//! 文本模拟输入（Typist）：把整段文本以模拟键盘逐字敲进当前焦点窗口。
//! 面向禁用粘贴/右键/剪贴板的平台（考试系统、加密表单、只读页面）——
//! 这类页面拦截的是剪贴板读取，而 KEYEVENTF_UNICODE 按键事件走 WM_CHAR
//! 通道，目标应用会当作正常键盘输入接收。
//!
//! 工程要点：
//! - Windows 不经 enigo 直接 SendInput(KEYEVENTF_UNICODE)：enigo 对 ASCII
//!   走「VK + 扫描码」路径，非美式键盘布局下标点符号会错位；Unicode 事件
//!   与布局无关，代理对（emoji 等 BMP 外字符）拆成两个 UTF-16 单元发送
//! - 「按任意物理键中止」：低级键盘钩子以 LLKHF_INJECTED 区分注入与物理
//!   按键（模式同 ccc.rs），钩子首次使用后常驻，快路径仅判 ACTIVE 原子量
//! - 进度经 sn-typing-progress 广播，结束（完成/中止/出错）发 sn-typing-done；
//!   窗口关闭（关闭按钮）也会触发中止
//! - 回车原样模拟：文本里的换行就是一次 Enter——在聊天应用里等于「发送」，
//!   这是用户明确要求的行为（目标平台正是要用键盘语义绕过限制）
//! - 节奏在输入进行中可实时调整（typing_set_speed 改写 LIVE_DELAYS，注入
//!   循环逐字符读取）：长文本可以先快后慢，边看目标应用的反应边调，不用
//!   停下重来；剪贴板直输（start_clipboard）省去开窗-粘贴-开始三步
//! - 草稿持久化到 app_config_dir/typist-draft.txt：托盘直输路径不经前端，
//!   落盘收进 start_common，两条入口共享同一份草稿

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::config::TypistConfig;

/// typist 窗口 label（按需创建，见 open_typist）
const WIN_LABEL: &str = "typist";

/// 是否有一轮模拟输入正在进行（含隐藏窗口后的倒计时阶段）
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// 中止请求：物理按键钩子 / typing_stop / 窗口关闭 任一来源置位
static ABORT: AtomicBool = AtomicBool::new(false);
/// 已敲入 / 总字符数（码点口径；typing_status 与进度事件共用）
static DONE: AtomicUsize = AtomicUsize::new(0);
static TOTAL: AtomicUsize = AtomicUsize::new(0);
/// 本轮输入的目标窗口标题（倒计时结束后捕获；窗口重开时经 typing_status 带出）
static TARGET: Mutex<String> = Mutex::new(String::new());
/// 本轮生效的节奏 (每键 ms, 行停顿 ms)：启动时从配置快照装入，输入进行中
/// 由 typing_set_speed 实时改写——注入循环每个按键读一次，改完下一个字符
/// 就生效，无需停止重启
static LIVE_DELAYS: Mutex<(u32, u32)> = Mutex::new((15, 120));
/// 中止钩子线程是否已启动（进程内只装一次，与 ccc.rs 同约束）；
/// 仅 Windows 有低级键盘钩子路径，其余平台无此静态量
#[cfg(target_os = "windows")]
static HOOK_STARTED: AtomicBool = AtomicBool::new(false);

/// 节奏参数钳制：配置文件可被手改，0 间隔会在注入层变成无停顿洪泛
/// （目标应用丢字 + 进度事件刷屏），下限兜底。纯函数可单测
fn clamp_cfg(cfg: TypistConfig) -> TypistConfig {
    TypistConfig {
        char_delay_ms: cfg.char_delay_ms.max(1),
        line_delay_ms: cfg.line_delay_ms,
        start_delay_ms: cfg.start_delay_ms.max(100),
        always_on_top: cfg.always_on_top,
    }
}

/* ---------- 对外命令 ---------- */

/// 开始把整段文本逐字敲进当前焦点窗口。隐藏 typist 窗口后立即返回，
/// 等待焦点回归 / 倒计时 / 逐字注入都在后台线程完成，进度走事件。
#[tauri::command]
pub fn typing_start(app: AppHandle, text: String) -> Result<String, String> {
    if text.is_empty() {
        return Err("没有可输入的文本".into());
    }
    start_common(&app, text)
}

/// 托盘「直接输入剪贴板文本」：复制好内容 → 点一下 → 开始敲，不开窗。
/// 剪贴板可能被其他程序短暂占着（打开重试可达百毫秒），读取放阻塞线程池
#[tauri::command]
pub async fn typing_start_clipboard(app: AppHandle) -> Result<String, String> {
    start_clipboard(&app).await
}

pub async fn start_clipboard(app: &AppHandle) -> Result<String, String> {
    let text = tauri::async_runtime::spawn_blocking(|| {
        arboard::Clipboard::new()
            .ok()
            .and_then(|mut cb| cb.get_text().ok())
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(text) = text.filter(|t| !t.is_empty()) else {
        return Err("剪贴板里没有文本内容".into());
    };
    start_common(app, text)
}

/// 读一次剪贴板文本（小窗「从剪贴板开始」按钮用；只读不写）
#[tauri::command]
pub async fn typing_clipboard_text() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        arboard::Clipboard::new()
            .map_err(|_| "无法访问剪贴板".to_string())
            .and_then(|mut cb| cb.get_text().map_err(|_| "剪贴板里没有文本".to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 输入进行中实时调速（也允许空闲时预置下一轮）：注入循环逐字符读取，
/// 改完下一个字符即生效。每键间隔下限 1ms 与 clamp_cfg 同口径
#[tauri::command]
pub fn typing_set_speed(char_delay_ms: u32, line_delay_ms: u32) {
    *LIVE_DELAYS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        (char_delay_ms.max(1), line_delay_ms);
}

/// 两条入口（小窗开始 / 托盘剪贴板直输）共用的启动路径
fn start_common(app: &AppHandle, text: String) -> Result<String, String> {
    // 先占坑再校验：命令可并发进入，两次连点「开始」不能都通过 ACTIVE
    // 检查（check-then-set 有竞态，会开两条注入线程交错敲键盘）
    if ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("已有一次模拟输入正在进行，请先停止".into());
    }
    // 校验失败路径统一还坑，让下一次开始不被卡死
    macro_rules! bail {
        ($msg:expr) => {{
            ACTIVE.store(false, Ordering::SeqCst);
            return Err($msg.into());
        }};
    }
    // 听写会话进行中注入会与「识别结果自动输入」打架（两条注入流交错）
    if app
        .state::<crate::Ctx>()
        .recording
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .is_some()
    {
        bail!("正在录音，请先结束当前听写再模拟输入");
    }
    let cfg = app
        .state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .map(|c| clamp_cfg(c.typist.clone()))
        .unwrap_or_default();

    // 藏起自己，焦点才能回到目标应用（用户刚在我们窗口里点「开始」）
    if let Some(w) = app.get_webview_window(WIN_LABEL) {
        let _ = w.hide();
    }
    install_abort_hook();
    ABORT.store(false, Ordering::SeqCst);
    DONE.store(0, Ordering::SeqCst);
    TOTAL.store(text.chars().count(), Ordering::SeqCst);
    // 旧轮次的标题先清掉：typing_status 不能把上一轮的目标报给这一轮
    TARGET
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clear();
    *LIVE_DELAYS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        (cfg.char_delay_ms, cfg.line_delay_ms);
    save_draft(app, &text);
    let h = app.clone();
    std::thread::spawn(move || run_typing(&h, text, cfg));
    Ok("started".into())
}

/// 请求中止当前模拟输入（下一个按键边界生效，延迟 ≤ 每键间隔）
#[tauri::command]
pub fn typing_stop() {
    ABORT.store(true, Ordering::SeqCst);
}

/// 当前进度快照（typist 窗口重开时恢复界面状态用；target 为本轮目标窗口标题）
#[tauri::command]
pub fn typing_status() -> serde_json::Value {
    serde_json::json!({
        "active": ACTIVE.load(Ordering::SeqCst),
        "done": DONE.load(Ordering::SeqCst),
        "total": TOTAL.load(Ordering::SeqCst),
        "target": TARGET.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone(),
    })
}

/// 打开（或首次按需创建）typist 窗口。托盘 / 热键 / 设置页共用；
/// 窗口创建必须经主线程，内部自行派发，可在任意线程调用。
#[tauri::command]
pub fn open_typist(app: AppHandle) {
    open_window(&app);
}

/// 热键路径的开关语义：窗口可见时再按一次收起（托盘/仪表盘入口始终唤起）
pub fn toggle_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WIN_LABEL) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            return;
        }
    }
    open_window(app);
}

pub fn open_window(app: &AppHandle) {
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        // 置顶跟随配置（抄录场景：目标页面滚动查看时小窗不被盖住）
        let top = h
            .state::<crate::Ctx>()
            .config
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|c| c.typist.always_on_top)
            .unwrap_or(false);
        if let Some(w) = h.get_webview_window(WIN_LABEL) {
            // 复用已有窗口：文本还留在里面，直接唤起
            let _ = w.set_always_on_top(top);
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
            return;
        }
        let built = tauri::WebviewWindowBuilder::new(
            &h,
            WIN_LABEL,
            tauri::WebviewUrl::App("typist.html".into()),
        )
        .title("文本模拟输入 · SpeakNow")
        .inner_size(600.0, 560.0)
        .min_inner_size(520.0, 460.0)
        .center()
        .resizable(true)
        .always_on_top(top)
        // 先建后显：避免窗口在默认位置闪现再跳到居中位
        .visible(false)
        .build();
        match built {
            Ok(w) => {
                let _ = w.show();
                let _ = w.set_focus();
            }
            Err(e) => eprintln!("[speaknow] typist 窗口创建失败: {e:#}"),
        }
    });
}

/// typist 窗口被关闭时：中止进行中的输入（此时窗口在前台，物理按键钩子
/// 看不到用户点关闭按钮的鼠标事件）并隐藏保活——textarea 里的草稿不丢
pub fn on_window_closed(app: &AppHandle) {
    ABORT.store(true, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(WIN_LABEL) {
        let _ = w.hide();
    }
}

/// 小窗置顶开关（对照原文抄录场景：目标页面要滚动查看，小窗不能被盖住）。
/// 持久化由前端 save_config 完成，这里只动窗口
#[tauri::command]
pub fn typist_set_top(app: AppHandle, on: bool) {
    if let Some(w) = app.get_webview_window(WIN_LABEL) {
        let _ = w.set_always_on_top(on);
    }
}

/* ---------- 草稿持久化 ---------- */

fn draft_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("typist-draft.txt"))
}

/// 读取上次留下的草稿（小窗挂载时恢复）。超过 1MB 当作没有——损坏或
/// 手改出来的异常文件不该整串灌进前端
#[tauri::command]
pub fn typist_read_draft(app: AppHandle) -> Option<String> {
    let p = draft_path(&app)?;
    let s = std::fs::read_to_string(p).ok()?;
    (s.len() <= 1024 * 1024).then_some(s)
}

/// 保存草稿（前端编辑去抖后调用）。空串 = 用户清空了输入框，删文件
#[tauri::command]
pub fn typist_save_draft(app: AppHandle, text: String) {
    save_draft(&app, &text);
}

fn save_draft(app: &AppHandle, text: &str) {
    let Some(p) = draft_path(app) else {
        return;
    };
    if text.is_empty() {
        let _ = std::fs::remove_file(&p);
        return;
    }
    if text.len() > 1024 * 1024 {
        return;
    }
    // 原子写（复用 config 的 tmp+rename），进程被杀也只会留下完整旧/新文件
    let _ = crate::config::atomic_write(&p, text.as_bytes());
}

/// 启动类失败的可见反馈（托盘剪贴板直输失败时前端小窗可能根本没开过，
/// 行内错误无处显示）：悬浮窗错误卡 + 提示音，门控与收尾卡一致
pub fn show_error_card(app: &AppHandle, msg: &str) {
    let cfg = app
        .state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .unwrap_or_default();
    if cfg.general.show_overlay && !crate::pipeline::suppress_local_overlay(&cfg) {
        crate::overlay::show(app);
    }
    crate::pipeline::emit_status(app, "error", msg, cfg.general.sound_feedback);
    crate::pipeline::hide_later(app, 4200);
}

/* ---------- 注入主循环 ---------- */

/// 结束原因（sn-typing-done 的 reason 字段；前端按此渲染提示文案）
fn run_typing(app: &AppHandle, text: String, cfg: TypistConfig) {
    let total = text.chars().count();
    let outcome = typing_loop(app, &text, &cfg, total);
    ACTIVE.store(false, Ordering::SeqCst);
    let done = DONE.load(Ordering::SeqCst);
    let (reason, error) = match outcome {
        Ok(()) => ("done", None),
        Err(TypingError::Stopped) => ("stopped", None),
        Err(TypingError::Failed(e)) => ("error", Some(e)),
    };
    // typist 专属事件只给本窗口恢复状态用，走本地 emit（不进外接字幕屏广播）
    let _ = app.emit(
        "sn-typing-done",
        serde_json::json!({
            "reason": reason,
            "done": done,
            "total": total,
            "error": error,
        }),
    );
    // 收尾反馈复用听写通道：悬浮窗收尾卡 + 提示音 + 自动隐藏（关闭悬浮窗的
    // 用户只剩 typist 窗口重开时的横幅，不强制弹窗）。中止不算失败：绿色
    // done 卡即可，出错才走红卡
    let cfg_now = app
        .state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .unwrap_or_default();
    let (stage, msg, hide_ms) = match (reason, error) {
        ("done", _) => ("done", format!("模拟输入完成：共 {total} 字"), 2600),
        ("stopped", _) => ("done", format!("模拟输入已中止：{done} / {total} 字"), 2600),
        (_, Some(e)) => ("error", format!("模拟输入失败：{e}"), 4200),
        (_, None) => ("error", "模拟输入失败：未知错误".to_string(), 4200),
    };
    if cfg_now.general.show_overlay && !crate::pipeline::suppress_local_overlay(&cfg_now) {
        crate::overlay::show(app);
    }
    crate::pipeline::emit_status(app, stage, &msg, cfg_now.general.sound_feedback);
    crate::pipeline::hide_later(app, hide_ms);
}

enum TypingError {
    /// 用户主动中止（物理按键 / 停止按钮 / 关窗口）
    Stopped,
    Failed(String),
}

fn typing_loop(
    app: &AppHandle,
    text: &str,
    cfg: &TypistConfig,
    total: usize,
) -> Result<(), TypingError> {
    // 等焦点回到目标应用：typist 窗口刚隐藏，Windows 会把焦点还给上一个
    // 活动窗口；等不到（用户又点了别处也无妨，前台是谁就敲给谁）只设上限，
    // 不因超时失败——用户可能主动把焦点切到别的输入框
    for _ in 0..48 {
        if ABORT.load(Ordering::SeqCst) {
            return Err(TypingError::Stopped);
        }
        if crate::inject::foreground_is_foreign() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    // 本轮专用的高精度定时器（快档毫秒级间隔的精度保障），随循环结束关闭
    let timer = HiResTimer::new();
    // 倒计时余量：焦点切换动画 / 用户松手
    sleep_abortable(u64::from(cfg.start_delay_ms.max(100)), &timer)?;
    // 捕获目标窗口标题：这是按键即将落下的地方，随首条进度事件告知前端
    // （「正在输入到：xxx」）——敲错窗口是最需要立刻暴露的事故
    let target = crate::selection::foreground_title();
    *TARGET
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = target.clone();
    // UIPI：目标窗口提权而本应用没有时按键会被系统静默丢弃，提前报错
    // 好过「按了开始却一个字都没出现」
    #[cfg(target_os = "windows")]
    if let Some(exe) = crate::inject::foreground_uipi_blocker() {
        return Err(TypingError::Failed(format!(
            "目标窗口 {exe} 以管理员身份运行，系统已阻止按键注入；请以管理员身份重启 SpeakNow 后重试"
        )));
    }

    #[cfg(target_os = "windows")]
    let mut typer = win::WinTyper;
    #[cfg(not(target_os = "windows"))]
    let mut typer = enigo::Enigo::new(&enigo::Settings::default())
        .map_err(|e| TypingError::Failed(format!("初始化键盘模拟失败: {e}")))?;

    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if ABORT.load(Ordering::SeqCst) {
            return Err(TypingError::Stopped);
        }
        let Some(tap) = classify(c, chars.peek().copied()) else {
            continue;
        };
        // 每个按键读一次实时节奏：typing_set_speed 改完，下一个字符就生效
        // （锁开销纳秒级，相对毫秒级的按键间隔可忽略）
        let (char_ms, line_ms) =
            *LIVE_DELAYS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let KeyTap::Enter = tap {
            // 行尾停顿：目标应用（尤其网页表单）对回车的响应常是异步的，
            // 立刻跟上下一行会丢首字符
            type_key(&mut typer, tap).map_err(TypingError::Failed)?;
            let done = DONE.fetch_add(1, Ordering::SeqCst) + 1;
            emit_progress(app, done, total);
            sleep_abortable(u64::from(char_ms) + u64::from(line_ms), &timer)?;
        } else {
            type_key(&mut typer, tap).map_err(TypingError::Failed)?;
            let done = DONE.fetch_add(1, Ordering::SeqCst) + 1;
            emit_progress(app, done, total);
            sleep_abortable(u64::from(char_ms), &timer)?;
        }
    }
    Ok(())
}

/// 字符 → 要模拟的按键。`\r\n` 只产生一次回车（跳过 \r 交给 \n）；
/// 孤立 `\r`（旧 Mac 行尾）同样按回车；其余控制字符没有输入语义，跳过。
/// 纯函数，独立于注入实现可单测。
fn classify(c: char, next: Option<char>) -> Option<KeyTap> {
    match c {
        '\r' if next == Some('\n') => None,
        '\r' | '\n' => Some(KeyTap::Enter),
        '\t' => Some(KeyTap::Tab),
        c if (c as u32) < 0x20 || c as u32 == 0x7f => None,
        c => Some(KeyTap::Char(c)),
    }
}

/// 可中止的睡眠：切成 ≤20ms 的片轮询 ABORT，长倒计时也能瞬间停下来。
/// Windows 下走高精度等待定时器（见 HiResTimer），其他平台 thread::sleep
fn sleep_abortable(ms: u64, timer: &HiResTimer) -> Result<(), TypingError> {
    let mut left = ms;
    while left > 0 {
        if ABORT.load(Ordering::SeqCst) {
            return Err(TypingError::Stopped);
        }
        let step = left.min(20);
        timer.sleep_ms(step);
        left -= step;
    }
    Ok(())
}

/* ---------- Windows 高精度定时器 ---------- */

/// `thread::sleep` 受系统定时器分辨率限制（默认 15.6ms，除非有进程调过
/// timeBeginPeriod）：快档（3~8ms）实际会被拉平到 ~15ms，八档速度在快端
/// 形同虚设。HIGH_RESOLUTION waitable timer（Win10 1803+）进程内生效、
/// 无 timeBeginPeriod 的全局功耗副作用，精度亚毫秒。创建失败（旧系统）
/// 自动回退 thread::sleep，行为退化但不坏。
#[cfg(target_os = "windows")]
struct HiResTimer(Option<windows::Win32::Foundation::HANDLE>);

#[cfg(target_os = "windows")]
impl HiResTimer {
    fn new() -> Self {
        let h = unsafe {
            windows::Win32::System::Threading::CreateWaitableTimerExW(
                None,
                None,
                windows::Win32::System::Threading::CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                windows::Win32::System::Threading::SYNCHRONIZATION_SYNCHRONIZE.0,
            )
        };
        Self(h.ok())
    }

    fn sleep_ms(&self, ms: u64) {
        if ms == 0 {
            return;
        }
        let Some(h) = self.0 else {
            std::thread::sleep(Duration::from_millis(ms));
            return;
        };
        unsafe {
            // due time 为负 = 相对时间，单位 100ns；period=0 一次性
            let due = -((ms as i64) * 10_000);
            if windows::Win32::System::Threading::SetWaitableTimer(h, &due, 0, None, None, false)
                .is_ok()
            {
                let _ = windows::Win32::System::Threading::WaitForSingleObject(
                    h,
                    windows::Win32::System::Threading::INFINITE,
                );
            } else {
                std::thread::sleep(Duration::from_millis(ms));
            }
        }
    }
}

/// 每轮注入线程创建一个，线程结束时 Drop 关闭句柄（一次输入一个对象，
/// 不做 thread_local：worker 线程用完即弃，局部生命周期恰好匹配）
#[cfg(target_os = "windows")]
impl Drop for HiResTimer {
    fn drop(&mut self) {
        if let Some(h) = self.0.take() {
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(h) };
        }
    }
}

#[cfg(not(target_os = "windows"))]
struct HiResTimer;

#[cfg(not(target_os = "windows"))]
impl HiResTimer {
    fn new() -> Self {
        Self
    }
    fn sleep_ms(&self, ms: u64) {
        if ms > 0 {
            std::thread::sleep(Duration::from_millis(ms));
        }
    }
}

/// 进度事件按 1/10 或收尾粒度节流：长文本逐字符广播只是给 UI 画进度条，
/// 没必要把事件通道刷满。本地 emit——进度不是字幕内容，不进外接屏广播
fn emit_progress(app: &AppHandle, done: usize, total: usize) {
    // done==1（首拍，目标标题刚捕获）与 done==total 必发；中间按 1/10 节流
    if done == 1 || done % 10 == 0 || done == total {
        let target = TARGET
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let _ = app.emit(
            "sn-typing-progress",
            serde_json::json!({ "done": done, "total": total, "target": target }),
        );
    }
}

/* ---------- 平台注入实现 ---------- */

/// 单测需要 assert_eq! 比较与打印；Copy 便于 classify 返回值直接传递
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyTap {
    Char(char),
    Enter,
    Tab,
}

#[cfg(target_os = "windows")]
fn type_key(typer: &mut win::WinTyper, key: KeyTap) -> Result<(), String> {
    typer.tap(key)
}

#[cfg(not(target_os = "windows"))]
fn type_key(typer: &mut enigo::Enigo, key: KeyTap) -> Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard};
    let k = match key {
        KeyTap::Char(c) => Key::Unicode(c),
        KeyTap::Enter => Key::Return,
        KeyTap::Tab => Key::Tab,
    };
    typer.key(k, Direction::Click).map_err(|e| format!("模拟按键失败: {e}"))
}

#[cfg(target_os = "windows")]
mod win {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_RETURN, VK_TAB,
    };

    pub struct WinTyper;

    impl WinTyper {
        /// Unicode 单元一按一抬放在同一次 SendInput 里，中间不会被其他
        /// 输入插队（连发的两个字符交错产生乱序）
        pub fn tap(&mut self, key: super::KeyTap) -> Result<(), String> {
            match key {
                super::KeyTap::Char(c) => self.char(c),
                super::KeyTap::Enter => self.vk(VK_RETURN),
                super::KeyTap::Tab => self.vk(VK_TAB),
            }
        }

        fn char(&mut self, c: char) -> Result<(), String> {
            let mut buf = [0u16; 2];
            for unit in c.encode_utf16(&mut buf) {
                let inputs = [unicode(*unit, false), unicode(*unit, true)];
                send(&inputs)?;
            }
            Ok(())
        }

        fn vk(&mut self, vk: VIRTUAL_KEY) -> Result<(), String> {
            let inputs = [kbd(vk, false), kbd(vk, true)];
            send(&inputs)
        }
    }

    /// KEYEVENTF_UNICODE 每个事件只携带一个 UTF-16 单元；代理对
    /// （emoji 等 BMP 外字符）由上层拆成高低位先后发送，目标应用按
    /// WM_CHAR 序列自行重组
    fn unicode(unit: u16, up: bool) -> INPUT {
        let mut flags = KEYEVENTF_UNICODE;
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: unit,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn kbd(vk: VIRTUAL_KEY, up: bool) -> INPUT {
        let mut flags = windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS::default();
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn send(inputs: &[INPUT]) -> Result<(), String> {
        let n = unsafe {
            SendInput(inputs, std::mem::size_of::<INPUT>() as i32)
        };
        if n != inputs.len() as u32 {
            return Err(format!("SendInput 仅接受 {}/{} 个事件", n, inputs.len()));
        }
        Ok(())
    }
}

/* ---------- 物理按键中止钩子（仅 Windows，模式同 ccc.rs） ---------- */

fn install_abort_hook() {
    #[cfg(target_os = "windows")]
    {
        if HOOK_STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(hook_thread);
    }
    #[cfg(not(target_os = "windows"))]
    {
        // 非 Windows 无低级键盘钩子路径：中止只能靠 typing_stop / 关窗口
    }
}

#[cfg(target_os = "windows")]
fn hook_thread() {
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
        WM_KEYDOWN, WM_SYSKEYDOWN,
    };

    unsafe extern "system" fn proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        use windows::Win32::UI::WindowsAndMessaging::{
            CallNextHookEx, LLKHF_INJECTED, LLKHF_LOWER_IL_INJECTED,
        };
        // 快路径：没在模拟输入时零成本透传（与 ccc.rs 同约束）
        if !ACTIVE.load(Ordering::Relaxed) {
            return CallNextHookEx(None, code, wparam, lparam);
        }
        let msg = wparam.0 as u32;
        if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let injected = (kb.flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)).0 != 0;
            // 本应用注入的字符带 INJECTED 标志；用户真实按下任何键 = 立即让路。
            // 长文本敲几分钟，「发现敲错地方了想停下来」是最强的中止诉求
            if !injected {
                ABORT.store(true, Ordering::SeqCst);
            }
        }
        // 永不吞按键：用户按键原样传给目标应用
        CallNextHookEx(None, code, wparam, lparam)
    }

    unsafe {
        let Ok(hook) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(proc), None, 0) else {
            eprintln!("[speaknow] typist 中止钩子安装失败（仍可用停止按钮中止）");
            return;
        };
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        let _ = UnhookWindowsHookEx(hook);
    }
}

#[cfg(test)]
mod tests {
    use super::{clamp_cfg, classify, KeyTap, TypistConfig};

    #[test]
    fn clamp_floors_delays_but_keeps_line_pause() {
        // 手改配置出现 0：每键间隔必须抬到 ≥1ms（0 会变成无停顿洪泛），
        // 起手倒计时 ≥100ms；行停顿允许为 0（只是不加额外停顿）
        let c = clamp_cfg(TypistConfig {
            char_delay_ms: 0,
            line_delay_ms: 0,
            start_delay_ms: 0,
            always_on_top: false,
        });
        assert_eq!(c.char_delay_ms, 1);
        assert_eq!(c.line_delay_ms, 0);
        assert_eq!(c.start_delay_ms, 100);
        // 正常值原样保留
        let ok = clamp_cfg(TypistConfig {
            char_delay_ms: 15,
            line_delay_ms: 120,
            start_delay_ms: 800,
            always_on_top: true,
        });
        assert_eq!(ok.char_delay_ms, 15);
        assert_eq!(ok.line_delay_ms, 120);
        assert_eq!(ok.start_delay_ms, 800);
        assert!(ok.always_on_top);
    }

    #[test]
    fn crlf_and_lone_cr_collapse_to_single_enter() {
        // \r 跟着 \n：跳过 \r，回车由 \n 产生（不重复）
        assert_eq!(classify('\r', Some('\n')), None);
        assert_eq!(classify('\n', Some('a')), Some(KeyTap::Enter));
        // 孤立 \r（旧 Mac 行尾）也是一次回车
        assert_eq!(classify('\r', Some('a')), Some(KeyTap::Enter));
        assert_eq!(classify('\r', None), Some(KeyTap::Enter));
    }

    #[test]
    fn tab_passes_through_and_controls_skip() {
        assert_eq!(classify('\t', None), Some(KeyTap::Tab));
        // NUL / ESC / DEL 等没有输入语义，不产生按键
        assert_eq!(classify('\0', None), None);
        assert_eq!(classify('\x1b', None), None);
        assert_eq!(classify('\x7f', None), None);
    }

    #[test]
    fn visible_chars_pass_through_unchanged() {
        assert_eq!(classify('a', None), Some(KeyTap::Char('a')));
        assert_eq!(classify('中', None), Some(KeyTap::Char('中')));
        // BMP 外字符（emoji）原样交给注入层拆代理对
        assert_eq!(classify('🎉', None), Some(KeyTap::Char('🎉')));
        // 0x20 空格是可见字符不是控制字符
        assert_eq!(classify(' ', None), Some(KeyTap::Char(' ')));
    }
}
