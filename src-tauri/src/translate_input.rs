//! 输入框翻译编排：读聚焦输入框草稿 → 复用划词翻译会话（悬浮窗卡片+流式）
//! → 译文全选替换回输入框。与听写/typist 互斥，替换带进程与内容双守卫，
//! 注入前各检查点复查会话未被作废。

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::translate;

/// 输入框翻译入口（热键 / 托盘 / 命令）。读草稿（UIA）、翻译（秒级网络请求）
/// 与替换（按键模拟）都是阻塞操作，调用方须在后台线程执行。
pub fn run(app: &AppHandle) {
    // 听写进行中不动输入框：替换的按键注入会与「识别结果自动输入」的两条
    // 注入流交错，且悬浮窗此刻由聆听卡占用——与 translate_selection 的
    // 静默守卫语义一致，直接返回不读草稿、不模拟按键
    if app
        .state::<crate::Ctx>()
        .recording
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .is_some()
    {
        return;
    }
    // typist 正在逐字注入时同样互斥：两套按键注入流并发会交错出乱序字符
    if crate::typist::is_active() {
        return;
    }
    let cfg = translate::current_config(app);
    if let Err(msg) = translate::engine_ready(app, &cfg) {
        translate::show_translate_error(app, &msg);
        return;
    }
    // 黑名单：用户自己加的排除项，静默跳过（弹窗反而打断被排除应用的正常使用）
    if let Some(hit) = translate::blacklist_hit(&cfg) {
        crate::trace_pipeline(app, &format!("输入框翻译跳过：{hit} 命中黑名单"));
        return;
    }
    // 终端聚焦时提前拒绝：终端里 Ctrl+A 是移动光标，全选替换不可能成立；
    // 早拦还避免 TextPattern 把整屏回滚区当草稿白读一遍白跑一次翻译
    if crate::inject::foreground_is_terminal() {
        translate::show_translate_error(
            app,
            "终端窗口不支持输入框翻译：终端里 Ctrl+A 是移动光标而非全选",
        );
        return;
    }
    let draft = match crate::selection::capture_input_text() {
        Ok(t) => t,
        Err(e) => {
            let msg = e.message();
            crate::trace_pipeline(app, &format!("读输入框草稿失败：{msg}"));
            translate::show_translate_error(app, &msg);
            return;
        }
    };
    let n = draft.chars().count();
    if n > 20_000 {
        translate::show_translate_error(
            app,
            &format!("草稿过长（{n} 字），输入框翻译暂只支持 2 万字以内"),
        );
        return;
    }
    // 读取时刻的前台进程：替换前的第一道守卫（须在 capture 之后立刻取，
    // 防翻译期间切窗后把全选按键发进无关应用）
    let origin = crate::inject::foreground_process_name();
    // 会话代数：翻译完成到回填注入之间隔着秒级窗口（等悬浮窗收回、等松键、
    // 剪贴板校验重试），期间 Esc 关卡 / 新翻译 / 新听写 / typist 启动任一发生
    // 都必须放弃回填——与听写粘贴的 superseded 检查点同构
    let gen = translate::next_translate_gen();
    let h_chk = app.clone();
    let superseded = Arc::new(move || {
        !translate::translate_gen_current(gen)
            || h_chk
                .state::<crate::Ctx>()
                .recording
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_some()
            || crate::typist::is_active()
    });
    if cfg.general.show_overlay && !crate::pipeline::suppress_local_overlay(&cfg) {
        crate::overlay::show(app);
    }
    crate::trace_pipeline(
        app,
        &format!("输入框翻译：{n}字（目标 {}）", cfg.llm.translate_target),
    );

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let target = cfg.llm.translate_target.clone();
        match translate::session_for_input(&app, &cfg, draft.clone(), target, gen).await {
            Ok(t) => {
                if superseded() {
                    crate::trace_pipeline(&app, "输入框翻译：回填前会话已作废（Esc/新翻译/新听写/typist），跳过替换");
                    return;
                }
                // 译文与草稿相同：模型判定草稿已是目标语言——全选替换等于白做
                // 一遍还丢掉原文的排版细节，不如原样保留并说明。带 gen 不作废
                // 会话：此刻用户可能已开新一轮翻译。
                // 措辞不引导「语言条换语言」——那条路径回到划词语义，不再自动替换
                if t.trim() == draft.trim() {
                    translate::show_translate_error_gen(
                        &app,
                        gen,
                        "译文与草稿相同（草稿可能已是目标语言），未做替换；如需换语言，调整目标语言后重新按输入框翻译快捷键",
                    );
                    return;
                }
                crate::overlay::hide(&app);
                // 等悬浮窗收回、焦点回到目标输入框（replace 管线里也会再等前台就绪）
                tokio::time::sleep(Duration::from_millis(240)).await;
                let mut out = cfg.output.clone();
                // 替换是编辑动作，永不替用户回车提交（聊天框里回车=发送）
                out.auto_submit = false;
                let origin2 = origin.clone();
                let draft2 = draft.clone();
                let t2 = t.clone();
                let sup = superseded.clone();
                let replaced = tauri::async_runtime::spawn_blocking(move || {
                    crate::inject::replace_focused_text(&out, &t2, &origin2, &draft2, sup.as_ref())
                })
                .await;
                match replaced {
                    Ok(Ok(true)) => {
                        // 复位悬浮窗状态机（前端据此清掉翻译卡片）；期间又有新
                        // 会话/听写接管则不动——那条流自己负责收尾
                        if !superseded() {
                            crate::pipeline::emit_status(&app, "idle", "", false);
                        }
                    }
                    // 注入前检查点放弃（bail 命中）：用户已转向新操作，静默让位
                    Ok(Ok(false)) => {
                        crate::trace_pipeline(&app, "输入框翻译：注入前检查点放弃回填");
                    }
                    Ok(Err(e)) => {
                        replace_failed(&app, gen, &t, format!("替换失败：{e:#}")).await;
                    }
                    Err(e) => {
                        replace_failed(&app, gen, &t, format!("替换失败：替换任务异常: {e}")).await;
                    }
                }
            }
            // 会话失败已由 session 内部经 sn-translate-error 广播给卡片，无事可做
            Err(_) => {}
        }
    });
}

/// 替换失败的收尾：尽力把译文复制到剪贴板（用户可手动全选粘贴）并弹错误卡。
/// 复制走 copy_only_locked：此刻听写粘贴可能正在持 PASTE_LOCK 进行「写剪贴板
/// →发粘贴键」，裸 copy_only 会挤进间隙让用户粘出译文而非听写结果
/// （与 translate.rs auto_copy_guarded 同一教训）。
/// 错误卡带 gen 且不作废会话：此刻用户可能已开新一轮翻译，abort 会误杀新会话
async fn replace_failed(app: &AppHandle, gen: u64, text: &str, msg: String) {
    let t = text.to_string();
    let copied = tauri::async_runtime::spawn_blocking(move || {
        crate::inject::copy_only_locked(&t)
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("{e}")));
    if let Err(ce) = copied.as_ref() {
        eprintln!("[speaknow] 替换失败后的退路复制失败: {ce:#}");
    }
    // 文案与事实相符：退路复制失败就不能说「已复制」（同 Overlay 复制按钮
    // 的「不谎报已复制」原则），只提示译文从悬浮窗卡片仍可取
    let tail = if copied.is_ok() {
        "（译文已复制到剪贴板，可手动全选粘贴）"
    } else {
        "（剪贴板被占用，译文仍在悬浮窗卡片中可复制）"
    };
    translate::show_translate_error_gen(app, gen, &format!("{msg}{tail}"));
}

/// 手动触发输入框翻译（托盘 / 前端）。读草稿与替换含 UIA/按键模拟（阻塞），
/// 放阻塞线程池执行
#[tauri::command]
pub async fn translate_input_cmd(app: AppHandle) -> Result<String, String> {
    let h = app.clone();
    tauri::async_runtime::spawn_blocking(move || run(&h))
        .await
        .map_err(|e| e.to_string())?;
    Ok("ok".into())
}
