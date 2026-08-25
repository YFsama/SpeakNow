use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::pipeline;

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let record = MenuItem::with_id(app, "record", "开始 / 停止录音", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "打开设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 SpeakNow", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&record, &show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("speaknow-tray")
        .tooltip("SpeakNow 语音输入")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "record" => pipeline::toggle(app, false),
            "show" => open_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn open_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}
