use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub hotkey: HotkeyConfig,
    pub audio: AudioConfig,
    pub asr: AsrConfig,
    pub llm: LlmConfig,
    pub output: OutputConfig,
    pub general: GeneralConfig,
    pub external_display: ExternalDisplayConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            hotkey: HotkeyConfig::default(),
            audio: AudioConfig::default(),
            asr: AsrConfig::default(),
            llm: LlmConfig::default(),
            output: OutputConfig::default(),
            general: GeneralConfig::default(),
            external_display: ExternalDisplayConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct HotkeyConfig {
    /// 形如 "ctrl+shift+Space"，主键名与 keyboard-types Code 一致
    pub key: String,
    /// 快速模式快捷键（可选）：跳过 AI 优化，直接输出 ASR 原文
    pub key_quick: String,
    /// hold（按住说话）/ toggle（按一下开始/结束）
    pub mode: String,
    pub enabled: bool,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            key: "ctrl+shift+Space".into(),
            key_quick: String::new(),
            mode: "toggle".into(),
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioConfig {
    /// None = 系统默认输入设备
    pub device: Option<String>,
    pub vad_enabled: bool,
    pub vad_silence_ms: u64,
    pub vad_threshold: f32,
    pub max_duration_sec: u64,
    /// 软件输入增益（dB，0~30）。用于系统输入电平过低的设备（如部分无线耳机）
    pub gain_db: f32,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            device: None,
            vad_enabled: false,
            vad_silence_ms: 1800,
            vad_threshold: 0.012,
            max_duration_sec: 120,
            gain_db: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AsrConfig {
    /// http（云端/自建接口）| local（内置离线 Whisper）
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub language: String,
    pub endpoint_path: String,
    /// 热词（行业术语），换行/逗号分隔
    pub hotwords: String,
    pub timeout_sec: u64,
    /// 内置本地模型 id（tiny-q80 / base / small）
    pub local_model: String,
    /// 模型下载镜像
    pub mirror: String,
    /// 边说边出字：录音期间按停顿自动分段识别
    pub streaming: bool,
    /// 清理语气词（"嗯/呃/yeah" 等口头音与呼吸声幻觉）；旧配置缺省时默认开启
    #[serde(default = "default_true")]
    pub strip_fillers: bool,
}

fn default_true() -> bool {
    true
}

impl Default for AsrConfig {
    fn default() -> Self {
        Self {
            provider: "http".into(),
            base_url: "https://open.bigmodel.cn/api/paas/v4".into(),
            api_key: String::new(),
            model: "glm-asr-2512".into(),
            language: "auto".into(),
            endpoint_path: "/audio/transcriptions".into(),
            hotwords: String::new(),
            timeout_sec: 60,
            local_model: "base".into(),
            mirror: "https://hf-mirror.com".into(),
            streaming: false,
            strip_fillers: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LlmConfig {
    pub enabled: bool,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// correct / polish / prompt
    pub mode: String,
    pub glossary: String,
    pub custom_prompt: String,
    pub timeout_sec: u64,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            base_url: "https://open.bigmodel.cn/api/paas/v4".into(),
            api_key: String::new(),
            model: "glm-4.6".into(),
            mode: "correct".into(),
            glossary: String::new(),
            custom_prompt: String::new(),
            timeout_sec: 45,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OutputConfig {
    /// clipboard / typing
    pub method: String,
    /// auto（终端自动用 Shift+Insert）/ ctrl+v / shift+insert
    pub paste_key: String,
    pub auto_paste: bool,
    pub auto_submit: bool,
    pub restore_clipboard: bool,
    /// 输入前在悬浮窗中确认（可编辑后再输入）
    pub review: bool,
}

impl Default for OutputConfig {
    fn default() -> Self {
        Self {
            method: "clipboard".into(),
            paste_key: "auto".into(),
            auto_paste: true,
            auto_submit: false,
            restore_clipboard: false,
            review: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GeneralConfig {
    pub show_overlay: bool,
    pub close_to_tray: bool,
    /// 开始/结束录音时的声音反馈
    pub sound_feedback: bool,
    /// 开机自启动
    pub autostart: bool,
    /// dark / light
    pub theme: String,
    /// 界面缩放 0.85 ~ 1.30
    pub font_scale: f32,
}

impl Default for GeneralConfig {
    fn default() -> Self {
        Self {
            show_overlay: true,
            close_to_tray: true,
            sound_feedback: true,
            autostart: false,
            theme: "dark".into(),
            font_scale: 1.0,
        }
    }
}

/// 外接显示（硬件字幕屏）API。开启后本机启动 HTTP + WebSocket 服务，
/// 聆听窗口的全部字幕事件同步推送给外接硬件；可选择同时隐藏本地悬浮窗。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ExternalDisplayConfig {
    /// 启用外接显示 API 服务
    pub enabled: bool,
    /// 服务端口
    pub port: u16,
    /// 允许局域网设备连接（false=仅本机 127.0.0.1；true=监听 0.0.0.0）
    pub allow_lan: bool,
    /// 外接显示时不再弹出本地聆听悬浮窗
    pub hide_local_overlay: bool,
}

impl Default for ExternalDisplayConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 8866,
            allow_lan: false,
            hide_local_overlay: false,
        }
    }
}

fn config_path(app: &AppHandle) -> anyhow::Result<PathBuf> {
    Ok(app.path().app_config_dir()?.join("config.json"))
}

pub fn load(app: &AppHandle) -> Config {
    let Ok(path) = config_path(app) else {
        return Config::default();
    };
    let parse = |p: &std::path::Path| -> Option<Config> {
        let s = fs::read_to_string(p).ok()?;
        match serde_json::from_str::<Config>(&s) {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("[speaknow] 配置解析失败（{}）: {e}", p.display());
                None
            }
        }
    };
    // 主文件 → 备份 → 默认；损坏的主文件保留为 .corrupt 供手动找回 Key，绝不静默覆盖
    // 注意 with_extension 替换最后一段：config.json → config.bak / config.corrupt
    let mut cfg = parse(&path).or_else(|| {
        let _ = fs::rename(&path, path.with_extension("corrupt"));
        parse(&path.with_extension("bak"))
    });
    if cfg.is_none() {
        cfg = Some(Config::default());
    }
    let mut cfg = cfg.unwrap_or_default();
    // 迁移：旧默认 ctrl+v 升级为 auto（终端窗口自动改用 Shift+Insert，其余场景行为不变）
    if cfg.output.paste_key == "ctrl+v" {
        cfg.output.paste_key = "auto".into();
    }
    cfg
}

pub fn save(app: &AppHandle, cfg: &Config) -> anyhow::Result<()> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    atomic_write(&path, serde_json::to_string_pretty(cfg)?.as_bytes())?;
    Ok(())
}

/// 原子写文件：先写 .tmp 再 rename 替换（NTFS 同卷 rename 原子），
/// 进程被强杀也只会留下完整旧文件或完整新文件，不会出现半截 JSON。
/// 写入前把上一份完好内容备份到 .bak，供主文件损坏时恢复。
pub fn atomic_write(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data)?;
    if path.exists() {
        let _ = fs::copy(path, path.with_extension("bak"));
    }
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_creates_bak_and_never_tears() {
        let dir = std::env::temp_dir().join("sn_cfg_atomic_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("config.json");

        atomic_write(&p, b"{\"a\":1}").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"{\"a\":1}");
        assert!(!p.with_extension("bak").exists(), "首写不应有 bak");

        atomic_write(&p, b"{\"a\":2}").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"{\"a\":2}");
        assert_eq!(
            std::fs::read(p.with_extension("bak")).unwrap(),
            b"{\"a\":1}",
            "bak 应为上一份完好内容"
        );

        // 重复覆盖写（rename 替换已存在文件，Windows 上必须走通）
        for i in 0..5 {
            atomic_write(&p, format!("{{\"n\":{i}}}").as_bytes()).unwrap();
        }
        assert_eq!(std::fs::read(&p).unwrap(), b"{\"n\":4}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
