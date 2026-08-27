use tauri::{AppHandle, Emitter};

/// 统一事件出口：本地 Tauri 事件（悬浮窗 / 设置页）+ 外接显示 API 广播，一份代码两路分发。
/// 事件名沿用 sn-*；外接侧封装为 {v, type, data, ts} 信封（见 display_api）。
/// 仅字幕链路事件走这里；纯本机 UI 事件（sn-config-changed、sn-mic-level 等）仍直接 app.emit。
pub fn emit(app: &AppHandle, name: &str, payload: serde_json::Value) {
    let _ = app.emit(name, payload.clone());
    crate::display_api::publish(name, &payload);
}
