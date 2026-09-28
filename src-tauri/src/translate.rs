//! 划词翻译编排：取词 → LLM 流式翻译 → 悬浮窗翻译卡片 → 复制 / 替换原文。
//! 复用既有设施：翻译提示词与思考-token 快路径在 llm.rs（mode=translate），
//! 悬浮窗定位在 overlay.rs（选区锚点），粘贴管线在 inject.rs。
//! 事件（本地 app.emit，不经外接显示）：sn-translate-start / -result / -error。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Once;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::config::{Config, TRANSLATE_LANGS};

/// 翻译会话代数：新会话开始即 +1，仍在流式读取的旧会话据此中止——
/// 划词卡片、悬浮窗语言条重译、设置页工作台三条入口共用一个串行通道，
/// 任何时刻只有最新一次翻译的 sn-llm-delta 是有效的
static GEN: AtomicU64 = AtomicU64::new(0);

fn current_config(app: &AppHandle) -> Config {
    app.state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .unwrap_or_default()
}

fn llm_ready(cfg: &Config) -> Result<(), String> {
    let llm = cfg.resolved_llm();
    if !llm.enabled || llm.base_url.trim().is_empty() {
        Err("划词翻译经 AI 完成：请先在「AI 优化」页启用并配置接口（模型与 Key 与听写共用）".into())
    } else {
        Ok(())
    }
}

/// 翻译引擎就绪检查：本地引擎查模型/运行时文件，云端查 LLM 配置
fn engine_ready(app: &AppHandle, cfg: &Config) -> Result<(), String> {
    if cfg.translate.engine == "local" {
        let id = crate::local_llm::resolve(&cfg.translate.local_model).id;
        if !crate::local_llm::model_files_ok(app, id) {
            Err("本地翻译模型未下载：请在「翻译」页的「本地翻译引擎」下载（或切回云端引擎）".into())
        } else {
            Ok(())
        }
    } else {
        llm_ready(cfg)
    }
}

/// 黑名单命中：前台窗口标题或进程名包含任一关键字（大小写不敏感）
fn blacklist_hit(cfg: &Config) -> Option<String> {
    let pats: Vec<String> = cfg
        .translate
        .blacklist
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
        .collect();
    if pats.is_empty() {
        return None;
    }
    let exe = crate::inject::foreground_process_name();
    let title = crate::selection::foreground_title();
    let exe_l = exe.to_lowercase();
    let title_l = title.to_lowercase();
    pats.iter()
        .find(|p| exe_l.contains(p.as_str()) || title_l.contains(p.as_str()))
        .map(|p| {
            if exe_l.contains(p.as_str()) {
                exe.clone()
            } else {
                crate::selection::foreground_title()
            }
        })
}

/// 划词翻译入口（热键 / 托盘 / 手动触发）。阻塞操作（取词含按键模拟与
/// 剪贴板轮询），调用方须在后台线程执行。
pub fn translate_selection(app: &AppHandle) {
    let cfg = current_config(app);
    if let Err(msg) = engine_ready(app, &cfg) {
        show_translate_error(app, &msg);
        return;
    }
    // 黑名单：用户自己加的排除项，静默跳过（弹窗反而打断被排除应用的正常使用）
    if let Some(hit) = blacklist_hit(&cfg) {
        crate::trace_pipeline(app, &format!("划词翻译跳过：{hit} 命中黑名单"));
        return;
    }
    let sel = match crate::selection::capture(&cfg.translate) {
        Ok(s) => s,
        Err(e) => {
            let msg = e.message();
            crate::trace_pipeline(app, &format!("取词失败：{msg}"));
            show_translate_error(app, &msg);
            return;
        }
    };
    crate::trace_pipeline(
        app,
        &format!(
            "划词翻译：{}字（via {}，目标 {}）",
            sel.text.chars().count(),
            sel.via,
            cfg.llm.translate_target
        ),
    );
    launch_card(app, &cfg, sel.text);
}

/// 弹出翻译卡片并开始会话：划词入口与剪贴板监听共用
/// （OCR 一键链在悬浮窗已显示时直接调 start_session，不走这里）
pub fn launch_card(app: &AppHandle, cfg: &Config, text: String) {
    if cfg.general.show_overlay && !crate::pipeline::suppress_local_overlay(cfg) {
        // 划词路径此刻选区高亮仍在，overlay_position 的 UIA 锚点正好是选区矩形
        crate::overlay::show(app);
    }
    start_session(app, cfg, text, cfg.llm.translate_target.clone());
}

fn show_translate_error(app: &AppHandle, message: &str) {
    let cfg = current_config(app);
    if cfg.general.show_overlay && !crate::pipeline::suppress_local_overlay(&cfg) {
        crate::overlay::show(app);
    }
    let _ = app.emit("sn-translate-error", serde_json::json!({ "message": message }));
    crate::pipeline::hide_later(app, 6000);
}

/// 开启一次带悬浮窗广播的翻译会话（划词入口 / 语言条重译 / 重译按钮）
pub fn start_session(app: &AppHandle, cfg: &Config, text: String, target: String) {
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit(
        "sn-translate-start",
        serde_json::json!({
            "gen": gen,
            "text": text,
            "target": target,
            "second": cfg.llm.translate_second_target,
        }),
    );
    let app = app.clone();
    let cfg = cfg.clone();
    tauri::async_runtime::spawn(async move {
        let _ = session(app, cfg, text, target, gen, true).await;
    });
}

/// 单次翻译会话。流式增量经 sn-llm-delta 广播（悬浮窗卡片 / 工作台据此逐字上屏）；
/// `announce` = 是否向悬浮窗发 start/result/error 生命周期事件（工作台的静默翻译不发，
/// 避免设置页里翻一段话却把悬浮窗弹出来）。
async fn session(
    app: AppHandle,
    cfg: Config,
    text: String,
    target: String,
    gen: u64,
    announce: bool,
) -> Result<String, String> {
    // 引擎选择：本地（llama.cpp sidecar，离线）或云端（用户配置的 OpenAI 兼容接口）
    let mut llm = if cfg.translate.engine == "local" {
        let h = app.clone();
        let base = tauri::async_runtime::spawn_blocking(move || crate::local_llm::ensure_server(&h))
            .await
            .map_err(|e| format!("本地引擎线程异常: {e}"))?
            .map_err(|e| format!("本地翻译引擎启动失败：{e:#}"))?;
        let mut l = cfg.resolved_llm();
        l.base_url = format!("{base}/v1");
        l.api_key.clear();
        l.provider_id.clear();
        // llama-server 不校验模型名，用模型 id 占位（也便于日志排查）
        l.model = crate::local_llm::resolve(&cfg.translate.local_model).id.to_string();
        // 本地 4B 出字慢（CPU 7~15 字/s）：放宽超时，避免长文翻译被 45s 掐断
        l.timeout_sec = l.timeout_sec.max(300);
        l.enabled = true;
        l
    } else {
        cfg.resolved_llm()
    };
    llm.mode = "translate".into();
    llm.translate_target = target;
    // 划词翻译永远走内置翻译提示词：自定义指令是给听写优化用的，
    // 带进来会与语言条的目标语言切换互相打架
    llm.custom_prompt.clear();

    let t0 = Instant::now();
    let first = AtomicU64::new(0);
    let h = app.clone();
    let superseded = move || {
        if GEN.load(Ordering::SeqCst) != gen {
            return true;
        }
        // 听写开始：悬浮窗要让位给聆听卡，旧翻译流立即中止省流量
        h.state::<crate::Ctx>()
            .recording
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
    };

    // 结构化翻译：JSON / YAML / properties 等只翻译字符串值——
    // 键名、注释、缩进与整体格式逐字节保留，占位符自动保护
    if cfg.translate.structured_translate {
        if let Some(sp) = crate::trans_struct::split(&text) {
            if sp.values.is_empty() {
                let msg = format!("识别到{}结构，但没有可翻译的字符串值", sp.kind.label());
                if announce {
                    let _ = app.emit("sn-translate-error", serde_json::json!({ "message": msg }));
                    crate::pipeline::hide_later(&app, 6000);
                }
                return Err(msg);
            }
            return translate_structured(
                &app,
                &llm,
                &sp,
                &text,
                gen,
                announce,
                t0,
                &superseded,
                cfg.translate.auto_copy,
            )
            .await;
        }
    }

    let out = match crate::llm::optimize_streaming(&llm, &text, &app, Some(&first), Some(&superseded))
        .await
    {
        Ok(t) => t,
        Err(e) => {
            if superseded() {
                // 新翻译 / 新听写已接管悬浮窗：静默退出，卡片由新会话的事件刷新
                return Err(format!("翻译中止：{e:#}"));
            }
            let msg = format!("翻译失败：{e:#}");
            if announce {
                let _ = app.emit("sn-translate-error", serde_json::json!({ "message": msg }));
                crate::pipeline::hide_later(&app, 6000);
            }
            return Err(msg);
        }
    };
    let ms = t0.elapsed().as_millis() as u64;
    let first_ms = first.load(Ordering::SeqCst);
    let out = crate::text_clean::tidy_punct(out.trim());
    if out.is_empty() {
        let msg = "AI 未返回译文（思考超限或模型异常），可点「重译」再试".to_string();
        if announce {
            let _ = app.emit("sn-translate-error", serde_json::json!({ "message": msg }));
            crate::pipeline::hide_later(&app, 6000);
        }
        return Err(msg);
    }
    let auto_copied = cfg.translate.auto_copy
        && crate::inject::copy_only(&out).is_ok();
    // 翻译入历史（原文/译文对照，供回查与再复制；asrMs=0 时前端隐藏识别行）
    crate::history::push(&app, &text, &out, 0, ms);
    if announce {
        let _ = app.emit(
            "sn-translate-result",
            serde_json::json!({
                "gen": gen,
                "final": out,
                "ms": ms,
                "firstMs": first_ms,
                "autoCopied": auto_copied,
            }),
        );
        // 翻译卡片要读：给足驻留时间，悬停钉住时计时自动暂停
        crate::pipeline::hide_later(&app, 10_000);
    }
    crate::trace_pipeline(
        &app,
        &format!("翻译完成：{ms}ms（首字 {first_ms}ms，{}字）", out.chars().count()),
    );
    Ok(out)
}

/* ---------- 结构化翻译执行（JSON / YAML / 键值：只译值） ---------- */

/// 单条值的预处理形态：占位符已掩码、换行已记为字面 \n（协议按行传输）
struct MaskedItem {
    masked: String,
    stash: Vec<String>,
    /// 原值含真实换行或字面 \n：协议结束后需把 \n 还原为换行
    had_nl: bool,
}

/// 结构化翻译：占位符掩码 → 分批编号协议送翻 → 严格校验回填。
/// 协议失配（编号错乱/丢行）或复杂值自动退回逐条单独翻译，保证结构永不损坏。
#[allow(clippy::too_many_arguments)]
async fn translate_structured(
    app: &AppHandle,
    llm: &crate::config::LlmConfig,
    sp: &crate::trans_struct::Split,
    text: &str,
    gen: u64,
    announce: bool,
    t0: Instant,
    superseded: &(dyn Fn() -> bool + Send + Sync),
    auto_copy: bool,
) -> Result<String, String> {
    use crate::trans_struct::{mask_placeholders, unmask_placeholders};

    let n = sp.values.len();
    let kind_label = sp.kind.label();
    let target_name = crate::config::lang_name(&llm.translate_target);
    crate::trace_pipeline(app, &format!("结构化翻译：{kind_label} · {n} 条文本值"));

    let items: Vec<MaskedItem> = sp
        .values
        .iter()
        .map(|v| {
            let (m, stash) = mask_placeholders(v);
            let had_nl = m.contains('\n') || m.contains("\\n");
            let masked = if m.contains('\n') { m.replace('\n', "\\n") } else { m };
            MaskedItem { masked, stash, had_nl }
        })
        .collect();

    const BATCH: usize = 30;
    let total_batches = n.div_ceil(BATCH);
    let mut translations: Vec<String> = Vec::with_capacity(n);
    for (bi, chunk) in items.chunks(BATCH).enumerate() {
        if superseded() {
            return Err("翻译中止：已被新会话取代".into());
        }
        // 批量协议：借用 custom_prompt 通道注入批量指令（llm 侧用中性系统提示包裹）
        let list = chunk
            .iter()
            .enumerate()
            .map(|(i, it)| format!("[{}] {}", translations.len() + i, it.masked))
            .collect::<Vec<_>>()
            .join("\n");
        let mut batch_llm = llm.clone();
        batch_llm.custom_prompt = format!(
            "你是本地化译员。输入是编号字符串列表（每行格式：[编号] 文本），\
             全部来自同一个{kind_label}文件，请保持术语与语气一致。\
             把每条文本翻译成{target_name}，并按完全相同的编号逐行输出译文\
             （每行格式：[编号] 译文），不要增删行、不要改变编号、不要输出任何解释。\
             ⟪数字⟫格式的记号是受保护的占位符，必须原样保留、不许翻译、不许改动；\
             译文中的字面 \\n 表示换行。文本：{{text}}"
        );
        let start = translations.len();
        let numbered = match crate::llm::optimize_streaming(
            &batch_llm,
            &list,
            app,
            None,
            Some(superseded),
        )
        .await
        {
            Ok(out) => parse_numbered(&out, start..start + chunk.len()),
            Err(_) => None,
        };
        let results: Vec<String> = match numbered {
            Some(rs) => rs,
            None => {
                crate::trace_pipeline(
                    app,
                    &format!("结构化翻译：第 {}/{} 批协议失配，逐条兜底", bi + 1, total_batches),
                );
                let mut indiv = Vec::with_capacity(chunk.len());
                for it in chunk {
                    match crate::llm::optimize(llm, &it.masked).await {
                        Ok(t) => indiv.push(t),
                        Err(e) => {
                            if superseded() {
                                return Err("翻译中止：已被新会话取代".into());
                            }
                            let msg = format!("翻译失败：{e:#}");
                            if announce {
                                let _ = app.emit(
                                    "sn-translate-error",
                                    serde_json::json!({ "message": msg }),
                                );
                                crate::pipeline::hide_later(app, 6000);
                            }
                            return Err(msg);
                        }
                    }
                }
                indiv
            }
        };
        for (it, tr) in chunk.iter().zip(results) {
            let mut t = if it.had_nl { tr.replace("\\n", "\n") } else { tr };
            t = unmask_placeholders(t.trim(), &it.stash);
            t = crate::text_clean::tidy_punct(&t);
            translations.push(t);
        }
        if announce && total_batches > 1 {
            let _ = app.emit(
                "sn-llm-delta",
                serde_json::json!({
                    "kind": "reasoning",
                    "delta": format!("已完成 {}/{} 批…\n", bi + 1, total_batches),
                }),
            );
        }
    }

    let out = crate::trans_struct::merge(sp, &translations);
    let ms = t0.elapsed().as_millis() as u64;
    let auto_copied = auto_copy && crate::inject::copy_only(&out).is_ok();
    crate::history::push(app, text, &out, 0, ms);
    if announce {
        let _ = app.emit(
            "sn-translate-result",
            serde_json::json!({
                "gen": gen,
                "final": out,
                "ms": ms,
                "firstMs": 0,
                "autoCopied": auto_copied,
                "structured": kind_label,
            }),
        );
        // 结构化文件通常较长：给足驻留阅读时间
        crate::pipeline::hide_later(app, 12_000);
    }
    crate::trace_pipeline(
        app,
        &format!("结构化翻译完成：{ms}ms（{kind_label}，{n} 条值，{}字）", out.chars().count()),
    );
    Ok(out)
}

/// 解析批量协议回包：行格式 `[N] 文本`，编号集合须与期望完全一致、无缺失。
/// 容忍模型偶尔包上的 markdown 代码围栏与空行
fn parse_numbered(out: &str, expected: std::ops::Range<usize>) -> Option<Vec<String>> {
    let mut got: Vec<Option<String>> = vec![None; expected.len()];
    for line in out.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with("```") {
            continue;
        }
        let rest = l.strip_prefix('[')?;
        let (num, rest) = rest.split_once(']')?;
        let n: usize = num.trim().parse().ok()?;
        let v = rest.strip_prefix(' ').unwrap_or(rest).to_string();
        let idx = n.checked_sub(expected.start)?;
        if idx >= expected.len() {
            return None;
        }
        if got[idx].is_some() {
            return None; // 编号重复
        }
        got[idx] = Some(v);
    }
    got.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::parse_numbered;

    #[test]
    fn numbered_protocol_roundtrip() {
        let out = "[3] 世界\n[4] 你好\n[5] 再见\n";
        let rs = parse_numbered(out, 3..6).expect("应解析成功");
        assert_eq!(rs, vec!["世界", "你好", "再见"]);
        // 缺行 → 失配
        assert!(parse_numbered("[3] 世界\n[4] 你好\n", 3..6).is_none());
        // 编号越界 → 失配
        assert!(parse_numbered("[3] a\n[4] b\n[7] c\n", 3..6).is_none());
        // 重复编号 → 失配
        assert!(parse_numbered("[3] a\n[3] b\n[4] c\n", 3..6).is_none());
        // 容忍前导空行与多余空白
        let rs = parse_numbered("\n  [0] Hi  \n[1] Bye\n", 0..2).unwrap();
        assert_eq!(rs, vec!["Hi", "Bye"]);
    }
}

/// 目标语言持久化（悬浮窗语言条 / 托盘共用语义）：落盘 + 更新内存 + 通知前端 + 重建托盘
fn persist_target(app: &AppHandle, target: &str) {
    let mut cfg = current_config(app);
    if cfg.llm.translate_target == target {
        return;
    }
    cfg.llm.translate_target = target.to_string();
    // 目标与第二目标撞车会让提示词退化（「已是 X 则改译成 X」），一并清掉
    if cfg.llm.translate_second_target == target {
        cfg.llm.translate_second_target.clear();
    }
    if let Err(e) = crate::config::save(app, &cfg) {
        eprintln!("[speaknow] 保存翻译目标语言失败: {e:#}");
        return;
    }
    *app.state::<crate::Ctx>()
        .config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(cfg);
    let _ = app.emit("sn-config-changed", ());
    let h = app.clone();
    let _ = app.run_on_main_thread(move || crate::tray::rebuild_menu(&h));
}

/* ---------- Tauri 命令 ---------- */

/// 手动触发划词翻译（设置页「试一下」/托盘菜单）
#[tauri::command]
pub async fn translate_selection_cmd(app: AppHandle) -> Result<String, String> {
    let h = app.clone();
    tauri::async_runtime::spawn_blocking(move || translate_selection(&h))
        .await
        .map_err(|e| e.to_string())?;
    Ok("ok".into())
}

/// 翻译指定文本（设置页输入翻译工作台 / 悬浮窗卡片「重译」）。
/// 静默会话：只流 sn-llm-delta，不发 start/result 生命周期事件、不弹悬浮窗；
/// 返回完整译文。`target` 缺省用当前配置目标语言（本次请求有效，不落盘）。
#[tauri::command]
pub async fn translate_text(
    app: AppHandle,
    text: String,
    target: Option<String>,
) -> Result<String, String> {
    let cfg = current_config(&app);
    engine_ready(&app, &cfg)?;
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("没有可翻译的文本".into());
    }
    let target = target.unwrap_or_else(|| cfg.llm.translate_target.clone());
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    session(app, cfg, text, target, gen, false).await
}

/// 广播式翻译会话（OCR 卡片「翻译」按钮用）：与 translate_text 不同，
/// 发 start/result 生命周期事件让悬浮窗从 OCR 卡片切换到流式翻译卡片；
/// 目标语言不落盘，用当前配置值
#[tauri::command]
pub async fn translate_announce(
    app: AppHandle,
    text: String,
    target: Option<String>,
) -> Result<(), String> {
    let cfg = current_config(&app);
    engine_ready(&app, &cfg)?;
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("没有可翻译的文本".into());
    }
    let target = target.unwrap_or_else(|| cfg.llm.translate_target.clone());
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit(
        "sn-translate-start",
        serde_json::json!({
            "gen": gen,
            "text": text,
            "target": target,
            "second": cfg.llm.translate_second_target,
        }),
    );
    // 错误已由 session 内部经 sn-translate-error 广播给卡片，命令本身不再上抛
    let _ = session(app, cfg, text, target, gen, true).await;
    Ok(())
}

/// 悬浮窗语言条切换目标语言并重译：持久化新目标 + 广播 start/result 给卡片
#[tauri::command]
pub async fn translate_retarget(
    app: AppHandle,
    text: String,
    target: String,
) -> Result<(), String> {
    if !TRANSLATE_LANGS.iter().any(|(c, _)| *c == target) {
        return Err("未知的目标语言".into());
    }
    let cfg_src = current_config(&app);
    engine_ready(&app, &cfg_src)?;
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("没有可翻译的文本".into());
    }
    persist_target(&app, &target);
    let cfg = current_config(&app);
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit(
        "sn-translate-start",
        serde_json::json!({
            "gen": gen,
            "text": text,
            "target": target,
            "second": cfg.llm.translate_second_target,
        }),
    );
    // 错误已由 session 内部经 sn-translate-error 广播给卡片，命令本身不再上抛
    let _ = session(app, cfg, text, target, gen, true).await;
    Ok(())
}

/// 把译文替换回原应用中选中的文字（选中状态下粘贴即覆盖，Ctrl+Z 可撤销）
#[tauri::command]
pub async fn translate_replace(app: AppHandle, text: String) -> Result<(), String> {
    let cfg = current_config(&app);
    crate::overlay::hide(&app);
    // 等悬浮窗收回、焦点回到目标应用（paste 管线里也会再等前台就绪）
    tokio::time::sleep(Duration::from_millis(240)).await;
    let mut out = cfg.output.clone();
    // 替换是编辑动作，不该替用户回车提交
    out.auto_submit = false;
    let t = if cfg.translate.replace_marker && !text.starts_with("翻 ") {
        format!("翻 {text}")
    } else {
        text
    };
    tauri::async_runtime::spawn_blocking(move || crate::inject::paste_text(&out, &t))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("替换失败：{e:#}"))?;
    // 复位悬浮窗状态机（前端据此清掉翻译卡片）
    crate::pipeline::emit_status(&app, "idle", "", false);
    Ok(())
}

/* ---------- 剪贴板监听（复制即翻译，CopyTranslator 式） ---------- */

/// 监听线程只起一次，常驻轮询；每tick读配置开关，关闭时零成本空转
static WATCHER: Once = Once::new();

pub fn ensure_clipboard_watcher(app: &AppHandle) {
    WATCHER.call_once(|| {
        let app = app.clone();
        thread::spawn(move || clipboard_watch_loop(app));
    });
}

fn clipboard_watch_loop(app: AppHandle) {
    /// 剪贴板里的内容长度上限：超长文本交给「输入翻译」工作台，卡片装不下也容易截断
    const MAX_CHARS: usize = 4000;
    const TICK_MS: u64 = 600;

    let mut last_seq: u64 = 0;
    #[cfg(not(target_os = "windows"))]
    let mut last_text = String::new();
    let mut last_handled = String::new();
    let mut prev_enabled = false;
    loop {
        thread::sleep(Duration::from_millis(TICK_MS));
        let cfg = current_config(&app);
        let on = cfg.translate.clipboard_watch;
        // 开关刚切换（或关闭期间）：重置变更基准，避免一开启就翻译存量剪贴板内容
        #[cfg(target_os = "windows")]
        if !on || !prev_enabled {
            last_seq = crate::inject::clipboard_seq_now();
        }
        if !on {
            prev_enabled = false;
            continue;
        }
        if !prev_enabled {
            prev_enabled = true;
            continue;
        }

        // 变更检测：Windows 用剪贴板序号（零拷贝），其他平台退化为内容比较
        #[cfg(target_os = "windows")]
        {
            let s = crate::inject::clipboard_seq_now();
            if s == last_seq {
                continue;
            }
            last_seq = s;
        }
        let Some(raw) = arboard::Clipboard::new()
            .ok()
            .and_then(|mut c| c.get_text().ok())
            .map(|t| t.trim().to_string())
        else {
            continue;
        };
        #[cfg(not(target_os = "windows"))]
        {
            if raw == last_text {
                continue;
            }
            last_text = raw.clone();
        }

        if raw.is_empty() || raw == last_handled {
            continue;
        }
        // 结构化文件（语言包/配置）放宽上限——只译值本就该整文件处理，卡片可滚动阅读；
        // 普通 prose 仍交给「输入翻译」工作台
        let limit = if crate::trans_struct::split(&raw).is_some() {
            60_000
        } else {
            MAX_CHARS
        };
        if raw.chars().count() > limit {
            continue;
        }
        // 本应用自己写入的（听写输出 / 译文复制 / OCR 自动复制）不触发
        if crate::inject::last_own_clipboard_text().is_some_and(|own| own == raw) {
            continue;
        }
        // 静默守卫：AI 未配置 / 黑名单应用 / 听写进行中，一律不打扰
        if engine_ready(&app, &cfg).is_err() || blacklist_hit(&cfg).is_some() {
            continue;
        }
        if app
            .state::<crate::Ctx>()
            .recording
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
        {
            continue;
        }
        last_handled = raw.clone();
        let text = crate::selection::soft_wrap_join(&raw);
        crate::trace_pipeline(
            &app,
            &format!("剪贴板监听触发翻译：{}字", text.chars().count()),
        );
        launch_card(&app, &cfg, text);
    }
}
