//! 转写后处理：清理语气词与幻觉填充（"嗯"、"呃"、"yeah"、"uh" 等）。
//! 口头犹豫音和呼吸声常被 ASR 转成填充词；确定性规则清理，零延迟、不依赖 LLM。

/// CJK 语气/犹豫音（保守集合：不含「啊/嘛/吧」等可能承担语气的字）
const CJK_FILLERS: &[char] = &['嗯', '唔', '呃', '哦', '噢', '喏', '噉'];
/// 拉丁填充词（整词匹配，忽略大小写）
const LATIN_FILLERS: &[&str] = &[
    "yeah", "yep", "yup", "uh", "um", "umm", "uhm", "uhh", "uhum", "erm", "hmm", "hm", "mmm", "mm",
    "huh",
];

fn is_cjk_filler(c: char) -> bool {
    CJK_FILLERS.contains(&c)
}

fn is_break(c: char) -> bool {
    c.is_whitespace() || "，、,；;。！!？?~～…·".contains(c)
}

/// 清理语气词：
/// - 拉丁填充词整词移除
/// - CJK：连续 ≥2 个语气字（如「嗯嗯」）整体移除；
///   单个语气字仅当处于句首/句尾/标点旁（引导或拖尾的犹豫音）时移除，
///   处在实词之间的保留（避免误伤「嗯这件事很奇怪」这类转述）
/// - 收尾清理：压缩连续逗号、去掉行首行尾的逗号与空白
pub fn strip_fillers(input: &str) -> String {
    if input.trim().is_empty() {
        return input.to_string();
    }

    // ---- 1) 拉丁填充词整词移除 ----
    let mut latin_cleaned = String::with_capacity(input.len());
    let mut word = String::new();
    let mut pending_break = String::new();
    for c in input.chars() {
        if c.is_ascii_alphabetic() {
            word.push(c);
        } else {
            if !word.is_empty() {
                let is_filler = LATIN_FILLERS.contains(&word.to_lowercase().as_str());
                if !is_filler {
                    latin_cleaned.push_str(&word);
                } else if !latin_cleaned.is_empty() && (c == '，' || c == ',') {
                    // 填充词后的逗号一并吞掉，避免留下「，」孤悬
                    word.clear();
                    continue;
                }
                word.clear();
            }
            latin_cleaned.push(c);
        }
    }
    let _ = pending_break;
    if !word.is_empty() && !LATIN_FILLERS.contains(&word.to_lowercase().as_str()) {
        latin_cleaned.push_str(&word);
    }

    // ---- 2) CJK 语气字处理 ----
    let chars: Vec<char> = latin_cleaned.chars().collect();
    let n = chars.len();
    let mut keep: Vec<bool> = vec![true; n];
    let mut i = 0;
    while i < n {
        if is_cjk_filler(chars[i]) {
            let mut j = i;
            while j < n && is_cjk_filler(chars[j]) {
                j += 1;
            }
            let run = j - i;
            if run >= 2 {
                for k in i..j {
                    keep[k] = false;
                }
            } else {
                // 单个语气字：仅句首/句尾/标点或空白邻接时移除
                let prev_break = i == 0 || is_break(chars[i - 1]);
                let next_break = j == n || is_break(chars[j]);
                if prev_break || next_break {
                    keep[i] = false;
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    let mut out: String = chars
        .iter()
        .enumerate()
        .filter(|(idx, _)| keep[*idx])
        .map(|(_, c)| *c)
        .collect();

    // ---- 3) 收尾清理 ----
    // 语气词移除后会留下「，。」「，！」等混合标点或孤悬逗号：
    // a. 连续标点（可夹空白）收敛为一个，句末级（。！？…）优先于逗号级（，、；）
    // b. 行首去掉全部标点（句子不该以标点开头）
    // c. 行尾去掉逗号级标点（话没说完的尾巴），保留句号级
    let weak = |c: char| matches!(c, '，' | ',' | '、' | '；' | ';');
    let strong = |c: char| matches!(c, '。' | '！' | '!' | '？' | '?' | '…' | '~' | '～');
    let mut collapsed = String::with_capacity(out.len());
    let mut run: Option<char> = None; // 本段连续标点应保留的代表
    let mut pending_ws = false; // 标点后暂存的空白（若标点串继续则吸收）
    for c in out.chars() {
        if weak(c) || strong(c) {
            run = Some(match run {
                None => c,
                // 强替换弱；强弱混合/同类保留先出现的终止符
                Some(prev) if strong(c) && !strong(prev) => c,
                Some(prev) => prev,
            });
            pending_ws = false; // 标点串内部的空白随收敛吸收
        } else if c.is_whitespace() && run.is_some() {
            pending_ws = true;
        } else {
            if let Some(p) = run.take() {
                collapsed.push(p);
            }
            // 标点后跟正文：保留原有空白（英文 "word. Next" 的空格不能丢）；
            // 只有标点串内部的空白才随收敛一起吸收
            if pending_ws {
                collapsed.push(' ');
            }
            pending_ws = false;
            collapsed.push(c);
        }
    }
    if let Some(p) = run {
        collapsed.push(p);
    }

    let trimmed = collapsed.trim();
    let mut out = String::with_capacity(trimmed.len());
    // 行首：跳过全部标点与空白
    let body = trimmed.trim_start_matches(|c| weak(c) || strong(c) || c.is_whitespace());
    // 行尾：去掉逗号级标点与空白，保留句号级
    let body = body.trim_end_matches(|c| weak(c) || c.is_whitespace());
    out.push_str(body);
    out
}

/* ================= 输出前标点规整（确定性，不依赖模型自觉） ================= */

/// CJK 表意字符（汉字；不含全角标点——标点与字母间的间距规则另算）
fn is_cjk_ideograph(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}' | '\u{F900}'..='\u{FAFF}')
}

/// 相邻至少一侧是汉字的半角标点 → 对应全角。
/// 中文字体下混排半角标点观感极差，ASR 与模型输出都常混出。
/// 句点不转：小数点、版本号、英文缩写的误伤风险远大于收益。
fn widen_adjacent_punct(s: &str) -> String {
    let map = |c: char| {
        Some(match c {
            ',' => '，',
            ';' => '；',
            ':' => '：',
            '?' => '？',
            '!' => '！',
            _ => return None,
        })
    };
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        let Some(full) = map(c) else {
            out.push(c);
            continue;
        };
        let near_cjk = (i > 0 && is_cjk_ideograph(chars[i - 1]))
            || (i + 1 < chars.len() && is_cjk_ideograph(chars[i + 1]));
        out.push(if near_cjk { full } else { c });
    }
    out
}

/// 汉字与 ASCII 字母数字之间补一个空格（「盘古之白」）。
/// 已有空格或标点的边界不会重复添加；纯英文文本零改动。
fn space_cjk_ascii(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    let mut last: Option<char> = None;
    for c in s.chars() {
        if let Some(l) = last {
            if (is_cjk_ideograph(l) && c.is_ascii_alphanumeric())
                || (l.is_ascii_alphanumeric() && is_cjk_ideograph(c))
            {
                out.push(' ');
            }
        }
        out.push(c);
        last = Some(c);
    }
    out
}

/// 最终输出前的确定性标点规整：不增删改任何文字，只做格式收敛。
/// 对 LLM 输出与快速模式原文一视同仁——这类格式问题不该依赖模型自觉。
pub fn tidy_punct(s: &str) -> String {
    if s.trim().is_empty() {
        return s.to_string();
    }
    space_cjk_ascii(&widen_adjacent_punct(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_common_fillers() {
        assert_eq!(strip_fillers("嗯嗯，今天开会"), "今天开会");
        assert_eq!(strip_fillers("嗯，好的"), "好的");
        assert_eq!(strip_fillers("好的，嗯"), "好的");
        assert_eq!(strip_fillers("yeah 嗯 嗯 我们开始"), "我们开始");
        assert_eq!(strip_fillers("我们，嗯，去吃饭"), "我们，去吃饭");
        assert_eq!(strip_fillers("嗯"), "");
        assert_eq!(strip_fillers("yes"), "yes");
    }

    #[test]
    fn keeps_meaningful_text() {
        assert_eq!(strip_fillers("是的。"), "是的。");
        assert_eq!(
            strip_fillers("这个方案嗯我觉得可行"),
            "这个方案嗯我觉得可行"
        ); // 句中单个保留
        assert_eq!(strip_fillers("OK 那就这么定了"), "OK 那就这么定了");
    }

    #[test]
    fn cleans_leftover_punctuation() {
        // 语气词移除后遗留的混合标点与句首句尾孤悬标点
        assert_eq!(strip_fillers("今天，嗯。我们去吃饭"), "今天。我们去吃饭");
        assert_eq!(strip_fillers("嗯。好的"), "好的");
        assert_eq!(strip_fillers("好的，嗯。"), "好的。");
        assert_eq!(strip_fillers("开始，嗯！行动"), "开始！行动");
        assert_eq!(strip_fillers("我们， 嗯，去吃饭"), "我们，去吃饭");
        // 正常文本的标点与空格不受影响
        assert_eq!(strip_fillers("yes. Next step"), "yes. Next step");
        assert_eq!(strip_fillers("第一点。第二点。"), "第一点。第二点。");
    }

    /* ---- 输出前标点规整 ---- */

    #[test]
    fn tidy_widens_halfwidth_punct_next_to_cjk() {
        // 紧邻汉字的半角标点 → 全角
        assert_eq!(tidy_punct("你好,世界:开始"), "你好，世界：开始");
        assert_eq!(tidy_punct("真的?太好了!"), "真的？太好了！");
        // 纯英文/数字上下文不动：时间、URL、代码
        assert_eq!(tidy_punct("meet at 10:30"), "meet at 10:30");
        assert_eq!(tidy_punct("see https://a.com"), "see https://a.com");
        // 句点永不转换（小数点、版本号）
        assert_eq!(tidy_punct("版本4.6"), "版本 4.6");
    }

    #[test]
    fn tidy_spaces_between_cjk_and_ascii() {
        assert_eq!(tidy_punct("用React和vite搭项目"), "用 React 和 vite 搭项目");
        assert_eq!(tidy_punct("等3秒重试"), "等 3 秒重试");
        // 已有空格不重复
        assert_eq!(tidy_punct("用 React 写的"), "用 React 写的");
        // 纯英文零改动
        assert_eq!(tidy_punct("hello, world 42"), "hello, world 42");
        // 全角标点两侧不强制加空格（中文排版惯例）
        assert_eq!(tidy_punct("你好，world"), "你好，world");
    }

    #[test]
    fn tidy_keeps_content_intact() {
        // 只动格式，不动任何文字
        let s = "登录接口报错,err code是500,修一下";
        assert_eq!(tidy_punct(s), "登录接口报错，err code 是 500，修一下");
        // 空文本原样返回
        assert_eq!(tidy_punct("  "), "  ");
    }
}
