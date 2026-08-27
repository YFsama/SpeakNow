//! 外接显示 API：把聆听窗口（悬浮窗）的全部字幕事件同步推送给外接硬件。
//!
//! 对外提供三个端点（默认 http://127.0.0.1:8866）：
//! - `GET /display`      内置远程显示页，任何带浏览器的设备打开即是一块字幕屏
//! - `GET /api/events`   WebSocket 事件流（预留 API，供客户自行开发硬件端）
//! - `GET /api/status`   JSON 服务信息（健康检查 / 预留）
//!
//! 事件信封：`{"v":1,"type":"status|partial|raw|result|delta|level|meta|target|hello","data":{...},"ts":...}`
//! 客户端必须忽略未知 type 与未知字段（前向兼容），详见 docs/external-display-api.md。

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
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
    let ty = name.strip_prefix("sn-").unwrap_or(name);
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

/// 按配置启停服务。仅 enabled/port/allowLan 变化才重启；
/// hideLocalOverlay 属于本地行为，无需动服务（已连接的硬件不断线）。
pub fn apply(cfg: &ExternalDisplayConfig) {
    let mut guard = SERVER.lock().unwrap();
    if let Some(r) = guard.as_ref() {
        if cfg.enabled && r.port == cfg.port && r.allow_lan == cfg.allow_lan {
            return;
        }
    }
    if let Some(r) = guard.take() {
        let _ = r.shutdown.send(true);
    }
    *LAST_ERROR.lock().unwrap() = None;
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
                let serve = axum::serve(listener, router()).with_graceful_shutdown(async move {
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
        Ok(Err(e)) => *LAST_ERROR.lock().unwrap() = Some(e),
        Err(_) => *LAST_ERROR.lock().unwrap() = Some("服务启动超时".into()),
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
    let guard = SERVER.lock().unwrap();
    let error = LAST_ERROR.lock().unwrap().clone();
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
