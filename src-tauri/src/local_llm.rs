// 本地翻译引擎：GGUF 模型 + llama.cpp llama-server（本机 OpenAI 兼容
// /v1/chat/completions），划词 / 复制即翻译 / 输入翻译均可完全离线完成，文本不出本机。
// 首选 Index-Translate（B 站开源翻译专项模型）或通用对话模型，提示词与解码
// 参数按模型家族自动切换（Index 家族走官方原生配方，见 llm.rs）。
// 与 Qwen3-ASR 共享 llama-runtime 二进制与下载设施（qwen_asr::download_runtime 等），
// 但各自独立子进程：端口段（18320+）、日志（server-llm.log）、生命周期互不干扰，
// 双方的孤儿清理互相避让对方的活跃实例（tracked_pid）。
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use tauri::{AppHandle, Emitter, Manager};

use crate::asr::truncate;
use crate::local_whisper::LocalModelStatus;

/// 本地翻译模型目录。首选 Index-Translate（B 站开源翻译专项模型，Qwen3.5 底座，
/// 150 语种、原生支持只译值的结构化任务，提示词走 llm.rs 的官方原生配方）；
/// Qwen3-4B / Gemma-3 为通用对话模型备选。
pub struct LocalLlmModel {
    pub id: &'static str,
    pub name: &'static str,
    pub desc: &'static str,
    /// HuggingFace 仓库名（如 "Qwen/Qwen3-4B-Instruct-2507-GGUF"）
    pub hf_repo: &'static str,
    pub gguf: &'static str,
    pub size_mb: u64,
}

pub const MODELS: &[LocalLlmModel] = &[
    LocalLlmModel {
        id: "index-translate-2b",
        name: "Index-Translate-2B · B站开源翻译专项",
        desc: "150 语种翻译专项训练（Qwen3.5 底座），JSON/YAML 只译值原生支持。仅 1.3GB，CPU 也流畅，推荐首选",
        hf_repo: "mradermacher/Index-Translate-2B-GGUF",
        gguf: "Index-Translate-2B.Q4_K_M.gguf",
        size_mb: 1252,
    },
    LocalLlmModel {
        id: "index-translate-9b",
        name: "Index-Translate-9B · 质量档",
        desc: "同家族 9B（WMT24++ COMET 0.8789），质量上限更高；5.5GB 建议显卡或大内存机器",
        hf_repo: "datouge/Index-Translate-9B-Q4_K_M-GGUF",
        gguf: "index-translate-9b-q4_k_m.gguf",
        size_mb: 5513,
    },
    LocalLlmModel {
        id: "qwen3-4b-instruct",
        name: "Qwen3-4B-Instruct-2507",
        desc: "通用对话 4B（非思考版），中文基本功扎实，也能兼顾润色等其他任务",
        hf_repo: "Qwen/Qwen3-4B-Instruct-2507-GGUF",
        gguf: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        size_mb: 2390,
    },
    LocalLlmModel {
        id: "gemma-3-4b-it",
        name: "Gemma-3-4B-it",
        desc: "Google 多语种 4B，欧语对（法/德/西）翻译占优",
        hf_repo: "unsloth/gemma-3-4b-it-GGUF",
        gguf: "gemma-3-4b-it-Q4_K_M.gguf",
        size_mb: 2600,
    },
];

pub fn find(id: &str) -> Option<&'static LocalLlmModel> {
    MODELS.iter().find(|m| m.id == id)
}

/// 配置引用的模型（未知 id 回退默认，避免手改配置后引擎失效）
pub fn resolve(id: &str) -> &'static LocalLlmModel {
    find(id).unwrap_or(&MODELS[0])
}

/// 端口段与 Qwen3-ASR（18279+）错开：两个引擎可同时常驻
const BASE_PORT: u16 = 18320;
/// 引擎冷启动（加载模型，1.3~5.5GB 视所选档位）最长等待
const BOOT_TIMEOUT: Duration = Duration::from_secs(180);
/// 与 ASR 引擎分开的日志文件（共用 runtime 目录）
const LOG_FILE: &str = "server-llm.log";

/* ---------- 路径与状态 ---------- */

fn config_dir(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_config_dir()
        .context("无法定位配置目录")
}

fn model_dir(app: &AppHandle, id: &str) -> Result<PathBuf> {
    Ok(config_dir(app)?.join("models").join(id))
}

pub fn model_files_ok(app: &AppHandle, id: &str) -> bool {
    let m = resolve(id);
    model_dir(app, m.id)
        .map(|d| d.join(m.gguf).exists())
        .unwrap_or(false)
}

pub fn status(app: &AppHandle) -> Vec<LocalModelStatus> {
    let backend = crate::qwen_asr::runtime_backend(app).unwrap_or_default();
    MODELS
        .iter()
        .map(|m| LocalModelStatus {
            id: m.id.into(),
            name: m.name.into(),
            desc: m.desc.to_string(),
            size_mb: m.size_mb,
            downloaded: model_files_ok(app, m.id),
            kind: Some("llm".into()),
            runtime_ready: Some(crate::qwen_asr::runtime_ok(app)),
            backend: (!backend.is_empty()).then_some(backend.clone()),
        })
        .collect()
}

/* ---------- 下载（模型走 HF 官方源或「语音识别」页配置的镜像；运行时复用 ASR 的） ---------- */

static DOWNLOADING: AtomicBool = AtomicBool::new(false);

pub async fn download(app: &AppHandle, id: &str) -> Result<()> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        bail!("已有模型下载任务进行中");
    }
    let res = download_inner(app, id).await;
    DOWNLOADING.store(false, Ordering::SeqCst);
    crate::bump_models_gen();
    let _ = app.emit("sn-models-changed", ());
    res
}

async fn download_inner(app: &AppHandle, id: &str) -> Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        bail!("本地翻译引擎目前仅支持 Windows（跟随 llama.cpp 运行时现状）");
    }
    #[cfg(target_os = "windows")]
    {
        let m = find(id).ok_or_else(|| anyhow!("未知模型: {id}"))?;
        let emit_app = app.clone();
        let model_id = m.id.to_string();
        let progress = move |file: &str, dl: u64, total: u64| {
            let _ = emit_app.emit(
                "sn-model-progress",
                serde_json::json!({
                    "model": model_id,
                    "file": file,
                    "downloaded": dl,
                    "total": total,
                }),
            );
        };
        // llama.cpp 运行时与 Qwen3-ASR 共享一份（含显卡自动检测）
        if !crate::qwen_asr::runtime_ok(app) {
            crate::qwen_asr::download_runtime(app, None, &progress).await?;
        }
        let dir = model_dir(app, m.id)?;
        tokio::fs::create_dir_all(&dir).await.ok();
        // 下载镜像沿用「语音识别」页的设置（HF 官方源在国内不稳时切 hf-mirror.com）
        let mirror = app
            .state::<crate::Ctx>()
            .config
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|c| c.asr.mirror.trim().trim_end_matches('/').to_string())
            .unwrap_or_default();
        let base = if mirror.is_empty() || mirror.contains("huggingface.co") {
            format!("https://huggingface.co/{}", m.hf_repo)
        } else {
            format!("{mirror}/{}", m.hf_repo)
        };
        crate::qwen_asr::fetch_file(
            &format!("{base}/resolve/main/{}", m.gguf),
            &dir.join(m.gguf),
            m.gguf,
            &progress,
        )
        .await
    }
}

/* ---------- llama-server 子进程管理（与 ASR 引擎互相独立、互不误杀） ---------- */

struct ServerState {
    child: Option<Child>,
    port: u16,
    /// 最近一次使用（ensure_server 放行）时刻：空闲自动释放的判定依据
    last_used: Instant,
    /// 最近一次健康探测成功时刻：60s 内复用，免去逐次 HTTP /health
    health_ok_at: Option<Instant>,
}

static SERVER: LazyLock<Mutex<Option<ServerState>>> = LazyLock::new(|| Mutex::new(None));
static SPAWN_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// 当前翻译引擎子进程 PID（Qwen3-ASR 的孤儿清理据此避让活跃实例）
pub fn tracked_pid() -> Option<u32> {
    SERVER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .and_then(|st| st.child.as_ref().map(|c| c.id()))
}

/// 终止遗留的 llama-server（仅本 runtime 目录内、且不属于任一活跃引擎的实例）
#[cfg(target_os = "windows")]
fn kill_leftover_runtimes(app: &AppHandle) -> usize {
    use std::mem::size_of;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };

    let Ok(dir) = crate::qwen_asr::runtime_dir(app) else {
        return 0;
    };
    let dir_lower = dir.to_string_lossy().to_lowercase();
    let mut killed = 0usize;
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return 0;
        };
        let mut e = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut more = Process32FirstW(snap, &mut e).is_ok();
        while more {
            let name = String::from_utf16_lossy(&e.szExeFile)
                .trim_end_matches('\0')
                .to_lowercase();
            // ASR 引擎的活跃实例不在此清理（它有自己的管理路径）
            if name == "llama-server.exe"
                && crate::qwen_asr::tracked_pid() != Some(e.th32ProcessID)
            {
                let rights = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE;
                if let Ok(h) = OpenProcess(rights, false, e.th32ProcessID) {
                    let mut buf = [0u16; 1024];
                    let mut len = buf.len() as u32;
                    if QueryFullProcessImageNameW(
                        h,
                        PROCESS_NAME_FORMAT(0),
                        PWSTR(buf.as_mut_ptr()),
                        &mut len,
                    )
                    .is_ok()
                    {
                        let path =
                            String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
                        if path.starts_with(&dir_lower) && TerminateProcess(h, 1).is_ok() {
                            killed += 1;
                        }
                    }
                    let _ = CloseHandle(h);
                }
            }
            more = Process32NextW(snap, &mut e).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    killed
}

#[cfg(not(target_os = "windows"))]
fn kill_leftover_runtimes(_app: &AppHandle) -> usize {
    0
}

pub fn shutdown(app: &AppHandle) {
    if let Some(st) = SERVER.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
        if let Some(mut c) = st.child {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
    kill_leftover_runtimes(app);
}

/// 空闲自动释放（省内存模式）：语义与 qwen_asr::idle_shutdown 一致，持
/// SPAWN_LOCK 与 ensure_server 串行防「放行后即杀」竞态
pub fn idle_shutdown(app: &AppHandle, idle: Duration) {
    let _guard = SPAWN_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let idle_hit = SERVER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .is_some_and(|st| st.last_used.elapsed() >= idle);
    if idle_hit {
        eprintln!(
            "[speaknow] 本地翻译引擎空闲超过 {} 分钟，自动释放内存",
            idle.as_secs() / 60
        );
        shutdown(app);
    }
}

fn health(base: &str) -> bool {
    matches!(
        crate::http::CLIENT_BLOCKING.get(format!("{base}/health")).send(),
        Ok(r) if r.status().is_success()
    )
}

fn find_free_port() -> Option<u16> {
    (BASE_PORT..BASE_PORT + 20)
        .find(|p| std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
}

fn log_tail(app: &AppHandle) -> String {
    let Ok(dir) = crate::qwen_asr::runtime_dir(app) else {
        return String::new();
    };
    let Ok(bytes) = std::fs::read(dir.join(LOG_FILE)) else {
        return String::new();
    };
    let start = bytes.len().saturating_sub(1200);
    String::from_utf8_lossy(&bytes[start..]).trim().to_string()
}

/// 确保本地翻译 llama-server 已启动并健康，返回 base URL（阻塞，需在
/// spawn_blocking 中调用）。翻译卡片在等待期间会收到「引擎启动中」提示
pub fn ensure_server(app: &AppHandle) -> Result<String> {
    let _guard = SPAWN_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);

    // 1) 已有子进程且健康
    {
        let mut g = SERVER.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(st) = g.as_mut() {
            let alive = st
                .child
                .as_mut()
                .map(|c| c.try_wait().map(|o| o.is_none()).unwrap_or(false))
                .unwrap_or(true);
            let base = format!("http://127.0.0.1:{}", st.port);
            // 健康探测 60s 内复用（同 qwen_asr：逐次 /health 在引擎忙时最坏
            // 白等 2s，进程活着 + 近期探活成功即放行）
            let recently_ok = st
                .health_ok_at
                .is_some_and(|t| t.elapsed() < Duration::from_secs(60));
            if alive && (recently_ok || health(&base)) {
                st.last_used = Instant::now();
                st.health_ok_at = Some(Instant::now());
                return Ok(base);
            }
            *g = None;
        }
    }

    // 2) 清掉本引擎遗留的实例（避开 ASR 引擎的活跃进程）
    kill_leftover_runtimes(app);

    // 3) 前置检查
    let cfg_model = app
        .state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .map(|c| c.translate.local_model.clone())
        .unwrap_or_default();
    let m = resolve(&cfg_model);
    if !model_files_ok(app, m.id) {
        bail!("本地翻译模型未下载：请在「翻译」页下载（或切回云端引擎）");
    }
    let exe = crate::qwen_asr::runtime_exe(app)?;
    if !exe.exists() {
        bail!("llama.cpp 运行时缺失：点击模型卡片的「↓ 下载」可自动补全");
    }
    let mut backend = crate::qwen_asr::runtime_backend(app).unwrap_or_else(|| "cpu".into());
    let gguf = model_dir(app, m.id)?.join(m.gguf);

    // 4) 启动（vulkan 初始化失败自动换 CPU 运行时重试一次）
    for attempt in 0..2 {
        let port = find_free_port().ok_or_else(|| {
            anyhow!("端口 {BASE_PORT}-{} 均被占用，无法启动本地翻译引擎", BASE_PORT + 19)
        })?;
        let log_path = crate::qwen_asr::runtime_dir(app)?.join(LOG_FILE);
        if let Some(p) = log_path.parent() {
            std::fs::create_dir_all(p).ok();
        }
        let mut cmd = Command::new(&exe);
        cmd.arg("-m").arg(&gguf)
            .args(["--host", "127.0.0.1", "--port"])
            .arg(port.to_string())
            .arg("--no-webui")
            // 4B 模型 KV 缓存开大：长文翻译的提示词 + 8K 输出预算才放得下
            .arg("-c").arg("16384")
            .current_dir(exe.parent().unwrap_or(std::path::Path::new(".")));
        if backend == "vulkan" {
            cmd.arg("-ngl").arg("99");
        }
        if let Ok(l) = std::fs::File::create(&log_path) {
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
        // 挂进与 ASR 引擎同一个 Job：应用无论怎么退出，两个引擎一起被内核收掉
        crate::qwen_asr::assign_to_job(&child);

        let base = format!("http://127.0.0.1:{port}");
        let start = Instant::now();
        let mut last_note = Instant::now() - Duration::from_secs(4);
        loop {
            if let Ok(Some(_)) = child.try_wait() {
                let tail = log_tail(app);
                let vulkan_fail = backend == "vulkan" && tail.to_lowercase().contains("vulkan");
                if vulkan_fail && attempt == 0 {
                    eprintln!("[speaknow] 翻译引擎 Vulkan 初始化失败，切换 CPU 运行时：{tail}");
                    let a = app.clone();
                    let _ = tauri::async_runtime::block_on(crate::qwen_asr::download_runtime(
                        &a,
                        Some("cpu"),
                        &|_, _, _| {},
                    ));
                    backend = "cpu".into();
                    break;
                }
                bail!("翻译引擎启动即退出：{}", truncate(&tail, 400));
            }
            if health(&base) {
                eprintln!("[speaknow] 本地翻译引擎就绪：{base}（{backend}，{}）", m.id);
                *SERVER.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
                    Some(ServerState {
                        child: Some(child),
                        port,
                        last_used: Instant::now(),
                        health_ok_at: Some(Instant::now()),
                    });
                return Ok(base);
            }
            if start.elapsed() > BOOT_TIMEOUT {
                let _ = child.kill();
                let _ = child.wait();
                bail!(
                    "本地翻译引擎启动超时（{}s）：{}",
                    BOOT_TIMEOUT.as_secs(),
                    truncate(&log_tail(app), 300)
                );
            }
            if last_note.elapsed() >= Duration::from_secs(5) {
                // 本地翻译引擎只服务翻译链路（ensure_server 的调用方是翻译会话
                // 与启动预热的同款引擎），启动提示归属 translate 流：翻译卡/
                // 工作台监听器只消费 scope=translate 的增量，误标 llm 会让
                // 「引擎启动中」提示从翻译卡上凭空消失
                let _ = app.emit(
                    "sn-llm-delta",
                    crate::llm::delta_payload(
                        crate::llm::SCOPE_TRANSLATE,
                        "reasoning",
                        "本地翻译引擎启动中…（首次加载模型需十几秒）\n",
                        None,
                    ),
                );
                last_note = Instant::now();
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }
    bail!("本地翻译引擎启动失败：{}", truncate(&log_tail(app), 300))
}
