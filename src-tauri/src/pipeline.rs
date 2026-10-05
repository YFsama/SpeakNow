use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::config::{AsrConfig, Config};
use crate::{asr, audio, events, history, inject, llm, overlay, Ctx, PendingReview};

/// 外接显示独占模式：本地不再弹出聆听悬浮窗（字幕只推给外接硬件）
pub fn suppress_local_overlay(cfg: &Config) -> bool {
    cfg.external_display.enabled && cfg.external_display.hide_local_overlay
}

/// 托盘 / 切换模式：正在录音则停止，否则开始
/// 上次 toggle 时刻（ms）：热键事件去抖。键盘连击/驱动重复会在几十毫秒内
/// 产生第二次 toggle，造成「一开就停」（话没说完就结束）或幽灵录音，
/// 进而引发旧结果晚到输入。300ms 内的第二次 toggle 一律忽略。
static LAST_TOGGLE_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ---------- 热键 / 托盘入口的串行执行通道 ---------- */

/// 全局快捷键与托盘菜单回调跑在主线程（tao 事件循环）上，而 start() 含
/// UIA 光标探测（慢目标上百 ms）与 WASAPI 开流等待（无线麦可达秒级），
/// 同步执行会冻结主窗与托盘——设置页 start_recording 命令早已用
/// spawn_blocking 规避，本通道让热键路径对齐。专用单线程消费还保证
/// hold 模式「按下→松开」的 FIFO 顺序：多线程池下 stop 可能抢在 start
/// 落锁前执行，快速点按会把录音漏停到最长时长兜底。
enum Cmd {
    Start { app: AppHandle, quick: bool, translate: bool },
    Stop { app: AppHandle },
    Toggle { app: AppHandle, quick: bool, translate: bool },
}

static CMD_TX: std::sync::LazyLock<std::sync::mpsc::Sender<Cmd>> =
    std::sync::LazyLock::new(|| {
        let (tx, rx) = std::sync::mpsc::channel::<Cmd>();
        std::thread::Builder::new()
            .name("speaknow-pipeline-cmd".into())
            .spawn(move || {
                for cmd in rx {
                    match cmd {
                        Cmd::Start { app, quick, translate } => {
                            // 失败的用户可见上报（error 状态 + 延迟隐藏）已收口在
                            // start() 内部 audio::start 失败处，这里只留日志
                            if let Err(e) = start(&app, quick, translate, false) {
                                eprintln!("[speaknow] 开始录音失败: {e}");
                            }
                        }
                        Cmd::Stop { app } => {
                            if let Err(e) = stop(&app) {
                                eprintln!("[speaknow] 结束录音失败: {e}");
                            }
                        }
                        Cmd::Toggle { app, quick, translate } => toggle(&app, quick, translate),
                    }
                }
            })
            .expect("pipeline 命令线程启动失败");
        tx
    });

/// toggle 模式主快捷键 / 托盘「开始 / 停止录音」：投递执行，不占主线程
pub fn post_toggle(app: &AppHandle, quick: bool, translate: bool) {
    let _ = CMD_TX.send(Cmd::Toggle { app: app.clone(), quick, translate });
}

/// hold 模式按下
pub fn post_start(app: &AppHandle, quick: bool, translate: bool) {
    let _ = CMD_TX.send(Cmd::Start { app: app.clone(), quick, translate });
}

/// hold 模式松开
pub fn post_stop(app: &AppHandle) {
    let _ = CMD_TX.send(Cmd::Stop { app: app.clone() });
}

/// 托盘 / 切换模式：正在录音则停止，否则开始。
/// `skip_llm`：快速模式（跳过 AI 优化）；`translate`：本次听写强制翻译模式
pub fn toggle(app: &AppHandle, skip_llm: bool, translate: bool) {
    let now = now_ms();
    // CAS 去抖：load/store 两步在并发 toggle 下有双双通过的间隙
    let mut last = LAST_TOGGLE_MS.load(Ordering::SeqCst);
    loop {
        if last > 0 && now.saturating_sub(last) < 300 {
            crate::trace_pipeline(
                app,
                &format!("toggle 忽略（{}ms 内重复，疑按键抖动）", now - last),
            );
            return;
        }
        match LAST_TOGGLE_MS.compare_exchange(last, now, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => break,
            Err(l) => last = l,
        }
    }
    crate::trace_pipeline(app, "toggle（热键）");
    let recording = app.state::<Ctx>().recording.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_some();
    if recording {
        let _ = stop(app);
    } else if let Err(e) = start(app, skip_llm, translate, false) {
        // 失败的用户可见上报（error 状态 + 延迟隐藏）已收口在 start() 内部
        // audio::start 失败处：此处再发一次会造成双份 error 事件干扰 UI
        eprintln!("[speaknow] 开始录音失败: {e}");
    }
}

/// 一次录音会话的全部状态。旧版这些是全局单份、由 start() 重置——上一会话
/// 尚在收尾的 watch / 流式分段 worker / run 若跨过重置点，会消费新会话的
/// 标志、把旧分段推进新队列（字幕重复 / 串话 / 快速模式标志被抢）。现在
/// 状态随会话创建、随会话消亡，各线程只碰自己这份 Arc。
pub struct Session {
    /// 会话代数：start() 递增的全局计数，旧会话的晚到结果据此作废
    pub gen: u64,
    /// 设置页发起（结束时只复制不输入）。跟随会话而非 stop 调用方：
    /// VAD / 最长时长 / 设备错误等自动收尾路径同样保持测试语义
    pub from_ui: bool,
    /// 快速模式（跳过 AI 优化）
    pub skip_llm: bool,
    /// 本次强制翻译模式
    pub translate: bool,
    /// 流式分段开启
    pub streaming: bool,
    /// watch 线程退出信号（stop 时置位；仅本会话线程可见，start() 重置不了它）
    pub cancel: AtomicBool,
    /// 流式分段游标 / 队列 / 收尾状态（仅本会话的 watch / worker / run 访问）
    pub stream_cut: AtomicUsize,
    pub stream_done: AtomicBool,
    pub stream_finished: AtomicBool,
    pub stream_queue: Mutex<VecDeque<Vec<i16>>>,
    pub stream_texts: Mutex<Vec<String>>,
    /// 分段队列的唤醒信号：入队 / 收尾置位后 notify，worker 空转等待改事件
    /// 驱动（此前 25ms 轮询，整场录音每秒 40 次空醒）。Notify 的 permit
    /// 语义保证 notify 先于 await 到达也不丢唤醒
    pub stream_notify: tokio::sync::Notify,
    /// 流式分段识别最终失败（含段级重试）的累计段数：拼接结果缺句时收尾
    /// 阶段据此在 done 消息里提示「可能不完整」，而不是静默给出残缺文本。
    /// 计数只在 worker 线程写、run() 收尾读，无重置需求（随会话消亡）
    pub stream_failed: AtomicUsize,
}

/// skip_llm=true：本次会话跳过 AI 优化（快速模式）
/// translate=true：本次会话强制「翻译」模式（输出目标语言译文，经 LLM）
/// from_ui=true：由设置页发起（结束时只复制结果，不模拟输入）
pub fn start(app: &AppHandle, skip_llm: bool, translate: bool, from_ui: bool) -> Result<(), String> {
    let state = app.state::<Ctx>();
    if state.recording.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_some() {
        return Ok(());
    }
    let cfg = state.config.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone().unwrap_or_default();

    // 反馈先行：WASAPI 开流要 20ms~1s+（无线麦唤醒更久），提示音/悬浮窗若
    // 排在开流之后，每次听写都会先经历一段「按了没反应」的空窗。提示文案
    // 只依赖 cfg（纯计算），整体提前到 audio::start 之前发出；开流失败再补
    // 一条 error 状态收场。失败上报收口在此处，hold / toggle / 托盘所有
    // 入口共用，调用方分支只留 eprintln（避免双份 error 事件）
    let sound = cfg.general.sound_feedback;
    // 翻译提示只在 LLM 真正可用时显示（凭据组解析后判定；LLM 未配置时
    // run() 会静默退回默认模式，提前剧透「翻译为 X」只会误导）
    let llm_ready = llm::llm_ready(&cfg.resolved_llm());
    let force_translate = !skip_llm && translate && llm_ready;
    let hold = cfg.hotkey.mode == "hold";
    let hint = if skip_llm {
        if hold {
            "松开快捷键结束（快速模式 · 不经 AI）".to_string()
        } else {
            "再次按下快捷键结束（快速模式 · 不经 AI）".to_string()
        }
    } else if force_translate {
        let target = crate::config::lang_name(&cfg.llm.translate_target);
        if hold {
            format!("松开快捷键结束（翻译为 {target}）")
        } else {
            format!("再次按下快捷键结束（翻译为 {target}）")
        }
    } else if hold {
        "松开快捷键结束并输入".to_string()
    } else {
        "再次按下快捷键结束并输入".to_string()
    };
    // 旧卡遗留的隐藏倒计时可能在「show 之后、录音装入 slot 之前」的窗口内
    // 到期（reaper 只认 recording=Some，装 slot 要等 audio::start 返回），
    // 把刚亮出的聆听卡藏掉且本会话再无补显——show 之前先取消倒计时关死窗口
    cancel_hide();
    emit_status(app, "recording", &hint, sound);
    if cfg.general.show_overlay && !suppress_local_overlay(&cfg) {
        overlay::show(app);
    }

    let rec = match audio::start(
        cfg.audio.device.as_deref(),
        cfg.audio.vad_threshold,
        cfg.audio.gain_db,
    ) {
        Ok(rec) => rec,
        Err(e) => {
            // 悬浮窗已随「反馈先行」show 过，error 消息展示 3 秒后随
            // hide_later 隐藏——用户不会再经历按住说话松开后毫无反馈
            eprintln!("[speaknow] 开始录音失败: {e:#}");
            emit_status(app, "error", &format!("开始录音失败：{e:#}"), false);
            hide_later(app, 3000);
            return Err(format!("{e:#}"));
        }
    };
    // 指定设备不可见 → 已回退系统默认（audio::find_device 判定）：声音进的
    // 是另一支麦，必须让用户知情；提示音已随首条 recording 状态播过，这里
    // 只更新文案、不再响一声
    if rec.used_fallback {
        emit_status(
            app,
            "recording",
            &format!("{hint}（指定设备不可用，已用系统默认麦克风）"),
            false,
        );
    }
    let shared = rec.shared.clone();
    // 开流后再上锁检查写入：并发双触发（按键弹跳 / UI 与热键同拍）时，
    // 后到者发现已在录音，丢弃自己多开的流（Drop 即停流），不覆盖进行中的
    // 会话。此路径已提前发出过 recording 状态——本就正在录音，无需补偿
    let mut slot = state.recording.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if slot.is_some() {
        drop(slot);
        return Ok(());
    }
    // 新会话开启：作废仍在处理中的上一代结果
    let gen = state.run_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let dev_label = cfg
        .audio
        .device
        .clone()
        .unwrap_or_else(|| "系统默认".to_string());
    crate::trace_pipeline(app, &format!("start 录音（gen {gen} · {dev_label}）"));
    let streaming = cfg.asr.streaming;
    // 快速模式跳过 LLM，翻译无从谈起：翻译标志仅在非快速会话生效
    let sess = Arc::new(Session {
        gen,
        from_ui,
        skip_llm,
        translate: !skip_llm && translate,
        streaming,
        cancel: AtomicBool::new(false),
        stream_cut: AtomicUsize::new(0),
        stream_done: AtomicBool::new(false),
        stream_finished: AtomicBool::new(!streaming),
        stream_queue: Mutex::new(VecDeque::new()),
        stream_texts: Mutex::new(Vec::new()),
        stream_notify: tokio::sync::Notify::new(),
        stream_failed: AtomicUsize::new(0),
    });
    *slot = Some((rec, sess.clone()));
    drop(slot);

    if streaming {
        let handle = app.clone();
        // 凭据组在此展开：分段识别使用录音开始时刻的凭据快照
        let asr_cfg = cfg.resolved_asr();
        let worker_sess = sess.clone();
        tauri::async_runtime::spawn(async move {
            segment_worker(handle, asr_cfg, worker_sess).await;
        });
    }

    // sn-retryable 维持「会话建立后」的原时机：过早发送会在 audio::start
    // 失败场景误清 UI 的重试标记（失败路径已在上方提前返回，到不了这里）
    events::emit(app, "sn-retryable", serde_json::json!(false));

    let handle = app.clone();
    let watch_device = cfg.audio.device.clone();
    thread::spawn(move || {
        watch(
            handle,
            sess,
            shared,
            cfg.audio.vad_enabled,
            cfg.audio.vad_silence_ms,
            cfg.audio.max_duration_sec,
            watch_device,
            cfg.audio.gain_db,
            cfg.audio.auto_gain,
        );
    });
    Ok(())
}

/// 流式分段消费者：按顺序识别本会话队列中的分段并推送实时字幕。
/// 会话被新录音取代（run_gen 前移）即退出——旧 worker 若继续存活，
/// 会与新会话的 worker 分流同一条队列，造成分段乱序与跨会话串话。
async fn segment_worker(app: AppHandle, asr_cfg: AsrConfig, sess: Arc<Session>) {
    loop {
        if app.state::<Ctx>().run_gen.load(Ordering::SeqCst) != sess.gen {
            return;
        }
        let seg = sess.stream_queue.lock().unwrap_or_else(std::sync::PoisonError::into_inner).pop_front();
        match seg {
            Some(samples) => {
                // 段级重试：asr::transcribe 只对云端网络类错误在内部重试一次
                // （with_retry；鉴权/参数类与本地模型路径一次即弃），而流式
                // 分段一旦丢弃就是永久缺句。这里对失败段再补一次短退避重试；
                // 仍失败才计入 stream_failed 并放弃，收尾时向用户提示结果
                // 可能不完整（云端网络类错误最多三次尝试，宁可多试不可丢句）
                let text = match asr::transcribe(&app, &asr_cfg, &samples).await {
                    Ok(t) => t,
                    Err(first) => {
                        eprintln!("[speaknow] 流式分段识别失败，重试一次: {first:#}");
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        match asr::transcribe(&app, &asr_cfg, &samples).await {
                            Ok(t) => t,
                            Err(second) => {
                                eprintln!("[speaknow] 流式分段重试仍失败，放弃该段: {second:#}");
                                sess.stream_failed.fetch_add(1, Ordering::SeqCst);
                                String::new()
                            }
                        }
                    }
                };
                if !text.trim().is_empty() {
                    // 段边界信息：segs=已定稿段数；last=最后一段原文。取 trim 后
                    // 的文本——join_transcripts 以 trim 段落收尾，joined 恒以
                    // last 结尾，前端据此从 text 尾部安全切出「暂存段」
                    let last = text.trim().to_string();
                    let (joined, segs) = {
                        let mut texts = sess.stream_texts.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                        texts.push(text);
                        (asr::join_transcripts(&texts), texts.len())
                    };
                    // text 保持旧语义不变，旧前端忽略 segs/last 天然兼容
                    events::emit(
                        &app,
                        "sn-partial",
                        serde_json::json!({ "text": joined, "segs": segs, "last": last }),
                    );
                }
            }
            None => {
                if sess.stream_done.load(Ordering::SeqCst) {
                    sess.stream_finished.store(true, Ordering::SeqCst);
                    return;
                }
                // 事件驱动等待：入队 / 收尾时生产侧 notify_one。构造 future 后
                // 双检队列与标记，关死「pop 之后、注册等待之前」的入队窗口
                let notified = sess.stream_notify.notified();
                if sess.stream_queue.lock().unwrap_or_else(std::sync::PoisonError::into_inner).front().is_some()
                    || sess.stream_done.load(Ordering::SeqCst)
                {
                    continue;
                }
                notified.await;
            }
        }
    }
}

/// 录音期自动增益（AGC）：以用户设定的基准增益为中心，仅在「确有语音」且窗口
/// 峰值过低时逐步提升、接近削波时快速回落。增益只作用于本次录音；结束时若学
/// 到了新值（偏离基准 ≥ 1.5dB 且确实听到语音），经 sn-gain-learned 事件交由
/// 前端写回该设备的记忆增益，下一次录音直接从学到的值起步，不再重复爬升。
struct Agc {
    enabled: bool,
    base_db: f32,
    gain_db: f32,
    /// 窗口内电平采样（增益后 RMS，watch 每 100ms 一拍）
    window: Vec<f32>,
    /// 窗口内「判定有语音」的采样数
    window_speech: usize,
    /// 整场录音累计有语音采样数（学得值门槛，防止对着底噪自学）
    total_speech: usize,
    min_db: f32,
    max_db: f32,
}

impl Agc {
    /// 决策窗口 1.5s
    const WINDOW_TICKS: usize = 15;
    /// 窗口内「有语音」采样下限（约 0.4s，纯底噪偶发越限不足以触发）
    const WINDOW_SPEECH_MIN: usize = 4;
    /// 学得值门槛：整场至少 1s 有效语音
    const TOTAL_SPEECH_MIN: usize = 10;
    /// 增益后窗口峰值低于此（RMS）→ 提升；正常音量（窗口峰值 0.2+）不触发
    const TARGET_LOW: f32 = 0.10;
    /// 增益后窗口峰值达到此（RMS）→ 接近削波，回落
    const TARGET_CLIP: f32 = 0.90;
    /// 增益前 RMS 峰值低于此视为无语音（底噪），绝不放大纯底噪
    const PRE_SPEECH_FLOOR: f32 = 0.01;
    const STEP_UP_DB: f32 = 3.0;
    const STEP_DOWN_DB: f32 = 4.0;
    /// 自动调节范围：基准 ±12dB（提升侧再受 45dB 硬上限约束）
    const RANGE_DB: f32 = 12.0;
    const HARD_MAX_DB: f32 = 45.0;

    fn new(base_db: f32, enabled: bool) -> Self {
        let base_db = base_db.clamp(0.0, Self::HARD_MAX_DB);
        Self {
            enabled,
            min_db: (base_db - Self::RANGE_DB).max(0.0),
            max_db: (base_db + Self::RANGE_DB).min(Self::HARD_MAX_DB),
            base_db,
            gain_db: base_db,
            window: Vec::with_capacity(Self::WINDOW_TICKS),
            window_speech: 0,
            total_speech: 0,
        }
    }

    /// 每拍喂入增益后电平（RMS 0~1）。返回新增益（dB）；None = 本拍无需调节。
    fn on_tick(&mut self, post_level: f32) -> Option<f32> {
        if !self.enabled {
            return None;
        }
        // 折算增益前电平：低于语音门限的信号（底噪）不计入语音判定，
        // 保证 AGC 只会放大「确实有人在说话」的输入，而不是把底噪泵上去
        let pre_level = post_level / 10f32.powf(self.gain_db / 20.0);
        if pre_level >= Self::PRE_SPEECH_FLOOR || post_level >= Self::TARGET_CLIP {
            self.window_speech += 1;
            self.total_speech += 1;
        }
        self.window.push(post_level);
        if self.window.len() < Self::WINDOW_TICKS {
            return None;
        }
        let peak = self.window.iter().copied().fold(0.0f32, f32::max);
        self.window.clear();
        let speech_ticks = self.window_speech;
        self.window_speech = 0;

        if peak >= Self::TARGET_CLIP && self.gain_db > self.min_db {
            self.gain_db = (self.gain_db - Self::STEP_DOWN_DB).max(self.min_db);
            return Some(self.gain_db);
        }
        if speech_ticks >= Self::WINDOW_SPEECH_MIN
            && peak < Self::TARGET_LOW
            && self.gain_db < self.max_db
        {
            self.gain_db = (self.gain_db + Self::STEP_UP_DB).min(self.max_db);
            return Some(self.gain_db);
        }
        None
    }

    /// 录音结束：若学到新增益则返回应记忆的值（0.5dB 步进）
    fn learned(&self) -> Option<f32> {
        if !self.enabled || self.total_speech < Self::TOTAL_SPEECH_MIN {
            return None;
        }
        if (self.gain_db - self.base_db).abs() < 1.5 {
            return None;
        }
        Some((self.gain_db * 2.0).round() / 2.0)
    }
}

/// 电平上报 + VAD 静音自动结束 + 最长时长保护 + 流式分段切分 + 录音期 AGC。
/// 直接持有本会话的音频共享状态与 Session：不读任何会被 start() 重置的
/// 全局量，旧会话的 watch 线程绝不会驱动新会话的录音。
#[allow(clippy::too_many_arguments)]
fn watch(
    app: AppHandle,
    sess: Arc<Session>,
    shared: Arc<audio::Shared>,
    vad_enabled: bool,
    silence_ms: u64,
    max_sec: u64,
    device: Option<String>,
    base_gain_db: f32,
    auto_gain: bool,
) {
    let mut agc = Agc::new(base_gain_db, auto_gain);
    let streaming = sess.streaming;
    // 临近最长时长提示（每会话一次）
    let mut near_max_hinted = false;
    loop {
        thread::sleep(Duration::from_millis(100));
        if sess.cancel.load(Ordering::SeqCst) {
            break;
        }
        let level = shared.level();
        // AGC 决策状态（agc）为本线程独占；增益写入是原子操作
        if let Some(db) = agc.on_tick(level) {
            shared.set_gain_db(db);
        }
        let silence = shared.silence_ms();
        let elapsed_ms = shared.elapsed_ms();
        let len = shared.len();
        let rate = shared.rate();
        let stream_err = shared.take_stream_error();
        events::emit(&app, "sn-level", serde_json::json!(level));

        // 音频设备丢失（拔出/蓝牙断连/驱动异常）：立即收尾识别已采集部分，
        // 而不是挂到 VAD 误停让用户以为「说完没反应」
        if let Some(err) = stream_err {
            crate::trace_pipeline(&app, &format!("音频流错误，自动收尾：{err}"));
            let _ = stop(&app);
            break;
        }

        // 流式分段：静音 700ms 或单段满 10s 时切一段送识别。
        // CAS 占位（cut→MAX→len）与 run() 的尾部收尾互斥：两边同拍
        // 取到同一游标会把同一段音频入队两次（重复语句）
        if streaming && len > 0 {
            let cut = sess.stream_cut.load(Ordering::SeqCst);
            if cut != usize::MAX && len > cut {
                let unsent_secs = (len - cut) as f64 / rate as f64;
                if (unsent_secs >= 10.0 || (silence > 700 && unsent_secs > 0.9))
                    && sess
                        .stream_cut
                        .compare_exchange(cut, usize::MAX, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                    {
                        let seg = shared.take_range(cut);
                        if !seg.is_empty() {
                            let seg16 = audio::to_16k_i16(&seg, rate);
                            sess.stream_queue
                                .lock().unwrap_or_else(std::sync::PoisonError::into_inner)
                                .push_back(seg16);
                            sess.stream_notify.notify_one();
                        }
                        sess.stream_cut.store(len, Ordering::SeqCst);
                    }
            }
        }

        if vad_enabled && elapsed_ms > 900 && silence > silence_ms {
            crate::trace_pipeline(&app, "VAD 静音自动结束");
            let _ = stop(&app);
            break;
        }
        // 临近最长录音时长（进入最后 5s 窗口）提示一次：达上限静默自动收尾
        // 会让说到一半的用户毫无预警。max_sec ≤ 5s 时提示窗口不存在，跳过。
        // hint 型 sn-status 前端只刷新提示文案、不做阶段清场（不闪断流式字幕）
        if !near_max_hinted && max_sec > 5 && elapsed_ms + 5_000 >= max_sec * 1_000 {
            near_max_hinted = true;
            crate::trace_pipeline(&app, "临近最长录音时长，已提示用户");
            events::emit(
                &app,
                "sn-status",
                serde_json::json!({
                    "stage": "recording",
                    "message": "即将达到最长录音时长，自动结束",
                    "sound": false,
                    "hint": true,
                }),
            );
        }
        if elapsed_ms > max_sec * 1000 {
            crate::trace_pipeline(&app, "达到最长时长自动结束");
            let _ = stop(&app);
            break;
        }
    }
    // 单一出口：AGC 学到的增益广播给前端按设备记忆（sn-gain-learned）
    if let Some(learned_db) = agc.learned() {
        crate::trace_pipeline(
            &app,
            &format!(
                "AGC 学得增益：基准 {:.1}dB → {:.1}dB（{}）",
                agc.base_db,
                learned_db,
                device.as_deref().unwrap_or("系统默认")
            ),
        );
        events::emit(
            &app,
            "sn-gain-learned",
            serde_json::json!({
                "device": device,
                "gainDb": learned_db,
                "baseDb": agc.base_db,
            }),
        );
    }
}

/// 结束当前录音会话。from_ui 等会话语义随 Session 走（start 时定型），
/// 任何收尾路径（热键松开 / VAD / 最长时长 / 设备错误 / 设置页）行为一致。
pub fn stop(app: &AppHandle) -> Result<(), String> {
    crate::trace_pipeline(app, "stop");
    let state = app.state::<Ctx>();
    // 取会话与置 cancel 都作用于同一份 Session：start() 无法重置它，
    // 新会话开始再早也不会让本会话的 watch 线程“复活”
    let Some((rec, sess)) = state.recording.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() else {
        return Ok(());
    };
    sess.cancel.store(true, Ordering::SeqCst);
    let cfg = state.config.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone().unwrap_or_default();

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        run(handle, cfg, rec, sess).await;
    });
    Ok(())
}

async fn run(app: AppHandle, cfg: Config, rec: audio::Recording, sess: Arc<Session>) {
    // 会话标志在 start 时已定型，此处只读取——旧会话的 run 不可能
    // 消费到新会话的快速/翻译标志（旧版全局 swap 的竞态窗口）
    let skip_llm = sess.skip_llm;
    let force_translate = sess.translate;
    let from_ui = sess.from_ui;
    // 展开凭据组引用：此后链路只看内联字段（录音开始时刻的凭据快照，
    // 录音进行中改配置不影响本次会话）
    let asr_resolved = cfg.resolved_asr();
    let llm_resolved = cfg.resolved_llm();
    let mut cfg = cfg;
    cfg.asr = asr_resolved;
    cfg.llm = llm_resolved;
    // 空 Key 的云端端点每次调用都注定 401：与其白发一次失败请求、等重试
    // 提示再回退原文，不如判未就绪直接跳过 AI 环节（本地端点免 Key 不受影响）
    let llm_active = !skip_llm && llm::llm_ready(&cfg.llm);
    // 翻译快捷键强制翻译模式；LLM 未启用/未配置时静默退回默认行为
    let translating = force_translate && llm_active;
    if translating {
        cfg.llm.mode = "translate".into();
    }

    // 告知悬浮窗本次使用的模型链路
    let asr_label = if cfg.asr.provider == "local" {
        if cfg.asr.local_model == crate::qwen_asr::MODEL_ID {
            "Qwen3-ASR 1.7B 本地".to_string()
        } else {
            format!("本地 Whisper · {}", cfg.asr.local_model)
        }
    } else {
        cfg.asr.model.clone()
    };
    events::emit(
        &app,
        "sn-meta",
        serde_json::json!({
            "asrModel": asr_label,
            "llmEnabled": llm_active,
            "llmModel": cfg.llm.model,
            "skip": skip_llm,
            "translate": translating || (llm_active && cfg.llm.mode == "translate"),
        }),
    );

    // 流式：把剩余尾部入队并标记收尾（全是本会话自己的队列）。
    // 切段互斥：CAS 把游标推到 usize::MAX 占位——watch 的切段路径见到
    // MAX 即放弃，杜绝 stop 与 watch 同拍取到同一游标导致尾部重复入队
    if sess.streaming {
        let rate = rec.shared.rate();
        let mut cut = sess.stream_cut.load(Ordering::SeqCst);
        for _ in 0..10 {
            if sess
                .stream_cut
                .compare_exchange(cut, usize::MAX, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                let tail = rec.shared.take_range(cut);
                if !tail.is_empty() {
                    let seg16 = audio::to_16k_i16(&tail, rate);
                    sess.stream_queue
                        .lock().unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push_back(seg16);
                    sess.stream_notify.notify_one();
                }
                break;
            }
            cut = sess.stream_cut.load(Ordering::SeqCst);
            if cut == usize::MAX {
                break; // watch 正持占位切段，它切完会推进游标
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        sess.stream_done.store(true, Ordering::SeqCst);
        // 收尾标记置位后唤醒 worker：它可能正挂在 notified() 上等新分段
        sess.stream_notify.notify_one();
    }

    // 说话探测门控依据：录音以多长静音收尾 + 停录时刻（静音收尾且管线
    // 耗时短 → 粘贴前跳过 ~300ms 的麦克风探测录音）
    let stop_info = Some((rec.shared.silence_ms(), Instant::now()));
    // 整段重采样（120s@48k 约 50-100ms 纯 CPU）移到阻塞线程池，不占
    // tokio 工作线程
    let captured = match tauri::async_runtime::spawn_blocking(move || audio::finish(rec)).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[speaknow] 收尾音频处理异常: {e}");
            return;
        }
    };
    let stream = if sess.streaming { Some(sess) } else { None };
    process_audio(app, cfg, captured.samples, from_ui, skip_llm, stream, stop_info).await;
}

/// 录音结束后的处理流水线（识别 → AI 优化 → 输入）；重试也走这里。
/// `stream`：本会话的流式分段状态；重试没有活跃会话，传 None 整段识别，
/// 也不再等待/合流任何流式状态（旧版重试会误等新录音的流式会话）。
/// `stop_info`：(录音收尾时的静音时长, 停录时刻)——供粘贴路径判定可否
/// 跳过说话探测；重试传 None（无从判定，保守探测）
pub async fn process_audio(
    app: AppHandle,
    cfg: Config,
    samples: Vec<i16>,
    from_ui: bool,
    skip_llm: bool,
    stream: Option<Arc<Session>>,
    stop_info: Option<(u64, Instant)>,
) {
    let streaming = stream.is_some();
    // 空 Key 的云端端点每次调用都注定 401：与其白发一次失败请求、等重试
    // 提示再回退原文，不如判未就绪直接跳过 AI 环节（本地端点免 Key 不受影响）
    let llm_active = !skip_llm && llm::llm_ready(&cfg.llm);
    // 本代会话标识：若处理期间用户开始了新录音，本代结果作废，不再输入。
    // 重试无会话：以当前代数为准（重试期间新录音开始同样作废）
    let gen = stream
        .as_ref()
        .map(|s| s.gen)
        .unwrap_or_else(|| app.state::<Ctx>().run_gen.load(Ordering::SeqCst));

    // 极短录音视为误触，温和忽略（不识别、不写入历史）。阈值可调：hold
    // 模式说单词级短口令（「好」「停」）被 800ms 默认吞掉时可在快捷键页调低
    let duration_secs = samples.len() as f64 / 16_000.0;
    let min_secs = (cfg.hotkey.min_duration_ms.max(0) as f64) / 1000.0;
    if duration_secs < min_secs {
        emit_status(&app, "done", "已忽略（录音太短）", false);
        hide_later(&app, 1400);
        return;
    }

    let asr_note = if streaming {
        "整理分段识别结果…"
    } else if cfg.asr.provider == "local" {
        "语音识别中（本地模型，首次加载需数秒）…"
    } else {
        "语音识别中…"
    };
    emit_status(&app, "transcribing", asr_note, false);
    let t_asr = Instant::now();

    // 本次结果中「确定缺句」的流式分段数：只有最终采纳的是流式拼接结果时
    // 失败分段才真的缺失（整段兜底成功会覆盖全部失败分段，不计入，否则
    // 会对着完整文本误报「可能不完整」）
    let mut failed_segs_in_result = 0usize;
    let raw = if let Some(sess) = stream.as_ref() {
        // 等待本会话分段 worker 处理完队列（上限 30 秒；会话被新录音
        // 取代时立即放弃等待，由后置的代数检查统一作废）
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut wait_timed_out = false;
        loop {
            if sess.stream_finished.load(Ordering::SeqCst) {
                break;
            }
            if app.state::<Ctx>().run_gen.load(Ordering::SeqCst) != sess.gen {
                eprintln!("[speaknow] 流式收尾被新录音取代");
                break;
            }
            if Instant::now() > deadline {
                eprintln!("[speaknow] 等待流式分段超时");
                wait_timed_out = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        let joined = {
            let texts = sess.stream_texts.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            asr::join_transcripts(&texts)
        };
        if joined.trim().is_empty() {
            // 兜底：整段识别
            asr::transcribe(&app, &cfg.asr, &samples).await
        } else {
            failed_segs_in_result = sess.stream_failed.load(Ordering::SeqCst);
            if wait_timed_out {
                // 超时放弃等待时队列里可能还有未识别的分段：这些段既没进
                // stream_texts 也没进失败计数，一并计入缺句数，否则
                // 「缺 N 段」提示会漏报
                let left = sess
                    .stream_queue
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .len();
                failed_segs_in_result += left;
            }
            Ok(joined)
        }
    } else {
        asr::transcribe(&app, &cfg.asr, &samples).await
    };

    let raw = match raw {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[speaknow] ASR 失败: {e:#}");
            // 保留音频供「重试」
            *app.state::<Ctx>().last_audio.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some((samples.clone(), from_ui));
            events::emit(&app, "sn-retryable", serde_json::json!(true));
            finish_status(
                &app,
                "error",
                &format!("语音识别失败：{e:#}"),
                3500,
                cfg.general.sound_feedback,
            );
            return;
        }
    };
    let asr_ms = t_asr.elapsed().as_millis() as u64;
    {
        let engine = if cfg.asr.provider == "local" {
            format!("local/{}", cfg.asr.local_model)
        } else {
            format!("{}/{}", cfg.asr.provider, cfg.asr.model)
        };
        let rtf = if asr_ms > 0 && duration_secs > 0.0 {
            format!("，实时率 {:.1}×", duration_secs * 1000.0 / asr_ms as f64)
        } else {
            String::new()
        };
        crate::trace_pipeline(
            &app,
            &format!(
                "识别耗时 {asr_ms}ms（音频 {duration_secs:.1}s{rtf}，{engine}，{}字）",
                raw.chars().count()
            ),
        );
    }

    // 语气词清理（"嗯/呃/yeah" 等口头音与呼吸声幻觉）
    let raw = if cfg.asr.strip_fillers {
        crate::text_clean::strip_fillers(&raw)
    } else {
        raw
    };

    if raw.trim().is_empty() {
        *app.state::<Ctx>().last_audio.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some((samples.clone(), from_ui));
        events::emit(&app, "sn-retryable", serde_json::json!(true));
        finish_status(
            &app,
            "error",
            "未识别到语音内容，可点「重试」或再录一次",
            2500,
            cfg.general.sound_feedback,
        );
        return;
    }

    // 分段失败可见化：done 消息末尾附带警示（不混入转写文本本身、不新增
    // 事件类型）。空串时 format! 拼接零开销，各收尾消息保持原文
    let seg_fail_note = if failed_segs_in_result > 0 {
        format!(" · ⚠ 有 {failed_segs_in_result} 个分段识别失败，结果可能不完整")
    } else {
        String::new()
    };
    // AI 优化开启却未就绪（缺 Key / 缺地址）被跳过时说明缘由：否则用户看到
    // 原文直出，只会以为 AI 优化坏了。快速模式（skip_llm）与主动关闭是用户
    // 本意，不打扰
    let llm_skip_note = if !skip_llm && cfg.llm.enabled && !llm_active {
        if cfg.llm.base_url.trim().is_empty() {
            " · AI 优化未配置地址，本次输出原文".to_string()
        } else {
            " · AI 优化未配置 API Key，本次输出原文".to_string()
        }
    } else {
        String::new()
    };
    let done_note = format!("{seg_fail_note}{llm_skip_note}");

    // 会话已过期：新录音已开始，本代结果不再上屏、不再输入（防止旧文本
    // 晚到覆盖新输入；先于 sn-raw，过期转写连悬浮窗都不闪现）
    if gen != app.state::<Ctx>().run_gen.load(Ordering::SeqCst) {
        crate::trace_pipeline(&app, &format!("识别完成但已过期（gen {gen}），跳过输入"));
        finish_status(&app, "done", "已跳过（已被新的录音取代）", 2000, false);
        return;
    }

    // 第一时间把原始转写推给悬浮窗预览（AI 优化期间即可阅读）
    events::emit(&app, "sn-raw", serde_json::json!({ "text": raw }));

    let mut final_text = raw.clone();
    let mut llm_ms = 0u64;
    let mut llm_first_ms = 0u64;
    if llm_active {
        emit_status(&app, "optimizing", "AI 纠错与优化中…", false);
        let t_llm = Instant::now();
        let first_token = AtomicU64::new(0);
        // 优化期间开始新录音则立即中止流式读取：省流量，也不再扰动新一轮悬浮窗
        let stale_app = app.clone();
        let stale = move || stale_app.state::<Ctx>().run_gen.load(Ordering::SeqCst) != gen;
        match llm::optimize_streaming(&cfg.llm, &raw, &app, Some(&first_token), Some(&stale)).await
        {
            Ok(t) if !t.trim().is_empty() => {
                final_text = t;
                // 翻译双语输出：原文一行 + 译文一行（原文取语气词清理后的转写，
                // 方便核对面板/历史里对照原意）
                if cfg.llm.mode == "translate" && cfg.llm.translate_output == "bilingual" {
                    final_text = format!("{raw}\n{final_text}");
                }
            }
            Ok(_) => {
                // 空正文（思考烧尽预算且重试仍空 / 模型异常）：不再静默吞掉，让用户知道为何是原文
                crate::trace_pipeline(
                    &app,
                    "AI 优化返回空正文（思考超限或模型异常），使用原始识别结果",
                );
                emit_status(
                    &app,
                    "optimizing",
                    "AI 未返回正文，使用原始识别结果…",
                    false,
                );
                // 提示停留：异步 sleep，不阻塞 tokio 工作线程
                tokio::time::sleep(Duration::from_millis(700)).await;
            }
            Err(e) => {
                // 被新录音取代：直接放弃本代结果，不再回退输入旧文本
                if app.state::<Ctx>().run_gen.load(Ordering::SeqCst) != gen {
                    crate::trace_pipeline(&app, &format!("AI 优化中止（{e:#}），本代已过期"));
                    finish_status(&app, "done", "已跳过（已被新的录音取代）", 2000, false);
                    return;
                }
                eprintln!("[speaknow] AI 优化失败: {e:#}");
                emit_status(&app, "optimizing", "AI 优化失败，使用原始识别结果…", false);
                tokio::time::sleep(Duration::from_millis(600)).await;
            }
        }
        llm_ms = t_llm.elapsed().as_millis() as u64;
        llm_first_ms = first_token.load(Ordering::SeqCst);
        let gen_ms = llm_ms.saturating_sub(llm_first_ms);
        let speed = if gen_ms > 200 {
            let cps = final_text.chars().count() as f64 * 1000.0 / gen_ms as f64;
            format!("，生成 {:.0}字/s", cps)
        } else {
            String::new()
        };
        crate::trace_pipeline(
            &app,
            &format!(
                "AI 优化耗时 {llm_ms}ms（首字 {llm_first_ms}ms，生成 {gen_ms}ms{speed}，{}，{}字）",
                cfg.llm.model,
                final_text.chars().count()
            ),
        );
        crate::trace_pipeline(
            &app,
            &format!(
                "耗时对比｜识别 {asr_ms}ms｜优化 {llm_ms}ms（首字 {llm_first_ms}ms）｜合计 {}ms",
                asr_ms + llm_ms
            ),
        );
    }

    // AI 优化耗时较久，期间可能已开始新录音：本代结果作废，不再进入输入/预览
    if llm_active && gen != app.state::<Ctx>().run_gen.load(Ordering::SeqCst) {
        crate::trace_pipeline(&app, "AI 优化完成但已过期，跳过输入");
        finish_status(&app, "done", "已跳过（已被新的录音取代）", 2000, false);
        return;
    }

    // 输出前的确定性标点规整：紧邻汉字的半角标点全角化、中英文之间补空格。
    // 对 LLM 输出与快速模式原文一视同仁——这类格式问题不该依赖模型自觉
    let final_text = crate::text_clean::tidy_punct(&final_text);

    if from_ui {
        // 测试模式的复制同样可能失败（剪贴板被剪贴板管理器/其他进程占用）：
        // 如实报错而不是照常提示「已复制」——否则用户一试回放粘出旧内容，
        // 会误判成识别错误而不是剪贴板问题
        match inject::copy_only(&final_text) {
            Ok(()) => {
                finish_status(
                    &app,
                    "done",
                    &format!("已复制到剪贴板（测试模式）{done_note}"),
                    3200,
                    cfg.general.sound_feedback,
                );
            }
            Err(e) => {
                eprintln!("[speaknow] 测试模式复制到剪贴板失败: {e:#}");
                finish_status(
                    &app,
                    "error",
                    &format!("复制失败：{e:#}"),
                    3500,
                    cfg.general.sound_feedback,
                );
            }
        }
        return;
    }

    // 预览编辑模式：结果进入悬浮窗编辑器，确认后再输入。
    // 本地悬浮窗被抑制（外接显示独占）时无处编辑，退回直接输入。
    if cfg.output.review && cfg.output.auto_paste && !suppress_local_overlay(&cfg) {
        *app.state::<Ctx>().pending_review.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(PendingReview {
            raw: raw.clone(),
            final_text: final_text.clone(),
            asr_ms,
            llm_ms,
        });
        events::emit(
            &app,
            "sn-review",
            // asrMs/llmMs 供审阅卡展示耗时徽标（与 done 卡的「识别 X · 优化 Y」
            // 对齐；值为 0 时前端省略对应段）
            serde_json::json!({
                "text": final_text,
                "raw": raw,
                "llmUsed": llm_ms > 0,
                "asrMs": asr_ms,
                "llmMs": llm_ms,
            }),
        );
        emit_status(&app, "review", "可编辑 · Enter 输入 · Esc 取消", false);
        overlay::show_review(&app);
        return;
    }

    finish_and_input(
        &app,
        &cfg,
        &raw,
        &final_text,
        asr_ms,
        llm_ms,
        gen,
        llm_first_ms,
        duration_secs,
        stop_info,
        &done_note,
    )
    .await;
}

/// 直接输入路径（历史 + 事件 + 粘贴）。gen 为本代会话代数：粘贴前若已有
/// 新录音开始（代数前移），放弃输入并提示「已跳过」，杜绝旧句子晚到落进光标。
/// note：追加到 done 阶段消息末尾的附加提示（流式分段失败 / AI 优化跳过说明；空 = 无）。
/// 只挂在 done 消息上——error 阶段消息已自带失败原因，再追加缺句警示只会冲淡重点
#[allow(clippy::too_many_arguments)]
pub async fn finish_and_input(
    app: &AppHandle,
    cfg: &Config,
    raw: &str,
    final_text: &str,
    asr_ms: u64,
    llm_ms: u64,
    gen: u64,
    llm_first_ms: u64,
    audio_secs: f64,
    stop_info: Option<(u64, Instant)>,
    note: &str,
) {
    history::push(app, raw, final_text, asr_ms, llm_ms, "dictation");
    events::emit(
        app,
        "sn-result",
        serde_json::json!({
            "raw": raw,
            "final": final_text,
            "asrMs": asr_ms,
            "llmMs": llm_ms,
            "llmFirstMs": llm_first_ms,
            "audioSecs": audio_secs,
        }),
    );

    if cfg.output.auto_paste {
        let undo_hint = if cfg!(target_os = "macos") {
            "⌘Z"
        } else {
            "Ctrl+Z"
        };
        let ok_msg = if cfg.output.method == "clipboard" {
            format!("已输入到光标处（{undo_hint} 可撤销）")
        } else {
            "已输入到光标处".to_string()
        };
        // paste_text_checked 内部要等待用户松键/焦点回归（可能 1~2 秒），放阻塞线程池；
        // 说话门限取 VAD 阈值（%）并设下限，探测到正在说话时暂缓输入。
        // quiet_stop：静音收尾（≥600ms，VAD 停录即如此）且停录到此刻 ≤2s——
        // 正在说话概率极低，跳过那次 ~300ms 的探测录音；重试无从判定则保守探测
        let quiet_stop = stop_info
            .map(|(silence, at)| silence >= 600 && at.elapsed() <= Duration::from_millis(2000))
            .unwrap_or(false);
        let out_cfg = cfg.output.clone();
        let text = final_text.to_string();
        let device = cfg.audio.device.clone();
        let voice_gate = (cfg.audio.vad_threshold * 100.0).max(2.0);
        let h = app.clone();
        let superseded = Arc::new(move || h.state::<Ctx>().run_gen.load(Ordering::SeqCst) != gen);
        let r = tauri::async_runtime::spawn_blocking(move || {
            inject::paste_text_checked(
                &out_cfg,
                &text,
                superseded,
                device.as_deref(),
                Some(voice_gate),
                quiet_stop,
            )
        })
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!("输入线程异常: {e}")));
        match r {
            Ok(true) => {
                crate::trace_pipeline(app, "已输入");
                finish_status(app, "done", &format!("{ok_msg}{note}"), 3200, cfg.general.sound_feedback);
            }
            Ok(false) => {
                crate::trace_pipeline(app, "输入跳过（已被新录音取代，结果已复制到剪贴板）");
                finish_status(
                    app,
                    "done",
                    &format!("已被新录音取代 · 结果已复制，可右键 / Ctrl+V 手动粘贴{note}"),
                    3200,
                    cfg.general.sound_feedback,
                );
            }
            Err(ref e) => {
                crate::trace_pipeline(app, &format!("输入失败：{e:#}"));
                // 模拟按键失败的高频场景补一句可自查的原因：UIPI 提权场景在
                // inject 里有专属报错，这里覆盖其余三个（文案不追加给剪贴板
                // 写入类失败——那是另一类问题，追加只会误导）
                let et = format!("{e:#}");
                let hint = if et.contains("模拟") || et.contains("键盘") || et.contains("按键") {
                    "\n常见原因：目标在锁屏 / UAC 弹窗 / 远程会话中（系统会拦截模拟按键），或目标窗口未真正获得焦点"
                } else {
                    ""
                };
                finish_status(
                    app,
                    "error",
                    &format!("输入失败：{et}{hint}"),
                    4000,
                    cfg.general.sound_feedback,
                );
            }
        }
    } else {
        // auto_paste 关闭时剪贴板是唯一输出通道：写入失败必须如实报错，
        // 否则「已复制」提示会让用户对着旧剪贴板内容 Ctrl+V
        match inject::copy_only(final_text) {
            Ok(()) => {
                finish_status(
                    app,
                    "done",
                    &format!("已复制到剪贴板{note}"),
                    3200,
                    cfg.general.sound_feedback,
                );
            }
            Err(e) => {
                eprintln!("[speaknow] 结果复制到剪贴板失败: {e:#}");
                finish_status(
                    app,
                    "error",
                    &format!("复制失败：{e:#}"),
                    3500,
                    cfg.general.sound_feedback,
                );
            }
        }
    }
}

fn finish_status(app: &AppHandle, stage: &str, msg: &str, hide_after_ms: u64, sound: bool) {
    emit_status(app, stage, msg, sound);
    hide_later(app, hide_after_ms);
}

/// 悬浮窗延迟隐藏的共享倒计时（ms，0 = 无待隐藏）。单一 reaper 线程消费，
/// hide_later 只重置数值——旧版每次调用 spawn 一条线程，预览卡钉住（悬停
/// 阅读）期间线程无限累积常驻；现在钉多久都只有这一条 reaper。
static HIDE_REMAINING_MS: AtomicU64 = AtomicU64::new(0);
static HIDE_REAPER: Once = Once::new();

/// 延迟隐藏悬浮窗；期间若悬停（pinned）则计时暂停，若开始新录音则取消。
/// 实际时长按 general.linger_mult 缩放（「卡片驻留时长」设置：短/标准/长
/// 统一作用于所有收尾卡，后端侧的 hide 调用点无需逐个改）
pub fn hide_later(app: &AppHandle, ms: u64) {
    let mult = app
        .state::<Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .map(|c| c.general.linger_mult)
        .unwrap_or(1.0)
        .clamp(0.3, 3.0);
    let scaled = ((ms.max(100) as f32) * mult).round() as u64;
    HIDE_REMAINING_MS.store(scaled, Ordering::SeqCst);
    HIDE_REAPER.call_once(|| {
        let handle = app.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(100));
            let state = handle.state::<Ctx>();
            if state.recording.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_some() {
                // 新录音开始：取消隐藏倒计时
                HIDE_REMAINING_MS.store(0, Ordering::SeqCst);
                continue;
            }
            if state.overlay_pinned.load(Ordering::SeqCst)
                || crate::translate::overlay_hide_guarded()
            {
                // 悬停阅读中，或翻译卡生命周期内（听写晚到的收尾会重新武装
                // 倒计时，不得把流式进行中的翻译卡连窗藏掉）：计时暂停
                continue;
            }
            let left = HIDE_REMAINING_MS.load(Ordering::SeqCst);
            if left == 0 {
                continue;
            }
            let new = left.saturating_sub(100);
            if HIDE_REMAINING_MS
                .compare_exchange(left, new, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                continue; // 并发重置了倒计时，按新值重新计
            }
            if new == 0 {
                overlay::hide(&handle);
                emit_status(&handle, "idle", "", false);
            }
        });
    });
}

/// 取消待隐藏倒计时（翻译卡启动前调用：旧听写卡遗留的倒计时若不清，
/// 会在新翻译流式期间把悬浮窗连卡片一起藏掉）
pub fn cancel_hide() {
    HIDE_REMAINING_MS.store(0, Ordering::SeqCst);
}

pub fn emit_status(app: &AppHandle, stage: &str, message: &str, sound: bool) {
    events::emit(
        app,
        "sn-status",
        serde_json::json!({ "stage": stage, "message": message, "sound": sound }),
    );
}

#[cfg(test)]
mod tests {
    use super::Agc;

    /// 模拟固定「增益前」语音电平：on_tick 收到的是增益后电平
    fn feed(agc: &mut Agc, pre_speech: f32, windows: usize) {
        for _ in 0..windows * Agc::WINDOW_TICKS {
            let post = pre_speech * 10f32.powf(agc.gain_db / 20.0);
            agc.on_tick(post);
        }
    }

    /// 输入过小且确有语音 → 逐窗口 +3dB，到目标后停住，并给出学得值
    #[test]
    fn agc_boosts_quiet_speech_and_converges() {
        let mut agc = Agc::new(0.0, true);
        feed(&mut agc, 0.03, 10);
        // 0.03 × ~4（12dB）≈ 0.12 ≥ 0.10 目标 → 恰好停在 +12dB
        assert!((agc.gain_db - 12.0).abs() < 0.01, "实际 {}", agc.gain_db);
        assert_eq!(agc.learned(), Some(12.0));
    }

    /// 纯底噪（增益前低于语音门限）绝不放大
    #[test]
    fn agc_ignores_noise_floor() {
        let mut agc = Agc::new(0.0, true);
        feed(&mut agc, 0.002, 8);
        assert!(agc.gain_db < 0.01, "实际 {}", agc.gain_db);
        assert!(agc.learned().is_none());
    }

    /// 正常音量不动
    #[test]
    fn agc_leaves_healthy_level_alone() {
        let mut agc = Agc::new(0.0, true);
        feed(&mut agc, 0.25, 4);
        assert!(agc.gain_db < 0.01, "实际 {}", agc.gain_db);
        assert!(agc.learned().is_none());
    }

    /// 接近削波 → 快速回落，且下限为基准 -12dB
    #[test]
    fn agc_backs_off_near_clipping() {
        let mut agc = Agc::new(20.0, true);
        feed(&mut agc, 0.95, 5);
        assert!((agc.gain_db - 8.0).abs() < 0.01, "实际 {}", agc.gain_db);
        assert_eq!(agc.learned(), Some(8.0));
    }

    /// 关闭时完全不参与
    #[test]
    fn agc_disabled_is_noop() {
        let mut agc = Agc::new(0.0, false);
        feed(&mut agc, 0.03, 6);
        assert!(agc.gain_db < 0.01);
        assert!(agc.learned().is_none());
    }
}
