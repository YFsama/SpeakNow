mod asr;
mod audio;
mod ccc;
mod config;
mod display_api;
mod events;
mod history;
mod hotkey;
mod http;
mod inject;
mod llm;
pub mod local_whisper;
mod local_llm;
mod ocr;
mod overlay;
mod pipeline;
mod qwen_asr;
mod selection;
mod trans_struct;
mod translate;
mod tray;
mod text_clean;
mod wav;

#[cfg(target_os = "windows")]
pub mod win_volume;
pub mod caret;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
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
    /// 当前录音会话（音频句柄 + 会话状态）：None = 空闲。会话标志与流式
    /// 分段状态都封装在 pipeline::Session 里，随会话生灭
    pub recording: Mutex<Option<(audio::Recording, std::sync::Arc<pipeline::Session>)>>,
    /// 预览卡悬停暂停自动隐藏
    pub overlay_pinned: AtomicBool,
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
            .lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|c| c.hotkey.mode.clone())
            .unwrap_or_else(|| "toggle".into())
    }
}

#[tauri::command]
fn get_config(app: AppHandle) -> config::Config {
    app.state::<Ctx>()
        .config
        .lock().unwrap_or_else(std::sync::PoisonError::into_inner)
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
        .lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .unwrap_or_default();
    if let Err(e) = config::save(&app, &config) {
        trace_save(&app, &format!("写文件失败 {e:#}"));
        return Err(e.to_string());
    }
    trace_save(&app, &format!("写文件 {}ms", t0.elapsed().as_millis()));
    *app.state::<Ctx>().config.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(config.clone());
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
    // 从本地引擎切到云端/其他方式时，停掉常驻 llama-server（约 10GB 提交内存）；
    // 之后再用回本地会按需自动拉起，不影响「秒级响应」的常驻体验
    if old.asr.provider == "local" && config.asr.provider != "local" {
        let h = app.clone();
        tauri::async_runtime::spawn_blocking(move || qwen_asr::shutdown(&h));
    }
    // Ctrl+C+C 双击复制即翻译：钩子首次开启后常驻，这里只同步开关
    ccc::apply(&app, &config);
    // 托盘快切菜单展示当前模式/翻译目标：设置页改动后同步重建。
    // 经独立线程派发到主线程——不等待主线程空闲，避免保存被卡
    if config.llm.mode != old.llm.mode || config.llm.translate_target != old.llm.translate_target {
        let h = app.clone();
        std::thread::spawn(move || {
            let h2 = h.clone();
            let _ = h.run_on_main_thread(move || crate::tray::rebuild_menu(&h2));
        });
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
    *app.state::<Ctx>().config.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(cfg.clone());
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
    // Linux 等平台缺此分支会导致编译失败（cmd 未定义），统一走 xdg-open
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
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

    // 系统端点音量（仅 Windows）。非 Windows 分支的 None 需显式标注类型：
    // 提供具体类型的 Windows 分支被编译掉后，推断无从进行
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
            (None::<f32>, false, None::<String>)
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
    let Some((samples, from_ui)) = state.last_audio.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() else {
        return Err("没有可重试的录音".into());
    };
    let mut cfg = state.config.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone().unwrap_or_default();
    // 凭据组在此展开（与其余路径一致）：迁移后内联字段已清空，
    // 不解析会导致重试静默降级到本地模型 / 跳过 AI 优化
    cfg.asr = cfg.resolved_asr();
    cfg.llm = cfg.resolved_llm();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // 重试无活跃会话：不做流式等待，直接整段识别；无停录静音信息，
        // 粘贴前的说话探测保守执行
        pipeline::process_audio(handle, cfg, samples, from_ui, false, None, None).await;
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
    let suggested = (db.clamp(0.0, 40.0) * 2.0).round() / 2.0;
    Ok(serde_json::json!({
        "peakPercent": r.peak_level,
        "suggestedDb": suggested,
    }))
}

/// 从设置页面手动触发录音（from_ui=true：结束时只复制结果，不自动输入；
/// 标志随会话保存，VAD/超时等自动收尾同样保持测试语义）
#[tauri::command]
async fn start_recording(app: AppHandle, from_ui: bool) -> Result<String, String> {
    // 设备初始化可能阻塞（无线麦重连等），移出主线程
    tauri::async_runtime::spawn_blocking(move || {
        pipeline::start(&app, false, false, from_ui)?;
        Ok::<String, String>("ok".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn stop_recording(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pipeline::stop(&app)?;
        Ok::<String, String>("ok".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 用一小段静音音频验证 ASR 接口连通性与鉴权（本地模式则校验模型文件）。
/// providers：凭据组列表——ASR 配置里的 providerId 引用它，命中时以凭据组为准
#[tauri::command]
async fn test_asr(
    app: AppHandle,
    config: config::AsrConfig,
    providers: Vec<config::ProviderProfile>,
) -> Result<String, String> {
    let config = config.resolved(&providers);
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

/// 内置本地模型列表与下载状态（Whisper 系列 + Qwen3-ASR + 本地翻译模型 + PP-OCR 质量档）
#[tauri::command]
fn builtin_models(app: AppHandle) -> Vec<local_whisper::LocalModelStatus> {
    let mut v = local_whisper::status(&app);
    v.push(qwen_asr::status(&app));
    v.extend(local_llm::status(&app));
    #[cfg(target_os = "windows")]
    v.push(ocr::ppocr_status(&app));
    v
}

/// 下载内置本地模型（进度经 sn-model-progress 事件推送）
#[tauri::command]
async fn download_builtin(app: AppHandle, id: String, mirror: String) -> Result<(), String> {
    if id == qwen_asr::MODEL_ID {
        qwen_asr::download(&app).await.map_err(|e| format!("{e:#}"))
    } else if local_llm::find(&id).is_some() {
        local_llm::download(&app, &id)
            .await
            .map_err(|e| format!("{e:#}"))
    } else {
        #[cfg(target_os = "windows")]
        if id == ocr::PPOCR_ID {
            return ocr::ppocr_download(&app).await.map_err(|e| format!("{e:#}"));
        }
        let _ = &mirror;
        local_whisper::download(&app, &id, &mirror)
            .await
            .map_err(|e| format!("{e:#}"))
    }
}

/// 删除已下载的本地模型（释放磁盘空间）
#[tauri::command]
fn delete_builtin(app: AppHandle, id: String) -> Result<(), String> {
    let known = local_whisper::LOCAL_MODELS.iter().any(|d| d.id == id)
        || id == qwen_asr::MODEL_ID
        || local_llm::find(&id).is_some();
    #[cfg(target_os = "windows")]
    let known = known || id == ocr::PPOCR_ID;
    if !known {
        return Err("未知模型".into());
    }
    if id == qwen_asr::MODEL_ID {
        // 服务进程占着 gguf 文件，必须先停
        qwen_asr::shutdown(&app);
    }
    if local_llm::find(&id).is_some() {
        local_llm::shutdown(&app);
    }
    #[cfg(target_os = "windows")]
    if id == ocr::PPOCR_ID {
        ocr::ppocr_unload();
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

/// 侧通 AI 优化接口（providers：凭据组，providerId 命中时以凭据组为准）
#[tauri::command]
async fn test_llm(
    config: config::LlmConfig,
    providers: Vec<config::ProviderProfile>,
) -> Result<String, String> {
    let config = config.resolved(&providers);
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

/// 全量使用统计（stats.json 持久累计，不受历史保留窗口影响）：
/// days 为按日期升序的 [YYYY-MM-DD, 条数]，只含最近 60 天。
/// 首次调用时若 stats.json 不存在，会从现有历史一次性播种（数字不回退）。
#[tauri::command]
fn get_stats(app: AppHandle) -> history::StatsView {
    history::stats(&app).into()
}

/// 批量删除历史（多选）：返回实际删除条数；统计为累计口径，不随删除回退
#[tauri::command]
fn delete_history_batch(app: AppHandle, ts: Vec<i64>) -> usize {
    history::delete_batch(&app, &ts)
}

/// 用当前 AI 设置重新优化某条历史记录的原始转写。
/// mode 可选：本次覆盖使用的模式（correct / polish / prompt / translate），
/// 只影响这一次调用、不落盘改全局配置。
#[tauri::command]
async fn regenerate(
    app: AppHandle,
    ts: i64,
    mode: Option<String>,
) -> Result<history::HistoryItem, String> {
    let cfg = app
        .state::<Ctx>()
        .config
        .lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .unwrap_or_default();
    // 展开凭据组引用后再判断可用性（内联字段可能为空、凭据在 providers 里）
    let mut llm_cfg = cfg.resolved_llm();
    if !llm_cfg.enabled || llm_cfg.base_url.trim().is_empty() {
        return Err("AI 优化未启用，请先在「AI 优化」中开启并保存".into());
    }
    if let Some(m) = mode.as_deref() {
        match m {
            "correct" | "polish" | "prompt" | "translate" => llm_cfg.mode = m.to_string(),
            _ => return Err(format!("不支持的重优化模式：{m}")),
        }
    }
    let raw = history::find_raw(&app, ts).ok_or("未找到该条记录")?;
    let text = llm::optimize(&llm_cfg, &raw)
        .await
        .map_err(|e| format!("重新优化失败: {e:#}"))?;
    // 翻译双语输出与直接输入路径保持一致：原文一行 + 译文一行
    let text = if llm_cfg.mode == "translate" && llm_cfg.translate_output == "bilingual" {
        format!("{raw}\n{text}")
    } else {
        text
    };
    history::update_final(&app, ts, &text).ok_or("更新记录失败")?;
    history::load(&app)
        .into_iter()
        .find(|i| i.ts == ts)
        .ok_or_else(|| "记录已不存在".into())
}

/// 手动编辑某条历史的终稿（前端行内编辑保存）。
/// update_final 内部的 write() 会广播 sn-history-changed，前端列表自动刷新。
#[tauri::command]
fn update_history_final(app: AppHandle, ts: i64, final_text: String) -> Result<(), String> {
    history::update_final(&app, ts, &final_text).ok_or_else(|| "未找到该条记录".into())
}

/// 收藏 / 取消收藏一条历史（置顶显示，不占保留条数名额）。
#[tauri::command]
fn history_set_pin(app: AppHandle, ts: i64, pinned: bool) -> Result<(), String> {
    history::set_pinned(&app, ts, pinned).ok_or_else(|| "未找到该条记录".into())
}

/// 截取指定物理像素区域返回 PNG base64（截图框选放大镜数据源）。
/// 前端传选区窗自身的外框物理坐标（getCurrentWindow().outerPosition/Size），
/// 位图与窗口 CSS 坐标按 devicePixelRatio 换算对齐。
/// 整屏 GDI 截取 + PNG 编码是百毫秒级重活：spawn_blocking 避免占住主线程
/// （同 list_devices 等既有重路径的约定）。
#[tauri::command]
async fn ocr_screen_source(x: i32, y: i32, w: i32, h: i32) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (b64, width, height) =
            ocr::screen_source(x, y, w, h).map_err(|e| format!("截屏失败：{e:#}"))?;
        Ok(serde_json::json!({ "png": b64, "width": width, "height": height }))
    })
    .await
    .map_err(|e| format!("截屏任务失败：{e}"))?
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    inject::copy_only(&text).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn dismiss_overlay(app: AppHandle) {
    *app.state::<Ctx>().pending_review.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    // Esc 关闭卡片 = 用户放弃本次翻译：作废翻译会话（代数 +1），仍在流式
    // 读取的翻译立即中止、迟到完成的 auto_copy 也会跳过——否则用户关闭
    // 卡片后几秒才完成的翻译会用旧译文覆盖这段时间里新复制的内容。
    // 听写的 run_gen 是另一套代数，不受影响
    translate::abort_active_session();
    overlay::hide(&app);
    pipeline::emit_status(&app, "idle", "", false);
}

/// 预览编辑：确认输入编辑后的文本
#[tauri::command]
async fn confirm_edit(app: AppHandle, text: String) -> Result<(), String> {
    let pending = app
        .state::<Ctx>()
        .pending_review
        .lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
        .ok_or("没有待确认的输入")?;
    let cfg = app
        .state::<Ctx>()
        .config
        .lock().unwrap_or_else(std::sync::PoisonError::into_inner)
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

    history::push(&app, &pending.raw, &text, pending.asr_ms, pending.llm_ms, "dictation");
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
    *app.state::<Ctx>().pending_review.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    overlay::hide(&app);
    pipeline::emit_status(&app, "idle", "", false);
}

/// 预览编辑：对编辑框内容重新调用 AI 优化（流式，结果逐字回到编辑框）。
/// mode 可选覆盖本次优化模式（correct / polish / prompt / translate），缺省用已保存配置。
#[tauri::command]
async fn optimize_text(
    app: AppHandle,
    text: String,
    mode: Option<String>,
) -> Result<String, String> {
    let cfg = app
        .state::<Ctx>()
        .config
        .lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .unwrap_or_default();
    let mut llm_cfg = cfg.resolved_llm();
    if !llm_cfg.enabled || llm_cfg.base_url.trim().is_empty() {
        return Err("AI 优化未启用，请先在「AI 优化」页开启并保存".into());
    }
    if let Some(m) = mode.as_deref() {
        if matches!(m, "correct" | "polish" | "prompt" | "translate") {
            llm_cfg.mode = m.to_string();
        }
    }
    let out = llm::optimize_streaming(&llm_cfg, &text, &app, None, None)
        .await
        .map_err(|e| format!("{e:#}"))?;
    // 翻译双语输出与直接输入路径保持一致：原文一行 + 译文一行
    let out = if llm_cfg.mode == "translate" && llm_cfg.translate_output == "bilingual" {
        format!("{text}\n{out}")
    } else {
        out
    };
    Ok(out)
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

/* ---------- 外接显示（硬件字幕屏）API ---------- */

/// 外接显示服务当前状态（运行中/端口/可访问 URL/最近错误）
#[tauri::command]
fn display_status() -> serde_json::Value {
    display_api::status()
}

/// 判定 URL 是否指向本机或 RFC1918 私网（仅 http）——解析后按 IP/主机
/// 精确判定，字符串前缀匹配会被 `http://10.evil.com` 这类数字开头的
/// DNS 域名绕过
fn is_private_host(u: &str) -> bool {
    let parsed = match reqwest::Url::parse(u) {
        Ok(u) => u,
        Err(_) => return false,
    };
    if parsed.scheme() != "http" {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    // IPv6 字面量带方括号（[::1]），解析前剥掉
    let host = host.trim_start_matches('[').trim_end_matches(']');
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => v4.is_loopback() || v4.is_private(),
        Ok(std::net::IpAddr::V6(v6)) => v6.is_loopback(),
        Err(_) => host.eq_ignore_ascii_case("localhost"),
    }
}

/// 在系统默认浏览器打开指定 URL（仅用于展示本服务自己的地址）
#[tauri::command]
fn open_display_page(url: String) -> Result<(), String> {
    if !is_private_host(&url) {
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
    // Linux 等平台缺此分支会导致编译失败（cmd 未定义），统一走 xdg-open
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map_err(|e| format!("打开失败: {e}"))?;
    Ok(())
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
            overlay_pinned: AtomicBool::new(false),
            pending_review: Mutex::new(None),
            last_audio: Mutex::new(None),
            overlay_manual: AtomicBool::new(false),
            run_gen: AtomicU64::new(0),
        })
        .setup(|app| {
            let cfg = config::load(app.handle());
            *app.state::<Ctx>().config.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(cfg.clone());
            // 先清掉上次崩溃/强杀遗留的 llama-server（曾以 ~10GB 提交内存常驻多日，
            // 加重系统内存压力导致白屏/卡死），本次会话按需重新拉起并纳入 Job Object
            {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    qwen_asr::cleanup_orphan_engines(&h);
                });
            }
            tray::setup(app.handle())?;
            if let Err(e) = hotkey::apply(app.handle(), &cfg.hotkey) {
                eprintln!("[speaknow] {e:#}");
            }
            // 剪贴板监听（复制即翻译）：常驻轮询线程，开关由配置每 tick 判定
            translate::ensure_clipboard_watcher(app.handle());
            // Ctrl+C+C 双击复制即翻译：低级键盘钩子（开关由原子量实时判定）
            ccc::apply(app.handle(), &cfg);
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
            // 选中本地翻译引擎时同样预启动，首次划词即秒级响应
            if cfg.translate.engine == "local"
                && local_llm::model_files_ok(app.handle(), &cfg.translate.local_model)
                && qwen_asr::runtime_ok(app.handle())
            {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    if let Err(e) = local_llm::ensure_server(&h) {
                        eprintln!("[speaknow] 本地翻译引擎预启动失败: {e:#}");
                    }
                });
            }
            // 外接显示（硬件字幕屏）API：开机自启。绑定/就绪等待最坏可到
            // 秒级（端口被占重试 + 就绪超时），放后台线程，不拖慢启动
            {
                let ext = cfg.external_display.clone();
                std::thread::spawn(move || display_api::apply(&ext));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let keep_in_tray = {
                        let state = window.app_handle().state::<Ctx>();
                        let guard = state.config.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                        guard
                            .as_ref()
                            .map(|c| c.general.close_to_tray)
                            .unwrap_or(true)
                    };
                    if keep_in_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                } else if window.label().starts_with("ocr-sel-") {
                    // 选区窗被 Alt+F4 等关闭：转为取消本轮截图取词（窗实例保留复用）
                    api.prevent_close();
                    crate::ocr::ocr_cancel(window.app_handle().clone());
                }
            }
            // 主窗口真正销毁（退出应用）前：把内存中的配置落盘，防止配置文件意外丢失
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    let cfg = window
                        .app_handle()
                        .state::<Ctx>()
                        .config
                        .lock().unwrap_or_else(std::sync::PoisonError::into_inner)
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
            delete_history_batch,
            get_stats,
            regenerate,
            update_history_final,
            history_set_pin,
            ocr_screen_source,
            copy_text,
            dismiss_overlay,
            overlay_pin,
            overlay_set_manual,
            retry_last,
            export_text,
            confirm_edit,
            cancel_review,
            optimize_text,
            translate::translate_selection_cmd,
            translate::translate_text,
            translate::translate_retarget,
            translate::translate_replace,
            translate::translate_announce,
            ocr::ocr_capture_cmd,
            ocr::ocr_region_selected,
            ocr::ocr_cancel,
            ocr::ocr_paste,
            ocr::ocr_langs,
            ocr::open_language_settings,
            display_status,
            open_display_page,
            is_elevated,
            restart_elevated
        ])
        .build(tauri::generate_context!())
        .expect("SpeakNow 启动失败")
        .run(|app, event| {
            // 应用退出时收掉 llama-server 子进程（识别 + 翻译两个引擎），避免孤儿进程
            // 占着数 GB 内存；强杀/崩溃路径由 Job Object（KILL_ON_JOB_CLOSE）兜底
            if let tauri::RunEvent::Exit = event {
                qwen_asr::shutdown(app);
                local_llm::shutdown(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::is_private_host;

    #[test]
    fn private_host_accepts_loopback_and_private_ranges() {
        assert!(is_private_host("http://127.0.0.1:8866/display"));
        assert!(is_private_host("http://localhost:8866/display"));
        assert!(is_private_host("http://[::1]:8866/display"));
        assert!(is_private_host("http://192.168.1.5:8866/display"));
        assert!(is_private_host("http://10.0.0.8:8866/display"));
        assert!(is_private_host("http://172.16.0.2:8866/display"));
    }

    #[test]
    fn private_host_rejects_lookalikes_and_public_hosts() {
        // 数字开头的前缀仿冒域名——旧字符串前缀匹配会全部放行
        assert!(!is_private_host("http://10.evil.com/display"));
        assert!(!is_private_host("http://192.168.evil.com/x"));
        assert!(!is_private_host("http://172.evil.com/x"));
        // 公网与协议限制
        assert!(!is_private_host("http://example.com/display"));
        assert!(!is_private_host("http://8.8.8.8/x"));
        assert!(!is_private_host("https://127.0.0.1:8866/x"));
        assert!(!is_private_host("172.32.0.1"));
    }
}
