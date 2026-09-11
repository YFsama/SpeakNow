use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::config::AsrConfig;
use crate::local_whisper;
use crate::qwen_asr;
use crate::wav;

pub fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let cut: String = s.chars().take(n).collect();
        format!("{cut}…")
    }
}

/// 云端单段音频上限（智谱 GLM-ASR 等限制 30 秒，留 2 秒余量）
const HTTP_CHUNK_SECS: usize = 28;

/// 分段（流式 VAD 切段 / 长音频分段）识别结果的拼接：
/// - 边界两侧已有标点 → 原样相连；
/// - 拉丁字符边界 → 补空格（英文/中英混排）；
/// - 其余（中文等）→ 补「，」。分段边界多为语义停顿（静音切分），
///   空衔接会让两句直接粘连成一句，标点永远缺失。
pub fn join_transcripts(parts: &[String]) -> String {
    let punct = |c: char| "，,、；;。！!？?…~～".contains(c);
    let mut out = String::new();
    for p in parts {
        let p = p.trim();
        if p.is_empty() {
            continue;
        }
        if out.is_empty() {
            out.push_str(p);
            continue;
        }
        let ends_punct = out.chars().last().map_or(false, punct);
        let starts_punct = p.chars().next().map_or(false, punct);
        let latin_edge = out.chars().last().map_or(false, |c| c.is_ascii())
            && p.chars().next().map_or(false, |c| c.is_ascii());
        if !ends_punct && !starts_punct {
            out.push(if latin_edge { ' ' } else { '，' });
        } else if latin_edge && !starts_punct {
            // 英文句点后仍需空格：End. Next 而非 End.Next
            out.push(' ');
        }
        out.push_str(p);
    }
    out
}

/// 统一入口：按 provider 分发到 本地内置 Whisper 或 OpenAI 兼容云端接口
pub async fn transcribe(
    app: &AppHandle,
    cfg: &AsrConfig,
    samples: &[i16],
) -> anyhow::Result<String> {
    if samples.is_empty() {
        bail!("音频内容为空");
    }

    // 智能回退：选了云端但未填 API Key（且不是本机自建服务），而本地模型已就绪 → 自动改用本地识别
    let mut provider = cfg.provider.as_str();
    if provider != "local"
        && cfg.api_key.trim().is_empty()
        && !is_local_server(&cfg.base_url)
        && local_whisper::status(app).iter().any(|m| m.downloaded)
    {
        eprintln!("[speaknow] 云端 ASR 未配置 Key，已自动回退到本地模型识别");
        provider = "local";
    }

    if provider == "local" {
        // 优先用配置指定的模型；若它未下载则取任一已下载模型（Qwen3-ASR 较重，不参与自动兜底排序）
        let mut statuses = local_whisper::status(app);
        statuses.push(qwen_asr::status(app));
        let id = statuses
            .iter()
            .find(|m| m.id == cfg.local_model && m.downloaded)
            .or_else(|| {
                statuses
                    .iter()
                    .find(|m| m.downloaded && m.kind.as_deref() != Some("qwen"))
            })
            .map(|m| m.id.clone())
            .ok_or_else(|| {
                anyhow!("本地模型尚未下载：请在「识别设置」下载本地模型，或填写云端 API Key")
            })?;
        let lang = cfg.language.clone();
        let handle = app.clone();
        let samples = samples.to_vec();
        if id == qwen_asr::MODEL_ID {
            return tauri::async_runtime::spawn_blocking(move || {
                qwen_asr::transcribe(&handle, &samples, &lang)
            })
            .await
            .map_err(|e| anyhow!("本地识别线程异常: {e}"))?
            .map_err(|e| anyhow!("Qwen3-ASR 识别失败: {e:#}"));
        }
        return tauri::async_runtime::spawn_blocking(move || {
            local_whisper::transcribe(&handle, &id, &samples, &lang)
        })
        .await
        .map_err(|e| anyhow!("本地识别线程异常: {e}"))?
        .map_err(|e| anyhow!("本地识别失败: {e:#}"));
    }
    if provider == "mimo" {
        return transcribe_mimo_chunked(cfg, samples).await;
    }
    // GLM-ASR 热词联动：AI 术语表的规范写法自动并入 ASR 热词——
    // 专有名词在识别源头就倾向于正确写法，比事后靠 LLM 纠正可靠得多。
    // 仅对智谱接口启用：其余兼容接口对多余表单字段的容忍度未知。
    let mut http_cfg = cfg.clone();
    if http_cfg.base_url.to_lowercase().contains("bigmodel") {
        let glossary = app
            .state::<crate::Ctx>()
            .config
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_default()
            .llm
            .glossary;
        if !glossary.trim().is_empty() {
            http_cfg.hotwords = merge_hotwords(&http_cfg.hotwords, &glossary);
        }
    }
    transcribe_http_chunked(&http_cfg, samples).await
}

/// 合并 ASR 热词与 LLM 术语表（术语行取「=」左侧的规范写法），去重、上限 100
fn merge_hotwords(existing: &str, glossary: &str) -> String {
    let glossary_terms = glossary
        .lines()
        .map(|l| l.split('=').next().unwrap_or("").trim());
    let mut seen: Vec<String> = Vec::new();
    let mut merged: Vec<&str> = Vec::new();
    for term in existing
        .split(|c| c == '\n' || c == ',' || c == '，')
        .map(str::trim)
        .chain(glossary_terms)
    {
        if term.is_empty() || merged.len() >= 100 {
            continue;
        }
        if !seen.iter().any(|s| s.eq_ignore_ascii_case(term)) {
            seen.push(term.to_lowercase());
            merged.push(term);
        }
    }
    merged.join("\n")
}

/// 小米 MiMo-V2.5-ASR：OpenAI Chat Completions 兼容（input_audio base64）
async fn transcribe_mimo_chunked(cfg: &AsrConfig, samples: &[i16]) -> anyhow::Result<String> {
    let chunk_len = 16_000 * HTTP_CHUNK_SECS;
    let chunks: Vec<&[i16]> = if samples.len() <= chunk_len {
        vec![samples]
    } else {
        samples.chunks(chunk_len).collect()
    };
    let mut parts: Vec<String> = Vec::new();
    for c in chunks {
        let wav = wav::encode(c, 16_000);
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(wav);
        let body = serde_json::json!({
            "model": cfg.model,
            "messages": [{
                "role": "user",
                "content": [{
                    "type": "input_audio",
                    "input_audio": { "data": format!("data:audio/wav;base64,{b64}") }
                }]
            }],
            "asr_options": if cfg.language.is_empty() || cfg.language == "auto" {
                serde_json::json!({ "language": "auto" })
            } else {
                serde_json::json!({ "language": cfg.language })
            }
        });
        let text = with_retry(cfg, RequestKind::Mimo(body)).await?;
        if !text.trim().is_empty() {
            parts.push(text);
        }
    }
    Ok(join_transcripts(&parts))
}

/// 网络类失败自动重试一次；鉴权/参数类错误直接返回
async fn with_retry(cfg: &AsrConfig, kind: RequestKind) -> anyhow::Result<String> {
    match send_request(cfg, kind.clone()).await {
        Ok(t) => Ok(t),
        Err(first) => {
            let msg = format!("{first:#}");
            let skip_retry = msg.contains("返回 401")
                || msg.contains("返回 403")
                || msg.contains("返回 404")
                || msg.contains("尚未配置");
            if skip_retry {
                return Err(first);
            }
            tokio::time::sleep(Duration::from_millis(600)).await;
            send_request(cfg, kind)
                .await
                .map_err(|e| anyhow!("{e:#}（已自动重试一次）"))
        }
    }
}

#[derive(Clone)]
enum RequestKind {
    /// OpenAI multipart /audio/transcriptions
    Multipart(Vec<u8>),
    /// MiMo chat/completions JSON
    Mimo(serde_json::Value),
}

/// 按请求类型发送并抽取文本
async fn send_request(cfg: &AsrConfig, kind: RequestKind) -> anyhow::Result<String> {
    let base = cfg.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        bail!("尚未配置 ASR 接口地址");
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(cfg.timeout_sec.max(5)))
        .build()?;

    let (url, resp) = match &kind {
        RequestKind::Mimo(body) => {
            let path = if cfg.endpoint_path.starts_with('/') {
                cfg.endpoint_path.clone()
            } else {
                format!("/{}", cfg.endpoint_path)
            };
            let mut req = client.post(format!("{base}{path}")).json(body);
            if !cfg.api_key.trim().is_empty() {
                req = req.bearer_auth(cfg.api_key.trim());
            }
            (format!("{base}{path}"), req.send().await)
        }
        RequestKind::Multipart(wav) => {
            let path = if cfg.endpoint_path.starts_with('/') {
                cfg.endpoint_path.clone()
            } else {
                format!("/{}", cfg.endpoint_path)
            };
            let url = format!("{base}{path}");
            let file_part = reqwest::multipart::Part::bytes(wav.clone())
                .file_name("audio.wav")
                .mime_str("audio/wav")?;
            let mut form = reqwest::multipart::Form::new()
                .part("file", file_part)
                .text("model", cfg.model.clone());

            if !cfg.language.is_empty() && cfg.language != "auto" {
                form = form.text("language", cfg.language.clone());
            }

            // 热词：换行/逗号分隔 → JSON 数组（GLM-ASR 等支持）
            let hotwords: Vec<String> = cfg
                .hotwords
                .split(|c| c == '\n' || c == ',' || c == '，')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .take(100)
                .map(String::from)
                .collect();
            if !hotwords.is_empty() {
                form = form.text("hotwords", serde_json::to_string(&hotwords)?);
            }

            let mut req = client.post(&url).multipart(form);
            if !cfg.api_key.trim().is_empty() {
                req = req.bearer_auth(cfg.api_key.trim());
            }
            (url, req.send().await)
        }
    };

    let resp = resp.with_context(|| format!("ASR 请求失败，请检查网络或代理设置（{url}）"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("ASR 服务返回 {}: {}", status, truncate(body.trim(), 300));
    }
    extract_text(&body)
}

/// 是否本机自建服务（whisper.cpp server 等，无需 Key，不做本地回退）
fn is_local_server(base: &str) -> bool {
    let b = base.trim().to_lowercase();
    b.contains("localhost")
        || b.contains("127.0.0.1")
        || b.contains("0.0.0.0")
        || b.contains("[::1]")
}

/// 超长录音自动分段识别再拼接
async fn transcribe_http_chunked(cfg: &AsrConfig, samples: &[i16]) -> anyhow::Result<String> {
    let chunk_len = 16_000 * HTTP_CHUNK_SECS;
    let chunks: Vec<&[i16]> = if samples.len() <= chunk_len {
        vec![samples]
    } else {
        samples.chunks(chunk_len).collect()
    };
    let mut parts: Vec<String> = Vec::new();
    for (i, c) in chunks.iter().enumerate() {
        if chunks.len() > 1 {
            eprintln!("[speaknow] ASR 分段 {}/{}", i + 1, chunks.len());
        }
        let wav_bytes = wav::encode(c, 16_000);
        let t = with_retry(cfg, RequestKind::Multipart(wav_bytes)).await?;
        if !t.trim().is_empty() {
            parts.push(t);
        }
    }
    Ok(join_transcripts(&parts))
}

fn extract_text(body: &str) -> anyhow::Result<String> {
    let v: Value = serde_json::from_str(body)
        .map_err(|_| anyhow!("ASR 响应不是 JSON: {}", truncate(body.trim(), 120)))?;

    if let Some(msg) = v
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
    {
        bail!("ASR 服务错误: {msg}");
    }
    // 常见格式：{"text": "..."}（OpenAI/智谱）或 chat.completion 形式
    if let Some(t) = v.get("text").and_then(Value::as_str) {
        return Ok(t.to_string());
    }
    if let Some(t) = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
    {
        return Ok(t.to_string());
    }
    if let Some(t) = v.get("transcript").and_then(Value::as_str) {
        return Ok(t.to_string());
    }
    if let Some(t) = v.as_str() {
        return Ok(t.to_string());
    }
    bail!("ASR 响应中没有文本字段: {}", truncate(body.trim(), 120))
}

#[cfg(test)]
mod tests {
    use super::{join_transcripts, merge_hotwords};

    #[test]
    fn merge_dedups_and_strips_aliases() {
        assert_eq!(
            merge_hotwords("Kubernetes\n", "Rust=拉斯特|拉斯\nkubernetes\n低代码平台"),
            "Kubernetes\nRust\n低代码平台"
        );
        // 空白与逗号分隔均可
        assert_eq!(merge_hotwords("A, B", "C"), "A\nB\nC");
        assert_eq!(merge_hotwords("", ""), "");
    }

    #[test]
    fn joins_zh_segments_inserting_comma_at_bare_boundaries() {
        // 分段边界（VAD 静音切分处）多为语义停顿：无标点衔接时补「，」而非粘连
        assert_eq!(
            join_transcripts(&["今天讨论预算".into(), "下午继续聊方案".into()]),
            "今天讨论预算，下午继续聊方案"
        );
        // 任一侧已有标点 → 原样相连
        assert_eq!(
            join_transcripts(&["今天讨论预算，".into(), "下午继续".into()]),
            "今天讨论预算，下午继续"
        );
        assert_eq!(
            join_transcripts(&["第一点。".into(), "第二点。".into()]),
            "第一点。第二点。"
        );
    }

    #[test]
    fn joins_latin_segments_with_space() {
        assert_eq!(
            join_transcripts(&["hello there".into(), "how are you".into()]),
            "hello there how are you"
        );
        // 句点后仍要有空格
        assert_eq!(
            join_transcripts(&["End.".into(), "Next one".into()]),
            "End. Next one"
        );
        // 下一句以标点开头 → 不加空格
        assert_eq!(
            join_transcripts(&["hello".into(), ", world".into()]),
            "hello, world"
        );
        // 中英混排边界按中文处理
        assert_eq!(
            join_transcripts(&["先说结论".into(), "then we move on".into()]),
            "先说结论，then we move on"
        );
    }

    #[test]
    fn joins_skip_empty_parts() {
        assert_eq!(
            join_transcripts(&["".into(), "  ".into(), "正文".into()]),
            "正文"
        );
        assert_eq!(join_transcripts(&[]), "");
    }
}
