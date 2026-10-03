//! Ctrl+C+C 双击复制即翻译（DeepL 式）：低级键盘钩子检测短时间内的第二次
//! Ctrl+C，把剪贴板里刚复制的内容送进翻译卡片。
//! 默认关闭；黑名单 / 引擎就绪 / 自写剪贴板 / 听写进行中守卫与「复制即翻译」一致。
//!
//! 工程约束：钩子回调跑在系统输入链路上，必须纳秒级返回——回调里只做
//! 原子开关判断与时间戳比对，命中后经 channel 交给工作线程处理全部重活；
//! 钩子永远不吞按键（始终 CallNextHookEx 透传）。注入事件（LLKHF_INJECTED，
//! 含本应用模拟复制的 Ctrl+C）一律忽略，防止自激励。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

use tauri::AppHandle;

use crate::config::Config;

static ENABLED: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);
static TRIGGER_TX: OnceLock<mpsc::Sender<()>> = OnceLock::new();

/// 配置变化时应用：置开关；首次开启时装载钩子（之后常驻，开关只控制行为）
pub fn apply(app: &AppHandle, cfg: &Config) {
    ENABLED.store(cfg.translate.ccc, Ordering::SeqCst);
    if cfg.translate.ccc {
        start(app.clone());
    }
}

fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let (tx, rx) = mpsc::channel::<()>();
    let _ = TRIGGER_TX.set(tx);
    // 工作线程：接收双击触发，等剪贴板新内容 + 守卫 + 弹翻译卡片（重活都在这）
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            // 第二次 Ctrl+C 刚按下、复制尚未落盘：此刻捕获序号基线（必须
            // 早于落盘，之后的「变更等待」才能区分新旧内容），再合并极短
            // 时间内的重复触发；落盘快慢交给轮询判定，不再固定盲等
            let baseline = crate::selection::ClipboardBaseline::capture();
            while rx.recv_timeout(Duration::from_millis(150)).is_ok() {}
            crate::translate::translate_clipboard_fresh(&app, baseline);
        }
    });
    // 钩子线程：Windows 低级键盘钩子需要消息循环（其他平台无实现，工作线程空转）
    #[cfg(target_os = "windows")]
    std::thread::spawn(hook_thread);
}

/* ---------- 双击判定（纯逻辑，可单测） ---------- */

/// 双击窗口：DeepL / pot 同类实现的常见值，快于常规连击、慢于滚键连发
const WINDOW_MS: u64 = 350;
/// 小于该间隔视为一次按键的系统重复投递（自动重复/抖动），不算双击
const NOISE_MS: u64 = 30;

#[derive(Default)]
struct CccState {
    /// 最近一次有效 Ctrl+C 的时刻；0 = 无记忆（任何其他按键都会清零）
    last_c_ms: u64,
}

impl CccState {
    /// 输入一次按键按下事件，返回是否构成 Ctrl+C 双击。
    /// 注入事件不参与判定也不清记忆（本应用模拟复制不打断用户节奏）；
    /// 非 C 键、无 Ctrl 的 C 一律重置记忆——
    /// 「Ctrl+C → 别的键 → Ctrl+C」不触发，只有干净的双击才算
    fn on_key(&mut self, vk_c: bool, ctrl: bool, injected: bool, now_ms: u64) -> bool {
        if injected {
            return false;
        }
        if !vk_c || !ctrl {
            self.last_c_ms = 0;
            return false;
        }
        let last = self.last_c_ms;
        self.last_c_ms = now_ms;
        last != 0 && now_ms > last && now_ms - last <= WINDOW_MS && now_ms - last > NOISE_MS
    }
}

/* ---------- Windows 低级键盘钩子 ---------- */

#[cfg(target_os = "windows")]
fn hook_thread() {
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
        WM_KEYDOWN, WM_SYSKEYDOWN,
    };

    static STATE: OnceLock<std::sync::Mutex<CccState>> = OnceLock::new();

    unsafe extern "system" fn proc(_code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
        use windows::Win32::UI::WindowsAndMessaging::{
            CallNextHookEx, LLKHF_INJECTED, LLKHF_LOWER_IL_INJECTED,
        };
        // 快路径：功能关闭时零成本透传
        if !ENABLED.load(Ordering::Relaxed) {
            return CallNextHookEx(None, _code, wparam, lparam);
        }
        let msg = wparam.0 as u32;
        if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            // 注入事件（LLKHF_INJECTED，含本应用模拟复制的 Ctrl+C）一律忽略，
            // 防止自激励，也不打断用户的双击节奏
            let injected = (kb.flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)).0 != 0;
            if !injected {
                if let Some(tx) = TRIGGER_TX.get() {
                    let ctrl = (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16) & 0x8000 != 0;
                    let st = STATE.get_or_init(|| std::sync::Mutex::new(CccState::default()));
                    let mut g = st.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    let now = windows::Win32::System::SystemInformation::GetTickCount64();
                    if g.on_key(kb.vkCode == 0x43, ctrl, false, now) {
                        let _ = tx.send(());
                    }
                }
            }
        }
        CallNextHookEx(None, _code, wparam, lparam)
    }

    unsafe {
        let Ok(hook) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(proc), None, 0) else {
            eprintln!("[speaknow] Ctrl+C+C 钩子安装失败（功能不可用，不影响其他功能）");
            return;
        };
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        let _ = UnhookWindowsHookEx(hook);
    }
}

#[cfg(test)]
mod tests {
    use super::CccState;

    /// 进度辅助：模拟一次按键并断言是否触发
    fn press(s: &mut CccState, vk_c: bool, ctrl: bool, injected: bool, at: u64) -> bool {
        s.on_key(vk_c, ctrl, injected, at)
    }

    #[test]
    fn double_ctrl_c_within_window_triggers() {
        let mut s = CccState::default();
        assert!(!press(&mut s, true, true, false, 1000));
        assert!(press(&mut s, true, true, false, 1200));
    }

    #[test]
    fn single_or_slow_press_does_not() {
        let mut s = CccState::default();
        // 无论怎么按，间隔超过窗口的连续单击永远不触发
        assert!(!press(&mut s, true, true, false, 1000));
        assert!(!press(&mut s, true, true, false, 1500));
        assert!(!press(&mut s, true, true, false, 2000));
        assert!(!press(&mut s, true, true, false, 3000));
    }

    #[test]
    fn other_key_or_no_ctrl_resets() {
        let mut s = CccState::default();
        assert!(!press(&mut s, true, true, false, 1000));
        assert!(!press(&mut s, false, true, false, 1100)); // 其他键
        assert!(!press(&mut s, true, true, false, 1300)); // 距上次 C 300ms 但中间断过
        assert!(!press(&mut s, true, true, false, 5000));
        assert!(!press(&mut s, true, false, false, 5100)); // 无 Ctrl
        assert!(!press(&mut s, true, true, false, 5300));
    }

    #[test]
    fn injected_events_never_trigger_but_keep_state() {
        let mut s = CccState::default();
        assert!(!press(&mut s, true, true, false, 1000));
        assert!(!press(&mut s, true, true, true, 1100)); // 注入：不触发、不清记忆
        // 真实双击判定按注入前的时间戳继续
        assert!(press(&mut s, true, true, false, 1300));
    }

    #[test]
    fn burst_noise_not_counted() {
        let mut s = CccState::default();
        assert!(!press(&mut s, true, true, false, 1000));
        assert!(!press(&mut s, true, true, false, 1010)); // 10ms 重复投递
        assert!(press(&mut s, true, true, false, 1300));
    }
}
