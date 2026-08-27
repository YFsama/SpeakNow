mod asr;
mod audio;
mod config;
mod display_api;
mod events;
mod history;
mod hotkey;
mod inject;
mod llm;
pub mod local_whisper;
mod overlay;
mod pipeline;
mod qwen_asr;
mod tray;
mod text_clean;
mod wav;

#[cfg(target_os = "windows")]
pub mod win_volume;
pub mod caret;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// 预览编辑模式下的待确认内容
#[derive(Debug, Clone)]
pub struct PendingReview {
    pub raw: String,
    pub final_text: String,
    pub asr_ms: u64,
    pub llm_ms: u64,
}

/// 全局共享的应用状态
pub struct Ctx {
    pub config: Mutex<Option<config::Config>>,
    pub recording: Mutex<Option<audio::Recording>>,
    pub watcher_cancel: Arc<AtomicBool>,
    /// 快速模式（跳过 AI 优化）标记，start 时置位、run 时消费
    pub skip_llm_next: AtomicBool,
    /// 预览卡悬停暂停自动隐藏
    pub overlay_pinned: AtomicBool,
    /// 流式分段会话状态
    pub stream_active: AtomicBool,
    pub stream_done: AtomicBool,
    pub stream_finished: AtomicBool,
    pub stream_cut: AtomicUsize,
    pub stream_queue: Mutex<VecDeque<Vec<i16>>>,
    pub stream_texts: Mutex<Vec<String>>,
    /// 预览编辑待确认内容
    pub pending_review: Mutex<Option<PendingReview>>,
    /// 最近一次失败/为空的录音（供「重试」）：(采样, 是否来自设置页)
    pub last_audio: Mutex<Option<(Vec<i16>, bool)>>,
    /// 悬浮窗被手动拖动后，本次会话固定位置不再自动跟随
    pub overlay_manual: AtomicBool,
    /// 录音会话代数：新录音开始时 +1，仍在处理中的旧结果若晚到则作废（避免旧文本覆盖新输入）
    pub run_gen: AtomicU64,
}

impl Ctx {
    pub fn hotkey_mode(&self) -> String {
        self.config
            .lock()
            .unwrap()
            .as_ref()
            .map(|c| c.hotkey.mode.clone())
            .unwrap_or_else(|| "toggle".into())
    }
}

#[tauri::command]
fn get_config(app: AppHandle) -> config::Config {
    app.state::<Ctx>()
        .config
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_default()
}

/// 保存链路追踪：追加到 app_config_dir/save-trace.log（超过 256KB 自动截断），用于诊断“自动保存卡住”
fn trace_save(app: &AppHandle, msg: &str) {
    use std::io::Write;
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let p = dir.join("save-trace.log");
    if let Ok(meta) = std::fs::metadata(&p) {
        if meta.len() > 256 * 1024 {
            let _ = std::fs::remove_file(&p);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(f, "{ts} {msg}");
    }
}

#[tauri::command]
async fn save_config(app: AppHandle, config: config::Config) -> Result<String, String> {
    let t0 = std::time::Instant::now();
    trace_save(&app, "invoke 进入");
    // 取旧配置：仅快捷键真正变化时才重注册（注册需经主线程，主线程被麦克风
    // 等同步命令占用时会让保存卡住——见 save-trace.log 诊断记录）
    let old = app
        .state::<Ctx>()
        .config
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_default();
    if let Err(e) = config::save(&app, &config) {
        trace_save(&app, &format!("写文件失败 {e:#}"));
        return Err(e.to_string());
    }
    trace_save(&app, &format!("写文件 {}ms", t0.elapsed().as_millis()));
    *app.state::<Ctx>().config.lock().unwrap() = Some(config.clone());
    trace_save(&app, &format!("内存更新 {}ms", t0.elapsed().as_millis()));

    let mut messages = vec!["已保存".to_string()];
    if config.hotkey != old.hotkey {
        // 后台线程重注册：不阻塞保存响应；失败记入追踪日志
        let h = app.clone();
        let hk = config.hotkey.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = hotkey::apply(&h, &hk) {
                eprintln!("[speaknow] 快捷键重注册失败: {e:#}");
                trace_save(&h, &format!("快捷键注册失败 {e:#}"));
            } else {
                trace_save(&h, &format!("快捷键重注册(后台) {}ms", t0.elapsed().as_millis()));
            }
        });
    }
    if let Err(e) = apply_autostart(&app, config.general.autostart) {
        trace_save(&app, &format!("自启设置失败 {e}"));
        messages.push(format!("开机自启：{e}"));
    }
    // 外接显示服务：相关配置变化时启停/重启（仅本地行为变化则不打扰已连接硬件）
    if config.external_display != old.external_display {
        let ext = config.external_display.clone();
        tauri::async_runtime::spawn_blocking(move || display_api::apply(&ext));
    }
    let _ = app.emit("sn-config-changed", ());
    trace_save(&app, &format!("完成 {}ms", t0.elapsed().as_millis()));
    Ok(messages.join("；"))
}

/// 录音/输入链路事件追踪：追加到 app_config_dir/pipeline.log（超过 256KB 自动截断）。
/// 用于诊断「录音提前结束 / 旧结果晚到输入」这类时序问题。
pub fn trace_pipeline(app: &AppHandle, msg: &str) {
    use std::io::Write;
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let p = dir.join("pipeline.log");
    if let Ok(meta) = std::fs::metadata(&p) {
        if meta.len() > 256 * 1024 {
            let _ = std::fs::remove_file(&p);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let ts = now_unix_ms();
        let _ = writeln!(f, "{ts} {msg}");
    }
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn apply_autostart(app: &AppHandle, want: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    let cur = al.is_enabled().unwrap_or(false);
    if want == cur {
        return Ok(());
    }
    if want {
        al.enable().map_err(|e| format!("启用失败: {e}"))
    } else {
        al.disable().map_err(|e| format!("禁用失败: {e}"))
    }
}

#[tauri::command]
fn reset_config(app: AppHandle) -> Result<config::Config, String> {
    let cfg = config::Config::default();
    config::save(&app, &cfg).map_err(|e| e.to_string())?;
    *app.state::<Ctx>().config.lock().unwrap() = Some(cfg.clone());
    // 后台线程重注册（apply 需经主线程派发，勿在主线程同步等待）
    let h = app.clone();
    let hk = cfg.hotkey.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = hotkey::apply(&h, &hk) {
            eprintln!("[speaknow] {e:#}");
        }
    });
    let _ = apply_autostart(&app, false);
    Ok(cfg)
}

#[tauri::command]
fn open_config_dir(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))?;
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer");
        c.arg(&dir);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&dir);
        c
    };
    cmd.spawn().map_err(|e| format!("打开目录失败: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn list_devices() -> Vec<audio::DeviceInfo> {
    // WASAPI 枚举可能因蓝牙/无线设备慢而阻塞，放到阻塞线程池，避免占住主线程
    tauri::async_runtime::spawn_blocking(audio::list_inputs)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn mic_test(
    app: AppHandle,
    device: Option<String>,
    playback: bool,
    gain_db: f32,
) -> Result<serde_json::Value, String> {
    let emitter_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ms = if playback { 3000 } else { 1400 };
        audio::mic_test(device.as_deref(), playback, gain_db, ms, |level| {
            let _ = emitter_app.emit("sn-mic-level", level);
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|r| {
        serde_json::json!({
            "avgLevel": r.avg_level,
            "peakLevel": r.peak_level,
            "wavBase64": r.wav_base64,
        })
    })
    .map_err(|e| format!("{e:#}"))
}

/* ---------- 麦克风深度诊断 ---------- */

/// 读取系统输入端点音量（0~100）与静音状态（仅 Windows）
#[tauri::command]
async fn mic_volume_info(device: Option<String>) -> Result<serde_json::Value, String> {
    // COM 调用可能因无线设备响应慢而阻塞，移出主线程
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            win_volume::get_volume(device.as_deref())
                .map(|(name, vol, muted)| {
                    serde_json::json!({
                        "device": name,
                        "volume": (vol * 100.0).round(),
                        "muted": muted,
                    })
                })
                .ok_or_else(|| "无法读取系统音量（仅支持 Windows）".to_string())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = device;
            Err("仅 Windows 支持系统音量调节".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 直接设置系统输入端点音量（0~100），可同时解除静音 —— 立即生效，无需保存
#[tauri::command]
async fn set_mic_volume(device: Option<String>, volume: f32, unmute: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            win_volume::set_volume(device.as_deref(), volume / 100.0, unmute)
                .ok_or_else(|| "设置系统音量失败".to_string())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (device, volume, unmute);
            Err("仅 Windows 支持系统音量调节".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取 Windows 麦克风授权状态（CapabilityAccessManager ConsentStore）
#[cfg(target_os = "windows")]
fn consent_status() -> (String, String) {
    use winreg::enums::*;
    use winreg::RegKey;

    let read = |root: RegKey, path: &str| -> Option<String> {
        let k = root.open_subkey(path).ok()?;
        let v: String = k.get_value("Value").ok()?;
        Some(v)
    };
    let base = "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    let system = read(RegKey::predef(HKEY_LOCAL_MACHINE), base)
        .or_else(|| read(RegKey::predef(HKEY_CURRENT_USER), base))
        .unwrap_or_else(|| "Unknown".into());

    // 本应用（非打包桌面应用）的单独授权记录
    let mut app = "Unknown".to_string();
    if let Ok(nonpackaged) = hkcu.open_subkey(format!("{base}\\NonPackaged")) {
        for name in nonpackaged.enum_keys().flatten() {
            if name.to_lowercase().ends_with("speaknow.exe") {
                if let Ok(k) = nonpackaged.open_subkey(&name) {
                    if let Ok(v) = k.get_value::<String, _>("Value") {
                        app = v;
                    }
                }
            }
        }
    }
    (system, app)
}

#[cfg(not(target_os = "windows"))]
fn consent_status() -> (String, String) {
    ("Unknown".into(), "Unknown".into())
}

#[tauri::command]
async fn mic_diagnose(device: Option<String>) -> Result<serde_json::Value, String> {
    let dev_for_capture = device.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        audio::mic_test(dev_for_capture.as_deref(), false, 0.0, 1800, |_| {})
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{e:#}"))?;

    let (system_privacy, app_privacy) = consent_status();
    let denied = |v: &str| v.eq_ignore_ascii_case("Deny");

    // 系统端点音量（仅 Windows）
    let (sys_volume, sys_muted, sys_dev) = {
        #[cfg(target_os = "windows")]
        {
            match win_volume::get_volume(device.as_deref()) {
                Some((n, v, m)) => (Some((v * 100.0).round()), m, Some(n)),
                None => (None, false, None),
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            (None, false, None)
        }
    };

    let mut findings: Vec<String> = Vec::new();
    // 通道分析：多声道时自动选取信号最强通道
    let best_channel = r
        .channel_peaks
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map(|(i, v)| (i, *v));
    if r.channel_peaks.len() > 1 {
        if let Some((i, v)) = best_channel {
            if v > 5.0 {
                findings.push(format!(
                    "设备为 {} 声道：已自动选取信号最强的通道 {}（峰值 {:.0}%），若整体仍偏弱可配合增益",
                    r.channel_peaks.len(),
                    i + 1,
                    v
                ));
            }
        }
    }
    if sys_muted {
        findings.push(
            "系统层面该麦克风处于「静音」状态：请在下方「系统输入音量」一键解除静音".into(),
        );
    }
    if let Some(v) = sys_volume {
        if v < 20.0 {
            findings.push(format!(
                "系统输入音量仅 {v:.0}%：电平会严重不足，建议在下方「系统输入音量」直接拉到 80–100"
            ));
        }
    }
    if denied(&system_privacy) {
        findings.push(
            "Windows 已对麦克风关闭（系统级总开关为 Deny）：所有桌面应用都会采到静音。请到 设置 → 隐私和安全性 → 麦克风，开启「麦克风访问」与「允许桌面应用访问麦克风」".into(),
        );
    } else if denied(&app_privacy) {
        findings.push(
            "SpeakNow 被 Windows 单独拒绝了麦克风权限：请在 设置 → 隐私和安全性 → 麦克风 的应用列表中找到 SpeakNow 并允许".into(),
        );
    }
    if r.frames == 0 {
        findings.push("音频流已打开但没有返回任何数据：设备可能被其他应用独占，或驱动异常，可尝试重新插拔接收器".into());
    } else if r.peak_level < 0.5 {
        if findings.is_empty() {
            findings.push(
                "音频流已打开、权限与系统音量均正常，但采到的全是静音：极可能是「选错了输入端点」——点下方「📡 同测全部设备」，所有设备同时采集，谁亮谁就是你正在说话的麦克风".into(),
            );
            findings.push(
                "若全部设备都无信号：检查耳机麦克风杆是否插紧/是否被物理静音、2.4G 接收器是否正被另一台电脑占用（同一接收器同时只能连一台），并在 Armoury Crate / 声卡驱动面板里确认麦克风通道已启用".into(),
            );
        }
    } else if r.peak_level < 5.0 {
        findings.push("有信号但电平很低：使用「自动校准增益」或调高系统输入音量即可".into());
    } else if findings.is_empty() {
        findings.push("麦克风工作正常 ✅ 信号电平健康".into());
    }

    Ok(serde_json::json!({
        "frames": r.frames,
        "peakPercent": r.peak_level,
        "avgPercent": r.avg_level,
        "channelPeaks": r.channel_peaks,
        "systemPrivacy": system_privacy,
        "appPrivacy": app_privacy,
        "systemVolume": sys_volume,
        "systemMuted": sys_muted,
        "systemDevice": sys_dev,
        "findings": findings,
    }))
}

/// 逐个设备短测，找出真正有声音的输入端点
#[tauri::command]
async fn scan_devices() -> Result<Vec<serde_json::Value>, String> {
    let devs = audio::list_inputs();
    tauri::async_runtime::spawn_blocking(move || {
        devs.iter()
            .map(|d| {
                let r = audio::mic_test(Some(&d.name), false, 0.0, 900, |_| {});
                let (peak, avg, ok) = match r {
                    Ok(r) => (r.peak_level, r.avg_level, true),
                    Err(_) => (-1.0, -1.0, false),
                };
                serde_json::json!({
                    "name": d.name,
                    "isDefault": d.is_default,
                    "channels": d.channels,
                    "sampleRate": d.sample_rate,
                    "peakPercent": peak,
                    "avgPercent": avg,
                    "ok": ok,
                })
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())
}

/// 同时打开所有输入设备并发采集：一次说话即可看到哪个端点真正有声音。
/// 期间向前端发送 sn-mic-level-all 事件（{ 设备名: 当前电平 }）用于实时条形图。
#[tauri::command]
async fn mic_test_all(
    app: AppHandle,
    duration_ms: Option<u64>,
) -> Result<Vec<serde_json::Value>, String> {
    let emitter = app.clone();
    let rows = tauri::async_runtime::spawn_blocking(move || {
        audio::test_all_devices(duration_ms.unwrap_or(3200), |levels| {
            let mut m = serde_json::Map::new();
            for (name, lv) in levels {
                m.insert(name.clone(), serde_json::json!(lv));
            }
            let _ = emitter.emit("sn-mic-level-all", serde_json::Value::Object(m));
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "name": r.name,
                "isDefault": r.is_default,
                "channels": r.channels,
                "sampleRate": r.sample_rate,
                "avgPercent": r.avg_level,
                "peakPercent": r.peak_level,
                "channelPeaks": r.channel_peaks,
                "frames": r.frames,
                "ok": r.error.is_none(),
                "error": r.error,
            })
        })
        .collect())
}

/// 枚举驱动层硬件 dB 增益控件（Mic Boost / 麦克风加强等，仅 Windows）
#[tauri::command]
async fn mic_hw_levels(device: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            let levels = win_volume::hw_levels(device.as_deref());
            serde_json::to_value(&levels).map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = device;
            Ok(serde_json::json!([]))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 设置某个驱动硬件 dB 控件（返回对齐步进后的实际值）
#[tauri::command]
async fn set_mic_hw_level(
    device: Option<String>,
    name: String,
    db: f32,
) -> Result<f32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            win_volume::set_hw_level(device.as_deref(), &name, db)
                .ok_or_else(|| "未找到该硬件增益控件".to_string())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (device, name, db);
            Err("仅 Windows 支持硬件增益调节".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 重试最近一次失败的识别（复用已录音频，无需重新说话）
#[tauri::command]
async fn retry_last(app: AppHandle) -> Result<String, String> {
    let state = app.state::<Ctx>();
    let Some((samples, from_ui)) = state.last_audio.lock().unwrap().take() else {
        return Err("没有可重试的录音".into());
    };
    let cfg = state.config.lock().unwrap().clone().unwrap_or_default();
    drop(state);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        pipeline::process_audio(handle, cfg, samples, from_ui, false).await;
    });
    Ok("正在重试识别…".into())
}

/// 悬浮窗被手动拖动（true=固定当前位置，false=恢复自动跟随输入框）
#[tauri::command]
fn overlay_set_manual(app: AppHandle, manual: bool) {
    use tauri::Manager;
    app.state::<Ctx>()
        .overlay_manual
        .store(manual, Ordering::SeqCst);
}

/// 一键打开系统麦克风设置页
#[tauri::command]
fn open_mic_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:privacy-microphone"])
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
    }
    Ok(())
}

/// 增益自动校准：以 0dB 录 2.6 秒测原始峰值，计算建议增益（0~30dB）
#[tauri::command]
async fn auto_calibrate(device: Option<String>) -> Result<serde_json::Value, String> {
    let r = tauri::async_runtime::spawn_blocking(move || {
        audio::mic_test(device.as_deref(), false, 0.0, 2600, |_| {})
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{e:#}"))?;

    let peak = r.peak_level / 100.0; // 0~1
    if peak < 0.008 {
        return Ok(serde_json::json!({
            "peakPercent": r.peak_level,
            "suggestedDb": serde_json::Value::Null,
        }));
    }
    let target = 0.6f32;
    let db = (target / peak).log10() * 20.0;
    let suggested = (db.max(0.0).min(40.0) * 2.0).round() / 2.0;
    Ok(serde_json::json!({
        "peakPercent": r.peak_level,
        "suggestedDb": suggested,
    }))
}

/// 从设置页面手动触发录音（from_ui=true：结束时只复制结果，不自动输入）
#[tauri::command]
async fn start_recording(app: AppHandle, from_ui: bool) -> Result<String, String> {
    // 设备初始化可能阻塞（无线麦重连等），移出主线程
    tauri::async_runtime::spawn_blocking(move || {
        let _ = from_ui;
        pipeline::start(&app, false)?;
        Ok::<String, String>("ok".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn stop_recording(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pipeline::stop(&app, true)?;
        Ok::<String, String>("ok".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 用一小段静音音频验证 ASR 接口连通性与鉴权（本地模式则校验模型文件）
#[tauri::command]
async fn test_asr(app: AppHandle, config: config::AsrConfig) -> Result<String, String> {
    if config.provider == "local" {
        let id = config.local_model.clone();
        if id == qwen_asr::MODEL_ID {
            let st = qwen_asr::status(&app);
            if !st.downloaded {
                return Err("Qwen3-ASR 模型尚未下载完整，请先在下方下载".into());
            }
            if st.runtime_ready != Some(true) {
                return Err("llama.cpp 运行时缺失：点击模型卡片的「↓ 下载」可自动补全".into());
            }
            return Ok("Qwen3-ASR 已就绪 ✓（llama.cpp 引擎在首次识别时自动启动，之后秒级响应）".into());
        }
        let ok = local_whisper::status(&app)
            .into_iter()
            .find(|s| s.id == id)
            .map(|s| s.downloaded)
            .unwrap_or(false);
        return if ok {
            Ok(format!("本地模型 {id} 已就绪 ✓（识别效果请用快捷键实测）"))
        } else {
            Err(format!("本地模型 {id} 尚未下载，请先在下方下载"))
        };
    }
    let samples = vec![0i16; 8000];
    match asr::transcribe(&app, &config, &samples).await {
        Ok(t) => Ok(format!(
            "连接成功 ✓ 服务返回：{}",
            if t.trim().is_empty() { "(空文本)" } else { &t }
        )),
        Err(e) => Err(format!("{e:#}")),
    }
}

/// 内置本地模型列表与下载状态（Whisper 系列 + Qwen3-ASR）
#[tauri::command]
fn builtin_models(app: AppHandle) -> Vec<local_whisper::LocalModelStatus> {
    let mut v = local_whisper::status(&app);
    v.push(qwen_asr::status(&app));
    v
}

/// 下载内置本地模型（进度经 sn-model-progress 事件推送）
#[tauri::command]
async fn download_builtin(app: AppHandle, id: String, mirror: String) -> Result<(), String> {
    if id == qwen_asr::MODEL_ID {
        qwen_asr::download(&app).await.map_err(|e| format!("{e:#}"))
    } else {
        local_whisper::download(&app, &id, &mirror)
            .await
            .map_err(|e| format!("{e:#}"))
    }
}

/// 删除已下载的本地模型（释放磁盘空间）
#[tauri::command]
fn delete_builtin(app: AppHandle, id: String) -> Result<(), String> {
    let known = local_whisper::LOCAL_MODELS.iter().any(|d| d.id == id)
        || id == qwen_asr::MODEL_ID;
    if !known {
        return Err("未知模型".into());
    }
    if id == qwen_asr::MODEL_ID {
        // 服务进程占着 gguf 文件，必须先停
        qwen_asr::shutdown();
    }
    let root = local_whisper::models_root(&app).map_err(|e| e.to_string())?;
    let dir = root.join(&id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("删除失败: {e}"))?;
    }
    Ok(())
}

/// 获取 OpenAI 兼容接口（Ollama / LM Studio / 云端）的模型列表
#[tauri::command]
async fn list_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("未配置接口地址".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(format!("{base}/models"));
    if !api_key.trim().is_empty() {
        req = req.bearer_auth(api_key.trim());
    }
    let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, asr::truncate(&body, 200)));
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "响应不是 JSON".to_string())?;
    let mut ids: Vec<String> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    if ids.is_empty() {
        return Err("接口未返回任何模型（服务是否已加载模型？）".into());
    }
    Ok(ids)
}

#[tauri::command]
async fn test_llm(config: config::LlmConfig) -> Result<String, String> {
    match llm::optimize(&config, "这是一句用于侧连通性测试的语音转写文本，请原样纠错后输出。").await {
        Ok(t) => Ok(format!("连接成功 ✓ 模型返回：{t}")),
        Err(e) => Err(format!("{e:#}")),
    }
}

#[tauri::command]
fn get_history(app: AppHandle) -> Vec<history::HistoryItem> {
    history::load(&app)
}

#[tauri::command]
fn clear_history(app: AppHandle) {
    history::clear(&app);
}

#[tauri::command]
fn delete_history(app: AppHandle, ts: i64) {
    history::delete(&app, ts);
}

/// 用当前 AI 设置重新优化某条历史记录的原始转写
#[tauri::command]
async fn regenerate(app: AppHandle, ts: i64) -> Result<history::HistoryItem, String> {
    let cfg = app
        .state::<Ctx>()
        .config
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_default();
    if !cfg.llm.enabled || cfg.llm.base_url.trim().is_empty() {
        return Err("AI 优化未启用，请先在「AI 优化」中开启并保存".into());
    }
    let raw = history::find_raw(&app, ts).ok_or("未找到该条记录")?;
    let text = llm::optimize(&cfg.llm, &raw)
        .await
        .map_err(|e| format!("重新优化失败: {e:#}"))?;
    history::update_final(&app, ts, &text).ok_or("更新记录失败")?;
    history::load(&app)
        .into_iter()
        .find(|i| i.ts == ts)
        .ok_or_else(|| "记录已不存在".into())
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    inject::copy_only(&text).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn dismiss_overlay(app: AppHandle) {
    *app.state::<Ctx>().pending_review.lock().unwrap() = None;
    overlay::hide(&app);
    pipeline::emit_status(&app, "idle", "", false);
}

/// 预览编辑：确认输入编辑后的文本
#[tauri::command]
async fn confirm_edit(app: AppHandle, text: String) -> Result<(), String> {
    let pending = app
        .state::<Ctx>()
        .pending_review
        .lock()
        .unwrap()
        .take()
        .ok_or("没有待确认的输入")?;
    let cfg = app
        .state::<Ctx>()
        .config
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_default();

    overlay::hide(&app);
    // 等待焦点从悬浮窗回到目标窗口
    tokio::time::sleep(Duration::from_millis(180)).await;

    let out_cfg = cfg.output.clone();
    let t = text.clone();
    tauri::async_runtime::spawn_blocking(move || inject::paste_text(&out_cfg, &t))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("输入失败：{e:#}"))?;

    history::push(&app, &pending.raw, &text, pending.asr_ms, pending.llm_ms);
    events::emit(
        &app,
        "sn-result",
        serde_json::json!({
            "raw": pending.raw,
            "final": text,
            "asrMs": pending.asr_ms,
            "llmMs": pending.llm_ms,
        }),
    );
    let undo_hint = if cfg!(target_os = "macos") { "⌘Z" } else { "Ctrl+Z" };
    let msg = if cfg.output.method == "clipboard" {
        format!("已输入到光标处（{undo_hint} 可撤销）")
    } else {
        "已输入到光标处".to_string()
    };
    pipeline::emit_status(&app, "done", &msg, cfg.general.sound_feedback);
    pipeline::hide_later(&app, 2600);
    Ok(())
}

/// 预览编辑：取消本次输入
#[tauri::command]
fn cancel_review(app: AppHandle) {
    *app.state::<Ctx>().pending_review.lock().unwrap() = None;
    overlay::hide(&app);
    pipeline::emit_status(&app, "idle", "", false);
}

/// 预览编辑：对编辑框内容重新调用 AI 优化
#[tauri::command]
async fn optimize_text(app: AppHandle, text: String) -> Result<String, String> {
    let cfg = app
        .state::<Ctx>()
        .config
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_default();
    if !cfg.llm.enabled || cfg.llm.base_url.trim().is_empty() {
        return Err("AI 优化未启用".into());
    }
    llm::optimize(&cfg.llm, &text)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// 悬浮窗预览卡悬停时暂停自动隐藏
#[tauri::command]
fn overlay_pin(app: AppHandle, pinned: bool) {
    app.state::<Ctx>()
        .overlay_pinned
        .store(pinned, Ordering::SeqCst);
}

/// 通用文本导出：写入配置目录下指定文件，返回完整路径
#[tauri::command]
fn export_text(app: AppHandle, filename: String, content: String) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))?;
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(filename);
    std::fs::write(&path, content).map_err(|e| format!("写入失败: {e}"))?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn show_main(app: AppHandle) {
    tray::open_main_window(&app);
}

/* ---------- 外接显示（硬件字幕屏）API ---------- */

/// 外接显示服务当前状态（运行中/端口/可访问 URL/最近错误）
#[tauri::command]
fn display_status() -> serde_json::Value {
    display_api::status()
}

/// 在系统默认浏览器打开指定 URL（仅用于展示本服务自己的地址）
#[tauri::command]
fn open_display_page(url: String) -> Result<(), String> {
    if !url.starts_with("http://127.0.0.1:") && !url.starts_with("http://localhost:") && !url.starts_with("http://192.168.") && !url.starts_with("http://10.") && !url.starts_with("http://172.") {
        return Err("仅允许打开本机或局域网地址".into());
    }
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    cmd.spawn().map_err(|e| format!("打开失败：{e}"))?;
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// 本应用当前是否以管理员身份运行（管理员窗口注入按键需要）
#[tauri::command]
fn is_elevated() -> bool {
    #[cfg(target_os = "windows")]
    {
        crate::inject::win_elevated()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// 以管理员身份重启（UAC 确认后旧实例自动退出）。实现见 elevated_relay。
#[tauri::command]
async fn restart_elevated(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        // 中继子进程：等本实例退出后再触发 UAC 拉起提权实例，避开单实例弹回
        std::process::Command::new(exe)
            .arg(ELEVATED_RELAY_ARG)
            .spawn()
            .map_err(|e| format!("启动提权中继失败：{e}"))?;
        std::thread::sleep(std::time::Duration::from_millis(250));
        app.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("仅 Windows 支持".into())
    }
}

/// 提权中继参数：本进程不初始化应用，只等旧实例退出后以管理员拉起新实例。
/// 不能由旧实例直接 ShellExecute「runas」：新实例会先撞上单实例插件被弹回。
const ELEVATED_RELAY_ARG: &str = "--elevated-relay";

fn elevated_relay() {
    std::thread::sleep(std::time::Duration::from_millis(1200));
    #[cfg(target_os = "windows")]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        if let Ok(exe) = std::env::current_exe() {
            let verb = HSTRING::from("runas");
            let path = HSTRING::from(exe.as_os_str());
            let _ = unsafe { ShellExecuteW(None, &verb, &path, None, None, SW_SHOWNORMAL) };
        }
    }
    std::process::exit(0);
}

pub fn run() {
    if std::env::args().any(|a| a == ELEVATED_RELAY_ARG) {
        elevated_relay();
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::open_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(Ctx {
            config: Mutex::new(None),
            recording: Mutex::new(None),
            watcher_cancel: Arc::new(AtomicBool::new(false)),
            skip_llm_next: AtomicBool::new(false),
            overlay_pinned: AtomicBool::new(false),
            stream_active: AtomicBool::new(false),
            stream_done: AtomicBool::new(false),
            stream_finished: AtomicBool::new(true),
            stream_cut: AtomicUsize::new(0),
            stream_queue: Mutex::new(VecDeque::new()),
            stream_texts: Mutex::new(Vec::new()),
            pending_review: Mutex::new(None),
            last_audio: Mutex::new(None),
            overlay_manual: AtomicBool::new(false),
            run_gen: AtomicU64::new(0),
        })
        .setup(|app| {
            let cfg = config::load(app.handle());
            *app.state::<Ctx>().config.lock().unwrap() = Some(cfg.clone());
            tray::setup(app.handle())?;
            if let Err(e) = hotkey::apply(app.handle(), &cfg.hotkey) {
                eprintln!("[speaknow] {e:#}");
            }
            if cfg.general.autostart {
                let _ = apply_autostart(app.handle(), true);
            }
            // 选中 Qwen3-ASR 时后台预启动引擎，首次快捷键识别即秒级响应
            if cfg.asr.provider == "local"
                && cfg.asr.local_model == qwen_asr::MODEL_ID
                && qwen_asr::model_files_ok(app.handle())
                && qwen_asr::runtime_ok(app.handle())
            {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    if let Err(e) = qwen_asr::ensure_server(&h) {
                        eprintln!("[speaknow] Qwen3-ASR 预启动失败: {e:#}");
                    }
                });
            }
            // 外接显示（硬件字幕屏）API：开机自启
            display_api::apply(&cfg.external_display);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let keep_in_tray = {
                        let state = window.app_handle().state::<Ctx>();
                        let guard = state.config.lock().unwrap();
                        guard
                            .as_ref()
                            .map(|c| c.general.close_to_tray)
                            .unwrap_or(true)
                    };
                    if keep_in_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
            // 主窗口真正销毁（退出应用）前：把内存中的配置落盘，防止配置文件意外丢失
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    let cfg = window
                        .app_handle()
                        .state::<Ctx>()
                        .config
                        .lock()
                        .unwrap()
                        .clone();
                    if let Some(cfg) = cfg {
                        if let Err(e) = config::save(window.app_handle(), &cfg) {
                            eprintln!("[speaknow] 退出时保存配置失败: {e:#}");
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            reset_config,
            open_config_dir,
            list_devices,
            mic_test,
            mic_volume_info,
            set_mic_volume,
            mic_diagnose,
            mic_test_all,
            mic_hw_levels,
            set_mic_hw_level,
            scan_devices,
            open_mic_settings,
            start_recording,
            stop_recording,
            test_asr,
            test_llm,
            builtin_models,
            download_builtin,
            delete_builtin,
            list_models,
            auto_calibrate,
            get_history,
            clear_history,
            delete_history,
            regenerate,
            copy_text,
            dismiss_overlay,
            overlay_pin,
            overlay_set_manual,
            retry_last,
            export_text,
            confirm_edit,
            cancel_review,
            optimize_text,
            show_main,
            quit_app,
            display_status,
            open_display_page,
            is_elevated,
            restart_elevated
        ])
        .build(tauri::generate_context!())
        .expect("SpeakNow 启动失败")
        .run(|_app, event| {
            // 应用退出时收掉 llama-server 子进程，避免孤儿进程占着 3GB 内存
            if let tauri::RunEvent::Exit = event {
                qwen_asr::shutdown();
            }
        });
}
