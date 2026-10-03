//! 结构化文本翻译：JSON / YAML / properties·env·toml 风格键值文件只翻译
//! 字符串「值」——键名、注释、缩进、整体格式逐字节保留。
//! 做法：扫描原文定位每个值的位置，把值抽成 ⟦N⟧ 占位标记的模板 + 唯一值列表，
//! 翻译后原位回填（不做 解析→再序列化，格式零漂移、键序零变化）。
//! 占位符（{name} / %s / {{var}} / $var / HTML 标签）在送翻前用 ⟪n⟫ 掩码保护。

/// 识别出的结构类型
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Json,
    Yaml,
    KeyValue,
}

impl Kind {
    pub fn label(&self) -> &'static str {
        match self {
            Kind::Json => "JSON",
            Kind::Yaml => "YAML",
            Kind::KeyValue => "键值",
        }
    }
}

pub struct Split {
    pub kind: Kind,
    /// 原文中各值替换为 ⟦N⟧ 标记后的模板（其余字节与原文一致）
    pub template: String,
    /// 唯一待译值（按首次出现顺序；模板中的 ⟦N⟧ 对应 values[N]）
    pub values: Vec<String>,
    /// values[i] 原文是否带引号（YAML/键值回填时保持加引号，防译文改变结构）
    pub quoted: Vec<bool>,
}

/// 自动识别并拆分。None = 不是（或不宜按）结构化文本处理。
/// 门槛设计得保守：宁可漏判走普通翻译（结果一样可读），不可误判把散文当文件拆。
pub fn split(text: &str) -> Option<Split> {
    let t = text.trim();
    if t.len() < 2 || t.len() > 500_000 {
        return None;
    }
    if (t.starts_with('{') || t.starts_with('['))
        && serde_json::from_str::<serde_json::Value>(t).is_ok()
    {
        return split_json(text);
    }
    split_yaml_like(text)
}

/// 原位回填：把译文按 ⟦N⟧ 标记塞回模板（JSON 值做标准转义，YAML/键值按需加引号）
pub fn merge(sp: &Split, translations: &[String]) -> String {
    let mut out = String::with_capacity(sp.template.len());
    let mut rest = sp.template.as_str();
    while let Some(pos) = rest.find('⟦') {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + '⟦'.len_utf8()..];
        let Some(end) = after.find('⟧') else {
            out.push('⟦');
            rest = after;
            continue;
        };
        let idx: usize = after[..end].trim().parse().unwrap_or(usize::MAX);
        match translations.get(idx) {
            Some(tr) => {
                out.push_str(&render_value(sp.kind, sp.quoted.get(idx).copied().unwrap_or(false), tr))
            }
            // 缺译文保底：按原文引号风格回填，保证结构仍可解析
            None => out.push_str(&render_value(
                sp.kind,
                sp.quoted.get(idx).copied().unwrap_or(false),
                sp.values.get(idx).map(String::as_str).unwrap_or(""),
            )),
        }
        rest = &after[end + '⟧'.len_utf8()..];
    }
    out.push_str(rest);
    out
}

/// 值的回填渲染：JSON 走标准转义；YAML/键值在原文带引号或译文可能改变结构时加双引号
fn render_value(kind: Kind, was_quoted: bool, tr: &str) -> String {
    match kind {
        Kind::Json => serde_json::to_string(tr)
            .unwrap_or_else(|_| String::from("\"\"")),
        Kind::Yaml | Kind::KeyValue => {
            if was_quoted || yaml_needs_quotes(tr) {
                serde_json::to_string(tr).unwrap_or_else(|_| String::from("\"\""))
            } else {
                tr.to_string()
            }
        }
    }
}

/// 译文以这些形态出现时必须加引号，否则会改变 YAML/键值结构
fn yaml_needs_quotes(s: &str) -> bool {
    if s.is_empty() || s.trim() != s {
        return true;
    }
    if s.contains('\n') || s.contains('\t') {
        return true;
    }
    // 数字/布尔/空：不加引号会改变值类型
    let low = s.to_ascii_lowercase();
    if matches!(
        low.as_str(),
        "true" | "false" | "null" | "nil" | "yes" | "no" | "on" | "off" | "~"
    ) {
        return true;
    }
    if s.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+'))
        && s.chars().any(|c| c.is_ascii_digit())
    {
        return true;
    }
    // 结构敏感字符
    s.chars().any(|c| {
        matches!(
            c,
            ':' | '#' | '{' | '}' | '[' | ']' | ',' | '&' | '*' | '!' | '|' | '>' | '\'' | '"'
                | '%' | '@' | '`' | '=' | '?'
        )
    }) || s.starts_with('-')
}

/* ---------- JSON：字符串字面量定位（键跳过、值替换） ---------- */

fn split_json(text: &str) -> Option<Split> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut template = String::with_capacity(text.len());
    let mut values: Vec<String> = Vec::new();
    let mut quoted: Vec<bool> = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let (_, ch) = chars[i];
        if ch != '"' {
            template.push(ch);
            i += 1;
            continue;
        }
        // 扫描整个字符串字面量（含转义对）
        let lit_start = i;
        let mut j = i + 1;
        while j < chars.len() {
            let c = chars[j].1;
            if c == '\\' && j + 1 < chars.len() {
                j += 2;
                continue;
            }
            if c == '"' {
                break;
            }
            j += 1;
        }
        if j >= chars.len() {
            return None; // 未闭合
        }
        let lit = &text[chars[lit_start].0..chars[j].0 + chars[j].1.len_utf8()];
        // 分类：闭引号后下一个非空白字符是 ':' → 键，原样保留
        let mut k = j + 1;
        while k < chars.len() && chars[k].1.is_whitespace() {
            k += 1;
        }
        let is_key = k < chars.len() && chars[k].1 == ':';
        if !is_key {
            if let Ok(v) = serde_json::from_str::<String>(lit) {
                if translatable(&v) {
                    match values.iter().position(|x| x == &v) {
                        Some(i) => template.push_str(&format!("⟦{i}⟧")),
                        None => {
                            template.push_str(&format!("⟦{}⟧", values.len()));
                            values.push(v);
                            quoted.push(true);
                        }
                    }
                    i = j + 1;
                    continue;
                }
            }
        }
        template.push_str(lit);
        i = j + 1;
    }
    Some(Split { kind: Kind::Json, template, values, quoted })
}

/* ---------- YAML / 键值：逐行定位「值」跨度 ---------- */

/// 一行拆解出的可替换单元
struct ValueSlot {
    line_no: usize,
    value_raw: String,
    quoted: bool,
    /// 值在行内的起始字节（替换从这里开始）
    start: usize,
    /// 值（含其后的行尾注释前空白）在行内的结束字节
    end: usize,
}

fn split_yaml_like(text: &str) -> Option<Split> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut slots: Vec<ValueSlot> = Vec::new();
    let mut structural = 0usize;
    let mut content_lines = 0usize;
    let mut eq_lines = 0usize;
    // 块标量区域（| 与 > 折叠）：块内容是任意的纯文本，行内出现「键: 值」
    // 会被上面的映射识别误抓（回填还可能加引号污染内容）——整段跳过不译，
    // 也不计入结构/内容行，直到缩进回到父键层级
    let mut block_indent: Option<usize> = None;

    for (n, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        if let Some(parent) = block_indent {
            if trimmed.is_empty() || indent > parent {
                continue; // 块内容行：原样保留
            }
            block_indent = None; // 缩进回到父层级：块结束，本行正常处理
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed == "---" || trimmed == "..." {
            structural += 1;
            continue;
        }
        content_lines += 1;
        // 内容部分：剥掉列表前缀「- 」再找映射分隔符
        let after_dash = trimmed.strip_prefix("- ").unwrap_or(trimmed);
        let dash_len = trimmed.len() - after_dash.len();

        if let Some(sep_at) = find_yaml_mapping_sep(after_dash) {
            structural += 1;
            let after_sep = indent + dash_len + sep_at + 1;
            let vstart = value_start(line, after_sep);
            let vfirst = line[vstart.min(line.len())..].chars().next();
            if vfirst == Some('|') || vfirst == Some('>') {
                // 块标量头：后续更深缩进的行属于块内容
                block_indent = Some(indent);
                continue;
            }
            if let Some(slot) = yaml_value_slot(n, line, vstart) {
                slots.push(slot);
            }
        } else if dash_len > 0 {
            // 纯列表项：- 值
            structural += 1;
            if let Some(slot) = yaml_value_slot(n, line, value_start(line, indent + dash_len)) {
                slots.push(slot);
            }
        } else if let Some(eq_at) = find_eq_sep(trimmed) {
            structural += 1;
            eq_lines += 1;
            if let Some(slot) = yaml_value_slot(n, line, value_start(line, indent + eq_at + 1)) {
                slots.push(slot);
            }
        }
    }

    // 识别门槛：≥3 个结构行且占内容行 70% 以上（散文偶带冒号不会误判）
    if structural < 3 || structural * 10 < content_lines * 7 {
        return None;
    }
    let kind = if eq_lines * 2 > structural {
        Kind::KeyValue
    } else {
        Kind::Yaml
    };

    // 组装模板：值去重后替换为 ⟦N⟧（引号风格取「任一出现带引号」）
    let mut values: Vec<String> = Vec::new();
    let mut quoted: Vec<bool> = Vec::new();
    let mut idx_map: Vec<usize> = Vec::new();
    for s in &slots {
        match values.iter().position(|x| x == &s.value_raw) {
            Some(i) => {
                idx_map.push(i);
                if s.quoted {
                    quoted[i] = true;
                }
            }
            None => {
                idx_map.push(values.len());
                values.push(s.value_raw.clone());
                quoted.push(s.quoted);
            }
        }
    }
    let mut template = String::with_capacity(text.len());
    for (n, line) in lines.iter().enumerate() {
        if n > 0 {
            template.push('\n');
        }
        match slots.iter().position(|s| s.line_no == n) {
            Some(si) => {
                let s = &slots[si];
                template.push_str(&line[..s.start]);
                template.push_str(&format!("⟦{}⟧", idx_map[si]));
                template.push_str(&line[s.end.min(line.len())..]);
            }
            None => template.push_str(line),
        }
    }
    Some(Split { kind, template, values, quoted })
}

/// 值实际起始：跳过分隔符后的空白
fn value_start(line: &str, after_sep: usize) -> usize {
    let rest = &line[after_sep.min(line.len())..];
    let ws = rest.len() - rest.trim_start().len();
    after_sep + ws
}

/// 行内值槽：解析引号风格与行尾注释，返回可译槽（不可译返回 None）
fn yaml_value_slot(line_no: usize, line: &str, vstart: usize) -> Option<ValueSlot> {
    let vstart = vstart.min(line.len());
    let rest = &line[vstart..];
    if rest.is_empty() {
        return None; // 嵌套块（值在子行）
    }
    let first = rest.chars().next().unwrap();
    // 块标量 / 锚点 / 标签：v1 不译（其缩进块按普通行原样保留）
    if matches!(first, '|' | '>' | '&' | '*' | '!') {
        return None;
    }
    let (value_raw, quoted, end) = if first == '"' {
        // 双引号：到未转义的闭引号
        let chars: Vec<(usize, char)> = rest.char_indices().collect();
        let mut j = 1;
        while j < chars.len() {
            let c = chars[j].1;
            if c == '\\' && j + 1 < chars.len() {
                j += 2;
                continue;
            }
            if c == '"' {
                break;
            }
            j += 1;
        }
        if j >= chars.len() {
            return None; // 未闭合
        }
        let lit = &rest[..chars[j].0 + 1];
        let inner = format!("\"{}\"", &lit[1..lit.len() - 1]);
        let v = serde_json::from_str::<String>(&inner).ok()?;
        (v, true, chars[j].0 + 1)
    } else if first == '\'' {
        // 单引号：'' 转义
        let mut end = None;
        let mut it = rest.char_indices().peekable();
        it.next();
        while let Some((off, c)) = it.next() {
            if c == '\'' {
                if let Some(&(_, '\'')) = it.peek() {
                    it.next();
                    continue;
                }
                end = Some(off + 1);
                break;
            }
        }
        let e = end?;
        let inner = &rest[1..e - 1];
        (inner.replace("''", "'"), true, e)
    } else {
        // 裸标量：到行尾注释「 #」为止（注释前的空白留在原文侧，回填后间距不变）
        let hash_off = find_plain_hash(rest);
        let value_end = rest[..hash_off].trim_end().len();
        (rest[..value_end].to_string(), false, value_end)
    };
    if !translatable(&value_raw) {
        return None;
    }
    Some(ValueSlot { line_no, value_raw, quoted, start: vstart, end: vstart + end })
}

/// 裸标量后行尾注释「 #」的位置（无注释则行尾）
fn find_plain_hash(rest: &str) -> usize {
    let chars: Vec<(usize, char)> = rest.char_indices().collect();
    let mut in_s = false;
    let mut in_d = false;
    for i in 0..chars.len() {
        let (off, c) = chars[i];
        match c {
            '\'' if !in_d => in_s = !in_s,
            '"' if !in_s => in_d = !in_d,
            // 行首 # 是注释（不会到这里）；「 #」是行尾注释
            '#' if !in_s && !in_d && (i == 0 || chars[i - 1].1 == ' ' || chars[i - 1].1 == '\t') => {
                return off;
            }
            _ => {}
        }
    }
    rest.len()
}

/// 找 YAML 映射分隔符（冒号后跟空格或行尾，引号外），返回冒号位置
fn find_yaml_mapping_sep(s: &str) -> Option<usize> {
    let chars: Vec<(usize, char)> = s.char_indices().collect();
    let mut in_s = false;
    let mut in_d = false;
    for i in 0..chars.len() {
        let (off, c) = chars[i];
        match c {
            '\'' if !in_d => in_s = !in_s,
            '"' if !in_s => in_d = !in_d,
            ':' if !in_s && !in_d => {
                let next = chars.get(i + 1).map(|x| x.1);
                if next.is_none() || next == Some(' ') || next == Some('\t') {
                    return Some(off);
                }
            }
            _ => {}
        }
    }
    None
}

/// properties / env 风格：key = value 的等号位置
fn find_eq_sep(s: &str) -> Option<usize> {
    if !s.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_' || c == '.') {
        return None;
    }
    let off = s.find('=')?;
    let key = &s[..off];
    if key
        .trim_end()
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '[' | ']'))
    {
        Some(off)
    } else {
        None
    }
}

/* ---------- 值可译性启发式 ---------- */

/// 该字符串是否值得翻译（跳过数字、布尔、URL、路径、locale、色值等）
pub fn translatable(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() || t.len() > 2000 {
        return false;
    }
    // 无字母（含 CJK）→ 纯符号/数字
    if !t.chars().any(|c| c.is_alphabetic()) {
        return false;
    }
    let low = t.to_ascii_lowercase();
    if matches!(
        low.as_str(),
        "true" | "false" | "null" | "nil" | "yes" | "no" | "on" | "off" | "none"
    ) {
        return false;
    }
    // 纯数字/时间/版本号
    if t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | ':' | 'v'))
        && t.chars().any(|c| c.is_ascii_digit())
    {
        return false;
    }
    // URL / 邮箱 / 路径
    if low.starts_with("http://")
        || low.starts_with("https://")
        || low.starts_with("www.")
        || low.starts_with("ftp://")
    {
        return false;
    }
    if !t.chars().any(char::is_whitespace) && t.contains('@') && t.contains('.') {
        return false;
    }
    if t.starts_with('/')
        || t.starts_with("./")
        || t.starts_with("../")
        || t.starts_with('~')
        || t.starts_with('\\')
    {
        return false;
    }
    // 颜色 / locale（zh-CN、en_US）
    if t.starts_with('#') && t.len() <= 9 && t[1..].chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    if is_locale_code(&low) {
        return false;
    }
    true
}

fn is_locale_code(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() < 2 || bytes.len() > 10 {
        return false;
    }
    if !bytes[..2].iter().all(|b| b.is_ascii_lowercase()) {
        return false;
    }
    if bytes.len() == 2 {
        return true;
    }
    let rest = &s[2..];
    let rest = rest.strip_prefix('-').or_else(|| rest.strip_prefix('_'));
    match rest {
        Some(r) => r.len() >= 2 && r.chars().all(|c| c.is_ascii_alphanumeric()),
        None => false,
    }
}

/* ---------- 占位符掩码 ---------- */

/// 把占位符（{name} / {{var}} / %s / $var / <tag>）替换为 ⟪n⟫ 记号，返回 (掩码串, 原文 stash)
pub fn mask_placeholders(s: &str) -> (String, Vec<String>) {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut stash: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let tok: Option<String> = match chars[i] {
            '{' => {
                let dbl = chars.get(i + 1) == Some(&'{');
                let body_start = if dbl { i + 2 } else { i + 1 };
                let mut j = body_start;
                while j < chars.len() && chars[j] != '}' && chars[j] != '{' && j - body_start <= 60 {
                    j += 1;
                }
                if j < chars.len() && chars[j] == '}' && j > body_start {
                    if dbl && chars.get(j + 1) != Some(&'}') {
                        None
                    } else {
                        let body: String = chars[body_start..j].iter().collect();
                        // 单花括号：变量名须以字母/下划线开头（排除普通花括号文本）
                        let ok = !dbl && {
                            let f = body.chars().next().unwrap_or(' ');
                            f.is_ascii_alphabetic() || f == '_'
                        } || dbl;
                        if ok {
                            let end = if dbl { j + 1 } else { j };
                            Some(chars[i..=end].iter().collect())
                        } else {
                            None
                        }
                    }
                } else {
                    None
                }
            }
            '%' => {
                // printf：%[-0-9.#$]*[a-zA-Z]
                let mut j = i + 1;
                while j < chars.len() && "0123456789.#$-+".contains(chars[j]) {
                    j += 1;
                }
                if j < chars.len() && chars[j].is_ascii_alphabetic() && j - i <= 8 {
                    Some(chars[i..=j].iter().collect())
                } else {
                    None
                }
            }
            '$' => {
                let mut j = i + 1;
                let braced = chars.get(j) == Some(&'{');
                if braced {
                    j += 1;
                }
                if chars.get(j).is_some_and(|c| c.is_ascii_alphabetic() || *c == '_') {
                    j += 1;
                    while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                        j += 1;
                    }
                    let mut end = j;
                    if braced && chars.get(j) == Some(&'}') {
                        end = j + 1;
                    }
                    Some(chars[i..end].iter().collect())
                } else {
                    None
                }
            }
            '<' => {
                // HTML 标签
                let next = chars.get(i + 1);
                if next.is_some_and(|c| c.is_ascii_alphabetic() || *c == '/') {
                    let mut j = i + 1;
                    while j < chars.len() && chars[j] != '>' && j - i <= 80 {
                        j += 1;
                    }
                    if j < chars.len() && chars[j] == '>' {
                        Some(chars[i..=j].iter().collect())
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
            _ => None,
        };
        match tok {
            Some(t) => {
                stash.push(t.clone());
                out.push_str(&format!("⟪{}⟫", stash.len() - 1));
                i += t.chars().count();
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    (out, stash)
}

/// 把 ⟪n⟫ 记号还原为占位符原文（容忍模型加的空格）
pub fn unmask_placeholders(s: &str, stash: &[String]) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find('⟪') {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + '⟪'.len_utf8()..];
        let Some(end) = after.find('⟫') else {
            out.push('⟪');
            rest = after;
            continue;
        };
        let idx: Option<usize> = after[..end].trim().parse().ok();
        match idx.and_then(|i| stash.get(i)) {
            Some(orig) => out.push_str(orig),
            None => out.push_str(&after[..end + '⟫'.len_utf8()]),
        }
        rest = &after[end + '⟫'.len_utf8()..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_values_only_keys_intact() {
        let src = r#"{
  "app": {
    "title": "Hello",
    "version": 2,
    "ok": true
  },
  "items": ["Apple", "Banana", 42]
}"#;
        let sp = split(src).expect("应识别为 JSON");
        assert_eq!(sp.kind, Kind::Json);
        assert_eq!(sp.values, vec!["Hello", "Apple", "Banana"]);
        let out = merge(&sp, &["你好".into(), "苹果".into(), "香蕉".into()]);
        assert!(out.contains("\"title\": \"你好\""));
        assert!(out.contains("\"version\": 2"));
        assert!(out.contains("\"ok\": true"));
        assert!(out.contains("\"苹果\", \"香蕉\", 42"));
        assert!(out.contains("\"app\"")); // 键未翻译
        assert!(!out.contains("Hello"));
    }

    #[test]
    fn json_escapes_roundtrip() {
        let src = r#"{"a":"line1\nline2 \"q\"","b":"路径 C:\\Users"}"#;
        let sp = split(src).expect("json");
        assert_eq!(sp.values.len(), 2);
        assert_eq!(sp.values[0], "line1\nline2 \"q\"");
        let out = merge(&sp, &["第一行\n第二行 \"引号\"".into(), sp.values[1].clone()]);
        let reparsed = serde_json::from_str::<serde_json::Value>(&out).unwrap();
        assert_eq!(reparsed["a"], "第一行\n第二行 \"引号\"");
        assert_eq!(reparsed["b"], "路径 C:\\Users");
    }

    #[test]
    fn yaml_nested_comments_and_skips() {
        let src = "# 注释保留\napp:\n  title: 你好世界\n  desc: \"多语言\"\nlist:\n  - 苹果\n  - 香蕉\nurl: https://example.com\n";
        let sp = split(src).expect("应识别为 YAML");
        assert_eq!(sp.kind, Kind::Yaml);
        assert_eq!(sp.values, vec!["你好世界", "多语言", "苹果", "香蕉"]);
        let out = merge(
            &sp,
            &["Hello".into(), "Multilingual".into(), "Apple".into(), "Banana".into()],
        );
        assert!(out.starts_with("# 注释保留"));
        assert!(out.contains("  title: Hello"));
        assert!(out.contains("  desc: \"Multilingual\""));
        assert!(out.contains("  - Apple"));
        assert!(out.contains("url: https://example.com"));
    }

    #[test]
    fn yaml_translation_gets_quoted_when_structural() {
        let src = "title: Hello\nsubtitle: World\nfooter: End\n";
        let sp = split(src).expect("yaml");
        let out = merge(&sp, &["你好: 世界".into(), "true".into(), "123".into()]);
        assert!(out.contains("title: \"你好: 世界\""));
        assert!(out.contains("subtitle: \"true\""));
        assert!(out.contains("footer: \"123\""));
    }

    #[test]
    fn properties_kv() {
        let src = "# config\nbutton.save=Save\nbutton.cancel=Cancel\nwindow.title=My App\n";
        let sp = split(src).expect("kv");
        assert_eq!(sp.kind, Kind::KeyValue);
        assert_eq!(sp.values, vec!["Save", "Cancel", "My App"]);
        let out = merge(&sp, &["保存".into(), "取消".into(), "我的应用".into()]);
        assert!(out.contains("button.save=保存"));
        assert!(out.contains("# config"));
    }

    #[test]
    fn prose_not_detected() {
        assert!(split("今天天气不错，我们去公园走了走。").is_none());
        assert!(split("Note: this is prose\nTip: another line").is_none());
    }

    #[test]
    fn duplicate_values_deduped() {
        let src = "{\"a\":\"Save\",\"b\":\"Save\",\"c\":\"Open\"}";
        let sp = split(src).unwrap();
        assert_eq!(sp.values, vec!["Save", "Open"]);
        let out = merge(&sp, &["保存".into(), "打开".into()]);
        assert_eq!(out, "{\"a\":\"保存\",\"b\":\"保存\",\"c\":\"打开\"}");
    }

    #[test]
    fn skips_urls_numbers_bools_paths() {
        let src =
            "{\"name\":\"Ann\",\"site\":\"https://x.com\",\"n\":3,\"flag\":false,\"path\":\"/usr/bin\"}";
        let sp = split(src).unwrap();
        assert_eq!(sp.values, vec!["Ann"]);
    }

    #[test]
    fn yaml_inline_comment_preserved() {
        let src = "title: Hello # 界面标题\nmenu: File\nexit: Quit\n";
        let sp = split(src).expect("yaml");
        let out = merge(&sp, &["你好".into(), "文件".into(), "退出".into()]);
        assert!(out.contains("你好 # 界面标题"));
    }

    #[test]
    fn yaml_block_scalar_skipped_intact() {
        // 块内容里的「键: 值」形态不得被当作映射行提取翻译（回填会污染内容）
        let src = "name: Intro\ndesc: |\n  First: line\n  Second line\n  # 不是注释\nmore: Text\ntail: End\n";
        let sp = split(src).expect("yaml");
        assert_eq!(sp.values, vec!["Intro", "Text", "End"]);
        let out = merge(&sp, &["介绍".into(), "文本".into(), "结尾".into()]);
        // 块内容逐字节原样
        assert!(out.contains("  First: line\n  Second line\n  # 不是注释\n"));
        assert!(out.contains("more: 文本"));
    }

    #[test]
    fn yaml_folded_block_and_sibling_after() {
        // 折叠块（>）与块结束后回到父层级的兄弟键
        let src = "a: One\nb: >\n  folded prose: with colon\nc: Two\nd: Three\n";
        let sp = split(src).expect("yaml");
        assert_eq!(sp.values, vec!["One", "Two", "Three"]);
        let out = merge(&sp, &["一".into(), "二".into(), "三".into()]);
        assert!(out.contains("  folded prose: with colon"));
        assert!(out.contains("c: 二"));
    }

    #[test]
    fn placeholder_masking() {
        let (m, stash) =
            mask_placeholders("你好 {name}，已下载 %d%，见 {{link}} 与 <b>加粗</b>，$user 登录");
        assert_eq!(stash.len(), 6); // {name} %d {{link}} <b> </b> $user
        assert!(!m.contains("{name}") && !m.contains("%d") && !m.contains("<b>"));
        let back = unmask_placeholders(&m, &stash);
        assert_eq!(
            back,
            "你好 {name}，已下载 %d%，见 {{link}} 与 <b>加粗</b>，$user 登录"
        );
        // 容忍模型在记号内加空格
        assert_eq!(unmask_placeholders("a ⟪ 0 ⟫ b", &stash), format!("a {} b", stash[0]));
    }
}
