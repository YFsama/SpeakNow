use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::config::{AsrConfig, Config};
use crate::{asr, audio, history, inject, llm, overlay, Ctx, PendingReview};

/// 托盘 / 切换模式：正在录音则停止，否则开始
/// 上次 toggle 时刻（ms）：热键事件去抖。键盘连击/驱动重复会在几十毫秒内
/// 产生第二次 toggle，造成「一开就停」（话没说完就结束）或幽灵录音，
/// 进而引发旧结果晚到输入。300ms 内的第二次 toggle 一律忽略。
static LAST_TOGGLE_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn toggle(app: &AppHandle, skip_llm: bool) {
    let now = now_ms();
    let last = LAST_TOGGLE_MS.load(Ordering::SeqCst);
    if last > 0 && now.saturating_sub(last) < 300 {
        crate::trace_pipeline(app, &format!("toggle 忽略（{}ms 内重复，疑按键抖动）", now - last));
        return;
    }
    LAST_TOGGLE_MS.store(now, Ordering::SeqCst);
    crate::trace_pipeline(app, "toggle（热键）");
    let recording = app.state::<Ctx>().recording.lock().unwrap().is_some();
    if recording {
        let _ = stop(app, false);
    } else if let Err(e) = start(app, skip_llm) {
        eprintln!("[speaknow] 开始录音失败: {e}");
        emit_status(app, "error", &format!("开始录音失败：{e}"), false);
        hide_later(app, 3000);
    }
}

/// skip_llm=true：本次会话跳过 AI 优化（快速模式）
pub fn start(app: &AppHandle, skip_llm: bool) -> Result<(), String> {
    let state = app.state::<Ctx>();
    if state.recording.lock().unwrap().is_some() {
        return Ok(());
    }
    let cfg = state.config.lock().unwrap().clone().unwrap_or_default();

    let rec = audio::start(
        cfg.audio.device.as_deref(),
        cfg.audio.vad_threshold,
        cfg.audio.gain_db,
    )
    .map_err(|e| format!("{e:#}"))?;
    *state.recording.lock().unwrap() = Some(rec);
    // 新会话开启：作废仍在处理中的上一代结果
    state.run_gen.fetch_add(1, Ordering::SeqCst);
    let gen = state.run_gen.load(Ordering::SeqCst);
    let dev_label = cfg
        .audio
        .device
        .clone()
        .unwrap_or_else(|| "系统默认".to_string());
    crate::trace_pipeline(app, &format!("start 录音（gen {gen} · {dev_label}）"));
    state.watcher_cancel.store(false, Ordering::SeqCst);
    state.skip_llm_next.store(skip_llm, Ordering::SeqCst);

    // 流式分段会话状态
    let streaming = cfg.asr.streaming;
    state.stream_active.store(streaming, Ordering::SeqCst);
    state.stream_done.store(false, Ordering::SeqCst);
    state.stream_finished.store(!streaming, Ordering::SeqCst);
    state.stream_cut.store(0, Ordering::SeqCst);
    state.stream_queue.lock().unwrap().clear();
    state.stream_texts.lock().unwrap().clear();
    let cancel = Arc::clone(&state.watcher_cancel);
    let sound = cfg.general.sound_feedback;
    drop(state);

    if streaming {
        let handle = app.clone();
        let asr_cfg = cfg.asr.clone();
        tauri::async_runtime::spawn(async move {
            segment_worker(handle, asr_cfg).await;
        });
    }

    if cfg.general.show_overlay {
        overlay::show(app);
    }
    let _ = app.emit("sn-retryable", false);
    let hint = match (cfg.hotkey.mode.as_str(), skip_llm) {
        ("hold", false) => "松开快捷键结束并输入",
        ("hold", true) => "松开快捷键结束（快速模式 · 不经 AI）",
        (_, false) => "再次按下快捷键结束并输入",
        (_, true) => "再次按下快捷键结束（快速模式 · 不经 AI）",
    };
    emit_status(app, "recording", hint, sound);

    let handle = app.clone();
    thread::spawn(move || {
        watch(
            handle,
            cancel,
            cfg.audio.vad_enabled,
            cfg.audio.vad_silence_ms,
            cfg.audio.max_duration_sec,
            streaming,
        );
    });
    Ok(())
}

/// 流式分段消费者：按顺序识别队列中的分段并推送实时字幕
async fn segment_worker(app: AppHandle, asr_cfg: AsrConfig) {
    let joiner = if asr_cfg.language == "en" { " " } else { "" };
    loop {
        let seg = app
            .state::<Ctx>()
            .stream_queue
            .lock()
            .unwrap()
            .pop_front();
        match seg {
            Some(samples) => {
                match asr::transcribe(&app, &asr_cfg, &samples).await {
                    Ok(t) if !t.trim().is_empty() => {
                        let joined = {
                            let state = app.state::<Ctx>();
                            let mut texts = state.stream_texts.lock().unwrap();
                            texts.push(t);
                            texts.join(joiner)
                        };
                        let _ = app.emit(
                            "sn-partial",
                            serde_json::json!({ "text": joined }),
                        );
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("[speaknow] 流式分段识别失败: {e:#}"),
                }
            }
            None => {
                if app.state::<Ctx>().stream_done.load(Ordering::SeqCst) {
                    app.state::<Ctx>()
                        .stream_finished
                        .store(true, Ordering::SeqCst);
                    return;
                }
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
        }
    }
}

/// 电平上报 + VAD 静音自动结束 + 最长时长保护 + 流式分段切分
#[allow(clippy::too_many_arguments)]
fn watch(
    app: AppHandle,
    cancel: Arc<AtomicBool>,
    vad_enabled: bool,
    silence_ms: u64,
    max_sec: u64,
    streaming: bool,
) {
    loop {
        thread::sleep(Duration::from_millis(100));
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        let info = {
            let state = app.state::<Ctx>();
            let guard = state.recording.lock().unwrap();
            guard.as_ref().map(|r| {
                (
                    r.shared.level(),
                    r.shared.silence_ms(),
                    r.shared.elapsed_ms(),
                    r.shared.len(),
                    r.shared.rate(),
                )
            })
        };
        let Some((level, silence, elapsed_ms, len, rate)) = info else {
            return;
        };
        let _ = app.emit("sn-level", level);

        // 流式分段：静音 700ms 或单段满 10s 时切一段送识别
        if streaming && len > 0 {
            let cut = app.state::<Ctx>().stream_cut.load(Ordering::SeqCst);
            if len > cut {
                let unsent_secs = (len - cut) as f64 / rate as f64;
                if unsent_secs >= 10.0 || (silence > 700 && unsent_secs > 0.9) {
                    let seg = {
                        let state = app.state::<Ctx>();
                        let guard = state.recording.lock().unwrap();
                        guard.as_ref().map(|r| r.shared.take_range(cut))
                    };
                    if let Some(seg) = seg {
                        let seg16 = audio::to_16k_i16(&seg, rate);
                        app.state::<Ctx>()
                            .stream_queue
                            .lock()
                            .unwrap()
                            .push_back(seg16);
                        app.state::<Ctx>().stream_cut.store(len, Ordering::SeqCst);
                    }
                }
            }
        }

        if vad_enabled && elapsed_ms > 900 && silence > silence_ms {
            crate::trace_pipeline(&app, "VAD 静音自动结束");
            let _ = stop(&app, false);
            return;
        }
        if elapsed_ms > max_sec * 1000 {
            crate::trace_pipeline(&app, "达到最长时长自动结束");
            let _ = stop(&app, false);
            return;
        }
    }
}

/// from_ui=true：由设置页触发（只复制结果，不模拟输入，避免打字打进出设置页）
pub fn stop(app: &AppHandle, from_ui: bool) -> Result<(), String> {
    crate::trace_pipeline(app, if from_ui { "stop（设置页）" } else { "stop" });
    let state = app.state::<Ctx>();
    state.watcher_cancel.store(true, Ordering::SeqCst);
    let Some(rec) = state.recording.lock().unwrap().take() else {
        return Ok(());
    };
    let cfg = state.config.lock().unwrap().clone().unwrap_or_default();
    drop(state);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        run(handle, cfg, rec, from_ui).await;
    });
    Ok(())
}

async fn run(app: AppHandle, cfg: Config, rec: audio::Recording, from_ui: bool) {
    let skip_llm = app
        .state::<Ctx>()
        .skip_llm_next
        .swap(false, Ordering::SeqCst);
    let llm_active = cfg.llm.enabled && !skip_llm && !cfg.llm.base_url.trim().is_empty();
    let streaming = app.state::<Ctx>().stream_active.load(Ordering::SeqCst);

    // 告知悬浮窗本次使用的模型链路
    let asr_label = if cfg.asr.provider == "local" {
        if cfg.asr.local_model == crate::qwen_asr::MODEL_ID {
            "Qwen3-ASR 1.7B 本地".to_string()
        } else {
            format!("本地 Whisper · {}", cfg.asr.local_model)
        }
    } else {
        cfg.asr.model.clone()
    };
    let _ = app.emit(
        "sn-meta",
        serde_json::json!({
            "asrModel": asr_label,
            "llmEnabled": llm_active,
            "llmModel": cfg.llm.model,
            "skip": skip_llm,
        }),
    );

    // 流式：把剩余尾部入队并标记收尾
    if streaming {
        let cut = app.state::<Ctx>().stream_cut.load(Ordering::SeqCst);
        let rate = rec.shared.rate();
        let tail = rec.shared.take_range(cut);
        if !tail.is_empty() {
            let seg16 = audio::to_16k_i16(&tail, rate);
            app.state::<Ctx>().stream_queue.lock().unwrap().push_back(seg16);
        }
        app.state::<Ctx>().stream_done.store(true, Ordering::SeqCst);
    }

    let captured = audio::finish(rec);
    process_audio(app, cfg, captured.samples, from_ui, skip_llm).await;
}

/// 录音结束后的处理流水线（识别 → AI 优化 → 输入）；重试也走这里
pub async fn process_audio(
    app: AppHandle,
    cfg: Config,
    samples: Vec<i16>,
    from_ui: bool,
    skip_llm: bool,
) {
    let streaming = app.state::<Ctx>().stream_active.load(Ordering::SeqCst);
    let llm_active = cfg.llm.enabled && !skip_llm && !cfg.llm.base_url.trim().is_empty();
    // 本代会话标识：若处理期间用户开始了新录音，本代结果作废，不再输入
    let gen = app.state::<Ctx>().run_gen.load(Ordering::SeqCst);

    // 极短录音视为误触，温和忽略（不识别、不写入历史）
    let duration_secs = samples.len() as f64 / 16_000.0;
    if duration_secs < 0.8 {
        emit_status(&app, "done", "已忽略（录音太短）", false);
        hide_later(&app, 1400);
        return;
    }

    let asr_note = if streaming {
        "整理分段识别结果…"
    } else if cfg.asr.provider == "local" {
        "语音识别中（本地模型，首次加载需数秒）…"
    } else {
        "语音识别中…"
    };
    emit_status(&app, "transcribing", asr_note, false);
    let t_asr = Instant::now();

    let raw = if streaming {
        // 等待分段 worker 处理完队列（上限 30 秒）
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if app.state::<Ctx>().stream_finished.load(Ordering::SeqCst) {
                break;
            }
            if Instant::now() > deadline {
                eprintln!("[speaknow] 等待流式分段超时");
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let joined = {
            let state = app.state::<Ctx>();
            let texts = state.stream_texts.lock().unwrap();
            let joiner = if cfg.asr.language == "en" { " " } else { "" };
            texts.join(joiner)
        };
        if joined.trim().is_empty() {
            // 兜底：整段识别
            asr::transcribe(&app, &cfg.asr, &samples).await
        } else {
            Ok(joined)
        }
    } else {
        asr::transcribe(&app, &cfg.asr, &samples).await
    };

    let raw = match raw {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[speaknow] ASR 失败: {e:#}");
            // 保留音频供「重试」
            *app.state::<Ctx>().last_audio.lock().unwrap() =
                Some((samples.clone(), from_ui));
            let _ = app.emit("sn-retryable", true);
            finish_status(
                &app,
                "error",
                &format!("语音识别失败：{e:#}"),
                3500,
                cfg.general.sound_feedback,
            );
            return;
        }
    };
    let asr_ms = t_asr.elapsed().as_millis() as u64;
    {
        let engine = if cfg.asr.provider == "local" {
            format!("local/{}", cfg.asr.local_model)
        } else {
            format!("{}/{}", cfg.asr.provider, cfg.asr.model)
        };
        let rtf = if asr_ms > 0 && duration_secs > 0.0 {
            format!("，实时率 {:.1}×", duration_secs * 1000.0 / asr_ms as f64)
        } else {
            String::new()
        };
        crate::trace_pipeline(
            &app,
            &format!(
                "识别耗时 {asr_ms}ms（音频 {duration_secs:.1}s{rtf}，{engine}，{}字）",
                raw.chars().count()
            ),
        );
    }

    // 语气词清理（"嗯/呃/yeah" 等口头音与呼吸声幻觉）
    let raw = if cfg.asr.strip_fillers {
        crate::text_clean::strip_fillers(&raw)
    } else {
        raw
    };

    if raw.trim().is_empty() {
        *app.state::<Ctx>().last_audio.lock().unwrap() =
            Some((samples.clone(), from_ui));
        let _ = app.emit("sn-retryable", true);
        finish_status(
            &app,
            "error",
            "未识别到语音内容，可点「重试」或再录一次",
            2500,
            cfg.general.sound_feedback,
        );
        return;
    }

    // 第一时间把原始转写推给悬浮窗预览（AI 优化期间即可阅读）
    let _ = app.emit("sn-raw", serde_json::json!({ "text": raw }));

    // 会话已过期：新录音已开始，本代结果不再输入（防止旧文本晚到覆盖新输入）
    if gen != app.state::<Ctx>().run_gen.load(Ordering::SeqCst) {
        crate::trace_pipeline(&app, &format!("识别完成但已过期（gen {gen}），跳过输入"));
        finish_status(
            &app,
            "done",
            "已跳过（已被新的录音取代）",
            2000,
            false,
        );
        return;
    }

    let mut final_text = raw.clone();
    let mut llm_ms = 0u64;
    let mut llm_first_ms = 0u64;
    if llm_active {
        emit_status(&app, "optimizing", "AI 纠错与优化中…", false);
        let t_llm = Instant::now();
        let first_token = AtomicU64::new(0);
        match llm::optimize_streaming(&cfg.llm, &raw, &app, Some(&first_token)).await {
            Ok(t) if !t.trim().is_empty() => final_text = t,
            Ok(_) => {}
            Err(e) => {
                eprintln!("[speaknow] AI 优化失败: {e:#}");
                emit_status(&app, "optimizing", "AI 优化失败，使用原始识别结果…", false);
                thread::sleep(Duration::from_millis(600));
            }
        }
        llm_ms = t_llm.elapsed().as_millis() as u64;
        llm_first_ms = first_token.load(Ordering::SeqCst);
        let gen_ms = llm_ms.saturating_sub(llm_first_ms);
        let speed = if gen_ms > 200 {
            let cps = final_text.chars().count() as f64 * 1000.0 / gen_ms as f64;
            format!("，生成 {:.0}字/s", cps)
        } else {
            String::new()
        };
        crate::trace_pipeline(
            &app,
            &format!(
                "AI 优化耗时 {llm_ms}ms（首字 {llm_first_ms}ms，生成 {gen_ms}ms{speed}，{}，{}字）",
                cfg.llm.model,
                final_text.chars().count()
            ),
        );
        crate::trace_pipeline(
            &app,
            &format!("耗时对比｜识别 {asr_ms}ms｜优化 {llm_ms}ms（首字 {llm_first_ms}ms）｜合计 {}ms", asr_ms + llm_ms),
        );
    }

    if from_ui {
        let _ = inject::copy_only(&final_text);
        finish_status(
            &app,
            "done",
            "已复制到剪贴板（测试模式）",
            3200,
            cfg.general.sound_feedback,
        );
        return;
    }

    // 预览编辑模式：结果进入悬浮窗编辑器，确认后再输入
    if cfg.output.review && cfg.output.auto_paste {
        *app.state::<Ctx>().pending_review.lock().unwrap() = Some(PendingReview {
            raw: raw.clone(),
            final_text: final_text.clone(),
            asr_ms,
            llm_ms,
        });
        let _ = app.emit(
            "sn-review",
            serde_json::json!({ "text": final_text, "raw": raw, "llmUsed": llm_ms > 0 }),
        );
        emit_status(&app, "review", "可编辑 · Enter 输入 · Esc 取消", false);
        overlay::show_review(&app);
        return;
    }

    finish_and_input(&app, &cfg, &raw, &final_text, asr_ms, llm_ms, gen, llm_first_ms, duration_secs)
        .await;
}

/// 直接输入路径（历史 + 事件 + 粘贴）。gen 为本代会话代数：粘贴前若已有
/// 新录音开始（代数前移），放弃输入并提示「已跳过」，杜绝旧句子晚到落进光标。
#[allow(clippy::too_many_arguments)]
pub async fn finish_and_input(
    app: &AppHandle,
    cfg: &Config,
    raw: &str,
    final_text: &str,
    asr_ms: u64,
    llm_ms: u64,
    gen: u64,
    llm_first_ms: u64,
    audio_secs: f64,
) {
    history::push(app, raw, final_text, asr_ms, llm_ms);
    let _ = app.emit(
        "sn-result",
        serde_json::json!({
            "raw": raw,
            "final": final_text,
            "asrMs": asr_ms,
            "llmMs": llm_ms,
            "llmFirstMs": llm_first_ms,
            "audioSecs": audio_secs,
        }),
    );

    if cfg.output.auto_paste {
        let undo_hint = if cfg!(target_os = "macos") { "⌘Z" } else { "Ctrl+Z" };
        let ok_msg = if cfg.output.method == "clipboard" {
            format!("已输入到光标处（{undo_hint} 可撤销）")
        } else {
            "已输入到光标处".to_string()
        };
        // paste_text 内部要等待用户松键/焦点回归（可能 1~2 秒），放阻塞线程池；
        // 说话门限取 VAD 阈值（%）并设下限，探测到正在说话时暂缓输入
        let out_cfg = cfg.output.clone();
        let text = final_text.to_string();
        let device = cfg.audio.device.clone();
        let voice_gate = (cfg.audio.vad_threshold * 100.0).max(2.0);
        let h = app.clone();
        let superseded = Arc::new(move || {
            h.state::<Ctx>().run_gen.load(Ordering::SeqCst) != gen
        });
        let r = tauri::async_runtime::spawn_blocking(move || {
            inject::paste_text_checked(&out_cfg, &text, superseded, device.as_deref(), Some(voice_gate))
        })
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!("输入线程异常: {e}")));
        match r {
            Ok(true) => {
                crate::trace_pipeline(app, "已输入");
                finish_status(app, "done", &ok_msg, 3200, cfg.general.sound_feedback);
            }
            Ok(false) => {
                crate::trace_pipeline(app, "输入跳过（已被新录音取代，结果已复制到剪贴板）");
                finish_status(
                    app,
                    "done",
                    "已被新录音取代 · 结果已复制，可右键 / Ctrl+V 手动粘贴",
                    3200,
                    cfg.general.sound_feedback,
                );
            }
            Err(ref e) => {
                crate::trace_pipeline(app, &format!("输入失败：{e:#}"));
                finish_status(
                    app,
                    "error",
                    &format!("输入失败：{e:#}"),
                    4000,
                    cfg.general.sound_feedback,
                );
            }
        }
    } else {
        let _ = inject::copy_only(final_text);
        finish_status(app, "done", "已复制到剪贴板", 3200, cfg.general.sound_feedback);
    }
}

fn finish_status(app: &AppHandle, stage: &str, msg: &str, hide_after_ms: u64, sound: bool) {
    emit_status(app, stage, msg, sound);
    hide_later(app, hide_after_ms);
}

/// 延迟隐藏悬浮窗；期间若悬停（pinned）则计时暂停，若开始新录音则取消
pub fn hide_later(app: &AppHandle, ms: u64) {
    let handle = app.clone();
    thread::spawn(move || {
        let mut shown_ms: u64 = 0;
        loop {
            thread::sleep(Duration::from_millis(100));
            let recording = handle.state::<Ctx>().recording.lock().unwrap().is_some();
            if recording {
                return;
            }
            if handle.state::<Ctx>().overlay_pinned.load(Ordering::SeqCst) {
                continue; // 悬停阅读中，计时暂停
            }
            shown_ms += 100;
            if shown_ms >= ms {
                overlay::hide(&handle);
                emit_status(&handle, "idle", "", false);
                return;
            }
        }
    });
}

pub fn emit_status(app: &AppHandle, stage: &str, message: &str, sound: bool) {
    let _ = app.emit(
        "sn-status",
        serde_json::json!({ "stage": stage, "message": message, "sound": sound }),
    );
}
