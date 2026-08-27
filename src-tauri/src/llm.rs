use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use serde_json::Value;
use tauri::AppHandle;

use crate::asr::truncate;
use crate::config::LlmConfig;
use crate::events;

/// 判断本次优化是否已过期（如已被新录音取代）；返回 true 时流式读取立即中止
pub type Superseded<'a> = Option<&'a (dyn Fn() -> bool + Send + Sync)>;

/// 构造 chat/completions 请求体（流式 / 非流式共用）。
/// 自定义指令存在时用户消息为指令模板（{text} 占位），系统提示改用中性版本，
/// 避免模式指令（如「保持口语风格」）与用户意图（如「翻译成英文」）互相打架。
fn request_body(cfg: &LlmConfig, raw: &str, stream: bool) -> Value {
    let system = build_system_prompt(cfg);
    let user = if cfg.custom_prompt.trim().is_empty() {
        raw.to_string()
    } else {
        cfg.custom_prompt.replace("{text}", raw)
    };
    // 中文约 1 字 1 token；编程指令模式会整理成条目，膨胀更多，留出更大余量
    let factor = if cfg.mode == "prompt" { 3 } else { 2 };
    let max_tokens = (400 + raw.chars().count() * factor).min(8192);
    serde_json::json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": 0.2,
        "max_tokens": max_tokens,
        "stream": stream
    })
}

/// 把 ASR 原始转写交给大模型纠错/优化（非流式；设置页测试、历史重优化用）
pub async fn optimize(cfg: &LlmConfig, raw: &str) -> anyhow::Result<String> {
    let base = cfg.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        bail!("尚未配置 AI 优化接口地址");
    }
    if cfg.model.trim().is_empty() {
        bail!("尚未配置 AI 优化模型名称");
    }
    let url = format!("{base}/chat/completions");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(cfg.timeout_sec.max(5)))
        .build()?;
    let mut req = client.post(&url).json(&request_body(cfg, raw, false));
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
/// `superseded`：可选谓词——为 true 时（如已被新录音取代）立即中止，不再耗费流量。
/// 接口不支持 stream 或流式全程未产出内容时，自动回退非流式请求。
pub async fn optimize_streaming(
    cfg: &LlmConfig,
    raw: &str,
    app: &AppHandle,
    first_token_ms: Option<&std::sync::atomic::AtomicU64>,
    superseded: Superseded<'_>,
) -> anyhow::Result<String> {
    let t0 = std::time::Instant::now();
    let base = cfg.base_url.trim().trim_end_matches('/');
    if base.is_empty() || cfg.model.trim().is_empty() {
        return optimize(cfg, raw).await;
    }
    let url = format!("{base}/chat/completions");

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(cfg.timeout_sec.max(5)))
        .build()
    {
        Ok(c) => c,
        Err(_) => return optimize(cfg, raw).await,
    };
    let mut req = client.post(&url).json(&request_body(cfg, raw, true));
    if !cfg.api_key.trim().is_empty() {
        req = req.bearer_auth(cfg.api_key.trim());
    }

    let mut resp = match req.send().await {
        Ok(r) if r.status().is_success() => r,
        // 不支持 stream 的网关等：静默回退非流式
        _ => return optimize(cfg, raw).await,
    };

    let mut acc = String::new();
    // 按字节缓冲、按完整行切分：多字节 UTF-8 字符可能被网络分块拦腰截断，
    // 逐 chunk 转字符串会产生乱码（U+FFFD）混进正文
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.context("AI 优化流式连接中断")? {
        if let Some(is_stale) = superseded {
            if is_stale() {
                bail!("已被新的录音取代，中止本次优化");
            }
        }
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes);
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
    if superseded.map_or(false, |f| f()) {
        bail!("已被新的录音取代，中止本次优化");
    }
    if acc.trim().is_empty() {
        return optimize(cfg, raw).await;
    }
    Ok(clean(&acc))
}

fn build_system_prompt(cfg: &LlmConfig) -> String {
    let mut p = String::new();
    if !cfg.custom_prompt.trim().is_empty() {
        // 自定义指令：模式指令会让位，只保留中性的执行约束
        p.push_str("你是文本处理助手。严格按照用户指令处理给定文本，忠实执行指令要求的全部转换。");
    } else {
        match cfg.mode.as_str() {
            "polish" => p.push_str(
                "你是语音输入的文字整理助手。输入是语音识别(ASR)的原始转录，\
                 含同音字错误、重复、口头语与标点缺失。请整理为通顺、自然的书面文字：\
                 1) 纠正错别字、同音字与标点错误（中文用全角标点，中英文之间补空格）；\
                 2) 删除重复表述与无意义的口头语，把明显的口语化说法改为书面表达；\
                 3) 合理断句，长内容按语义分段；数字、单位、日期按书面习惯书写。\
                 必须保留全部原意与细节（名称、数量、条件、否定关系一个都不能丢），\
                 不得概括、删减、添加或臆测内容；语气贴合原文（原文随意则不要过度正式）；\
                 输出语言与原文一致。",
            ),
            "prompt" => p.push_str(
                "你是资深软件工程师的语音输入助手。用户正在对 AI 编程助手（如 Codex、\
                 Claude Code、ZCode）口述需求或指令，输入是语音识别(ASR)的原始转录。\
                 请整理为清晰、专业、可直接执行的编程指令：\
                 1) 纠正错别字与标点，理顺语句逻辑、指代与语序；\
                 2) 文件名、路径、命令、参数、API、库名等技术细节原样保留\
                 （仅修正拼写与大小写错误，不要翻译或改写）；\
                 3) 内容较多时用简洁的条目或编号步骤组织，一项一行；\
                 不改变用户意图、不虚构需求、不补充原文没有的内容。输出语言与原文一致。",
            ),
            _ => p.push_str(
                "你是专业的中英文语音转录校对助手。输入是语音识别(ASR)的原始转录，\
                 可能存在同音字、错别字、标点与专有名词错误。请逐句校对，只做以下修正：\
                 1) 纠正错别字、同音字与明显的识别错误；\
                 2) 补全或修正标点（中文用全角、英文用半角），中英文之间补空格。\
                 必须保持原句结构、用词、语序与口语风格不变，\
                 不增删、不改写、不概括内容，输出语言与原文一致。",
            ),
        }
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

/// 清理模型输出：内嵌的思考过程、偶尔加上的代码块包裹或成对引号
pub fn clean(s: &str) -> String {
    let mut t = s.trim().to_string();
    // 部分思考型模型（qwen3 / R1 蒸馏版等）会把推理过程以 <think>…</think> 混进正文
    while let Some(start) = t.find("<think>") {
        let tail = &t[start + "<think>".len()..];
        if let Some(rel) = tail.find("</think>") {
            let end = start + "<think>".len() + rel + "</think>".len();
            t.replace_range(start..end, "");
        } else {
            // 未闭合（输出被截断）：思考之后不会再有正文，连同丢弃
            t.truncate(start);
            break;
        }
    }
    let mut t = t.trim();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_strips_think_blocks() {
        assert_eq!(clean("<think>推理过程</think>正文"), "正文");
        assert_eq!(clean("前文<think>中途</think>后文"), "前文后文");
        // 未闭合：思考之后全部丢弃
        assert_eq!(clean("正文<think>被截断的思考"), "正文");
        assert_eq!(clean("  干净正文  "), "干净正文");
    }

    #[test]
    fn clean_strips_code_fence_and_quotes() {
        assert_eq!(clean("```\n fenced \n```"), "fenced");
        assert_eq!(clean("“引号包裹”"), "引号包裹");
    }
}
