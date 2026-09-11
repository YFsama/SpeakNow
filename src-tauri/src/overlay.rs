use tauri::{AppHandle, Manager};

const OVERLAY_LABEL: &str = "overlay";
/// 悬浮窗基准逻辑尺寸。比卡片（500px）宽 60px，给两侧阴影各留 30px 完整渐隐空间，
/// 避免阴影被透明窗口的矩形边界硬切出锐利断层
const OVERLAY_W: f64 = 560.0;
const OVERLAY_H: f64 = 320.0;

fn mouse_location() -> Option<(i32, i32)> {
    use enigo::{Enigo, Mouse, Settings};
    Enigo::new(&Settings::default()).ok()?.location().ok()
}

/// 界面缩放后的实际窗口逻辑尺寸：前端用 body.zoom 缩放卡片并同步放大窗口，
/// 定位与工作区夹紧必须按放大后的尺寸计算，否则大缩放下卡片会越出屏幕
fn overlay_size(app: &AppHandle) -> (f64, f64) {
    let scale = app
        .state::<crate::Ctx>()
        .config
        .lock()
        .ok()
        .and_then(|c| c.as_ref().map(|c| f64::from(c.general.font_scale)))
        .filter(|s| (0.5..=2.0).contains(s))
        .unwrap_or(1.0);
    (OVERLAY_W * scale, OVERLAY_H * scale)
}

/// 显示状态悬浮窗（不抢占焦点）。定位优先级：
/// 手动拖拽位置（本会话） → 光标/输入框锚点 → 前台窗口所在屏底部 → 鼠标所在屏底部 → 主屏底部
pub fn show(app: &AppHandle) {
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    let _ = win.set_always_on_top(true);

    // 用户拖动过：保持当前位置
    if app
        .state::<crate::Ctx>()
        .overlay_manual
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        let _ = win.show();
        return;
    }

    // 优先：贴近正在输入的输入框（ZCode/Codex 等聊天式输入框上方）
    let (ov_w, ov_h) = overlay_size(app);
    if let Some(((x, y, above), title)) = crate::caret::overlay_position(ov_w, ov_h) {
        let _ = win.set_position(tauri::PhysicalPosition::new(
            x.round() as i32,
            y.round() as i32,
        ));
        let _ = crate::events::emit(
            app,
            "sn-target",
            serde_json::json!({
                "title": truncate_title(&title),
                "above": above,
            }),
        );
        let _ = win.show();
        return;
    }

    // 回退：前台窗口所在显示器底部居中。双屏场景鼠标常停在另一块屏上，
    // 按鼠标定位会把卡片弹到用户没在看的显示器（表现为「提示音正常但框不弹」）
    if let Some(((wx, wy, ww, wh), scale)) = crate::caret::foreground_monitor_work_area() {
        let w = ov_w * scale;
        let h = ov_h * scale;
        let x = wx + ((ww - w) / 2.0).max(0.0);
        let y = wy + (wh - h - 110.0 * scale).max(0.0);
        let _ = win.set_position(tauri::PhysicalPosition::new(
            x.round() as i32,
            y.round() as i32,
        ));
        let _ = win.show();
        return;
    }

    let mut screen: Option<(f64, f64)> = None;
    // 鼠标所在显示器优先
    if let Some((mx, my)) = mouse_location() {
        if let Ok(monitors) = win.available_monitors() {
            for mon in monitors {
                let pos = mon.position();
                let size = mon.size();
                if mx >= pos.x
                    && mx < pos.x + size.width as i32
                    && my >= pos.y
                    && my < pos.y + size.height as i32
                {
                    let scale = mon.scale_factor();
                    let s = size.to_logical::<f64>(scale);
                    screen = Some((s.width, s.height));
                    break;
                }
            }
        }
    }
    // 回退：主显示器
    if screen.is_none() {
        if let Ok(Some(mon)) = win.primary_monitor() {
            let scale = mon.scale_factor();
            let s = mon.size().to_logical::<f64>(scale);
            screen = Some((s.width, s.height));
        }
    }
    if let Some((sw, sh)) = screen {
        let x = ((sw - ov_w) / 2.0).max(0.0);
        let y = (sh - ov_h - 110.0).max(0.0);
        let _ = win.set_position(tauri::LogicalPosition::new(x, y));
    }
    let _ = win.show();
}

fn truncate_title(t: &str) -> String {
    let n = t.chars().count();
    if n <= 24 {
        t.to_string()
    } else {
        t.chars().take(24).collect::<String>() + "…"
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = win.hide();
    }
}

/// 预览编辑模式：显示并聚焦悬浮窗（用户需要打字编辑）
pub fn show_review(app: &AppHandle) {
    show(app);
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = win.set_focus();
    }
}
