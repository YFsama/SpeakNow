use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use serde_json::Value;
use tauri::AppHandle;

use crate::asr::truncate;
use crate::config::LlmConfig;
use crate::events;

/// 把 ASR 原始转写交给大模型纠错/优化
pub async fn optimize(cfg: &LlmConfig, raw: &str) -> anyhow::Result<String> {
    let base = cfg.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        bail!("尚未配置 AI 优化接口地址");
    }
    if cfg.model.trim().is_empty() {
        bail!("尚未配置 AI 优化模型名称");
    }
    let url = format!("{base}/chat/completions");

    let system = build_system_prompt(cfg);
    let user = if cfg.custom_prompt.trim().is_empty() {
        raw.to_string()
    } else {
        cfg.custom_prompt.replace("{text}", raw)
    };
    // 中文约 1 字 1 token，留出格式余量
    let max_tokens = (400 + raw.chars().count() * 2).min(4096);

    let body = serde_json::json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": 0.2,
        "max_tokens": max_tokens
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(cfg.timeout_sec.max(5)))
        .build()?;
    let mut req = client.post(&url).json(&body);
    if !cfg.api_key.trim().is_empty() {
        req = req.bearer_auth(cfg.api_key.trim());
    }

    let resp = req.send().await.context("AI 优化请求失败，请检查网络或代理设置")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("AI 服务返回 {}: {}", status, truncate(text.trim(), 300));
    }

    let v: Value =
        serde_json::from_str(&text).map_err(|_| anyhow!("AI 响应解析失败"))?;
    let content = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("AI 响应缺少 content: {}", truncate(&text, 200)))?;
    Ok(clean(content))
}

/// 流式优化：SSE 逐 token 经 sn-llm-delta 事件推给悬浮窗（content 逐字上屏、
/// reasoning_content 以「思考中」暗色小字展示），返回完整正文。
/// `first_token_ms`：可选输出——首个正文 token 的耗时（流式体验的关键指标）。
/// 接口不支持 stream 或流式全程未产出内容时，自动回退非流式请求。
pub async fn optimize_streaming(
    cfg: &LlmConfig,
    raw: &str,
    app: &AppHandle,
    first_token_ms: Option<&std::sync::atomic::AtomicU64>,
) -> anyhow::Result<String> {
    let t0 = std::time::Instant::now();
    let base = cfg.base_url.trim().trim_end_matches('/');
    if base.is_empty() || cfg.model.trim().is_empty() {
        return optimize(cfg, raw).await;
    }
    let url = format!("{base}/chat/completions");
    let system = build_system_prompt(cfg);
    let user = if cfg.custom_prompt.trim().is_empty() {
        raw.to_string()
    } else {
        cfg.custom_prompt.replace("{text}", raw)
    };
    let max_tokens = (400 + raw.chars().count() * 2).min(4096);
    let body = serde_json::json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": 0.2,
        "max_tokens": max_tokens,
        "stream": true
    });

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(cfg.timeout_sec.max(5)))
        .build()
    {
        Ok(c) => c,
        Err(_) => return optimize(cfg, raw).await,
    };
    let mut req = client.post(&url).json(&body);
    if !cfg.api_key.trim().is_empty() {
        req = req.bearer_auth(cfg.api_key.trim());
    }

    let mut resp = match req.send().await {
        Ok(r) if r.status().is_success() => r,
        // 不支持 stream 的网关等：静默回退非流式
        _ => return optimize(cfg, raw).await,
    };

    let mut acc = String::new();
    let mut buf = String::new();
    while let Some(chunk) = resp.chunk().await.context("AI 优化流式连接中断")? {
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line: String = buf.drain(..=pos).collect();
            let line = line.trim();
            if !line.starts_with("data:") {
                continue;
            }
            let data = line[5..].trim();
            if data == "[DONE]" || data.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            // 思考型模型先流 reasoning_content（推理过程），正文在 content
            if let Some(rc) = v
                .pointer("/choices/0/delta/reasoning_content")
                .and_then(Value::as_str)
            {
                if !rc.is_empty() {
                    events::emit(
                        app,
                        "sn-llm-delta",
                        serde_json::json!({ "kind": "reasoning", "delta": rc }),
                    );
                }
            }
            if let Some(c) = v.pointer("/choices/0/delta/content").and_then(Value::as_str) {
                if !c.is_empty() {
                    if let Some(ft) = first_token_ms {
                        if ft.load(std::sync::atomic::Ordering::Relaxed) == 0 {
                            ft.store(
                                t0.elapsed().as_millis() as u64,
                                std::sync::atomic::Ordering::Relaxed,
                            );
                        }
                    }
                    acc.push_str(c);
                    events::emit(
                        app,
                        "sn-llm-delta",
                        serde_json::json!({ "kind": "content", "delta": c, "text": acc }),
                    );
                }
            }
        }
    }
    if acc.trim().is_empty() {
        return optimize(cfg, raw).await;
    }
    Ok(clean(&acc))
}

fn build_system_prompt(cfg: &LlmConfig) -> String {
    let mut p = String::new();
    match cfg.mode.as_str() {
        "polish" => p.push_str(
            "你是语音输入的文本整理助手。用户给你一段语音识别(ASR)的原始转录文本，请：\
             1) 纠正错别字、同音字与标点错误；\
             2) 将口语化表达整理为通顺、简洁的书面文字。\
             必须保留全部原意与信息，不得添加、删减或臆测内容，输出语言与原文一致。",
        ),
        "prompt" => p.push_str(
            "你是资深软件工程师的语音输入助手。用户正在对 AI 编程助手（如 Codex、Claude Code、ZCode）口述指令。\
             请将口语化的 ASR 转录整理为清晰、专业、结构良好的编程指令：纠正错别字与标点，理顺语句逻辑，\
             必要时用简洁的条目或步骤组织内容，但不改变用户意图、不虚构需求、不添加原文没有的内容。输出语言与原文一致。",
        ),
        _ => p.push_str(
            "你是专业的中英文语音转录校对助手。用户给你一段语音识别(ASR)的原始转录文本，\
             请只纠正其中的错别字、同音字、标点与专有名词错误，保持原句结构、用词和口语风格不变，\
             不要增删或改写内容，输出语言与原文一致。",
        ),
    }
    p.push_str("\n直接输出处理后的文本，不要输出任何解释、前后缀、markdown 代码块或引号。");

    let glossary: Vec<&str> = cfg
        .glossary
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if !glossary.is_empty() {
        p.push_str("\n\n专业术语表（专有名词请优先按以下写法纠正）：\n");
        for g in glossary {
            p.push_str(&format!("- {g}\n"));
        }
    }
    p
}

/// 去掉模型偶尔加上的代码块包裹或成对引号
fn clean(s: &str) -> String {
    let mut t = s.trim();
    if t.starts_with("```") {
        if let Some(nl) = t.find('\n') {
            t = t[nl + 1..].trim();
        }
        if let Some(p) = t.rfind("```") {
            t = t[..p].trim();
        }
    }
    let t = t.trim_matches(|c| {
        matches!(c, '"' | '“' | '”' | '\'' | '‘' | '’' | '「' | '」' | '`')
    });
    t.trim().to_string()
}
