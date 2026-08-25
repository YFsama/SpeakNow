import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import type { MetaPayload, Stage } from '../types';
import {
  cancelReview,
  confirmEdit,
  dismissOverlay,
  getConfig,
  optimizeText,
  overlayPin,
  overlaySetManual,
  restartElevated,
  retryLast,
} from '../api';

const BAR_COUNT = 26;
const COUNTDOWN_MS = 3200;
const WIN_NORMAL = { w: 520, h: 320 };
const WIN_REVIEW = { w: 560, h: 420 };

/* ---- WebAudio 合成提示音（无资源文件依赖） ---- */
let audioCtx: AudioContext | null = null;
function playTones(freqs: number[], noteDur = 0.085, gain = 0.09) {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    audioCtx ??= new Ctx();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const t0 = audioCtx.currentTime;
    freqs.forEach((f, i) => {
      const start = t0 + i * noteDur;
      const osc = audioCtx!.createOscillator();
      const g = audioCtx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(gain, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + noteDur);
      osc.connect(g);
      g.connect(audioCtx!.destination);
      osc.start(start);
      osc.stop(start + noteDur + 0.02);
    });
  } catch {
    /* 忽略音频失败 */
  }
}

function fmtMs(ms?: number | null): string {
  if (!ms) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/* AI 净生成速度：扣除首字等待后的字/秒 */
function fmtSpeed(chars: number, genMs: number): string {
  if (genMs < 200 || chars <= 0) return '';
  return `${Math.round((chars * 1000) / genMs)}字/s`;
}

/* ---- 长文本自适应：估算渲染行数（卡片内宽约 460px，14px 字号） ---- */
function estimateDisplayLines(text: string, widthPx: number): number {
  let n = 0;
  for (const ln of text.split('\n')) {
    let w = 0;
    for (const ch of ln) {
      // CJK 与全角按 14px，其余按 7.6px 估宽
      w += /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 14 : 7.6;
    }
    n += Math.max(1, Math.ceil(w / widthPx));
  }
  return n;
}

/* ---- 词级 diff（支持中文按字、英文按词） ---- */
interface Token {
  t: string;
  changed: boolean;
}

function tokenize(s: string): string[] {
  return s.match(/[\u4e00-\u9fff]|[A-Za-z0-9]+|\s+|[^\s\w]/g) ?? [];
}

function diffTokens(raw: string, final: string): Token[] {
  const a = tokenize(raw);
  const b = tokenize(final);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Token[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: b[j], changed: false });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      out.push({ t: b[j], changed: true });
      j++;
    }
  }
  while (j < m) {
    out.push({ t: b[j], changed: true });
    j++;
  }
  return out;
}

function TokenText({ tokens, animate }: { tokens: Token[]; animate: boolean }) {
  let k = 0;
  return (
    <>
      {tokens.map((tok, idx) => {
        if (/^\s+$/.test(tok.t)) return tok.t;
        const delay = animate ? `${Math.min(k++ * 18, 900)}ms` : undefined;
        return (
          <span
            key={idx}
            className={`word-in ${tok.changed ? 'word-changed' : ''}`}
            style={delay ? { animationDelay: delay } : undefined}
          >
            {tok.t}
          </span>
        );
      })}
    </>
  );
}

export default function Overlay() {
  const [stage, setStage] = useState<Stage>('idle');
  const [message, setMessage] = useState('');
  const [meta, setMeta] = useState<MetaPayload | null>(null);
  const [target, setTarget] = useState('');
  const [rawText, setRawText] = useState('');
  const [partial, setPartial] = useState('');
  const [result, setResult] = useState('');
  const [resultId, setResultId] = useState(0);
  const [usedLlm, setUsedLlm] = useState(false);
  const [timing, setTiming] = useState<{
    asr?: number | null;
    llm?: number | null;
    first?: number | null;
    audioSecs?: number | null;
  }>({});
  const [levels, setLevels] = useState<number[]>(() => Array(BAR_COUNT).fill(0));
  const [secs, setSecs] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [aboveInput, setAboveInput] = useState(true);
  const [retryable, setRetryable] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [editText, setEditText] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /* AI 流式输出：正文逐字累计 + 思考型模型的推理片段 */
  const [llmText, setLlmText] = useState('');
  const [llmThinking, setLlmThinking] = useState('');
  const llmStreamRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage>('idle');
  stageRef.current = stage;
  const editorRef = useRef<HTMLTextAreaElement>(null);

  /* 悬浮窗固定深色玻璃风（不随浅色主题变白）；仅缩放跟随配置 */
  useEffect(() => {
    const apply = () => {
      getConfig().then((c) => {
        document.body.style.zoom = String(c.general.fontScale || 1);
      });
    };
    apply();
    const un = listen('sn-config-changed', apply);
    return () => {
      un.then((f) => f());
    };
  }, []);

  /* AI 流式输出：逐字上屏并滚到最新 */
  useEffect(() => {
    const un = listen<{ kind: string; delta?: string; text?: string }>('sn-llm-delta', (e) => {
      if (e.payload.kind === 'content' && e.payload.text !== undefined) {
        setLlmText(e.payload.text);
      } else if (e.payload.kind === 'reasoning' && e.payload.delta) {
        setLlmThinking((t) => (t + e.payload.delta).slice(-160));
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const el = llmStreamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [llmText]);

  /* 预览编辑模式：放大窗口并聚焦输入框 */
  useEffect(() => {
    const win = getCurrentWindow();
    if (stage === 'review') {
      void win.setSize(new LogicalSize(WIN_REVIEW.w, WIN_REVIEW.h));
      setTimeout(() => editorRef.current?.focus(), 60);
    } else if (stageRef.current !== 'review') {
      // 其他阶段恢复默认尺寸
    }
  }, [stage]);

  useEffect(() => {
    if (stage !== 'review') {
      void getCurrentWindow().setSize(new LogicalSize(WIN_NORMAL.w, WIN_NORMAL.h));
    }
  }, [stage === 'review']);

  // 完成阶段长文本：按估算行数自适应窗口高度（320~560px），结果区可滚动阅读
  const doneLines = stage === 'done' && result ? estimateDisplayLines(result, 460) : 0;
  const doneTextH = Math.min(Math.max(Math.round(doneLines * 26.6), 64), 400);
  useEffect(() => {
    if (stage !== 'done' || !result) return;
    const h = Math.min(Math.max(196 + doneTextH, WIN_NORMAL.h), 560);
    void getCurrentWindow().setSize(new LogicalSize(WIN_NORMAL.w, h));
  }, [stage, result, doneTextH]);

  useEffect(() => {
    const un1 = listen<{ stage: Stage; message: string; sound?: boolean }>(
      'sn-status',
      (e) => {
        const p = e.payload;
        setStage(p.stage);
        setMessage(p.message ?? '');
        if (p.stage === 'recording') {
          setSecs(0);
          setRawText('');
          setPartial('');
          setResult('');
          setUsedLlm(false);
          setTiming({});
          setLevels(Array(BAR_COUNT).fill(0));
        }
        // 新一轮 AI 优化开始 / 离开优化阶段：清空流式缓冲
        if (p.stage === 'optimizing' || p.stage === 'recording') {
          setLlmText('');
          setLlmThinking('');
        }
        if (p.sound) {
          if (p.stage === 'recording') playTones([620, 880]);
          else if (p.stage === 'done') playTones([880, 1175, 1568], 0.07);
          else if (p.stage === 'error') playTones([340, 230], 0.12);
        }
      },
    );
    const un2 = listen<MetaPayload>('sn-meta', (e) => setMeta(e.payload));
    const un3 = listen<{ text: string }>('sn-raw', (e) => setRawText(e.payload.text));
    const un4 = listen<{ text: string }>('sn-partial', (e) => setPartial(e.payload.text));
    const un5 = listen<{
      raw: string;
      final: string;
      asrMs?: number | null;
      llmMs?: number | null;
      llmFirstMs?: number | null;
      audioSecs?: number | null;
    }>('sn-result', (e) => {
      setResult(e.payload.final || e.payload.raw);
      setUsedLlm((e.payload.llmMs ?? 0) > 0 && e.payload.final !== e.payload.raw);
      setTiming({
        asr: e.payload.asrMs,
        llm: e.payload.llmMs,
        first: e.payload.llmFirstMs,
        audioSecs: e.payload.audioSecs,
      });
      setResultId((n) => n + 1);
    });
    const un6 = listen<{ text: string; raw: string; llmUsed: boolean }>(
      'sn-review',
      (e) => {
        setEditText(e.payload.text);
        setUsedLlm(e.payload.llmUsed);
      },
    );
    const un7 = listen<number>('sn-level', (e) => {
      setLevels((prev) => {
        const next = prev.slice(1);
        next.push(Math.max(0.05, Math.min(1, e.payload * 3.5)));
        return next;
      });
    });
    const un8 = listen<{ title: string; above?: boolean }>('sn-target', (e) => {
      setTarget(e.payload.title || '');
      setAboveInput(e.payload.above !== false);
    });
    const un9 = listen<boolean>('sn-retryable', (e) => {
      setRetryable(!!e.payload);
      if (e.payload) setRetrying(false);
    });
    const timer = setInterval(() => {
      if (stageRef.current === 'recording') setSecs((s) => +(s + 0.2).toFixed(1));
    }, 200);
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
      un3.then((f) => f());
      un4.then((f) => f());
      un5.then((f) => f());
      un6.then((f) => f());
      un7.then((f) => f());
      un8.then((f) => f());
      un9.then((f) => f());
      clearInterval(timer);
    };
  }, []);

  const onEnter = () => {
    setHovered(true);
    void overlayPin(true);
  };
  const onLeave = () => {
    setHovered(false);
    void overlayPin(false);
  };

  const onConfirm = async () => {
    if (!editText.trim() || confirming) return;
    setConfirming(true);
    try {
      await confirmEdit(editText);
    } catch {
      setConfirming(false);
    }
  };

  const onReoptimize = async () => {
    if (optimizing || !editText.trim()) return;
    setOptimizing(true);
    try {
      const t = await optimizeText(editText);
      setEditText(t);
    } catch {
      /* 失败静默，保留原文 */
    } finally {
      setOptimizing(false);
    }
  };

  if (stage === 'idle') return <div className="h-screen w-screen" />;

  const doneTokens =
    stage === 'done' && result
      ? diffTokens(usedLlm && rawText ? rawText : result, result)
      : [];

  // 阶段主题色描边：录音=玫红 识别=天蓝 优化=靛紫 完成=翠绿 审阅=琥珀 出错=红
  const glow =
    stage === 'recording'
      ? 'from-rose-500/55 via-red-500/25 to-rose-500/55'
      : stage === 'optimizing'
        ? 'from-indigo-400/45 via-violet-500/25 to-indigo-400/45'
        : stage === 'done'
          ? 'from-emerald-400/45 via-teal-400/25 to-emerald-400/45'
          : stage === 'error'
            ? 'from-red-500/50 via-orange-500/25 to-red-500/50'
            : stage === 'review'
              ? 'from-amber-400/50 via-orange-400/25 to-amber-400/50'
              : 'from-sky-500/40 via-indigo-500/25 to-sky-500/40';

  return (
    <div
      className="flex h-screen w-screen items-start justify-center pt-4"
      onClick={stage === 'review' ? undefined : dismissOverlay}
    >
      <div
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        className={`anim-pop relative w-[500px] rounded-[22px] bg-gradient-to-r ${glow} p-[1.5px] shadow-[0_24px_70px_-22px_rgba(2,6,23,0.7)] transition-all duration-300 ${
          hovered ? 'brightness-[1.08] shadow-[0_28px_80px_-20px_rgba(2,6,23,0.75)]' : ''
        }`}
        style={stage === 'review' ? { width: WIN_REVIEW.w - 20 } : undefined}
      >
        {/* 锚点箭头：指向下方输入框（卡片悬于输入框上方时） */}
        {stage !== 'review' && (
          <span
            className={`pointer-events-none absolute left-10 z-10 h-0 w-0 border-x-[8px] border-x-transparent ${
              aboveInput
                ? '-bottom-[7px] border-t-[8px] border-t-[#12142a]'
                : '-top-[7px] border-b-[8px] border-b-[#12142a]'
            }`}
            aria-hidden
          />
        )}
        <div
          className="relative overflow-hidden rounded-[21px] px-5 py-4"
          style={{
            background:
              'linear-gradient(160deg, rgba(40,44,80,0.97) 0%, rgba(21,23,46,0.97) 42%, rgba(13,14,30,0.98) 100%)',
            boxShadow:
              'inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(0,0,0,0.45), inset 0 0 0 1px rgba(255,255,255,0.03)',
          }}
        >
          {/* 玻璃斜向高光（模拟毛玻璃反光面） */}
          <span
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'linear-gradient(115deg, rgba(255,255,255,0.11) 0%, rgba(255,255,255,0.035) 30%, rgba(255,255,255,0) 48%)',
            }}
            aria-hidden
          />
          {/* 上下文条：可拖拽把手 · 目标应用（模型链路在识别/优化阶段各自展示，避免重复） */}
          <div
            data-tauri-drag-region
            onPointerDown={() => void overlaySetManual(true)}
            title="按住可拖动卡片，拖动后本次会话固定位置"
            className="mb-3.5 flex cursor-move items-center gap-2 rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-1.5 text-[10px] text-slate-500 transition hover:bg-white/[0.05]"
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="9" cy="6" r="2" /><circle cx="15" cy="6" r="2" />
              <circle cx="9" cy="12" r="2" /><circle cx="15" cy="12" r="2" />
              <circle cx="9" cy="18" r="2" /><circle cx="15" cy="18" r="2" />
            </svg>
            <span data-tauri-drag-region className="min-w-0 truncate font-medium tracking-wide">
              SpeakNow
            </span>
            {target && (
              <span
                data-tauri-drag-region
                className="ml-auto flex min-w-0 shrink-0 items-center gap-1 rounded-full border border-sky-400/20 bg-sky-400/[0.07] px-2 py-0.5 text-[9.5px] text-sky-300/90"
                title={`文字将输入到：${target}`}
              >
                <span className="opacity-60">将输入到</span>
                <span className="max-w-[110px] truncate font-medium">{target}</span>
              </span>
            )}
          </div>
          {(stage === 'done' || stage === 'error') && (
            <span
              key={`${stage}-${resultId}`}
              className={`countdown-bar absolute bottom-0 left-0 h-[2px] ${
                stage === 'done'
                  ? 'bg-gradient-to-r from-emerald-400 to-sky-400'
                  : 'bg-gradient-to-r from-red-400 to-amber-400'
              }`}
              style={{
                animationDuration: `${COUNTDOWN_MS}ms`,
                animationPlayState: hovered ? 'paused' : 'running',
              }}
              aria-hidden
            />
          )}

          {stage === 'recording' && (
            <div className="anim-rise">
              <div className="flex items-center gap-3">
                <span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-indigo-600 shadow-lg shadow-sky-500/30">
                  <span className="absolute inset-0 animate-ping rounded-full bg-sky-500/25" />
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <rect x="9" y="2.5" width="6" height="12" rx="3" fill="white" />
                    <path
                      d="M5 12a7 7 0 0 0 14 0"
                      stroke="white"
                      strokeWidth="2"
                      strokeLinecap="round"
                      fill="none"
                    />
                    <path
                      d="M12 19v2.5"
                      stroke="white"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
                <div>
                  <div className="text-[14px] font-semibold leading-5 text-slate-100">
                    正在聆听…
                  </div>
                  <div className="text-[11px] leading-4 text-slate-500">
                    {meta?.skip ? '快速模式 · 不经 AI 优化' : meta?.asrModel || ''}
                  </div>
                </div>
                <span className="ml-auto font-mono text-[13px] tabular-nums text-slate-400">
                  {secs.toFixed(1)}s
                </span>
              </div>
              <div className="mt-3 flex h-9 items-center gap-[3px]">
                {levels.map((v, i) => (
                  <span
                    key={i}
                    className="flex-1 rounded-full bg-gradient-to-t from-sky-500/90 to-indigo-400/90 transition-[height,opacity] duration-100"
                    style={{
                      height: `${Math.max(5, v * 34)}px`,
                      opacity: 0.35 + v * 0.65,
                      boxShadow: v > 0.5 ? '0 0 8px rgba(56,189,248,0.45)' : undefined,
                    }}
                  />
                ))}
              </div>
              {/* 流式实时字幕 */}
              {partial && (
                <div className="mt-2 flex max-h-14 flex-col justify-end overflow-hidden text-[13px] leading-6 text-slate-300">
                  <div className="line-clamp-2">{partial}</div>
                </div>
              )}
              <div className="mt-1.5 text-center text-[11px] text-slate-500">
                {message || '再次按下快捷键结束'}
              </div>
            </div>
          )}

          {stage === 'transcribing' && !rawText && !partial && (
            <div className="anim-rise">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-500/15">
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-sky-400/30 border-t-sky-400" />
                </span>
                <div>
                  <div className="text-[13.5px] font-medium text-slate-200">
                    语音识别中…
                  </div>
                  <div className="text-[11px] text-slate-500">{meta?.asrModel}</div>
                </div>
              </div>
              <div className="mt-3.5 space-y-2 pl-11">
                <div className="skeleton h-3 w-[86%]" />
                <div className="skeleton h-3 w-[64%]" />
                <div className="skeleton h-3 w-[38%]" />
              </div>
            </div>
          )}

          {((stage === 'transcribing' && (rawText || partial)) || stage === 'optimizing') && (
            <div className="anim-rise">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-500/15">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"
                      fill="#818cf0"
                    />
                  </svg>
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1 text-[13.5px] font-medium text-slate-100">
                    {stage === 'optimizing' && llmText ? 'AI 优化结果' : 'AI 纠错与优化中'}
                    {!(stage === 'optimizing' && llmText) && (
                      <>
                        <span className="dot ml-0.5 inline-block h-1 w-1 rounded-full bg-indigo-400" />
                        <span
                          className="dot ml-0.5 inline-block h-1 w-1 rounded-full bg-indigo-400"
                          style={{ animationDelay: '0.15s' }}
                        />
                        <span
                          className="dot ml-0.5 inline-block h-1 w-1 rounded-full bg-indigo-400"
                          style={{ animationDelay: '0.3s' }}
                        />
                      </>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {meta?.llmModel ? `${meta.asrModel} → ${meta.llmModel}` : ''}
                  </div>
                </div>
              </div>

              {stage === 'optimizing' && llmText ? (
                /* 流式正文：逐字增长 + 光标，自动滚到最新 */
                <div
                  ref={llmStreamRef}
                  className="sn-scroll mt-2.5 max-h-[170px] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-indigo-400/15 bg-indigo-500/[0.06] px-3 py-2 text-[13.5px] leading-[1.85] text-slate-100"
                >
                  {llmText}
                  <span className="llm-cursor text-indigo-300">▍</span>
                </div>
              ) : stage === 'optimizing' && llmThinking ? (
                /* 思考型模型：正文未出，先暗色展示思考片段 */
                <div className="mt-2.5 rounded-lg border border-white/[0.05] bg-black/20 px-3 py-2">
                  <div className="text-[10px] text-slate-600">深度思考中…</div>
                  <div className="mt-0.5 line-clamp-2 break-all text-[11px] leading-5 text-slate-500">
                    {llmThinking}
                  </div>
                </div>
              ) : (
                <div className="relative mt-3 max-h-[84px] overflow-hidden pl-11 text-[13px] leading-6 text-slate-400/90">
                  {rawText || partial}
                  <span
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-[rgba(16,17,38,0.97)] to-transparent"
                    aria-hidden
                  />
                </div>
              )}

              {stage === 'optimizing' && llmText && (
                <div className="mt-1.5 line-clamp-1 pl-1 text-[10px] text-slate-600">
                  原文：{rawText}
                </div>
              )}
            </div>
          )}

          {stage === 'review' && (
            <div className="anim-rise">
              <div className="mb-2 flex items-center gap-2.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-500/15 text-[11px] text-amber-400">
                  ✎
                </span>
                <span className="text-[12.5px] font-medium text-amber-300">
                  确认输入
                </span>
                {usedLlm && (
                  <span className="rounded-full border border-indigo-400/25 bg-indigo-400/10 px-2 py-0.5 text-[10px] text-indigo-300">
                    AI 已优化 · 可继续修改
                  </span>
                )}
                <span className="ml-auto text-[10px] text-slate-600">
                  Enter 输入 · Shift+Enter 换行 · Esc 取消
                </span>
              </div>
              <textarea
                ref={editorRef}
                value={editText}
                rows={7}
                spellCheck={false}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void onConfirm();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    void cancelReview();
                  }
                }}
                className="w-full resize-none rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-[13.5px] leading-7 text-slate-100 outline-none transition hover:border-white/[0.18] focus:border-sky-500/60 focus:ring-2 focus:ring-sky-500/15"
              />
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  disabled={optimizing || !editText.trim()}
                  onClick={onReoptimize}
                  className="rounded-full border border-white/10 bg-black/25 px-3.5 py-1.5 text-[12px] text-slate-300 transition hover:border-white/25 disabled:opacity-50"
                >
                  {optimizing ? '优化中…' : '✨ 重新优化'}
                </button>
                <button
                  type="button"
                  onClick={() => void cancelReview()}
                  className="rounded-full border border-white/10 bg-black/25 px-3.5 py-1.5 text-[12px] text-slate-400 transition hover:border-white/25"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={!editText.trim() || confirming}
                  onClick={onConfirm}
                  className="ml-auto rounded-lg bg-gradient-to-r from-sky-500 to-indigo-500 px-4 py-1.5 text-[12px] font-medium text-white shadow-lg shadow-sky-500/25 transition hover:brightness-110 active:scale-[0.97] disabled:opacity-50"
                >
                  {confirming ? '输入中…' : '↵ 输入'}
                </button>
              </div>
            </div>
          )}

          {stage === 'done' && (
            <div className="anim-rise">
              <div className="flex items-center gap-2.5">
                <span className="anim-pop flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-[12px] text-emerald-400 ring-2 ring-emerald-500/20">
                  ✓
                </span>
                <span className="text-[13px] font-medium text-emerald-300">
                  {message || '完成'}
                </span>
                {usedLlm && (
                  <span className="rounded-full border border-indigo-400/25 bg-indigo-400/10 px-2 py-0.5 text-[10px] text-indigo-300">
                    AI 已优化
                  </span>
                )}
              </div>
              {result && (
                <div
                  className="sn-scroll relative mt-3 overflow-y-auto whitespace-pre-wrap break-words text-[14px] leading-[1.9] text-slate-100"
                  style={{ maxHeight: doneTextH }}
                >
                  <TokenText key={`final-${resultId}`} tokens={doneTokens} animate />
                </div>
              )}
              <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-2 text-[10px] text-slate-600">
                <span className="flex flex-wrap items-center gap-2.5 font-mono">
                  {timing.asr ? (
                    <span>
                      识别 {fmtMs(timing.asr)}
                      {timing.audioSecs && timing.asr > 0 ? (
                        <span className="text-slate-500">
                          {' '}
                          · {(timing.audioSecs * 1000 / timing.asr).toFixed(1)}×
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                  {timing.llm ? (
                    <span>
                      优化 {fmtMs(timing.llm)}
                      {timing.first && result ? (
                        <span className="text-slate-500">
                          {' '}
                          · {fmtSpeed(result.length, timing.llm - (timing.first || 0))}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                  {timing.asr && timing.llm ? (
                    <span className="text-slate-500">合计 {fmtMs(timing.asr + timing.llm)}</span>
                  ) : null}
                </span>
                <span>悬停可暂停 · 点击关闭</span>
              </div>
            </div>
          )}

          {stage === 'error' && (
            <div className="anim-rise">
              <div className="flex items-start gap-3 py-0.5">
                <span className="anim-pop mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-[13px] font-bold text-red-400 ring-2 ring-red-500/20">
                  !
                </span>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="text-[13px] leading-5 text-red-300">{message}</div>
                  {message.includes('管理员') && (
                    <div className="mt-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          void restartElevated().catch(() => {});
                        }}
                        className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-amber-500/90 to-orange-500/90 px-3.5 py-1.5 text-[12px] font-medium text-white shadow-lg shadow-amber-500/20 transition hover:brightness-110 active:scale-[0.97]"
                      >
                        🛡 以管理员身份重启 SpeakNow
                      </button>
                    </div>
                  )}
                  {retryable && (
                    <div className="mt-2.5 flex items-center gap-2">
                      <button
                        type="button"
                        disabled={retrying}
                        onClick={async () => {
                          setRetrying(true);
                          try {
                            await retryLast();
                          } catch {
                            setRetrying(false);
                          }
                        }}
                        className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-red-500/80 to-orange-500/80 px-3.5 py-1.5 text-[12px] font-medium text-white shadow-lg shadow-red-500/20 transition hover:brightness-110 active:scale-[0.97] disabled:opacity-60"
                      >
                        {retrying ? (
                          <>
                            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                            重试中…
                          </>
                        ) : (
                          <>↻ 用刚录的音频重试</>
                        )}
                      </button>
                      <span className="text-[10.5px] text-slate-600">无需重新说话</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
