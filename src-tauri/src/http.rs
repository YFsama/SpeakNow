//! 共享 HTTP 客户端：连接池 keep-alive + TLS 会话复用。此前云端 ASR / LLM /
//! 健康探测各自每次调用新建 reqwest::Client——每次听写白付 1~2 个完整的
//! TCP+TLS 握手（约 1-2 RTT），还会为阻塞客户端反复拉起内部运行时线程。
//! 超时一律按请求设置（RequestBuilder::timeout 会覆盖客户端级超时）。

use std::sync::LazyLock;
use std::time::Duration;

/// 异步客户端（云端 ASR / LLM 流式）。不设客户端级超时，逐请求 `.timeout()`
pub static CLIENT: LazyLock<reqwest::Client> =
    LazyLock::new(|| reqwest::Client::builder().build().expect("构建 HTTP 客户端失败"));

/// 阻塞客户端（llama-server 健康探测 / 本地转写）。默认 2s 探测超时，
/// 长请求逐请求 `.timeout()` 覆盖
pub static CLIENT_BLOCKING: LazyLock<reqwest::blocking::Client> =
    LazyLock::new(|| {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .expect("构建阻塞 HTTP 客户端失败")
    });

/// 是否本机自建服务（whisper.cpp server / Ollama / LM Studio / llama.cpp，
/// 无需 API Key）。ASR 的「是否可本地回退」与 LLM 的「空 Key 是否跳过」
/// 共用同一口径，避免两处判定漂移
pub fn is_local_base(base: &str) -> bool {
    let b = base.trim().to_lowercase();
    b.contains("localhost")
        || b.contains("127.0.0.1")
        || b.contains("0.0.0.0")
        || b.contains("[::1]")
}
