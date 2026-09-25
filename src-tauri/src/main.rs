// 防止 Windows 上发布版额外弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebView2 会缓存 tauri:// 页面：升级 exe 后旧 overlay.html 可能被缓存复活（白框回归）。
    // 禁用 HTTP 磁盘缓存，保证每次都用内嵌的最新前端。追加而非覆盖用户
    // 已设置的 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS（如显卡开关等调试参数）
    #[cfg(target_os = "windows")]
    {
        let extra = "--disk-cache-size=1";
        let merged = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
            Ok(mut existing) if !existing.trim().is_empty() => {
                if existing.contains(extra) {
                    existing
                } else {
                    existing.push(' ');
                    existing.push_str(extra);
                    existing
                }
            }
            _ => extra.to_string(),
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
    }
    speaknow_lib::run()
}
