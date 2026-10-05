use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::pipeline;

/// 听写模式候选（托盘快切用）
const MODES: &[(&str, &str)] = &[
    ("correct", "仅纠错"),
    ("polish", "纠错 + 润色"),
    ("prompt", "编程指令"),
    ("translate", "翻译模式"),
];

fn current_config(app: &AppHandle) -> crate::config::Config {
    app.state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .unwrap_or_default()
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let record = MenuItem::with_id(app, "record", "开始 / 停止录音", true, None::<&str>)?;
    // 快速录音：显式入口跳过 AI 优化（不用先去设置页配第二快捷键）
    let record_quick =
        MenuItem::with_id(app, "record_quick", "快速录音（跳过 AI）", true, None::<&str>)?;
    let translate_sel =
        MenuItem::with_id(app, "translate_sel", "划词翻译选中文字", true, None::<&str>)?;
    let ocr_item = MenuItem::with_id(app, "ocr", "截图取词（框选识别）", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "打开设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 SpeakNow", true, None::<&str>)?;

    let cfg = current_config(app);
    // 听写模式快切：● 标记当前模式（设置页可改更细的选项）
    let mut mode_items = Vec::new();
    for (id, label) in MODES {
        let mark = if cfg.llm.mode == *id { "● " } else { "　" };
        mode_items.push(MenuItem::with_id(
            app,
            format!("mode:{id}"),
            format!("{mark}{label}"),
            true,
            None::<&str>,
        )?);
    }
    let mode_menu = Submenu::with_id_and_items(
        app,
        "modes",
        "听写模式",
        true,
        &mode_items
            .iter()
            .map(|i| i as &dyn tauri::menu::IsMenuItem<Wry>)
            .collect::<Vec<_>>(),
    )?;
    // 翻译目标语言快切：不进设置页即可切换「说中文出英文 / 出日文…」
    let mut lang_items = Vec::new();
    for (code, name) in crate::config::TRANSLATE_LANGS {
        let mark = if cfg.llm.translate_target == *code {
            "● "
        } else {
            "　"
        };
        lang_items.push(MenuItem::with_id(
            app,
            format!("lang:{code}"),
            format!("{mark}{name}"),
            true,
            None::<&str>,
        )?);
    }
    let lang_menu = Submenu::with_id_and_items(
        app,
        "langs",
        "翻译为",
        true,
        &lang_items
            .iter()
            .map(|i| i as &dyn tauri::menu::IsMenuItem<Wry>)
            .collect::<Vec<_>>(),
    )?;

    // 预览编辑快切：☑ 跟随配置勾选状态，与模式/语言同为持久配置项
    let review = CheckMenuItem::with_id(
        app,
        "review",
        "输入前确认（预览编辑）",
        true,
        cfg.output.review,
        None::<&str>,
    )?;

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[&record, &record_quick, &translate_sel, &ocr_item, &show, &sep1, &mode_menu, &lang_menu, &review, &sep2, &quit],
    )
}

/// 重建托盘菜单（模式/翻译目标的 ● 标记随配置变化）。托盘自身与设置页
/// 保存路径都会调用；菜单构建必须在主线程，由调用方派发。
pub fn rebuild_menu(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("speaknow-tray") {
        match build_menu(app) {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
            }
            Err(e) => eprintln!("[speaknow] 重建托盘菜单失败: {e}"),
        }
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id("speaknow-tray")
        .tooltip("SpeakNow 语音输入")
        .menu(&menu)
        .on_menu_event(handle_menu_event);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref().to_string();
    match id.as_str() {
        "record" => pipeline::post_toggle(app, false, false),
        "record_quick" => pipeline::post_start(app, true, false),
        "translate_sel" => {
            // 取词含按键模拟与剪贴板轮询（阻塞），放独立线程；托盘菜单收起后
            // 焦点回到原窗口，选区仍在即可取词
            let h = app.clone();
            std::thread::spawn(move || crate::translate::translate_selection(&h));
        }
        "ocr" => crate::ocr::start_capture(app),
        "show" => open_main_window(app),
        "quit" => app.exit(0),
        // 预览编辑快切：与模式/语言同为持久配置项，落盘 + 通知设置页刷新
        "review" => {
            let mut cfg = current_config(app);
            cfg.output.review = !cfg.output.review;
            if let Err(e) = crate::config::save(app, &cfg) {
                eprintln!("[speaknow] 托盘保存配置失败: {e:#}");
                return;
            }
            *app.state::<crate::Ctx>().config.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(cfg);
            let _ = app.emit("sn-config-changed", ());
            rebuild_menu(app);
        }
        _ => {
            let Some((kind, value)) = id.split_once(':') else {
                return;
            };
            let mut cfg = current_config(app);
            match kind {
                "mode" => {
                    if !MODES.iter().any(|(m, _)| *m == value) {
                        return;
                    }
                    cfg.llm.mode = value.to_string();
                }
                "lang" => {
                    if !crate::config::TRANSLATE_LANGS.iter().any(|(c, _)| *c == value) {
                        return;
                    }
                    cfg.llm.translate_target = value.to_string();
                    // 目标语言切到与第二目标相同：清掉第二目标，避免
                    // 「原文已是 X 则改译成 X」的退化指令
                    if cfg.llm.translate_second_target == value {
                        cfg.llm.translate_second_target.clear();
                    }
                }
                _ => return,
            }
            // 托盘改的是已保存配置的一部分：落盘 + 更新内存 + 通知设置页刷新
            if let Err(e) = crate::config::save(app, &cfg) {
                eprintln!("[speaknow] 托盘保存配置失败: {e:#}");
                return;
            }
            *app.state::<crate::Ctx>().config.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(cfg);
            let _ = app.emit("sn-config-changed", ());
            rebuild_menu(app);
        }
    }
}

pub fn open_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}
