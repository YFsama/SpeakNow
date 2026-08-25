// Qwen3-ASR 本地引擎：
//   官方 GGUF（ggml-org/Qwen3-ASR-1.7B-GGUF，HF 直连）+ llama.cpp llama-server 子进程，
//   通过本机 OpenAI 兼容接口 /v1/audio/transcriptions 转写，识别过程完全离线。
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::asr::truncate;
use crate::local_whisper::LocalModelStatus;
use crate::wav;

pub const MODEL_ID: &str = "qwen3-asr-1.7b";
pub const MODEL_NAME: &str = "Qwen3-ASR 1.7B（新一代离线 · 高精度）";
const MAIN_GGUF: &str = "Qwen3-ASR-1.7B-Q8_0.gguf";
const MMPROJ_GGUF: &str = "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf";
const HF_BASE: &str = "https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/main";
/// 已确认存在 Windows x64 资产的 llama.cpp 构建号（「取最新」失败时的兜底）
const PINNED_BUILD: &str = "b10584";
const BASE_PORT: u16 = 18279;
/// 单段音频上限：llama.cpp 对超长音频偶发幻觉/空结果，12 秒内最稳
const CHUNK_SECS: usize = 12;
/// 引擎冷启动（加载 2.9GB 模型）最长等待
const BOOT_TIMEOUT: Duration = Duration::from_secs(240);
const USER_AGENT: &str = concat!("SpeakNow/", env!("CARGO_PKG_VERSION"));

/* ---------- 路径与状态 ---------- */

fn config_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .context("无法定位配置目录")?)
}

fn model_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(config_dir(app)?.join("models").join(MODEL_ID))
}

fn runtime_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(config_dir(app)?.join("llama-runtime"))
}

pub fn model_files_ok(app: &AppHandle) -> bool {
    model_dir(app)
        .map(|d| d.join(MAIN_GGUF).exists() && d.join(MMPROJ_GGUF).exists())
        .unwrap_or(false)
}

fn runtime_exe(app: &AppHandle) -> Result<PathBuf> {
    Ok(runtime_dir(app)?.join("llama-server.exe"))
}

pub fn runtime_ok(app: &AppHandle) -> bool {
    runtime_exe(app).map(|p| p.exists()).unwrap_or(false)
}

/// 运行时后端标记（backend.txt 首行：vulkan / cpu）
fn runtime_backend(app: &AppHandle) -> Option<String> {
    let txt = runtime_dir(app).ok()?.join("backend.txt");
    std::fs::read_to_string(txt)
        .ok()?
        .lines()
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

pub fn status(app: &AppHandle) -> LocalModelStatus {
    let backend = runtime_backend(app).unwrap_or_default();
    LocalModelStatus {
        id: MODEL_ID.into(),
        name: MODEL_NAME.into(),
        desc: "Qwen 新一代大模型 ASR，中文准确率显著优于 Whisper；模型+运行时约 3GB，"
            .to_string()
            + "自动检测显卡（Vulkan 加速），下载走 HuggingFace 官方源直连",
        size_mb: 2950,
        downloaded: model_files_ok(app),
        kind: Some("qwen".into()),
        runtime_ready: Some(runtime_ok(app)),
        backend: (!backend.is_empty()).then_some(backend),
    }
}

/* ---------- 下载（运行时 + 模型，进度经 sn-model-progress 推送） ---------- */

static DOWNLOADING: AtomicBool = AtomicBool::new(false);

pub async fn download(app: &AppHandle) -> Result<()> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        bail!("已有模型下载任务进行中");
    }
    let emit_app = app.clone();
    let progress = move |file: &str, dl: u64, total: u64| {
        let _ = emit_app.emit(
            "sn-model-progress",
            serde_json::json!({ "model": MODEL_ID, "file": file, "downloaded": dl, "total": total }),
        );
    };
    let res = download_inner(app, &progress).await;
    DOWNLOADING.store(false, Ordering::SeqCst);
    let _ = app.emit("sn-models-changed", ());
    res
}

async fn download_inner(
    app: &AppHandle,
    progress: &(dyn Fn(&str, u64, u64) + Send + Sync),
) -> Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        bail!("Qwen3-ASR 本地引擎目前仅支持 Windows");
    }
    #[cfg(target_os = "windows")]
    {
        if !runtime_ok(app) {
            download_runtime(app, None, progress).await?;
        }
        let dir = model_dir(app)?;
        tokio::fs::create_dir_all(&dir).await.ok();
        // 先下小的 mmproj（音频编码器），再下主模型
        fetch_file(
            &format!("{HF_BASE}/{MMPROJ_GGUF}"),
            &dir.join(MMPROJ_GGUF),
            MMPROJ_GGUF,
            progress,
        )
        .await?;
        fetch_file(
            &format!("{HF_BASE}/{MAIN_GGUF}"),
            &dir.join(MAIN_GGUF),
            MAIN_GGUF,
            progress,
        )
        .await?;
        Ok(())
    }
}

/// 下载并解压 llama.cpp 运行时。backend=None 时自动检测（有显卡 → vulkan，否则 cpu）
pub async fn download_runtime(
    app: &AppHandle,
    force_backend: Option<&str>,
    progress: &(dyn Fn(&str, u64, u64) + Send + Sync),
) -> Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, force_backend, progress);
        bail!("仅支持 Windows");
    }
    #[cfg(target_os = "windows")]
    {
        let backend = force_backend.map(String::from).unwrap_or_else(detect_backend);
        let tag = latest_build_tag(&backend)
            .await
            .unwrap_or_else(|| PINNED_BUILD.to_string());
        let asset = format!("llama-{tag}-bin-win-{backend}-x64.zip");
        let url = format!("https://github.com/ggml-org/llama.cpp/releases/download/{tag}/{asset}");
        let dir = runtime_dir(app)?;
        tokio::fs::create_dir_all(&dir).await.ok();
        let zip_path = dir.join(&asset);
        // 版本变化时清掉旧的 exe/dll，避免新旧混用
        let _ = std::fs::remove_file(dir.join("backend.txt"));
        fetch_file(&url, &zip_path, &asset, progress).await?;
        let zc = zip_path.clone();
        let dc = dir.clone();
        tauri::async_runtime::spawn_blocking(move || unzip_all(&zc, &dc))
            .await
            .map_err(|e| anyhow!("解压线程异常: {e}"))??;
        if !dir.join("llama-server.exe").exists() {
            bail!("运行时包中缺少 llama-server.exe");
        }
        tokio::fs::remove_file(&zip_path).await.ok();
        tokio::fs::write(dir.join("backend.txt"), format!("{backend}\n{tag}")).await?;
        eprintln!("[speaknow] llama.cpp 运行时就绪：{tag} / {backend}");
        Ok(())
    }
}

/// 有独立/集成显卡就走 Vulkan（包小 33MB、通吃 N/A/I）；失败会自动回退 CPU
fn detect_backend() -> String {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let out = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_VideoController).Name -join ';'",
            ])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output();
        if let Ok(o) = out {
            if o.status.success() {
                let s = String::from_utf8_lossy(&o.stdout).to_lowercase();
                let has_gpu = ["nvidia", "geforce", "radeon", "amd", "arc", "iris", "uhd", "graphics"]
                    .iter()
                    .any(|k| s.contains(k));
                if has_gpu {
                    return "vulkan".into();
                }
            }
        }
    }
    "cpu".into()
}

/// 取最近一个含对应 Windows 资产的 release tag；失败用固定构建号
async fn latest_build_tag(backend: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?;
    let v: serde_json::Value = client
        .get("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10")
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    for rel in v.as_array()? {
        let Some(tag) = rel.get("tag_name").and_then(|t| t.as_str()) else {
            continue;
        };
        let want = format!("llama-{tag}-bin-win-{backend}-x64.zip");
        let hit = rel
            .get("assets")
            .and_then(|a| a.as_array())
            .map(|arr| arr.iter().any(|a| a.get("name").and_then(|n| n.as_str()) == Some(&want)))
            .unwrap_or(false);
        if hit {
            return Some(tag.into());
        }
    }
    None
}

fn unzip_all(zip_path: &Path, dest: &Path) -> Result<()> {
    let f = std::fs::File::open(zip_path).context("打开运行时压缩包失败")?;
    let mut z = zip::ZipArchive::new(f).context("压缩包损坏或格式不支持")?;
    for i in 0..z.len() {
        let mut e = z.by_index(i)?;
        if e.is_dir() {
            continue;
        }
        let Some(name) = e.enclosed_name() else {
            continue;
        };
        let out = dest.join(name);
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).ok();
        }
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut e, &mut buf)?;
        std::fs::write(&out, &buf)?;
    }
    Ok(())
}

/// 流式下载单个文件到 .part 再改名；已存在则跳过（断点只需删除损坏文件重下）
async fn fetch_file(
    url: &str,
    dest: &Path,
    label: &str,
    progress: &(dyn Fn(&str, u64, u64) + Send + Sync),
) -> Result<()> {
    if dest.exists() {
        let n = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
        progress(label, n, n);
        return Ok(());
    }
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(150))
        .build()?;
    let resp = client
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .with_context(|| format!("下载失败（{label}）"))?;
    let total = resp.content_length().unwrap_or(0);
    if let Some(p) = dest.parent() {
        tokio::fs::create_dir_all(p).await.ok();
    }
    let tmp = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .context("创建临时文件失败")?;
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut resp = resp;
    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = resp
        .chunk()
        .await
        .with_context(|| format!("下载中断（{label}）"))?
    {
        file.write_all(&chunk).await.context("写入磁盘失败")?;
        downloaded += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(200) {
            progress(label, downloaded, total);
            last_emit = Instant::now();
        }
    }
    file.flush().await.ok();
    drop(file);
    tokio::fs::rename(&tmp, dest)
        .await
        .with_context(|| format!("保存文件失败（{label}）"))?;
    progress(label, downloaded, downloaded.max(total));
    Ok(())
}

/* ---------- llama-server 子进程管理 ---------- */

struct ServerState {
    child: Option<Child>,
    port: u16,
}

static SERVER: LazyLock<Mutex<Option<ServerState>>> = LazyLock::new(|| Mutex::new(None));
/// 串行化引擎启动，避免并发首识时重复拉起
static SPAWN_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

pub fn shutdown() {
    if let Some(st) = SERVER.lock().unwrap().take() {
        if let Some(mut c) = st.child {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn probe_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .expect("probe client")
}

fn health(base: &str) -> bool {
    matches!(
        probe_client().get(format!("{base}/health")).send(),
        Ok(r) if r.status().is_success()
    )
}

/// 端口上是否是我们上次遗留的 Qwen3-ASR 服务（可安全接管复用）
fn adoptable(port: u16) -> Option<String> {
    let base = format!("http://127.0.0.1:{port}");
    if !health(&base) {
        return None;
    }
    let props = probe_client()
        .get(format!("{base}/props"))
        .send()
        .ok()
        .and_then(|r| r.text().ok())
        .unwrap_or_default();
    if props.contains("Qwen3-ASR") {
        Some(base)
    } else {
        None
    }
}

fn find_free_port() -> u16 {
    for p in BASE_PORT..BASE_PORT + 20 {
        if std::net::TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return p;
        }
    }
    BASE_PORT
}

fn log_tail(app: &AppHandle) -> String {
    let Ok(dir) = runtime_dir(app) else {
        return String::new();
    };
    let Ok(bytes) = std::fs::read(dir.join("server.log")) else {
        return String::new();
    };
    let start = bytes.len().saturating_sub(1200);
    String::from_utf8_lossy(&bytes[start..]).trim().to_string()
}

/// 确保本地 llama-server 已启动并健康，返回 base URL（阻塞，勿在异步线程直接调用）
pub fn ensure_server(app: &AppHandle) -> Result<String> {
    let _guard = SPAWN_LOCK.lock().unwrap();

    // 1) 已有子进程且健康
    {
        let mut g = SERVER.lock().unwrap();
        if let Some(st) = g.as_mut() {
            let alive = st
                .child
                .as_mut()
                .map(|c| c.try_wait().map(|o| o.is_none()).unwrap_or(false))
                .unwrap_or(true);
            let base = format!("http://127.0.0.1:{}", st.port);
            if alive && health(&base) {
                return Ok(base);
            }
            *g = None;
        }
    }

    // 2) 接管上次异常退出的残留服务
    if let Some(base) = adoptable(BASE_PORT) {
        *SERVER.lock().unwrap() = Some(ServerState {
            child: None,
            port: BASE_PORT,
        });
        eprintln!("[speaknow] 接管已运行的 Qwen3-ASR 引擎（端口 {BASE_PORT}）");
        return Ok(base);
    }

    // 3) 前置检查
    if !model_files_ok(app) {
        bail!("Qwen3-ASR 模型文件不完整：请在「识别设置」重新点击下载");
    }
    let exe = runtime_exe(app)?;
    if !exe.exists() {
        bail!("llama.cpp 运行时缺失：请在「识别设置」重新点击下载补全");
    }
    let mut backend = runtime_backend(app).unwrap_or_else(|| "cpu".into());
    let dir = model_dir(app)?;

    // 4) 启动（vulkan 初始化失败时自动换 CPU 运行时重试一次）
    for attempt in 0..2 {
        let port = find_free_port();
        let log_file = runtime_dir(app)?.join("server.log");
        if let Some(p) = log_file.parent() {
            std::fs::create_dir_all(p).ok();
        }
        let mut cmd = Command::new(&exe);
        cmd.arg("-m").arg(dir.join(MAIN_GGUF))
            .arg("--mmproj")
            .arg(dir.join(MMPROJ_GGUF))
            .args(["--host", "127.0.0.1", "--port"])
            .arg(port.to_string())
            .arg("--no-webui")
            .current_dir(exe.parent().unwrap_or(Path::new(".")));
        if backend == "vulkan" {
            cmd.arg("-ngl").arg("99");
        }
        // stdout/stderr 都写进 server.log（llama.cpp 主要输出到 stderr）
        if let Ok(l) = std::fs::File::create(&log_file) {
            match l.try_clone() {
                Ok(l2) => {
                    cmd.stdout(Stdio::from(l)).stderr(Stdio::from(l2));
                }
                Err(_) => {
                    cmd.stderr(Stdio::from(l));
                }
            }
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Err(anyhow!("启动 llama-server 失败: {e}（运行时可能被杀毒软件拦截）")),
        };

        let base = format!("http://127.0.0.1:{port}");
        let start = Instant::now();
        let mut last_note = Instant::now() - Duration::from_secs(4);
        loop {
            if health(&base) {
                eprintln!("[speaknow] Qwen3-ASR 引擎就绪：{base}（{backend}）");
                *SERVER.lock().unwrap() = Some(ServerState {
                    child: Some(child),
                    port,
                });
                return Ok(base);
            }
            if let Ok(Some(_)) = child.try_wait() {
                let tail = log_tail(app);
                let vulkan_fail = backend == "vulkan"
                    && tail.to_lowercase().contains("vulkan");
                if vulkan_fail && attempt == 0 {
                    eprintln!("[speaknow] Vulkan 初始化失败，自动切换 CPU 运行时：{tail}");
                    let _ = app.emit(
                        "sn-status",
                        serde_json::json!({ "stage": "transcribing", "message": "显卡加速初始化失败，正在切换 CPU 版运行时（约 20MB）…", "sound": false }),
                    );
                    let a = app.clone();
                    let _ = tauri::async_runtime::block_on(download_runtime(
                        &a,
                        Some("cpu"),
                        &|_, _, _| {},
                    ));
                    backend = "cpu".into();
                    break; // 用 cpu 运行时重试外层循环
                }
                bail!("llama-server 启动即退出：{}", truncate(&tail, 400));
            }
            if start.elapsed() > BOOT_TIMEOUT {
                let _ = child.kill();
                let _ = child.wait();
                bail!(
                    "Qwen3-ASR 引擎启动超时（{}s）：{}",
                    BOOT_TIMEOUT.as_secs(),
                    truncate(&log_tail(app), 300)
                );
            }
            if last_note.elapsed() >= Duration::from_secs(5) {
                let _ = app.emit(
                    "sn-status",
                    serde_json::json!({ "stage": "transcribing", "message": "Qwen3-ASR 引擎启动中…（首次加载约 3GB 模型，需十几秒）", "sound": false }),
                );
                last_note = Instant::now();
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    bail!("Qwen3-ASR 引擎启动失败：{}", truncate(&log_tail(app), 300))
}

/// 转写：分块调本地 /v1/audio/transcriptions（阻塞，需在 spawn_blocking 中调用）
pub fn transcribe(app: &AppHandle, samples: &[i16], language: &str) -> Result<String> {
    if samples.is_empty() {
        bail!("音频内容为空");
    }
    let base = ensure_server(app)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()?;
    let chunk_len = 16_000 * CHUNK_SECS;
    let chunks: Vec<&[i16]> = if samples.len() <= chunk_len {
        vec![samples]
    } else {
        samples.chunks(chunk_len).collect()
    };
    let mut parts: Vec<String> = Vec::new();
    for (i, c) in chunks.iter().enumerate() {
        if chunks.len() > 1 {
            eprintln!("[speaknow] Qwen3-ASR 分段 {}/{}", i + 1, chunks.len());
        }
        let wav_bytes = wav::encode(c, 16_000);
        let part = reqwest::blocking::multipart::Part::bytes(wav_bytes)
            .file_name("audio.wav")
            .mime_str("audio/wav")?;
        let mut form = reqwest::blocking::multipart::Form::new()
            .part("file", part)
            .text("model", MODEL_ID.to_string());
        if !language.is_empty() && language != "auto" {
            form = form.text("language", language.to_string());
        }
        let resp = client
            .post(format!("{base}/v1/audio/transcriptions"))
            .multipart(form)
            .send()
            .context("本地引擎请求失败（进程可能已退出）")?;
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        if !status.is_success() {
            bail!("本地引擎返回 {status}: {}", truncate(body.trim(), 300));
        }
        let v: serde_json::Value = serde_json::from_str(&body)
            .with_context(|| format!("本地引擎响应异常: {}", truncate(body.trim(), 120)))?;
        if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
            let cleaned = clean_asr_text(t);
            if !cleaned.is_empty() {
                parts.push(cleaned);
            }
        }
    }
    let joiner = if language == "en" { " " } else { "" };
    Ok(parts.join(joiner))
}

/// llama.cpp 的 qwen3-asr 转写会回显模板外壳（如 `language Chinese<asr_text>实际内容`），剥掉
fn clean_asr_text(t: &str) -> String {
    let mut s = t.trim();
    if let Some(pos) = s.find("<asr_text>") {
        s = s[pos + "<asr_text>".len()..].trim_start();
    }
    if let Some(pos) = s.find("</asr_text>") {
        s = s[..pos].trim_end();
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::clean_asr_text;

    #[test]
    fn strips_template_echo() {
        assert_eq!(
            clean_asr_text("language Chinese<asr_text>大家好，今天开会"),
            "大家好，今天开会"
        );
        assert_eq!(
            clean_asr_text("language English<asr_text>Hello world</asr_text>"),
            "Hello world"
        );
        assert_eq!(clean_asr_text("普通文本没有标记"), "普通文本没有标记");
    }
}
