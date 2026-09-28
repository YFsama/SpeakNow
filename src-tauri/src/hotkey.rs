use std::str::FromStr;
use std::sync::{LazyLock, Mutex};

use anyhow::{anyhow, Result};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

use crate::config::HotkeyConfig;
use crate::{pipeline, Ctx};

/// 解析 "ctrl+shift+Space" 形式的快捷键描述
pub fn parse_shortcut(s: &str) -> Result<Shortcut> {
    let mut mods = Modifiers::empty();
    let mut code: Option<Code> = None;
    for part in s.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "alt" | "option" => mods |= Modifiers::ALT,
            "shift" => mods |= Modifiers::SHIFT,
            "meta" | "cmd" | "command" | "super" | "win" => mods |= Modifiers::META,
            _ => {
                let c = Code::from_str(part)
                    .or_else(|_| Code::from_str(&capitalize_first(part)))
                    .map_err(|_| anyhow!("无法识别的按键: {part}"))?;
                code = Some(c);
            }
        }
    }
    let code = code.ok_or_else(|| anyhow!("快捷键缺少主键: {s}"))?;
    let mods = if mods.is_empty() { None } else { Some(mods) };
    Ok(Shortcut::new(mods, code))
}

fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
        None => s.to_string(),
    }
}

/// 串行化重注册，避免后台任务竞态导致重复注册
static APPLY_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// 应用快捷键配置变更：注销旧的，注册主快捷键 + 快速模式/翻译模式快捷键
pub fn apply(app: &AppHandle, hk: &HotkeyConfig) -> Result<()> {
    let _g = APPLY_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if hk.enabled && !hk.key.trim().is_empty() {
        let shortcut = parse_shortcut(&hk.key)?;
        gs.on_shortcut(shortcut, handle_event).map_err(|e| {
            anyhow!("注册快捷键 {} 失败（可能已被其他应用占用）: {e}", hk.key)
        })?;
    }
    // 快速模式快捷键：跳过 AI 优化，即使主快捷键停用也可单独使用
    if !hk.key_quick.trim().is_empty() {
        let shortcut = parse_shortcut(&hk.key_quick)?;
        gs.on_shortcut(shortcut, handle_event).map_err(|e| {
            anyhow!(
                "注册快速模式快捷键 {} 失败（可能已被其他应用占用）: {e}",
                hk.key_quick
            )
        })?;
    }
    // 翻译模式快捷键：本次听写强制翻译（输出目标语言译文），不经设置即可切换
    if !hk.key_translate.trim().is_empty() {
        let shortcut = parse_shortcut(&hk.key_translate)?;
        gs.on_shortcut(shortcut, handle_event).map_err(|e| {
            anyhow!(
                "注册翻译模式快捷键 {} 失败（可能已被其他应用占用）: {e}",
                hk.key_translate
            )
        })?;
    }
    // 划词翻译快捷键：翻译任意应用中选中的文字（DeepL 客户端式体验）
    if !hk.key_translate_sel.trim().is_empty() {
        let shortcut = parse_shortcut(&hk.key_translate_sel)?;
        gs.on_shortcut(shortcut, handle_event).map_err(|e| {
            anyhow!(
                "注册划词翻译快捷键 {} 失败（可能已被其他应用占用）: {e}",
                hk.key_translate_sel
            )
        })?;
    }
    // 截图取词快捷键：框选屏幕区域 OCR 识别（复制/翻译/输入）
    if !hk.key_ocr.trim().is_empty() {
        let shortcut = parse_shortcut(&hk.key_ocr)?;
        gs.on_shortcut(shortcut, handle_event).map_err(|e| {
            anyhow!(
                "注册截图取词快捷键 {} 失败（可能已被其他应用占用）: {e}",
                hk.key_ocr
            )
        })?;
    }
    Ok(())
}

fn handle_event(app: &AppHandle, sc: &Shortcut, event: ShortcutEvent) {
    let hk = app
        .state::<Ctx>()
        .config
        .lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .map(|c| c.hotkey.clone())
        .unwrap_or_default();

    let is_quick = !hk.key_quick.is_empty()
        && parse_shortcut(&hk.key_quick).map(|q| q == *sc).unwrap_or(false);
    let is_translate = !is_quick
        && !hk.key_translate.is_empty()
        && parse_shortcut(&hk.key_translate)
            .map(|t| t == *sc)
            .unwrap_or(false);
    let is_translate_sel = !is_quick
        && !is_translate
        && !hk.key_translate_sel.is_empty()
        && parse_shortcut(&hk.key_translate_sel)
            .map(|t| t == *sc)
            .unwrap_or(false);
    let is_ocr = !is_quick
        && !is_translate
        && !is_translate_sel
        && !hk.key_ocr.is_empty()
        && parse_shortcut(&hk.key_ocr)
            .map(|t| t == *sc)
            .unwrap_or(false);

    // 划词翻译独立于听写会话：取词含按键模拟与剪贴板轮询（阻塞可达秒级），
    // 放独立线程执行，不占住热键回调线程
    if is_translate_sel && event.state() == ShortcutState::Pressed {
        let h = app.clone();
        std::thread::spawn(move || crate::translate::translate_selection(&h));
        return;
    }

    // 截图取词同样独立：弹选区窗 + GDI 截屏 + OCR 全在后台完成
    if is_ocr && event.state() == ShortcutState::Pressed {
        crate::ocr::start_capture(app);
        return;
    }

    match event.state() {
        ShortcutState::Pressed => {
            if hk.mode == "hold" {
                if let Err(e) = pipeline::start(app, is_quick, is_translate, false) {
                    eprintln!("[speaknow] 开始录音失败: {e}");
                }
            } else {
                pipeline::toggle(app, is_quick, is_translate);
            }
        }
        ShortcutState::Released => {
            if hk.mode == "hold" {
                if let Err(e) = pipeline::stop(app) {
                    eprintln!("[speaknow] 结束录音失败: {e}");
                }
            }
        }
    }
}
