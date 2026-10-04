//! 截图取词（OCR）：全局热键 → 每屏一个全屏透明框选窗 → GDI 截屏 →
//! Windows.Media.Ocr（系统内置离线引擎）→ 悬浮窗 OCR 卡片（复制 / 翻译 / 输入到光标）。
//!
//! 引擎分层（调研结论见 docs/ocr-research.md）：
//! - system：Windows.Media.Ocr，零下载零依赖、毫秒级、词级坐标；中文依赖
//!   系统 OCR 语言包（缺失时引导安装，不静默失败）——M1 快路径
//! - ppocr / vlm：后续质量档预留位（ort + PP-OCRv5 / llama.cpp + PaddleOCR-VL），
//!   当前选择时回落 system
//!
//! 选区实现：每台显示器一个 transparent 无边框置顶窗（overlay.html?ocr=N 路由），
//! 前端拖拽出逻辑像素矩形回调 ocr_region_selected；此刻隐藏全部选区窗后用 GDI
//! 按物理像素重截选区——用户确认瞬间看到什么就识别什么，无需冻结帧传递大图。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::config::Config;

/// 正在进行截图选区（防重入：热键狂按 / 托盘连点只开一轮）
static SELECTING: AtomicBool = AtomicBool::new(false);

/// 选区窗标签前缀，每屏一窗：ocr-sel-0 / ocr-sel-1 …（首次创建后常驻隐藏复用）
const SEL_PREFIX: &str = "ocr-sel-";

fn current_config(app: &AppHandle) -> Config {
    app.state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .unwrap_or_default()
}

/* ---------- 入口（热键 / 托盘 / 设置页「试一下」） ---------- */

/// 开始一次截图取词：弹出各屏选区窗等待框选。线程安全，可从任意线程调用。
pub fn start_capture(app: &AppHandle) {
    // 非 Windows：截屏（GDI）与识别（Windows.Media.Ocr）链路尚未移植，必须在
    // 入口直接报错走 sn-ocr-error 事件——否则用户完整框选松手后才在
    // recognize_region 里失败，白白经历一轮选区交互
    #[cfg(not(target_os = "windows"))]
    {
        emit_error(app, "截图取词当前仅支持 Windows");
        return;
    }
    let cfg = current_config(app);
    if !cfg.ocr.enabled {
        return;
    }
    if SELECTING.swap(true, Ordering::SeqCst) {
        return;
    }
    // 窗口创建必须经主线程；不等待结果（选区窗何时出齐与本流程无竞态——
    // region_selected 只会在窗可见后被用户触发）
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = open_selection_windows(&h) {
            SELECTING.store(false, Ordering::SeqCst);
            eprintln!("[speaknow] 截图取词选区窗创建失败: {e:#}");
            emit_error(&h, &format!("截图取词启动失败：{e:#}"));
        }
    });
}

/// 每屏一个选区窗：已创建的直接复位尺寸后显示（跨屏布局变化自适应），首次创建
fn open_selection_windows(app: &AppHandle) -> anyhow::Result<()> {
    let probe = app
        .get_webview_window("overlay")
        .or_else(|| app.get_webview_window("main"))
        .ok_or_else(|| anyhow::anyhow!("无法枚举显示器"))?;
    let monitors = probe.available_monitors()?;
    if monitors.is_empty() {
        anyhow::bail!("未检测到显示器");
    }
    for (i, mon) in monitors.iter().enumerate() {
        let pos = *mon.position();
        let size = *mon.size();
        let label = format!("{SEL_PREFIX}{i}");
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
            let _ = w.set_size(tauri::PhysicalSize::new(size.width, size.height));
            let _ = w.show();
        } else {
            let url = format!("overlay.html?ocr={i}");
            let scale = mon.scale_factor();
            // builder 只收逻辑坐标（物理/逻辑换算后传入），build 完再用物理值精确复位
            let w = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
                .title("SpeakNow 截图取词")
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false)
                .resizable(false)
                .visible(false)
                .position(pos.x as f64 / scale, pos.y as f64 / scale)
                .inner_size(size.width as f64 / scale, size.height as f64 / scale)
                .build()?;
            let _ = w.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
            let _ = w.set_size(tauri::PhysicalSize::new(size.width, size.height));
            // 先定位后显示，避免窗口在默认位置闪现
            let _ = w.show();
        }
    }
    Ok(())
}

/// 隐藏全部选区窗（保留实例，下次秒开）
fn hide_selection_windows(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if label.starts_with(SEL_PREFIX) {
            let _ = w.hide();
        }
    }
}

fn emit_error(app: &AppHandle, message: &str) {
    show_overlay_respecting_config(app);
    let _ = app.emit("sn-ocr-error", serde_json::json!({ "message": message }));
    crate::pipeline::hide_later(app, 6000);
}

fn show_overlay_respecting_config(app: &AppHandle) {
    let cfg = current_config(app);
    if cfg.general.show_overlay && !crate::pipeline::suppress_local_overlay(&cfg) {
        crate::overlay::show(app);
    }
}

/* ---------- Tauri 命令 ---------- */

/// 前端框选完成：入参为该选区窗内的逻辑像素矩形（左上原点 + 宽高）。
/// 隐藏选区窗 → 换算物理像素 → GDI 重截 → OCR → 结果事件。
#[tauri::command]
pub async fn ocr_region_selected(
    app: AppHandle,
    webview_window: tauri::WebviewWindow,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), String> {
    // 先取窗口定位信息再隐藏（outer_position = 所在显示器物理原点）
    let scale = webview_window.scale_factor().unwrap_or(1.0);
    let origin = webview_window.outer_position().map_err(|e| e.to_string())?;
    hide_selection_windows(&app);
    if !SELECTING.swap(false, Ordering::SeqCst) {
        return Ok(()); // 过期回调（已取消后又触发的残余事件）
    }
    if w < 4 || h < 4 {
        return Ok(()); // 误触的极小选区：当作用户取消
    }
    let px = origin.x + (x as f64 * scale).round() as i32;
    let py = origin.y + (y as f64 * scale).round() as i32;
    let pw = (w as f64 * scale).round() as i32;
    let ph = (h as f64 * scale).round() as i32;

    let cfg = current_config(&app);
    show_overlay_respecting_config(&app);
    // 复位听写/翻译卡片状态机（清掉残留的 done/翻译卡），再进 OCR 流程
    crate::pipeline::emit_status(&app, "idle", "", false);
    let _ = app.emit("sn-ocr-start", serde_json::json!({}));

    let h = app.clone();
    let cfg2 = cfg.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        // 选区窗刚隐藏，等合成器把残影刷掉再截，否则会截到还没消失的遮罩
        std::thread::sleep(Duration::from_millis(140));
        let lines = match recognize_region(&h, &cfg2, px, py, pw, ph) {
            Ok(l) => l,
            Err(e) => {
                crate::trace_pipeline(&h, &format!("截图取词失败：{e:#}"));
                emit_error(&h, &format!("{e:#}"));
                return;
            }
        };
        let text = crate::selection::soft_wrap_join(&lines.join("\n"));
        let ms = t0.elapsed().as_millis() as u64;
        crate::trace_pipeline(
            &h,
            &format!(
                "截图取词完成：{ms}ms（{}字，区域 {pw}×{ph}）",
                text.chars().count()
            ),
        );
        if text.trim().is_empty() {
            emit_error(&h, "该区域没有识别到文字（可尝试框选更大的范围）");
            return;
        }
        // 识别后自动复制也可能失败（剪贴板被占用）：结果事件带回 copyFailed，
        // 卡片据此提示手动复制——否则用户粘贴出旧内容还以为识别错了
        let copy_failed =
            cfg2.ocr.copy_on_capture && crate::inject::copy_only(&text).is_err();
        // 截图翻译一键链：AI 未配置时降级为普通 OCR 卡片（复制/翻译按钮仍可用）
        let llm = cfg2.resolved_llm();
        let can_translate =
            cfg2.ocr.auto_translate && llm.enabled && !llm.base_url.trim().is_empty();
        if can_translate {
            let target = cfg2.llm.translate_target.clone();
            crate::translate::start_session(&h, &cfg2, text, target);
        } else {
            // 识别成功入历史（kind=ocr，识别耗时记到 asr 位；前端据 asrMs/llmMs 隐藏耗时行）
            crate::history::push(&h, &text, &text, ms, 0, "ocr");
            let _ = h.emit(
                "sn-ocr-result",
                serde_json::json!({ "text": text, "ms": ms, "copyFailed": copy_failed }),
            );
            // OCR 卡片要读要选：给足驻留时间，悬停钉住时计时自动暂停
            crate::pipeline::hide_later(&h, 15_000);
        }
    });
    Ok(())
}

/// 取消本轮选区（Esc / 右键 / 单击空白）
#[tauri::command]
pub fn ocr_cancel(app: AppHandle) {
    hide_selection_windows(&app);
    SELECTING.store(false, Ordering::SeqCst);
}

/// 手动触发一次截图取词（设置页「试一下」/ 托盘菜单）
#[tauri::command]
pub async fn ocr_capture_cmd(app: AppHandle) -> Result<String, String> {
    start_capture(&app);
    Ok("ok".into())
}

/// OCR 卡片「输入到光标」：收起悬浮窗后粘贴（不自动提交，粘贴是编辑不是发送）
#[tauri::command]
pub async fn ocr_paste(app: AppHandle, text: String) -> Result<(), String> {
    let cfg = current_config(&app);
    crate::overlay::hide(&app);
    // 等悬浮窗收回、焦点回到目标应用
    tokio::time::sleep(Duration::from_millis(240)).await;
    let mut out = cfg.output.clone();
    out.auto_submit = false;
    let t = text;
    tauri::async_runtime::spawn_blocking(move || crate::inject::paste_text(&out, &t))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("输入失败：{e:#}"))?;
    crate::pipeline::emit_status(&app, "idle", "", false);
    Ok(())
}

/// 系统 OCR 引擎可用的语言包标签（BCP-47，如 zh-Hans-CN / en-US）。
/// 前端据此判断中文语言包是否已装、引导安装（不静默失败）。
#[tauri::command]
pub async fn ocr_langs() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(available_language_tags)
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("{e:#}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("仅 Windows 支持系统 OCR".into())
    }
}

/// 一键打开系统语言设置页（安装 OCR 语言包用）
#[tauri::command]
pub fn open_language_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:regionlanguage"])
            .spawn()
            .map_err(|e| format!("打开失败：{e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        return Err("仅 Windows 支持".into());
    }
    Ok(())
}

/* ---------- 识别主流程（按配置引擎分发） ---------- */

/// 截取物理像素区域并识别，返回逐行文本（未做软换行合并）
fn recognize_region(
    app: &AppHandle,
    cfg: &Config,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> anyhow::Result<Vec<String>> {
    #[cfg(target_os = "windows")]
    {
        match cfg.ocr.engine.as_str() {
            "ppocr" => ppocr_region(app, x, y, w, h),
            // 云端档：视觉大模型 API（复用「AI 优化」凭据组；GLM-4.6V-Flash 免费档起步）
            "cloud" => {
                let llm = cfg.resolved_llm();
                if !llm.enabled || llm.base_url.trim().is_empty() {
                    anyhow::bail!("云端 OCR 复用「AI 优化」接口：请先在「AI 优化」页启用并配置（GLM-4.6V-Flash 免费）");
                }
                cloud_ocr_region(&llm, x, y, w, h)
            }
            // vlm 高精度档（PaddleOCR-VL + llama.cpp）尚未内置：回落系统引擎
            "vlm" => {
                eprintln!("[speaknow] OCR 引擎 {} 尚未内置，回落 system", cfg.ocr.engine);
                win_ocr_region(&cfg.ocr.language, x, y, w, h)
            }
            _ => win_ocr_region(&cfg.ocr.language, x, y, w, h),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, cfg, x, y, w, h);
        anyhow::bail!("截图取词当前仅支持 Windows")
    }
}

/* ---------- Windows：GDI 截屏 + Windows.Media.Ocr ---------- */

#[cfg(target_os = "windows")]
fn win_ocr_region(lang_pref: &str, x: i32, y: i32, w: i32, h: i32) -> anyhow::Result<Vec<String>> {
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;

    // COM 守卫：WinRT 调用与 IAsyncOperation::get 的阻塞等待都要求 MTA；
    // 本函数只会在 spawn_blocking 的线程池线程上执行（无既有套间）
    let _com = ComGuard::new();
    let engine = build_engine(lang_pref)?;
    // 引擎有最大边长限制（通常 4096）：超限时等比缩到限制内再截
    let max_dim = OcrEngine::MaxImageDimension().unwrap_or(4096) as f64;
    let scale = (max_dim / w.max(1) as f64)
        .min(max_dim / h.max(1) as f64)
        .min(1.0);
    let target = if scale < 1.0 {
        Some((
            ((w as f64 * scale).round() as i32).max(1),
            ((h as f64 * scale).round() as i32).max(1),
        ))
    } else {
        None
    };
    let frame = capture_region(x, y, w, h, target)?;

    // 像素写入 Buffer：无参 DataWriter 写内部缓冲后 DetachBuffer（自动维护
    // Length；CreateCopyFromBuffer 按 Length 读取，Buffer::Create 后 Length=0）
    let writer = DataWriter::new().map_err(|e| anyhow::anyhow!("创建 DataWriter 失败: {e}"))?;
    writer
        .WriteBytes(&frame.pixels)
        .map_err(|e| anyhow::anyhow!("写入像素失败: {e}"))?;
    let buffer = writer
        .DetachBuffer()
        .map_err(|e| anyhow::anyhow!("取出缓冲区失败: {e}"))?;
    let _ = writer.Close();
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        frame.width as i32,
        frame.height as i32,
    )
    .map_err(|e| anyhow::anyhow!("构建位图失败: {e}"))?;

    let op = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| anyhow::anyhow!("启动识别失败: {e}"))?;
    let result = op.get().map_err(|e| anyhow::anyhow!("识别失败: {e}"))?;
    let lines = result
        .Lines()
        .map_err(|e| anyhow::anyhow!("读取结果失败: {e}"))?;
    let n = lines.Size().unwrap_or(0);
    let mut out = Vec::with_capacity(n as usize);
    for i in 0..n {
        let Ok(line) = lines.GetAt(i) else { continue };
        let Ok(text) = line.Text() else { continue };
        out.push(strip_cjk_spaces(&text.to_string()));
    }
    Ok(out)
}

/// COM 初始化守卫：MTA，只初始化、永不卸载。原因：WinRT 激活工厂是进程级
/// 静态缓存（FactoryCache），先 CoUninitialize 拆掉套间后，其他线程（线程池
/// 线程会复用同一缓存）继续使用缓存的工厂会访问冲突崩溃。短命线程的 MTA
/// 随线程退出自然回收，泄漏一个初始化计数无害。
#[cfg(target_os = "windows")]
struct ComGuard {
    _priv: (),
}

#[cfg(target_os = "windows")]
impl ComGuard {
    fn new() -> Self {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        // 已初始化（任何模式）时返回错误，这里统统忽略：MTA 场景下重复
        // 初始化是幂等的引用计数
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        ComGuard { _priv: () }
    }
}

/// 按偏好挑选 OCR 引擎：auto 跟随用户语言列表；指定语言则匹配语言包前缀；
/// 全部落空时给可操作的引导信息（装语言包）而不是裸错误
#[cfg(target_os = "windows")]
fn build_engine(lang_pref: &str) -> anyhow::Result<windows::Media::Ocr::OcrEngine> {
    use windows::Media::Ocr::OcrEngine;

    let pref = lang_pref.trim().to_lowercase();
    if pref.is_empty() || pref == "auto" {
        if let Ok(e) = OcrEngine::TryCreateFromUserProfileLanguages() {
            return Ok(e);
        }
    } else if let Ok(avail) = OcrEngine::AvailableRecognizerLanguages() {
        let n = avail.Size().unwrap_or(0);
        for i in 0..n {
            if let Ok(l) = avail.GetAt(i) {
                let tag_matches = l
                    .LanguageTag()
                    .map(|t| t.to_string().to_lowercase().starts_with(&pref))
                    .unwrap_or(false);
                if tag_matches {
                    if let Ok(e) = OcrEngine::TryCreateFromLanguage(&l) {
                        return Ok(e);
                    }
                }
            }
        }
    }
    // 兜底：任意可用语言包（好过直接失败——偏好语言缺失时至少能识别）
    if let Ok(avail) = OcrEngine::AvailableRecognizerLanguages() {
        let n = avail.Size().unwrap_or(0);
        for i in 0..n {
            if let Ok(l) = avail.GetAt(i) {
                if let Ok(e) = OcrEngine::TryCreateFromLanguage(&l) {
                    return Ok(e);
                }
            }
        }
    }
    anyhow::bail!(
        "系统未安装任何 OCR 语言包：设置 → 时间和语言 → 语言和区域 → 添加语言（如「中文(简体，中国)」），\
         装好后无需重启即可使用"
    )
}

/// 系统已装的 OCR 语言包标签列表
#[cfg(target_os = "windows")]
fn available_language_tags() -> anyhow::Result<Vec<String>> {
    use windows::Media::Ocr::OcrEngine;
    let _com = ComGuard::new();
    let avail = OcrEngine::AvailableRecognizerLanguages()
        .map_err(|e| anyhow::anyhow!("枚举语言包失败: {e}"))?;
    let n = avail.Size().unwrap_or(0);
    let mut out = Vec::with_capacity(n as usize);
    for i in 0..n {
        if let Ok(l) = avail.GetAt(i) {
            if let Ok(tag) = l.LanguageTag() {
                out.push(tag.to_string());
            }
        }
    }
    Ok(out)
}

/// 自上而下 BGRA 位图（alpha 已强制 255，GDI 不保证 alpha 通道有效）
#[cfg(target_os = "windows")]
pub(crate) struct BgraFrame {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

/// GDI 截取物理像素区域。target = Some((tw, th)) 时缩放截取（HALFTONE 插值），
/// 用于超过 OCR 引擎边长上限的大区域。
#[cfg(target_os = "windows")]
fn capture_region(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    target: Option<(i32, i32)>,
) -> anyhow::Result<BgraFrame> {
    capture_region_opts(x, y, w, h, target, true)
}

/// `layered`：是否带 CAPTUREBLT（纳入分层窗口）。OCR 识别路径需要（其他
/// 应用的悬浮层也是屏幕内容）；放大镜底图必须**不带**——选区窗自身就是
/// 透明分层窗，带着截会把遮罩/十字准线/提示横幅烤进底图（本窗口自己的
/// 140ms 残影等待就是同一问题的自证），像素级对准会被自家准线遮蔽
#[allow(clippy::too_many_arguments)]
fn capture_region_opts(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    target: Option<(i32, i32)>,
    layered: bool,
) -> anyhow::Result<BgraFrame> {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HALFTONE, HGDIOBJ, SRCCOPY,
    };

    if w <= 0 || h <= 0 {
        anyhow::bail!("选区尺寸无效（{w}×{h}）");
    }
    let (out_w, out_h) = target.unwrap_or((w, h));
    let scaled = out_w != w || out_h != h;
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            anyhow::bail!("打开屏幕 DC 失败");
        }
        let memdc = CreateCompatibleDC(Some(screen));
        // 中转位图：按原始尺寸整块 BitBlt（layered 时 CAPTUREBLT 纳入分层窗口）
        let rop = if layered { SRCCOPY | CAPTUREBLT } else { SRCCOPY };
        let src_bmp = CreateCompatibleBitmap(screen, w, h);
        let src_old = SelectObject(memdc, HGDIOBJ::from(src_bmp));
        let blit_ok = BitBlt(memdc, 0, 0, w, h, Some(screen), x, y, rop).is_ok();
        if !blit_ok {
            SelectObject(memdc, src_old);
            let _ = DeleteObject(HGDIOBJ::from(src_bmp));
            let _ = DeleteDC(memdc);
            let _ = ReleaseDC(None, screen);
            anyhow::bail!("屏幕捕获失败（BitBlt）");
        }
        // 缩放路径：src 仍选在 memdc 中作为 StretchBlt 源，另建 DC+位图做目标
        let dst_bmp = if scaled {
            let dstdc = CreateCompatibleDC(Some(screen));
            let dst = CreateCompatibleBitmap(screen, out_w, out_h);
            let dst_old = SelectObject(dstdc, HGDIOBJ::from(dst));
            let _ = SetStretchBltMode(dstdc, HALFTONE);
            let s_ok =
                StretchBlt(dstdc, 0, 0, out_w, out_h, Some(memdc), 0, 0, w, h, SRCCOPY).as_bool();
            SelectObject(dstdc, dst_old);
            let _ = DeleteDC(dstdc);
            if !s_ok {
                SelectObject(memdc, src_old);
                let _ = DeleteObject(HGDIOBJ::from(dst));
                let _ = DeleteObject(HGDIOBJ::from(src_bmp));
                let _ = DeleteDC(memdc);
                let _ = ReleaseDC(None, screen);
                anyhow::bail!("屏幕缩放捕获失败（StretchBlt）");
            }
            Some(dst)
        } else {
            None
        };
        // GetDIBits 要求目标位图不在任何 DC 中：memdc 换回默认对象
        // （同时解除 src_bmp 的选中，才能安全删除）
        SelectObject(memdc, src_old);
        let (read_bmp, bmp_w, bmp_h) = match dst_bmp {
            Some(dst) => {
                let _ = DeleteObject(HGDIOBJ::from(src_bmp));
                (dst, out_w, out_h)
            }
            None => (src_bmp, w, h),
        };
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: bmp_w,
                biHeight: -bmp_h, // 负值 = 自上而下
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (bmp_w * bmp_h * 4) as usize];
        let got = GetDIBits(
            memdc,
            read_bmp,
            0,
            bmp_h as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        let _ = DeleteObject(HGDIOBJ::from(read_bmp));
        let _ = DeleteDC(memdc);
        let _ = ReleaseDC(None, screen);
        if got != bmp_h {
            anyhow::bail!("读取像素失败（GetDIBits 返回 {got}/{bmp_h} 行）");
        }
        // GDI 不写有效 alpha：全部强制不透明，避免后续按 RGBA 解释时整图透明
        for px in pixels.chunks_exact_mut(4) {
            px[3] = 255;
        }
        Ok(BgraFrame {
            width: bmp_w as u32,
            height: bmp_h as u32,
            pixels,
        })
    }
}

/* ---------- 云端档：视觉大模型 API（跨平台，PNG base64 → chat/completions） ---------- */

/// 云端视觉 OCR 默认模型（免费档；可在「AI 优化」页换任意 vision 模型——
/// 本函数读 ocr 专用覆盖，为空则用免费默认）
const CLOUD_DEFAULT_MODEL: &str = "glm-4.6v-flash";

fn cloud_ocr_region(
    llm: &crate::config::LlmConfig,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> anyhow::Result<Vec<String>> {
    // 云端按 token 计费：限制最长边 1600px 足够识别文字，成本可控
    #[cfg(target_os = "windows")]
    let frame = {
        let scale = (1600.0 / w.max(1) as f64).min(1600.0 / h.max(1) as f64).min(1.0);
        let target = if scale < 1.0 {
            Some((
                ((w as f64 * scale).round() as i32).max(1),
                ((h as f64 * scale).round() as i32).max(1),
            ))
        } else {
            None
        };
        crate::ocr::capture_region_pub(x, y, w, h, target)?
    };
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y, w, h);
        anyhow::bail!("云端截图档当前仅支持 Windows（粘贴图片可跨平台，待 M3）");
    }
    #[cfg(target_os = "windows")]
    {
        // BGRA → PNG base64（image crate 编码）
        let img = image::RgbaImage::from_raw(frame.width, frame.height, {
            let mut rgba = frame.pixels.clone();
            for px in rgba.chunks_exact_mut(4) {
                px.swap(0, 2); // BGRA → RGBA
            }
            rgba
        })
        .ok_or_else(|| anyhow::anyhow!("像素缓冲尺寸异常"))?;
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|e| anyhow::anyhow!("PNG 编码失败: {e}"))?;
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png);

        let model = if llm.model.trim().is_empty() {
            CLOUD_DEFAULT_MODEL.to_string()
        } else {
            llm.model.trim().to_string()
        };
        let url = format!(
            "{}/chat/completions",
            llm.base_url.trim().trim_end_matches('/')
        );
        let body = serde_json::json!({
            "model": model,
            "temperature": 0.1,
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{b64}") } },
                    { "type": "text", "text": "识别图片中的全部文字，按阅读顺序输出纯文本，保留自然换行；不要解释、不要加标注；没有文字则输出空字符串。" }
                ]
            }]
        });
        // 共享阻塞客户端（连接复用）；60s 超时按请求覆盖默认的 2s 探测超时
        let client = &*crate::http::CLIENT_BLOCKING;
        let mut req = client
            .post(&url)
            .timeout(Duration::from_secs(60))
            .json(&body);
        if !llm.api_key.trim().is_empty() {
            req = req.bearer_auth(llm.api_key.trim());
        }
        let resp = req.send().map_err(|e| anyhow::anyhow!("云端 OCR 请求失败: {e}"))?;
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("云端 OCR HTTP {status}: {}", text.chars().take(160).collect::<String>());
        }
        let v: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| anyhow::anyhow!("云端 OCR 响应不是 JSON"))?;
        let out = v
            .pointer("/choices/0/message/content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if out.is_empty() {
            anyhow::bail!("云端未识别到文字");
        }
        Ok(out.lines().map(String::from).collect())
    }
}

/// 供云端档（跨平台函数体）使用的截屏出口
#[cfg(target_os = "windows")]
pub(crate) fn capture_region_pub(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    target: Option<(i32, i32)>,
) -> anyhow::Result<BgraFrame> {
    capture_region(x, y, w, h, target)
}

/// 截取指定物理像素区域并编码为 PNG base64（截图框选放大镜的数据源）。
/// 返回 (base64, 宽, 高)。区域取自屏幕实时内容——调用时机在选区层起笔时，
/// 层上尚无任何已绘制元素，不会把框选 UI 自己拍进去
#[cfg(target_os = "windows")]
pub(crate) fn screen_source(x: i32, y: i32, w: i32, h: i32) -> anyhow::Result<(String, u32, u32)> {
    // 不带 CAPTUREBLT：把选区窗自身（遮罩/准线/横幅）排除在底图之外
    let frame = capture_region_opts(x, y, w, h, None, false)?;
    let img = image::RgbaImage::from_raw(frame.width, frame.height, {
        let mut rgba = frame.pixels.clone();
        for px in rgba.chunks_exact_mut(4) {
            px.swap(0, 2); // BGRA → RGBA
        }
        rgba
    })
    .ok_or_else(|| anyhow::anyhow!("像素缓冲尺寸异常"))?;
    let (width, height) = (img.width(), img.height());
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| anyhow::anyhow!("PNG 编码失败: {e}"))?;
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png);
    Ok((b64, width, height))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn screen_source(_x: i32, _y: i32, _w: i32, _h: i32) -> anyhow::Result<(String, u32, u32)> {
    anyhow::bail!("截图放大镜当前仅支持 Windows")
}

/* ---------- PP-OCRv5 质量档（oar-ocr + ModelScope 模型，约 21MB） ---------- */


/// 本地质量档模型 id（模型目录名 / LocalModelStatus.id / 下载命令标识）
#[cfg(target_os = "windows")]
pub const PPOCR_ID: &str = "ppocr-v5-mobile";

/// 必需文件：det / rec / 字典。ModelScope 国内直连（无需镜像），URL 已逐一核验
#[cfg(target_os = "windows")]
const PPOCR_FILES: &[(&str, &str)] = &[
    (
        "ch_PP-OCRv5_det_mobile.onnx",
        "https://modelscope.cn/models/RapidAI/RapidOCR/resolve/master/onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx",
    ),
    (
        "ch_PP-OCRv5_rec_mobile.onnx",
        "https://modelscope.cn/models/RapidAI/RapidOCR/resolve/master/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile.onnx",
    ),
    (
        "ppocrv5_dict.txt",
        "https://modelscope.cn/models/RapidAI/RapidOCR/resolve/master/paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile/ppocrv5_dict.txt",
    ),
];

#[cfg(target_os = "windows")]
fn ppocr_dir(app: &AppHandle) -> anyhow::Result<std::path::PathBuf> {
    Ok(crate::local_whisper::models_root(app)?.join(PPOCR_ID))
}

#[cfg(target_os = "windows")]
pub fn ppocr_files_ok(app: &AppHandle) -> bool {
    let Ok(dir) = ppocr_dir(app) else { return false };
    PPOCR_FILES.iter().all(|(f, _)| {
        dir.join(f)
            .metadata()
            .map(|m| m.len() > 0)
            .unwrap_or(false)
    })
}

#[cfg(target_os = "windows")]
pub fn ppocr_status(app: &AppHandle) -> crate::local_whisper::LocalModelStatus {
    crate::local_whisper::LocalModelStatus {
        id: PPOCR_ID.into(),
        name: "PP-OCRv5 中文质量档（截图取词）".into(),
        desc: "检测+识别全套约 21MB，中文准确率高于系统引擎，离线推理零上传".into(),
        size_mb: 21,
        downloaded: ppocr_files_ok(app),
        kind: Some("ppocr".into()),
        runtime_ready: Some(true),
        backend: None,
    }
}

#[cfg(target_os = "windows")]
static PPOCR_DOWNLOADING: AtomicBool = AtomicBool::new(false);

/// 下载质量档模型（进度经 sn-model-progress 事件推送，与本地 ASR 模型同协议）
#[cfg(target_os = "windows")]
pub async fn ppocr_download(app: &AppHandle) -> anyhow::Result<()> {
    use tauri::Emitter;
    if PPOCR_DOWNLOADING.swap(true, Ordering::SeqCst) {
        anyhow::bail!("已有下载任务进行中");
    }
    struct ResetOnDrop<'a>(&'a AtomicBool);
    impl Drop for ResetOnDrop<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _reset = ResetOnDrop(&PPOCR_DOWNLOADING);

    let dir = ppocr_dir(app)?;
    std::fs::create_dir_all(&dir)?;
    let emit_app = app.clone();
    let progress = move |file: &str, dl: u64, total: u64| {
        let _ = emit_app.emit(
            "sn-model-progress",
            serde_json::json!({
                "model": PPOCR_ID,
                "file": file,
                "downloaded": dl,
                "total": total,
            }),
        );
    };

    let client = reqwest::Client::builder()
        // ModelScope 直连需要浏览器 UA（无 UA 一律 403，返回 311 字节 HTML）
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36")
        .timeout(Duration::from_secs(300))
        .build()?;
    for (file, url) in PPOCR_FILES {
        let dest = dir.join(file);
        if dest.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            continue; // 断点续装：已有文件跳过
        }
        let resp = client.get(*url).send().await?.error_for_status()?;
        let total = resp.content_length().unwrap_or(0);
        let part = dest.with_extension("part");
        let mut file_out = tokio::fs::File::create(&part).await?;
        use tokio::io::AsyncWriteExt;
        let mut resp = resp;
        let mut downloaded: u64 = 0;
        while let Some(chunk) = resp.chunk().await? {
            file_out.write_all(&chunk).await?;
            downloaded += chunk.len() as u64;
            progress(file, downloaded, total);
        }
        file_out.flush().await?;
        drop(file_out);
        if downloaded == 0 {
            anyhow::bail!("下载内容为空：{file}");
        }
        tokio::fs::rename(&part, &dest).await?;
    }
    // 模型文件集变化：丢弃旧引擎实例（下次识别按新文件重建）
    ppocr_unload();
    let _ = app.emit("sn-models-changed", ());
    Ok(())
}

#[cfg(target_os = "windows")]
static PPOCR_ENGINE: std::sync::LazyLock<std::sync::Mutex<Option<oar_ocr::oarocr::OAROCR>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

#[cfg(target_os = "windows")]
pub fn ppocr_unload() {
    *PPOCR_ENGINE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

/// 惰性构建引擎（首次识别时加载三模型，此后常驻）
#[cfg(target_os = "windows")]
fn ppocr_ensure_engine(app: &AppHandle) -> anyhow::Result<()> {
    let mut guard = PPOCR_ENGINE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if guard.is_some() {
        return Ok(());
    }
    if !ppocr_files_ok(app) {
        anyhow::bail!("PP-OCR 质量档模型未下载：请在「截图取词」页下载（约 21MB），或把引擎切回「系统内置」");
    }
    let dir = ppocr_dir(app)?;
    let ocr = oar_ocr::oarocr::OAROCRBuilder::new(
        dir.join("ch_PP-OCRv5_det_mobile.onnx"),
        dir.join("ch_PP-OCRv5_rec_mobile.onnx"),
        dir.join("ppocrv5_dict.txt"),
    )
    .build()
    .map_err(|e| anyhow::anyhow!("PP-OCR 引擎初始化失败: {e}"))?;
    *guard = Some(ocr);
    Ok(())
}

/// 质量档识别：截屏 → RgbImage → oar-ocr（det+rec）→ 按坐标排序的行文本
#[cfg(target_os = "windows")]
fn ppocr_region(app: &AppHandle, x: i32, y: i32, w: i32, h: i32) -> anyhow::Result<Vec<String>> {
    ppocr_ensure_engine(app)?;
    // 质量档自带 max_side_len 缩放，按原始物理像素截取即可
    let frame = capture_region(x, y, w, h, None)?;
    let img = image::RgbImage::from_fn(frame.width, frame.height, |px, py| {
        let i = ((py as usize * frame.width as usize) + px as usize) * 4;
        // BGRA → RGB
        image::Rgb([frame.pixels[i + 2], frame.pixels[i + 1], frame.pixels[i]])
    });
    let guard = PPOCR_ENGINE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let engine = guard.as_ref().expect("引擎已在上文构建");
    let results = engine
        .predict(vec![img])
        .map_err(|e| anyhow::anyhow!("PP-OCR 识别失败: {e}"))?;
    let Some(result) = results.into_iter().next() else {
        return Ok(Vec::new());
    };
    // 按坐标重排为阅读顺序（先按 y 分带再按 x），DB 检测的返回顺序不保证
    let mut rows: Vec<(f32, f32, String)> = result
        .recognized_text_regions()
        .filter_map(|r| {
            let text = r.text.as_ref().map(|s| s.to_string())?;
            // BoundingBox 是四角点集：取 min y / min x 作排序键
            let (mut top, mut left) = (f32::MAX, f32::MAX);
            for p in &r.bounding_box.points {
                top = top.min(p.y);
                left = left.min(p.x);
            }
            Some((top, left, text))
        })
        .collect();
    rows.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
    });
    Ok(rows.into_iter().map(|(_, _, t)| t).collect())
}

/// Windows OCR 会在中日韩字符间插半角空格（旧版行为，部分版本已修）：
/// 剔除两侧都是 CJK 字符的空格，词间拉丁空格保留
#[cfg(target_os = "windows")]
fn strip_cjk_spaces(s: &str) -> String {    fn is_cjk(c: char) -> bool {
        // 0x2e80..=0x9fff 已含日文假名区段（0x3040-0x30ff）
        matches!(c as u32, 0x2e80..=0x9fff | 0xff00..=0xffef | 0x2018..=0x201f)
    }
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == ' '
            && i > 0
            && chars.get(i + 1).is_some_and(|&n| is_cjk(n))
            && is_cjk(chars[i - 1])
        {
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(all(target_os = "windows", test))]
mod tests {
    use super::strip_cjk_spaces;

    #[test]
    fn strips_inner_cjk_spaces_only() {
        assert_eq!(strip_cjk_spaces("你好 世 界"), "你好世界");
        assert_eq!(strip_cjk_spaces("hello world"), "hello world");
        assert_eq!(
            strip_cjk_spaces("中文 and English 混排"),
            "中文 and English 混排"
        );
    }

    /// 实机冒烟：GDI 截屏 → Buffer 互操作 → Windows.Media.Ocr 全链路。
    /// 需要交互式桌面会话（CI/无头环境不可用），故 #[ignore]，
    /// 本地验证：cargo test --lib ocr -- --ignored --nocapture
    #[test]
    #[ignore]
    fn win_ocr_smoke() {
        let frame = super::capture_region(80, 80, 800, 400, None).expect("GDI 截屏失败");
        assert!(frame.width == 800 && frame.height == 400, "尺寸不符");
        assert!(frame.pixels.len() == 800 * 400 * 4);
        // alpha 已强制 255
        assert!(frame.pixels.chunks_exact(4).all(|p| p[3] == 255));
        // 亮度统计（桌面被锁定/纯黑区域时全 0 属正常，不作硬断言）
        let luma: u64 = frame
            .pixels
            .chunks_exact(4)
            .map(|p| (p[0] as u64 + p[1] as u64 + p[2] as u64) / 3)
            .sum();
        println!("截屏亮度总和: {luma}");

        // 引擎创建 + 识别（识别内容取决于屏幕，只验证不 panic、结构合法）
        let langs = super::available_language_tags().expect("枚举语言包失败");
        println!("可用语言包: {langs:?}");
        if langs.is_empty() {
            println!("（无语言包，跳过识别段）");
            return;
        }
        let lines = super::win_ocr_region("auto", 80, 80, 800, 400).expect("识别失败");
        println!("识别行数: {} -> {lines:?}", lines.len());
    }

    /// PP-OCR 质量档实机冒烟：ModelScope 下载模型（约 21MB，缺啥补啥）→
    /// 构建引擎 → 识别屏幕区域。需要交互式桌面 + 网络，故 #[ignore]，
    /// 本地验证：cargo test --lib ppocr_smoke -- --ignored --nocapture
    #[test]
    #[ignore]
    fn ppocr_smoke() {
        let dir = std::env::temp_dir().join("ppocr-ocr-test");
        std::fs::create_dir_all(&dir).unwrap();
        for (file, url) in super::PPOCR_FILES {
            let dest = dir.join(file);
            if dest.metadata().map(|m| m.len() > 0).unwrap_or(false) {
                continue;
            }
            println!("下载 {file} …");
            let client = reqwest::blocking::Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36")
                .build()
                .unwrap();
            let mut resp = client.get(*url).send().unwrap();
            let mut buf = Vec::new();
            resp.copy_to(&mut buf).unwrap();
            std::fs::write(&dest, &buf).unwrap();
        }
        let ocr = oar_ocr::oarocr::OAROCRBuilder::new(
            dir.join("ch_PP-OCRv5_det_mobile.onnx"),
            dir.join("ch_PP-OCRv5_rec_mobile.onnx"),
            dir.join("ppocrv5_dict.txt"),
        )
        .build()
        .expect("构建 PP-OCR 引擎失败");
        let frame = super::capture_region(80, 80, 800, 400, None).expect("截屏失败");
        let img = image::RgbImage::from_fn(frame.width, frame.height, |x, y| {
            let i = ((y as usize * frame.width as usize) + x as usize) * 4;
            image::Rgb([frame.pixels[i + 2], frame.pixels[i + 1], frame.pixels[i]])
        });
        let t0 = std::time::Instant::now();
        let results = ocr.predict(vec![img]).expect("识别失败");
        let ms = t0.elapsed().as_millis();
        for r in &results {
            for region in r.recognized_text_regions() {
                println!("  [conf={:.2}] {}", region.confidence.unwrap_or(0.0), region.text.as_deref().unwrap_or(""));
            }
        }
        println!("PP-OCR 识别耗时: {ms}ms");
    }
}
