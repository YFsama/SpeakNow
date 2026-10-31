//! 记忆库（Mem）：把听写 / 截图取词 / 翻译的产出自动沉淀为可检索的个人记忆
//! （借鉴 Nowledge Mem 的「记忆层」理念：输入即记忆、检索即回忆）。
//!
//! 存储：app_config_dir/mem.json，与 history.rs 同模式——全局读-改-写锁 +
//! 原子写 + 变更广播（事件名 sn-mem-changed）。检索语义与 src/dev/mock-tauri.ts
//! 的 mockMemSearch 逐字对齐：前端浏览器 mock 预览与真机行为完全一致。
//!
//! v2（召回链路，借鉴开源记忆层的成熟做法）：多因子排序（Generative Agents
//! 的时间衰减 × Elasticsearch 的使用频次对数）、仅实际使用才计数（防检索
//! 命中自我强化）、近重复合并（mem0 去重的简化版）、采集黑名单（隐私优先）。
//!
//! 采集入口 [`capture`] 由听写（pipeline）/ OCR（ocr）/ 翻译（translate，含
//! 输入框翻译复用的会话）三条链路各一行调用：开关判断只读内存配置（调用
//! 线程同步、微秒级），文件 IO 与可选的 LLM 蒸馏全部转后台线程——绝不阻塞
//! 会话主流程；热键/托盘回调所在的主线程更不会被碰到。

use std::collections::HashSet;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rand::Rng;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// 置顶条目数量上限（照 history.rs 的 PINNED_CAP 口径）：超出时最早置顶的
/// 自动取消，防置顶无限膨胀吃光保留名额之外的存储
const PINNED_CAP: usize = 20;

/// 单条采集的正文长度上限（码点）：结构化翻译整文件可达数万字符，这种
/// 「文件级操作」沉淀为单条记忆既检索不到重点、也让蒸馏请求徒劳烧钱；
/// 与输入框翻译的草稿上限（2 万字）同款取值
const MAX_CAPTURE_CHARS: usize = 20_000;

/// 读-改-写全局锁：采集（听写/OCR/翻译三条会话线程）、命令（删除/置顶/
/// 清空，Tauri 线程池）与蒸馏回写可能并发进入，无锁时后写者覆盖先写者
/// （丢一条记忆）——history.rs 的 STORE_LOCK 同教训
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// 蒸馏并发闸：一次只跑一个蒸馏任务，采集时若已有蒸馏在途则本次跳过——
/// 库中下一条新记忆入库会再触发，只丢即时性不丢功能；长文本连发时防止
/// LLM 请求无限堆积
static DISTILL_BUSY: AtomicBool = AtomicBool::new(false);

/// DISTILL_BUSY 的 RAII 复位守卫：正常结束与 panic 展开都会经 Drop 复位。
/// 手工 store 在任务 panic（tokio 捕获为 JoinError 而非崩溃进程）时会漏掉，
/// BUSY 永久为 true 将静默禁用蒸馏直到重启
struct DistillBusyGuard;
impl Drop for DistillBusyGuard {
    fn drop(&mut self) {
        DISTILL_BUSY.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemEntry {
    /// 毫秒时间戳（与 history 相同口径：秒级粒度下同秒两条会共享 ts）
    pub ts: i64,
    /// dictation / ocr / translate
    pub kind: String,
    /// 采集时的前台应用 exe 基名（小写去 .exe，如 "chrome"）；取不到为空串
    pub app: String,
    /// 展示标题：蒸馏摘要或正文前 40 码点（见 fallback_title）
    pub title: String,
    /// 正文（听写终稿 / OCR 原文 / 译文）
    pub text: String,
    /// 蒸馏关键词（未蒸馏为空数组）。default：旧文件/手编文件缺省容错
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub distilled: bool,
    /// 置顶：不占保留条数名额
    #[serde(default)]
    pub pinned: bool,
    /// 正文字符数（码点口径，= text.chars().count()，与前端 [...str].length 一致）
    pub chars: u32,
    /// 近重复出现次数（v2）：同一内容再次采集时旧条 +1 而不是新建条目
    #[serde(default)]
    pub hits: u32,
    /// 实际使用次数（v2）：只有「注入到光标 / 复制」才计数——检索命中不算，
    /// 否则被召回得越多的条目分数越高，形成检索自我强化的正反馈
    #[serde(default)]
    pub uses: u32,
    /// 最近一次实际使用的毫秒时间戳（v2），0 = 从未使用过
    #[serde(default)]
    pub last_used_at: i64,
    /// 软作废（v3）：被哪条记忆的 ts 取代，0 = 在世。LLM 冲突裁决命中时标记
    /// ——不物理删（作废优先于删除，误判可逆：设置页仍可见，导出保留）；
    /// 召回与 context.md 过滤，mem_list 不过滤（前端有「已被取代」徽章）
    #[serde(default)]
    pub superseded_by: i64,
}

/// mem_list 命令返回：条目 + 概览统计。统计不受 query/kind 过滤影响
/// （「共 N 条 / 今日 / 累计字符」永远是对整库的口径，与 mock 一致）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemListResult {
    pub items: Vec<MemEntry>,
    pub total: u32,
    pub today_count: u32,
    pub total_chars: u64,
}

/* ---------- 存储（history.rs 同模式） ---------- */

fn path(app: &AppHandle) -> anyhow::Result<std::path::PathBuf> {
    Ok(app.path().app_config_dir()?.join("mem.json"))
}

/// 显式目录版的存储路径（mem_import::import_paths_standalone 与部分单测用：
/// 离线导入不依赖 Tauri AppHandle，但必须与运行时完全同一路径规则）
pub(crate) fn path_at(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("mem.json")
}

fn load(app: &AppHandle) -> Vec<MemEntry> {
    match path(app) {
        Ok(p) => load_at(&p),
        Err(_) => Vec::new(),
    }
}

pub(crate) fn load_at(p: &std::path::Path) -> Vec<MemEntry> {
    fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 落盘 + 广播 sn-mem-changed。只会在已持 STORE_LOCK 的后台/命令线程调用
/// （capture 线程 / 命令线程 / 蒸馏任务），不在主线程
fn write(app: &AppHandle, items: &[MemEntry]) {
    if let Ok(p) = path(app) {
        write_at(&p, items);
    }
    let _ = app.emit("sn-mem-changed", ());
}

/// 显式路径版落盘（离线导入用；不广播——没有 AppHandle 也就没有监听者）
pub(crate) fn write_at(p: &std::path::Path, items: &[MemEntry]) {
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(items) {
        let _ = crate::config::atomic_write(p, json.as_bytes());
    }
}

fn now_ms_i64() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/* ---------- 检索（纯逻辑，与 mockMemSearch 逐字同口径） ---------- */

/// 单条打分：terms 已小写化。每个 term 依次尝试 keywords（任一 contains）=3、
/// title contains=2、text contains=1，全不命中 → None（AND 语义：任一词
/// 未命中即整条淘汰）。kind 过滤在打分前（不匹配直接淘汰，不参与排序）
fn score_entry(e: &MemEntry, terms: &[String], kind: Option<&str>) -> Option<i64> {
    if kind.is_some_and(|k| e.kind != k) {
        return None;
    }
    let mut score = 0i64;
    for t in terms {
        let s = if e
            .keywords
            .iter()
            .any(|k| k.to_lowercase().contains(t.as_str()))
        {
            3
        } else if e.title.to_lowercase().contains(t.as_str()) {
            2
        } else if e.text.to_lowercase().contains(t.as_str()) {
            1
        } else {
            return None;
        };
        score += s;
    }
    Some(score)
}

/// 检索 + 排序 + 截断（纯函数）：无查询时 (pinned desc, ts desc)；有查询时
/// (score desc, ts desc)。items 视为新→旧或乱序均可，排序自身保证结果序
pub fn search(items: Vec<MemEntry>, query: &str, kind: Option<&str>, limit: usize) -> Vec<MemEntry> {
    // JS：query.trim().toLowerCase().split(/\s+/).filter(Boolean) ≡ 小写化后
    // 按空白切分（split_whitespace 覆盖 Unicode 空白，含 \u00a0 邻近语义）
    let terms: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(String::from)
        .collect();
    let mut scored: Vec<(i64, MemEntry)> = items
        .into_iter()
        .filter_map(|e| score_entry(&e, &terms, kind).map(|s| (s, e)))
        .collect();
    if terms.is_empty() {
        scored.sort_by(|a, b| b.1.pinned.cmp(&a.1.pinned).then(b.1.ts.cmp(&a.1.ts)));
    } else {
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.ts.cmp(&a.1.ts)));
    }
    scored.truncate(limit);
    scored.into_iter().map(|(_, e)| e).collect()
}

/// v2 召回排序（纯函数，now 显式注入便于测试）。与 mock-tauri.ts 的
/// mem_recall case 逐字同口径：
/// - 有查询：文本分（复用 score_entry 的 3/2/1 加权 AND）× 0.95^天数 ×
///   (1+log10(1+uses))。多因子出处：时间衰减 0.95/小时是 Generative Agents
///   论文的记忆检索公式；使用频次对数项是 Elasticsearch function_score 的
///   `1 + log10(1 + N)`——对数让「用过一次」收益最大、刷得越多边际越小，
///   防止单条高频记忆垄断榜首。天数基准取 last_used_at>0 则它否则 ts：
///   「用过」也算一次保鲜（用时即相关性信号）
/// - 空查询：置顶浮顶，其余按 max(last_used_at, ts) 新→旧——「用过/采过」
///   最新的排最前，用户反复取用的内容一打卡片就在顶部
/// - v3：软作废条目（superseded_by>0）不进召回——它们是被裁决取代的过时
///   记忆，召回场景召回它们等于主动输出已知错误。mem_list 不过滤（管理页
///   可见），置顶与否不作豁免：裁决只会在明确矛盾/完全重复时发生
pub fn recall_rank(items: Vec<MemEntry>, query: &str, limit: usize, now_ms: i64) -> Vec<MemEntry> {
    const DAY_MS: f64 = 86_400_000.0;
    let items: Vec<MemEntry> = items.into_iter().filter(|e| e.superseded_by == 0).collect();
    let terms: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(String::from)
        .collect();
    if terms.is_empty() {
        let mut sorted = items;
        sorted.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then(b.last_used_at.max(b.ts).cmp(&a.last_used_at.max(a.ts)))
                .then(b.ts.cmp(&a.ts))
        });
        sorted.truncate(limit);
        return sorted;
    }
    let mut scored: Vec<(f64, MemEntry)> = items
        .into_iter()
        .filter_map(|e| {
            let s = score_entry(&e, &terms, None)?;
            Some((s as f64, e))
        })
        .map(|(s, e)| {
            let base = if e.last_used_at > 0 { e.last_used_at } else { e.ts };
            let days = (now_ms - base) as f64 / DAY_MS;
            let recency = 0.95f64.powf(days);
            let freq = 1.0 + (1.0 + e.uses as f64).log10();
            (s * recency * freq, e)
        })
        .collect();
    // total_cmp 对 NaN 也有全序（pow/log 输入均良性不会产生 NaN），排序确定
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(b.1.ts.cmp(&a.1.ts)));
    scored.truncate(limit);
    scored.into_iter().map(|(_, e)| e).collect()
}

/// 概览统计（纯函数，不受过滤影响）：(总数, 今日条数, 累计字符)。
/// today = 本地零点起（口径与 mock 的 todayStart.setHours(0,0,0,0) 一致）
fn stats(items: &[MemEntry], now_unix_ms: i64) -> (u32, u32, u64) {
    let today_start = local_midnight_ms(now_unix_ms);
    let today_count = items.iter().filter(|e| e.ts >= today_start).count() as u32;
    (
        items.len() as u32,
        today_count,
        items.iter().map(|e| e.chars as u64).sum(),
    )
}

/// unix 毫秒 → 本地当日零点（毫秒）：本地时间对日取模。
/// history.rs 里有一份同口径实现但是私有的（本任务不许改 history.rs），
/// 故按同算法复刻，两处行为保持一致
fn local_midnight_ms(unix_ms: i64) -> i64 {
    local_unix_ms(unix_ms.max(0)) - local_unix_ms(unix_ms.max(0)).rem_euclid(86_400_000)
}

/// unix 毫秒 → 本地「视作 UTC」的毫秒（供纯数学日历分解出本地日期）。
/// Windows 经 FileTimeToLocalFileTime 换算时区偏移（含夏令时），复用已启用
/// 的 Win32 feature，无新依赖；其余平台按 UTC（与 history.rs 同取舍）
fn local_unix_ms(unix_ms: i64) -> i64 {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::FILETIME;
        use windows::Win32::Storage::FileSystem::FileTimeToLocalFileTime;
        // 1601 ↔ 1970 两个 epoch 的差值（100ns 单位）
        const W32_EPOCH: u64 = 116_444_736_000_000_000;
        let t = unix_ms.max(0) as u64 * 10_000 + W32_EPOCH;
        let utc = FILETIME {
            dwLowDateTime: t as u32,
            dwHighDateTime: (t >> 32) as u32,
        };
        let mut local = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        if unsafe { FileTimeToLocalFileTime(&utc, &mut local) }.is_ok() {
            let lt = ((local.dwHighDateTime as u64) << 32) | local.dwLowDateTime as u64;
            return ((lt - W32_EPOCH) / 10_000) as i64;
        }
        unix_ms
    }
    #[cfg(not(target_os = "windows"))]
    {
        unix_ms
    }
}

/* ---------- 滚动清理 / 置顶（纯逻辑，history.rs 同款口径） ---------- */

/// 滚动清理：非置顶子列保新弃旧截到 limit（= 超限从最旧开始删非 pinned），
/// 置顶不占名额、始终保留；结果整体按 ts 新→旧重排
pub(crate) fn truncate_keep_pinned(items: Vec<MemEntry>, limit: usize) -> Vec<MemEntry> {
    if !items.iter().any(|i| i.pinned) {
        let mut items = items;
        items.truncate(limit);
        return items;
    }
    let pinned: Vec<MemEntry> = items.iter().filter(|i| i.pinned).cloned().collect();
    let mut rest: Vec<MemEntry> = items.into_iter().filter(|i| !i.pinned).collect();
    rest.truncate(limit);
    rest.extend(pinned);
    rest.sort_by(|a, b| b.ts.cmp(&a.ts));
    rest
}

/// 置顶数超上限时取消最旧的置顶（items 新→旧，最旧在尾部）
fn evict_pinned_overflow(items: &mut Vec<MemEntry>, just_pinned: i64) {
    let others: Vec<i64> = items
        .iter()
        .filter(|i| i.pinned && i.ts != just_pinned)
        .map(|i| i.ts)
        .collect();
    if others.len() >= PINNED_CAP {
        if let Some(&oldest) = others.last() {
            if let Some(it) = items.iter_mut().find(|i| i.ts == oldest) {
                it.pinned = false;
            }
        }
    }
}

/* ---------- 采集入口 ---------- */

/// exe 基名规整：小写 + 去 .exe（"Chrome.exe" → "chrome"），与前端 mock
/// 数据 / types.ts 注释的展示口径一致；取不到（空串）保持空串
pub(crate) fn normalize_app(name: &str) -> String {
    let n = name.trim().to_lowercase();
    n.strip_suffix(".exe").unwrap_or(&n).to_string()
}

/// 未蒸馏时的兜底标题：正文前 40 码点，空白折叠为单空格（标题单行展示）。
/// v3 起导入/快记的合成标题也复用它做无来源兜底（mem_import::compose_title）
pub(crate) fn fallback_title(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(40)
        .collect()
}

/// 采集黑名单内置名单（子串、小写匹配进程名）：密码管理器的内容绝不入库，
/// 始终生效、不可关闭——隐私优先于便利。副作用是在其中划词翻译的译文也
/// 不入库（translate 采集来源进程即密码管理器进程），这是有意的取舍：
/// 译文与原文一一对应，泄露等价
pub const BUILTIN_SENSITIVE_APPS: &[&str] = &[
    "1password",
    "keepass",
    "keepassxc",
    "bitwarden",
    "lastpass",
    "enpass",
    "dashlane",
    // Proton 只拦密码管理器本体（Proton Pass），不用宽子串 "proton"——
    // 否则 Proton Mail/VPN/Drive 的正常听写与翻译也会被拦
    "proton pass",
    "protonpass",
    "remembear",
    "passwordstate",
    "authy",
    "yubikey",
];

/// 采集黑名单判定（纯函数）：内置名单（不可关）或用户补充名单
/// （cfg.mem.capture_blacklist，每行一个关键字）任一命中即拒绝入库。
/// 子串匹配故「mykeepasshelper」这类宿主进程也会被内置名单拦下
fn app_blacklisted(app_norm: &str, user_blacklist: &str) -> bool {
    if BUILTIN_SENSITIVE_APPS.iter().any(|k| app_norm.contains(k)) {
        return true;
    }
    user_blacklist
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .any(|l| app_norm.contains(&l.to_lowercase()))
}

/// bigram 规整：小写 + 滤掉全部空白（换行的位置差异不该影响相似度）
fn normalize_for_bigram(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect()
}

/// 字符二元组集合（中文一字即一个 token，字符 bigram 足够刻画语序近复述）
fn char_bigrams(norm: &str) -> HashSet<[char; 2]> {
    let chars: Vec<char> = norm.chars().collect();
    if chars.len() < 2 {
        return HashSet::new();
    }
    chars.windows(2).map(|w| [w[0], w[1]]).collect()
}

/// Jaccard 相似度 |A∩B| / |A∪B|（0.75 阈值下的重述/微调判定）
fn jaccard(a: &HashSet<[char; 2]>, b: &HashSet<[char; 2]>) -> f64 {
    if a.is_empty() || b.is_empty() {
        // 双空 = 两个都 <2 字符，调用方已走相等比较；一空一非 = 必不相似
        return if a.len() == b.len() { 1.0 } else { 0.0 };
    }
    let inter = a.iter().filter(|g| b.contains(*g)).count() as f64;
    let union = (a.len() + b.len()) as f64 - inter;
    inter / union
}

/// 近重复合并（mem0 去重思路的简化版）：只看最近 50 条同 kind+app 的旧
/// 条目，bigram Jaccard ≥ 0.75 即视为同一内容的重述——旧条 hits+=1、由
/// 调用方落盘广播、本次不新建。否则「同一句话反复说」会刷屏挤掉别的
/// 记忆。v1 的精确相等去重是 Jaccard=1 的特例，自然被覆盖；任一侧文本
/// 规整后不足 2 字符时无 bigram 可言，退化为相等比较
pub(crate) fn bump_near_duplicate(items: &mut [MemEntry], kind: &str, app: &str, text: &str) -> bool {
    let norm = normalize_for_bigram(text);
    let short = norm.chars().count() < 2;
    let grams = if short { HashSet::new() } else { char_bigrams(&norm) };
    for e in items.iter_mut().take(50) {
        if e.kind != kind || e.app != app {
            continue;
        }
        let e_norm = normalize_for_bigram(&e.text);
        let dup = if short || e_norm.chars().count() < 2 {
            e_norm == norm
        } else {
            jaccard(&grams, &char_bigrams(&e_norm)) >= 0.75
        };
        if dup {
            e.hits += 1;
            return true;
        }
    }
    false
}

/// 采集入口：听写终稿 / OCR 原文 / 译文产出后各一行调用。本函数在会话线程
/// 同步做的只有内存配置开关与文本有效性判断（微秒级）；去重、入库、滚动
/// 清理、落盘与可选蒸馏全部在专职后台线程完成。任何失败静默（只记日志），
/// 绝不影响主流程
pub fn capture(app: &AppHandle, kind: &str, app_name: &str, text: &str) {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > MAX_CAPTURE_CHARS {
        return;
    }
    let cfg = app
        .state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .unwrap_or_default();
    let mem_cfg = cfg.mem.clone();
    if !mem_cfg.enabled {
        return;
    }
    let capture_on = match kind {
        "dictation" => mem_cfg.capture_dictation,
        "ocr" => mem_cfg.capture_ocr,
        "translate" => mem_cfg.capture_translate,
        _ => false,
    };
    if !capture_on {
        return;
    }
    let entry_app = normalize_app(app_name);
    // 采集黑名单在会话线程同步判定（纯内存、微秒级）：隐私拦截必须
    // fail-closed——哪怕后面后台线程没起得来，敏感内容也绝不能入库
    if app_blacklisted(&entry_app, &mem_cfg.capture_blacklist) {
        return;
    }
    // 蒸馏前置判定也只读内存（llm_ready 是纯字段检查）：LLM 未配置时连
    // 后台线程都不必起
    let llm_cfg = cfg.resolved_llm();
    let distill = mem_cfg.distill && crate::llm::llm_ready(&llm_cfg);

    let app = app.clone();
    let kind = kind.to_string();
    let text = text.to_string();
    let limit = mem_cfg.limit.max(1);
    let spawned = std::thread::Builder::new()
        .name("speaknow-mem-capture".into())
        .spawn(move || {
            let ts = now_ms_i64();
            let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut items = load(&app);
            if bump_near_duplicate(&mut items, &kind, &entry_app, &text) {
                // 近重复：旧条 hits+1 即视为「又出现了一次」，不新建条目
                write(&app, &items);
                return;
            }
            items.insert(
                0,
                MemEntry {
                    ts,
                    kind: kind.clone(),
                    app: entry_app,
                    title: fallback_title(&text),
                    chars: text.chars().count() as u32,
                    text,
                    hits: 0,
                    uses: 0,
                    last_used_at: 0,
                    keywords: Vec::new(),
                    distilled: false,
                    pinned: false,
                    superseded_by: 0,
                },
            );
            items = truncate_keep_pinned(items, limit);
            write(&app, &items);
            drop(_guard);
            if distill {
                spawn_distill(&app, ts, &llm_cfg);
            }
        });
    if let Err(e) = spawned {
        eprintln!("[speaknow] 记忆库采集线程启动失败: {e}");
    }
}

/* ---------- AI 蒸馏 + v3 冲突裁决 ---------- */

/// 蒸馏指令（借用 custom_prompt 通道，{text} 占位由 llm::optimize 的
/// user_content 替换）。选这条路的理由：custom_prompt 非空时 llm 侧自动换用
/// 中性「文本处理助手」系统提示，且关键词对齐/概括守卫全部关闭——蒸馏
/// 本来就是要改写与提炼文本，那些守卫会误伤并触发无谓的修补重试
const DISTILL_PROMPT: &str = "你是个人记忆库的管理员。为下面的文本提炼记忆卡信息：\
\n1) title：一句话标题，不超过 20 个字，概括核心事实，保留专有名词与数字；\
\n2) keywords：至多 6 个检索关键词，用原文语言，单词或短语，不要与标题整句重复。\
\n只输出一个 JSON 对象，不要任何解释、前后缀或代码块：\
{\"title\":\"…\",\"keywords\":[\"…\"]}\
\n\n文本：{text}";

/// 冲突裁决候选集上限：候选进 prompt 要按条烧 token，10 条已覆盖「同一件事
/// 的近期待裁决记忆」的绝大多数场景，再多只是稀释注意力
const OR_RECALL_LIMIT: usize = 10;

/// OR 召回（v3 冲突裁决候选集专用，纯函数）：任一词命中（keywords/title/
/// text 任一 contains）即入围，按 ts 新→旧取前 limit。不复用 search 的 AND
/// 语义的理由：与新记忆矛盾的旧记忆往往用词相反（「会议定在周三」vs
/// 「会议改到周四」），只共享个别关键词，AND 会把它们全部漏掉；召回候选
/// 宁多勿漏，筛掉幻觉靠代码层三道闸。已作废条目不入围——作废链没有意义
pub fn or_recall(items: Vec<MemEntry>, query: &str, limit: usize) -> Vec<MemEntry> {
    let terms: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(String::from)
        .collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<MemEntry> = items
        .into_iter()
        .filter(|e| e.superseded_by == 0)
        .filter(|e| {
            terms.iter().any(|t| {
                e.keywords.iter().any(|k| k.to_lowercase().contains(t.as_str()))
                    || e.title.to_lowercase().contains(t.as_str())
                    || e.text.to_lowercase().contains(t.as_str())
            })
        })
        .collect();
    // 时间倒序（规格如此）：同现多条疑似时，最新的那条最可能是「现行版本」
    hits.sort_by(|a, b| b.ts.cmp(&a.ts));
    hits.truncate(limit);
    hits
}

/// 毫秒差 → 中文相对时间（裁决 prompt 里给人/模型读的时间线索）
fn relative_time(delta_ms: i64) -> String {
    let s = (delta_ms / 1000).max(0);
    if s < 60 {
        return format!("{s} 秒前");
    }
    let m = s / 60;
    if m < 60 {
        return format!("{m} 分钟前");
    }
    let h = m / 60;
    if h < 24 {
        return format!("{h} 小时前");
    }
    format!("{} 天前", h / 24)
}

/// 裁决版蒸馏提示（候选集非空时替代 DISTILL_PROMPT，{text}/{candidates}
/// 由 distill_prompt 填充）。这是三道闸的第三闸（提示词侧）：明确「仅当语义
/// 明确矛盾/完全重复才返回 id，不确定一律 0」——mem0 官方同款保守路线：
/// 错误作废不可逆，漏判的重复入库已被 hits 统计兜住
const DISTILL_ADJUDICATE_PROMPT: &str = "你是个人记忆库的管理员。为下面的文本提炼记忆卡信息：\
\n1) title：一句话标题，不超过 20 个字，概括核心事实，保留专有名词与数字；\
\n2) keywords：至多 6 个检索关键词，用原文语言，单词或短语，不要与标题整句重复；\
\n3) supersedes：若「候选记忆」中存在与新文本语义明确矛盾或完全重复的条目，返回该条的 id；\
不确定或没有则返回 0。宁可漏判不可误判：作废一条记忆不可逆，而漏判的代价只是重复入库。\
\n只输出一个 JSON 对象，不要任何解释、前后缀或代码块：\
{\"title\":\"…\",\"keywords\":[\"…\"],\"supersedes\":0}\
\n\n候选记忆（id=取代它时要返回的数字）：\
{candidates}\
\n\n文本：{text}";

/// 组装蒸馏提示词（纯函数，now 注入便于测试）：无候选时与 v2 完全一致，
/// 有候选时换裁决版并把候选排布成「id（相对时间）标题 + 正文前 200 码点」
fn distill_prompt(candidates: &[MemEntry], now_ms: i64) -> String {
    if candidates.is_empty() {
        return DISTILL_PROMPT.to_string();
    }
    let mut block = String::new();
    for e in candidates {
        let excerpt: String = e.text.chars().take(200).collect();
        let title: String = e.title.chars().take(40).collect();
        block.push_str(&format!(
            "\n[id={}]（{}）标题：{}｜内容：{}",
            e.ts,
            relative_time(now_ms - e.ts),
            title,
            excerpt
        ));
    }
    DISTILL_ADJUDICATE_PROMPT
        .replace("{candidates}", block.trim_start_matches('\n'))
}

/// 解析蒸馏回包（脏输入容错）：截取首个 { 到最后一个 } 之间尝试反序列化；
/// title 去空白后非空、超长截断；关键词去空/去重（小写）/截到 6 个；
/// supersedes 缺省 0（v2 回包无此字段天然兼容）。解析失败返回 None——
/// 调用方重试一次后整体 NOOP，保留入库时的兜底标题
fn parse_distill_json(out: &str) -> Option<(String, Vec<String>, i64)> {
    #[derive(Deserialize)]
    struct Raw {
        title: String,
        #[serde(default)]
        keywords: Vec<String>,
        #[serde(default)]
        supersedes: i64,
    }
    let s = out.trim();
    let start = s.find('{')?;
    let end = s.rfind('}')?;
    if end <= start {
        return None;
    }
    let raw: Raw = serde_json::from_str(&s[start..=end]).ok()?;
    // 标题 20 字是提示词要求，这里硬截到 40 兜底（模型偶尔超长也不至于撑爆卡片）
    let title: String = raw.title.trim().chars().take(40).collect();
    if title.is_empty() {
        return None;
    }
    let mut seen = HashSet::new();
    let keywords: Vec<String> = raw
        .keywords
        .into_iter()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty() && seen.insert(k.to_lowercase()))
        .take(6)
        .collect();
    Some((title, keywords, raw.supersedes))
}

/// 三道闸之二（纯函数）：LLM 返回的 supersedes 必须命中候选集且非自身。
/// 编造 id 是 LLM 幻觉高发位（把日期、正文数字当 id 返回都见过），这层
/// 代码兜底保证：不在候选集里的值一律丢弃，宁缺毋滥
fn gate_supersedes(claimed: i64, candidates: &[i64], new_ts: i64) -> Option<i64> {
    (claimed > 0 && claimed != new_ts && candidates.contains(&claimed)).then_some(claimed)
}

/// 应用蒸馏与裁决结果（纯逻辑，锁外不可见）：新条仍在库且未蒸馏（迟到完成
/// 不覆盖）→ 更新 title/keywords/distilled；supersedes 已过闸且旧条在库、
/// 在世 → 旧条 superseded_by = 新 ts（软作废，不物理删）。返回是否有变更
fn apply_distill(
    items: &mut [MemEntry],
    ts: i64,
    title: &str,
    keywords: Vec<String>,
    supersedes: Option<i64>,
) -> bool {
    let mut changed = false;
    if let Some(e) = items.iter_mut().find(|e| e.ts == ts) {
        if !e.distilled {
            e.title = title.to_string();
            e.keywords = keywords;
            e.distilled = true;
            changed = true;
        }
    }
    if let Some(old_ts) = supersedes {
        if let Some(old) = items.iter_mut().find(|e| e.ts == old_ts) {
            // 已作废的不二次改判（链式取代无意义）；自身不可作废自身
            if old.superseded_by == 0 && old_ts != ts {
                old.superseded_by = ts;
                changed = true;
            }
        }
    }
    changed
}

/// 单次「optimize → 解析」尝试：请求失败或解析失败都算失败（None）
async fn distill_attempt(llm_cfg: &crate::config::LlmConfig, text: &str) -> Option<(String, Vec<String>, i64)> {
    crate::llm::optimize(llm_cfg, text)
        .await
        .ok()
        .and_then(|out| parse_distill_json(&out))
}

/// 后台蒸馏（v3 含冲突裁决）：DISTILL_BUSY 原子闸防堆积（swap 失败 = 已有
/// 在途任务，直接跳过）。流程：锁内快照新条目正文 + OR 召回候选集 → 锁外
/// LLM（网络绝不持锁）→ 三道闸（解析失败重试一次再失败整体 NOOP；supersedes
/// 必须在候选集内；不确定 NOOP）→ 锁内应用 + 广播。超时收紧到 ≤10s：
/// 蒸馏是锦上添花，不值得挂默认 45s 等待
fn spawn_distill(app: &AppHandle, ts: i64, base_cfg: &crate::config::LlmConfig) {
    if DISTILL_BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    // 先 clone 成 owned 再进 spawn：spawn 要求 'static，借引用逃逸编译期就拒
    let base_cfg = base_cfg.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _busy = DistillBusyGuard;
        // ① 锁内快照：正文、候选集（排除自身与已作废——在世记忆才可被取代）
        let snapshot = {
            let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let items = load(&app);
            items
                .iter()
                .find(|e| e.ts == ts)
                .map(|e| {
                    // 候选召回词：新条目的 title + keywords（入库时 keywords 为空、
                    // title 是兜底摘要/导入面包屑——都是高区分度信号）
                    let query = format!("{} {}", e.title, e.keywords.join(" "));
                    let pool: Vec<MemEntry> = items
                        .iter()
                        .filter(|e| e.ts != ts && e.superseded_by == 0)
                        .cloned()
                        .collect();
                    (e.text.clone(), or_recall(pool, &query, OR_RECALL_LIMIT))
                })
        };
        let Some((text, candidates)) = snapshot else {
            // 条目已被并发删除：无事可做
            return;
        };
        let mut llm_cfg = base_cfg.clone();
        llm_cfg.custom_prompt = distill_prompt(&candidates, now_ms_i64());
        llm_cfg.timeout_sec = llm_cfg.timeout_sec.clamp(1, 10);
        // ② 三道闸之一：失败重试一次，再失败整体 NOOP（保留兜底标题不动库）
        let mut parsed = distill_attempt(&llm_cfg, &text).await;
        if parsed.is_none() {
            eprintln!("[speaknow] 记忆蒸馏首次失败（ts={ts}），重试一次");
            parsed = distill_attempt(&llm_cfg, &text).await;
        }
        let Some((title, keywords, claimed)) = parsed else {
            eprintln!("[speaknow] 记忆蒸馏失败或解析失败（ts={ts}），整体 NOOP");
            return;
        };
        // ③ 三道闸之二：supersedes 必须在候选集内（防 LLM 编造 id）
        let candidate_ids: Vec<i64> = candidates.iter().map(|c| c.ts).collect();
        let gated = gate_supersedes(claimed, &candidate_ids, ts);
        // ④ 锁内应用 + 落盘广播
        {
            let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut items = load(&app);
            if apply_distill(&mut items, ts, &title, keywords, gated) {
                write(&app, &items);
            }
        }
        // BUSY 由 _busy 守卫 Drop 复位（含 panic 展开路径）
    });
}

/* ---------- Tauri 命令（lib.rs generate_handler 注册） ---------- */

/// 记忆检索：query 空格分词 AND（keywords>title>text 加权），kind 过滤，
/// limit 截断；统计（total/todayCount/totalChars）对整库口径，不受过滤影响
#[tauri::command]
pub fn mem_list(app: AppHandle, query: String, kind: Option<String>, limit: u32) -> MemListResult {
    let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let items = load(&app);
    let (total, today_count, total_chars) = stats(&items, now_ms_i64());
    MemListResult {
        items: search(items, &query, kind.as_deref(), limit as usize),
        total,
        today_count,
        total_chars,
    }
}

/// 批量删除（多选）：锁内一次 load→retain→write，返回实际删除条数
#[tauri::command]
pub fn mem_delete_batch(app: AppHandle, ts: Vec<i64>) -> usize {
    let set: HashSet<i64> = ts.iter().copied().collect();
    let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut items = load(&app);
    let before = items.len();
    items.retain(|i| !set.contains(&i.ts));
    let removed = before - items.len();
    if removed > 0 {
        write(&app, &items);
    }
    removed
}

/// 收藏 / 取消收藏一条记忆（置顶显示，不占保留名额；置顶上限 20，
/// 挤出最旧置顶——history.rs 同款口径）
#[tauri::command]
pub fn mem_set_pinned(app: AppHandle, ts: i64, pinned: bool) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut items = load(&app);
    let Some(item) = items.iter_mut().find(|i| i.ts == ts) else {
        return Err("未找到该条记忆".into());
    };
    item.pinned = pinned;
    if pinned {
        evict_pinned_overflow(&mut items, ts);
    }
    write(&app, &items);
    Ok(())
}

/// 清空记忆库（不影响使用统计；确认弹窗在前端）
#[tauri::command]
pub fn mem_clear(app: AppHandle) {
    let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Ok(p) = path(&app) {
        let _ = fs::remove_file(p);
    }
    let _ = app.emit("sn-mem-changed", ());
}

/* ---------- v3：导入入库通道 / 存储统计 / REST 令牌 ---------- */

/// v3 导入与快记的批量入库通道（mem_import.rs 调用）：锁内一次 load →
/// 逐条近重复判定（先后块互相可见）→ 新增 → 滚动清理 → 一次 write，
/// 网络/解析/分块全部在调用方完成后才进锁。两点与 capture 的刻意差异：
/// - 不做采集黑名单过滤：黑名单只管自动采集（被动听写/取词可能撞上密码
///   管理器进程），网页/文件/快记是用户亲手发起的主动行为，拦它只会
///   造成「点了导入没反应」的困惑
/// - 同毫秒多条（分块导入常态）ts 递增防撞：ts 在本库兼作主键（删除/
///   置顶/裁决都按 ts 寻址），共享 ts 会让多块同生同死
/// 返回 (实际留存的新增数, 近重复合并数, 被滚动清理挤出的本批条数)
pub(crate) fn import_batch(
    app: &AppHandle,
    kind: &str,
    app_name: &str,
    chunks: &[(String, String)],
    limit: usize,
) -> (u32, u32, u32) {
    let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut items = load(app);
    let app_norm = normalize_app(app_name);
    let (added, merged, new_ts) = import_batch_core(&mut items, kind, &app_norm, chunks);
    if added > 0 || merged > 0 {
        items = truncate_keep_pinned(items, limit);
        write(app, &items);
    }
    // 滚动清理可能把本批新条目挤出（limit 较小而导入量大时）：added 以实际
    // 留存数为准、被挤出的并入第三个返回值，摘要 toast 才不会虚报「新增 400」
    let kept = new_ts.iter().filter(|t| items.iter().any(|e| e.ts == **t)).count() as u32;
    (kept, merged, added - kept)
}

/// 批量入库核心（调用方已持有items 并完成 load；不落盘不截断，由调用方决定
/// write 与 truncate 时机）。运行时导入与离线导入（import_paths_standalone）
/// 共用此处，保证两条路径行为逐字一致
pub(crate) fn import_batch_core(
    items: &mut Vec<MemEntry>,
    kind: &str,
    app_norm: &str,
    chunks: &[(String, String)],
) -> (u32, u32, Vec<i64>) {
    let mut added = 0u32;
    let mut merged = 0u32;
    let mut new_ts: Vec<i64> = Vec::new();
    let mut ts = now_ms_i64();
    for (title, text) in chunks {
        if bump_near_duplicate(items, kind, app_norm, text) {
            merged += 1;
            continue;
        }
        if items.first().is_some_and(|e| e.ts >= ts) {
            ts = items[0].ts + 1;
        }
        items.insert(
            0,
            MemEntry {
                ts,
                kind: kind.to_string(),
                app: app_norm.to_string(),
                title: title.clone(),
                chars: text.chars().count() as u32,
                text: text.clone(),
                hits: 0,
                uses: 0,
                last_used_at: 0,
                keywords: Vec::new(),
                distilled: false,
                pinned: false,
                superseded_by: 0,
            },
        );
        new_ts.push(ts);
        added += 1;
    }
    (added, merged, new_ts)
}

/// 存储统计（记忆页存储卡与容量管理用）。软作废条目的保留策略 = Obsidian
/// 模式：永不清——滚动清理与普通条目同规则（在世与否不影响保留名额），
/// 「作废优先于删除」让误判可逆，真要腾空间由用户显式删除
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemStorageStats {
    pub items: u32,
    pub pinned: u32,
    pub superseded: u32,
    /// mem.json 文件字节数
    pub bytes: u64,
    /// mem.bak 文件字节数（0 = 无备份；atomic_write 每次写盘自动留 bak）
    pub bak_bytes: u64,
    /// 全库正文字符数（码点口径，= 各条 chars 求和，与前端展示一致）
    pub chars: u64,
}

/// 统计的纯逻辑部分（不含文件字节数，便于测试）：(总数, 置顶, 作废, 累计字符)
fn storage_counts(items: &[MemEntry]) -> (u32, u32, u32, u64) {
    (
        items.len() as u32,
        items.iter().filter(|e| e.pinned).count() as u32,
        items.iter().filter(|e| e.superseded_by > 0).count() as u32,
        items.iter().map(|e| e.chars as u64).sum(),
    )
}

/// 存储统计命令：锁内 load 统计 + mem.json / mem.bak 的 fs::metadata 字节数
#[tauri::command]
pub fn mem_storage_stats(app: AppHandle) -> MemStorageStats {
    let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let items = load(&app);
    let (n, pinned, superseded, chars) = storage_counts(&items);
    let p = path(&app).ok();
    let bytes = p
        .as_deref()
        .and_then(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);
    let bak_bytes = p
        .as_deref()
        .map(|p| p.with_extension("bak"))
        .and_then(|b| fs::metadata(b).ok())
        .map(|m| m.len())
        .unwrap_or(0);
    MemStorageStats {
        items: n,
        pinned,
        superseded,
        bytes,
        bak_bytes,
        chars,
    }
}

/// base62 字母表（0-9a-zA-Z）：URL/HTTP 头安全，无 +/= 与易混引号
const TOKEN_ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/// 令牌主体（纯逻辑，rng 注入便于测试）：24 位 base62 ≈ 143 bit 熵，
/// 局域网内暴力枚举不可行
fn token_body(rng: &mut impl Rng) -> String {
    (0..24)
        .map(|_| TOKEN_ALPHABET[rng.random_range(0..62)] as char)
        .collect()
}

/// 生成记忆 REST 访问令牌（sn- + 24 位 base62）。必须走 config::save 正规
/// 落盘链路（与 save_config 同款三步：写文件 → 更新 Ctx 内存 → 广播
/// sn-config-changed）——display_api 的局域网鉴权读的就是这份配置，
/// 只改内存不落盘会在重启后「令牌失效」
#[tauri::command]
pub async fn mem_gen_token(app: AppHandle) -> Result<String, String> {
    let token = format!("sn-{}", token_body(&mut rand::rng()));
    let mut new_cfg = app
        .state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .unwrap_or_default();
    new_cfg.mem.api_token = token.clone();
    // config::save 是同步文件 IO：挪到阻塞线程池，不占 tokio worker
    let app2 = app.clone();
    let cfg2 = new_cfg.clone();
    tauri::async_runtime::spawn_blocking(move || crate::config::save(&app2, &cfg2).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())??;
    *app
        .state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(new_cfg);
    let _ = app.emit("sn-config-changed", ());
    Ok(token)
}

/* ---------- v2：召回 / 使用计数 / 工作记忆 ---------- */

/// 实际使用计数的纯逻辑部分：找到 ts 对应条目则 uses+=1、last_used_at=now，
/// 返回 true（由调用方落盘广播）；找不到返回 false（条目已被并发删除）
fn apply_used(items: &mut [MemEntry], ts: i64, now: i64) -> bool {
    let Some(e) = items.iter_mut().find(|e| e.ts == ts) else {
        return false;
    };
    e.uses += 1;
    e.last_used_at = now;
    true
}

/// 使用计数的落盘路径（锁内 load→改→write，命令与注入/复制成功路径共用）
fn mark_used(app: &AppHandle, ts: i64) {
    let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut items = load(app);
    if apply_used(&mut items, ts, now_ms_i64()) {
        write(app, &items);
    }
}

/// 召回检索（display_api 的 GET /mem/search 直接复用本函数的命令形态）。
/// 与 mem_list 的 v1 排序不同：这是给「快速取用」场景的多因子排序
/// （见 recall_rank），两套语义并存——mem_list 服务管理页浏览，本命令
/// 服务召回卡片
#[tauri::command]
pub fn mem_recall(app: AppHandle, query: String, limit: u32) -> Vec<MemEntry> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let items = load(&app);
    recall_rank(items, &query, limit as usize, now_ms_i64())
}

/// 记录一次实际使用（uses+1、lastUsedAt=now、广播）。条目不存在时静默
/// 忽略（mock 同口径：并发删除不是错误，前端无需 toast）
#[tauri::command]
pub fn mem_used(app: AppHandle, ts: i64) {
    mark_used(&app, ts);
}

/// 召回卡「输入到光标处」：注入成功才计一次使用（仅实际使用计数，
/// 防检索自我强化）。时序照抄 confirm_edit / ocr_paste 先例——async
/// 命令体跑在 tokio 运行时、注入在 spawn_blocking、等待用异步 sleep，
/// 热键→悬浮窗→本命令的整条调用链没有任何一处会阻塞主线程
#[tauri::command]
pub async fn mem_recall_paste(app: AppHandle, ts: i64) -> Result<String, String> {
    // 锁内只做文本快照，随即放锁：粘贴期间不能把采集/命令挡在锁外
    let text = {
        let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        load(&app).into_iter().find(|e| e.ts == ts).map(|e| e.text)
    };
    let text = text.ok_or("未找到该条记忆")?;
    let cfg = app
        .state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .unwrap_or_default();
    let out_cfg = cfg.output.clone();
    crate::overlay::hide(&app);
    // 等悬浮窗收回、焦点从卡片回落到目标应用（confirm_edit 同款 180ms）
    tokio::time::sleep(std::time::Duration::from_millis(180)).await;
    let t = text;
    tauri::async_runtime::spawn_blocking(move || crate::inject::paste_text(&out_cfg, &t))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("输入失败：{e:#}"))?;
    // 成功才计使用 + done 状态；失败走 Err 给前端 toast，不计数
    mark_used(&app, ts);
    crate::pipeline::emit_status(&app, "done", "已注入到光标处", cfg.general.sound_feedback);
    crate::pipeline::hide_later(&app, 2600);
    Ok("ok".into())
}

/// 召回卡「复制」：copy 走 lib.rs copy_text 同款 inject::copy_only，但挪到
/// spawn_blocking——剪贴板被占用时 copy_only 内部有重试，不能占着调用线程
#[tauri::command]
pub async fn mem_copy_used(app: AppHandle, ts: i64) -> Result<(), String> {
    let text = {
        let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        load(&app).into_iter().find(|e| e.ts == ts).map(|e| e.text)
    };
    let text = text.ok_or("未找到该条记忆")?;
    tauri::async_runtime::spawn_blocking(move || crate::inject::copy_only(&text))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("复制失败：{e:#}"))?;
    mark_used(&app, ts);
    Ok(())
}

/// 热键召回入口：预取最近 12 条并广播 sn-mem-recall 打开悬浮搜索卡。
/// 调用方是热键 handler（可能处于主线程调用链），文件 IO 全部下放到
/// 专职后台线程（ocr 热键路径 spawn_blocking 的同款纪律），本函数立即返回
pub fn open_recall(app: &AppHandle) {
    // 会话进行中（录音 / 审阅待确认）不打扰：若照常往下走，发出的 idle 会
    // 清掉进行中的卡片，而前端守卫会拦下召回卡——两头不对等就出现空屏死态；
    // 更糟的是 review 态被清后 pending_review 再无人认领，本次听写产出
    // 将永久无法注入。识别/优化期前端 stageRef 守卫兜底，这里覆盖最重的两态
    {
        let state = app.state::<crate::Ctx>();
        let busy = state
            .recording
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
            || state
                .pending_review
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_some();
        if busy {
            return;
        }
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("speaknow-mem-recall".into())
        .spawn(move || {
            let recent = {
                let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                recall_rank(load(&app), "", 12, now_ms_i64())
            };
            // 事件顺序照抄 ocr.rs 惯例（悬浮窗前端按此设计互斥）：
            // ① 清掉 done 卡遗留的隐藏倒计时，否则卡片刚弹就被旧倒计时藏窗；
            // ② 先广播 idle 复位听写/翻译卡状态机，再发本卡事件——若顺序颠倒，
            //    迟到的 idle 会把刚打开的召回卡清场
            crate::pipeline::cancel_hide();
            crate::overlay::show(&app);
            crate::pipeline::emit_status(&app, "idle", "", false);
            // MemEntry 自带 camelCase 序列化，与前端 MemEntry 类型逐字段对齐
            let _ = app.emit("sn-mem-recall", serde_json::json!({ "recent": recent }));
        });
    if let Err(e) = spawned {
        eprintln!("[speaknow] 记忆召回线程启动失败: {e}");
    }
}

/// 工作记忆 markdown 的全文预算（码点）：给外部 AI 工具会话开场注入用，
/// 太长会稀释用户的实际问题——宁少勿超
const CONTEXT_BUDGET: usize = 4_000;
/// Recent 段条数上限：20 条足够唤起近期上下文，再多只是 token 噪声
const CONTEXT_RECENT: usize = 20;

/// kind → 中文标签（工作记忆是给人/外部 AI 读的，不用内部代号）
fn kind_label(kind: &str) -> &str {
    match kind {
        "dictation" => "听写",
        "ocr" => "截图取词",
        "translate" => "翻译",
        other => other,
    }
}

/// 天数（1970-01-01 起）→ 公历年月日（Howard Hinnant civil_from_days）。
/// history.rs 有一份同算法但是私有的（本任务不许改 history.rs），故复刻
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y } as i32, m as u32, d as u32)
}

/// 工作记忆 markdown（纯函数，now 注入便于测试）。格式是 Nowledge Context
/// Bundle 的简化：置顶全文摘要 + 近期一行索引 + 免责声明。逐行压入且只在
/// 整行放得下时才加（宁少勿超：截断半行反而误导读它的 AI）
fn context_markdown_from(items: &[MemEntry], now_ms: i64) -> String {
    let local = local_unix_ms(now_ms);
    let (y, mo, d) = civil_from_days(local.div_euclid(86_400_000));
    let sec_of_day = local.rem_euclid(86_400_000) / 1_000;
    // v3：软作废条目不进 context——这份 markdown 是给外部 AI 当上下文注入的，
    // 被裁决取代的过时信息混进去只会误导；概览 Items 同口径只数在世条目
    let items: Vec<&MemEntry> = items.iter().filter(|e| e.superseded_by == 0).collect();
    let mut out = String::new();
    let push = |out: &mut String, line: &str| {
        if out.chars().count() + line.chars().count() + 1 <= CONTEXT_BUDGET {
            out.push_str(line);
            out.push('\n');
        }
    };
    push(
        &mut out,
        &format!(
            "# SpeakNow Memory Context\nGenerated: {y:04}-{mo:02}-{d:02} {:02}:{:02} · Items: {}",
            sec_of_day / 3_600,
            (sec_of_day % 3_600) / 60,
            items.len()
        ),
    );
    let last_touch = |e: &MemEntry| e.last_used_at.max(e.ts);
    let pinned: Vec<&MemEntry> = items.iter().copied().filter(|e| e.pinned).collect();
    if !pinned.is_empty() {
        push(&mut out, "\n## Pinned");
        // 置顶也按最近触碰排序：越常取用的越靠前
        let mut pinned = pinned;
        pinned.sort_by(|a, b| last_touch(b).cmp(&last_touch(a)));
        for e in pinned {
            let excerpt: String = e.text.chars().take(200).collect();
            push(&mut out, &format!("- ★ {}：{}", e.title, excerpt));
        }
    }
    push(&mut out, "\n## Recent");
    let mut recent: Vec<&MemEntry> = items.iter().copied().filter(|e| !e.pinned).collect();
    recent.sort_by(|a, b| last_touch(b).cmp(&last_touch(a)));
    for e in recent.into_iter().take(CONTEXT_RECENT) {
        let (ry, rm, rd) = civil_from_days(local_unix_ms(last_touch(e)).div_euclid(86_400_000));
        let _ = ry; // 年份不进索引行：M-DD 短格式省 token，跨年由免责句兜底
        push(
            &mut out,
            &format!("- {rm}-{rd:02} [{}] {}（用过 {} 次）", kind_label(&e.kind), e.title, e.uses),
        );
    }
    push(
        &mut out,
        "\n> 以上由 SpeakNow 记忆库自动生成，可能过期；如与你当前输入冲突，以当前输入为准。完整检索：GET /mem/search?q=",
    );
    out
}

/// 工作记忆 markdown（display_api 的 GET /mem/context.md 用）：给外部 AI
/// 工具会话开场注入用。调用方是 HTTP 工作线程，这里仍走锁保证快照一致性
pub fn context_markdown(app: &AppHandle) -> String {
    let items = {
        let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        load(app)
    };
    context_markdown_from(&items, now_ms_i64())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(ts: i64, kind: &str, title: &str, text: &str, keywords: &[&str]) -> MemEntry {
        MemEntry {
            ts,
            kind: kind.into(),
            app: "app".into(),
            title: title.into(),
            text: text.into(),
            keywords: keywords.iter().map(|s| s.to_string()).collect(),
            distilled: !keywords.is_empty(),
            pinned: false,
            chars: text.chars().count() as u32,
            hits: 0,
            uses: 0,
            last_used_at: 0,
            superseded_by: 0,
        }
    }

    /* ---- 检索：多词 AND、权重、kind 过滤 ---- */

    #[test]
    fn search_and_semantics_and_weights() {
        // A：rust 命中 keywords(3)、pipeline 命中 text(1) → 4 分
        // B：rust 命中 title(2)、pipeline 命中 text(1) → 3 分
        // C：rust 命中 keywords 但 pipeline 全不命中 → AND 淘汰
        // D：两词都在 text → 2 分
        let a = entry(40, "dictation", "架构记录", "今天聊了 pipeline 架构", &["rust", "记忆库"]);
        let b = entry(39, "dictation", "rust 学习", "rust 与 pipeline 实践", &[]);
        let c = entry(41, "dictation", "rust 笔记", "别的内容", &["rust"]);
        let d = entry(38, "dictation", "日常", "rust pipeline 杂记", &[]);
        let out = search(vec![a, b, c, d], "rust pipeline", None, 10);
        let ts: Vec<i64> = out.iter().map(|e| e.ts).collect();
        assert_eq!(ts, vec![40, 39, 38], "按分排序（4>3>2），C 被 AND 淘汰");
    }

    #[test]
    fn search_single_term_weight_order() {
        let kw = entry(10, "ocr", "标题甲", "正文不含词", &["检索"]);
        let ti = entry(11, "ocr", "检索标题", "正文不含词", &[]);
        let tx = entry(12, "ocr", "标题丙", "正文含检索词", &[]);
        let out = search(vec![tx.clone(), ti.clone(), kw.clone()], "检索", None, 10);
        assert_eq!(
            out.iter().map(|e| e.ts).collect::<Vec<_>>(),
            vec![10, 11, 12],
            "keywords(3) > title(2) > text(1)"
        );
        // 同分（都只命中 text）→ ts 新在前
        let t1 = entry(1, "ocr", "a", "检索", &[]);
        let t2 = entry(2, "ocr", "b", "检索", &[]);
        let out = search(vec![t1, t2], "检索", None, 10);
        assert_eq!(out.iter().map(|e| e.ts).collect::<Vec<_>>(), vec![2, 1]);
    }

    #[test]
    fn search_kind_filter_before_scoring() {
        let d = entry(5, "dictation", "t", "关键词命中", &["命中"]);
        let o = entry(4, "ocr", "t", "关键词命中", &["命中"]);
        assert_eq!(
            search(vec![d.clone(), o], "命中", Some("ocr"), 10)
                .iter()
                .map(|e| e.kind.clone())
                .collect::<Vec<_>>(),
            vec!["ocr".to_string()],
            "kind 不匹配直接淘汰，分数再高也不出现"
        );
        // None = 不过滤
        assert_eq!(search(vec![d], "命中", None, 10).len(), 1);
    }

    #[test]
    fn search_empty_query_pins_first_then_ts() {
        let mut old_pinned = entry(1, "dictation", "老的置顶", "x", &[]);
        old_pinned.pinned = true;
        let new = entry(99, "dictation", "新的普通", "y", &[]);
        let mid = entry(50, "dictation", "中间", "z", &[]);
        let out = search(vec![new.clone(), mid.clone(), old_pinned.clone()], "", None, 10);
        assert_eq!(
            out.iter().map(|e| e.ts).collect::<Vec<_>>(),
            vec![1, 99, 50],
            "无查询：置顶优先，其余 ts 新→旧"
        );
        // 有查询时置顶不加分（分数优先，同分才比 ts）
        let out = search(vec![old_pinned, new.clone()], "x", None, 10);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].ts, 1);
    }

    #[test]
    fn search_limit_truncates_after_sort() {
        let items: Vec<MemEntry> = (0..10).map(|i| entry(i, "dictation", "t", "词", &[])).collect();
        assert_eq!(search(items, "词", None, 3).len(), 3);
        // limit=0：与 mock 的 slice(0,0) 一致，返回空（统计仍在 MemListResult 层单独算）
        let items: Vec<MemEntry> = (0..3).map(|i| entry(i, "dictation", "t", "词", &[])).collect();
        assert!(search(items, "", None, 0).is_empty());
    }

    #[test]
    fn search_terms_are_case_insensitive_and_whitespace_split() {
        let e = entry(1, "translate", "Design Note", "Hybrid Retrieval works", &[]);
        assert_eq!(search(vec![e.clone()], "  design   HYBRID ", None, 10).len(), 1);
        // 多空白压缩成 AND 两词，均命中 text
        assert_eq!(search(vec![e], "note\tretrieval", None, 10).len(), 1);
    }

    /* ---- 滚动清理 / 置顶 ---- */

    #[test]
    fn truncate_keeps_pinned_beyond_limit() {
        // 新→旧：ts 5(置顶),4,3(置顶),2,1,0；limit=3 → 非置顶截到 [4,2,1]，
        // 置顶 5/3 全保留，ts 0 被滚掉，整体 ts 降序 [5,4,3,2,1]
        let mut items = vec![
            entry(5, "dictation", "f", "f", &[]),
            entry(4, "dictation", "e", "e", &[]),
            entry(3, "dictation", "d", "d", &[]),
            entry(2, "dictation", "c", "c", &[]),
            entry(1, "dictation", "b", "b", &[]),
            entry(0, "dictation", "a", "a", &[]),
        ];
        items[0].pinned = true;
        items[2].pinned = true;
        let out = truncate_keep_pinned(items, 3);
        assert_eq!(out.iter().map(|i| i.ts).collect::<Vec<_>>(), vec![5, 4, 3, 2, 1]);
        assert_eq!(out.iter().filter(|i| i.pinned).count(), 2);
    }

    #[test]
    fn truncate_without_pinned_is_plain() {
        let items = vec![
            entry(3, "ocr", "c", "c", &[]),
            entry(2, "ocr", "b", "b", &[]),
            entry(1, "ocr", "a", "a", &[]),
        ];
        let out = truncate_keep_pinned(items, 2);
        assert_eq!(out.iter().map(|i| i.ts).collect::<Vec<_>>(), vec![3, 2]);
    }

    #[test]
    fn pinned_fifo_eviction_at_cap() {
        // 21 条已置顶最旧 20 条，再置顶最新 → 挤出最旧置顶，总数回到上限
        let mut items: Vec<MemEntry> = (80..=100i64)
            .rev()
            .map(|ts| {
                let mut it = entry(ts, "dictation", "x", "x", &[]);
                it.pinned = ts <= 99;
                it
            })
            .collect();
        items[0].pinned = true; // ts=100
        evict_pinned_overflow(&mut items, 100);
        let pinned: Vec<i64> = items.iter().filter(|i| i.pinned).map(|i| i.ts).collect();
        assert!(!pinned.contains(&80), "最旧置顶被挤出: {pinned:?}");
        assert_eq!(pinned.len(), PINNED_CAP);
        // 未达上限不挤出
        let mut few: Vec<MemEntry> = (0..5i64).rev().map(|ts| entry(ts, "ocr", "x", "x", &[])).collect();
        for it in few.iter_mut() {
            it.pinned = true;
        }
        evict_pinned_overflow(&mut few, 4);
        assert_eq!(few.iter().filter(|i| i.pinned).count(), 5);
    }

    /* ---- 近重复合并（bigram Jaccard）/ 标题 / app 规整 ---- */

    #[test]
    fn jaccard_identical_unrelated_and_boundary() {
        let a = char_bigrams(&normalize_for_bigram("今天天气很好"));
        assert!(
            (jaccard(&a, &char_bigrams(&normalize_for_bigram("今天天气很好"))) - 1.0).abs() < 1e-9,
            "相同文本 = 1"
        );
        let z = char_bigrams(&normalize_for_bigram("完全不同内容"));
        assert!(jaccard(&a, &z) < 0.05, "无关文本 ≈ 0，实际 {}", jaccard(&a, &z));
        // 0.75 边界：abcd 与 abcde 交集 3 / 并集 4 = 恰好 0.75（≥ 阈值判重）
        let b1 = char_bigrams(&normalize_for_bigram("abcd"));
        let b2 = char_bigrams(&normalize_for_bigram("abcde"));
        assert!((jaccard(&b1, &b2) - 0.75).abs() < 1e-9);
        // abcd 与 abcdef：3/5 = 0.6 < 0.75，不算重复
        let b3 = char_bigrams(&normalize_for_bigram("abcdef"));
        assert!((jaccard(&b1, &b3) - 0.6).abs() < 1e-9);
    }

    #[test]
    fn jaccard_short_text_falls_back_to_equality() {
        // <2 字符无 bigram：退化为相等比较（v1 精确去重语义）
        let mut items = vec![entry(2, "dictation", "t", "a", &[])];
        assert!(bump_near_duplicate(&mut items, "dictation", "app", "a"), "同为单字符 → 重复");
        assert_eq!(items[0].hits, 1);
        assert!(!bump_near_duplicate(&mut items, "dictation", "app", "b"), "单字符不同 → 不重复");
        // 空白不参与：换行/空格差异不影响判定
        let mut items = vec![entry(3, "dictation", "t", "你好\n世界", &[])];
        assert!(bump_near_duplicate(&mut items, "dictation", "app", "你 好 世 界"));
    }

    #[test]
    fn near_duplicate_bumps_hits_without_new_entry() {
        let mut items = vec![entry(5, "dictation", "t", "会议改到下午三点", &[])];
        assert!(
            bump_near_duplicate(&mut items, "dictation", "app", "会议改到下午三点"),
            "完全相同 → Jaccard=1 特例自然覆盖 v1 精确去重"
        );
        assert_eq!(items[0].hits, 1);
        assert_eq!(items.len(), 1, "不新建条目");
        // 微调重述（末尾多一个词）仍算近重复
        assert!(bump_near_duplicate(&mut items, "dictation", "app", "会议改到下午三点半"));
        assert_eq!(items[0].hits, 2);
        // 语义无关的新内容不算
        assert!(!bump_near_duplicate(&mut items, "dictation", "app", "明天去超市买菜"));
        assert_eq!(items[0].hits, 2);
    }

    #[test]
    fn near_duplicate_scoped_kind_app_and_window() {
        let mut items = vec![entry(5, "dictation", "t", "同一句话", &[])];
        // kind / app 不同的旧条不参与判定
        assert!(!bump_near_duplicate(&mut items, "ocr", "app", "同一句话"));
        assert!(!bump_near_duplicate(&mut items, "dictation", "other", "同一句话"));
        // 只看最近 50 条：目标条排在第 51 位（下标 50）时超出窗口
        let mut many: Vec<MemEntry> = (0..50)
            .map(|i| entry(i, "dictation", "t", &format!("别的记忆{i}"), &[]))
            .collect();
        many.push(entry(99, "dictation", "t", "同一句话", &[]));
        assert!(
            !bump_near_duplicate(&mut many, "dictation", "app", "同一句话"),
            "第 51 条超出 50 条窗口"
        );
        // 同一条挪进窗口（下标 49，第 50 位）即命中
        let mut many: Vec<MemEntry> = (0..49)
            .map(|i| entry(i, "dictation", "t", &format!("别的记忆{i}"), &[]))
            .collect();
        many.push(entry(99, "dictation", "t", "同一句话", &[]));
        assert!(bump_near_duplicate(&mut many, "dictation", "app", "同一句话"));
        assert!(!bump_near_duplicate(&mut [], "dictation", "app", "x"), "空库不算重复");
    }

    /* ---- 采集黑名单 ---- */

    #[test]
    fn blacklist_builtin_always_on() {
        for app in ["1password", "keepassxc", "bitwarden", "proton pass", "protonpass", "authy", "yubikey"] {
            assert!(app_blacklisted(app, ""), "内置名单 {app} 应始终拦截");
        }
        // 子串匹配：宿主/变体进程名同样被拦（app_blacklisted 收已规整输入，
        // 规整 = normalize_app 去 .exe 小写，由 capture 侧先行完成）
        assert!(app_blacklisted("mykeepasshelper", ""));
        assert!(app_blacklisted("protonpass", ""));
        // 收窄验证：Proton 全家桶的非密码应用（Mail/VPN/Drive）不被宽子串误伤
        assert!(!app_blacklisted("proton", ""));
        assert!(!app_blacklisted("proton mail", ""));
        assert!(!app_blacklisted("chrome", ""), "普通应用不拦");
        assert!(!app_blacklisted("", ""), "取不到进程名（空串）不拦——听写场景可能无前台信息");
    }

    #[test]
    fn blacklist_user_lines_substring_match() {
        // 匹配方向：关键字是进程名的子串（与内置名单一致）
        assert!(app_blacklisted("vscode", "微信\n\n VSCode \n"), "用户名单逐行 trim、小写子串匹配");
        assert!(app_blacklisted("wechat", "WeChat"), "大小写不敏感");
        assert!(!app_blacklisted("chrome", "微信\n VSCode"), "未命中不拦");
        assert!(!app_blacklisted("chrome", "  \n \n"), "空白行忽略");
    }

    /* ---- v2 召回排序（固定 now） ---- */

    #[test]
    fn recall_rank_recency_and_uses_factors() {
        let now = 10_000_000_000_000i64;
        let day = 86_400_000i64;
        // 同分同新鲜度：用过的浮顶（频次因子 1+log10(1+uses) ≥ 1）
        let mut used = entry(now - day, "dictation", "t", "检索词", &[]);
        used.uses = 9;
        let fresh_unused = entry(now - day, "dictation", "t2", "检索词", &[]);
        let out = recall_rank(vec![fresh_unused, used], "检索词", 10, now);
        assert_eq!(out[0].uses, 9, "同新鲜度下使用次数是决定因素");
        // 旧的但常用 > 新的没用过：0.95^10≈0.60 × 2（uses=9）≈1.20 > 0.95
        let mut old_used = entry(now - 10 * day, "dictation", "t3", "检索词", &[]);
        old_used.uses = 9;
        let new_unused = entry(now - day, "dictation", "t4", "检索词", &[]);
        let out = recall_rank(vec![new_unused.clone(), old_used], "检索词", 10, now);
        assert_eq!(out[0].uses, 9, "多因子合成的老常用条应排在新未用条之前");
        // 时间衰减单因子：都没用过时新的在前
        let out = recall_rank(
            vec![new_unused, entry(now - 30 * day, "dictation", "t5", "检索词", &[])],
            "检索词",
            10,
            now,
        );
        assert_eq!(out[0].ts, now - day);
        // AND 语义延续：任一词未命中整条淘汰
        let out = recall_rank(vec![entry(1, "dictation", "t", "只有甲", &[])], "甲 乙", 10, now);
        assert!(out.is_empty());
        // limit 截断
        let many: Vec<MemEntry> = (0..8).map(|i| entry(i, "dictation", "t", "检索词", &[])).collect();
        assert_eq!(recall_rank(many, "检索词", 3, now).len(), 3);
    }

    #[test]
    fn recall_rank_days_base_prefers_last_used() {
        let now = 10_000_000_000_000i64;
        let day = 86_400_000i64;
        // ts 很老但刚用过：衰减基准取 last_used_at → 几乎不衰减
        let mut just_used = entry(now - 30 * day, "dictation", "t", "检索词", &[]);
        just_used.last_used_at = now - 1_000;
        let stale = entry(now - day, "dictation", "t2", "检索词", &[]);
        let out = recall_rank(vec![stale, just_used], "检索词", 10, now);
        assert_eq!(out[0].last_used_at, now - 1_000, "衰减基准 = last_used_at（用时即保鲜）");
    }

    #[test]
    fn recall_rank_empty_query_pins_then_touch_order() {
        let now = 10_000_000_000_000i64;
        let mut pin = entry(1, "dictation", "老置顶", "x", &[]);
        pin.pinned = true;
        // ts 旧但刚用过（last_used 比新条的采集时刻还新）→ 浮到最新未用条之上
        let mut used_old = entry(100, "dictation", "用过", "y", &[]);
        used_old.last_used_at = now - 500;
        let new_unused = entry(now - 1_000, "dictation", "新的", "z", &[]);
        let out = recall_rank(vec![new_unused.clone(), used_old, pin], "", 10, now);
        assert_eq!(
            out.iter().map(|e| e.ts).collect::<Vec<_>>(),
            vec![1, 100, now - 1_000],
            "空查询：置顶浮顶，其余按 max(last_used, ts) 新→旧（用过浮顶）"
        );
        assert_eq!(recall_rank(vec![new_unused], "", 0, now).len(), 0, "limit=0 为空");
    }

    /* ---- 使用计数 ---- */

    #[test]
    fn apply_used_updates_fields_and_tolerates_missing() {
        let mut items = vec![entry(7, "dictation", "t", "x", &[]), entry(8, "ocr", "t2", "y", &[])];
        assert!(apply_used(&mut items, 7, 123_456));
        assert_eq!(items[0].uses, 1);
        assert_eq!(items[0].last_used_at, 123_456);
        assert_eq!(items[1].uses, 0, "只动目标条");
        assert!(apply_used(&mut items, 7, 999_999));
        assert_eq!(items[0].uses, 2, "重复使用累加");
        assert_eq!(items[0].last_used_at, 999_999);
        assert!(!apply_used(&mut items, 404, 1), "不存在的 ts 静默失败");
    }

    /* ---- 工作记忆 markdown ---- */

    #[test]
    fn context_markdown_sections_and_disclaimer() {
        // 20_729 天 + 12h = 2026-10-03 12:00 UTC：UTC 与 UTC+8（本机）的本地日均为 10-03
        let now = 20_729i64 * 86_400_000 + 43_200_000;
        let mut pin = entry(now - 5_000, "dictation", "置顶要点", "置顶正文", &[]);
        pin.pinned = true;
        let mut used = entry(now - 10_000, "translate", "翻译记录", "译文", &[]);
        used.uses = 2;
        used.last_used_at = now - 1_000;
        let md = context_markdown_from(
            &[used, entry(now - 20_000, "ocr", "取词", "词", &[]), pin],
            now,
        );
        assert!(md.contains("# SpeakNow Memory Context"), "{md}");
        assert!(md.contains("Items: 3"));
        assert!(md.contains("## Pinned"));
        assert!(md.contains("- ★ 置顶要点：置顶正文"));
        assert!(md.contains("## Recent"));
        assert!(md.contains("[翻译] 翻译记录（用过 2 次）"), "kind 中文标签 + 使用计数");
        assert!(md.contains("[截图取词] 取词（用过 0 次）"));
        assert!(md.contains("以上由 SpeakNow 记忆库自动生成"));
        assert!(md.contains("以当前输入为准"));
        assert!(md.contains("GET /mem/search?q="));
        // 日期行格式 M-DD（十月 = 10，两位日）
        assert!(md.contains("- 10-03 ["), "{md}");
    }

    #[test]
    fn context_markdown_caps_at_4000_chars() {
        let now = 1_791_427_600_000i64;
        // 40 条 600 字置顶 + 40 条近期：无预算时远超 4000，整行压入策略下不得越界
        let items: Vec<MemEntry> = (0..80)
            .map(|i| {
                let mut e = entry(now - i as i64 * 1_000, "dictation", &format!("标题{i}"), &"长".repeat(600), &[]);
                e.pinned = i % 2 == 0;
                e
            })
            .collect();
        let md = context_markdown_from(&items, now);
        assert!(md.chars().count() <= 4_000, "实际 {} 字符", md.chars().count());
        assert!(md.contains("Items: 80"), "概览行必在（预算优先留给头部）");
    }

    #[test]
    fn context_markdown_empty_library_still_valid() {
        let md = context_markdown_from(&[], 1_791_427_600_000);
        assert!(md.contains("Items: 0"));
        assert!(md.contains("## Recent"), "空 Recent 段保留（Pinned 空段省略）");
    }

    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(10_957), (2000, 1, 1));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29)); // 世纪闰日
        assert_eq!(civil_from_days(20_729), (2026, 10, 3));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }

    #[test]
    fn fallback_title_collapses_and_caps_40_chars() {
        assert_eq!(fallback_title("  你好\n世界  "), "你好 世界");
        let long = "字".repeat(60);
        assert_eq!(fallback_title(&long).chars().count(), 40);
    }

    #[test]
    fn normalize_app_strips_exe_and_lowercases() {
        assert_eq!(normalize_app("Chrome.exe"), "chrome");
        assert_eq!(normalize_app("WindowsTerminal.EXE"), "windowsterminal");
        assert_eq!(normalize_app("pid:123"), "pid:123");
        assert_eq!(normalize_app(""), "");
    }

    /* ---- 统计 / 本地零点 ---- */

    #[test]
    fn stats_counts_all_regardless_of_content() {
        let mut e1 = entry(1_791_427_600_000, "dictation", "t", "四字正文", &[]); // 2026-10-08 02:46:40 UTC
        e1.chars = 4;
        let mut e2 = entry(1_791_427_600_001, "ocr", "t", "x", &[]);
        e2.chars = 1;
        let now = 1_791_427_600_500;
        // 相差 1ms 的两条必为同本地日：today 计 2
        let (total, today, chars) = stats(&[e1, e2], now);
        assert_eq!((total, today, chars), (2, 2, 5));
    }

    #[test]
    fn local_midnight_is_aligned_and_bounded() {
        let noon = 1_791_427_600_000i64; // 2026-10-03 12:00 UTC
        let m = local_midnight_ms(noon);
        assert!(m <= noon && noon - m < 86_400_000, "零点 ≤ 时刻且相差不足一天");
        assert_eq!(local_midnight_ms(noon + 1), m, "同本地日零点相同");
        // 任意时刻减零点必是 [0, 24h) 的本地钟表余量
        let other = local_midnight_ms(noon - 86_400_000 + 1);
        assert!(other <= noon - 86_400_000 + 1);
    }

    /* ---- 蒸馏 JSON 解析（含脏输入） ---- */

    #[test]
    fn distill_json_clean() {
        let (t, k, sup) = parse_distill_json(
            "{\"title\":\"剪贴板还原三重保障\",\"keywords\":[\"剪贴板\",\"PASTE_LOCK\"],\"supersedes\":1700000000000}",
        )
        .expect("干净 JSON 应解析");
        assert_eq!(t, "剪贴板还原三重保障");
        assert_eq!(k, vec!["剪贴板".to_string(), "PASTE_LOCK".to_string()]);
        assert_eq!(sup, 1_700_000_000_000, "v3 supersedes 字段透传");
        // v2 回包（无 supersedes）缺省 0——旧 prompt 不改也能跑
        let (_, _, sup) = parse_distill_json("{\"title\":\"t\",\"keywords\":[]}")
            .expect("v2 形态应解析");
        assert_eq!(sup, 0);
    }

    #[test]
    fn distill_json_dirty_inputs() {
        // 代码围栏 + 前后缀 prose（llm::clean 之后仍可能残留的形态）
        let fenced = "好的，结果如下：\n```json\n{\"title\":\"记忆卡\",\"keywords\":[\"a\"],\"supersedes\":5}\n```\n以上。";
        let (t, k, sup) = parse_distill_json(fenced).expect("围栏包裹应解析");
        assert_eq!(t, "记忆卡");
        assert_eq!(k, vec!["a".to_string()]);
        assert_eq!(sup, 5);
        // 空关键词缺省、title 空白被拒
        assert!(parse_distill_json("{\"title\":\"  \",\"keywords\":[]}").is_none());
        assert!(parse_distill_json("{\"keywords\":[\"a\"]}").is_none());
        // 非 JSON / 截断 / 只有半边花括号
        assert!(parse_distill_json("我不明白").is_none());
        assert!(parse_distill_json("{\"title\":\"截断").is_none());
        assert!(parse_distill_json("}").is_none());
        assert!(parse_distill_json("").is_none());
        // supersedes 是字符串而非数字 → 整体解析失败（保守丢弃，不猜测转换）
        assert!(parse_distill_json("{\"title\":\"t\",\"supersedes\":\"1700000000000\"}").is_none());
    }

    #[test]
    fn distill_json_keyword_dedup_and_cap() {
        let raw = "{\"title\":\"t\",\"keywords\":[\"Rust\",\"rust\",\"  \",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\",\"g\"]}";
        let (_, k, _) = parse_distill_json(raw).expect("应解析");
        assert_eq!(k.len(), 6, "截到 6 个");
        assert!(k.iter().any(|x| x == "Rust") && !k.iter().any(|x| x == "rust"), "小写去重");
        // title 超长硬截
        let long = "标".repeat(80);
        let json = format!("{{\"title\":\"{long}\",\"keywords\":[]}}");
        let (t, _, _) = parse_distill_json(&json).expect("应解析");
        assert_eq!(t.chars().count(), 40);
    }

    /* ---- serde camelCase 往返 ---- */

    #[test]
    fn memlistresult_serde_is_camelcase_roundtrip() {
        let r = MemListResult {
            items: vec![],
            total: 3,
            today_count: 1,
            total_chars: 9,
        };
        let j = serde_json::to_string(&r).unwrap();
        assert!(j.contains("\"todayCount\":1"), "{j}");
        assert!(j.contains("\"totalChars\":9"), "{j}");
        let back: MemListResult = serde_json::from_str(&j).unwrap();
        assert_eq!(back.total, 3);
        assert_eq!(back.today_count, 1);
        assert_eq!(back.total_chars, 9);
    }

    #[test]
    fn mementry_roundtrip_and_default_tolerance() {
        let e = MemEntry {
            ts: 42,
            kind: "translate".into(),
            app: "chrome".into(),
            title: "t".into(),
            text: "正文内容".into(),
            keywords: vec!["a".into()],
            distilled: true,
            pinned: false,
            chars: 4,
            hits: 3,
            uses: 7,
            last_used_at: 1_234,
            superseded_by: 99,
        };
        let j = serde_json::to_string(&e).unwrap();
        assert!(j.contains("\"keywords\":[\"a\"]"), "{j}");
        assert!(j.contains("\"lastUsedAt\":1234"), "camelCase 输出与前端类型对齐：{j}");
        assert!(j.contains("\"supersededBy\":99"), "v3 软作废字段 camelCase：{j}");
        let back: MemEntry = serde_json::from_str(&j).unwrap();
        assert_eq!(back, e);
        // 旧文件 / 手编文件缺 keywords/distilled/pinned 及 v2/v3 新字段：缺省容错
        let legacy: MemEntry =
            serde_json::from_str("{\"ts\":1,\"kind\":\"ocr\",\"app\":\"\",\"title\":\"t\",\"text\":\"x\",\"chars\":1}")
                .unwrap();
        assert!(legacy.keywords.is_empty() && !legacy.distilled && !legacy.pinned);
        assert_eq!((legacy.hits, legacy.uses, legacy.last_used_at), (0, 0, 0), "v1 mem.json 反序列化默认值");
        assert_eq!(legacy.superseded_by, 0, "v2 mem.json 反序列化默认在世");
    }

    /* ---- v3：软作废过滤 / OR 召回 / 裁决三道闸 / 统计 / 令牌 ---- */

    #[test]
    fn superseded_filtered_in_recall_but_not_search() {
        let mut dead = entry(100, "dictation", "旧说法", "会议定在周三", &[]);
        dead.superseded_by = 200;
        let alive = entry(50, "dictation", "新说法", "会议改到周四", &[]);
        // recall_rank：有查询与空查询两条路径都过滤作废条目
        let out = recall_rank(vec![dead.clone(), alive.clone()], "会议", 10, 10_000);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].ts, 50, "作废条目不进召回");
        let out = recall_rank(vec![dead, alive], "", 10, 10_000);
        assert_eq!(out.iter().map(|e| e.ts).collect::<Vec<_>>(), vec![50]);
        // search（mem_list 通道）：不过滤——设置页要能看到并管理作废条目
        let out = search(
            vec![entry(100, "dictation", "旧说法", "会议定在周三", &[]), entry(50, "dictation", "新说法", "会议改到周四", &[])],
            "会议",
            None,
            10,
        );
        assert_eq!(out.len(), 2, "mem_list 不作废过滤");
    }

    #[test]
    fn superseded_filtered_in_context_markdown() {
        let now = 1_791_427_600_000i64;
        let mut pin = entry(now - 1_000, "dictation", "置顶但被取代", "旧置顶正文", &[]);
        pin.pinned = true;
        pin.superseded_by = 1;
        let alive = entry(now - 2_000, "ocr", "在世", "词", &[]);
        let md = context_markdown_from(&[pin, alive.clone()], now);
        assert!(!md.contains("旧置顶正文"), "置顶不作豁免：被取代即出 context");
        assert!(!md.contains("置顶但被取代"));
        assert!(md.contains("在世"));
        assert!(md.contains("Items: 1"), "概览只数在世条目：{md}");
    }

    #[test]
    fn or_recall_any_term_hits_and_orders_by_ts() {
        let a = entry(10, "dictation", "会议时间", "会议定在周三上午", &[]);
        let b = entry(20, "dictation", "调休安排", "本周五调休", &["会议"]);
        let c = entry(30, "dictation", "无关", "完全不同的内容", &[]);
        // OR：两个词各自只命中一条（AND 会得空）——b 只命中「会议」关键词，
        // a 只命中「周三」，都应入围且按 ts 新→旧
        let out = or_recall(vec![a.clone(), b.clone(), c.clone()], "会议 周三", 10);
        assert_eq!(out.iter().map(|e| e.ts).collect::<Vec<_>>(), vec![20, 10]);
        // limit 截断
        assert_eq!(or_recall(vec![a.clone(), b, c], "会议 周三", 1).len(), 1);
        // 空查询无候选（分不出词就无从召回）
        assert!(or_recall(vec![a], "", 10).is_empty());
        // 作废条目不入围（不可链式取代）
        let mut dead = entry(40, "dictation", "旧会议", "会议时间", &[]);
        dead.superseded_by = 1;
        assert!(or_recall(vec![dead], "会议", 10).is_empty());
    }

    #[test]
    fn relative_time_buckets() {
        assert_eq!(relative_time(5_000), "5 秒前");
        assert_eq!(relative_time(90_000), "1 分钟前");
        assert_eq!(relative_time(3_600_000), "1 小时前");
        assert_eq!(relative_time(3 * 86_400_000), "3 天前");
        assert_eq!(relative_time(-1_000), "0 秒前", "时钟回拨钳到 0");
    }

    #[test]
    fn distill_prompt_no_candidates_is_v2() {
        assert_eq!(distill_prompt(&[], 1_791_427_600_000), DISTILL_PROMPT);
        let cand = entry(1_700_000_000_000, "dictation", "会议时间", "会议定在周三。请准时参加。", &[]);
        let p = distill_prompt(&[cand], 1_700_000_000_000 + 3 * 86_400_000);
        assert!(p.contains("supersedes"), "{p}");
        assert!(p.contains("[id=1700000000000]（3 天前）"), "id + 相对时间排布：{p}");
        assert!(p.contains("标题：会议时间"), "{p}");
        assert!(p.contains("会议定在周三"), "正文前 200 码点进候选：{p}");
        assert!(p.contains("宁可漏判不可误判"), "保守裁决指令在位：{p}");
        assert!(p.ends_with("文本：{text}"), "占位保留在尾部");
    }

    #[test]
    fn gate_supersedes_rejects_fabricated_ids() {
        let cands = [10i64, 20, 30];
        assert_eq!(gate_supersedes(20, &cands, 99), Some(20), "候选内的 id 放行");
        assert_eq!(gate_supersedes(0, &cands, 99), None, "0 = 无裁决");
        assert_eq!(gate_supersedes(-5, &cands, 99), None, "负数丢弃");
        assert_eq!(gate_supersedes(40, &cands, 99), None, "编造 id（不在候选集）丢弃");
        assert_eq!(gate_supersedes(99, &cands, 99), None, "自身不可作废自身");
    }

    #[test]
    fn apply_distill_updates_and_soft_supersedes() {
        // items[0]=旧条(ts=10)，items[1]=新条(ts=20)
        let mut items = vec![entry(10, "dictation", "旧标题", "旧正文", &[]), entry(20, "dictation", "兜底", "新正文", &[])];
        // 正常路径：新条更新三字段 + 旧条软作废
        assert!(apply_distill(&mut items, 20, "新标题", vec!["k".into()], Some(10)));
        assert_eq!(items[1].superseded_by, 0, "新条自身在世");
        assert!(items[1].distilled);
        assert_eq!(items[1].title, "新标题");
        assert_eq!(items[0].superseded_by, 20, "旧条被新条 ts 软作废");
        // 迟到完成：已蒸馏条目不覆盖；已作废旧条不二次改判
        assert!(!apply_distill(&mut items, 20, "又一版", vec![], Some(10)));
        assert_eq!(items[0].superseded_by, 20);
        assert_eq!(items[1].title, "新标题");
        // 条目已被并发删除：无事可做；目标旧条不存在：只更新新条
        let mut items = vec![entry(1, "ocr", "t", "x", &[])];
        assert!(!apply_distill(&mut items, 999, "t", vec![], None));
        assert!(apply_distill(&mut items, 1, "t2", vec![], Some(999)));
    }

    #[test]
    fn storage_counts_pure_logic() {
        let mut a = entry(1, "dictation", "t", "四字", &[]);
        a.pinned = true;
        let mut b = entry(2, "ocr", "t", "两字", &[]);
        b.superseded_by = 9;
        let c = entry(3, "translate", "t", "一个字", &[]);
        // chars 是码点数：「四字」=2 、「两字」=2、「一个字」=3
        let (n, pinned, superseded, chars) = storage_counts(&[a, b, c]);
        assert_eq!((n, pinned, superseded, chars), (3, 1, 1, 7));
        // MemStorageStats serde：bakBytes camelCase 与前端类型对齐
        let s = MemStorageStats {
            items: 3,
            pinned: 1,
            superseded: 1,
            bytes: 1234,
            bak_bytes: 567,
            chars: 9,
        };
        let j = serde_json::to_string(&s).unwrap();
        assert!(j.contains("\"bakBytes\":567"), "{j}");
        let back: MemStorageStats = serde_json::from_str(&j).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn token_body_format_and_entropy() {
        let mut rng = rand::rng();
        let t1 = token_body(&mut rng);
        let t2 = token_body(&mut rng);
        assert_eq!(t1.chars().count(), 24);
        assert!(t1.chars().all(|c| c.is_ascii_alphanumeric()), "base62：{t1}");
        assert_ne!(t1, t2, "两次生成不应碰撞（62^24 空间）");
        // 完整令牌形态在命令层拼 sn- 前缀，这里校验字母表覆盖假设
        assert_eq!(TOKEN_ALPHABET.len(), 62);
    }
}
