//! GitHub Release 自动更新：检查版本（GitHub API）→ 下载平台安装包到临时
//! 目录（断点续传 + sha256 校验 + 可选镜像加速）→ 拉起安装器并退出应用完成
//! 覆盖安装（NSIS 覆盖安装不动 app_config_dir 里的用户配置，Key 与历史无损）。
//!
//! 为什么不用 tauri-plugin-updater：它要求 minisign 签名密钥对（私钥进 CI
//! Secrets、公钥烧进 tauri.conf.json），而现有发布流水线没有签名基础设施；
//! 自研检查/下载对 CI 零改动，且只从本仓库官方 Release 取包，加上 URL /
//! 路径双重白名单校验与 sha256 digest 比对，不会成为「下载并运行任意 exe」
//! 的口子。
//!
//! 安全边界：
//! - 下载 URL 必须是 https://github.com/YFsama/SpeakNow/releases/download/…
//!   （重定向到 CDN 由 reqwest 自动跟随，起始 URL 锁死官方仓库）
//! - 镜像仅做「前缀 + 官方 URL」拼接，且只在官方提供 sha256 digest 时启用：
//!   镜像返回的内容必须逐字节通过官方摘要校验，否则等价于从任意地址下载
//!   并运行 exe——没有可校验的摘要时一律直连
//! - install_update 只接受临时目录 speaknow-update 子树下的 .exe/.dmg
//! - 打开发布页只接受 https://github.com 前缀

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;

use crate::http;

const RELEASES_API: &str = "https://api.github.com/repos/YFsama/SpeakNow/releases/latest";
const DOWNLOAD_PREFIX: &str = "https://github.com/YFsama/SpeakNow/releases/download/";
/// 免限额预检地址：GET/HEAD 会 302 到 …/releases/tag/<tag>，读 Location
/// 即可拿到最新 tag，不打 GitHub API 限额（无 token 60 次/时）
const RELEASES_LATEST_PAGE: &str = "https://github.com/YFsama/SpeakNow/releases/latest";
/// 下载连接超时（TCP+TLS 握手）。总时长不设限——由相邻 chunk 间的空闲
/// 看门狗接管，慢网传大包不再被一刀切的总额外超时掐断
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 相邻两次 chunk 到达的最大间隔：超过判网络停滞，中断本次（由重试续传）
const IDLE_READ_TIMEOUT: Duration = Duration::from_secs(60);
/// 周期检查基础间隔（6 小时）与抖动幅度（±10 分钟：错峰避开限流高峰）
const CHECK_INTERVAL_SECS: u64 = 6 * 3600;
const CHECK_JITTER_SECS: i64 = 600;
/// 连续检查失败退避的封顶（24 小时）
const BACKOFF_CAP_SECS: u64 = 24 * 3600;

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

/// 下载时对资产的期望值（来自最近一次 check_update）：落盘后按此校验
/// size 与 sha256，防止镜像/网络损坏送来同大小异内容的包
#[derive(Debug, Clone)]
struct AssetExpectation {
    url: String,
    /// API asset.size；0 = 未知（跳过大小比对）
    size: u64,
    /// 已归一化的 sha256 hex（小写、无前缀）；None = 官方未提供（降级仅校验大小）
    digest: Option<String>,
}

/// 更新的进程内内存态：下载 single-flight 标志 + 就绪包 + 检查发现。
/// 重启后 .part 文件仍可续传，就绪态靠文件存在与否重建（validate_install_path）
struct UpdateState {
    downloading: bool,
    /// 已下载并校验通过的就绪包：(版本号, 安装包路径)
    ready: Option<(String, PathBuf)>,
    /// 最近一次检查发现的新版本号（无更新时清空；托盘入口展示用）
    last_available: Option<String>,
    /// 最近一次检查的资产期望值（下载时按 URL 匹配消费）
    last_asset: Option<AssetExpectation>,
}

fn lock_state() -> std::sync::MutexGuard<'static, UpdateState> {
    static STATE: LazyLock<Mutex<UpdateState>> = LazyLock::new(|| {
        Mutex::new(UpdateState {
            downloading: false,
            ready: None,
            last_available: None,
            last_asset: None,
        })
    });
    STATE.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 下载专用客户端：连接 15s + 不限总时长（chunk 级空闲看门狗接管读超时）。
/// 共享 http::CLIENT 的兜底总超时 120s 会掐断慢网大包，不能复用
static DL_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .unwrap_or_else(|e| {
            eprintln!("[speaknow] 下载客户端构建失败，退回默认客户端: {e}");
            reqwest::Client::default()
        })
});

/// 预检专用客户端：禁跟随重定向才能读到 releases/latest 的 302 Location
static HEAD_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .unwrap_or_else(|e| {
            eprintln!("[speaknow] 预检客户端构建失败，退回默认客户端: {e}");
            reqwest::Client::default()
        })
});

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
    /// GitHub 2025-04 起为 Release 资产提供摘要（形如 "sha256:…"）。旧
    /// Release / 接口同步延迟时缺失 → 降级为仅大小校验并记日志
    digest: Option<String>,
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

fn current_config(app: &AppHandle) -> crate::config::Config {
    app.state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
        .unwrap_or_default()
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let (info, asset) = fetch_latest().await?;
    record_check_result(&app, &info, asset.as_ref());
    Ok(info)
}

/// 网络检查 + 解析（不含状态副作用，供命令与周期线程共用）
async fn fetch_latest() -> Result<(UpdateInfo, Option<AssetExpectation>), String> {
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
    let exp = asset.map(|a| AssetExpectation {
        url: a.browser_download_url.clone(),
        size: a.size.unwrap_or(0),
        digest: a.digest.as_deref().and_then(parse_sha256_digest),
    });
    let current = env!("CARGO_PKG_VERSION").to_string();
    let tag = rel.tag_name.trim().to_string();
    let latest = tag.trim_start_matches('v').to_string();
    let html_url = rel.html_url.clone().unwrap_or_else(|| {
        format!("https://github.com/YFsama/SpeakNow/releases/tag/{tag}")
    });
    Ok((
        UpdateInfo {
            update_available: is_newer(&latest, &current),
            current,
            latest,
            tag,
            notes: rel.body.clone().unwrap_or_default(),
            download_url: asset.map(|a| a.browser_download_url.clone()).unwrap_or_default(),
            asset_size: asset.and_then(|a| a.size).unwrap_or(0),
            published_at: rel.published_at.clone().unwrap_or_default(),
            html_url,
        },
        exp,
    ))
}

/// 记录检查结果（发现版本 / 资产期望值），必要时刷新托盘入口并触发后台预下载
fn record_check_result(app: &AppHandle, info: &UpdateInfo, asset: Option<&AssetExpectation>) {
    let availability_changed = {
        let mut st = lock_state();
        let next = if info.update_available {
            Some(info.latest.clone())
        } else {
            None
        };
        let changed = st.last_available != next;
        st.last_available = next;
        st.last_asset = asset.cloned();
        changed
    };
    if availability_changed {
        poke_tray(app);
    }
    maybe_auto_download(app, info);
}

/// 后台预下载：开关全开且发现新版本（未跳过）时静默下载，失败只记日志
/// （下一轮周期检查会再试）。下载跑在独立线程，不占 tokio 共享池长连接
fn maybe_auto_download(app: &AppHandle, info: &UpdateInfo) {
    if !info.update_available || info.download_url.is_empty() {
        return;
    }
    let cfg = current_config(app);
    // 预下载受 auto_check_update 总开关约束（关掉自动检查 = 完全手动模式）
    if !cfg.general.auto_check_update || !cfg.general.auto_download_update {
        return;
    }
    if cfg.general.skip_version == info.latest {
        return;
    }
    {
        let st = lock_state();
        if st.downloading {
            return;
        }
        // 同版本已就绪（文件还在）才跳过：临时目录被系统清理后允许重下，
        // 否则本进程内永远不会再下载，托盘入口点安装只会报「文件不存在」
        if let Some((v, p)) = &st.ready {
            if *v == info.latest && p.is_file() {
                return;
            }
        }
    }
    let app = app.clone();
    let url = info.download_url.clone();
    std::thread::spawn(move || {
        if let Err(e) = tauri::async_runtime::block_on(download_update_impl(&app, &url)) {
            eprintln!("[speaknow] 更新预下载失败（静默，下轮重试）: {e}");
        }
    });
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
    download_update_impl(&app, &url).await
}

/// 下载主流程（手动命令与后台预下载共用）：single-flight → 断点续传下载 →
/// 校验 → rename → 记就绪态 + 发 sn-update-ready
async fn download_update_impl(app: &AppHandle, url: &str) -> Result<String, String> {
    validate_download_url(url)?;
    let filename = url
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty() && s.len() < 200)
        .ok_or("无法从 URL 提取文件名")?
        .to_string();
    let root = update_root();
    std::fs::create_dir_all(&root).map_err(|e| format!("创建下载目录失败：{e}"))?;
    let dest = root.join(&filename);
    let part = root.join(format!("{filename}.part"));

    {
        let mut st = lock_state();
        // 同名就绪包：不重下（check_update 反复触发预下载、用户反复点下载都命中这里）
        if let Some((_, p)) = &st.ready {
            if *p == dest && p.is_file() {
                return Ok(p.display().to_string());
            }
        }
        if st.downloading {
            return Err("更新包正在下载中，请稍候".into());
        }
        st.downloading = true;
        // 下载目标换版本：旧就绪包作废（文件随下方清理删除）
        st.ready = None;
    }
    // 清残留：历史安装包与其他名字的 .part（含旧版本同名 dest，避免 rename
    // 时与旧文件混淆）。同名 .part 保留——跨进程重启也能续传大包（临时目录
    // 被系统清理则自然从头下载）
    if let Ok(entries) = std::fs::read_dir(&root) {
        for e in entries.flatten() {
            let p = e.path();
            if p == part {
                continue;
            }
            let stale = p
                .extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x == "exe" || x == "dmg" || x == "part");
            if stale {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    // 消费最近一次检查的期望值（URL 必须一致，防止拿 A 版本的摘要校验 B 版本）
    let exp = lock_state().last_asset.clone().filter(|e| e.url == url);
    let result = download_with_retries(app, url, &exp, &part, &dest).await;
    lock_state().downloading = false;
    match result {
        Ok(()) => {
            let ver = version_from_download_url(url).unwrap_or_default();
            lock_state().ready = Some((ver.clone(), dest.clone()));
            let _ = app.emit(
                "sn-update-ready",
                serde_json::json!({
                    "version": ver,
                    "path": dest.display().to_string(),
                }),
            );
            poke_tray(app);
            Ok(dest.display().to_string())
        }
        // 失败保留 .part 供下次续传（校验失败类的删文件发生在 verify 内部）。
        // 广播失败终态：前端（关于页）的 busy 态只由 progress/ready 驱动，
        // 没有终态事件会永久卡在「正在下载」——后台预下载失败同样要复位
        Err(e) => {
            let _ = app.emit(
                "sn-update-progress",
                serde_json::json!({ "error": e }),
            );
            Err(e)
        }
    }
}

/// 镜像 URL = 前缀 + 官方 URL（如 https://gh-proxy.com/https://github.com/…）。
/// 前缀必须是 http(s) 来源（拒绝 file:// 等协议注入），官方部分仍走
/// validate_download_url 白名单；内容安全由 sha256 校验兜底（见 usable_mirror）
fn build_mirror_url(mirror: &str, official: &str) -> Option<String> {
    let m = mirror.trim().trim_end_matches('/');
    if m.is_empty() {
        return None;
    }
    // 大小写不敏感：HTTPS:// 前缀的用户输入不该静默失效（否则只觉「镜像没用」）
    let lower = m.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return None;
    }
    Some(format!("{m}/{official}"))
}

/// 取本配置下可用的镜像地址：仅在官方提供 sha256 digest 时启用镜像——
/// 没有摘要校验就信任镜像等价于「从任意前缀下载并运行 exe」
fn usable_mirror(app: &AppHandle, official: &str, exp: &Option<AssetExpectation>) -> Option<String> {
    if exp.as_ref().and_then(|e| e.digest.as_ref()).is_none() {
        return None;
    }
    build_mirror_url(&current_config(app).general.download_mirror, official)
}

/// 多源多次尝试下载：源序列 = [镜像?] + 官方直连（镜像失败自动回退直连）；
/// 每源最多 3 次尝试（1 + 重试 2 次），退避 3s / 10s；跨次尝试经 .part 续传
async fn download_with_retries(
    app: &AppHandle,
    official: &str,
    exp: &Option<AssetExpectation>,
    part: &Path,
    dest: &Path,
) -> Result<(), String> {
    let mut sources: Vec<String> = Vec::new();
    if let Some(m) = usable_mirror(app, official, exp) {
        sources.push(m);
    }
    sources.push(official.to_string());

    let mut last_err = String::from("下载失败");
    for src in &sources {
        for attempt in 0..3u32 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_secs(if attempt == 1 { 3 } else { 10 })).await;
            }
            // 每次尝试都从原始 URL 重新发起：官方 URL 会 302 到 CDN 签名地址
            // （约 1 小时过期），续传复用签名地址必然 403
            let attempt_result = fetch_once(app, src, exp, part).await;
            match attempt_result {
                Ok(()) => match verify_download(part, exp) {
                    Ok(()) => {
                        std::fs::rename(part, dest)
                            .map_err(|e| format!("保存更新包失败：{e}"))?;
                        return Ok(());
                    }
                    // 校验失败是系统性的（坏镜像/内容被篡改），同源重试只会
                    // 再花一遍全量下载带宽——立即换源（官方直连兜底）；
                    // 网络失败才值得同源重试（.part 续传省带宽）
                    Err(e) => {
                        last_err = e;
                        break;
                    }
                },
                Err(e) => {
                    last_err = e;
                }
            }
        }
    }
    Err(last_err)
}

/// 断点续传规划：已知期望大小时 part 超过期望 = 损坏从零开始；恰好等于 =
/// 上次已写完未及 rename（崩溃/断电），直接进校验；否则从 part 长度续传
enum ResumePlan {
    Fresh,
    Append(u64),
    AlreadyComplete,
}

fn resume_plan(part_len: u64, expected_size: u64) -> ResumePlan {
    if part_len == 0 {
        return ResumePlan::Fresh;
    }
    if expected_size == 0 {
        // 期望未知：按可续传处理（最终有没有问题由校验兜底）
        return ResumePlan::Append(part_len);
    }
    match part_len.cmp(&expected_size) {
        std::cmp::Ordering::Less => ResumePlan::Append(part_len),
        std::cmp::Ordering::Equal => ResumePlan::AlreadyComplete,
        std::cmp::Ordering::Greater => ResumePlan::Fresh,
    }
}

/// 单次下载尝试：带 Range 续传、chunk 级空闲看门狗、进度 + 速度事件
async fn fetch_once(
    app: &AppHandle,
    src: &str,
    exp: &Option<AssetExpectation>,
    part: &Path,
) -> Result<(), String> {
    let expected = exp.as_ref().map(|e| e.size).unwrap_or(0);
    let part_len = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    let mut req = DL_CLIENT
        .get(src)
        .header("User-Agent", concat!("SpeakNow/", env!("CARGO_PKG_VERSION")));
    let resume_from = match resume_plan(part_len, expected) {
        ResumePlan::Fresh => {
            if part_len > 0 {
                let _ = std::fs::remove_file(part);
            }
            0
        }
        ResumePlan::Append(n) => {
            // 实测 302 保留 Range 头、CDN 回 206，续传可行
            req = req.header("Range", format!("bytes={n}-"));
            n
        }
        ResumePlan::AlreadyComplete => return Ok(()),
    };
    let mut resp = req.send().await.map_err(|e| format!("下载失败：{e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // part 比 asset 还大（损坏或换了内容）：删掉重来，交给下一次尝试
        let _ = std::fs::remove_file(part);
        return Err("续传区间非法，已清空重下".into());
    }
    if !status.is_success() {
        return Err(format!("下载失败：源返回 {status}"));
    }
    let (mut file, mut downloaded) = if status == reqwest::StatusCode::PARTIAL_CONTENT {
        let f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(part)
            .map_err(|e| format!("续传打开文件失败：{e}"))?;
        f.set_len(resume_from)
            .map_err(|e| format!("续传文件截齐失败：{e}"))?;
        (f, resume_from)
    } else {
        // 200 = 源忽略 Range（或全新下载），从头写
        let f = std::fs::File::create(part).map_err(|e| format!("创建文件失败：{e}"))?;
        (f, 0u64)
    };
    // 进度总量：已知期望用期望（续传时 content_length 只是剩余字节）；
    // 未知则用续传起点 + 本次剩余估算
    let total = if expected > 0 {
        expected
    } else {
        downloaded + resp.content_length().unwrap_or(0)
    };
    // 进度节流：至少间隔 250ms 或收满 1MB 才发一帧，避免万级事件刷爆前端；
    // 速度用 2s 滑动窗口平滑（瞬时抖动会让 KB/s 数字乱跳）
    let mut speed = SpeedWindow::new(2000);
    let mut last_emit = std::time::Instant::now();
    let mut last_bytes = downloaded;
    loop {
        // chunk 级空闲看门狗：60 秒收不到下一块判网络停滞（替代总额超时，
        // 慢网传大包只要仍在出数据就不会被掐断）
        let chunk = tokio::time::timeout(IDLE_READ_TIMEOUT, resp.chunk())
            .await
            .map_err(|_| "下载中断：60 秒无数据（网络停滞）".to_string())?
            .map_err(|e| format!("下载中断：{e}"))?;
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk)
            .map_err(|e| format!("写入失败：{e}（磁盘空间不足？）"))?;
        downloaded += chunk.len() as u64;
        speed.push(now_ms(), downloaded);
        let now = std::time::Instant::now();
        if now.duration_since(last_emit) >= Duration::from_millis(250)
            || downloaded - last_bytes >= 1024 * 1024
        {
            emit_progress(app, downloaded, total, speed.bps());
            last_emit = now;
            last_bytes = downloaded;
        }
    }
    emit_progress(app, downloaded, total, speed.bps());
    file.flush().map_err(|e| format!("写入失败：{e}"))?;
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 下载速度滑动窗口：记录 (时刻 ms, 累计字节)，统计窗口内字节增量。
/// 纯数值逻辑独立成结构体便于单测
struct SpeedWindow {
    window_ms: u64,
    samples: Vec<(u64, u64)>,
}

impl SpeedWindow {
    fn new(window_ms: u64) -> Self {
        Self {
            window_ms,
            samples: Vec::new(),
        }
    }

    fn push(&mut self, now_ms: u64, cum_bytes: u64) {
        self.samples.push((now_ms, cum_bytes));
        let cutoff = now_ms.saturating_sub(self.window_ms);
        // 窗口外的旧样本出队（边界样本保留，起点撑满整个窗口）；
        // 至少留一条作窗口起点（单样本算不出速度）
        if let Some(first_kept) = self.samples.iter().position(|(t, _)| *t >= cutoff) {
            self.samples.drain(0..first_kept);
        }
    }

    /// 窗口内平均速度（B/s）；样本不足或时间无跨度时 None
    fn bps(&self) -> Option<f64> {
        let first = self.samples.first()?;
        let last = self.samples.last()?;
        let dt = last.0.checked_sub(first.0)?;
        if dt == 0 {
            return None;
        }
        Some(last.1.saturating_sub(first.1) as f64 * 1000.0 / dt as f64)
    }
}

/// 进度事件：speed 为窗口平均 B/s，etaSec 仅在总量与速度都可知时给出（可空）
fn emit_progress(app: &AppHandle, downloaded: u64, total: u64, bps: Option<f64>) {
    let speed = bps.map(|v| v.round() as u64).unwrap_or(0);
    let eta = match bps {
        Some(v) if v > 0.0 && total > downloaded => {
            Some(((total - downloaded) as f64 / v).round() as u64)
        }
        _ => None,
    };
    let _ = app.emit(
        "sn-update-progress",
        serde_json::json!({ "downloaded": downloaded, "total": total, "speed": speed, "etaSec": eta }),
    );
}

/// "sha256:<64 hex>" → 归一化 hex（小写无前缀）；其他算法（sha512 等）或
/// 格式异常返回 None → 调用方降级为仅大小校验
fn parse_sha256_digest(d: &str) -> Option<String> {
    // 前缀大小写不敏感（GitHub 固定小写，但自定义源可能大写）：误判降级会
    // 连带禁用镜像，排查成本高
    let t = d.trim();
    let h = t
        .strip_prefix("sha256:")
        .or_else(|| t.strip_prefix("SHA256:"))?
        .trim()
        .to_ascii_lowercase();
    if h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(h)
    } else {
        None
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// 流式计算文件 sha256（安装包几十 MB，不能一次读进内存）
fn file_sha256(p: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(p)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

/// 落盘后校验：先比 API 的 asset.size 与实际字节数，再比 sha256 digest。
/// 不匹配删除 .part 并报「校验失败」；digest 缺失降级为仅大小校验并记日志
fn verify_download(part: &Path, exp: &Option<AssetExpectation>) -> Result<(), String> {
    let Some(exp) = exp else {
        // 没有最近检查的期望值（理论上只发生在前端拿旧 URL 直接下载）：
        // 无从校验，放行并留痕
        eprintln!("[speaknow] 无资产期望值（size/digest），跳过下载校验");
        return Ok(());
    };
    let actual = std::fs::metadata(part)
        .map(|m| m.len())
        .map_err(|e| format!("校验失败：{e}"))?;
    if exp.size > 0 && actual != exp.size {
        let _ = std::fs::remove_file(part);
        return Err(format!("校验失败：大小不符（期望 {} 字节，实际 {actual} 字节）", exp.size));
    }
    if let Some(want) = &exp.digest {
        let got = file_sha256(part).map_err(|e| format!("校验失败：{e}"))?;
        if got != *want {
            let _ = std::fs::remove_file(part);
            return Err("校验失败：SHA-256 不符，已删除（下载源损坏或被篡改）".into());
        }
    } else {
        eprintln!("[speaknow] Release 资产未提供 digest，降级为仅大小校验");
    }
    Ok(())
}

/// 从官方下载 URL 提取版本号：
/// …/releases/download/v0.6.1/SpeakNow_0.6.1_x64-setup.exe → 0.6.1
fn version_from_download_url(u: &str) -> Option<String> {
    let rest = u.split("/releases/download/").nth(1)?;
    let tag = rest.split('/').next()?;
    if tag.is_empty() {
        return None;
    }
    Some(tag.trim_start_matches('v').to_string())
}

/* ---------- 周期检查 ---------- */

/// 周期检查线程主体（lib.rs setup 里 spawn）：每 6h ± 10 分钟检查一次新
/// 版本，连续失败按 ×2 退避封顶 24h。独立 std::thread + sleep 循环——
/// 进程退出即随之终止，无需优雅退出协议；配置每轮现取，改开关无需重启
pub fn periodic_check_loop(app: AppHandle) {
    let mut fail_streak: u32 = 0;
    let mut last_tag: Option<String> = None;
    loop {
        std::thread::sleep(next_check_interval(fail_streak));
        if !current_config(&app).general.auto_check_update {
            continue;
        }
        // 免限额预检：HEAD releases/latest 读 302 Location 的 tag，与上一轮
        // 一致则跳过 API 调用（预检失败不阻塞，回退完整检查）
        if let Ok(Some(tag)) = tauri::async_runtime::block_on(precheck_latest_tag()) {
            if last_tag.as_deref() == Some(tag.as_str()) {
                continue;
            }
        }
        match tauri::async_runtime::block_on(fetch_latest()) {
            Ok((info, asset)) => {
                fail_streak = 0;
                last_tag = Some(info.tag.clone());
                record_check_result(&app, &info, asset.as_ref());
            }
            Err(e) => {
                fail_streak += 1;
                eprintln!("[speaknow] 周期检查更新失败（连续 {fail_streak} 次，间隔退避加倍）: {e}");
            }
        }
    }
}

/// 下一轮间隔：6h ± 10 分钟抖动；连续失败 ×2 退避封顶 24h（抖动保底 60s）
fn next_check_interval(fail_streak: u32) -> Duration {
    use rand::Rng;
    let base = if fail_streak == 0 {
        CHECK_INTERVAL_SECS
    } else {
        CHECK_INTERVAL_SECS
            .saturating_mul(1u64 << fail_streak.min(12))
            .min(BACKOFF_CAP_SECS)
    };
    let jitter = rand::rng().random_range(-CHECK_JITTER_SECS..=CHECK_JITTER_SECS);
    Duration::from_secs((base as i64 + jitter).max(60) as u64)
}

/// HEAD releases/latest（禁跟随重定向）读 302 Location 里的 tag。
/// 非 302 / 无 Location 返回 None，调用方走完整 API 检查
async fn precheck_latest_tag() -> Result<Option<String>, String> {
    let resp = HEAD_CLIENT
        .head(RELEASES_LATEST_PAGE)
        .header("User-Agent", concat!("SpeakNow/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("预检失败：{e}"))?;
    if !resp.status().is_redirection() {
        return Ok(None);
    }
    let loc = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    Ok(tag_from_location(loc))
}

/// "https://github.com/YFsama/SpeakNow/releases/tag/v0.6.1" → "v0.6.1"
fn tag_from_location(loc: &str) -> Option<String> {
    let tag = loc.split("/tag/").nth(1)?.trim();
    if tag.is_empty() || tag.contains('/') {
        return None;
    }
    Some(tag.to_string())
}

/// 托盘「新版本」入口要展示的版本：就绪包优先，其次最近检查发现的新版本；
/// 已跳过的版本不展示（与前端侧栏红点同一口径）
pub fn tray_badge_version(app: &AppHandle) -> Option<String> {
    let v = {
        let st = lock_state();
        st.ready
            .as_ref()
            .map(|(v, _)| v.clone())
            .or_else(|| st.last_available.clone())?
    };
    if v.is_empty() {
        return None;
    }
    let skip = current_config(app).general.skip_version;
    (v != skip).then_some(v)
}

/// 发现/就绪状态变化后重建托盘菜单（新版本入口增减）。菜单构建必须在
/// 主线程，本函数可能从后台线程调，经 run_on_main_thread 派发
fn poke_tray(app: &AppHandle) {
    let h = app.clone();
    let _ = app.run_on_main_thread(move || crate::tray::rebuild_menu(&h));
}

/* ---------- 安装 ---------- */

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

/// 安装器是否已拉起（单飞）：手动安装内部 app.exit(0) 会再走一遍
/// RunEvent::Exit 退出钩子，不拦会把安装器拉起两次
static INSTALL_LAUNCHED: AtomicBool = AtomicBool::new(false);

/// 拉起安装器并退出应用：Windows 走 NSIS 静默参数 /P（被动进度，不出向导
/// 提问）+ /R（装完自动重启应用），且经 detached cmd 延迟 2 秒再启动——本
/// 进程退出收尾（配置落盘、llama-server 回收）完成后再动被占用的安装目标
/// 文件，避免文件占用竞态；macOS 打开 dmg 由用户拖入 Applications。
/// 先 spawn 再 exit，与官方 tauri-plugin-updater 同序
#[tauri::command]
pub fn install_update(app: AppHandle, path: String) -> Result<(), String> {
    let canon = validate_install_path(&path)?;
    // 手动安装：用户点了「安装并重启」，/R 装完自动拉起新版本是预期行为
    launch_installer_detached(&canon, true)?;
    app.exit(0);
    Ok(())
}

/// restart_elevated 的退出抑制标志：提权中继正要拉起新实例时绝不能同时
/// 开装——安装器会覆盖正在启动的提权实例文件（/P 可能杀掉新实例或装失败）。
/// lib.rs 在 restart_elevated 的 app.exit 之前设置
static SUPPRESS_EXIT_INSTALL: AtomicBool = AtomicBool::new(false);
pub fn suppress_exit_install() {
    SUPPRESS_EXIT_INSTALL.store(true, Ordering::SeqCst);
}

/// 退出时安装钩子（lib.rs RunEvent::Exit 调用）：后台预下载就绪后用户直接
/// 退出应用也把这次更新装上。用户明确「跳过此版本」或文件被临时目录清理
/// 时静默跳过（尊重跳过：装一个用户不要的版本比少装一次更糟）。
/// 不带 /R：用户主动退出，装完静默复活应用是惊吓不是惊喜
pub fn install_on_exit_if_ready(app: &AppHandle) {
    if SUPPRESS_EXIT_INSTALL.load(Ordering::SeqCst) {
        return;
    }
    let Some((ver, path)) = lock_state().ready.clone() else {
        return;
    };
    if !ver.is_empty() && ver == current_config(app).general.skip_version {
        return;
    }
    if !path.is_file() {
        return;
    }
    if let Err(e) = validate_install_path(&path.display().to_string())
        .and_then(|c| launch_installer_detached(&c, false))
    {
        eprintln!("[speaknow] 退出时装载更新失败（忽略，正常退出）: {e}");
    }
}

/// detached 拉起安装器（手动安装与退出钩子共用，INSTALL_LAUNCHED 单飞）。
/// auto_restart 仅手动路径为真（/R 装完自动重启应用）
fn launch_installer_detached(canon: &Path, auto_restart: bool) -> Result<(), String> {
    if INSTALL_LAUNCHED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("cmd");
        // raw_arg 绕过 std 的 MSVC 参数转义：args() 会给含引号的整串再包一层
        // 引号并把内部 " 转义成 \"，cmd /C 剥壳后安装器路径损坏（实测报
        // '\C:\…\setup.exe\' 不是内部或外部命令，安装器永远拉不起且错误被
        // 吞掉）——命令行必须原样传递
        cmd.raw_arg("/C");
        cmd.raw_arg(&nsis_cmd_line(&canon.display().to_string(), auto_restart));
        cmd.current_dir(update_root());
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP：脱离本进程控制台组与
        // 生命周期，本进程随后 exit 不会把安装器带崩。延迟不能用 timeout /t：
        // detached 无控制台时 timeout.exe 缺句柄立即报错，改用 ping -n 3
        // （3 次约 1s 间隔的回环探测 ≈ 2s 延迟，无控制台也能用）
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        cmd.spawn()
            .map_err(|e| format!("启动安装器失败：{e}"))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(canon)
            .spawn()
            .map_err(|e| format!("启动安装器失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = canon;
        std::process::Command::new("xdg-open")
            .arg(canon)
            .spawn()
            .map_err(|e| format!("启动安装器失败：{e}"))?;
        Ok(())
    }
}

/// Windows 安装器拉起命令行（纯函数供单测）：ping 延迟约 2s + NSIS /P /R
fn nsis_cmd_line(installer: &str, auto_restart: bool) -> String {
    // auto_restart 仅为真于手动「安装并重启」：退出钩子装完不复活应用
    format!(
        "ping -n 3 127.0.0.1 >nul & \"{installer}\" /P{}",
        if auto_restart { " /R" } else { "" }
    )
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

    #[test]
    fn digest_parse_accepts_prefixed_hex_only() {
        let ok = "sha256:2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824";
        let parsed = parse_sha256_digest(ok);
        assert_eq!(
            parsed.as_deref(),
            Some("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
        );
        // 其他算法不认（降级路径）
        assert!(parse_sha256_digest("sha512:abcd").is_none());
        // 长度不对 / 非 hex / 无前缀
        assert!(parse_sha256_digest("sha256:abc").is_none());
        assert!(parse_sha256_digest(
            "sha256:zzf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        )
        .is_none());
        assert!(parse_sha256_digest(
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        )
        .is_none());
        assert!(parse_sha256_digest("").is_none());
    }

    #[test]
    fn verify_download_size_and_digest() {
        // 测试模块允许 unwrap（项目约定）
        let dir = std::env::temp_dir().join("speaknow-update-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("verify.part");
        std::fs::write(&p, b"hello").unwrap();

        // 大小不符：删文件 + 报「校验失败」
        let exp = AssetExpectation {
            url: String::new(),
            size: 99,
            digest: None,
        };
        let err = verify_download(&p, &Some(exp)).unwrap_err();
        assert!(err.contains("校验失败"), "{err}");
        assert!(!p.exists(), "校验失败的 .part 应被删除");

        // digest 不符：删文件 + 报「校验失败」
        std::fs::write(&p, b"hello").unwrap();
        let wrong = AssetExpectation {
            url: String::new(),
            size: 5,
            digest: Some("0".repeat(64)),
        };
        assert!(verify_download(&p, &Some(wrong)).is_err());
        assert!(!p.exists());

        // digest 吻合（sha256("hello")）：通过且保留文件
        std::fs::write(&p, b"hello").unwrap();
        let hello_sha = hex_lower(&Sha256::digest(b"hello"));
        let good = AssetExpectation {
            url: String::new(),
            size: 5,
            digest: Some(hello_sha),
        };
        assert!(verify_download(&p, &Some(good)).is_ok());
        assert!(p.exists());

        // digest 缺失（旧 Release）：仅大小校验，通过（降级日志见 stderr）
        let degraded = AssetExpectation {
            url: String::new(),
            size: 5,
            digest: None,
        };
        assert!(verify_download(&p, &Some(degraded)).is_ok());

        // 无期望值：跳过校验直接放行
        assert!(verify_download(&p, &None).is_ok());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn resume_plan_branches() {
        // 无 part：全新开始
        assert!(matches!(resume_plan(0, 100), ResumePlan::Fresh));
        // 期望未知：尽力续传
        assert!(matches!(resume_plan(30, 0), ResumePlan::Append(30)));
        // part 小于期望：续传起点 = part 长度（Range: bytes=N-）
        assert!(matches!(resume_plan(30, 100), ResumePlan::Append(30)));
        // part 恰好等于期望：上次写完未 rename，直接进校验
        assert!(matches!(resume_plan(100, 100), ResumePlan::AlreadyComplete));
        // part 超过期望：损坏，从头来
        assert!(matches!(resume_plan(101, 100), ResumePlan::Fresh));
    }

    #[test]
    fn mirror_url_build_and_whitelist() {
        let official =
            "https://github.com/YFsama/SpeakNow/releases/download/v0.6.0/SpeakNow_0.6.0_x64-setup.exe";
        // 官方部分先过白名单，再拼镜像前缀
        assert!(validate_download_url(official).is_ok());
        assert_eq!(
            build_mirror_url("https://gh-proxy.com/", official).as_deref(),
            Some("https://gh-proxy.com/https://github.com/YFsama/SpeakNow/releases/download/v0.6.0/SpeakNow_0.6.0_x64-setup.exe")
        );
        // 尾斜杠归一
        assert_eq!(
            build_mirror_url("https://gh-proxy.com", official),
            build_mirror_url("https://gh-proxy.com/", official)
        );
        // 留空 / 空白 = 直连
        assert!(build_mirror_url("", official).is_none());
        assert!(build_mirror_url("   ", official).is_none());
        // 恶意前缀不越权：非 http(s) 协议一律拒绝，拼不出可用的下载地址
        assert!(build_mirror_url("file://evil", official).is_none());
        assert!(build_mirror_url("javascript:alert(1)", official).is_none());
        assert!(build_mirror_url("ftp://x", official).is_none());
        // 镜像 URL 中官方路径仍是完整后缀（校验与 digest 都以它为准）
        let m = build_mirror_url("https://gh-proxy.com/", official).unwrap();
        assert!(m.ends_with(official));
    }

    #[test]
    fn speed_window_sliding_average() {
        let mut w = SpeedWindow::new(2000);
        assert!(w.bps().is_none());
        // 0→2s 匀速 1000 B/s
        w.push(0, 0);
        w.push(1000, 1000);
        w.push(2000, 2000);
        assert_eq!(w.bps(), Some(1000.0));
        // 3s 时窗口滑出 t=0 样本：增量 1600B / 2s = 800 B/s
        w.push(3000, 2600);
        assert_eq!(w.bps(), Some(800.0));
        // 单样本（无时间跨度）：算不出速度
        let mut w2 = SpeedWindow::new(2000);
        w2.push(100, 500);
        assert!(w2.bps().is_none());
    }

    #[test]
    fn tag_from_location_parse() {
        assert_eq!(
            tag_from_location("https://github.com/YFsama/SpeakNow/releases/tag/v0.6.1"),
            Some("v0.6.1".into())
        );
        assert_eq!(
            tag_from_location("https://github.com/YFsama/SpeakNow/releases/tag/v0.6.1 "),
            Some("v0.6.1".into())
        );
        // 非 tag 页 / 空 / 带残留路径：一律 None（回退完整 API 检查）
        assert!(tag_from_location("https://github.com/YFsama/SpeakNow").is_none());
        assert!(tag_from_location("https://github.com/YFsama/SpeakNow/releases/tag/").is_none());
        assert!(tag_from_location("https://x/tag/v1/extra").is_none());
        assert!(tag_from_location("").is_none());
    }

    #[test]
    fn nsis_cmd_line_carries_passive_and_restart() {
        let exe = r"C:\tmp\speaknow-update\SpeakNow_0.6.1_x64-setup.exe";
        // 手动路径：延迟启动 + 被动安装 + 装完自动重启应用，路径加引号防空格断裂
        let manual = nsis_cmd_line(exe, true);
        assert!(manual.starts_with("ping -n 3 127.0.0.1 >nul & \""));
        assert!(manual.contains("\" /P /R"));
        // 退出钩子路径：不带 /R——用户主动退出应用，装完不静默复活
        let on_exit = nsis_cmd_line(exe, false);
        assert!(on_exit.contains("\" /P"));
        assert!(!on_exit.contains("/R"));
    }

    #[test]
    fn version_from_download_url_test() {
        assert_eq!(
            version_from_download_url(
                "https://github.com/YFsama/SpeakNow/releases/download/v0.6.1/SpeakNow_0.6.1_x64-setup.exe"
            )
            .as_deref(),
            Some("0.6.1")
        );
        assert_eq!(
            version_from_download_url(
                "https://github.com/YFsama/SpeakNow/releases/download/1.2.0/SpeakNow_1.2.0_aarch64.dmg"
            )
            .as_deref(),
            Some("1.2.0")
        );
        assert!(version_from_download_url("https://example.com/x.exe").is_none());
    }
}
