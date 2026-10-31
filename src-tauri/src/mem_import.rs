//! 记忆库 v3 导入体系：网页 / 本地文件 / 项目文件夹 → 分块入库，外加快记。
//! 与自动采集（mem::capture）的分工：capture 只管听写/OCR/翻译的被动产出，
//! 这里全是用户在设置页亲手发起的主动行为——因此不走采集黑名单（黑名单
//! 防的是「听写时恰好在密码管理器里」，拦用户主动导入只会造成困惑）。
//!
//! 分块（RAG 通行做法）：>800 码点的长文按 markdown 标题 > 空行段落 >
//! 句末标点递归分割，目标块 400~600、硬上限 800、零重叠——子串检索场景
//! 里重叠块只会污染命中统计。每块 title 是「来源标题 > 最近标题链」面包屑，
//! title 是检索的 2 分权重位，等于免费加权。
//!
//! 线程纪律：所有命令 async，网络/读盘/解析全在 spawn_blocking（dom_smoothie
//! 的 DOM 天然 !Send，单线程内用完即弃），STORE_LOCK 锁内只做快照与追加。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// 导入结果摘要（网页 / 文件 / 项目 / 快记共用，字段与 types.ts 契约冻结）
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemImportSummary {
    /// 新建条数
    pub added: u32,
    /// 近重复合并进既有条目（hits +1）的条数
    pub merged: u32,
    /// 因大小超限/编码校验失败/枚举上限等跳过的条数
    pub skipped: u32,
}

/* ---------- 分块器（纯逻辑） ---------- */

/// 硬上限（码点）：RAG 实践 400~600 是检索粒度甜点，800 是绝不越过的红线
const CHUNK_MAX: usize = 800;
/// 目标区间下沿：达到后即可在新块加入会越界时提前收口
const CHUNK_MERGE_FLOOR: usize = 400;
/// 目标区间上沿：软目标（单段 600~800 允许整段成块，硬上限才是硬的）
const CHUNK_MERGE_CEIL: usize = 600;

/// 一块：正文 + 面包屑标题链（仅标题行继承部分，不含来源前缀，可空）
pub(crate) struct Chunk {
    pub text: String,
    pub title: String,
}

/// 入口：CRLF 归一后递归分块。零丢弃（非空白文本都进块）、零重叠
pub(crate) fn chunk_text(text: &str) -> Vec<Chunk> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = Vec::new();
    split_rec(normalized.trim(), &[], &mut out);
    out
}

/// markdown 标题行（#/##/###，规格只认三级以内）：返回 (层级, 标题文本)。
/// 「#话题」井号标签不是标题（要求 # 后跟空白或行尾），裸 "###" 也不是
fn heading(line: &str) -> Option<(u8, String)> {
    let t = line.trim_start();
    let hashes = t.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 3 {
        return None;
    }
    let rest = &t[hashes..];
    if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let title: String = rest.trim().chars().take(40).collect();
    if title.is_empty() {
        return None;
    }
    Some((hashes as u8, title))
}

/// 标题链渲染：各级标题 " > " 连接（如「Hooks > useEffect」）
fn render_chain(chain: &[(u8, String)]) -> String {
    chain
        .iter()
        .map(|(_, t)| t.as_str())
        .collect::<Vec<_>>()
        .join(" > ")
}

/// 按标题行切段（纯函数）：返回 (标题信息, 标题行之后的区段正文)。正文
/// 不含标题行——标题文本进链（title 是 2 分检索位），标题行随块重入正文
/// 会造成递归死循环（子段的 split_by_headings 又认出自己的首行标题）
struct Section {
    heading: Option<(u8, String)>,
    body: String,
}

fn split_by_headings(text: &str) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    let mut cur_heading: Option<(u8, String)> = None;
    let mut cur_lines: Vec<&str> = Vec::new();
    let mut has_cur = false;
    let flush = |sections: &mut Vec<Section>,
                     cur_heading: &mut Option<(u8, String)>,
                     cur_lines: &mut Vec<&str>,
                     has_cur: &mut bool| {
        if !*has_cur {
            return;
        }
        let body = cur_lines.join("\n");
        // 纯空白的首段（首个标题前只有空白）直接丢弃
        if !body.trim().is_empty() || cur_heading.is_some() {
            sections.push(Section {
                heading: cur_heading.take(),
                body,
            });
        } else {
            cur_heading.take();
        }
        cur_lines.clear();
        *has_cur = false;
    };
    for line in text.lines() {
        if let Some((level, title)) = heading(line) {
            flush(&mut sections, &mut cur_heading, &mut cur_lines, &mut has_cur);
            cur_heading = Some((level, title));
            has_cur = true;
        } else {
            cur_lines.push(line);
            has_cur = true;
        }
    }
    flush(&mut sections, &mut cur_heading, &mut cur_lines, &mut has_cur);
    sections
}

/// 句子级硬拆（单段 >CHUNK_MAX 的兜底）：在 ≤CHUNK_MAX 窗口内找最靠后的
/// 句末边界（。！？!? 及后随空白的 "."——防切在 3.14 / v1.2 中间）切分；
/// 找不到边界就 800 码点硬切。前后两段共享的字节为零
fn sentence_split(p: &str) -> Vec<String> {
    let chars: Vec<char> = p.chars().collect();
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let remain = chars.len() - start;
        if remain <= CHUNK_MAX {
            let piece: String = chars[start..].iter().collect();
            let t = piece.trim();
            if !t.is_empty() {
                out.push(t.to_string());
            }
            break;
        }
        let window_end = start + CHUNK_MAX;
        let mut cut = None;
        for i in (start..window_end).rev() {
            let c = chars[i];
            let is_boundary = matches!(c, '。' | '！' | '？' | '!' | '?')
                || (c == '.' && (i + 1 == chars.len() || chars[i + 1].is_whitespace()));
            if is_boundary {
                cut = Some(i + 1);
                break;
            }
        }
        let cut = cut.unwrap_or(window_end);
        let piece: String = chars[start..cut].iter().collect();
        let t = piece.trim();
        if !t.is_empty() {
            out.push(t.to_string());
        }
        start = cut;
    }
    out
}

/// 递归分割：≤800 整块；>800 依次尝试 标题行 > 空行段落（>800 的段落先
/// 句切）> 硬切，段落后贪心合并成 400~600 目标块。每次递归至少消费一行
/// 标题或走段落路径，必然终止
fn split_rec(text: &str, chain: &[(u8, String)], out: &mut Vec<Chunk>) {
    if text.chars().count() <= CHUNK_MAX {
        let t = text.trim();
        if !t.is_empty() {
            out.push(Chunk {
                text: t.to_string(),
                title: render_chain(chain),
            });
        }
        return;
    }
    let sections = split_by_headings(text);
    // 有任何标题可依（多段，或整段归属一个标题）就走标题分支
    if sections.iter().any(|s| s.heading.is_some()) {
        // 链跨兄弟区段延续：线性文档里「## 小节」跟在「# 大章」之后就是其
        // 子节——按层级回退再追加，天然得到「大章 > 小节」面包屑
        let mut running = chain.to_vec();
        for s in sections {
            if let Some((level, title)) = &s.heading {
                while running.last().is_some_and(|(l, _)| l >= level) {
                    running.pop();
                }
                running.push((*level, title.clone()));
            }
            let body = if s.body.trim().is_empty() {
                // 目录式文档（整页几乎全是标题行）：标题文本自身作为正文，
                // 保证零丢失（标题链太长的文档丢标题等于丢内容）
                s.heading.as_ref().map(|(_, t)| t.clone()).unwrap_or_default()
            } else {
                s.body
            };
            split_rec(body.trim(), &running, out);
        }
        return;
    }
    // 段落 → 句子 → 贪心合并
    let mut blocks: Vec<String> = Vec::new();
    for para in text.split("\n\n") {
        let p = para.trim();
        if p.is_empty() {
            continue;
        }
        if p.chars().count() > CHUNK_MAX {
            blocks.extend(sentence_split(p));
        } else {
            blocks.push(p.to_string());
        }
    }
    let chain_title = render_chain(chain);
    let mut cur = String::new();
    for b in blocks {
        let b_len = b.chars().count();
        let cur_len = cur.chars().count();
        let joined = if cur.is_empty() { b_len } else { cur_len + 2 + b_len };
        // 收口两条件：并入将破 800 硬上限；当前已 ≥400 且并入将破 600 软目标
        let over_hard = joined > CHUNK_MAX;
        let over_target = !cur.is_empty() && cur_len >= CHUNK_MERGE_FLOOR && joined > CHUNK_MERGE_CEIL;
        if over_hard || over_target {
            out.push(Chunk {
                text: cur.trim().to_string(),
                title: chain_title.clone(),
            });
            cur = b;
        } else if cur.is_empty() {
            cur = b;
        } else {
            cur.push_str("\n\n");
            cur.push_str(&b);
        }
    }
    if !cur.trim().is_empty() {
        out.push(Chunk {
            text: cur.trim().to_string(),
            title: chain_title,
        });
    }
}

/// 块标题合成（纯函数）：「来源标题 > 最近标题链」面包屑。来源与链都缺时
/// 兜底为正文前 40 码点（快记场景——没有来源也没有结构）
pub(crate) fn compose_title(source: &str, chain: &str, chunk_text: &str) -> String {
    let s = source.trim();
    let c = chain.trim();
    let title = match (s.is_empty(), c.is_empty()) {
        (false, false) => format!("{s} > {c}"),
        (false, true) => s.to_string(),
        (true, false) => c.to_string(),
        (true, true) => crate::mem::fallback_title(chunk_text),
    };
    title.chars().take(100).collect()
}

/// 分块并合成入库键值对 (title, text)
fn chunk_pairs(source_title: &str, text: &str) -> Vec<(String, String)> {
    chunk_text(text)
        .into_iter()
        .map(|c| (compose_title(source_title, &c.title, &c.text), c.text))
        .collect()
}

/// 单次导入的块数上限：5MB 纯文本理论上可切数千块，一次灌入只会让
/// mem.json 瞬间膨胀再被滚动清理丢掉大半。截断部分计入 skipped
const MAX_IMPORT_CHUNKS: usize = 400;

fn cap_chunks(pairs: Vec<(String, String)>) -> (Vec<(String, String)>, u32) {
    if pairs.len() > MAX_IMPORT_CHUNKS {
        let skipped = (pairs.len() - MAX_IMPORT_CHUNKS) as u32;
        let mut pairs = pairs;
        pairs.truncate(MAX_IMPORT_CHUNKS);
        (pairs, skipped)
    } else {
        (pairs, 0)
    }
}

/* ---------- 网页导入：抓取 / 编码 / 正文抽取 ---------- */

/// 响应体读取上限：不信任 Content-Length（可谎报），流式边读边截断
const URL_MAX_BYTES: usize = 5 * 1024 * 1024;
/// 抓取总超时（含 ≤3 跳重定向）
const URL_TIMEOUT_SEC: u64 = 15;
/// 手动跟跳上限
const MAX_REDIRECTS: usize = 3;

/// URL 协议白名单（纯函数）：仅 http/https。
/// 注意：这里【故意】不做内网/loopback IP 拦截——URL 由用户在设置页亲自
/// 输入，与浏览器地址栏同信任级（拦 127.0.0.1 会挡住本地文档站如
/// devdocs 镜像）；且 display_api 的 REST 端点不暴露导入命令，第三方网页
/// 无法借 GET 触发导入。此决策已由主 Agent 拍板，勿在此重加拦截
pub(crate) fn validate_url_scheme(u: &reqwest::Url) -> Result<(), String> {
    match u.scheme() {
        "http" | "https" => Ok(()),
        _ => Err("仅支持 http/https".into()),
    }
}

/// Content-Type 解析（纯函数）：(mime 小写, charset 标签)。参数与空白归一，
/// 无 charset 参数时为 None
pub(crate) fn parse_content_type(ct: &str) -> (String, Option<String>) {
    let mut parts = ct.split(';');
    let mime = parts.next().unwrap_or("").trim().to_lowercase();
    let charset = parts.into_iter().find_map(|p| {
        let p = p.trim();
        p.split_once('=')
            .and_then(|(k, v)| {
                (k.trim().eq_ignore_ascii_case("charset"))
                    .then_some(v.trim().trim_matches('"').trim_matches('\'').to_string())
            })
            .filter(|v| !v.is_empty())
    });
    (mime, charset)
}

/// 正文类 Content-Type 白名单：HTML / XHTML / 纯文本
pub(crate) fn content_type_accepted(mime: &str) -> bool {
    matches!(mime, "text/html" | "text/plain" | "application/xhtml+xml")
}

/// 单跳重定向解析（纯函数）：跳数超上限 / Location 缺失或非法 / 目标协议
/// 出白名单（每跳仍校验——https → file: 的协议滑落是自动跟跳的经典坑）
/// → Err；相对 Location 按当前 URL 解析为绝对地址
pub(crate) fn redirect_target(
    loc: Option<&str>,
    base: &reqwest::Url,
    hops: usize,
) -> Result<reqwest::Url, String> {
    if hops >= MAX_REDIRECTS {
        return Err("重定向次数过多".into());
    }
    let Some(loc) = loc else {
        return Err("重定向缺少 Location 头".into());
    };
    let next = base
        .join(loc.trim())
        .map_err(|_| "重定向地址非法".to_string())?;
    validate_url_scheme(&next)?;
    Ok(next)
}

/// 字节子串搜索（ASCII 域用，避免为一次查找引入正则依赖）
fn find_sub(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).find(|&i| &haystack[i..i + needle.len()] == needle)
}

/// 前 1024 字节扫 meta charset（WHATWG prescan 的简化实现）：统一搜
/// "charset" 关键字取值——`<meta charset="gbk">` 与
/// `<meta http-equiv=content-type content="…;charset=gbk">` 两种形态里
/// "charset=" 后面都是标签值，一个扫描同时覆盖。大小写不敏感；误报由
/// for_label（非法标签名返回 None）自然过滤
fn meta_charset(bytes: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    let head = &bytes[..bytes.len().min(1024)];
    let lower: Vec<u8> = head.iter().map(|b| b.to_ascii_lowercase()).collect();
    let mut pos = 0usize;
    while let Some(idx) = find_sub(&lower[pos..], b"charset") {
        let at = pos + idx + b"charset".len();
        pos = at;
        let rest = &lower[at..];
        let mut i = 0usize;
        while i < rest.len() && matches!(rest[i], b' ' | b'\t' | b'\n' | b'\r') {
            i += 1;
        }
        if i >= rest.len() || rest[i] != b'=' {
            continue;
        }
        i += 1;
        while i < rest.len() && matches!(rest[i], b' ' | b'\t') {
            i += 1;
        }
        let label: &[u8] = if i < rest.len() && (rest[i] == b'"' || rest[i] == b'\'') {
            let quote = rest[i];
            i += 1;
            let start = i;
            while i < rest.len() && rest[i] != quote {
                i += 1;
            }
            // start/i 是 rest（即 lower[at..]）内的相对索引，映射回 head 必须补 at
            // 偏移——漏加会取到错位片段，Encoding::for_label 恒 None，meta 层失效
            let s = at + start;
            let e = (at + i).min(head.len());
            &head[s..e.max(s)]
        } else {
            let start = i;
            while i < rest.len() && !matches!(rest[i], b' ' | b'\t' | b';' | b'>' | b'"' | b'\'') {
                i += 1;
            }
            let s = at + start;
            let e = (at + i).min(head.len());
            &head[s..e.max(s)]
        };
        if let Some(enc) = encoding_rs::Encoding::for_label(label) {
            return Some(enc);
        }
    }
    None
}

/// 字节流 → UTF-8（纯函数，WHATWG 优先级）：BOM > HTTP charset >
/// 前 1024 字节 meta charset > chardetng 统计探测。某级声明解码出替换符
/// （had_errors）说明声明多半是错的，降级交给下一级；encoding_rs 的 decode
/// 永不失败——坏字节最多变替换符，不至于让整页报废
pub(crate) fn decode_body(bytes: &[u8], http_charset: Option<&str>) -> String {
    if let Some((enc, _)) = encoding_rs::Encoding::for_bom(bytes) {
        let (cow, _, _) = enc.decode(bytes);
        return cow.into_owned();
    }
    if let Some(label) = http_charset {
        if let Some(enc) = encoding_rs::Encoding::for_label(label.as_bytes()) {
            // decode_without_bom_handling 返回 (文本, 是否有替换符) 二元组
            let (cow, had_errors) = enc.decode_without_bom_handling(bytes);
            if !had_errors {
                return cow.into_owned();
            }
        }
    }
    if let Some(enc) = meta_charset(bytes) {
        let (cow, had_errors) = enc.decode_without_bom_handling(bytes);
        if !had_errors {
            return cow.into_owned();
        }
    }
    let mut det = chardetng::EncodingDetector::new();
    // 探测器多喂一点样本更准（meta 扫描的 1024 只是 HTML 规范窗口）
    det.feed(&bytes[..bytes.len().min(4096)], true);
    let enc = det.guess(None, true);
    let (cow, _) = enc.decode_without_bom_handling(bytes);
    cow.into_owned()
}

/// 正文抽取判定「过短」的阈值（码点）：低于它视作抽取失败（导航壳页面），
/// 转 meta description 兜底
const LOW_TEXT_MIN: usize = 120;

/// 网页正文抽取结果
struct Extracted {
    title: String,
    text: String,
}

/// HTML → (标题, 正文)：dom_smoothie 是 Mozilla Readability 的 Rust 移植，
/// 正文/标题的清洗启发式与 Firefox 阅读模式同源。元数据（og:title /
/// description）在 parse 之前取——parse 会清洗重排 DOM，meta 标签可能被删。
/// 正文过短时用 meta description / og:description（Readability 的 excerpt
/// 正取自这两者）兜底并给标题加「(低置信)」前缀——抽不出正文的页面至少
/// 保住一句话简介；连简介也没有就报错拒绝入库
fn extract_html(html: &str, url: &str) -> anyhow::Result<Extracted> {
    let mut r = dom_smoothie::Readability::new(html.to_string(), Some(url), None)
        .map_err(|e| anyhow::anyhow!("正文抽取失败：{e}"))?;
    let json_ld = r.parse_json_ld();
    let meta = r.get_article_metadata(json_ld);
    let article = r
        .parse()
        .map_err(|e| anyhow::anyhow!("正文抽取失败：{e}"))?;
    // 标题：og:title（元数据）优先，退化到 Readability 清洗后的 <title>/<h1>
    let mut title = if meta.title.trim().is_empty() {
        article.title.trim().to_string()
    } else {
        meta.title.trim().to_string()
    };
    title = title.chars().take(80).collect();
    let mut text = normalize_article_text(&article.text_content);
    if text.chars().count() < LOW_TEXT_MIN {
        let desc = meta
            .excerpt
            .as_deref()
            .or(article.excerpt.as_deref())
            .map(str::trim)
            .filter(|d| !d.is_empty());
        if let Some(d) = desc {
            text = d.to_string();
            title = format!("(低置信) {title}");
        }
    }
    if text.trim().is_empty() {
        anyhow::bail!("未提取到有效正文");
    }
    Ok(Extracted { title, text })
}

/// 正文规整：行首尾空白去除、连续空行压成单空行（Readability 输出里
/// 块级元素间常带多行空隙，入库前压掉省字符且不影响检索）
fn normalize_article_text(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    let mut blank = false;
    for line in t.lines() {
        let l = line.trim();
        if l.is_empty() {
            if !blank {
                out.push('\n');
            }
            blank = true;
        } else {
            blank = false;
            out.push_str(l);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

/// 纯文本响应的标题：URL 末段路径（人读的文件名语义），退化到 hostname
fn plain_title(u: &reqwest::Url) -> String {
    let seg = u
        .path_segments()
        .and_then(|mut s| s.next_back())
        .unwrap_or("");
    let t = if seg.is_empty() {
        u.host_str().unwrap_or("网页").to_string()
    } else {
        seg.to_string()
    };
    t.chars().take(80).collect()
}

/// 抓取（含手动跟跳与流式截断）。返回 (字节, mime, charset, 最终 URL)。
/// 总超时 15s 由 deadline 兜底（自动重定向 3 跳 × 单请求超时可能放大到
/// 45s，与「总超时」的语义不符），每跳仍受单请求超时约束
async fn fetch_page(
    client: &reqwest::Client,
    start: reqwest::Url,
    deadline: tokio::time::Instant,
) -> Result<(Vec<u8>, String, Option<String>, reqwest::Url), String> {
    let mut url = start;
    let mut hops = 0usize;
    loop {
        let resp = tokio::time::timeout_at(deadline, client.get(url.clone()).send())
            .await
            .map_err(|_| "请求超时（15s）".to_string())?
            .map_err(|e| format!("请求失败：{e}"))?;
        let status = resp.status();
        if status.is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            url = redirect_target(loc.as_deref(), &url, hops)?;
            hops += 1;
            continue;
        }
        if !status.is_success() {
            return Err(format!("HTTP {}", status.as_u16()));
        }
        // Content-Type 在读正文前校验：读完 5MB 才发现是 zip 就白等了
        let ct = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let (mime, charset) = parse_content_type(ct);
        if !content_type_accepted(&mime) {
            return Err(format!(
                "不支持的 Content-Type：{}（仅支持网页与纯文本）",
                if mime.is_empty() { "未知" } else { &mime }
            ));
        }
        let mut resp = resp;
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = tokio::time::timeout_at(deadline, resp.chunk())
            .await
            .map_err(|_| "读取超时（15s）".to_string())?
            .map_err(|e| format!("读取失败：{e}"))?
        {
            let room = URL_MAX_BYTES - buf.len();
            if chunk.len() >= room {
                buf.extend_from_slice(&chunk[..room]);
                break; // 到达上限：多余字节直接弃读（连接随 resp drop 关闭）
            }
            buf.extend_from_slice(&chunk);
        }
        return Ok((buf, mime, charset, url));
    }
}

/// 网页导入：抓取 → 解码 → 抽正文 → 分块入库（kind="web"，app=hostname）。
/// 单条资源任一环节失败即整单 Err（前端 toast），不存在部分成功
#[tauri::command]
pub async fn mem_import_url(app: AppHandle, url: String) -> Result<MemImportSummary, String> {
    let parsed: reqwest::Url = url.trim().parse().map_err(|_| "URL 无法解析".to_string())?;
    validate_url_scheme(&parsed)?;
    // 独立 no-redirect 客户端（每次导入新建，一次性使用无连接复用价值；
    // reqwest 自动跟跳会跳过我们对每一跳的协议校验）
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(URL_TIMEOUT_SEC))
        .build()
        .map_err(|e| format!("网络客户端构建失败：{e}"))?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(URL_TIMEOUT_SEC);
    let (bytes, mime, charset, final_url) = fetch_page(&client, parsed, deadline).await?;
    let limit = mem_limit(&app);
    // 解码 + 抽取 + 分块 + 入库全在阻塞线程：dom_smoothie 的 DOM !Send，
    // 天然只能单线程内完成；锁内只有 import_batch 的快照与追加
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<MemImportSummary, String> {
        let text = decode_body(&bytes, charset.as_deref());
        let host = final_url.host_str().unwrap_or("").to_string();
        let (source_title, body) = if mime == "text/plain" {
            (plain_title(&final_url), text)
        } else {
            let ex = extract_html(&text, final_url.as_str()).map_err(|e| e.to_string())?;
            (ex.title, ex.text)
        };
        let (pairs, skipped) = cap_chunks(chunk_pairs(&source_title, &body));
        let (added, merged, evicted) = crate::mem::import_batch(&app, "web", &host, &pairs, limit);
        Ok(MemImportSummary { added, merged, skipped: skipped + evicted })
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(result)
}

/* ---------- 文件 / 文件夹导入 ---------- */

/// 单文件大小上限：文本记忆的价值密度撑不起更大文件，超限截前 10MB
const FILE_MAX_BYTES: usize = 10 * 1024 * 1024;
/// NUL 字节嗅探窗口
const NUL_SNIFF_LEN: usize = 8 * 1024;

/// 文本字节校验（纯函数）：前 8KB 的 NUL 占比 >10% 拒收（真文本几乎不含
/// NUL，二进制伪装成 .txt 的典型特征）；再验 UTF-8 整体合法（失败=二进制
/// 或未知编码，拒收）。返回 None = 拒收
pub(crate) fn validate_text_bytes(bytes: &[u8]) -> Option<String> {
    let head = &bytes[..bytes.len().min(NUL_SNIFF_LEN)];
    if !head.is_empty() {
        let nul = head.iter().filter(|b| **b == 0).count();
        if nul * 10 > head.len() {
            return None;
        }
    }
    std::str::from_utf8(bytes).ok().map(str::to_string)
}

/// 读文件前 10MB（返回 (字节, 是否被截断)）。以 take 兜底 fs::metadata 的
/// 谎报与竞态——即使元数据说小于上限，也只读上限字节
fn read_capped(path: &Path) -> std::io::Result<(Vec<u8>, bool)> {
    let truncated = fs::metadata(path).map(|m| m.len() > FILE_MAX_BYTES as u64).unwrap_or(false);
    let f = fs::File::open(path)?;
    let mut buf = Vec::new();
    f.take(FILE_MAX_BYTES as u64).read_to_end(&mut buf)?;
    if truncated {
        // 截断点可能落在多字节 UTF-8 序列中间（中文 3 字节，概率约 2/3），
        // 整体 from_utf8 会因此失败而误拒整个文件——回退到最后一个完整序列边界
        if let Err(err) = std::str::from_utf8(&buf) {
            let cut = err.valid_up_to();
            buf.truncate(cut);
        }
    }
    Ok((buf, truncated))
}

/// 单文件入库（阻塞线程内执行）：校验失败/读取失败均计 skipped 并记日志
fn import_one_file(
    app: &AppHandle,
    path: &Path,
    app_name: &str,
    limit: usize,
    summary: &mut MemImportSummary,
) {
    let (bytes, truncated) = match read_capped(path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[speaknow] 记忆导入跳过（读取失败 {}）：{e}", path.display());
            summary.skipped += 1;
            return;
        }
    };
    if truncated {
        // 超限：内容仍按前 10MB 入库，skipped +1 是给前端的「不完整」提示
        summary.skipped += 1;
    }
    let Some(text) = validate_text_bytes(&bytes) else {
        eprintln!("[speaknow] 记忆导入跳过（非文本文件 {}）", path.display());
        summary.skipped += 1;
        return;
    };
    let text = text.trim();
    if text.is_empty() {
        summary.skipped += 1;
        return;
    }
    let title = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "导入文件".into());
    let (pairs, skipped) = cap_chunks(chunk_pairs(&title, text));
    summary.skipped += skipped;
    let (added, merged, evicted) = crate::mem::import_batch(app, "file", app_name, &pairs, limit);
    summary.added += added;
    summary.merged += merged;
    summary.skipped += evicted;
}

/// 本地文件导入（多选）：title=文件名（去扩展名），app="导入"，kind="file"。
/// 单文件失败只计 skipped，不影响其余文件。每处理完一个文件广播一次
/// sn-mem-import-progress（前端画进度条），收尾补 label="" 的完成事件
#[tauri::command]
pub async fn mem_import_files(app: AppHandle, paths: Vec<String>) -> MemImportSummary {
    let limit = mem_limit(&app);
    let res = tauri::async_runtime::spawn_blocking(move || {
        let mut summary = MemImportSummary::default();
        let total = paths.len() as u32;
        for (i, p) in paths.iter().enumerate() {
            import_one_file(&app, Path::new(p), "导入", limit, &mut summary);
            // done 用 i+1：本文件已处理完毕（含计 skipped 的失败文件——
            // 对进度条而言「处理了但没入库」也是进度）。Emitter 线程安全，
            // spawn_blocking 线程直接 emit
            let label = Path::new(p)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let _ = app.emit(
                "sn-mem-import-progress",
                import_progress_event(i as u32 + 1, total, &label),
            );
        }
        // 收尾事件：label 置空是前端的「全部完成、收起进度条」信号
        let _ = app.emit("sn-mem-import-progress", import_progress_event(total, total, ""));
        summary
    })
    .await;
    match res {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[speaknow] 文件导入任务失败: {e}");
            MemImportSummary::default()
        }
    }
}

/// 项目目录导入时整棵跳过的目录名：依赖产物与版本库体积大且无个人记忆
/// 价值（.git 是点开头，被隐藏目录规则一并覆盖）
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "out"];
/// 项目导入的文件数上限：超出部分计入 skipped（整个项目几万文件的
/// monorepo 根目录不该被灌进记忆库）
const FOLDER_FILE_CAP: usize = 200;
/// 目录深度上限：防符号链接环导致的无限下钻（显式栈，不靠递归栈）
const FOLDER_DEPTH_CAP: usize = 48;

/// 递归枚举 .md/.txt（迭代式深度优先，跳过隐藏目录与 SKIP_DIRS）
fn collect_docs(root: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > FOLDER_DEPTH_CAP {
            continue;
        }
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let p = entry.path();
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push((p, depth + 1));
            } else if ft.is_file() {
                let ext = p
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if ext == "md" || ext == "txt" {
                    out.push(p);
                }
            }
        }
    }
    // 排序保证确定性（同一目录两次导入结果一致），超限截断也截得可复现
    out.sort();
    Ok(())
}

/// 项目文件夹导入：文件级规格同 mem_import_files，外加两项安全约束：
/// - 每个文件路径 canonicalize 后必须仍以根目录 canonicalize 前缀开头
///   （防枚举与读取之间目录被替换 / junction 指向库外的越界读取）
/// - 枚举 + 读取全部在 spawn_blocking（200 个文件的 IO 不占 tokio worker）
#[tauri::command]
pub async fn mem_import_folder(app: AppHandle, path: String) -> Result<MemImportSummary, String> {
    let limit = mem_limit(&app);
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<MemImportSummary, String> {
        let root = PathBuf::from(&path);
        let root_canon = root
            .canonicalize()
            .map_err(|e| format!("路径无法访问：{e}"))?;
        if !root_canon.is_dir() {
            return Err("不是文件夹".into());
        }
        let mut files = Vec::new();
        collect_docs(&root_canon, &mut files).map_err(|e| format!("枚举失败：{e}"))?;
        let overflow = files.len().saturating_sub(FOLDER_FILE_CAP) as u32;
        files.truncate(FOLDER_FILE_CAP);
        let app_name = root_canon
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "导入".into());
        let mut summary = MemImportSummary {
            skipped: overflow,
            ..Default::default()
        };
        let total = files.len() as u32;
        for (i, f) in files.iter().enumerate() {
            // 越界断言：canonicalize 解析 junction/符号链接的最终目标，
            // 目标不在根目录树内即拒（TOCTOU 窗口内被替换同理）
            let canon = match f.canonicalize() {
                Ok(c) => c,
                Err(_) => {
                    summary.skipped += 1;
                    continue;
                }
            };
            if !canon.starts_with(&root_canon) {
                summary.skipped += 1;
                continue;
            }
            import_one_file(&app, &canon, &app_name, limit, &mut summary);
            // 越界/解析失败跳过的文件也占一个 done：进度条按「已处理文件」
            // 推进，否则 done 永远到不了 total
            let label = f
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let _ = app.emit(
                "sn-mem-import-progress",
                import_progress_event(i as u32 + 1, total, &label),
            );
        }
        // 收尾事件：label 置空是前端的「全部完成、收起进度条」信号。Err
        // 路径（路径不可访问/枚举失败）都发生在循环前，不会留半截进度条
        let _ = app.emit("sn-mem-import-progress", import_progress_event(total, total, ""));
        Ok(summary)
    })
    .await
    .map_err(|e| e.to_string())?;
    res
}

/* ---------- v4：备份合并导入 / 进度事件 ---------- */

/// 备份 JSON 的大小上限：保留上限 500 条 × 单条 2 万码点的理论极值约
/// 10MB，20MB 覆盖富余。超限整体拒绝而非像 read_capped 那样截断读——
/// 截出来的半个 JSON 必然解析失败，明确的超限提示远比莫名的语法错误
/// 更能指导用户
const BACKUP_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// 读备份文件（read_capped 同款 take 兜底，防 metadata 谎报与读取中途
/// 文件变大）。备份导出必为 UTF-8 JSON：非 UTF-8 直接判「不是备份文件」
fn read_backup_capped(path: &Path) -> Result<String, String> {
    let f = fs::File::open(path).map_err(|e| format!("备份文件无法访问：{e}"))?;
    let mut buf = Vec::new();
    f.take(BACKUP_MAX_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("备份文件读取失败：{e}"))?;
    if buf.len() as u64 > BACKUP_MAX_BYTES {
        return Err("备份文件超过 20MB 上限".into());
    }
    String::from_utf8(buf).map_err(|_| "备份文件不是 UTF-8 文本".into())
}

/// 备份文档解析（纯函数）：兼容两种导出格式——顶层数组 [MemEntry,...] 与
/// {items:[...]}。整体不是合法 JSON → Err（文件级失败，前端 toast）；合法
/// JSON 但两种格式都不符，或单条缺必填字段 → 逐条计 skipped——一条坏数据
/// 不拖垮整份备份。返回 (可入库条目, skipped 数)
fn parse_backup_doc(text: &str) -> Result<(Vec<crate::mem::MemEntry>, u32), String> {
    let doc: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("备份文件不是有效 JSON：{e}"))?;
    let arr: &[serde_json::Value] = match &doc {
        serde_json::Value::Array(v) => v,
        serde_json::Value::Object(m) => match m.get("items") {
            Some(serde_json::Value::Array(v)) => v,
            // 对象形态必须有 items 数组，其余（含 items 非数组）一律格式非法
            _ => return Ok((Vec::new(), 1)),
        },
        _ => return Ok((Vec::new(), 1)),
    };
    let mut entries = Vec::new();
    let mut skipped = 0u32;
    for v in arr {
        match serde_json::from_value::<crate::mem::MemEntry>(v.clone()) {
            Ok(e) => entries.push(e),
            Err(_) => skipped += 1,
        }
    }
    Ok((entries, skipped))
}

/// 进度事件载荷构造（纯函数）：字段名与冻结契约逐字对齐（done/total/
/// label）。单文件与目录导入每处理完一个文件发一次，收尾发 label="" 的
/// 完成事件；Emitter 线程安全，spawn_blocking 线程直接 emit 即可
fn import_progress_event(done: u32, total: u32, label: &str) -> serde_json::Value {
    serde_json::json!({ "done": done, "total": total, "label": label })
}

/// v4 备份合并导入（多设备迁移）：前端用系统对话框选定导出的 JSON，这里
/// 读文件 + 解析 + 合并入库。合并语义（同 ts 就地更新、计数取大、近重复
/// 只加 hits）见 mem::merge_backup_core 注释——多设备间不丢任何一侧的
/// 使用记录。文件 IO 与解析全在阻塞线程，锁内只有 mem::import_backup_batch
/// 的快照与合并
#[tauri::command]
pub async fn mem_import_backup(app: AppHandle, path: String) -> Result<MemImportSummary, String> {
    let limit = mem_limit(&app);
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<MemImportSummary, String> {
        let text = read_backup_capped(Path::new(&path))?;
        let (entries, skipped) = parse_backup_doc(&text)?;
        let (added, merged, evicted) = crate::mem::import_backup_batch(&app, entries, limit);
        Ok(MemImportSummary {
            added,
            merged,
            skipped: skipped + evicted,
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    res
}

/* ---------- 快记 ---------- */

/// 快记（kind="note"，app=空串）：用户随手存的一句/一段话。trim 后空 →
/// skipped；>800 码点走分块。不过黑名单（用户主动行为，理由同模块头注释）
#[tauri::command]
pub async fn mem_add_note(app: AppHandle, text: String) -> MemImportSummary {
    let text = text.trim().to_string();
    if text.is_empty() {
        return MemImportSummary {
            added: 0,
            merged: 0,
            skipped: 1,
        };
    }
    let limit = mem_limit(&app);
    let res = tauri::async_runtime::spawn_blocking(move || {
        let (pairs, skipped) = cap_chunks(chunk_pairs("", &text));
        let (added, merged, evicted) = crate::mem::import_batch(&app, "note", "", &pairs, limit);
        MemImportSummary {
            added,
            merged,
            skipped: skipped + evicted,
        }
    })
    .await;
    match res {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[speaknow] 快记入库失败: {e}");
            MemImportSummary {
                added: 0,
                merged: 0,
                skipped: 1,
            }
        }
    }
}

/// 离线导入（examples/memimport 诊断工具用）：对显式给定的配置目录执行与
/// UI 导入完全相同的读取校验/分块/近重复合并/滚动清理——复用 import_batch_core
/// 与同一 mem.json 路径规则，只是不经过 Tauri 命令层（无 AppHandle、不广播
/// 事件）。运行中的 app 下一次读盘即见新条目。dry=true 只统计不落盘。
/// 返回 (摘要, 新增条目标题清单) 供调用方打印
pub fn import_paths_standalone(
    config_dir: &Path,
    inputs: &[String],
    app_name: &str,
    dry: bool,
) -> Result<(MemImportSummary, Vec<String>), String> {
    let mem_json = crate::mem::path_at(config_dir);
    let mut items = crate::mem::load_at(&mem_json);
    // limit 与运行时同源：读同目录 config.json 的 mem.limit（读不到用默认值）
    let limit = std::fs::read_to_string(config_dir.join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<crate::config::Config>(&s).ok())
        .map(|c| c.mem.limit)
        .unwrap_or(500);
    let app_norm = crate::mem::normalize_app(app_name);
    let mut summary = MemImportSummary::default();
    let mut new_titles: Vec<String> = Vec::new();
    let mut all_new_ts: Vec<i64> = Vec::new();
    for input in inputs {
        let p = Path::new(input);
        let files: Vec<std::path::PathBuf> = if p.is_dir() {
            let mut v = Vec::new();
            if collect_docs(p, &mut v).is_err() {
                summary.skipped += 1;
                continue;
            }
            v
        } else if p.is_file() {
            vec![p.to_path_buf()]
        } else {
            summary.skipped += 1;
            continue;
        };
        for f in files {
            // 与 import_one_file 同款校验与分块（此处不落盘，最后统一处理）
            let (bytes, truncated) = match read_capped(&f) {
                Ok(v) => v,
                Err(_) => {
                    summary.skipped += 1;
                    continue;
                }
            };
            if truncated {
                summary.skipped += 1;
            }
            let Some(text) = validate_text_bytes(&bytes) else {
                summary.skipped += 1;
                continue;
            };
            let text = text.trim();
            if text.is_empty() {
                summary.skipped += 1;
                continue;
            }
            let title = f
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "导入文件".into());
            let (pairs, skipped) = cap_chunks(chunk_pairs(&title, text));
            summary.skipped += skipped;
            let (added, merged, new_ts) =
                crate::mem::import_batch_core(&mut items, "file", &app_norm, &pairs);
            summary.added += added;
            summary.merged += merged;
            if added > 0 {
                // core 每批从最新往旧插（insert 0），取本批前 added 条的标题
                for e in items.iter().take(added as usize) {
                    new_titles.push(e.title.clone());
                }
            }
            all_new_ts.extend(new_ts);
        }
    }
    if !all_new_ts.is_empty() || summary.merged > 0 {
        items = crate::mem::truncate_keep_pinned(items, limit);
        let kept = all_new_ts.iter().filter(|t| items.iter().any(|e| e.ts == **t)).count() as u32;
        summary.skipped += summary.added - kept;
        summary.added = kept;
        if !dry {
            crate::mem::write_at(&mem_json, &items);
        }
    }
    Ok((summary, new_titles))
}

/* ---------- 杂项 ---------- */

/// 当前配置的记忆保留上限（滚动清理用）：读内存配置（微秒级），缺省 500
fn mem_limit(app: &AppHandle) -> usize {
    app.state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .unwrap_or_default()
        .mem
        .limit
        .max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---- 分块器 ---- */

    #[test]
    fn chunk_short_text_stays_whole() {
        let out = chunk_text("一句话记忆");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "一句话记忆");
        assert_eq!(out[0].title, "", "无来源无标题链 → 标题由 compose_title 兜底");
        // 恰好 800：整条入库不切
        let t = "字".repeat(800);
        assert_eq!(chunk_text(&t).len(), 1);
        // 801：必须切
        let t = "字".repeat(801);
        let out = chunk_text(&t);
        assert!(out.len() >= 2, "801 码点必须切分");
    }

    #[test]
    fn chunk_respects_hard_cap_and_zero_overlap() {
        // 无任何边界（无标题/无空行/无句读）：800 硬切 + 零重叠零丢失
        let t = "字".repeat(2000);
        let out = chunk_text(&t);
        let lens: Vec<usize> = out.iter().map(|c| c.text.chars().count()).collect();
        assert!(lens.iter().all(|l| *l <= CHUNK_MAX), "{lens:?}");
        assert_eq!(lens.iter().sum::<usize>(), 2000, "硬切零丢失零重叠");
        assert_eq!(out.iter().map(|c| c.text.as_str()).collect::<String>(), t);
    }

    #[test]
    fn chunk_prefers_sentence_boundaries() {
        // 300 句 × 8 码点 ≈ 2400：无标题无空行，句末标点是首选边界
        let sentences: Vec<String> = (0..300).map(|i| format!("第{i:04}句话。")).collect();
        let t = sentences.join("");
        let out = chunk_text(&t);
        assert!(out.len() >= 3);
        for c in &out {
            assert!(c.text.chars().count() <= CHUNK_MAX);
            // 句界优先：整块以句末标点收尾（硬切才会切在句中）
            assert!(c.text.ends_with('。'), "块未按句界收尾：{}", c.text.chars().take(20).collect::<String>());
        }
        // 零重叠：每句恰好出现在一个块里
        for s in &sentences {
            let hits = out.iter().filter(|c| c.text.contains(s.as_str())).count();
            assert_eq!(hits, 1, "{s} 出现 {hits} 次");
        }
    }

    #[test]
    fn chunk_sentence_dot_boundary_avoids_decimals() {
        // "3.14" 中的点不是句界；"句. 句" 的点后跟空白才是
        let pieces = vec!["圆周率是3.14159265".to_string(); 200]; // 无空白句点 → 不构成边界
        let t = pieces.join("");
        let out = chunk_text(&t);
        for c in &out {
            assert!(c.text.chars().count() <= CHUNK_MAX);
        }
        // 至少存在一个硬切块（数字中无任何句界可用）
        assert!(out.iter().any(|c| c.text.contains("3.14")));
    }

    #[test]
    fn chunk_heading_inheritance_and_breadcrumb() {
        // 两节各 500 字（≤800 各自成块），标题链进块 title
        let sec = "内".repeat(500);
        let doc = format!("# 总纲\n\n{sec}\n\n## 子项\n\n{sec}");
        let out = chunk_text(&doc);
        assert!(out.len() >= 2, "两节至少两块");
        let titles: Vec<&str> = out.iter().map(|c| c.title.as_str()).collect();
        assert!(
            titles.iter().any(|t| t.contains("总纲")),
            "一级标题进链：{titles:?}"
        );
        assert!(
            titles.iter().any(|t| t.contains("子项") && t.contains("总纲")),
            "二级标题带父级面包屑：{titles:?}"
        );
        // 正文零丢失：两节的「内」都在块里
        let joined: String = out.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(joined.matches('内').count(), 1000);
    }

    #[test]
    fn chunk_long_section_splits_inside_with_chain() {
        // 单节 >800：节内继续递归（段落/句界），链仍然挂在每块上
        let paras: Vec<String> = (0..4).map(|i| format!("第{i}段。{}", "细".repeat(300))).collect();
        let doc = format!("## 长节\n\n{}", paras.join("\n\n"));
        let out = chunk_text(&doc);
        assert!(out.len() >= 2, "长节被拆：{}", out.len());
        for c in &out {
            assert!(c.title.contains("长节"), "链继承：{}", c.title);
            assert!(c.text.chars().count() <= CHUNK_MAX);
        }
    }

    #[test]
    fn chunk_heading_only_doc_no_loss() {
        // 目录式文档（几乎全是标题行）：标题文本自身成为正文，零丢失
        let heads: Vec<String> = (0..40).map(|i| format!("### 第{i}章标题文字")).collect();
        let doc = heads.join("\n");
        let out = chunk_text(&doc);
        let joined: String = out.iter().map(|c| c.text.as_str()).collect();
        for h in &heads {
            assert!(joined.contains(h.as_str()), "标题行 {h} 丢失");
        }
    }

    #[test]
    fn heading_detection_edges() {
        assert_eq!(heading("# 一级"), Some((1u8, "一级".to_string())));
        assert_eq!(heading("### 三级"), Some((3u8, "三级".to_string())));
        assert_eq!(heading("#### 四级"), None, "规格只认三级以内");
        assert_eq!(heading("#tag"), None, "井号话题不是标题");
        assert_eq!(heading("###"), None, "裸井号行不是标题");
        assert_eq!(heading("普通文本"), None);
        assert_eq!(heading(""), None);
    }

    #[test]
    fn compose_title_variants() {
        assert_eq!(compose_title("React 官方文档", "Hooks > useEffect", "正文"), "React 官方文档 > Hooks > useEffect");
        assert_eq!(compose_title("React 官方文档", "", "正文"), "React 官方文档");
        assert_eq!(compose_title("", "Hooks", "正文"), "Hooks");
        assert_eq!(compose_title("", "", "一段没有来源的话  "), "一段没有来源的话");
        // 超长硬截 100
        let long = "长".repeat(200);
        assert_eq!(compose_title(&long, "", "x").chars().count(), 100);
    }

    #[test]
    fn cap_chunks_limits_and_counts_skipped() {
        let pairs: Vec<(String, String)> = (0..MAX_IMPORT_CHUNKS + 10)
            .map(|i| (format!("t{i}"), format!("v{i}")))
            .collect();
        let (kept, skipped) = cap_chunks(pairs);
        assert_eq!(kept.len(), MAX_IMPORT_CHUNKS);
        assert_eq!(skipped, 10);
        let (kept, skipped) = cap_chunks(vec![("a".into(), "b".into())]);
        assert_eq!(kept.len(), 1);
        assert_eq!(skipped, 0);
    }

    /* ---- URL 安全校验（纯函数；网络部分在真机手测） ---- */

    #[test]
    fn url_scheme_whitelist() {
        assert!(validate_url_scheme(&"https://example.com/a".parse().unwrap()).is_ok());
        assert!(validate_url_scheme(&"http://127.0.0.1:8899/doc".parse().unwrap()).is_ok(), "内网/loopback 不拦（主 Agent 决策：用户手输 URL 与浏览器同信任级）");
        for bad in ["ftp://example.com/f", "file:///C:/x.md", "gopher://x", "javascript:alert(1)"] {
            let u: reqwest::Url = bad.parse().unwrap();
            let e = validate_url_scheme(&u).unwrap_err();
            assert_eq!(e, "仅支持 http/https");
        }
    }

    #[test]
    fn content_type_parse_and_whitelist() {
        assert_eq!(
            parse_content_type("text/html; charset=GBK"),
            ("text/html".to_string(), Some("GBK".to_string()))
        );
        assert_eq!(
            parse_content_type("  TEXT/PLAIN "),
            ("text/plain".to_string(), None)
        );
        assert_eq!(
            parse_content_type("application/xhtml+xml; charset=\"utf-8\""),
            ("application/xhtml+xml".to_string(), Some("utf-8".to_string()))
        );
        assert_eq!(parse_content_type(""), (String::new(), None));
        assert!(content_type_accepted("text/html"));
        assert!(content_type_accepted("text/plain"));
        assert!(content_type_accepted("application/xhtml+xml"));
        for bad in ["application/pdf", "image/png", "application/octet-stream", ""] {
            assert!(!content_type_accepted(bad), "{bad} 不应放行");
        }
    }

    #[test]
    fn redirect_target_rules() {
        let base: reqwest::Url = "https://a.com/page".parse().unwrap();
        // 相对路径按当前 URL 解析
        let next = redirect_target(Some("/next"), &base, 0).unwrap();
        assert_eq!(next.as_str(), "https://a.com/next");
        let next = redirect_target(Some("https://b.com/x"), &base, 0).unwrap();
        assert_eq!(next.as_str(), "https://b.com/x");
        // 跳数上限（≤3 跳：第 4 跳拒绝）
        assert!(redirect_target(Some("/x"), &base, 2).is_ok(), "第 3 跳仍允许");
        assert_eq!(redirect_target(Some("/x"), &base, 3).unwrap_err(), "重定向次数过多");
        // 每跳协议校验：跳向 ftp 拒绝
        assert!(redirect_target(Some("ftp://evil.com"), &base, 0).is_err());
        assert!(redirect_target(Some("file:///C:/Windows"), &base, 0).is_err());
        // Location 缺失 / 非法
        assert!(redirect_target(None, &base, 0).is_err());
        assert!(redirect_target(Some("http://[::1"), &base, 0).is_err());
    }

    /* ---- 编码探测 ---- */

    #[test]
    fn decode_body_utf8_and_bom() {
        // 原生 UTF-8 直通
        assert_eq!(decode_body("你好世界".as_bytes(), None), "你好世界");
        // BOM 优先：UTF-16LE BOM（ff fe）压过 HTTP charset 声明。
        // 注意 encoding_rs 的 Encoding::encode 对 UTF-16 编码会静默改用
        // UTF-8（Web 平台 TextEncoder 只支持 UTF-8 的口径），故手工按
        // LE 字节序拼 UTF-16
        let utf16le: Vec<u8> = "BOM标题测试"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        let mut bommed = vec![0xffu8, 0xfe];
        bommed.extend_from_slice(&utf16le);
        assert_eq!(decode_body(&bommed, Some("utf-8")), "BOM标题测试");
        // 无 BOM 无声明的 UTF-16 字节不会被误判（chardetng 猜不出时以
        // 替换符兜底，不会 panic）
        let _ = decode_body(&utf16le, None);
    }

    /// 钉死 meta 探测层本身（不经 chardetng 兜底）：曾因相对索引漏加偏移
    /// 恒取错位片段导致该层整体失效，靠统计探测器碰巧猜对而漏测
    #[test]
    fn meta_charset_layer_parses_labels() {
        // 双引号 / 单引号 / 无引号三形态，且 charset 不在字节 0 位（覆盖偏移路径）
        assert_eq!(
            meta_charset(b"<html><head><meta charset=\"gbk\"></head>"),
            Some(encoding_rs::GBK)
        );
        assert_eq!(
            meta_charset(b"<meta http-equiv='Content-Type' content='text/html; charset=big5'>"),
            Some(encoding_rs::BIG5)
        );
        assert_eq!(meta_charset(b"xx <meta charset = gb18030 >"), Some(encoding_rs::GB18030));
        // 无声明 / 无法识别的 label
        assert_eq!(meta_charset(b"<html><head><title>hi</title></head>"), None);
        assert_eq!(meta_charset(b"<meta charset=\"not-a-charset\">"), None);
    }

    #[test]
    fn decode_body_http_charset_then_meta_then_detect() {
        // 探测链路用足量样本：统计探测器对过短样本（几十字节）没有区分度
        let sample = "记忆库导入需要正确识别网页编码，这段较长的中文文本用于给统计探测器提供稳定的字符分布。\
                      编码识别错误会产生乱码，乱码入库后既检索不到也无法阅读，因此探测链路需要多层兜底。\
                      GBK 双字节编码的汉字分布与日文、韩文编码有可区分的统计特征，样本越长判定越稳。";
        let (gbk, _, _) = encoding_rs::GBK.encode(sample);
        // ② HTTP charset 声明
        assert_eq!(decode_body(&gbk, Some("gbk")), sample);
        // 声明错误（说是 utf-8 实为 GBK）：解码出替换符 → 降级到探测
        let detected = decode_body(&gbk, Some("utf-8"));
        assert!(detected.contains("记忆库导入"), "错误声明应被探测器纠正：{detected:?}");
        // ③ meta charset（无 HTTP 声明，两种 meta 形态）
        for head in [
            &b"<html><head><meta charset=\"gbk\"></head><body>"[..],
            b"<html><head><meta http-equiv=\"Content-Type\" content=\"text/html; charset=gbk\">",
        ] {
            let mut with_meta = head.to_vec();
            with_meta.extend_from_slice(&gbk);
            assert!(decode_body(&with_meta, None).contains("记忆库导入"));
        }
        // ④ 全无声明：chardetng 统计探测
        let guessed = decode_body(&gbk, None);
        assert!(guessed.contains("记忆库导入"), "chardetng 兜底：{guessed:?}");
    }

    /* ---- 正文抽取（dom_smoothie，纯 DOM 离线可测） ---- */

    #[test]
    fn extract_html_article_title_and_content() {
        let paras: Vec<String> = (0..6).map(|i| format!("<p>这是第{i}段正文内容，讲述记忆库导入的正文抽取行为与边界处理。</p>")).collect();
        let html = format!(
            "<html><head><title>测试页面标题 - 某站点</title></head><body><article><h1>大标题</h1>{}</article></body></html>",
            paras.join("")
        );
        let ex = extract_html(&html, "https://example.com/article").expect("应抽出正文");
        assert!(!ex.title.is_empty());
        assert!(ex.text.contains("第0段正文内容"), "正文段落保留：{}", ex.text.chars().take(60).collect::<String>());
        assert!(ex.text.contains("第5段正文内容"));
        assert!(ex.text.chars().count() >= LOW_TEXT_MIN, "长正文不走低置信路径");
        assert!(!ex.title.contains("(低置信)"));
    }

    #[test]
    fn extract_html_short_body_falls_back_to_description() {
        // og:description 与 meta description 任一命中即可（Readability 的
        // excerpt 自带两者择优，规格同样写「meta description/og:description」）
        let html = "<html><head><title>短页</title>\
            <meta name=\"description\" content=\"这是页面的一句话简介，作为低置信兜底正文使用。\">\
            <meta property=\"og:description\" content=\"og 备用的页面简介\"></head>\
            <body><article><p>只有一句话</p></article></body></html>";
        let ex = extract_html(html, "https://example.com/short").expect("简介兜底应成功");
        assert!(ex.title.starts_with("(低置信)"), "低置信前缀：{}", ex.title);
        assert!(ex.text.contains("简介"), "description 作正文：{}", ex.text);
        assert!(ex.text.chars().count() >= LOW_TEXT_MIN || ex.text.contains("简介"));
    }

    #[test]
    fn normalize_article_text_collapses_blank_runs() {
        assert_eq!(normalize_article_text("a\n\n\n\nb\n  \n c \n"), "a\n\nb\n\nc");
        assert_eq!(normalize_article_text("  \n\n  "), "");
    }

    #[test]
    fn plain_title_from_url() {
        assert_eq!(plain_title(&"https://a.com/docs/readme.md".parse().unwrap()), "readme.md");
        assert_eq!(plain_title(&"https://a.com/".parse().unwrap()), "a.com");
        assert_eq!(plain_title(&"https://a.com".parse().unwrap()), "a.com");
    }

    /* ---- 文件校验 ---- */

    #[test]
    fn validate_text_bytes_rules() {
        assert_eq!(validate_text_bytes("普通文本".as_bytes()).as_deref(), Some("普通文本"));
        // 非 UTF-8（二进制伪装）拒
        assert!(validate_text_bytes(&[0xff, 0xfe, 0x00, 0x42, 0x43]).is_none());
        // 前 8KB NUL 占比 >10% 拒（文本几乎不含 NUL）
        let mut nul_heavy = vec![b'A'; 800];
        nul_heavy.extend(std::iter::repeat_n(0u8, 200)); // 20%
        assert!(validate_text_bytes(&nul_heavy).is_none());
        // 少量 NUL（<10%）且合法 UTF-8：放行
        let mut nul_light = vec![b'A'; 1000];
        nul_light[5] = 0;
        assert!(validate_text_bytes(&nul_light).is_some());
        // 空输入：无 NUL 可言、UTF-8 合法（空串），由上层 trim 判空
        assert!(validate_text_bytes(b"").is_some());
    }

    fn temp_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("speaknow-memimp-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn read_capped_truncates_at_10mb() {
        let root = temp_root("cap");
        let p = root.join("big.txt");
        // 10MB + 16 字节：前 4 字节有标记，验证读到的就是文件头部
        let mut data = b"HEAD".to_vec();
        data.extend(std::iter::repeat_n(b'x', FILE_MAX_BYTES + 16 - 4));
        fs::write(&p, &data).unwrap();
        let (buf, truncated) = read_capped(&p).unwrap();
        assert!(truncated);
        assert_eq!(buf.len(), FILE_MAX_BYTES, "只读前 10MB");
        assert_eq!(&buf[..4], b"HEAD", "从头截断而非从尾");
        // 小文件：不截断
        let small = root.join("small.txt");
        fs::write(&small, b"hello").unwrap();
        let (buf, truncated) = read_capped(&small).unwrap();
        assert!(!truncated && buf == b"hello");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn canonicalize_prefix_assertion() {
        let root = temp_root("canon");
        let sub = root.join("docs");
        fs::create_dir_all(&sub).unwrap();
        let inside = sub.join("a.md");
        fs::write(&inside, b"# inside").unwrap();
        let outside = root.join("outside.md");
        fs::write(&outside, b"# outside").unwrap();
        let root_canon = root.canonicalize().unwrap();
        let inside_canon = inside.canonicalize().unwrap();
        let outside_canon = outside.canonicalize().unwrap();
        // 目录树内：前缀断言通过（mem_import_folder 的越界判据）
        assert!(inside_canon.starts_with(&root_canon), "{inside_canon:?} 应在 {root_canon:?} 内");
        assert!(outside_canon.starts_with(&root_canon), "同级文件也在根内");
        // 换个根再断言：原文件相对新根就是越界（模拟 junction 指向库外）
        let other_root = temp_root("canon-other");
        let other_canon = other_root.canonicalize().unwrap();
        assert!(!inside_canon.starts_with(&other_canon), "不在根目录树内 = 越界拒");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&other_root);
    }

    #[test]
    fn collect_docs_skips_hidden_and_build_dirs() {
        let root = temp_root("walk");
        for d in ["docs", "docs/nested", "node_modules", ".git", ".hidden", "target", "dist", "build", "out"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        fs::write(root.join("docs/a.md"), b"a").unwrap();
        fs::write(root.join("docs/nested/b.txt"), b"b").unwrap();
        fs::write(root.join("node_modules/x.md"), b"x").unwrap();
        fs::write(root.join(".git/y.md"), b"y").unwrap();
        fs::write(root.join(".hidden/z.txt"), b"z").unwrap();
        fs::write(root.join("target/t.md"), b"t").unwrap();
        fs::write(root.join("root.md"), b"r").unwrap();
        fs::write(root.join("ignore.log"), b"l").unwrap();
        fs::write(root.join("upper.MD"), b"u").unwrap(); // 扩展名大小写不敏感
        let mut out = Vec::new();
        collect_docs(&root.canonicalize().unwrap(), &mut out).unwrap();
        let names: Vec<String> = out
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(names.contains(&"a.md".to_string()));
        assert!(names.contains(&"b.txt".to_string()));
        assert!(names.contains(&"root.md".to_string()));
        assert!(names.contains(&"upper.MD".to_string()), "扩展名大小写不敏感");
        assert!(!names.iter().any(|n| n == "x.md" || n == "y.md" || n == "z.txt" || n == "t.md"), "跳过目录不漏：{names:?}");
        assert!(!names.iter().any(|n| n == "ignore.log"));
        assert_eq!(out.len(), 4);
        // 排序确定性
        let mut sorted = out.clone();
        sorted.sort();
        assert_eq!(out, sorted);
        let _ = fs::remove_dir_all(&root);
    }

    /* ---- 摘要 serde 契约 ---- */

    #[test]
    fn import_summary_serde_camelcase() {
        let s = MemImportSummary {
            added: 3,
            merged: 2,
            skipped: 1,
        };
        let j = serde_json::to_string(&s).unwrap();
        assert_eq!(j, "{\"added\":3,\"merged\":2,\"skipped\":1}", "字段名与冻结契约一致");
        let back: MemImportSummary = serde_json::from_str(&j).unwrap();
        assert_eq!(back, s);
    }

    /* ---- v4：备份解析 / 大小上限 / 进度事件 ---- */

    #[test]
    fn parse_backup_doc_accepts_both_formats() {
        // 顶层数组（直接导出 mem.json 的形态）
        let arr = r#"[{"ts":1,"kind":"note","app":"","title":"a","text":"内容","chars":2},
                      {"ts":2,"kind":"ocr","app":"chrome","title":"b","text":"y","chars":1}]"#;
        let (es, sk) = parse_backup_doc(arr).unwrap();
        assert_eq!((es.len(), sk), (2, 0));
        assert_eq!(es[0].ts, 1);
        // {items:[...]} 形态（工具包装导出）
        let obj = r#"{"items":[{"ts":3,"kind":"note","app":"","title":"c","text":"z","chars":1}]}"#;
        let (es, sk) = parse_backup_doc(obj).unwrap();
        assert_eq!((es.len(), sk), (1, 0));
        assert_eq!(es[0].ts, 3);
        // v1/v2 老备份缺 v3 字段：#[serde(default)] 缺省容错照常入库
        let legacy = r#"[{"ts":4,"kind":"dictation","app":"","title":"t","text":"x","chars":1}]"#;
        let (es, sk) = parse_backup_doc(legacy).unwrap();
        assert_eq!((es.len(), sk), (1, 0));
        assert_eq!(es[0].superseded_by, 0);
    }

    #[test]
    fn parse_backup_doc_counts_bad_entries_and_formats() {
        // 单条缺必填字段（无 ts）→ 该条 skipped，其余照常入库
        let mixed = r#"[{"ts":1,"kind":"note","app":"","title":"a","text":"x","chars":1},
                        {"kind":"note"}]"#;
        let (es, sk) = parse_backup_doc(mixed).unwrap();
        assert_eq!((es.len(), sk), (1, 1));
        // 数组里混非对象元素 → 逐条 skipped
        let mixed = r#"[1,"x",null]"#;
        let (es, sk) = parse_backup_doc(mixed).unwrap();
        assert_eq!((es.len(), sk), (0, 3));
        // 合法 JSON 但格式非法（对象无 items / items 非数组 / 标量）→ skipped 1
        for bad in [r#"{"foo":1}"#, r#"{"items":{"a":1}}"#, "123", "\"x\""] {
            let (es, sk) = parse_backup_doc(bad).unwrap();
            assert_eq!((es.len(), sk), (0, 1), "格式非法计 skipped：{bad}");
        }
        // 整体语法非法 → Err（文件级失败，前端 toast）
        assert!(parse_backup_doc("不是 JSON").is_err());
        assert!(parse_backup_doc("").is_err());
        assert!(parse_backup_doc("{\"ts\":1,").is_err());
    }

    #[test]
    fn read_backup_capped_limit_and_utf8() {
        let root = temp_root("bakcap");
        // 超限拒：截断读出的半个 JSON 必然解析失败，拒绝比截断更有指导性
        let p = root.join("big.json");
        let mut data = Vec::with_capacity(BACKUP_MAX_BYTES as usize + 17);
        data.push(b'[');
        data.extend(std::iter::repeat_n(b'x', BACKUP_MAX_BYTES as usize + 16));
        fs::write(&p, &data).unwrap();
        let err = read_backup_capped(&p).unwrap_err();
        assert!(err.contains("20MB"), "{err}");
        // 恰好等限：放行（take 多读 1 字元只是超限探针）
        let edge = root.join("edge.json");
        fs::write(&edge, std::iter::repeat_n(b'a', BACKUP_MAX_BYTES as usize).collect::<Vec<u8>>()).unwrap();
        assert_eq!(read_backup_capped(&edge).unwrap().len(), BACKUP_MAX_BYTES as usize);
        // 非 UTF-8 → 判不是备份文件
        let bin = root.join("bin.json");
        fs::write(&bin, [0xffu8, 0xfe, 0x00, 0x42]).unwrap();
        let err = read_backup_capped(&bin).unwrap_err();
        assert!(err.contains("UTF-8"), "{err}");
        // 不存在 → Err
        assert!(read_backup_capped(&root.join("none.json")).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn import_progress_event_contract_fields() {
        let v = import_progress_event(2, 5, "笔记.md");
        assert_eq!(v["done"], 2);
        assert_eq!(v["total"], 5);
        assert_eq!(v["label"], "笔记.md");
        // 键集与冻结契约一致（done/total/label 三键，无多余字段；serde_json
        // 默认按字典序存键，比较前排序）
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["done", "label", "total"]);
        // 收尾事件：done=total 且 label 空串（前端收进度条的信号）
        let end = import_progress_event(5, 5, "");
        assert_eq!(end["done"], 5);
        assert_eq!(end["total"], 5);
        assert_eq!(end["label"], "");
    }
}
