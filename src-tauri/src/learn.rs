//! 词典自动学习（修正即沉淀）：预览编辑模式下用户反复把 LLM 输出的同一
//! 片段改成同一写法，说明模型不知道这个词——同一改法累计两次即把新写法
//! 追加进 AI 优化术语表（llm.glossary），后续听写的提示词就会点名纠正。
//! 竞品 Wispr Flow 把「自动学新词」当独占卖点；SpeakNow 的 confirm_edit
//! 修正钩子天然握有「LLM 输出 vs 用户终稿」对照，最有条件做差异化。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use tauri::{AppHandle, Emitter, Manager};

/// 同一改法累计达到该次数才学习：一次修正可能只是口误或随手润色，
/// 两次相同替换才视为稳定的术语改法（对齐竞品「改两次即学会」的体感）
const LEARN_THRESHOLD: u32 = 2;

/// 新写法的长度窗（字符数）：超长中段多半是整句重写而非术语修正
const MAX_WORD_CHARS: usize = 15;

/// 各候选改法的进程内计数（key = 用户改后的写法）。
/// 只存内存、重启清零是有意的 MVP 取舍：多数连续修正发生在同一会话内，
/// 持久化半成品计数反而会把「很久之前改过一次」误判成稳定改法
static COUNTS: LazyLock<Mutex<HashMap<String, u32>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 裁掉公共前缀/后缀，返回（旧中段, 新中段）。两侧中段都非空才算一次
/// 「替换」——纯插入/纯删除没有可比对的误识原文，学不进术语表；两串全等
/// 或中段相同返回 None。前缀取满后后缀不再与之重叠，保证中段最小（否则
/// "aa"/"a" 这类前缀吃掉后缀，中段就不是「被改的那一段」了）。
pub fn diff_replacement(a: &str, b: &str) -> Option<(String, String)> {
    if a == b {
        return None;
    }
    let ac: Vec<char> = a.chars().collect();
    let bc: Vec<char> = b.chars().collect();
    let mut p = 0;
    while p < ac.len() && p < bc.len() && ac[p] == bc[p] {
        p += 1;
    }
    let mut s = 0;
    while s < ac.len() - p && s < bc.len() - p && ac[ac.len() - 1 - s] == bc[bc.len() - 1 - s] {
        s += 1;
    }
    let old_mid: String = ac[p..ac.len() - s].iter().collect();
    let new_mid: String = bc[p..bc.len() - s].iter().collect();
    if old_mid.is_empty() || new_mid.is_empty() {
        return None;
    }
    Some((old_mid, new_mid))
}

/// 是否为不值得学的「琐碎」片段：全部由数字/标点/空白组成（改个标点、删个
/// 空格之类与术语无关）。全角标点不是 ASCII，须单独点名——否则「，→。」
/// 这类纯中文标点替换会被当成可学新词
fn is_trivial(s: &str) -> bool {
    s.chars().all(|c| {
        c.is_ascii_digit() || c.is_ascii_punctuation() || c.is_whitespace() || is_cjk_punct(c)
    })
}

/// 常用中日韩标点（ASCII 判定覆盖不到的那部分）
fn is_cjk_punct(c: char) -> bool {
    matches!(
        c,
        '，' | '。' | '！' | '？' | '；' | '：' | '、' | '（' | '）' | '《' | '》' | '【'
            | '】' | '“' | '”' | '‘' | '’' | '…' | '—' | '·'
    )
}

/// 术语表是否已收录该词：按行 trim 后取「=」左侧 canonical 部分精确比对
/// （与 llm::parse_glossary 同一口径）；别名不参与判断——别名是「误识形式」，
/// 用户若坚持把规范写法改回误识形式，理应学成新的 canonical
fn glossary_contains(glossary: &str, word: &str) -> bool {
    glossary.lines().any(|line| {
        let canonical = line.split_once('=').map_or(line.trim(), |(c, _)| c.trim());
        canonical == word
    })
}

/// 学习判定（纯函数，便于单测）：计数达标且术语表尚未收录
fn should_learn(counts_hit: bool, glossary: &str, word: &str) -> bool {
    counts_hit && !glossary_contains(glossary, word)
}

/// 入口：confirm_edit 在确认用户终稿后调用（llm_out = LLM 输出，user_final
/// = 用户编辑后的终稿）。本函数只做 O(n) diff + 计数 + 一次配置快照读，
/// 落盘与事件广播全部转后台线程，绝不阻塞输入确认路径。
pub fn learn(app: &AppHandle, llm_out: &str, user_final: &str) {
    let Some((_old_mid, new_mid)) = diff_replacement(llm_out, user_final) else {
        return;
    };
    // 术语表按行 trim 解析（llm::parse_glossary），学词先去首尾空白：
    // 否则 " Rust " 会成为计数键，且与已收录的 "Rust" 比对不上导致重复学习
    let new_mid = new_mid.trim().to_string();
    if !(1..=MAX_WORD_CHARS).contains(&new_mid.chars().count()) || is_trivial(&new_mid) {
        return;
    }
    let count = {
        let mut m = COUNTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let e = m.entry(new_mid.clone()).or_insert(0);
        *e += 1;
        *e
    };
    // glossary 现值只作判定快照；真正落盘时后台线程会重新取现值
    let glossary = app
        .state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .map(|c| c.llm.glossary.clone())
        .unwrap_or_default();
    if !should_learn(count >= LEARN_THRESHOLD, &glossary, &new_mid) {
        return;
    }
    let app = app.clone();
    let word = new_mid;
    std::thread::spawn(move || {
        // 与 mem_gen_token 同款三步（吸取历史竞态教训）：锁内取现值 clone →
        // 只改 glossary 字段落盘 → 重新锁 Ctx 按字段回写。绝不整体覆盖，
        // 否则会抹掉期间并发 save_config 写入的其他改动
        let mut cfg = app
            .state::<crate::Ctx>()
            .config
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .unwrap_or_default();
        // 并发兜底：判定快照之后、本线程落盘之前，可能有同词学习线程已写入
        // （如用户在设置页手动删过又触发），重查一次避免重复行
        if glossary_contains(&cfg.llm.glossary, &word) {
            return;
        }
        if !cfg.llm.glossary.is_empty() {
            cfg.llm.glossary.push('\n');
        }
        cfg.llm.glossary.push_str(&word);
        if let Err(e) = crate::config::save(&app, &cfg) {
            eprintln!("[speaknow] 词典学习落盘失败 {e:#}");
            return;
        }
        {
            let state = app.state::<crate::Ctx>();
            let mut guard = state
                .config
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let c = guard.get_or_insert_with(crate::config::Config::default);
            c.llm.glossary = cfg.llm.glossary.clone();
        }
        // 广播配置变更让设置窗拉回最新 glossary：否则前端内存里的旧术语表
        // 会在下一次自动保存时把刚学的词静默写丢（后端直改配置须广播
        // sn-config-changed 是既有约定，见 mem_gen_token）
        let _ = app.emit("sn-config-changed", ());
        let _ = app.emit("sn-dict-learned", serde_json::json!({ "word": word }));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_中段替换被提取() {
        assert_eq!(
            diff_replacement("用拉斯特写个脚本", "用 Rust 写个脚本"),
            Some(("拉斯特".to_string(), " Rust ".to_string()))
        );
        assert_eq!(
            diff_replacement("打开鸡皮提", "打开 ChatGPT"),
            Some(("鸡皮提".to_string(), " ChatGPT".to_string()))
        );
        // 整串不同也是合法替换（前缀 = 后缀 = 0）
        assert_eq!(diff_replacement("甲", "乙"), Some(("甲".to_string(), "乙".to_string())));
    }

    #[test]
    fn diff_纯插入纯删除与全等返回_none() {
        assert_eq!(diff_replacement("你好世界", "你好"), None); // 纯删除
        assert_eq!(diff_replacement("你好", "你好，世界"), None); // 纯插入
        assert_eq!(diff_replacement("完全一样", "完全一样"), None); // 全等
        // 前缀吃满后后缀不重叠："aa" vs "a" 的差异是删除而非替换
        assert_eq!(diff_replacement("aa", "a"), None);
        assert_eq!(diff_replacement("aba", "ab"), None);
    }

    #[test]
    fn diff_前后缀夹住的插入删除返回_none() {
        // 前后缀都在、但一侧中段为空：是插入/删除不是替换，学不进术语表
        assert_eq!(diff_replacement("柯里化是", "柯里化 curry 是"), None);
        assert_eq!(diff_replacement("柯里化 curry 是", "柯里化是"), None);
    }

    #[test]
    fn diff_中文按字符而非字节() {
        // 多字节字符按 char 比对才能得到完整词（字节级裁剪会把汉字切碎）
        assert_eq!(
            diff_replacement("用库伯内特斯部署", "用 Kubernetes 部署"),
            Some(("库伯内特斯".to_string(), " Kubernetes ".to_string()))
        );
    }

    #[test]
    fn trivial_判定() {
        assert!(is_trivial("123"));
        assert!(is_trivial(" ,.!;-"));
        assert!(is_trivial("  \t\n"));
        assert!(is_trivial("，。！？")); // 全角标点同样是琐碎片段
        assert!(is_trivial("")); // 空（trim 后为空）视为琐碎，不学
        assert!(!is_trivial("Rust"));
        assert!(!is_trivial("K8s"));
        assert!(!is_trivial("，a")); // 混入任一非琐碎字符即不琐碎
    }

    #[test]
    fn should_learn_计数与收录判定() {
        // 计数达标 + 未收录 → 学
        assert!(should_learn(true, "", "Rust"));
        assert!(should_learn(true, "Go\nK8s=库伯内特斯", "Rust"));
        // 计数未达标 → 不学
        assert!(!should_learn(false, "", "Rust"));
        // canonical 精确命中（含「=别名」行与首尾空白）→ 不学
        assert!(!should_learn(true, "Rust=拉斯特|拉斯", "Rust"));
        assert!(!should_learn(true, "  Rust  = 拉斯特 ", "Rust"));
        assert!(!should_learn(true, "Go", "Go"));
        // 别名不算收录：用户坚持的写法学成新 canonical
        assert!(should_learn(true, "Rust=拉斯特", "拉斯特"));
        // 大小写敏感的精确比对：rust 与 Rust 是两个词
        assert!(should_learn(true, "Rust", "rust"));
    }
}
