//! 共享 HTTP 客户端：连接池 keep-alive + TLS 会话复用。此前云端 ASR / LLM /
//! 健康探测各自每次调用新建 reqwest::Client——每次听写白付 1~2 个完整的
//! TCP+TLS 握手（约 1-2 RTT），还会为阻塞客户端反复拉起内部运行时线程。
//! 超时一律按请求设置（RequestBuilder::timeout 会覆盖客户端级超时）。

use std::sync::LazyLock;
use std::time::Duration;

/// 异步客户端（云端 ASR / LLM 流式）。兜底超时 120s：现有调用点全部逐请求
/// `.timeout()` 覆盖，这里防的是未来新调用点忘写——无兜底时慢网关会让
/// 请求无限挂起并占住会话
pub static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .expect("构建 HTTP 客户端失败")
});

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
/// 无需 API Key）。ASR 的「是否可本地回退」、LLM 的「空 Key 是否跳过」与
/// 本地优先模式（local_only）的「LLM 是否出网」共用同一口径，避免判定漂移
pub fn is_local_base(base: &str) -> bool {
    let raw = base.trim().trim_end_matches('/');
    // 解析 URL 后对主机名精确匹配：旧的子串包含会把
    // "https://localhost.evil.com"、"https://user@127.0.0.1.evil.com"
    // 误判本机——local_only 据此放行 LLM 的话就是隐私破口。
    // 缺 scheme 的手填地址（"127.0.0.1:11434"、"localhost:8080"，后者
    // localhost 会被当成 scheme 而解析出空 host）补 http:// 再解析，
    // 保持旧实现的宽容；仍解析不出的一律按非本机——方向安全：至多
    // 多要求一次 Key / local_only 下多停一个端点，不会把数据放出网
    let host = reqwest::Url::parse(raw)
        .ok()
        .filter(|u| u.host_str().is_some())
        .or_else(|| reqwest::Url::parse(&format!("http://{raw}")).ok())
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()));
    matches!(
        host.as_deref(),
        // "::1" 与 "[::1]"：url crate 对 IPv6 host_str 保留方括号
        Some("localhost")
            | Some("127.0.0.1")
            | Some("0.0.0.0")
            | Some("::1")
            | Some("[::1]")
    )
}

#[cfg(test)]
mod tests {
    use super::is_local_base;

    #[test]
    fn local_hosts_match_exactly() {
        // 旧用例口径：四种本机写法 + 缺 scheme 的手填地址都识别
        assert!(is_local_base("http://127.0.0.1:11434/v1"));
        assert!(is_local_base("http://localhost:8080"));
        assert!(is_local_base("http://[::1]:8080/v1"));
        assert!(is_local_base("http://0.0.0.0:9000"));
        assert!(is_local_base("  https://LocalHost:443/api  "));
        assert!(is_local_base("127.0.0.1:11434"));
        assert!(is_local_base("localhost:8080/v1"));
    }

    #[test]
    fn lookalike_and_public_hosts_rejected() {
        // 子串命中但主机不同：不得放行（local_only 隐私判定共用此口径）
        assert!(!is_local_base("https://localhost.evil.com/api"));
        assert!(!is_local_base("http://127.0.0.1.evil.com/v1"));
        assert!(!is_local_base("http://[::1].evil.com"));
        assert!(!is_local_base("https://user@127.0.0.1.evil.com/v1"));
        assert!(!is_local_base("https://open.bigmodel.cn/api/paas/v4"));
        assert!(!is_local_base("https://api.deepseek.com"));
        assert!(!is_local_base(""));
        assert!(!is_local_base("not a url"));
    }
}
