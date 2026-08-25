// 防止 Windows 上发布版额外弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebView2 会缓存 tauri:// 页面：升级 exe 后旧 overlay.html 可能被缓存复活（白框回归）。
    // 禁用 HTTP 磁盘缓存，保证每次都用内嵌的最新前端。
    #[cfg(target_os = "windows")]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disk-cache-size=1",
    );
    speaknow_lib::run()
}
