use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
#[derive(Default)]
pub struct Config {
    /// 统一 API 凭据组：一处维护 base_url + api_key，语音识别与 AI 优化共同引用。
    /// 同一厂商（如智谱：GLM-ASR + GLM 纠错）只需填写一次 Key
    pub providers: Vec<ProviderProfile>,
    pub hotkey: HotkeyConfig,
    pub audio: AudioConfig,
    pub asr: AsrConfig,
    pub llm: LlmConfig,
    pub output: OutputConfig,
    pub general: GeneralConfig,
    pub external_display: ExternalDisplayConfig,
}


/// 翻译目标语言候选（代码 → 展示名）。托盘快切与设置页共用。
pub const TRANSLATE_LANGS: &[(&str, &str)] = &[
    ("zh", "中文"),
    ("en", "English"),
    ("ja", "日本語"),
    ("ko", "한국어"),
    ("fr", "Français"),
    ("de", "Deutsch"),
    ("es", "Español"),
    ("ru", "Русский"),
];

/// 语言代码转展示名（未知代码原样返回）
pub fn lang_name(code: &str) -> String {
    TRANSLATE_LANGS
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, n)| n.to_string())
        .unwrap_or_else(|| code.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderProfile {
    /// 稳定标识，asr.providerId / llm.providerId 引用它
    pub id: String,
    /// 显示名（如「智谱」「DeepSeek」）
    pub name: String,
    pub base_url: String,
    pub api_key: String,
}

impl Default for ProviderProfile {
    fn default() -> Self {
        Self {
            id: "p1".into(),
            name: "智谱".into(),
            base_url: "https://open.bigmodel.cn/api/paas/v4".into(),
            api_key: String::new(),
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
    /// 翻译模式快捷键（可选）：本次听写强制用「翻译」模式，输出目标语言译文
    pub key_translate: String,
    /// hold（按住说话）/ toggle（按一下开始/结束）
    pub mode: String,
    pub enabled: bool,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            key: "ctrl+shift+Space".into(),
            key_quick: String::new(),
            key_translate: String::new(),
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
    /// 软件输入增益（dB，0~45）。用于系统输入电平过低的设备（如部分无线耳机）。
    /// 始终等于「当前所选设备」的增益；切换设备时由前端按映射换入对应值。
    pub gain_db: f32,
    /// 各输入设备独立记住的软件增益（键 = 设备名，"__default__" = 系统默认模式）
    pub gain_db_by_device: std::collections::BTreeMap<String, f32>,
    /// 录音期自动增益：输入过小且确有语音时逐步提升、接近削波时回落，
    /// 学到的值录音结束后写回该设备的记忆增益；旧配置缺省时默认开启
    #[serde(default = "default_true")]
    pub auto_gain: bool,
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
            gain_db_by_device: std::collections::BTreeMap::new(),
            auto_gain: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AsrConfig {
    /// http（云端/自建接口）| local（内置离线 Whisper）
    pub provider: String,
    /// 引用凭据组 id（Config.providers）；命中时以凭据组的 base_url/api_key 为准，
    /// 留空则使用下方内联字段（自定义/未迁移配置）
    pub provider_id: String,
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
            provider_id: String::new(),
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

impl AsrConfig {
    /// 展开凭据组引用：providerId 命中时以凭据组的 base_url/api_key 覆盖内联字段
    pub fn resolved(&self, providers: &[ProviderProfile]) -> AsrConfig {
        let mut c = self.clone();
        if let Some(p) = providers.iter().find(|p| p.id == c.provider_id) {
            c.base_url = p.base_url.clone();
            c.api_key = p.api_key.clone();
        }
        c
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LlmConfig {
    pub enabled: bool,
    /// 引用凭据组 id（Config.providers）；命中时以凭据组的 base_url/api_key 为准
    pub provider_id: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// correct / polish / prompt / translate
    pub mode: String,
    pub glossary: String,
    pub custom_prompt: String,
    pub timeout_sec: u64,
    /// 翻译目标语言代码（见 TRANSLATE_LANGS）
    pub translate_target: String,
    /// 第二目标语言：识别语言==目标语言时改译为此语言
    /// （如目标 en、第二目标 zh：说中文出英文、说英文出中文）
    pub translate_second_target: String,
    /// translation（仅译文）/ bilingual（原文 + 译文两行）
    pub translate_output: String,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            provider_id: String::new(),
            base_url: "https://open.bigmodel.cn/api/paas/v4".into(),
            api_key: String::new(),
            model: "glm-4.6".into(),
            mode: "correct".into(),
            glossary: String::new(),
            custom_prompt: String::new(),
            timeout_sec: 45,
            translate_target: "en".into(),
            translate_second_target: "zh".into(),
            translate_output: "translation".into(),
        }
    }
}

impl LlmConfig {
    /// 展开凭据组引用：providerId 命中时以凭据组的 base_url/api_key 覆盖内联字段
    pub fn resolved(&self, providers: &[ProviderProfile]) -> LlmConfig {
        let mut c = self.clone();
        if let Some(p) = providers.iter().find(|p| p.id == c.provider_id) {
            c.base_url = p.base_url.clone();
            c.api_key = p.api_key.clone();
        }
        c
    }
}

impl Config {
    /// ASR 配置展开凭据组后的快照（识别链路入口使用）
    pub fn resolved_asr(&self) -> AsrConfig {
        self.asr.resolved(&self.providers)
    }

    /// LLM 配置展开凭据组后的快照（优化/翻译链路入口使用）
    pub fn resolved_llm(&self) -> LlmConfig {
        self.llm.resolved(&self.providers)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OutputConfig {
    /// clipboard / typing
    pub method: String,
    /// auto（终端自动用 Shift+Insert）/ ctrl+v / ctrl+shift+v / shift+insert / terminal-typing
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
    migrate_providers(&mut cfg);
    scrub_dangling_provider_ids(&mut cfg);
    cfg
}

/// 清洗悬空的 providerId（引用已不存在的凭据组——手改配置/文件损坏的残留）：
/// 清掉后 resolve 回退内联字段，设置页下拉也显示「自定义」而不是空白。
fn scrub_dangling_provider_ids(cfg: &mut Config) {
    let hit = |id: &str| cfg.providers.iter().any(|p| p.id == id);
    if !cfg.asr.provider_id.is_empty() && !hit(&cfg.asr.provider_id) {
        cfg.asr.provider_id.clear();
    }
    if !cfg.llm.provider_id.is_empty() && !hit(&cfg.llm.provider_id) {
        cfg.llm.provider_id.clear();
    }
}

/// v1 → v2 凭据组迁移：旧版 asr/llm 各自内联一份 base_url + api_key，
/// 同一厂商要填两遍。迁移把已有凭据收拢为凭据组并建立引用，此后 Key 只存一处。
/// 规则：
/// - providers 已非空（v2 配置）→ 不动
/// - ASR 有 Key → 生成凭据组 asr，asr.providerId 指向它；LLM 地址与 Key 与
///   ASR 完全一致（智谱「一个 Key 两用」的常见形态）→ 共用同一条
/// - 仅 LLM 有 Key → 生成凭据组 llm
/// - 引用建立后清空内联 Key 与地址（以凭据组为准）；providerId 未命中时
///   resolve 回退内联字段，不致破坏手动编辑的配置
fn migrate_providers(cfg: &mut Config) {
    if !cfg.providers.is_empty() {
        return;
    }
    let asr_key = cfg.asr.api_key.trim().to_string();
    let llm_key = cfg.llm.api_key.trim().to_string();
    if asr_key.is_empty() && llm_key.is_empty() {
        return; // 没有可迁移的凭据
    }
    let asr_url = cfg.asr.base_url.trim().to_string();
    let llm_url = cfg.llm.base_url.trim().to_string();
    let same = !asr_key.is_empty()
        && !llm_key.is_empty()
        && asr_url == llm_url
        && asr_key == llm_key;
    if !asr_key.is_empty() {
        let name = if same { "API 服务".to_string() } else { "ASR 服务".to_string() };
        cfg.providers.push(ProviderProfile {
            id: "asr".into(),
            name,
            base_url: asr_url.clone(),
            api_key: asr_key,
        });
        cfg.asr.provider_id = "asr".into();
    }
    if !llm_key.is_empty() {
        if same {
            cfg.llm.provider_id = "asr".into();
        } else {
            cfg.providers.push(ProviderProfile {
                id: "llm".into(),
                name: "AI 优化服务".into(),
                base_url: llm_url,
                api_key: llm_key,
            });
            cfg.llm.provider_id = "llm".into();
        }
    }
    if !cfg.asr.provider_id.is_empty() {
        cfg.asr.api_key.clear();
        cfg.asr.base_url.clear();
    }
    if !cfg.llm.provider_id.is_empty() {
        cfg.llm.api_key.clear();
        cfg.llm.base_url.clear();
    }
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
/// tmp 名带 pid + 序号：设置页异步保存 / 托盘 / 退出落盘三条路径并发写
/// 同一文件时互不覆盖对方的半成品。
pub fn atomic_write(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!(
        "tmp-{}-{seq}",
        std::process::id()
    ));
    fs::write(&tmp, data)?;
    if path.exists() {
        let _ = fs::copy(path, path.with_extension("bak"));
    }
    let r = fs::rename(&tmp, path);
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    r
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

    /* ---- v1→v2 凭据组迁移与 resolve ---- */

    #[test]
    fn migrate_collapses_shared_creds_into_one_profile() {
        // 智谱「一个 Key 两用」的常见形态：ASR 与 LLM 同址同 Key → 共用一条凭据组
        let mut cfg = Config::default();
        cfg.asr.api_key = "sk-1".into();
        cfg.llm.api_key = "sk-1".into();
        migrate_providers(&mut cfg);
        assert_eq!(cfg.providers.len(), 1);
        assert_eq!(cfg.asr.provider_id, "asr");
        assert_eq!(cfg.llm.provider_id, "asr");
        assert!(cfg.asr.api_key.is_empty() && cfg.llm.api_key.is_empty());
        assert_eq!(cfg.resolved_asr().api_key, "sk-1");
        assert_eq!(cfg.resolved_llm().api_key, "sk-1");
        assert_eq!(
            cfg.resolved_llm().base_url,
            "https://open.bigmodel.cn/api/paas/v4"
        );
    }

    #[test]
    fn migrate_separates_different_vendors() {
        let mut cfg = Config::default();
        cfg.asr.api_key = "sk-a".into();
        cfg.llm.base_url = "https://api.deepseek.com".into();
        cfg.llm.api_key = "sk-b".into();
        migrate_providers(&mut cfg);
        assert_eq!(cfg.providers.len(), 2);
        assert_eq!(cfg.llm.provider_id, "llm");
        assert_eq!(cfg.resolved_llm().base_url, "https://api.deepseek.com");
        assert_eq!(cfg.resolved_llm().api_key, "sk-b");
    }

    #[test]
    fn migrate_noop_without_keys_and_idempotent_on_v2() {
        let mut fresh = Config::default();
        migrate_providers(&mut fresh);
        assert!(fresh.providers.is_empty(), "无凭据不迁移");

        let mut v2 = Config::default();
        v2.providers.push(ProviderProfile::default());
        let before = v2.providers.clone();
        migrate_providers(&mut v2);
        assert_eq!(v2.providers, before, "v2 配置不再迁移");
    }

    #[test]
    fn resolved_falls_back_to_inline_when_provider_id_misses() {
        let mut cfg = Config::default();
        cfg.llm.provider_id = "ghost".into();
        cfg.llm.base_url = "https://x.example".into();
        cfg.llm.api_key = "sk-x".into();
        let llm = cfg.resolved_llm();
        assert_eq!(llm.base_url, "https://x.example");
        assert_eq!(llm.api_key, "sk-x");
    }

    #[test]
    fn scrub_clears_dangling_provider_ids_only() {
        let mut cfg = Config::default();
        cfg.providers.push(ProviderProfile {
            id: "p1".into(),
            name: "组1".into(),
            base_url: "https://a.example".into(),
            api_key: "k1".into(),
        });
        cfg.asr.provider_id = "p1".into();
        cfg.llm.provider_id = "ghost".into();
        scrub_dangling_provider_ids(&mut cfg);
        assert_eq!(cfg.asr.provider_id, "p1", "命中的引用保留");
        assert!(cfg.llm.provider_id.is_empty(), "悬空引用被清洗");
        // 空引用与空组列表：无事发生
        let mut empty = Config::default();
        empty.llm.provider_id = "x".into();
        scrub_dangling_provider_ids(&mut empty);
        assert!(empty.llm.provider_id.is_empty());
    }

    #[test]
    fn lang_name_maps_known_codes() {
        assert_eq!(lang_name("en"), "English");
        assert_eq!(lang_name("zh"), "中文");
        assert_eq!(lang_name("xx"), "xx");
    }
}
