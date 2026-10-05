use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

use crate::wav;

const TARGET_RATE: u32 = 16_000;

/// 录音过程中跨线程共享的状态（cpal 回调线程写，主流程读）
pub struct Shared {
    samples: Mutex<Vec<f32>>,
    sample_rate: AtomicU32,
    started: Instant,
    /// 最近一个音频块的 RMS * 1000
    level: AtomicU32,
    /// 最近一次检测到声音的时刻（ms，自录音开始）
    last_voice_ms: AtomicU64,
    /// 各原始声道独立峰值（诊断用）
    channel_peaks: Mutex<Vec<f32>>,
    /// 当前软件增益（线性 × 1000）。存原子量：录音期间 AGC 可实时调节，
    /// cpal 回调每个音频块重新读取，避免重建音频流
    gain_milli: AtomicU32,
    /// 音频流错误（设备拔出/蓝牙断连/驱动异常）。回调线程写入，watch 线程取走
    stream_error: Mutex<Option<String>>,
}

impl Shared {
    pub fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
    pub fn level(&self) -> f32 {
        self.level.load(Ordering::Relaxed) as f32 / 1000.0
    }
    /// 当前软件增益（dB）
    pub fn gain_db(&self) -> f32 {
        let g = self.gain_milli.load(Ordering::Relaxed) as f32 / 1000.0;
        20.0 * g.log10().max(0.0)
    }
    /// 运行期调节软件增益（dB，< 0 按 0 处理）
    pub fn set_gain_db(&self, db: f32) {
        let g = 10f32.powf(db.max(0.0) / 20.0) * 1000.0;
        self.gain_milli.store(g as u32, Ordering::Relaxed);
    }
    pub fn silence_ms(&self) -> u64 {
        self
            .elapsed_ms()
            .saturating_sub(self.last_voice_ms.load(Ordering::Relaxed))
    }
    /// 取最近 max_secs 音频，编码为 16kHz WAV（用于测试回放）
    pub fn snapshot_wav(&self, max_secs: f64) -> Vec<u8> {
        let rate = self.sample_rate.load(Ordering::Relaxed);
        let samples = self.samples.lock().map(|s| s.clone()).unwrap_or_default();
        let max_len = (max_secs * rate as f64) as usize;
        let cut = if samples.len() > max_len && max_len > 0 {
            samples.len() - max_len
        } else {
            0
        };
        let slice = &samples[cut..];
        let resampled = resample_linear(slice, rate, TARGET_RATE);
        let pcm: Vec<i16> = resampled
            .iter()
            .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect();
        wav::encode(&pcm, TARGET_RATE)
    }

    /// 取走音频流错误（如有）。设备丢失后继续挂着只会 VAD 误停/空识别，
    /// watch 线程据此立即收尾并提示
    pub fn take_stream_error(&self) -> Option<String> {
        self.stream_error.lock().ok().and_then(|mut e| e.take())
    }

    /// 当前已缓存采样数（原始采样率，单声道）
    pub fn len(&self) -> usize {
        self.samples.lock().map(|s| s.len()).unwrap_or(0)
    }

    pub fn rate(&self) -> u32 {
        self.sample_rate.load(Ordering::Relaxed)
    }

    /// 克隆 [from..] 范围的采样（用于流式分段切分）
    pub fn take_range(&self, from: usize) -> Vec<f32> {
        self.samples
            .lock()
            .map(|s| s[from.min(s.len())..].to_vec())
            .unwrap_or_default()
    }
}

/// 原始采样率 f32 → 16kHz i16（流式分段用）
pub fn to_16k_i16(samples: &[f32], from_rate: u32) -> Vec<i16> {
    let r = resample_linear(samples, from_rate, TARGET_RATE);
    r.iter()
        .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
        .collect()
}

/// 录音句柄（可跨线程传递；cpal Stream 本身 !Send，始终留在创建线程上）
pub struct Recording {
    pub shared: Arc<Shared>,
    /// 本次开流是否发生「指定设备不可见 → 回退系统默认」（find_device 判定）。
    /// 以字段而非改 start 签名的方式暴露：test_all_devices / mic_test 等
    /// 调用方零改动，pipeline 据此向用户追加提示
    pub used_fallback: bool,
    stop_flag: Arc<AtomicBool>,
    stop_signal: Arc<(Mutex<()>, Condvar)>,
    owner: Option<JoinHandle<()>>,
}

impl Drop for Recording {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        let (lock, cv) = &*self.stop_signal;
        // 持锁唤醒：确保 owner 不可能恰好正处于「已读标志、未进 wait」的间隙
        let _guard = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        cv.notify_all();
        drop(_guard);
        if let Some(t) = self.owner.take() {
            let _ = t.join();
        }
    }
}

/// 输入设备信息（含默认标记与默认流规格）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub name: String,
    pub is_default: bool,
    pub channels: Option<u16>,
    pub sample_rate: Option<u32>,
    pub sample_format: Option<String>,
}

pub fn list_inputs() -> Vec<DeviceInfo> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok());
    host.input_devices()
        .map(|it| {
            it.filter_map(|d| {
                let name = d.name().ok()?;
                let cfg = d.default_input_config().ok();
                Some(DeviceInfo {
                    is_default: default_name.as_deref() == Some(name.as_str()),
                    name,
                    channels: cfg.as_ref().map(|c| c.channels()),
                    sample_rate: cfg.as_ref().map(|c| c.sample_rate().0),
                    sample_format: cfg.map(|c| format!("{:?}", c.sample_format())),
                })
            })
            .collect()
        })
        .unwrap_or_default()
}

/// 设备名归一化：去首尾空白、压掉多余空格、统一小写，
/// 用于容忍系统枚举时名称里的细微差异（全半角/空格/大小写）
fn normalized(s: &str) -> String {
    s.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 按名字查找输入设备。返回 (设备, 是否发生回退)：回退 = 用户指定了设备名
/// 但枚举中找不到（false = 命中指定设备或本就未指定）。调用方据布尔值向
/// 用户提示「已用系统默认麦克风」，避免声音进了另一支麦却毫无感知
fn find_device(name: Option<&str>) -> anyhow::Result<(cpal::Device, bool)> {
    let host = cpal::default_host();
    if let Some(n) = name {
        if !n.is_empty() {
            let mut exact: Option<cpal::Device> = None;
            let mut fuzzy: Option<cpal::Device> = None;
            if let Ok(it) = host.input_devices() {
                for d in it {
                    let Ok(nm) = d.name() else { continue };
                    if nm == n {
                        exact = Some(d);
                        break;
                    }
                    if normalized(&nm) == normalized(n) {
                        fuzzy = fuzzy.or(Some(d));
                    }
                }
            }
            if let Some(d) = exact.or(fuzzy) {
                return Ok((d, false));
            }
            // 设备暂时不可见（无线接收器休眠/重新枚举/重启未就绪）：
            // 回退系统默认设备继续录音，而不是让整次听写失败。
            // 该设备常同时就是系统默认输入，多数情况下等效。
            if let Some(d) = host.default_input_device() {
                return Ok((d, true));
            }
        }
    }
    host.default_input_device()
        .map(|d| (d, false))
        .ok_or_else(|| anyhow!("未找到可用的音频输入设备"))
}

/// 启动录音。音频流在专属线程内创建/销毁，本函数返回轻量控制句柄。
/// gain_db：软件输入增益（作用于 VAD/电平/识别/回放全链路）
pub fn start(
    device: Option<&str>,
    vad_threshold: f32,
    gain_db: f32,
) -> anyhow::Result<Recording> {
    let shared = Arc::new(Shared {
        samples: Mutex::new(Vec::with_capacity(160_000)),
        sample_rate: AtomicU32::new(0),
        started: Instant::now(),
        level: AtomicU32::new(0),
        last_voice_ms: AtomicU64::new(0),
        channel_peaks: Mutex::new(Vec::new()),
        gain_milli: AtomicU32::new(1000),
        stream_error: Mutex::new(None),
    });
    let stop_flag = Arc::new(AtomicBool::new(false));
    // 停止信号唤醒：原实现 20ms 轮询 stop_flag，停止平均晚一拍（≤20ms）才
    // 被发现——改用 Condvar 即时唤醒（信号量语义：Mutex 只作 Condvar 载体）
    let stop_signal = Arc::new((Mutex::new(()), Condvar::new()));
    // 通道回传 used_fallback（find_device 在 owner 线程内判定，recv 返回即
    // happens-before 于 Recording 构造，无需额外同步原语）
    let (tx, rx) = mpsc::channel::<anyhow::Result<bool>>();
    let dev_name = device.map(str::to_string);
    shared.set_gain_db(gain_db);

    let thread_shared = shared.clone();
    let thread_flag = stop_flag.clone();
    let thread_signal = stop_signal.clone();

    let owner = thread::spawn(move || {
        let init = || -> anyhow::Result<(cpal::Stream, bool)> {
            let (device, used_fallback) = find_device(dev_name.as_deref())?;
            let supported = device.default_input_config()?;
            let sample_format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            let channels = config.channels.max(1) as u32;
            thread_shared
                .sample_rate
                .store(config.sample_rate.0, Ordering::SeqCst);

            // 错误回调：记录到 Shared（仅打印的话，设备拔出/断连后录音会一直
            // 挂到 VAD 误停，表现为「说完没反应」）；watch 线程检测后收尾
            let err_fn = {
                let s = thread_shared.clone();
                move |err: cpal::StreamError| {
                    eprintln!("[speaknow] 音频流错误: {err}");
                    if let Ok(mut slot) = s.stream_error.lock() {
                        if slot.is_none() {
                            *slot = Some(err.to_string());
                        }
                    }
                }
            };
            let stream = match sample_format {
                cpal::SampleFormat::F32 => device.build_input_stream(
                    &config,
                    {
                        let s = thread_shared.clone();
                        move |data: &[f32], _| push_block(data, &s, channels, vad_threshold)
                    },
                    err_fn,
                    None,
                ),
                cpal::SampleFormat::I16 => device.build_input_stream(
                    &config,
                    {
                        let s = thread_shared.clone();
                        move |data: &[i16], _| {
                            let conv: Vec<f32> =
                                data.iter().map(|v| *v as f32 / 32768.0).collect();
                            push_block(&conv, &s, channels, vad_threshold);
                        }
                    },
                    err_fn,
                    None,
                ),
                cpal::SampleFormat::U16 => device.build_input_stream(
                    &config,
                    {
                        let s = thread_shared.clone();
                        move |data: &[u16], _| {
                            let conv: Vec<f32> = data
                                .iter()
                                .map(|v| (*v as f32 - 32768.0) / 32768.0)
                                .collect();
                            push_block(&conv, &s, channels, vad_threshold);
                        }
                    },
                    err_fn,
                    None,
                ),
                other => bail!("暂不支持的采样格式: {other:?}"),
            }
            .map_err(|e| anyhow!("无法打开音频流: {e}"))?;

            stream.play().map_err(|e| anyhow!("无法启动音频流: {e}"))?;
            Ok((stream, used_fallback))
        };

        match init() {
            Ok((stream, used_fallback)) => {
                let _ = tx.send(Ok(used_fallback));
                let (lock, cv) = &*thread_signal;
                let mut g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                while !thread_flag.load(Ordering::SeqCst) {
                    // 500ms 超时仅作保险（唤醒信号丢失时也能退出）
                    (g, _) = cv
                        .wait_timeout(g, Duration::from_millis(500))
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                }
                drop(g);
                drop(stream); // 在创建它的线程上销毁
                std::thread::sleep(Duration::from_millis(60)); // 等尾部数据入队
            }
            Err(e) => {
                let _ = tx.send(Err(e));
            }
        }
    });

    match rx.recv() {
        Ok(Ok(used_fallback)) => Ok(Recording {
            shared,
            used_fallback,
            stop_flag,
            stop_signal,
            owner: Some(owner),
        }),
        Ok(Err(e)) => {
            let _ = owner.join();
            Err(e)
        }
        Err(_) => bail!("音频线程启动失败"),
    }
}

/// 多声道 → 单声道：逐帧取绝对值最大的通道（防止信号只在一个声道或差分信号被平均稀释/抵消）；
/// 同时应用增益（每个块重新读取，支持录音期 AGC 实时调节）、更新电平、VAD 与各声道独立峰值
fn push_block(data: &[f32], shared: &Shared, channels: u32, vad_threshold: f32) {
    if data.is_empty() {
        return;
    }
    let ch = channels.max(1) as usize;

    // 各声道独立峰值（诊断）
    {
        let mut peaks = shared.channel_peaks.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if peaks.len() != ch {
            peaks.clear();
            peaks.resize(ch, 0.0);
        }
        for frame in data.chunks(ch) {
            for (c, s) in frame.iter().enumerate() {
                let m = s.abs();
                if m > peaks[c] {
                    peaks[c] = m;
                }
            }
        }
    }

    let mut mono: Vec<f32> = if ch <= 1 {
        data.to_vec()
    } else {
        // 选取每帧中绝对值最大的声道样本
        data.chunks(ch)
            .map(|f| {
                *f.iter()
                    .max_by(|a, b| a.abs().total_cmp(&b.abs()))
                    .unwrap_or(&0.0)
            })
            .collect()
    };
    let gain = shared.gain_milli.load(Ordering::Relaxed) as f32 / 1000.0;
    if (gain - 1.0).abs() > 1e-4 {
        for s in mono.iter_mut() {
            *s = (*s * gain).clamp(-1.0, 1.0);
        }
    }

    let sum_sq: f32 = mono.iter().map(|s| s * s).sum();
    let rms = (sum_sq / mono.len() as f32).sqrt();
    shared
        .level
        .store(((rms * 1000.0) as u32).min(1000), Ordering::Relaxed);
    if rms >= vad_threshold {
        shared
            .last_voice_ms
            .store(shared.elapsed_ms(), Ordering::Relaxed);
    }

    if let Ok(mut buf) = shared.samples.lock() {
        buf.extend_from_slice(&mono);
    }
}

pub struct Captured {
    /// 16kHz 单声道 16bit 采样
    pub samples: Vec<i16>,
}

/// 结束录音并收集结果：重采样到 16kHz 单声道
pub fn finish(rec: Recording) -> Captured {
    let shared = rec.shared.clone();
    drop(rec); // 触发 Drop：停止音频线程并等待尾部数据（owner 已等 60ms 尾拍）

    // owner join 之后已无并发写者：直接拿走缓冲，避免整段克隆
    let samples = {
        let mut buf = shared
            .samples
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        std::mem::take(&mut *buf)
    };
    let rate = shared.sample_rate.load(Ordering::Relaxed);

    let resampled = resample_linear(&samples, rate, TARGET_RATE);
    let pcm: Vec<i16> = resampled
        .iter()
        .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
        .collect();

    Captured { samples: pcm }
}

pub fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    // 降采样抗混叠预滤波：线性插值本身不抗混叠——48k→16k 时 8kHz 以上的
    // 齿音能量会折叠进语音频段干扰识别。先做宽度≈降采样比的滑动平均
    // （box 滤波，前缀和 O(n)）把超奈奎斯特能量压掉再插值；奇数窗裁掉
    // 前 (w-1)/2 个样本做零相位对齐（box 是线性相位滤波器，中心对齐后
    // 不引入群延迟，带内波形不因此失真）
    let src: Vec<f32> = {
        let ratio = from as f64 / to as f64;
        if ratio < 1.9 {
            input.to_vec()
        } else {
            let w = ratio.round().max(2.0) as usize;
            // 前缀和（含首 0），窗口 [i-w+1, i] 不足宽度按实际覆盖数平均
            let mut prefix = Vec::with_capacity(input.len() + 1);
            prefix.push(0f32);
            let mut acc = 0f32;
            for s in input {
                acc += s;
                prefix.push(acc);
            }
            let filtered: Vec<f32> = (0..input.len())
                .map(|i| {
                    let lo = i.saturating_sub(w - 1);
                    (prefix[i + 1] - prefix[lo]) / (i - lo + 1) as f32
                })
                .collect();
            let shift = (w - 1) / 2;
            filtered[shift.min(filtered.len())..].to_vec()
        }
    };
    let ratio = to as f64 / from as f64;
    let n = ((input.len() as f64) * ratio).round() as usize;
    (0..n)
        .map(|i| {
            let p = i as f64 / ratio;
            let i0 = p.floor() as usize;
            let i1 = (i0 + 1).min(src.len() - 1);
            let t = (p - i0 as f64) as f32;
            src[i0] * (1.0 - t) + src[i1] * t
        })
        .collect()
}

/// 麦克风测试结果（电平 0~100）
pub struct MicTestResult {
    pub avg_level: f32,
    pub peak_level: f32,
    /// 采到的帧数（0 = 音频流没有任何数据回调）
    pub frames: u64,
    /// 各原始声道独立峰值（0~100，诊断用）
    pub channel_peaks: Vec<f32>,
    /// 可选：本次录音的 WAV（base64），供前端回放试听
    pub wav_base64: Option<String>,
}

/// 「同测全部设备」单设备结果
pub struct AllDeviceTest {
    pub name: String,
    pub is_default: bool,
    pub channels: Option<u16>,
    pub sample_rate: Option<u32>,
    pub avg_level: f32,
    pub peak_level: f32,
    pub channel_peaks: Vec<f32>,
    pub frames: u64,
    pub error: Option<String>,
}

/// 同时打开系统里所有输入设备并发采集（一次说话即可对比全部端点）。
/// on_tick 约每 120ms 回调一次 [(设备名, 当前电平 0~1)]，用于前端实时条形图。
pub fn test_all_devices<F: Fn(&[(String, f32)])>(
    duration_ms: u64,
    on_tick: F,
) -> Vec<AllDeviceTest> {
    struct Live {
        rec: Recording,
        acc: f32,
        n: u32,
        peak: f32,
    }
    let devs = list_inputs();
    let mut ok: Vec<(DeviceInfo, Live)> = Vec::new();
    let mut failed: Vec<DeviceInfo> = Vec::new();
    for d in devs {
        match start(Some(&d.name), f32::MIN, 0.0) {
            Ok(rec) => ok.push((
                d,
                Live {
                    rec,
                    acc: 0.0,
                    n: 0,
                    peak: 0.0,
                },
            )),
            Err(_) => failed.push(d),
        }
    }

    let begin = Instant::now();
    let dur = Duration::from_millis(duration_ms.max(1000));
    while begin.elapsed() < dur {
        thread::sleep(Duration::from_millis(120));
        let mut tick: Vec<(String, f32)> = Vec::with_capacity(ok.len());
        for (d, l) in ok.iter_mut() {
            let lv = l.rec.shared.level();
            l.acc += lv;
            l.n += 1;
            if lv > l.peak {
                l.peak = lv;
            }
            tick.push((d.name.clone(), lv));
        }
        on_tick(&tick);
    }

    let mut rows: Vec<AllDeviceTest> = ok
        .into_iter()
        .map(|(d, l)| {
            let frames = l.rec.shared.len() as u64;
            let channel_peaks = l
                .rec
                .shared
                .channel_peaks
                .lock()
                .map(|p| p.iter().map(|v| (v * 100.0).min(100.0)).collect())
                .unwrap_or_default();
            drop(l.rec);
            AllDeviceTest {
                name: d.name,
                is_default: d.is_default,
                channels: d.channels,
                sample_rate: d.sample_rate,
                avg_level: if l.n == 0 {
                    0.0
                } else {
                    (l.acc / l.n as f32 * 100.0).min(100.0)
                },
                peak_level: (l.peak * 100.0).min(100.0),
                channel_peaks,
                frames,
                error: None,
            }
        })
        .collect();
    for d in failed {
        rows.push(AllDeviceTest {
            name: d.name,
            is_default: d.is_default,
            channels: d.channels,
            sample_rate: d.sample_rate,
            avg_level: -1.0,
            peak_level: -1.0,
            channel_peaks: Vec::new(),
            frames: 0,
            error: Some("无法打开音频流（可能被其他应用独占或驱动异常）".into()),
        });
    }
    rows
}

/// 粘贴前说话探测（单次开流版）：开一条采集流持续监听电平，检测到持续安静
/// （连续 quiet_ms 低于阈值，与旧实现「一个 220ms 探测窗峰值 < 阈值即放行」
/// 同口径）或达到 max_ms 返回。开流失败视为安静放行（与旧实现一致，探测
/// 故障不应阻塞输入）。此前 inject 的门限循环每轮 mic_test 都整建一次
/// WASAPI 流（无线麦单次可达 1s），连续说话 6 秒要反复开流十几次
pub fn mic_gate(
    device: Option<&str>,
    thr_percent: f32,
    max_ms: u64,
    superseded: &dyn Fn() -> bool,
) {
    let Ok(rec) = start(device, f32::MIN, 0.0) else {
        return;
    };
    let begin = Instant::now();
    let mut quiet_ms = 0u32;
    loop {
        std::thread::sleep(Duration::from_millis(50));
        // 被新录音取代：立即退出（调用方随后复查 superseded 走跳过分支）
        if superseded() {
            return;
        }
        let lv = rec.shared.level() * 100.0;
        if lv >= thr_percent {
            quiet_ms = 0;
        } else {
            quiet_ms += 50;
        }
        if quiet_ms >= 200 {
            return;
        }
        if begin.elapsed() >= Duration::from_millis(max_ms) {
            return;
        }
    }
}

/// 短时录音测试：实时回调电平，结束后返回均值/峰值（及可选回放音频）
pub fn mic_test<F: Fn(f32)>(
    device: Option<&str>,
    playback: bool,
    gain_db: f32,
    duration_ms: u64,
    on_level: F,
) -> anyhow::Result<MicTestResult> {
    let rec = start(device, f32::MIN, gain_db)?; // 阈值取最小值，避免影响电平统计
    let duration = Duration::from_millis(duration_ms);
    let begin = Instant::now();
    let mut acc = 0.0f32;
    let mut peak = 0.0f32;
    let mut n = 0u32;
    while begin.elapsed() < duration {
        std::thread::sleep(Duration::from_millis(50));
        let lv = rec.shared.level();
        on_level(lv);
        acc += lv;
        n += 1;
        if lv > peak {
            peak = lv;
        }
    }
    let frames = rec.shared.len() as u64;
    let channel_peaks = rec
        .shared
        .channel_peaks
        .lock()
        .map(|p| p.iter().map(|v| (v * 100.0).min(100.0)).collect())
        .unwrap_or_default();
    let avg = if n == 0 { 0.0 } else { acc / n as f32 };
    let wav = if playback {
        Some(rec.shared.snapshot_wav(4.0))
    } else {
        None
    };
    drop(rec);

    Ok(MicTestResult {
        avg_level: (avg * 100.0).min(100.0),
        peak_level: (peak * 100.0).min(100.0),
        frames,
        channel_peaks,
        wav_base64: wav.map(|w| {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(w)
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::resample_linear;

    #[test]
    fn resample_identity_and_length() {
        let input = vec![0.1f32, 0.2, 0.3];
        assert_eq!(resample_linear(&input, 16_000, 16_000), input);
        // 1 秒 48k → 16k：输出恰 16k 样本
        let one_sec: Vec<f32> = (0..48_000).map(|i| (i as f32 * 0.001).sin()).collect();
        assert_eq!(resample_linear(&one_sec, 48_000, 16_000).len(), 16_000);
    }

    /// 1kHz 正弦（远离奈奎斯特）经 48k→16k 后应保真
    #[test]
    fn resample_keeps_in_band_signal() {
        let freq = 1_000.0f32;
        let input: Vec<f32> = (0..48_000)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / 48_000.0).sin())
            .collect();
        let out = resample_linear(&input, 48_000, 16_000);
        let direct: Vec<f32> = (0..16_000)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / 16_000.0).sin())
            .collect();
        // 跳过头尾半周期（滑动平均的边界效应），带内幅值误差应很小
        let max_err = out[500..15_500]
            .iter()
            .zip(&direct[500..15_500])
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(max_err < 0.05, "带内失真 {max_err}");
    }

    /// 12kHz 正弦在 48k→16k 下超出 8k 奈奎斯特：抗混叠预滤波必须显著压低
    /// （不滤波时会整体折叠成 4kHz 假信号，幅值不减）。测量跳过首尾
    /// 热身/收尾区（部分窗口的瞬态，真实录音中无害）
    #[test]
    fn resample_attenuates_above_nyquist() {
        let freq = 12_000.0f32;
        let input: Vec<f32> = (0..48_000)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / 48_000.0).sin())
            .collect();
        let out = resample_linear(&input, 48_000, 16_000);
        let steady = &out[100..out.len() - 100];
        let peak = steady.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        // 3 抽头 box 在 12kHz 的理论增益 1/3；留裕量断言
        assert!(peak < 0.45, "超奈奎斯特分量未被压低：peak {peak}");
    }
}
