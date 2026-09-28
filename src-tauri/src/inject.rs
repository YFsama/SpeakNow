use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use enigo::{Direction, Enigo, Key, Keyboard, Settings};

use crate::config::OutputConfig;

/// 串行化粘贴：同一时刻只允许一条粘贴流程操作剪贴板/发按键。
/// 没有它，快速连续两次听写会交叉写剪贴板，出现「新话说完却粘出上一句」。
static PASTE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// 本应用最近一次写入剪贴板的文本。剪贴板监听（复制即翻译）据此跳过
/// 自身写入，杜绝「复制译文 → 监听又把译文翻一遍」的自激励循环；
/// 听写输出 / OCR 自动复制同理不触发
static LAST_OWN_TEXT: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

fn note_own_text(t: &str) {
    *LAST_OWN_TEXT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(t.to_string());
}

/// 最近一次由本应用写入剪贴板的文本（供剪贴板监听比对）
pub fn last_own_clipboard_text() -> Option<String> {
    LAST_OWN_TEXT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

/// 粘贴世代计数：新一轮 paste_text_checked 开始时递增。延迟恢复线程
/// 检查世代未变才执行恢复，防止过期恢复覆盖新一轮粘贴写入的内容
static PASTE_GEN: AtomicU64 = AtomicU64::new(0);

/// 粘贴前保存的用户剪贴板内容：文本或图像。恢复时按原类型写回——
/// 此前只按文本处理，用户复制的截图/设计稿会被听写文本静默清掉
pub(crate) enum SavedClipboard {
    Text(String),
    Image(arboard::ImageData<'static>),
}

pub(crate) fn save_clipboard_content() -> Option<SavedClipboard> {
    let mut c = arboard::Clipboard::new().ok()?;
    if let Ok(t) = c.get_text() {
        if !t.is_empty() {
            return Some(SavedClipboard::Text(t));
        }
    }
    c.get_image().ok().map(SavedClipboard::Image)
}

pub(crate) fn restore_clipboard_content(saved: &SavedClipboard) {
    let Ok(mut c) = arboard::Clipboard::new() else {
        return;
    };
    match saved {
        SavedClipboard::Text(t) => {
            let _ = c.set_text(t.clone());
        }
        SavedClipboard::Image(img) => {
            let _ = c.set_image(img.clone());
        }
    }
}

/// 本应用当前是否以管理员身份运行
#[cfg(target_os = "windows")]
pub fn win_elevated() -> bool {
    win::app_elevated()
}

/* ---------- 供划词翻译（selection）复用的探测助手 ---------- */

/// 前台窗口进程名（如 "Chrome.exe"），取不到返回空串
#[cfg(target_os = "windows")]
pub fn foreground_process_name() -> String {
    let (pid, ok) = win::foreground_pid();
    if ok && pid != 0 {
        win::process_name(pid)
    } else {
        String::new()
    }
}

/// 前台是否终端类窗口（终端里模拟 Ctrl+C 是中断信号，划词翻译须避开）
#[cfg(target_os = "windows")]
pub fn foreground_is_terminal() -> bool {
    win::foreground_is_terminal()
}

/// 前台窗口提权而本应用没有（UIPI 会拦截模拟按键）：返回阻断者进程名
#[cfg(target_os = "windows")]
pub fn foreground_uipi_blocker() -> Option<String> {
    win::uipi_blocker()
}

/// 当前剪贴板序号（任何程序写剪贴板都会 +1；判定模拟复制是否生效）
#[cfg(target_os = "windows")]
pub fn clipboard_seq_now() -> u64 {
    clipboard_seq()
}

/// 等待用户物理松开修饰键（热键的 Ctrl/⌘ 还按着时发 C 会变成组合键，不再是复制）
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn wait_modifiers_free(timeout_ms: u64) -> bool {
    wait_modifiers_released(timeout_ms, &|| false)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn wait_modifiers_free(_timeout_ms: u64) -> bool {
    true
}

/* ---------- Windows 前台窗口 / 按键状态探测 ---------- */
#[cfg(target_os = "windows")]
mod win {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId,
    };

    /// 进程可执行文件名（如 "WindowsTerminal.exe"），取不到时回退 "pid:N"
    pub fn process_name(pid: u32) -> String {
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return format!("pid:{pid}");
            };
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            let name = if windows::Win32::System::Threading::QueryFullProcessImageNameW(
                h,
                windows::Win32::System::Threading::PROCESS_NAME_WIN32,
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
            .is_ok()
            {
                let full = String::from_utf16_lossy(&buf[..len as usize]);
                full.rsplit(['\\', '/']).next().unwrap_or(&full).to_string()
            } else {
                format!("pid:{pid}")
            };
            let _ = CloseHandle(h);
            name
        }
    }

    /// 已知终端窗口类名特征（小写包含匹配）
    const TERMINAL_CLASSES: &[&str] = &[
        "cascadia", "consolewindow", "mintty", "virtualconsole", "alacritty", "wezterm", "putty",
    ];

    /// 用户是否仍物理按着修饰键（Ctrl/Shift/Alt/Win）。
    /// 热键 Ctrl+Shift+Space 触发输入时，用户常还没松开 Ctrl+Shift——
    /// 此时注入的 V 会变成 Ctrl+Shift+V，在终端等应用里不再触发粘贴。
    pub fn modifiers_held() -> bool {
        unsafe {
            [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN]
                .iter()
                .any(|vk| (GetAsyncKeyState(vk.0 as i32) as u16) & 0x8000 != 0)
        }
    }

    pub(crate) fn foreground_pid() -> (u32, bool) {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return (0, false);
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            (pid, true)
        }
    }

    /// 前台是否已是其他应用（悬浮窗/预览编辑收回后焦点已回到目标窗口）
    pub fn foreground_is_foreign() -> bool {
        let (pid, ok) = foreground_pid();
        ok && pid != 0 && pid != std::process::id()
    }

    fn foreground_class() -> String {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return String::new();
            }
            let mut buf = [0u16; 64];
            let n = GetClassNameW(hwnd, &mut buf);
            String::from_utf16_lossy(&buf[..n.max(0) as usize])
        }
    }

    /// 前台是否终端类窗口（Windows Terminal / conhost / mintty 等）
    pub fn foreground_is_terminal() -> bool {
        let class = foreground_class().to_lowercase();
        TERMINAL_CLASSES.iter().any(|k| class.contains(k))
    }

    /// 终端窗口应使用的粘贴键：Unix 风格终端（Windows Terminal / WSL /
    /// mintty / alacritty / wezterm）默认绑定 Ctrl+Shift+V；
    /// 传统 conhost 与 PuTTY 只认 Shift+Insert。
    pub fn terminal_paste_key() -> &'static str {
        let class = foreground_class().to_lowercase();
        if class.contains("consolewindow") || class.contains("putty") {
            "shift+insert"
        } else {
            "ctrl+shift+v"
        }
    }

    fn process_elevated(pid: u32) -> bool {
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut token = HANDLE::default();
            let opened = OpenProcessToken(h, TOKEN_QUERY, &mut token).is_ok();
            let _ = CloseHandle(h);
            if !opened {
                return false;
            }
            let mut elev = TOKEN_ELEVATION::default();
            let mut ret = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut elev as *mut _ as *mut core::ffi::c_void),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut ret,
            )
            .is_ok();
            let _ = CloseHandle(token);
            ok && elev.TokenIsElevated != 0
        }
    }

    fn self_elevated() -> bool {
        unsafe {
            let mut token = HANDLE::default();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
                return true; // 读不到就按「已提权」处理，避免误报
            }
            let mut elev = TOKEN_ELEVATION::default();
            let mut ret = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut elev as *mut _ as *mut core::ffi::c_void),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut ret,
            )
            .is_ok();
            let _ = CloseHandle(token);
            ok && elev.TokenIsElevated != 0
        }
    }

    /// 本应用当前是否以管理员身份运行（供 UI 展示）
    pub fn app_elevated() -> bool {
        self_elevated()
    }

    /// 前台窗口以管理员运行而本应用没有：UIPI 会静默丢弃注入的按键（表现为「自动输入无反应」。
    /// 返回阻断者的进程名，未阻断返回 None。
    pub fn uipi_blocker() -> Option<String> {
        let (pid, ok) = foreground_pid();
        if ok && pid != 0 && process_elevated(pid) && !self_elevated() {
            Some(process_name(pid))
        } else {
            None
        }
    }
}

/* ---------- macOS 按键状态探测（CoreGraphics 公开 C API，无需额外依赖） ---------- */
#[cfg(target_os = "macos")]
mod mac {
    // kCGEventSourceStateCombinedSessionState；CGEventSourceKeyState 是稳定公开 API，
    // Tauri 在 macOS 上已链接 CoreGraphics，直接 extern 声明即可调用。
    const STATE_COMBINED_SESSION: u32 = 0;
    /// 左右修饰键虚拟键码（HIToolbox/Events.h 的 kVK_* 常量值）
    const MODIFIER_VKEYS: &[u16] = &[
        54, // kVK_RightCommand
        55, // kVK_Command
        56, // kVK_Shift
        58, // kVK_Option
        59, // kVK_Control
        60, // kVK_RightShift
        61, // kVK_RightOption
        62, // kVK_RightControl
    ];

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceKeyState(state: u32, key: u16) -> bool;
    }

    /// 用户是否仍物理按着修饰键（⌘/⌃/⌥/⇧，左右键都查）
    pub fn modifiers_held() -> bool {
        unsafe {
            MODIFIER_VKEYS
                .iter()
                .any(|&k| CGEventSourceKeyState(STATE_COMBINED_SESSION, k))
        }
    }
}

/// 用户是否仍物理按着修饰键。Windows 读 GetAsyncKeyState，macOS 读
/// CGEventSourceKeyState；Linux 无该探测路径。
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn any_modifiers_held() -> bool {
    #[cfg(target_os = "windows")]
    {
        win::modifiers_held()
    }
    #[cfg(target_os = "macos")]
    {
        mac::modifiers_held()
    }
}

/// 等待用户物理松开修饰键（超时后放弃等待继续执行）
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn wait_modifiers_released(timeout_ms: u64, bail: &dyn Fn() -> bool) -> bool {
    let step = Duration::from_millis(25);
    for _ in 0..(timeout_ms / 25) {
        if bail() {
            return false; // 已被新的录音取代，立即放弃
        }
        if !any_modifiers_held() {
            break;
        }
        thread::sleep(step);
    }
    thread::sleep(Duration::from_millis(20)); // 松键事件传播余量
    !bail()
}

/// 等待前台窗口切回目标应用（预览编辑确认后焦点回归目标窗口）
#[cfg(target_os = "windows")]
fn wait_foreground_foreign(timeout_ms: u64, bail: &dyn Fn() -> bool) -> bool {
    for _ in 0..(timeout_ms / 25) {
        if bail() {
            return false;
        }
        if win::foreground_is_foreign() {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    !bail()
}

/// Windows 剪贴板序号：任何程序每次写剪贴板都会 +1（用于确认写入生效/期间无人改动）
#[cfg(target_os = "windows")]
fn clipboard_seq() -> u64 {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    unsafe { GetClipboardSequenceNumber() as u64 }
}

/// 写入剪贴板并双重校验（读回一致 + 序号前移）。剪贴板管理器（ToDesk 同步 /
/// Win+V 历史 / 云同步）可能让写入延迟生效，出现「粘贴出上一次的内容」——
/// 校验始终失败时必须报错放弃自动粘贴（内容大概率已在剪贴板，可手动 Ctrl+V），
/// 绝不能带着旧内容发粘贴键。
fn copy_verified(text: &str) -> Result<()> {
    #[cfg(target_os = "windows")]
    let seq_before = clipboard_seq();
    let mut last_err = String::new();
    // ~2 秒内重试：先密后疏
    let waits = [40, 40, 60, 60, 100, 100, 150, 150, 200, 200, 250, 250];
    for (attempt, wait) in waits.iter().enumerate() {
        let mut cb = match arboard::Clipboard::new() {
            Ok(cb) => cb,
            Err(e) => {
                last_err = format!("{e}");
                thread::sleep(Duration::from_millis(*wait));
                continue;
            }
        };
        if let Err(e) = cb.set_text(text.to_string()) {
            last_err = format!("{e}");
            thread::sleep(Duration::from_millis(*wait));
            continue;
        }
        drop(cb); // 立即释放剪贴板，别自己占着锁
        // 直接读回校验（读回+序号双重证明写入生效即通过）；失败才进入
        // 等待重试——成功路径不再固定睡 20ms
        let read_ok = arboard::Clipboard::new()
            .ok()
            .and_then(|mut c| c.get_text().ok())
            .map(|t| t == text)
            .unwrap_or(false);
        #[cfg(target_os = "windows")]
        let seq_ok = clipboard_seq() > seq_before;
        #[cfg(not(target_os = "windows"))]
        let seq_ok = true;
        if read_ok && seq_ok {
            note_own_text(text);
            return Ok(());
        }
        if attempt == waits.len() - 1 {
            last_err = if read_ok { "序号未前移".into() } else { "读回不一致".into() };
        }
        thread::sleep(Duration::from_millis(*wait));
    }
    Err(anyhow::anyhow!(
        "剪贴板被其他程序占用（{last_err}），本次结果已尽力复制；自动粘贴已取消，可手动 Ctrl+V"
    ))
}

pub fn copy_only(text: &str) -> Result<()> {
    let mut cb = arboard::Clipboard::new().context("无法访问剪贴板")?;
    cb.set_text(text.to_string())
        .context("写入剪贴板失败")?;
    note_own_text(text);
    Ok(())
}

/// 把文字输入到当前焦点窗口（无条件执行；用户在预览编辑里点「输入」等场景使用）
pub fn paste_text(cfg: &OutputConfig, text: &str) -> Result<()> {
    match paste_text_checked(cfg, text, Arc::new(|| false), None, None, false) {
        Ok(_) => Ok(()),
        Err(e) => Err(e),
    }
}

/// 带取代检查的粘贴。`superseded` 返回 true 表示本次结果已被新的录音取代，
/// 放弃自动输入但把结果复制到剪贴板（返回 Ok(false)，调用方提示「已跳过 · 已复制」，
/// 用户可在右键粘贴类终端里手动粘贴）。
/// `voice_gate`：麦克风说话峰值百分比阈值（如 2.5）——粘贴前探测到用户正在
/// 说话时暂缓输入（最多约 6 秒），杜绝「我正说着下一句，旧结果突然被敲进来」。
/// 检查点：等待结束写入剪贴板前、发粘贴键前——覆盖 LLM 与各等待期间新录音开始的窗口。
/// `quiet_stop`：调用方确认「录音以静音收尾且管线耗时很短」，可跳过说话探测
/// （探测本身要开一次 ~220ms 的录音流，是粘贴路径最大的固定延迟）
pub fn paste_text_checked(
    cfg: &OutputConfig,
    text: &str,
    superseded: Arc<dyn Fn() -> bool + Send + Sync>,
    device: Option<&str>,
    voice_gate: Option<f32>,
    quiet_stop: bool,
) -> Result<bool> {
    let _lock = PASTE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);

    // 「被新录音取代」：放弃自动输入，但结果留在剪贴板供手动粘贴（右键/Ctrl+V）
    macro_rules! skip {
        () => {{
            let _ = copy_only(text);
            return Ok(false);
        }};
    }

    // 1) 等用户物理松开热键修饰键（Ctrl+Shift 残留会让注入的 V 变成 Ctrl+Shift+V）
    // 2) 等前台窗口回到目标应用（悬浮窗/预览编辑收回后焦点回归）
    #[cfg(target_os = "windows")]
    {
        let bail = || superseded();
        if !wait_modifiers_released(1500, &bail) {
            skip!();
        }
        if !wait_foreground_foreign(800, &bail) {
            skip!();
        }
        thread::sleep(Duration::from_millis(30));
        if superseded() {
            skip!();
        }
        if let Some(exe) = win::uipi_blocker() {
            return Err(anyhow::anyhow!(
                "目标窗口 {exe} 以管理员身份运行，系统已阻止按键注入；点击下方「以管理员身份重启」即可解决，或手动 Ctrl+V 粘贴"
            ));
        }
    }
    // macOS：热键的 ⌘/⌃/⌥/⇧ 还按着时注入 ⌘V 会变成组合键（终端等应用不再触发
    // 粘贴，「按了没反应」的最常见原因）——与 Windows 同样先等物理松键再发送
    #[cfg(target_os = "macos")]
    {
        let bail = || superseded();
        if !wait_modifiers_released(1500, &bail) {
            skip!();
        }
        thread::sleep(Duration::from_millis(30));
        if superseded() {
            skip!();
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    thread::sleep(Duration::from_millis(30));
    if superseded() {
        skip!();
    }

    // 说话探测：用户正在说话时暂缓输入（录音已被取代的场景之外，还存在
    // 「录音意外早停、用户未重新按键继续说」的情况——此时无法用代数判断，
    // 用麦克风活动兜底：正在说话就等，安静了再输入）。
    // quiet_stop 跳过：静音收尾 + 管线耗时短 → 正在说话概率极低
    if let Some(thr) = voice_gate {
        if !quiet_stop {
            let t0 = std::time::Instant::now();
            while t0.elapsed() < Duration::from_secs(6) {
                if superseded() {
                    skip!();
                }
                match crate::audio::mic_test(device, false, 0.0, 220, |_| {}) {
                    Ok(r) if r.peak_level >= thr => {
                        thread::sleep(Duration::from_millis(350));
                    }
                    _ => break, // 安静（或探测失败）→ 继续输入
                }
            }
        }
    }

    // 输入方式决策：全局模拟键入；或「终端键入」模式在终端窗口对单行文本
    // 直接模拟键入（不依赖任何粘贴快捷键，兼容只用鼠标右键粘贴的终端）。
    // 多行文本在终端里键入会逐行触发执行，退回 Shift+Insert 粘贴。
    let terminal_typing = cfg.paste_key == "terminal-typing"
        && !text.contains('\n')
        && !text.contains('\r')
        && {
            #[cfg(target_os = "windows")]
            {
                win::foreground_is_terminal()
            }
            #[cfg(not(target_os = "windows"))]
            {
                false
            }
        };

    if cfg.method == "typing" || terminal_typing {
        // 同步执行并把错误上抛：模拟键入失败（macOS 未授予辅助功能权限是最常见
        // 原因）必须让用户看见，静默丢弃会表现为「按了快捷键但什么都没输入」
        let mut e = new_enigo()?;
        e.text(text).map_err(|err| {
            anyhow::anyhow!(
                "模拟键盘输入失败：{err}（macOS 需在 系统设置 → 隐私与安全性 → 辅助功能 中授权本应用；也可在「输出」改用剪贴板粘贴）"
            )
        })?;
        if cfg.auto_submit {
            thread::sleep(Duration::from_millis(120));
            e.key(Key::Return, Direction::Click)
                .map_err(|err| anyhow::anyhow!("模拟回车失败: {err}"))?;
        }
        return Ok(true);
    }

    let saved = if cfg.restore_clipboard {
        save_clipboard_content()
    } else {
        None
    };

    copy_verified(text)?;
    // 校验通过（读回一致 + 序号前移已证明写入生效）后留一小段传播余量
    thread::sleep(Duration::from_millis(30));

    // auto：终端窗口按类型选粘贴键（WT/WSL 等 Unix 风格 → Ctrl+Shift+V；
    // conhost/PuTTY → Shift+Insert），其余用 Ctrl+V；terminal-typing 的
    // 终端单行场景已在上方转为模拟键入，这里落到默认 Ctrl+V
    let effective_key = match cfg.paste_key.as_str() {
        "auto" => {
            #[cfg(target_os = "windows")]
            {
                if win::foreground_is_terminal() {
                    win::terminal_paste_key()
                } else {
                    "ctrl+v"
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                "ctrl+v"
            }
        }
        // 终端键入模式走到这里说明是终端多行文本（键入会逐行执行，不可用）：
        // 终端退回 Shift+Insert，非终端用 Ctrl+V
        "terminal-typing" => {
            #[cfg(target_os = "windows")]
            {
                if win::foreground_is_terminal() {
                    "shift+insert"
                } else {
                    "ctrl+v"
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                "ctrl+v"
            }
        }
        other => other,
    };
    // 发键前最后一道代数检查：等待/校验期间用户可能已开始下一次听写
    if superseded() {
        skip!();
    }
    // 粘贴世代：新一轮粘贴开始即 +1。延迟恢复线程据此放弃过期的恢复，
    // 避免「上一次粘贴的恢复线程把新一次粘贴刚写入的相同文本覆盖回旧内容」
    // （Windows 有序号守卫，mac/Linux 无——世代令牌跨平台兜底）
    let paste_gen = PASTE_GEN.fetch_add(1, Ordering::SeqCst);
    if let Err(e) = send_paste_key(effective_key) {
        // 粘贴键失败也必须恢复用户原剪贴板：copy_verified 已把原内容覆盖掉
        if let Some(prev) = saved.as_ref() {
            restore_clipboard_content(prev);
        }
        return Err(e);
    }

    // 延迟恢复原剪贴板：必须晚于目标应用读取剪贴板的时刻。双重守卫：
    // ① 剪贴板序号未变（期间用户/任何程序都没动过剪贴板，含下一次听写已写入相同文本的情况）
    // ② 内容仍是本次文本。两条都满足才恢复，杜绝「恢复过早 → 粘出旧内容」。
    #[cfg(target_os = "windows")]
    let seq_after_set = clipboard_seq();
    if let Some(prev) = saved {
        let mark = text.to_string();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(2000));
            // 已有新一轮粘贴：本恢复过期，放弃
            if PASTE_GEN.load(Ordering::SeqCst) != paste_gen {
                return;
            }
            #[cfg(target_os = "windows")]
            if clipboard_seq() != seq_after_set {
                return;
            }
            let unchanged = arboard::Clipboard::new()
                .ok()
                .and_then(|mut c| c.get_text().ok())
                .map(|cur| cur == mark)
                .unwrap_or(false);
            if unchanged {
                restore_clipboard_content(&prev);
            }
        });
    }

    if cfg.auto_submit {
        thread::sleep(Duration::from_millis(150));
        let mut e = new_enigo()?;
        e.key(Key::Return, Direction::Click)?;
    }
    Ok(true)
}

fn new_enigo() -> Result<Enigo> {
    Enigo::new(&Settings::default()).context(
        "初始化键盘模拟失败（macOS 需在 系统设置 → 隐私与安全性 → 辅助功能 中授权本应用）",
    )
}

fn send_paste_key(paste_key: &str) -> Result<()> {
    let mut e = new_enigo()?;
    // Shift+Insert 是 Windows/Linux 终端的粘贴键；macOS 键盘没有 Insert 键
    // （enigo 的 mac 后端也没有 Key::Insert 变体），该配置在 mac 上退回
    // 系统标准粘贴键（下方 default 分支的 ⌘V）
    #[cfg(target_os = "windows")]
    if paste_key == "shift+insert" {
        e.key(Key::Shift, Direction::Press)?;
        e.key(Key::Insert, Direction::Click)?;
        e.key(Key::Shift, Direction::Release)?;
        return Ok(());
    }
    match paste_key {
        "ctrl+shift+v" => {
            // Windows Terminal / WSL / Unix 风格终端的标准粘贴键
            e.key(Key::Control, Direction::Press)?;
            e.key(Key::Shift, Direction::Press)?;
            e.key(Key::Unicode('v'), Direction::Click)?;
            e.key(Key::Shift, Direction::Release)?;
            e.key(Key::Control, Direction::Release)?;
        }
        _ => {
            #[cfg(target_os = "macos")]
            let modifier = Key::Meta;
            #[cfg(not(target_os = "macos"))]
            let modifier = Key::Control;
            e.key(modifier, Direction::Press)?;
            e.key(Key::Unicode('v'), Direction::Click)?;
            e.key(modifier, Direction::Release)?;
        }
    }
    Ok(())
}
