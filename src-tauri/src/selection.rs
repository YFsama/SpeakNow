//! 跨应用取词：读取前台应用中用户选中的文字（划词翻译的第一步）。
//! 定位链（参照 pot/Easydict 的实践，代码自研）：
//! 1. Windows UI Automation TextPattern GetSelection + GetText——无副作用、
//!    不碰剪贴板，Chromium/Edge/UWP/Office 支持；
//! 2. 模拟 Ctrl+C（macOS Cmd+C）+ 剪贴板读取——覆盖面最广的兜底，
//!    带剪贴板序号/内容变化校验与「用完还原」，终端与提权窗口拒绝执行。
//!
//! 取词后做软换行合并（PDF 复制出的硬换行不断句，直接喂模型会切碎语义）。

use std::thread;
use std::time::Duration;

use crate::config::TranslateConfig;

/// 取到的选中文本
pub struct Selection {
    pub text: String,
    /// uia（无障碍接口）| copy（模拟复制兜底）
    pub via: &'static str,
}

pub enum CaptureError {
    /// 前台没有可读取的选中文本
    Empty,
    /// 前台是终端：模拟 Ctrl+C 是中断信号，宁可不取词也不打断正在跑的命令
    Terminal,
    /// 目标窗口以管理员运行，UIPI 拦截模拟按键（携带进程名）
    #[allow(dead_code)]
    Elevated(String),
    /// 其他失败（剪贴板占用、模拟按键失败等）
    Failed(String),
}

impl CaptureError {
    /// 面向用户的错误说明
    pub fn message(&self) -> String {
        match self {
            CaptureError::Empty => "未检测到选中文本：先在任意应用里选中文字再按划词翻译热键".into(),
            CaptureError::Terminal => "终端窗口中禁用模拟复制取词（Ctrl+C 是中断信号）；可先手动复制，再到「翻译」页粘贴翻译".into(),
            CaptureError::Elevated(exe) => format!(
                "目标应用 {exe} 以管理员身份运行，系统阻止了按键注入；点击下方按钮以管理员身份重启后可取词"
            ),
            CaptureError::Failed(e) => e.clone(),
        }
    }
}

/// 读取前台选中文本。阻塞操作（模拟复制路径含按键等待与剪贴板轮询），
/// 必须在后台线程调用。`forced_copy` = 跳过 UIA 直接模拟复制（兼容性开关）。
pub fn capture(tr: &TranslateConfig) -> Result<Selection, CaptureError> {
    if !tr.forced_copy {
        if let Some(t) = uia_selection_text() {
            if !t.trim().is_empty() {
                return Ok(Selection { text: tidy(&t), via: "uia" });
            }
        }
    }
    copy_selection().map(|t| Selection { text: tidy(&t), via: "copy" })
}

/// 前台窗口标题（黑名单匹配用；非 Windows 平台返回空）
#[cfg(target_os = "windows")]
pub fn foreground_title() -> String {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_invalid() {
            return String::new();
        }
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(fg, &mut buf);
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }
}

#[cfg(not(target_os = "windows"))]
pub fn foreground_title() -> String {
    String::new()
}

/* ---------- UI Automation 取词（无副作用，优先） ---------- */

#[cfg(target_os = "windows")]
fn uia_selection_text() -> Option<String> {
    use windows::core::Interface;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        IUIAutomation, IUIAutomationTextPattern, CUIAutomation, UIA_TextPatternId,
    };

    // COM 初始化守卫：模式冲突（线程已以其他模式初始化）时视为借用，不配对卸载
    struct ComGuard {
        owned: bool,
    }
    impl ComGuard {
        fn new() -> Self {
            let owned = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
            ComGuard { owned }
        }
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.owned {
                unsafe { CoUninitialize() };
            }
        }
    }

    let _com = ComGuard::new();
    unsafe {
        let uia = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_ALL).ok()?;
        let el = uia.GetFocusedElement().ok()?;
        let unk = el.GetCurrentPattern(UIA_TextPatternId).ok()?;
        let tp = unk.cast::<IUIAutomationTextPattern>().ok()?;
        let ranges = tp.GetSelection().ok()?;
        let n = ranges.Length().ok()?;
        // Word 等支持多段选区（Ctrl 逐段点选）：逐 range 取文本换行拼接
        let mut parts: Vec<String> = Vec::new();
        for i in 0..n {
            let Ok(range) = ranges.GetElement(i) else {
                continue;
            };
            let Ok(text) = range.GetText(-1) else {
                continue;
            };
            let t = text.to_string();
            if !t.trim().is_empty() {
                parts.push(t);
            }
        }
        if parts.is_empty() {
            None
        } else {
            Some(parts.join("\n"))
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn uia_selection_text() -> Option<String> {
    None
}

/* ---------- 输入框草稿读取（输入框翻译用，无副作用不碰剪贴板） ---------- */

/// TextPattern 回退通道的草稿长度上限：该通道无法证明聚焦的是输入控件
/// （网页正文/文档的 DocumentRange 同样命中），超长视为误读拒绝
#[cfg(target_os = "windows")]
const TEXT_FALLBACK_MAX_CHARS: usize = 2_000;

/// 读输入框草稿失败的原因（各变体仅在 Windows 的 UIA 通道构造，
/// mac 构建下「matched 但 never constructed」按同文件 CaptureError::Elevated
/// 的先例允许 dead_code）
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub enum InputCaptureError {
    /// 聚焦控件不是可编辑的输入框（读不到 ValuePattern/TextPattern）
    NotEditable,
    /// 密码框：内容不该被翻译或广播
    Password,
    /// 读到了但为空（输入框没有草稿）
    Empty,
    Failed(String),
}

impl InputCaptureError {
    /// 面向用户的中文说明（风格仿 CaptureError::message）
    pub fn message(&self) -> String {
        match self {
            InputCaptureError::NotEditable => "当前聚焦的不是一个可编辑的输入框：请先把光标点到聊天框/搜索框等输入框里再触发输入框翻译".into(),
            InputCaptureError::Password => "聚焦的是密码框：密码内容不会送去翻译".into(),
            InputCaptureError::Empty => "输入框里没有可翻译的草稿：先输入内容再触发输入框翻译".into(),
            InputCaptureError::Failed(e) => e.clone(),
        }
    }
}

/// 读取当前聚焦输入控件的完整草稿文本（输入框翻译第一步，无副作用不碰剪贴板）。
/// ValuePattern 优先（Win32 Edit / UWP / Chromium 输入框的整框取值通道），
/// 失败回退 TextPattern 的 DocumentRange 全文。密码框一律拒绝。
pub fn capture_input_text() -> Result<String, InputCaptureError> {
    #[cfg(target_os = "windows")]
    {
        capture_input_text_win()
    }
    // macOS/Linux 无 UI Automation 通道（模拟键全选兜底会动用户输入框，不可用）
    #[cfg(not(target_os = "windows"))]
    {
        Err(InputCaptureError::Failed("输入框翻译目前仅支持 Windows".into()))
    }
}

#[cfg(target_os = "windows")]
fn capture_input_text_win() -> Result<String, InputCaptureError> {
    use windows::core::Interface;
    use windows::Win32::Foundation::VARIANT_TRUE;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Variant::VT_BOOL;
    use windows::Win32::UI::Accessibility::{
        IUIAutomation, IUIAutomationTextPattern, IUIAutomationValuePattern, CUIAutomation,
        UIA_IsPasswordPropertyId, UIA_TextPatternId, UIA_ValuePatternId,
    };

    // COM 初始化守卫：模式冲突（线程已以其他模式初始化）时视为借用，不配对卸载
    struct ComGuard {
        owned: bool,
    }
    impl ComGuard {
        fn new() -> Self {
            let owned = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
            ComGuard { owned }
        }
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.owned {
                unsafe { CoUninitialize() };
            }
        }
    }

    let _com = ComGuard::new();
    unsafe {
        let uia = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_ALL)
            .map_err(|e| InputCaptureError::Failed(format!("初始化 UI Automation 失败: {e}")))?;
        let el = uia
            .GetFocusedElement()
            .map_err(|e| InputCaptureError::Failed(format!("获取聚焦控件失败: {e}")))?;
        // 密码框：草稿是敏感凭据，不读内容、不翻译、不上广播。windows crate 的
        // VARIANT 是裸结构体（无 to_bool 助手），手动判 VT_BOOL + VARIANT_TRUE
        if let Ok(v) = el.GetCurrentPropertyValue(UIA_IsPasswordPropertyId) {
            if v.Anonymous.Anonymous.vt == VT_BOOL
                && v.Anonymous.Anonymous.Anonymous.boolVal == VARIANT_TRUE
            {
                return Err(InputCaptureError::Password);
            }
        }
        // 主通道 ValuePattern：Win32 Edit / UWP / Chromium 输入框的整框取值
        if let Ok(unk) = el.GetCurrentPattern(UIA_ValuePatternId) {
            if let Ok(vp) = unk.cast::<IUIAutomationValuePattern>() {
                if let Ok(val) = vp.CurrentValue() {
                    let t = val.to_string();
                    // 只 trim 首尾，不做软换行合并——输入框草稿的换行是用户
                    // 刻意敲的（聊天软件 Shift+Enter 分段），合并会改写原意
                    let t = t.trim();
                    if t.is_empty() {
                        return Err(InputCaptureError::Empty);
                    }
                    return Ok(t.to_string());
                }
            }
        }
        // 回退 TextPattern DocumentRange 全文：部分自绘输入框只暴露文本协议。
        // 该通道拿不到「这是输入控件」的证明——网页正文/Word 文档的
        // DocumentRange 同样走这里（整页整篇），比 ValuePattern 不可靠得多，
        // 收紧长度上限：真实聊天草稿几乎不可能超此数，超了大概率焦点在
        // 文档/网页正文上，白翻一遍只烧 token
        if let Ok(unk) = el.GetCurrentPattern(UIA_TextPatternId) {
            if let Ok(tp) = unk.cast::<IUIAutomationTextPattern>() {
                if let Ok(range) = tp.DocumentRange() {
                    if let Ok(text) = range.GetText(-1) {
                        let t = text.to_string();
                        let n = t.chars().count();
                        if n > TEXT_FALLBACK_MAX_CHARS {
                            return Err(InputCaptureError::Failed(format!(
                                "读到的文本有 {n} 字，超出输入框草稿的合理范围（焦点可能落在网页正文或文档上），已取消"
                            )));
                        }
                        let t = t.trim();
                        if t.is_empty() {
                            return Err(InputCaptureError::Empty);
                        }
                        return Ok(t.to_string());
                    }
                }
            }
        }
        Err(InputCaptureError::NotEditable)
    }
}

/* ---------- 模拟复制兜底 ---------- */

/// 剪贴板变更基线：在「触发复制动作」的时刻捕获（必须早于复制落盘），
/// 稍后用 wait_changed 轮询等待基线之后的新写入。Windows 记剪贴板序号
/// （零拷贝，复制相同内容也能判定），其他平台退化为文本快照比较。
/// 模拟复制取词与 Ctrl+C+C 双击共用：慢应用（Word / 大 PDF）的复制落盘
/// 可达秒级，固定延时后盲读会拿到上一次复制的内容
pub(crate) struct ClipboardBaseline {
    #[cfg(target_os = "windows")]
    seq: u64,
    #[cfg(not(target_os = "windows"))]
    text: String,
}

impl ClipboardBaseline {
    pub(crate) fn capture() -> Self {
        #[cfg(target_os = "windows")]
        {
            Self {
                seq: crate::inject::clipboard_seq_now(),
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            Self {
                text: arboard::Clipboard::new()
                    .ok()
                    .and_then(|mut c| c.get_text().ok())
                    .unwrap_or_default(),
            }
        }
    }

    /// 轮询等待基线之后出现的新文本（30ms 步进，上限 `timeout_ms`；
    /// 序号已前移但暂时读不出内容时继续等到上限——写入方还占着剪贴板）
    pub(crate) fn wait_changed(&self, timeout_ms: u64) -> Option<String> {
        let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            thread::sleep(Duration::from_millis(30));
            #[cfg(target_os = "windows")]
            let changed = crate::inject::clipboard_seq_now() > self.seq;
            #[cfg(not(target_os = "windows"))]
            let changed = arboard::Clipboard::new()
                .ok()
                .and_then(|mut c| c.get_text().ok())
                .map(|t| t != self.text)
                .unwrap_or(false);
            if changed {
                if let Some(t) = arboard::Clipboard::new()
                    .ok()
                    .and_then(|mut c| c.get_text().ok())
                    .filter(|t| !t.is_empty())
                {
                    return Some(t);
                }
            }
            if std::time::Instant::now() >= deadline {
                return None;
            }
        }
    }
}

fn copy_selection() -> Result<String, CaptureError> {
    #[cfg(target_os = "windows")]
    {
        if crate::inject::foreground_is_terminal() {
            return Err(CaptureError::Terminal);
        }
        if let Some(exe) = crate::inject::foreground_uipi_blocker() {
            return Err(CaptureError::Elevated(exe));
        }
    }
    // 热键的 Ctrl/⌘ 还按着时发 C 会变成组合键（不再是复制）：先等物理松键
    let _ = crate::inject::wait_modifiers_free(1200);

    let saved = crate::inject::save_clipboard_content();
    // 变更基线须在发出复制键之前捕获：「序号前移 / 内容变化」相对基线成立，
    // 才能证明读到的是本次选区而不是剪贴板里的旧内容
    let baseline = ClipboardBaseline::capture();

    send_copy_key().map_err(|e| CaptureError::Failed(format!("模拟复制失败：{e:#}")))?;

    let text = baseline.wait_changed(700).unwrap_or_default();
    // 读取完成时刻的剪贴板序号：稍后还原前校验窗口期内无他人写入
    #[cfg(target_os = "windows")]
    let seq_read = crate::inject::clipboard_seq_now();
    // 还原用户剪贴板（原本为空则保留取到的文本——多数场景反而有用）。
    // 序号守卫：取词后的窗口期内用户/其他程序动过剪贴板就放弃还原——
    // 用户新复制的内容优先，不拿取词前的旧内容盖回去（与 inject.rs
    // 粘贴后的延迟恢复守卫同理；非 Windows 无序号，维持原行为）
    if let Some(prev) = saved.as_ref() {
        thread::sleep(Duration::from_millis(50));
        #[cfg(target_os = "windows")]
        {
            if crate::inject::clipboard_seq_now() == seq_read {
                crate::inject::restore_clipboard_content(prev);
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            crate::inject::restore_clipboard_content(prev);
        }
    }
    if text.trim().is_empty() {
        Err(CaptureError::Empty)
    } else {
        Ok(text)
    }
}

fn send_copy_key() -> anyhow::Result<()> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut e = Enigo::new(&Settings::default()).map_err(|err| {
        anyhow::anyhow!(
            "{err}（macOS 需在 系统设置 → 隐私与安全性 → 辅助功能 中授权本应用）"
        )
    })?;
    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;
    let r = (|| -> anyhow::Result<()> {
        e.key(modifier, Direction::Press)?;
        e.key(Key::Unicode('c'), Direction::Click)?;
        e.key(modifier, Direction::Release)?;
        Ok(())
    })();
    // Click/Release 失败时 Ctrl/⌘ 还按着：不补发 Release 的话用户后续
    // 每个键都变组合键（inject::send_paste_key 同款补偿）
    if r.is_err() {
        let _ = e.key(modifier, Direction::Release);
    }
    r
}

/* ---------- 文本规整 ---------- */

/// 选中文本的规整：去首尾空白 + 软换行合并（PDF 复制出的硬换行不断句，
/// 直接翻译会把句子切碎）。带缩进/制表符的文本视为代码原样保留。
fn tidy(s: &str) -> String {
    soft_wrap_join(s.trim())
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x2e80..=0x9fff | 0xff00..=0xffef)
}

fn ends_sentence(s: &str) -> bool {
    s.chars().last().is_some_and(|c| {
        matches!(
            c,
            '.' | '!' | '?' | ':' | ';' | ',' | '”' | '"' | ')' | ']' | '}' | '’'
        ) || matches!(c as u32, 0x3002 | 0xff01 | 0xff1f | 0xff1a | 0xff1b | 0xff0c | 0x2026 | 0x3001 | 0x300d | 0x300b | 0xff09)
    })
}

/// 软换行合并：把被排版折断的行拼回整句。划词取词与截图 OCR 共用
/// （OCR 逐行输出同样需要区分「作者刻意断行」与「视觉折行」）
pub(crate) fn soft_wrap_join(s: &str) -> String {
    let lines: Vec<&str> = s.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    if lines.len() < 2 {
        return s.to_string();
    }
    // 代码特征：任意续行以空白开头或含制表符——原样保留，不做合并
    if lines[1..].iter().any(|l| l.starts_with(' ') || l.starts_with('\t')) || s.contains('\t') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    for (i, ln) in lines.iter().enumerate() {
        let cur = ln.trim();
        if i == 0 {
            out.push_str(cur);
            continue;
        }
        if cur.is_empty() {
            // 空行 = 段落边界，保留
            if !out.ends_with('\n') {
                out.push('\n');
            }
            continue;
        }
        if out.ends_with('\n') || ends_sentence(&out) {
            // 上一行以句读收尾（或刚遇段落边界）：这是作者刻意断行，保留换行
            out.push('\n');
            out.push_str(cur);
        } else {
            // 软换行：行中间被 PDF 排版折断——拼接还原成整句
            let prev_cjk = out.chars().last().is_some_and(is_cjk);
            let cur_cjk = cur.chars().next().is_some_and(is_cjk);
            if !prev_cjk && !cur_cjk {
                out.push(' '); // 拉丁字母之间补空格
            }
            out.push_str(cur);
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_soft_wrapped_cjk_lines() {
        let src = "这是一段从 PDF\n里复制出来的中文\n句子被硬换行切碎了。\n第二段从这里开始。";
        let out = soft_wrap_join(src);
        assert_eq!(out, "这是一段从 PDF里复制出来的中文句子被硬换行切碎了。\n第二段从这里开始。");
    }

    #[test]
    fn joins_latin_soft_wrap_with_space() {
        let src = "The quick brown fox\njumps over the lazy dog.";
        assert_eq!(soft_wrap_join(src), "The quick brown fox jumps over the lazy dog.");
    }

    #[test]
    fn keeps_paragraph_breaks_and_sentence_ends() {
        let src = "第一句结束。\n第二句开始\n\n新段落";
        assert_eq!(soft_wrap_join(src), "第一句结束。\n第二句开始\n\n新段落");
    }

    #[test]
    fn code_with_indentation_untouched() {
        let src = "fn main() {\n    let x = 1;\n    println!(x);\n}";
        assert_eq!(soft_wrap_join(src), src);
    }

    #[test]
    fn single_line_noop() {
        assert_eq!(soft_wrap_join("hello"), "hello");
    }
}
