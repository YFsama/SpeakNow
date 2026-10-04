use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const MAX_ITEMS: usize = 50;

/* 读-改-写全局锁：push / update_final / delete / clear 可能从听写、划词翻译、
   OCR 等不同线程并发进入，无锁时后写者会覆盖先写者（丢一条记录） */
static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub ts: i64,
    pub raw: String,
    #[serde(rename = "final")]
    pub final_text: String,
    #[serde(default)]
    pub asr_ms: Option<u64>,
    #[serde(default)]
    pub llm_ms: Option<u64>,
    /// dictation / translate / ocr（旧数据缺省；前端按 asrMs==null 推断为 translate）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// 收藏置顶（旧数据缺省 = false）。置顶条目不占保留条数名额，
    /// 截断时始终保留（数量上限见 PINNED_CAP，防无限膨胀）
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
}

/// 置顶条目数量上限：超出时最早置顶的自动取消（先进先出）
const PINNED_CAP: usize = 20;

/// 设置 / 取消置顶。置满再置顶时按置顶时间（近似 ts 序）挤出最早的一条。
pub fn set_pinned(app: &AppHandle, ts: i64, pinned: bool) -> Option<()> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut items = load(app);
    let item = items.iter_mut().find(|i| i.ts == ts)?;
    item.pinned = pinned;
    if pinned {
        evict_pinned_overflow(&mut items, ts);
    }
    write(app, &items);
    Some(())
}

/// 置顶数超过上限时取消最旧的置顶（items 按新→旧排列，最旧在尾部）。
/// 纯函数便于单测。
fn evict_pinned_overflow(items: &mut Vec<HistoryItem>, just_pinned: i64) {
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

/// 截断：非置顶子列截到 limit（保新弃旧），置顶条目不占名额、始终保留，
/// 结果整体按 ts 新→旧重排。纯函数便于单测。
fn truncate_with_pinned(items: Vec<HistoryItem>, limit: usize) -> Vec<HistoryItem> {
    if !items.iter().any(|i| i.pinned) {
        let mut items = items;
        items.truncate(limit);
        return items;
    }
    let pinned: Vec<HistoryItem> = items.iter().filter(|i| i.pinned).cloned().collect();
    let mut rest: Vec<HistoryItem> = items.into_iter().filter(|i| !i.pinned).collect();
    rest.truncate(limit);
    rest.extend(pinned);
    rest.sort_by(|a, b| b.ts.cmp(&a.ts));
    rest
}

fn path(app: &AppHandle) -> anyhow::Result<std::path::PathBuf> {
    Ok(app.path().app_config_dir()?.join("history.json"))
}

fn write(app: &AppHandle, items: &[HistoryItem]) {
    if let Ok(p) = path(app) {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(items) {
            let _ = crate::config::atomic_write(&p, json.as_bytes());
        }
    }
    let _ = app.emit("sn-history-changed", ());
}

pub fn load(app: &AppHandle) -> Vec<HistoryItem> {
    path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/** 追加一条历史记录。kind：dictation / translate / ocr */
pub fn push(
    app: &AppHandle,
    raw: &str,
    final_text: &str,
    asr_ms: u64,
    llm_ms: u64,
    kind: &str,
) {
    // 毫秒时间戳：秒级粒度下同一秒的两条记录共享 ts（key 冲突 / 删除连带）。
    // 旧数据仍是秒级，前端展示按数量级自适应（<1e12 视为秒）
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let limit = app
        .state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .map(|c| c.general.history_limit.max(1))
        .unwrap_or(MAX_ITEMS);
    let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut items = load(app);
    items.insert(
        0,
        HistoryItem {
            ts,
            raw: raw.into(),
            final_text: final_text.into(),
            asr_ms: if asr_ms > 0 { Some(asr_ms) } else { None },
            llm_ms: if llm_ms > 0 { Some(llm_ms) } else { None },
            kind: Some(kind.to_string()),
            pinned: false,
        },
    );
    // 截断：置顶条目不占保留名额（新条目本身尚未置顶，天然参与截断）
    items = truncate_with_pinned(items, limit);
    write(app, &items);
    // 同一把 STORE_LOCK 内顺带累计全量统计（累计口径见 Stats）；
    // stats 写失败只记日志，不影响历史主流程
    let mut s = load_stats_locked(app);
    s.total += 1;
    s.chars += final_text.chars().count() as u64;
    *s.days.entry(day_key(ts)).or_insert(0) += 1;
    trim_days(&mut s.days, STATS_DAYS_KEEP);
    write_stats(app, &s);
}

pub fn find_raw(app: &AppHandle, ts: i64) -> Option<String> {
    load(app)
        .into_iter()
        .find(|i| i.ts == ts)
        .map(|i| i.raw)
}

/// 重新优化后更新某条记录的结果
pub fn update_final(app: &AppHandle, ts: i64, text: &str) -> Option<()> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut items = load(app);
    let item = items.iter_mut().find(|i| i.ts == ts)?;
    item.final_text = text.to_string();
    write(app, &items);
    Some(())
}

pub fn delete(app: &AppHandle, ts: i64) {
    let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut items = load(app);
    items.retain(|i| i.ts != ts);
    write(app, &items);
}

pub fn clear(app: &AppHandle) {
    let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Ok(p) = path(app) {
        let _ = fs::remove_file(p);
    }
    let _ = app.emit("sn-history-changed", ());
}

/* ---------- 全量使用统计（stats.json，与 history.json 同目录） ---------- */

/// days 只保留最近 60 个本地日期（YYYY-MM-DD 字典序 = 时间序）
const STATS_DAYS_KEEP: usize = 60;

/// 全量使用统计：与 history.json 的保留窗口解耦——「累计使用 / 累计输入 /
/// 今日 / 较昨日 / 近 7 天」超窗后仍准确（旧版从 ≤保留条数的窗口推算会失真）。
/// 累计口径为「使用过就计入」：删除 / 清空历史不回退计数。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Stats {
    #[serde(default)]
    pub total: u64,
    #[serde(default)]
    pub chars: u64,
    /// 键为本地日期 YYYY-MM-DD
    #[serde(default)]
    pub days: BTreeMap<String, u64>,
}

/// get_stats 命令的返回形态：days 展平为按日期升序的 [日期, 条数] 数组
#[derive(Debug, Clone, Serialize)]
pub struct StatsView {
    pub total: u64,
    pub chars: u64,
    pub days: Vec<(String, u64)>,
}

impl From<Stats> for StatsView {
    fn from(s: Stats) -> Self {
        // BTreeMap 迭代天然按键（= 日期）升序
        StatsView {
            total: s.total,
            chars: s.chars,
            days: s.days.into_iter().collect(),
        }
    }
}

fn stats_path(app: &AppHandle) -> anyhow::Result<std::path::PathBuf> {
    Ok(app.path().app_config_dir()?.join("stats.json"))
}

fn write_stats(app: &AppHandle, s: &Stats) {
    if let Ok(p) = stats_path(app) {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(s) {
            // 统计写失败不影响主流程：下一次累计以旧值继续，仅记日志
            if let Err(e) = crate::config::atomic_write(&p, json.as_bytes()) {
                eprintln!("[speaknow] stats.json 写入失败: {e}");
            }
        }
    }
}

/// 历史时间戳旧秒新毫秒（与前端 `ts < 1e12` 判定一致），统一折算毫秒
fn ts_ms(ts: i64) -> i64 {
    if ts < 1_000_000_000_000 {
        ts * 1000
    } else {
        ts
    }
}

/// 天数（1970-01-01 起）→ 公历年月日（Howard Hinnant civil_from_days，纯数学、无时区依赖）
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y } as i32, m as u32, d as u32)
}

/// unix 毫秒 → 本地「视作 UTC」的毫秒（供纯数学日历分解出本地日期）。
/// Windows：经 FileTimeToLocalFileTime 换算时区偏移（含夏令时），复用已启用的
/// Win32_Storage_FileSystem / Win32_Foundation feature，无需新增依赖；
/// 其余平台暂按 UTC（本项目主力平台为 Windows，OCR 等特性同为 Windows 专属）。
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

/// unix 毫秒 → 本地日期 YYYY-MM-DD
fn day_key(unix_ms: i64) -> String {
    let (y, m, d) = civil_from_days(local_unix_ms(unix_ms).div_euclid(86_400_000));
    format!("{y:04}-{m:02}-{d:02}")
}

/// days 超出保留数时裁掉最旧日期（键字典序 = 时间序）
fn trim_days(days: &mut BTreeMap<String, u64>, keep: usize) {
    while days.len() > keep {
        match days.keys().next().cloned() {
            Some(oldest) => {
                days.remove(&oldest);
            }
            None => break,
        }
    }
}

/// 从现有历史播种统计（stats.json 首次落盘前的口径迁移）：
/// total=条数、chars=Σ终稿码点数（.chars().count()，与前端 [...str].length 口径一致）、
/// days=按本地日分组。播种值 = 旧版前端从保留窗口推算的值，老用户看到的数字不回退。
fn seed_stats(items: &[HistoryItem]) -> Stats {
    let mut s = Stats::default();
    for i in items {
        s.total += 1;
        s.chars += i.final_text.chars().count() as u64;
        *s.days.entry(day_key(ts_ms(i.ts))).or_insert(0) += 1;
    }
    trim_days(&mut s.days, STATS_DAYS_KEEP);
    s
}

/// 读 stats.json；不存在 / 损坏时从历史一次性播种并落盘（调用方须持 STORE_LOCK）
fn load_stats_locked(app: &AppHandle) -> Stats {
    if let Ok(p) = stats_path(app) {
        if let Ok(text) = fs::read_to_string(&p) {
            if let Ok(s) = serde_json::from_str::<Stats>(&text) {
                return s;
            }
        }
    }
    let s = seed_stats(&load(app));
    write_stats(app, &s);
    s
}

/// 全量使用统计（get_stats 命令入口）：首次访问时按需播种
pub fn stats(app: &AppHandle) -> Stats {
    let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    load_stats_locked(app)
}

/// 批量删除（多选）：锁内一次 load→retain→write（write 会广播 sn-history-changed），
/// 返回实际删除条数。统计为累计口径，不随删除回退——与「清空」语义一致。
pub fn delete_batch(app: &AppHandle, ts: &[i64]) -> usize {
    let set: HashSet<i64> = ts.iter().copied().collect();
    let _guard = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut items = load(app);
    let before = items.len();
    items.retain(|i| !set.contains(&i.ts));
    let removed = before - items.len();
    if removed > 0 {
        write(app, &items);
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(10_957), (2000, 1, 1));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29)); // 世纪闰日
        assert_eq!(civil_from_days(20_729), (2026, 10, 3));
        // 负值（1970 前）也正确
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }

    #[test]
    fn day_key_is_padded_iso_date() {
        let k = day_key(0);
        // 本地时区在 [-12,+14] 内，1970-01-01 00:00 UTC 只会是 01-01 或 12-31/01-02
        assert!(k == "1970-01-01" || k == "1969-12-31" || k == "1970-01-02", "{k}");
        // 正午时刻的键格式固定为 10 位 YYYY-MM-DD
        let noon = day_key(1_791_427_600_000); // 2026-10-03 12:00 UTC 的毫秒
        assert!(noon.len() == 10 && noon.as_bytes()[4] == b'-', "{noon}");
    }

    #[test]
    fn ts_ms_normalizes_seconds_and_millis() {
        assert_eq!(ts_ms(129_600), 129_600_000); // 旧秒级
        assert_eq!(ts_ms(1_296_000_000_000), 1_296_000_000_000); // 新毫秒级
    }

    #[test]
    fn trim_days_keeps_newest() {
        let mut days: BTreeMap<String, u64> =
            (0..80).map(|i| (format!("d{i:03}"), i as u64)).collect();
        trim_days(&mut days, STATS_DAYS_KEEP);
        assert_eq!(days.len(), STATS_DAYS_KEEP);
        assert_eq!(days.keys().next().unwrap(), "d020"); // 最旧的 20 天被裁掉
        assert_eq!(days.get("d079"), Some(&79)); // 最新保留
        let mut one = BTreeMap::from([("2026-10-03".to_string(), 5u64)]);
        trim_days(&mut one, STATS_DAYS_KEEP);
        assert_eq!(one.len(), 1); // 不足保留数不裁
    }

    fn item(ts: i64, final_text: &str) -> HistoryItem {
        HistoryItem {
            ts,
            raw: final_text.into(),
            final_text: final_text.into(),
            asr_ms: None,
            llm_ms: None,
            kind: None,
            pinned: false,
        }
    }

    /// 相差 1ms 的两条必为同本地日；相隔整 24h 的两条必为不同本地日（任意固定
    /// 时区偏移下均成立），故分组断言对测试机时区不敏感。
    /// 基准取 2026-10-03 12:00 UTC（毫秒级 > 1e12，不会被秒级折算误伤）
    #[test]
    fn seed_counts_items_chars_and_days() {
        let day1_noon: i64 = 1_791_427_600_000;
        let items = vec![
            item(day1_noon, "你好"),             // 2 码点
            item(day1_noon + 1, "世界🎵"),       // 3 码点（emoji 按 1 计，与前端 [...s].length 一致）
            item(1_791_427_600, "旧秒级"),       // 旧秒级时间戳，折算后与 day1 同日
            item(day1_noon + 86_400_000, "ok"), // 次日同一时刻 → 不同本地日
        ];
        let s = seed_stats(&items);
        assert_eq!(s.total, 4);
        assert_eq!(s.chars, 2 + 3 + 3 + 2);
        assert_eq!(s.days.values().sum::<u64>(), 4);
        assert_eq!(s.days.len(), 2); // 前三条同日合并
        let counts: Vec<u64> = s.days.values().copied().collect();
        assert!(counts.contains(&3) && counts.contains(&1));
    }

    #[test]
    fn seed_trims_days_to_keep_limit() {
        // 80 天、每天正午一条（正午 ±14h 不跨本地日界，分组对时区不敏感）
        let items: Vec<HistoryItem> = (0..80)
            .map(|i| item(1_791_427_600_000 + i * 86_400_000, "x"))
            .collect();
        let s = seed_stats(&items);
        assert_eq!(s.total, 80);
        assert_eq!(s.days.len(), STATS_DAYS_KEEP); // 只留最近 60 天
        assert_eq!(s.days.values().sum::<u64>(), STATS_DAYS_KEEP as u64);
    }

    #[test]
    fn stats_view_days_are_ascending_pairs() {
        let mut s = Stats::default();
        for d in ["2026-10-03", "2026-09-30", "2026-10-01"] {
            s.days.insert(d.to_string(), 1);
        }
        let v: StatsView = s.into();
        assert_eq!(
            v.days,
            vec![
                ("2026-09-30".to_string(), 1),
                ("2026-10-01".to_string(), 1),
                ("2026-10-03".to_string(), 1),
            ]
        );
    }

    #[test]
    fn truncate_keeps_pinned_beyond_limit() {
        // 新→旧：ts 5(置顶),4,3(置顶),2,1,0；limit=3 → 非置顶 [4,2,1,0] 截到 3 保 [4,2,1]
        // （置顶 3 不占名额），置顶 5,3 全保留，结果按 ts 降序 [5,4,3,2,1]，ts0 被截掉
        let mut items = vec![
            item(5, "f"),
            item(4, "e"),
            item(3, "d"),
            item(2, "c"),
            item(1, "b"),
            item(0, "a"),
        ];
        items[0].pinned = true;
        items[2].pinned = true;
        let out = truncate_with_pinned(items, 3);
        let ts: Vec<i64> = out.iter().map(|i| i.ts).collect();
        assert_eq!(ts, vec![5, 4, 3, 2, 1]);
        assert_eq!(out.iter().filter(|i| i.pinned).count(), 2);
    }

    #[test]
    fn truncate_without_pinned_is_plain() {
        let items = vec![item(3, "c"), item(2, "b"), item(1, "a")];
        let out = truncate_with_pinned(items, 2);
        assert_eq!(out.iter().map(|i| i.ts).collect::<Vec<_>>(), vec![3, 2]);
    }

    #[test]
    fn pinned_fifo_eviction_at_cap() {
        // 真实序：新→旧。ts 100..=80 共 21 条；已置顶最旧 20 条（99..=80），
        // 再置顶最新的 ts=100 → 挤出最旧置顶 ts=80，总数回到 20
        let mut items: Vec<HistoryItem> = (80..=100i64)
            .rev()
            .map(|ts| {
                let mut it = item(ts, "x");
                it.pinned = ts <= 99; // 99..=80 已置顶；100 尚未
                it
            })
            .collect();
        // set_pinned 的调用序：先把目标置顶，再挤溢出
        items[0].pinned = true; // ts=100（新→旧首位）
        evict_pinned_overflow(&mut items, 100);
        let pinned_ts: Vec<i64> = items.iter().filter(|i| i.pinned).map(|i| i.ts).collect();
        assert!(!pinned_ts.contains(&80), "最旧置顶 ts=80 应被挤出: {pinned_ts:?}");
        assert!(pinned_ts.contains(&100));
        assert_eq!(pinned_ts.len(), PINNED_CAP);
        // 未达上限不挤出
        let mut few: Vec<HistoryItem> = (0..5i64).rev().map(|ts| item(ts, "x")).collect();
        for it in few.iter_mut() {
            it.pinned = true;
        }
        evict_pinned_overflow(&mut few, 4);
        assert_eq!(few.iter().filter(|i| i.pinned).count(), 5);
    }
}
