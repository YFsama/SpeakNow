use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
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
    stop_flag: Arc<AtomicBool>,
    owner: Option<JoinHandle<()>>,
}

impl Drop for Recording {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
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

fn find_device(name: Option<&str>) -> anyhow::Result<cpal::Device> {
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
                return Ok(d);
            }
            // 设备暂时不可见（无线接收器休眠/重新枚举/重启未就绪）：
            // 回退系统默认设备继续录音，而不是让整次听写失败。
            // 该设备常同时就是系统默认输入，多数情况下等效。
            if let Some(d) = host.default_input_device() {
                return Ok(d);
            }
        }
    }
    host.default_input_device()
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
    });
    let stop_flag = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<anyhow::Result<()>>();
    let dev_name = device.map(str::to_string);
    shared.set_gain_db(gain_db);

    let thread_shared = shared.clone();
    let thread_flag = stop_flag.clone();

    let owner = thread::spawn(move || {
        let init = || -> anyhow::Result<cpal::Stream> {
            let device = find_device(dev_name.as_deref())?;
            let supported = device.default_input_config()?;
            let sample_format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            let channels = config.channels.max(1) as u32;
            thread_shared
                .sample_rate
                .store(config.sample_rate.0, Ordering::SeqCst);

            let err_fn = |err| eprintln!("[speaknow] 音频流错误: {err}");
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
            Ok(stream)
        };

        match init() {
            Ok(stream) => {
                let _ = tx.send(Ok(()));
                while !thread_flag.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(20));
                }
                drop(stream); // 在创建它的线程上销毁
                std::thread::sleep(Duration::from_millis(60)); // 等尾部数据入队
            }
            Err(e) => {
                let _ = tx.send(Err(e));
            }
        }
    });

    match rx.recv() {
        Ok(Ok(())) => Ok(Recording {
            shared,
            stop_flag,
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
        let mut peaks = shared.channel_peaks.lock().unwrap();
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
    pub duration_secs: f64,
}

/// 结束录音并收集结果：重采样到 16kHz 单声道
pub fn finish(rec: Recording) -> Captured {
    let shared = rec.shared.clone();
    drop(rec); // 触发 Drop：停止音频线程并等待尾部数据
    thread::sleep(Duration::from_millis(40));

    let samples = shared.samples.lock().map(|s| s.clone()).unwrap_or_default();
    let rate = shared.sample_rate.load(Ordering::Relaxed);
    let secs = if rate == 0 {
        0.0
    } else {
        samples.len() as f64 / rate as f64
    };

    let resampled = resample_linear(&samples, rate, TARGET_RATE);
    let pcm: Vec<i16> = resampled
        .iter()
        .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
        .collect();

    Captured {
        samples: pcm,
        duration_secs: secs,
    }
}

pub fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = to as f64 / from as f64;
    let n = ((input.len() as f64) * ratio).round() as usize;
    (0..n)
        .map(|i| {
            let p = i as f64 / ratio;
            let i0 = p.floor() as usize;
            let i1 = (i0 + 1).min(input.len() - 1);
            let t = (p - i0 as f64) as f32;
            input[i0] * (1.0 - t) + input[i1] * t
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
