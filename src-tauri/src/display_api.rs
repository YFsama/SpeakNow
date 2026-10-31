//! 外接显示 API：把聆听窗口（悬浮窗）的全部字幕事件同步推送给外接硬件。
//!
//! 对外提供端点（默认 http://127.0.0.1:8866）：
//! - `GET /display`      内置远程显示页，任何带浏览器的设备打开即是一块字幕屏
//! - `GET /api/events`   WebSocket 事件流（预留 API，供客户自行开发硬件端）
//! - `GET /api/status`   JSON 服务信息（健康检查 / 预留）
//! - `GET /mem/search`   记忆库检索（只读 JSON；loopback 免钥，远程须带
//!   `X-SN-API-Key`，见下方「/mem/* 安全口径」）
//! - `GET /mem/context.md` 工作记忆 markdown（只读，供外部工具拼接上下文，
//!   鉴权口径同 /mem/search）
//!
//! 事件信封：`{"v":1,"type":"status|partial|raw|result|delta|level|meta|target|review|retryable|gain-learned|hello","data":{...},"ts":...}`
//! 客户端必须忽略未知 type 与未知字段（前向兼容），详见 docs/external-display-api.md。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use tauri::{AppHandle, Manager};
use tokio::sync::{broadcast, watch};

use crate::config::ExternalDisplayConfig;

/// API 协议版本：信封结构发生不兼容变更时 +1，客户端按 v 判断
pub const PROTOCOL_VERSION: u32 = 1;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ---------- 事件广播总线 ---------- */

static BUS: OnceLock<broadcast::Sender<String>> = OnceLock::new();

fn bus() -> &'static broadcast::Sender<String> {
    BUS.get_or_init(|| broadcast::channel(256).0)
}

/// 事件入口：pipeline/llm/overlay 的每条 sn-* 事件都经此转发给已连接的外接设备。
/// 无连接时 send 返回错误，直接忽略（零开销）。
pub fn publish(name: &str, payload: &serde_json::Value) {
    // 无订阅者直接返回：信封构造 + 序列化在录音期每 100ms（sn-level）、
    // AI 流式期每个 token 都会跑一次，白产生分配与 CPU
    if bus().receiver_count() == 0 {
        return;
    }
    // 线名 = 内部事件名去掉 sn- 前缀；个别名称按对外文档口径归一
    // （sn-llm-delta → delta，与 remote_display.html / API 文档一致）
    let ty = match name.strip_prefix("sn-").unwrap_or(name) {
        "llm-delta" => "delta",
        other => other,
    };
    let envelope = serde_json::json!({
        "v": PROTOCOL_VERSION,
        "type": ty,
        "data": payload,
        "ts": now_ms(),
    });
    let _ = bus().send(envelope.to_string());
}

/* ---------- 服务生命周期 ---------- */

struct Running {
    port: u16,
    allow_lan: bool,
    shutdown: watch::Sender<bool>,
}

static SERVER: Mutex<Option<Running>> = Mutex::new(None);
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// /mem/* 端点的 AppHandle 来源：axum 侧拿不到 Tauri 上下文，而本模块的
/// apply 调用点不传 app。Tauri 2 没有全局句柄，由 lib.rs 的 setup 钩子在
/// 启动期登记一次（先于本服务线程 spawn）。OnceLock 首写为准，重复登记
/// 静默忽略；服务在线但句柄未就绪属极早期竞态，端点按 500 文本报告
static APP: OnceLock<AppHandle> = OnceLock::new();

/// 登记 AppHandle（由 lib.rs setup 在启动期调用，见 APP 注释）
pub fn set_app_handle(app: AppHandle) {
    let _ = APP.set(app);
}

/// 按配置启停服务。仅 enabled/port/allowLan 变化才重启；
/// hideLocalOverlay 属于本地行为，无需动服务（已连接的硬件不断线）。
pub fn apply(cfg: &ExternalDisplayConfig) {
    let mut guard = SERVER.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(r) = guard.as_ref() {
        if cfg.enabled && r.port == cfg.port && r.allow_lan == cfg.allow_lan {
            return;
        }
    }
    if let Some(r) = guard.take() {
        let _ = r.shutdown.send(true);
    }
    *LAST_ERROR.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    if !cfg.enabled {
        return;
    }

    let bind_ip = if cfg.allow_lan { "0.0.0.0" } else { "127.0.0.1" };
    let port = cfg.port;
    let (shut_tx, shut_rx) = watch::channel(false);
    // 绑定结果回传：同步等待（正常 <50ms；端口被占时重试至 ~2.4s）
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    tauri::async_runtime::spawn(async move {
        match bind_with_retry(bind_ip, port).await {
            Ok(listener) => {
                let _ = ready_tx.send(Ok(()));
                let mut rx = shut_rx;
                // into_make_service_with_connect_info：把 TCP 对端地址注入
                // 请求扩展，/mem/* 鉴权据此判定 loopback（axum 标准做法，
                // 不启用则 handler 拿不到来源 IP）
                let serve = axum::serve(
                    listener,
                    router().into_make_service_with_connect_info::<std::net::SocketAddr>(),
                )
                .with_graceful_shutdown(async move {
                    let _ = rx.wait_for(|v| *v).await;
                });
                if let Err(e) = serve.await {
                    eprintln!("[speaknow] 外接显示服务异常退出: {e}");
                }
            }
            Err(e) => {
                let _ = ready_tx.send(Err(format!("端口 {port} 监听失败：{e}")));
            }
        }
    });

    match ready_rx.recv_timeout(Duration::from_millis(4000)) {
        Ok(Ok(())) => {
            *guard = Some(Running {
                port,
                allow_lan: cfg.allow_lan,
                shutdown: shut_tx,
            });
        }
        Ok(Err(e)) => *LAST_ERROR.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(e),
        Err(_) => {
            // 就绪超时但服务线程可能仍在绑定/启动：同样登记 Running（带
            // shutdown 句柄），否则这个可能存活的服务变成无主进程，
            // 下次 apply 停不掉、status 也看不到
            *LAST_ERROR.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some("服务启动超时".into());
            *guard = Some(Running {
                port,
                allow_lan: cfg.allow_lan,
                shutdown: shut_tx,
            });
        }
    }
}

/// 同端口重启时旧监听需要片刻才释放，仅对 AddrInUse 重试
async fn bind_with_retry(
    ip: &str,
    port: u16,
) -> std::io::Result<tokio::net::TcpListener> {
    let mut last: Option<std::io::Error> = None;
    for _ in 0..12 {
        match tokio::net::TcpListener::bind((ip, port)).await {
            Ok(l) => return Ok(l),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                last = Some(e);
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap())
}

/// 当前服务状态（供设置页展示）
pub fn status() -> serde_json::Value {
    let guard = SERVER.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let error = LAST_ERROR.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    match guard.as_ref() {
        Some(r) => serde_json::json!({
            "running": true,
            "port": r.port,
            "allowLan": r.allow_lan,
            "urls": urls(r.port, r.allow_lan),
            "error": error,
        }),
        None => serde_json::json!({
            "running": false,
            "urls": [],
            "error": error,
        }),
    }
}

/// 主网卡局域网 IP（UDP connect 探测路由，不真正发包）
fn primary_lan_ip() -> Option<std::net::IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    s.local_addr().ok().map(|a| a.ip())
}

fn urls(port: u16, allow_lan: bool) -> Vec<String> {
    let mut v = vec![format!("http://127.0.0.1:{port}/display")];
    if allow_lan {
        if let Some(ip) = primary_lan_ip() {
            v.push(format!("http://{ip}:{port}/display"));
        }
    }
    v
}

/* ---------- HTTP / WS 路由 ---------- */

fn router() -> axum::Router {
    axum::Router::new()
        .route("/", get(display_page))
        .route("/display", get(display_page))
        .route("/api/events", get(events_ws))
        .route("/api/status", get(api_status))
        .route("/mem/search", get(mem_search))
        .route("/mem/context.md", get(mem_context))
}

async fn display_page() -> Html<&'static str> {
    Html(include_str!("../assets/remote_display.html"))
}

async fn api_status() -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "app": "SpeakNow",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": PROTOCOL_VERSION,
        "events": "/api/events",
    }))
}

async fn events_ws(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(client_socket)
}

async fn client_socket(mut socket: WebSocket) {
    let hello = serde_json::json!({
        "v": PROTOCOL_VERSION,
        "type": "hello",
        "data": {
            "app": "SpeakNow",
            "version": env!("CARGO_PKG_VERSION"),
            "protocol": PROTOCOL_VERSION,
        },
        "ts": now_ms(),
    })
    .to_string();
    if socket.send(Message::Text(hello.into())).await.is_err() {
        return;
    }
    let mut rx = bus().subscribe();
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(msg) => {
                    if socket.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                // 慢客户端丢帧继续（电平类事件允许丢，字幕类事件很快跟上下一条）
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            inc = socket.recv() => match inc {
                None | Some(Ok(Message::Close(_))) => break,
                // Ping 由协议层自动应答；其余客户端消息忽略（预留硬件上行指令）
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            },
        }
    }
}

// ---------- /mem 只读记忆端点 ----------
//
// 安全口径（Nowledge Mem 式「同机免钥、远程必钥」）：
// - **loopback 免钥**：来源 IP 是 127.0.0.1/::1 时不校验令牌。本机 AI 工具
//   零配置即用；要求本机也带钥只会把令牌摊到每台机器的 rc 文件里——能发
//   起本机请求的进程已在用户会话内，它能读的配置/环境变量不比这个 REST
//   端点多多少，免钥没有降低实质安全，可用性收益却很大。
// - **非 loopback 必须带令牌**（即 allowLan 开启后的局域网访问）：请求头
//   `X-SN-API-Key` 与 cfg.mem.api_token 完全相等才放行，否则 401 纯文本。
//   LAN 是不可信网络（咖啡店 Wi-Fi 同网段即可探测），记忆库含全部听写/
//   OCR/翻译历史，必须挡在令牌之后。
// - **api_token 为空 = 未生成 = 从未授权过远程**：非 loopback 一律 401
//   （fail-closed，文案引导去设置页生成）。不能因「用户还没来得及生成」
//   就默认放行。
// - **拿不到对端地址按非 loopback 处理**（fail-closed）：该情形只应出现
//   在路由误配等异常路径，误拒的代价远低于误放。
// - **错钥不计节流**：v1 从简，重复错钥与正常请求同等待遇；后续可加指数
//   退避的 429（令牌为长随机串，短窗口穷举本就不可行）。

/// 401 文案：缺钥/错钥。不区分两种情况，避免给探测者「键存在与否」的反馈
const UNAUTHORIZED_KEY_MSG: &str = "unauthorized: missing or invalid X-SN-API-Key";
/// 401 文案：令牌从未生成——引导去设置页生成后再来（空令牌 = 未授权远程）
const UNAUTHORIZED_NO_TOKEN_MSG: &str = "unauthorized: no API token generated; \
generate one in SpeakNow settings (Memory page), then send it as X-SN-API-Key";

/// /mem/* 鉴权判定（两个 handler 顶部调用）。
/// Ok = 放行；Err(文案) = 401 纯文本拒绝。
///
/// 令牌按请求实时读配置锁（`mem.api_token`），轮换立即生效、无需重启服务；
/// 锁内只 clone 一个短字符串，持有微秒级且不跨 await，不阻塞事件循环。
fn mem_authorized(
    app: Option<&AppHandle>,
    remote: Option<std::net::SocketAddr>,
    headers: &HeaderMap,
) -> Result<(), &'static str> {
    // 免钥面严格限定 loopback：本机工具零配置可用
    if remote.is_some_and(|a| a.ip().is_loopback()) {
        // 防 DNS rebinding：对端虽是 loopback，但恶意网页可把自有域名解析到
        // 127.0.0.1，让浏览器的同源请求「来自本机」免钥读走全部记忆。
        // 浏览器请求必带 Host 头且值为发起域名——Host 不是回环名即按远程
        // 处理（落入令牌校验）。无 Host 头的老 HTTP/1.0 客户端按直连放行
        match headers.get(axum::http::header::HOST).and_then(|v| v.to_str().ok()) {
            None => return Ok(()),
            Some(h) => {
                // "127.0.0.1:8866"→"127.0.0.1"、"[::1]:8866"→"[::1]"；
                // 裸 "::1"（无端口）单独比对
                let host = h.split(':').next().unwrap_or("");
                if matches!(host, "127.0.0.1" | "localhost" | "[::1]") || h == "::1" {
                    return Ok(());
                }
            }
        }
    }
    // 以下全部按「远程」从严：app 未就绪（读不到令牌）视同无法鉴权，拒绝
    let Some(app) = app else {
        return Err(UNAUTHORIZED_KEY_MSG);
    };
    let token = mem_api_token(app);
    if token.is_empty() {
        return Err(UNAUTHORIZED_NO_TOKEN_MSG);
    }
    // 头值非 ASCII 时 to_str 失败 → 视同无效钥（fail-closed）
    let Some(key) = headers.get("X-SN-API-Key").and_then(|v| v.to_str().ok()) else {
        return Err(UNAUTHORIZED_KEY_MSG);
    };
    if constant_time_eq(key.as_bytes(), token.as_bytes()) {
        Ok(())
    } else {
        Err(UNAUTHORIZED_KEY_MSG)
    }
}

/// 实时读配置里的 mem.api_token。配置 Mutex 还没装入（极早期）时按空处理
/// （= 未生成 = fail-closed）
fn mem_api_token(app: &AppHandle) -> String {
    app.state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .map(|c| c.mem.api_token.clone())
        .unwrap_or_default()
}

/// 恒定时间字节相等比较（防时序侧信道）：逐字节异或、取或累积，最后统一
/// 判零——中途绝不提前返回，耗时与「匹配前缀长度」无关，攻击者无法按响应
/// 时间逐字节猜令牌。长度先比较（长度不是秘密：令牌生成即定长；subtle 的
/// ct_eq 同样要求等长输入）。不引入 subtle crate，本场景 10 行足够。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// GET /mem/search?q=<空格分词的查询>&k=<条数上限>&kind=<本期忽略>
///
/// 返回 `200 {"items":[MemEntry...],"total":<全库条数>}`：
/// - q 缺省/为空 → mem_recall 的空查询语义：最近序（置顶优先，其余 ts
///   新→旧），与前端记忆页空搜索同口径
/// - k 缺省 10，上限 50，clamp 下限 1（0 会导致空结果，视同默认更直观）
/// - kind 本期忽略：mem_recall 只收 query/limit，保留参数位兼容前端
///   /mem 面板既有调用习惯
/// - total 是全库条数（不受 q/k 过滤影响），复用 mem_list(limit=0) 取统计
///   ——mem_list 是 pub 命令函数且统计本就对整库口径，不再新造只读计数 API
///
/// 错误统一 500 纯文本（与现有端点的朴素风格一致，不上 JSON 错误封套）
async fn mem_search(
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let Err(msg) = mem_authorized(APP.get(), Some(addr), &headers) {
        return (StatusCode::UNAUTHORIZED, msg).into_response();
    }
    let Some(app) = APP.get().cloned() else {
        return mem_error("AppHandle 尚未就绪（服务早于应用初始化完成）");
    };
    let q = params.get("q").cloned().unwrap_or_default();
    let k = params
        .get("k")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(10)
        .clamp(1, 50);
    // mem_recall / mem_list 都是同步文件 IO（读 mem.json 反序列化），转
    // 阻塞线程池：axum 与 sn-* 事件共享 tauri::async_runtime 的 worker，
    // 大库检索不能占住它们
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let items = crate::mem::mem_recall(app.clone(), q, k);
        let total = crate::mem::mem_list(app, String::new(), None, 0).total;
        serde_json::to_string(&serde_json::json!({ "items": items, "total": total }))
    })
    .await;
    match joined {
        Ok(Ok(body)) => ([(header::CONTENT_TYPE, "application/json")], body).into_response(),
        Ok(Err(e)) => mem_error(&format!("记忆检索结果序列化失败: {e}")),
        Err(e) => mem_error(&format!("记忆检索任务执行失败: {e}")),
    }
}

/// GET /mem/context.md → 200，`Content-Type: text/markdown; charset=utf-8`，
/// body 为工作记忆 markdown（mem::context_markdown）。同样走阻塞线程池
async fn mem_context(
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(msg) = mem_authorized(APP.get(), Some(addr), &headers) {
        return (StatusCode::UNAUTHORIZED, msg).into_response();
    }
    let Some(app) = APP.get().cloned() else {
        return mem_error("AppHandle 尚未就绪（服务早于应用初始化完成）");
    };
    let joined =
        tauri::async_runtime::spawn_blocking(move || crate::mem::context_markdown(&app)).await;
    match joined {
        Ok(md) => (
            [(header::CONTENT_TYPE, "text/markdown; charset=utf-8")],
            md,
        )
            .into_response(),
        Err(e) => mem_error(&format!("记忆上下文生成失败: {e}")),
    }
}

/// /mem/* 统一错误出口：500 + 纯文本
fn mem_error(msg: &str) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, msg.to_string()).into_response()
}
