use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use serde_json::Value;
use tauri::AppHandle;

use crate::asr::truncate;
use crate::config::LlmConfig;
use crate::events;

/// 判断本次优化是否已过期（如已被新录音取代）；返回 true 时流式读取立即中止
pub type Superseded<'a> = Option<&'a (dyn Fn() -> bool + Send + Sync)>;

/// 术语表条目：规范写法 + 常见误识形式。
/// 支持两种行格式：`Rust` 或 `Rust=拉斯特|拉斯`（「=」右侧为该词的典型 ASR 误识，
/// 原文命中误识形式时会在提示词里点名要求纠正，命中比泛泛列出有效得多）。
struct GlossaryEntry {
    canonical: String,
    aliases: Vec<String>,
}

fn parse_glossary(cfg: &LlmConfig) -> Vec<GlossaryEntry> {
    cfg.glossary
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|line| {
            let (canonical, aliases) = match line.split_once('=') {
                Some((c, a)) => (
                    c.trim().to_string(),
                    a.split('|').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect(),
                ),
                None => (line.to_string(), Vec::new()),
            };
            GlossaryEntry { canonical, aliases }
        })
        .filter(|e| !e.canonical.is_empty())
        .collect()
}

/// 大小写不敏感的包含判断（中文 to_lowercase 为原样，等价于直接 contains）
fn contains_ci(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// 常规用户消息：自定义指令模板（{text} 占位）或原始转写
fn user_content(cfg: &LlmConfig, raw: &str) -> String {
    if cfg.custom_prompt.trim().is_empty() {
        raw.to_string()
    } else {
        cfg.custom_prompt.replace("{text}", raw)
    }
}

/// 定点修补重试的用户消息：带上原始转写与上一次输出，只要求修正指明的问题。
/// 比让模型从同样的输入重新生成有效得多——小模型/思考模型重新生成往往原样再错一遍，
/// 而在上一次输出基础上做局部替换是它们擅长且廉价的操作。
fn patch_message(raw: &str, prev: &str, missing: &[String], truncated: bool) -> String {
    let mut problems = String::new();
    if !missing.is_empty() {
        let list = missing.iter().map(|m| format!("「{m}」")).collect::<String>();
        problems.push_str(&format!("丢失或改写了原文中的关键词：{list}。把这些关键词按原文写法补回或恢复原样。"));
    }
    if truncated {
        problems.push_str(
            "输出比原文短了很多（发生了概括或删减）——原文提到的每一件事都必须保留，\
             请把被删减的内容补回来，不得概括。\
             说了几件事就输出几件事，条件与否定关系一个都不能丢。",
        );
    }
    format!(
        "（原始转写）\n{raw}\n\n（上一次的输出）\n{prev}\n\n\
         上一次的输出存在问题：{problems}\
         请以上一次的输出为基础修正这些问题，其余内容一字不改。\
         直接输出修正后的完整文本，不要输出任何解释。"
    )
}

/// 构造 chat/completions 请求体（流式 / 非流式共用）。
/// 自定义指令存在时用户消息为指令模板（{text} 占位），系统提示改用中性版本，
/// 避免模式指令（如「保持口语风格」）与用户意图（如「翻译成英文」）互相打架。
fn request_body(cfg: &LlmConfig, user: &str, stream: bool) -> Value {
    let system = build_system_prompt(cfg);
    // 中文约 1 字 1 token；编程指令模式会整理成条目，膨胀更多，留出更大余量
    let factor = if cfg.mode == "prompt" { 3 } else { 2 };
    let max_tokens = (400 + user.chars().count() * factor).min(8192);
    serde_json::json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": if cfg.custom_prompt.trim().is_empty() && cfg.mode == "correct" { 0.1 } else { 0.2 },
        "max_tokens": max_tokens,
        "stream": stream
    })
}

/// 把 ASR 原始转写交给大模型纠错/优化（非流式；设置页测试、历史重优化用）。
/// 输出经过关键词对齐守卫：先做确定性的术语误识替换，仍有丢失时定点修补重试一次，
/// 且只在修补版违规更少时采纳——重试绝不劣化结果。
pub async fn optimize(cfg: &LlmConfig, raw: &str) -> anyhow::Result<String> {
    let first = optimize_once(cfg, &user_content(cfg, raw)).await?;
    let out = apply_alias_fixes(cfg, &first);
    let missing = guard_missing(cfg, raw, &out);
    let truncated = truncation_violation(cfg, raw, &out);
    if missing.is_empty() && !truncated {
        return Ok(out);
    }
    let score = missing.len() + truncated as usize;
    eprintln!("[speaknow] 对齐守卫：丢失关键词 {missing:?}、概括删减={truncated}，尝试定点修补");
    match optimize_once(cfg, &patch_message(raw, &out, &missing, truncated)).await {
        Ok(t) if !t.trim().is_empty() => {
            let t = apply_alias_fixes(cfg, &t);
            let t_score =
                guard_missing(cfg, raw, &t).len() + truncation_violation(cfg, raw, &t) as usize;
            if t_score <= score {
                Ok(t)
            } else {
                eprintln!("[speaknow] 修补版未优于原版，保留原版");
                Ok(out)
            }
        }
        _ => Ok(out),
    }
}

/// 单次非流式请求
async fn optimize_once(cfg: &LlmConfig, user: &str) -> anyhow::Result<String> {
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
    let mut req = client.post(&url).json(&request_body(cfg, user, false));
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
/// 输出经过关键词对齐守卫：先做确定性的术语误识替换，仍有丢失时以「思考中」
/// 提示并定点修补重试一次（带上一次输出、只修关键词），重试不占优则保留原版。
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
    let first = stream_once(cfg, &user_content(cfg, raw), app, first_token_ms, superseded).await?;
    let out = apply_alias_fixes(cfg, &first);
    let missing = guard_missing(cfg, raw, &out);
    let truncated = truncation_violation(cfg, raw, &out);
    if missing.is_empty() && !truncated {
        return Ok(out);
    }
    // 被新录音取代则不再耗费重试流量
    if superseded.map_or(false, |f| f()) {
        bail!("已被新的录音取代，中止本次优化");
    }
    let score = missing.len() + truncated as usize;
    let mut why = String::new();
    if !missing.is_empty() {
        let list = missing.iter().map(|m| format!("「{m}」")).collect::<String>();
        why.push_str(&format!("丢失关键词 {list}"));
    }
    if truncated {
        if !why.is_empty() {
            why.push_str("、");
        }
        why.push_str("疑似概括删减");
    }
    crate::trace_pipeline(app, &format!("对齐守卫：{why}，尝试定点修补"));
    events::emit(
        app,
        "sn-llm-delta",
        serde_json::json!({
            "kind": "reasoning",
            "delta": format!("⚠ {why}，定点修补中…\n")
        }),
    );
    match stream_once(cfg, &patch_message(raw, &out, &missing, truncated), app, first_token_ms, superseded).await {
        Ok(t) if !t.trim().is_empty() => {
            let t = apply_alias_fixes(cfg, &t);
            let m2 = guard_missing(cfg, raw, &t);
            let t2 = truncation_violation(cfg, raw, &t);
            let t_score = m2.len() + t2 as usize;
            if !m2.is_empty() || t2 {
                let list2 = m2.iter().map(|m| format!("「{m}」")).collect::<String>();
                crate::trace_pipeline(
                    app,
                    &format!("修补后仍存在问题（关键词 {list2}、概括删减={t2}）"),
                );
            }
            if t_score <= score {
                Ok(t)
            } else {
                crate::trace_pipeline(app, "修补版未优于原版，保留原版");
                Ok(out)
            }
        }
        _ => Ok(out),
    }
}

/// 单次流式请求（守卫逻辑在外层包装）
async fn stream_once(
    cfg: &LlmConfig,
    user: &str,
    app: &AppHandle,
    first_token_ms: Option<&std::sync::atomic::AtomicU64>,
    superseded: Superseded<'_>,
) -> anyhow::Result<String> {
    let t0 = std::time::Instant::now();
    let base = cfg.base_url.trim().trim_end_matches('/');
    if base.is_empty() || cfg.model.trim().is_empty() {
        return optimize_once(cfg, user).await;
    }
    let url = format!("{base}/chat/completions");

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(cfg.timeout_sec.max(5)))
        .build()
    {
        Ok(c) => c,
        Err(_) => return optimize_once(cfg, user).await,
    };
    let mut req = client.post(&url).json(&request_body(cfg, user, true));
    if !cfg.api_key.trim().is_empty() {
        req = req.bearer_auth(cfg.api_key.trim());
    }

    let mut resp = match req.send().await {
        Ok(r) if r.status().is_success() => r,
        // 不支持 stream 的网关等：静默回退非流式
        _ => return optimize_once(cfg, user).await,
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
        return optimize_once(cfg, user).await;
    }
    Ok(clean(&acc))
}

/* ================= 关键词对齐守卫 ================= */

/// 英文虚词/填充词白名单：润色时被翻译或删除不算丢失关键词。
/// 含中文口语里常被合法汉化的普通借词（code→代码、app→应用、web→网页、demo→演示、ppt→幻灯片）。
/// 刻意不含否定与量化词（no / not / all / any / some），它们丢了会改变句意。
const GUARD_WHITELIST: &[&str] = &[
    "the", "a", "an", "and", "or", "but", "if", "because", "so", "that", "this", "these",
    "those", "of", "to", "in", "on", "at", "for", "with", "by", "from", "into", "about",
    "is", "am", "are", "was", "were", "be", "been", "being", "do", "does", "did",
    "doing", "have", "has", "had", "will", "would", "can", "could", "should", "shall",
    "may", "might", "must", "i", "you", "he", "she", "it", "we", "they", "me", "him",
    "her", "us", "them", "my", "your", "his", "its", "our", "their", "here", "there",
    "what", "which", "who", "when", "where", "why", "how", "than", "then", "too",
    "very", "just", "also", "once", "again", "other", "such", "own", "same",
    "ok", "okay", "yeah", "yep", "yup", "nope", "uh", "um", "oh", "wow", "hey",
    "hi", "hello", "please", "thanks", "thank", "like", "really", "actually",
    "basically", "literally", "maybe", "well", "code", "app", "web", "demo", "ppt",
];

/// 提取原文中的英文/数字词元（最大 [字母数字.] 连续段，去掉首尾句点）。
/// 用于「原文有、输出无」的丢失检测——这是关键词被模型擅自翻译/改写/删除的主要信号。
fn latin_tokens(s: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let flush = |cur: &mut String, tokens: &mut Vec<String>| {
        let t = cur.trim_matches('.');
        if !t.is_empty() {
            tokens.push(t.to_lowercase());
        }
        cur.clear();
    };
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '.' {
            cur.push(c);
        } else {
            flush(&mut cur, &mut tokens);
        }
    }
    flush(&mut cur, &mut tokens);
    tokens
}

/// 词元是否值得守卫：含字母且长度 ≥ 2（如 Tauri、Bug），或 ≥ 2 位数字（如 44、4.6）。
/// 单个字母/单个数字放过——「3 → 三」这类书面化是润色的合法行为。
fn guardable_token(tok: &str) -> bool {
    let letters = tok.chars().filter(|c| c.is_ascii_alphabetic()).count();
    let digits = tok.chars().filter(|c| c.is_ascii_digit()).count();
    (letters >= 1 && tok.len() >= 2) || digits >= 2
}

/// 校验输出与原文的关键词对齐，返回丢失/被改写的关键词清单（保序去重，至多 8 个）。
/// 自定义指令模式（翻译、改写等）不适用——关键词合法地会变。
pub fn guard_missing(cfg: &LlmConfig, raw: &str, out: &str) -> Vec<String> {
    if !cfg.custom_prompt.trim().is_empty() || out.trim().is_empty() {
        return Vec::new();
    }
    let out_l = out.to_lowercase();
    // 术语命中：原文出现的规范写法或误识形式。这些词的转换以术语表为准，
    // 其内部包含的英文词元（如「低code平台」里的 code）随之豁免，不按丢失处理
    let entries = parse_glossary(cfg);
    let matched: Vec<&GlossaryEntry> = entries
        .iter()
        .filter(|e| contains_ci(raw, &e.canonical) || e.aliases.iter().any(|a| contains_ci(raw, a)))
        .collect();
    let mut missing: Vec<String> = Vec::new();
    for tok in latin_tokens(raw) {
        if !guardable_token(&tok) || GUARD_WHITELIST.contains(&tok.as_str()) {
            continue;
        }
        if matched.iter().any(|e| {
            contains_ci(&e.canonical, &tok) || e.aliases.iter().any(|a| contains_ci(a, &tok))
        }) {
            continue;
        }
        if !out_l.contains(&tok) && !missing.iter().any(|m| m.eq_ignore_ascii_case(&tok)) {
            missing.push(tok);
        }
    }
    // 术语表：原文出现规范写法或误识形式，输出却不含规范写法 → 违反用户明确意图
    for e in matched {
        if !contains_ci(out, &e.canonical)
            && !missing.iter().any(|m| m.eq_ignore_ascii_case(&e.canonical))
        {
            missing.push(e.canonical.clone());
        }
    }
    missing.truncate(8);
    missing
}

/// 概括/删减检测：correct / polish 模式下，输出有效字符数（字母数字，忽略标点空白）
/// 显著少于原文——correct < 75%、polish < 55%——视为发生了概括删减。
/// 纯中文内容的丢失逃过关键词守卫（没有英文词元可比），这道长度闸兜底。
/// 仅对中文为主的转写启用：英文口语的填充词比例天然偏高，合法润色就可能砍掉一半；
/// prompt 模式整理为条目会合理收缩；短文本无统计意义——均不检测。
fn truncation_violation(cfg: &LlmConfig, raw: &str, out: &str) -> bool {
    if !cfg.custom_prompt.trim().is_empty()
        || cfg.mode == "prompt"
        || raw.trim().is_empty()
        || out.trim().is_empty()
    {
        return false;
    }
    let count = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).count();
    let (raw_n, out_n) = (count(raw), count(out));
    if raw_n < 16 || out_n == 0 {
        return false;
    }
    let cjk = raw
        .chars()
        .filter(|c| ('\u{4E00}'..='\u{9FFF}').contains(c))
        .count();
    if cjk * 2 < raw_n {
        return false; // 非中文为主，交给关键词守卫
    }
    let ratio = out_n as f64 / raw_n as f64;
    if cfg.mode == "correct" {
        ratio < 0.75
    } else {
        ratio < 0.55
    }
}

/// 大小写不敏感替换（逐处替换，替换产物不会被再次匹配）。
/// 仅当 to_lowercase 保持字节长度时走小写索引匹配（ASCII 与 CJK 均满足），
/// 否则退回区分大小写的精确替换，保证 exotic 字符下也不会错位。
fn replace_ci(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }
    let (h, n) = (haystack.to_lowercase(), needle.to_lowercase());
    if h.len() != haystack.len() || n.len() != needle.len() {
        return haystack.replace(needle, replacement);
    }
    let mut out = String::with_capacity(haystack.len());
    let mut consumed = 0usize;
    while let Some(pos) = h[consumed..].find(&n) {
        let s = consumed + pos;
        out.push_str(&haystack[consumed..s]);
        out.push_str(replacement);
        consumed = s + n.len();
    }
    out.push_str(&haystack[consumed..]);
    out
}

/// 确定性术语修复：输出含误识形式却无规范写法时，按用户声明的映射直接替换。
/// 这是用户明确表达的意图，零模型成本、必定生效；多数误识场景在此就被修复，
/// 不再需要发起修补重试。
fn apply_alias_fixes(cfg: &LlmConfig, out: &str) -> String {
    let mut t = out.to_string();
    for e in parse_glossary(cfg) {
        if e.aliases.is_empty() || contains_ci(&t, &e.canonical) {
            continue;
        }
        for a in &e.aliases {
            if contains_ci(&t, a) {
                t = replace_ci(&t, a, &e.canonical);
            }
        }
    }
    t
}

/* ================= 系统提示词 ================= */

fn build_system_prompt(cfg: &LlmConfig) -> String {
    let mut p = String::new();
    if !cfg.custom_prompt.trim().is_empty() {
        // 自定义指令：模式指令会让位，只保留中性的执行约束
        p.push_str(
            "你是文本处理助手。严格按照用户指令处理给定文本，忠实执行指令要求的全部转换。\
             转换中不得丢失原文的事实信息（名称、数量、条件、否定关系）。",
        );
    } else {
        match cfg.mode.as_str() {
            "polish" => p.push_str(
                "你是语音输入的文字整理助手。输入是语音识别(ASR)的原始转录，\
                 含同音字错误、重复、口头语与标点缺失。请整理为通顺、自然的书面文字。\n\
                 不可突破的底线（优先级最高）：\n\
                 1) 人名、地名、产品名、公司名、项目与团队代号、专业术语、英文单词与缩写：\
                 一字不改，只许修正拼写与大小写，禁止翻译、替换、增删或解释；\n\
                 2) 数字、单位、日期、版本号、路径、命令、代码：原样保留，不得改写；\n\
                 3) 不概括、不删减、不添加、不臆测；说了几件事就输出几件事，\
                 条件与否定关系一个都不能丢；\n\
                 4) 语气贴合原文：原文随意就保持随意，不要过度正式。\n\
                 整理手法（只在底线之内使用）：\n\
                 - 修正同音/近音识别错误：替换词必须与原词读音接近且贴合语境，没把握就不改；\n\
                 - 删除重复表述与无意义口头语（嗯、呃、就是说、那个）；\
                 修正明显口误、调整影响理解的语序；合理断句，长内容按语义分段；\
                 数字与单位按书面习惯书写。\n\
                 示例：\n\
                 输入：嗯那个就是说登录这块吧，用户反馈挺多的，大概百分之三十的人登不上去，\
                 你看看是不是token过期了，还是说接口本身有问题\n\
                 输出：登录这块用户反馈挺多，约 30% 的用户登不上去。看看是不是 Token 过期了，\
                 还是接口本身有问题。\n\
                 （口头语删除、百分之三十→30% 属书面化；Token、接口等词原样保留，信息一条不丢）",
            ),
            "prompt" => p.push_str(
                "你是资深软件工程师的语音输入助手。用户正在对 AI 编程助手（如 Codex、\
                 Claude Code、ZCode）口述需求或指令，输入是语音识别(ASR)的原始转录。\
                 请整理为清晰、专业、可直接执行的编程指令：\n\
                 1) 纠正错别字与标点，理顺语句逻辑、指代与语序；\n\
                 2) 文件名、路径、命令、参数、API、库名、变量名等技术细节必须原样保留\
                 （仅修正拼写与大小写，不翻译、不改写、不缩写）；\n\
                 3) 内容较多时用简洁的条目或编号步骤组织，一项一行；\n\
                 4) 不改变用户意图、不虚构需求、不补充原文没有的内容。输出语言与原文一致。\n\
                 示例：\n\
                 输入：帮我把 src 下面的 utils 点 ts 里面那个 debouce 函数改成带取消的，\
                 然后所有调用的地方都要改一下\n\
                 输出：把 src/utils.ts 中的 debounce 函数改为支持取消的版本，\
                 并更新所有调用处。",
            ),
            _ => p.push_str(
                "你是语音转写校对员。输入是语音识别(ASR)的原始转录，\
                 可能存在同音/近音错字、标点缺失、中英文间距问题。逐句校对，只做修正，不做改写。\n\
                 校对规则：\n\
                 1) 只修正「读音相同或相近」造成的识别错误：替换词与原词读音接近且贴合语境才改；\
                 没有把握就保持原样，宁可少改，不可改错；\n\
                 2) 专有名词、人名、产品名、公司名、技术术语、英文单词、数字与代号：\
                 除非确定是识别错误，否则一字不改（仅可修正拼写与大小写）；\n\
                 3) 不增删内容、不调整语序、不替换同义词、不概括；保持原句的口语风格；\n\
                 4) 标点：仅补全明显缺失、修正明显错误（中文用全角、英文用半角），\
                 中英文之间补空格。\n\
                 示例：\n\
                 输入：这个功能下个迭代再作，先把登录的 bug 修了，登不上的反馈挺多的\n\
                 输出：这个功能下个迭代再做，先把登录的 Bug 修了，登不上的反馈挺多的\n\
                 （「作→做」为同音错字，bug→Bug 规范大小写，其余一字未动）\n\
                 输入：用 react和 vite搭个项目，状态管理用 zustand\n\
                 输出：用 React 和 Vite 搭个项目，状态管理用 Zustand\n\
                 （仅补中英文空格与规范大小写）\n\
                 输入：明天三点开会讨论第二季度的预算\n\
                 输出：明天三点开会讨论第二季度的预算\n\
                 （没有把握的错误不改，原样输出）",
            ),
        }
    }
    p.push_str("\n直接输出处理后的文本，不要输出任何解释、前后缀、markdown 代码块或引号。");

    if let Some(section) = glossary_section(cfg) {
        p.push_str("\n\n");
        p.push_str(&section);
    }
    p
}

/// 术语表段落：规范写法 + 误识形式说明。静态注入（命中检测在守卫侧动态进行——
/// 提示词层面列出全部词条供模型参考即可，逐条点名会显著拉长提示词）。
fn glossary_section(cfg: &LlmConfig) -> Option<String> {
    let entries = parse_glossary(cfg);
    if entries.is_empty() {
        return None;
    }
    let mut s = String::from("用户术语表（规范写法；原文出现其同音/近音/分词变体时，必须纠正为该写法）：\n");
    for e in &entries {
        if e.aliases.is_empty() {
            s.push_str(&format!("- {}\n", e.canonical));
        } else {
            s.push_str(&format!(
                "- {}（原文出现「{}」等写法时，必须写作「{}」）\n",
                e.canonical,
                e.aliases.join("」「"),
                e.canonical
            ));
        }
    }
    Some(s)
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

    fn cfg(mode: &str, glossary: &str) -> LlmConfig {
        LlmConfig {
            enabled: true,
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            mode: mode.into(),
            glossary: glossary.into(),
            custom_prompt: String::new(),
            timeout_sec: 30,
        }
    }

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

    /* ---- 对齐守卫 ---- */

    #[test]
    fn guard_catches_lost_latin_keyword() {
        let c = cfg("polish", "");
        // 模型把 Tauri 翻译/删除了
        assert_eq!(
            guard_missing(&c, "我们用 Tauri 做的桌面端", "我们用桌面框架做的桌面端"),
            vec!["tauri"]
        );
        // 大小写变化不算丢失
        assert!(guard_missing(&c, "用 tauri 写的", "用 Tauri 写的").is_empty());
        // 完整保留则通过
        assert!(guard_missing(&c, "用 Tauri 写的", "用 Tauri（跨端框架）写的").is_empty());
    }

    #[test]
    fn guard_catches_lost_numbers_and_versions() {
        let c = cfg("polish", "");
        assert_eq!(guard_missing(&c, "版本 4.6 有问题", "版本有问题"), vec!["4.6"]);
        // 单个数字被书面化（3 → 三）不算丢失
        assert!(guard_missing(&c, "等 3 秒重试", "等三秒重试").is_empty());
    }

    #[test]
    fn guard_ignores_whitelisted_fillers() {
        let c = cfg("polish", "");
        // ok/yeah 这类填充词被润色掉是合法行为
        assert!(guard_missing(&c, "ok 那就这么定了", "那就这么定了").is_empty());
    }

    #[test]
    fn guard_skipped_for_custom_prompt() {
        let mut c = cfg("polish", "");
        c.custom_prompt = "把 {text} 翻译成英文".into();
        // 翻译后中文关键词消失是预期行为
        assert!(guard_missing(&c, "部署到 Kubernetes 集群", "Deploy to the cluster").is_empty());
    }

    #[test]
    fn guard_enforces_glossary() {
        let c = cfg("polish", "低代码平台=低code平台\nRust");
        // 原文命中误识形式，输出却没有规范写法 → 违规；
        // 误识形式内部的英文词元（code）随术语豁免，不计丢失
        assert_eq!(
            guard_missing(&c, "我们在做低code平台", "我们在做低代码平添"),
            vec!["低代码平台"]
        );
        // 误识形式被正确纠正 → 通过
        assert!(guard_missing(&c, "我们在做低code平台", "我们在做低代码平台").is_empty());
        // 原文含规范写法但输出丢了 → 违规
        assert_eq!(guard_missing(&c, "用 Rust 写的", "用某系统语言写的"), vec!["Rust"]);
    }

    #[test]
    fn latin_token_extraction() {
        assert_eq!(
            latin_tokens("用 qwen3:4b 和 v1.2 部署."),
            vec!["qwen3", "4b", "v1.2"]
        );
        // 句尾句点不并入词元
        assert_eq!(latin_tokens("fixed the Bug."), vec!["fixed", "the", "bug"]);
    }

    /* ---- 术语表 ---- */

    #[test]
    fn glossary_parses_aliases() {
        let c = cfg("polish", "Rust=拉斯特|拉斯\n低代码平台\n");
        let e = parse_glossary(&c);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].canonical, "Rust");
        assert_eq!(e[0].aliases, vec!["拉斯特", "拉斯"]);
        assert_eq!(e[1].canonical, "低代码平台");
        assert!(e[1].aliases.is_empty());
    }

    #[test]
    fn glossary_section_lists_alias_hint() {
        let c = cfg("polish", "Rust=拉斯特");
        let s = glossary_section(&c).unwrap();
        assert!(s.contains("Rust（原文出现「拉斯特」等写法时，必须写作「Rust」）"));
    }

    /* ---- 确定性术语修复 ---- */

    #[test]
    fn alias_fixes_replace_misrecognition() {
        let c = cfg("polish", "Rust=拉斯特|拉斯");
        // 多处误识全部替换为规范写法
        assert_eq!(apply_alias_fixes(&c, "用拉斯特和拉斯写的"), "用Rust和Rust写的");
        // 已含规范写法（大小写不敏感）则不动——大小写规范化是模型的活
        assert_eq!(apply_alias_fixes(&c, "用 rust 写的"), "用 rust 写的");
        assert!(guard_missing(&c, "用 Rust 写的", "用 rust 写的").is_empty());
        // 无关文本不动
        assert_eq!(apply_alias_fixes(&c, "用 Go 写的"), "用 Go 写的");
    }

    #[test]
    fn alias_fixes_then_guard_passes() {
        let c = cfg("polish", "Rust=拉斯特");
        // 模型输出了误识形式 → 确定性修复后守卫应通过（无需重试）
        let fixed = apply_alias_fixes(&c, "用拉斯特写的");
        assert!(guard_missing(&c, "我们在用拉斯特开发", &fixed).is_empty());
    }

    #[test]
    fn replace_ci_handles_multiple_and_case() {
        assert_eq!(replace_ci("Tauri 和 tauri", "tauri", "Tauri"), "Tauri 和 Tauri");
        assert_eq!(replace_ci("低code平台", "低code平台", "低代码平台"), "低代码平台");
        // 顺序非重叠替换：两个源匹配各替换一次
        assert_eq!(replace_ci("abab", "ab", "ba"), "baba");
    }

    /* ---- 修补重试消息 ---- */

    #[test]
    fn patch_message_carries_prev_output_and_keywords() {
        let m = patch_message("用 Tauri 写的", "用桌面框架写的", &["tauri".to_string()], false);
        assert!(m.contains("（原始转写）"));
        assert!(m.contains("用 Tauri 写的"));
        assert!(m.contains("（上一次的输出）"));
        assert!(m.contains("用桌面框架写的"));
        assert!(m.contains("「tauri」"));
        assert!(m.contains("其余内容一字不改"));
        assert!(!m.contains("概括"));
    }

    #[test]
    fn patch_message_flags_truncation() {
        let m = patch_message("raw", "prev", &[], true);
        assert!(m.contains("概括或删减"));
        assert!(m.contains("说了几件事就输出几件事"));
        // 同时存在两种问题时都点名
        let both = patch_message("raw", "prev", &["tauri".to_string()], true);
        assert!(both.contains("「tauri」"));
        assert!(both.contains("概括或删减"));
    }

    /* ---- 概括删减检测 ---- */

    #[test]
    fn truncation_detected_for_cjk_polish() {
        let c = cfg("polish", "");
        let raw = "明天上午十点开评审会，参加的有前端后端和测试，主要过登录流程和支付流程两个方案，会后要把结论同步给产品";
        // 砍掉一半以上细节 → 判定概括
        let short = "明天开会过方案，会后同步结论";
        assert!(truncation_violation(&c, raw, short));
        // 只去掉口头语级别的量 → 通过
        let ok = "明天上午十点开评审会，参加的有前端、后端和测试，主要过登录流程和支付流程两个方案，会后把结论同步给产品";
        assert!(!truncation_violation(&c, raw, ok));
    }

    #[test]
    fn truncation_stricter_for_correct_mode() {
        let c = cfg("correct", "");
        let raw = "这个方案我觉得整体可行但是细节还要再讨论一下风险点和回滚方案";
        // correct 只纠错不该动长度：0.8 倍也判定删减
        let out = "这个方案我觉得整体可行，但细节还要再讨论";
        assert!(truncation_violation(&c, raw, out));
    }

    #[test]
    fn truncation_skips_english_short_and_prompt() {
        let polish = cfg("polish", "");
        // 英文填充词多，合法润色砍一半也不判
        let raw = "um yeah so like I think maybe we should probably just refactor the whole module";
        let out = "We should refactor the whole module";
        assert!(!truncation_violation(&polish, raw, out));
        // 短文本不判
        assert!(!truncation_violation(&polish, "这个方案可行吗", "可行"));
        // prompt 模式整理成条目会收缩，不判
        let prompt = cfg("prompt", "");
        assert!(!truncation_violation(&prompt, "这个方案我觉得整体可行但是细节还要再讨论一下风险点和回滚方案", "可行"));
    }

    #[test]
    fn system_prompt_contains_examples_and_contract() {
        let polish = build_system_prompt(&cfg("polish", ""));
        assert!(polish.contains("一字不改"));
        assert!(polish.contains("示例"));
        let correct = build_system_prompt(&cfg("correct", ""));
        assert!(correct.contains("宁可少改"));
    }
}
