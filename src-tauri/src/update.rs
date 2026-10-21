//! GitHub Release 自动更新：检查版本（GitHub API）→ 下载平台安装包到临时
//! 目录 → 拉起安装器并退出应用完成覆盖安装（NSIS 覆盖安装不动 app_config_dir
//! 里的用户配置，Key 与历史无损）。
//!
//! 为什么不用 tauri-plugin-updater：它要求 minisign 签名密钥对（私钥进 CI
//! Secrets、公钥烧进 tauri.conf.json），而现有发布流水线没有签名基础设施；
//! 自研检查/下载对 CI 零改动，且只从本仓库官方 Release 取包，加上 URL /
//! 路径双重白名单校验，不会成为「下载并运行任意 exe」的口子。
//!
//! 安全边界：
//! - 下载 URL 必须是 https://github.com/YFsama/SpeakNow/releases/download/…
//!   （重定向到 CDN 由 reqwest 自动跟随，起始 URL 锁死官方仓库）
//! - install_update 只接受临时目录 speaknow-update 子树下的 .exe/.dmg
//! - 打开发布页只接受 https://github.com 前缀

use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;
use tauri::AppHandle;
use tauri::Emitter;

use crate::http;

const RELEASES_API: &str = "https://api.github.com/repos/YFsama/SpeakNow/releases/latest";
const DOWNLOAD_PREFIX: &str = "https://github.com/YFsama/SpeakNow/releases/download/";

/// 检查结果（前端展示用；downloadUrl 为空表示本平台没有对应安装包）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub tag: String,
    pub update_available: bool,
    /// Release 说明（markdown 原文，前端按行展示）
    pub notes: String,
    pub download_url: String,
    pub asset_size: u64,
    /// Release 创建时间（GitHub ISO8601 原文）
    pub published_at: String,
    pub html_url: String,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    body: Option<String>,
    html_url: Option<String>,
    published_at: Option<String>,
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: Option<u64>,
}

/// 本平台安装包在 Release assets 里的文件名后缀（与 CI 产物名一致：
/// Windows `…-x64-setup.exe`、macOS `…-aarch64.dmg`）
#[cfg(target_os = "windows")]
fn asset_suffix() -> &'static str {
    "x64-setup.exe"
}
#[cfg(not(target_os = "windows"))]
fn asset_suffix() -> &'static str {
    ".dmg"
}

/// 解析版本号为数字段：去掉 v 前缀按 . 切分；段内含非数字（如 0.4.10-beta）
/// 时把该段的数字前缀当值（1.0.0a → [1,0,0]），保证比较永不出错
fn parse_ver(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split('.')
        .map(|seg| {
            let digits: String = seg.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse().unwrap_or(0)
        })
        .collect()
}

/// latest 是否严格新于 current（逐段数值比较，避免 "0.4.9" > "0.4.10" 的
/// 字符串序陷阱；段数不足按 0 补齐，1.2 == 1.2.0）
pub fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (parse_ver(latest), parse_ver(current));
    let n = a.len().max(b.len());
    for i in 0..n {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

#[tauri::command]
pub async fn check_update() -> Result<UpdateInfo, String> {
    let resp = http::CLIENT
        .get(RELEASES_API)
        // GitHub API 硬性要求 User-Agent；无 token 限额 60 次/时，启动检查一次足够
        .header("User-Agent", concat!("SpeakNow/", env!("CARGO_PKG_VERSION")))
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    if !resp.status().is_success() {
        // 403 多为限流：提示稍后再试而不是报一串 JSON
        return Err(format!("GitHub 返回 {}", resp.status()));
    }
    let rel: GhRelease = resp
        .json()
        .await
        .map_err(|e| format!("解析 Release 信息失败：{e}"))?;
    let asset = rel
        .assets
        .iter()
        .find(|a| a.name.ends_with(asset_suffix()))
        // 平台精确产物缺席时兜底任一安装包资产（发布产物改名不至于查不到更新）
        .or_else(|| {
            rel.assets
                .iter()
                .find(|a| a.name.ends_with(".exe") || a.name.ends_with(".dmg"))
        });
    let current = env!("CARGO_PKG_VERSION").to_string();
    let tag = rel.tag_name.trim().to_string();
    let latest = tag.trim_start_matches('v').to_string();
    let html_url = rel.html_url.clone().unwrap_or_else(|| {
        format!("https://github.com/YFsama/SpeakNow/releases/tag/{tag}")
    });
    Ok(UpdateInfo {
        update_available: is_newer(&latest, &current),
        current,
        latest,
        tag,
        notes: rel.body.clone().unwrap_or_default(),
        download_url: asset.map(|a| a.browser_download_url.clone()).unwrap_or_default(),
        asset_size: asset.and_then(|a| a.size).unwrap_or(0),
        published_at: rel.published_at.clone().unwrap_or_default(),
        html_url,
    })
}

/// 下载 URL 白名单：锁死本仓库官方 Release 路径。asset 来自 check_update
/// 的返回，但前端 invoke 参数可被任意构造，必须服务端再验一次
fn validate_download_url(u: &str) -> Result<(), String> {
    if u.starts_with(DOWNLOAD_PREFIX) && u.len() > DOWNLOAD_PREFIX.len() {
        Ok(())
    } else {
        Err("下载地址非法（仅允许本仓库 GitHub Release）".into())
    }
}

/// 更新包落盘目录：临时目录下固定子目录（install_update 只认这里）
fn update_root() -> PathBuf {
    std::env::temp_dir().join("speaknow-update")
}

#[tauri::command]
pub async fn download_update(app: AppHandle, url: String) -> Result<String, String> {
    validate_download_url(&url)?;
    let filename = url
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty() && s.len() < 200)
        .ok_or("无法从 URL 提取文件名")?
        .to_string();
    let root = update_root();
    std::fs::create_dir_all(&root).map_err(|e| format!("创建下载目录失败：{e}"))?;
    // 清掉上一次的残留安装包，临时目录不会越积越多
    if let Ok(entries) = std::fs::read_dir(&root) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "exe" || x == "dmg") {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    let dest = root.join(&filename);

    // 流式下载 + 进度事件。超时放宽到 30 分钟（安装包几十 MB、慢网不中断）；
    // 进度节流：至少间隔 250ms 或收满 1MB 才发一帧，避免万级事件刷爆前端
    let mut resp = http::CLIENT
        .get(&url)
        .header("User-Agent", concat!("SpeakNow/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(1800))
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：GitHub 返回 {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&dest).map_err(|e| format!("创建文件失败：{e}"))?;
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut last_bytes = downloaded;
    let emit = |downloaded: u64| {
        let _ = app.emit(
            "sn-update-progress",
            serde_json::json!({ "downloaded": downloaded, "total": total }),
        );
    };
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("下载中断：{e}"))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("写入失败：{e}（磁盘空间不足？）"))?;
        downloaded += chunk.len() as u64;
        let now = std::time::Instant::now();
        if now.duration_since(last_emit) >= Duration::from_millis(250)
            || downloaded - last_bytes >= 1024 * 1024
        {
            emit(downloaded);
            last_emit = now;
            last_bytes = downloaded;
        }
    }
    emit(downloaded);
    file.flush().map_err(|e| format!("写入失败：{e}"))?;
    Ok(dest.display().to_string())
}

/// 安装路径白名单：必须位于 update_root() 子树内且扩展名正确。
/// canonicalize 消掉 ..\ 与符号链接后再比前缀，防止路径穿越
fn validate_install_path(p: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(p);
    if !path.is_absolute() {
        return Err("路径非法".into());
    }
    let canon = path
        .canonicalize()
        .map_err(|_| "安装文件不存在（下载目录被清理？请重新下载）".to_string())?;
    let root = update_root()
        .canonicalize()
        .map_err(|e| format!("定位下载目录失败：{e}"))?;
    if !canon.starts_with(&root) {
        return Err("路径非法（仅允许运行下载的安装包）".into());
    }
    #[cfg(target_os = "windows")]
    {
        if canon.extension().and_then(|x| x.to_str()) != Some("exe") {
            return Err("路径非法（Windows 更新包应为 .exe）".into());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if canon.extension().and_then(|x| x.to_str()) != Some("dmg") {
            return Err("路径非法（macOS 更新包应为 .dmg）".into());
        }
    }
    Ok(canon)
}

/// 拉起安装器并退出应用：Windows 直接运行 NSIS 安装器（覆盖安装，向导式
/// 两三步）；macOS 打开 dmg 由用户拖入 Applications。先 spawn 再 exit，
/// 与官方 tauri-plugin-updater 同序——进程退出收尾（配置落盘、llama-server
/// 回收）走既有 RunEvent::Exit 钩子
#[tauri::command]
pub fn install_update(app: AppHandle, path: String) -> Result<(), String> {
    let canon = validate_install_path(&path)?;
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new(&canon);
        c.current_dir(update_root());
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&canon);
        c
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = {
        let _ = &canon;
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&canon);
        c
    };
    cmd.spawn().map_err(|e| format!("启动安装器失败：{e}"))?;
    app.exit(0);
    Ok(())
}

/// 在系统浏览器打开发布页（更新面板「查看发布页」用）。只放行 github.com，
/// 与 open_display_page 的私网白名单同理：invoke 参数可被构造
#[tauri::command]
pub fn open_release_page(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/") {
        return Err("仅允许打开 GitHub 页面".into());
    }
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map_err(|e| format!("打开失败: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare_numeric_not_lexicographic() {
        // 字符串序会把 0.4.9 判成大于 0.4.10，必须数值比较
        assert!(is_newer("0.4.10", "0.4.9"));
        assert!(!is_newer("0.4.9", "0.4.10"));
        assert!(is_newer("v0.5.0", "0.4.10"));
        assert!(is_newer("1.0.0", "0.9.99"));
        assert!(!is_newer("0.4.10", "0.4.10"));
        assert!(!is_newer("0.4.10", "v0.4.11"));
        // 段数不等：右侧按 0 补齐
        assert!(is_newer("1.2.1", "1.2"));
        assert!(!is_newer("1.2", "1.2.0"));
        // 预发布后缀不 panic，按数字前缀参与比较
        assert!(is_newer("0.5.0-beta", "0.4.10"));
    }

    #[test]
    fn download_url_whitelist() {
        assert!(validate_download_url(concat!(
            "https://github.com/YFsama/SpeakNow/releases/download/",
            "v0.5.0/SpeakNow_0.5.0_x64-setup.exe"
        ))
        .is_ok());
        // 仿冒域名 / 其他仓库 / 裸前缀一律拒绝
        assert!(validate_download_url("https://evil.com/a.exe").is_err());
        assert!(
            validate_download_url("https://github.com/other/repo/releases/download/v1/a.exe")
                .is_err()
        );
        assert!(validate_download_url(DOWNLOAD_PREFIX).is_err());
        assert!(validate_download_url("http://github.com/YFsama/SpeakNow/releases/download/v1/a.exe").is_err());
    }
}
