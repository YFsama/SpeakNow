import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import type { Config, MetaPayload, Stage } from '../types';
import { TRANSLATE_LANGS, langName, resolvedLlmCreds } from '../types';
import {
  cancelReview,
  confirmEdit,
  copyText,
  dismissOverlay,
  getConfig,
  ocrCapture,
  ocrPaste,
  openSettings,
  optimizeText,
  overlayPin,
  overlaySetManual,
  restartElevated,
  retryLast,
  translateAnnounce,
  translateRetarget,
  translateText,
  translateReplace,
} from '../api';

const BAR_COUNT = 26;
const COUNTDOWN_MS = 3200;
/* 窗口须比卡片宽出两圈完整阴影余量（两侧各 30px）：
   旧版 520 窗口装 500 卡片，仅 10px 余量，阴影被窗口矩形硬切出不自然断层 */
const WIN_NORMAL = { w: 560, h: 320 };
const WIN_REVIEW = { w: 600, h: 420 };
const CARD_W_REVIEW = 540;

const MODE_LABELS: Record<string, string> = {
  correct: '仅纠错',
  polish: '纠错 + 润色',
  prompt: '编程指令',
  translate: '翻译',
};

/* sn-llm-delta 载荷：scope 标记流的归属链路（"llm"=听写优化 / 设置页重优化，
   "translate"=划词 · 复制即翻译 · 输入翻译工作台）。各消费端按 scope 分流，
   审阅重优化与划词翻译真并发时各归各卡、互不串字（契约 C2）；
   scope 缺省视作 "llm"，兼容未携带该字段的旧后端 */
type LlmDelta = { kind: string; delta?: string; text?: string; scope?: string };

/* sn-partial 载荷：text=已完成段的拼接字幕（旧字段，语义不变）；segs=已
   定稿段数；last=最后一段原文（后端以 trim 后段落拼接，text 恒以 last 结
   尾）——供段尾切分渲染「暂存样式」。segs/last 缺省（旧后端）时前端归一
   化为 0/''，整体按普通样式渲染，行为与旧版一致 */
type PartialPayload = { text: string; segs?: number; last?: string };
/* 前端持有的 partial 状态：segs/last 归一化必有值 */
type PartialState = { text: string; segs: number; last: string };

/* 段尾切分：last 命中 text 末尾时切出 head（已定稿段）/ tail（最后一段 →
   暂存样式）。不命中（旧后端无 last / 极端拼接差异）则整体作为 head 正常
   渲染——endsWith/slice 均按 UTF-16 码元切分，与命中判定口径一致 */
function splitPartialTail(p: { text: string; last: string }): { head: string; tail: string } {
  if (p.last && p.text.endsWith(p.last)) {
    return { head: p.text.slice(0, p.text.length - p.last.length), tail: p.last };
  }
  return { head: p.text, tail: '' };
}

/* 划词翻译卡片状态（独立于听写 stage 机器：由 sn-translate-* 事件驱动） */
interface TransCard {
  text: string;
  target: string;
  /** 第二目标语言代码（原文已是目标语时改译为此语言；空 = 未启用） */
  second: string;
  /** 会话代数：result/error 事件的 gen 更旧时忽略（旧会话迟到结果不覆盖新卡片） */
  gen: number;
  status: 'streaming' | 'done' | 'error';
  stream: string;
  thinking: string;
  final: string;
  error: string;
  ms: number;
  firstMs: number;
  autoCopied: boolean;
  /** 「识别后自动复制」开启但写入剪贴板失败（被占用等）：徽标转红提示手动复制 */
  copyFailed: boolean;
  /** 结构化翻译：结果事件携带的结构类型（JSON/YAML/键值），空 = 普通翻译 */
  structured: string;
}

/* 翻译卡片驻留时长（与后端 hide_later 的 10s 对齐；悬停钉住时暂停） */
const TRANS_COUNTDOWN_MS = 10000;

/* 阶段色微光（卡片外圈短焦光晕的颜色，与描边渐变同色系）：
   取代旧版大范围灰色阴影——低透明长尾在 8bit alpha 量化下会出现色带，
   且色相单一的暗灰晕在浅色桌面上观感浑浊 */
const GLOW_COLORS: Record<string, string> = {
  recording: 'rgba(244,63,94,0.22)',
  transcribing: 'rgba(56,189,248,0.18)',
  optimizing: 'rgba(129,140,248,0.22)',
  done: 'rgba(52,211,153,0.20)',
  error: 'rgba(239,68,68,0.22)',
  review: 'rgba(251,191,36,0.20)',
  translate: 'rgba(52,211,153,0.20)',
};

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

/* 错误信息清洗：命令层抛出的错误串到前端常带 "Error:" 前缀，网关失败时还会
   嵌一整段 JSON 报文——去前缀并截断 160 字，避免错误卡被一屏报文淹没 */
function prettyError(e: unknown): string {
  let s = e instanceof Error ? e.message : String(e);
  s = s.replace(/^Error:\s*/, '').trim();
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/* 审阅编辑框 auto-grow：先 auto 还原再按 scrollHeight 长高，封顶 260px 后
   转内部滚动（与 OCR 编辑框同手法，基线 rows=7） */
function growReviewBox(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
}

/* ---- 长文本自适应：估算渲染行数（卡片内宽约 460px，14px 字号） ---- */
/* 宽度判定正则提升为模块常量：流式期间 estimateDisplayLines 高频执行，
   逐字符新建正则字面量会让引擎反复走编译路径（V8 有缓存但非零成本） */
const CJK_WIDTH_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/;
function estimateDisplayLines(text: string, widthPx: number): number {
  let n = 0;
  for (const ln of text.split('\n')) {
    let w = 0;
    for (const ch of ln) {
      // CJK 与全角按 14px，其余按 7.6px 估宽
      w += CJK_WIDTH_RE.test(ch) ? 14 : 7.6;
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
  // 超长文本（如 8k 字输出）下 (n+1)×(m+1) 的 DP 矩阵会分配数百 MB 并在完成
  // 瞬间卡住数秒：超限时放弃差异高亮，整段按普通文本渲染
  if (n * m > 1e6) return [{ t: final, changed: false }];
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

/* 完整入场动效（blur + 位移逐词入场）只给前若干个词：超长结果的后续词改用
   轻量淡入，避免完成瞬间同时驱动上千个 filter 动画把整页卡住 */
const WORD_IN_CAP = 120;

const TokenText = memo(function TokenText({
  tokens,
  animate,
}: {
  tokens: Token[];
  animate: boolean;
}) {
  let k = 0;
  return (
    <>
      {tokens.map((tok, idx) => {
        if (/^\s+$/.test(tok.t)) return tok.t;
        const i = k++;
        const full = !animate || i < WORD_IN_CAP;
        const delay = animate && full ? `${Math.min(i * 18, 900)}ms` : undefined;
        return (
          <span
            key={idx}
            className={`${full ? 'word-in' : 'word-in-fade'} ${
              tok.changed ? 'word-changed' : ''
            }`}
            style={delay ? { animationDelay: delay } : undefined}
          >
            {tok.t}
          </span>
        );
      })}
    </>
  );
});

/* 录音电平条：独立子组件持有 sn-level 监听（约 10Hz），
   电平跳动只重渲染这一排条，不再带动整张卡片重绘 */
function LevelBars() {
  const [levels, setLevels] = useState<number[]>(() => Array(BAR_COUNT).fill(0));
  useEffect(() => {
    const un = listen<number>('sn-level', (e) => {
      setLevels((prev) => {
        const next = prev.slice(1);
        next.push(Math.max(0.05, Math.min(1, e.payload * 3.5)));
        return next;
      });
    });
    return () => {
      un.then((f) => f());
    };
  }, []);
  return (
    <div className="mt-3 flex h-9 items-center gap-[3px]">
      {levels.map((v, i) => (
        <span
          key={i}
          /* scaleY 替代 height 过渡：只走合成器，不逐帧触发布局；
             静态微光替代按值切换的 boxShadow，避免每帧样式对象翻转。
             v>0.95 视为近削波：条身换琥珀色提醒音量顶着上限 */
          className={`flex-1 rounded-full transition-[transform,opacity] duration-100 ${
            v > 0.95 ? 'bg-amber-400' : 'bg-gradient-to-t from-sky-500/90 to-indigo-400/90'
          }`}
          style={{
            height: '34px',
            transformOrigin: 'bottom',
            transform: `scaleY(${Math.max(5, v * 34) / 34})`,
            opacity: 0.35 + v * 0.65,
            boxShadow: v > 0.95 ? '0 0 8px rgba(251,191,36,0.36)' : '0 0 8px rgba(56,189,248,0.32)',
          }}
        />
      ))}
    </div>
  );
}

/* 录音计时：独立子组件持有 200ms 定时器，秒数跳动只重渲染计时文本 */
function RecTimer() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSecs((s) => +(s + 0.2).toFixed(1)), 200);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="ml-auto font-mono text-[13px] tabular-nums text-slate-400">
      {secs.toFixed(1)}s
    </span>
  );
}

/* AI 流式输出隔离卡：sn-llm-delta 的逐 token 更新只重渲染本子组件，
   悬浮窗其余部分（上下文条、阶段描边、倒计时条）不再逐字重绘；
   完成态仍由父级监听 sn-result / sn-status 接管 */
const LlmStream = memo(function LlmStream({
  stage,
  meta,
  rawText,
  partial,
}: {
  stage: Stage;
  meta: MetaPayload | null;
  rawText: string;
  partial: string;
}) {
  /* AI 流式输出：正文逐字累计 + 思考型模型的推理片段 */
  const [llmText, setLlmText] = useState('');
  const [llmThinking, setLlmThinking] = useState('');
  const streamRef = useRef<HTMLDivElement>(null);
  /* 粘性滚动：用户上滚阅读后不再强制拉回底部，滚回底部附近自动恢复跟随 */
  const stickRef = useRef(true);

  // 新一轮 AI 优化开始 / 离开优化阶段：清空流式缓冲
  useEffect(() => {
    if (stage === 'optimizing' || stage === 'recording') {
      setLlmText('');
      setLlmThinking('');
    }
  }, [stage]);

  useEffect(() => {
    const un = listen<LlmDelta>('sn-llm-delta', (e) => {
      /* 只消费听写侧的流：翻译会话共用本频道（scope 见 LlmDelta 注释），
         并发时不得把译文增量写进听写优化卡 */
      if (e.payload.scope === 'translate') return;
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

  /* 自动滚到最新：只在用户本就停在底部附近（40px 内）时跟随；
     requestAnimationFrame 合帧（一帧最多滚一次，清理时取消挂起帧），
     目标位置未变则不写，避免逐 token 触发强制同步布局 */
  useEffect(() => {
    const el = streamRef.current;
    if (!el || !stickRef.current) return;
    const raf = requestAnimationFrame(() => {
      const top = el.scrollHeight - el.clientHeight;
      if (el.scrollTop !== top) el.scrollTop = top;
    });
    return () => cancelAnimationFrame(raf);
  }, [llmText]);

  return (
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
            {/* 三态标题：流式字幕是 ASR 识别而非 AI 阶段，避免误导用户以为已进优化 */}
            {stage === 'optimizing' && llmText
              ? 'AI 优化结果'
              : stage === 'transcribing'
                ? '语音识别中'
                : 'AI 纠错与优化中'}
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
            {/* 识别阶段 LLM 尚未介入，只报 ASR；进优化才展示完整链路 */}
            {stage === 'optimizing' && meta?.llmModel
              ? `${meta.asrModel} → ${meta.llmModel}`
              : (meta?.asrModel ?? '')}
          </div>
        </div>
      </div>

      {stage === 'optimizing' && llmText ? (
        /* 流式正文：逐字增长 + 光标，自动滚到最新 */
        <div
          ref={streamRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
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
  );
});

export default function Overlay() {
  const [stage, setStage] = useState<Stage>('idle');
  const [message, setMessage] = useState('');
  const [meta, setMeta] = useState<MetaPayload | null>(null);
  const [target, setTarget] = useState('');
  const [rawText, setRawText] = useState('');
  const [partial, setPartial] = useState<PartialState>({ text: '', segs: 0, last: '' });
  const [result, setResult] = useState('');
  const [resultId, setResultId] = useState(0);
  const [usedLlm, setUsedLlm] = useState(false);
  /* done 卡操作反馈：复制闪「已复制」/ 重新优化进行中 */
  const [doneCopied, setDoneCopied] = useState(false);
  const [doneReopt, setDoneReopt] = useState(false);
  /* 错误卡「复制错误信息」反馈 */
  const [errCopied, setErrCopied] = useState(false);
  const [timing, setTiming] = useState<{
    asr?: number | null;
    llm?: number | null;
    first?: number | null;
    audioSecs?: number | null;
  }>({});
  const [hovered, setHovered] = useState(false);
  const [aboveInput, setAboveInput] = useState(true);
  const [retryable, setRetryable] = useState(false);
  const [retrying, setRetrying] = useState(false);
  /* 录音期提示（临近最长时长自动结束等）：来自 sn-status 的 hint 型载荷，
     常规状态切换时清空 */
  const [recHint, setRecHint] = useState('');
  const [editText, setEditText] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /* 审阅窗口：原文（恢复用）、重优化模式覆盖、操作反馈、AI 配置 */
  const [reviewRaw, setReviewRaw] = useState('');
  const [reoptMode, setReoptMode] = useState('');
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [llmEnabled, setLlmEnabled] = useState(false);
  const [llmMode, setLlmMode] = useState('correct');
  const [translateTarget, setTranslateTarget] = useState('en');
  /* 划词翻译卡片 */
  const [trans, setTrans] = useState<TransCard | null>(null);
  const [transBusy, setTransBusy] = useState(false);
  const [transCopied, setTransCopied] = useState(false);
  const [transReplacing, setTransReplacing] = useState(false);
  const [transActionErr, setTransActionErr] = useState('');
  const [srcExpanded, setSrcExpanded] = useState(false);
  /* Esc 守存中间态：译文已写入剪贴板、卡片闪提示后延迟关闭（同 OCR 卡模式） */
  const [transSaved, setTransSaved] = useState(false);
  /* 截图取词（OCR）卡片 */
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrCard, setOcrCard] = useState<{ text: string; ms: number; copyFailed?: boolean } | null>(null);
  const [ocrCopied, setOcrCopied] = useState(false);
  const [ocrPasting, setOcrPasting] = useState(false);
  /* OCR 取词失败消息（语言包缺失 / 引擎失败）；提前到与其余 OCR 状态同处声明，
     供全局 Esc 兜底等更早出现的效果引用 */
  const [ocrErr, setOcrErr] = useState('');
  /* Esc 守存中间态：修改稿已写入剪贴板、卡片闪提示后延迟关闭 */
  const [ocrSaved, setOcrSaved] = useState(false);
  /* 可编辑正文：识别错字先改再用（复制/翻译/输入都取编辑后的文本） */
  const [ocrEdit, setOcrEdit] = useState('');
  const ocrEditRef = useRef<HTMLTextAreaElement>(null);
  /* 声音反馈开关（翻译完成音随配置；ref 避免监听器闭包过期） */
  const soundRef = useRef(true);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  /* 重新优化期间把流式累计文本直接写回审阅编辑框（不进 React 状态） */
  const reoptStreamRef = useRef(false);
  /* 重新优化期间最新一份流式累计文本（供渲染后补写与失败时保留部分结果） */
  const streamTextRef = useRef('');
  /* 界面缩放：body.zoom 放大卡片的同时窗口必须同步放大，否则卡片被窗口边缘裁切 */
  const zoomRef = useRef(1);
  /* 悬浮窗本地缩放乘子（Ctrl+滚轮调整，与全局 fontScale 相乘） */
  const overlayMultRef = useRef(1);
  /* 卡片驻留时长乘子（general.lingerMult，进度条动画与后端 hide 同步缩放） */
  const [lingerMult, setLingerMult] = useState(1);
  /* 双击复制豁免：双击的第二次 mousedown 会先摧毁已有手动选区并自动选中
     双击词，dblclick 时读 getSelection 恒非空、无法区分——只能在第一次
     mousedown（e.detail===1）记录「当时是否已有选区」，dblclick 按该标志判定 */
  const hadSelBeforeDbl = useRef(false);
  /* 翻译卡片镜像：sn-translate-error 等监听器需要读最新卡片状态做代数过滤
     与播音决策，避免监听器闭包里的过期 trans */
  const transRef = useRef<TransCard | null>(null);
  useEffect(() => {
    transRef.current = trans;
  }, [trans]);
  const winSize = (w: number, h: number) =>
    new LogicalSize(Math.round(w * zoomRef.current), Math.round(h * zoomRef.current));

  /* 悬浮窗固定深色玻璃风（不随浅色主题变白）；仅缩放跟随配置 */
  useEffect(() => {
    // 本地缩放乘子（Ctrl+滚轮调整，localStorage 持久）：与全局「界面缩放」
    // 相乘——悬浮窗常需要比设置窗更大的字号（远处瞄一眼字幕/译文）
    try {
      overlayMultRef.current = Number(localStorage.getItem('sn:overlayZoom')) || 1;
    } catch {
      /* localStorage 不可用：仅本次会话生效 */
    }
    const apply = (c: Config) => {
      zoomRef.current = c.general.fontScale || 1;
      document.body.style.zoom = String(zoomRef.current * overlayMultRef.current);
      soundRef.current = c.general.soundFeedback !== false;
      // 后端凭据组迁移会清空内联 llm.baseUrl，须按解析后的生效凭据判断
      // LLM 是否可用，否则迁移后审阅编辑器的「重新优化」会莫名消失
      setLlmEnabled(c.llm.enabled && !!resolvedLlmCreds(c).baseUrl.trim());
      setLlmMode(c.llm.mode);
      setTranslateTarget(c.llm.translateTarget || 'en');
      // 卡片驻留乘子：进度条动画与后端 hide_later 同步缩放
      setLingerMult(c.general.lingerMult || 1);
    };
    getConfig().then(apply);
    const un = listen('sn-config-changed', () => getConfig().then(apply));
    return () => {
      un.then((f) => f());
    };
  }, []);

  /* 悬浮窗 Ctrl+滚轮缩放：只改本地乘子（0.7~1.8），不动全局设置 */
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const cur = overlayMultRef.current;
      const next = Math.min(1.8, Math.max(0.7, cur - Math.sign(e.deltaY) * 0.05));
      if (next === cur) return;
      overlayMultRef.current = next;
      document.body.style.zoom = String((zoomRef.current || 1) * next);
      try {
        localStorage.setItem('sn:overlayZoom', String(next));
      } catch {
        /* 持久化失败不影响本次会话 */
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  /* 审阅窗口「重新优化」的流式回填：增量不进 React 状态（逐 token setState 会
     整卡重渲染审阅 UI），改为把事件携带的累计文本直接写入 textarea */
  useEffect(() => {
    const un = listen<LlmDelta>('sn-llm-delta', (e) => {
      if (
        !reoptStreamRef.current ||
        e.payload.scope === 'translate' || // 与划词翻译并发时互不串字（C2）
        e.payload.kind !== 'content' ||
        e.payload.text === undefined
      )
        return;
      streamTextRef.current = e.payload.text;
      if (editorRef.current && editorRef.current.value !== e.payload.text) {
        editorRef.current.value = e.payload.text;
        // 流式回填不经 React 状态：高度须在此同步调整
        growReviewBox(editorRef.current);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  /* 受控 textarea 在重渲染时会把 DOM 值拉回 editText（流式期间是旧值）：
     每次渲染后、绘制前把最新流式文本补写回去，保证逐字上屏连续无闪断 */
  useLayoutEffect(() => {
    if (!reoptStreamRef.current) return;
    const t = streamTextRef.current;
    if (t && editorRef.current && editorRef.current.value !== t) {
      editorRef.current.value = t;
      growReviewBox(editorRef.current);
    }
  });

  /* 预览编辑模式：放大窗口并聚焦输入框 */
  useEffect(() => {
    if (stage !== 'review') return;
    const win = getCurrentWindow();
    void win.setSize(winSize(WIN_REVIEW.w, WIN_REVIEW.h));
    const t = setTimeout(() => editorRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [stage]);

  /* 审阅编辑框随内容长高（封顶 260px 后内部滚动，复用 OCR 卡的 auto-height
     手法）；流式回填不经 React 短暂状态时的长高已由回填处直接调 growReviewBox */
  useEffect(() => {
    if (stage !== 'review') return;
    growReviewBox(editorRef.current);
  }, [stage, editText]);

  // 退出审阅或开始新一轮录音时恢复默认尺寸（完成阶段可能已把窗口自适应放大
  // 到 560px，不在录音时复位的话，长结果之后的下一轮会一直顶着放大的窗口）
  useEffect(() => {
    if (stage !== 'review') {
      void getCurrentWindow().setSize(winSize(WIN_NORMAL.w, WIN_NORMAL.h));
    }
  }, [stage === 'review', stage === 'recording']);

  // 完成阶段长文本：按估算行数自适应窗口高度（320~560px），结果区可滚动阅读。
  // 行数估算与词级 diff 开销不小（长文本可达数毫秒），用 useMemo 锁定在
  // [stage, result, …] 变化时重算：悬停进出等重渲染不再反复付这笔账
  const doneLines = useMemo(
    () => (stage === 'done' && result ? estimateDisplayLines(result, 460) : 0),
    [stage, result],
  );
  const doneTextH = useMemo(
    () => Math.min(Math.max(Math.round(doneLines * 26.6), 64), 400),
    [doneLines],
  );
  /* 词级 diff 结果：resultId 作新结果的复位键（即使文本相同也换新数组，
     配合 TokenText 的 key 重放入场动效） */
  const doneTokens = useMemo(
    () =>
      stage === 'done' && result
        ? diffTokens(usedLlm && rawText ? rawText : result, result)
        : [],
    [stage, result, usedLlm, rawText, resultId],
  );
  useEffect(() => {
    if (stage !== 'done' || !result) return;
    const h = Math.min(Math.max(196 + doneTextH, WIN_NORMAL.h), 560);
    void getCurrentWindow().setSize(winSize(WIN_NORMAL.w, h));
  }, [stage, result, doneTextH]);

  useEffect(() => {
    const un1 = listen<{ stage: Stage; message: string; sound?: boolean; hint?: boolean }>(
      'sn-status',
      (e) => {
        const p = e.payload;
        // hint 型状态（录音临近最长时长等，后端 watch 循环发出）：只刷新提示
        // 文案——常规路径的阶段切换与清场会把录音中的流式字幕等闪断
        if (p.hint) {
          setRecHint(p.message ?? '');
          return;
        }
        setRecHint('');
        setStage(p.stage);
        setMessage(p.message ?? '');
        // 听写接管 / 悬浮窗隐藏（含替换原文后的复位）：翻译与 OCR 卡片一并清场
        setTrans(null);
        setTransBusy(false);
        setTransActionErr('');
        setTransSaved(false); // 取消挂起的 Esc 守存延迟关闭，避免吞掉新一轮会话
        setOcrBusy(false);
        setOcrCard(null);
        setOcrSaved(false); // 取消可能挂起的 Esc 延迟关闭，避免吞掉新一轮会话
        if (p.stage === 'error') setErrCopied(false);
        if (p.stage === 'recording') {
          setRawText('');
          setPartial({ text: '', segs: 0, last: '' });
          setResult('');
          setUsedLlm(false);
          setTiming({});
          setNotice(null); // 清掉上一会话遗留的操作反馈（done 卡也会显示 notice）
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
    const un4 = listen<PartialPayload>('sn-partial', (e) =>
      setPartial({
        text: e.payload.text,
        segs: e.payload.segs ?? 0,
        last: e.payload.last ?? '',
      }),
    );
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
    const un6 = listen<{
      text: string;
      raw: string;
      llmUsed: boolean;
      asrMs?: number | null;
      llmMs?: number | null;
    }>('sn-review', (e) => {
      setEditText(e.payload.text);
      setReviewRaw(e.payload.raw);
      setUsedLlm(e.payload.llmUsed);
      // 耗时徽标与 done 卡同源（识别 X · 优化 Y；0/缺省的段前端省略）
      setTiming({ asr: e.payload.asrMs, llm: e.payload.llmMs, first: null, audioSecs: null });
      setNotice(null);
      // 保险：新审阅会话到来时清掉上一轮可能遗留的「确认中」状态
      setConfirming(false);
    });
    const un7 = listen<{ title: string; above?: boolean }>('sn-target', (e) => {
      setTarget(e.payload.title || '');
      setAboveInput(e.payload.above !== false);
    });
    const un8 = listen<boolean>('sn-retryable', (e) => {
      setRetryable(!!e.payload);
      if (e.payload) setRetrying(false);
    });
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
      un3.then((f) => f());
      un4.then((f) => f());
      un5.then((f) => f());
      un6.then((f) => f());
      un7.then((f) => f());
      un8.then((f) => f());
    };
  }, []);

  /* ---- 划词翻译卡片：生命周期事件 + 流式增量 ---- */
  useEffect(() => {
    const un1 = listen<{ gen: number; text: string; target: string; second?: string }>(
      'sn-translate-start',
      (e) => {
        setTrans({
          text: e.payload.text,
          target: e.payload.target,
          second: e.payload.second ?? '',
          gen: e.payload.gen,
          status: 'streaming',
          stream: '',
          thinking: '',
          final: '',
          error: '',
          ms: 0,
          firstMs: 0,
          autoCopied: false,
          copyFailed: false,
          structured: '',
        });
        setTransBusy(true);
        setTransCopied(false);
        setTransActionErr('');
        setSrcExpanded(false);
        setTransSaved(false); // 新会话接管旧卡：取消挂起的 Esc 守存延迟关闭
        // 翻译卡片接管悬浮窗：OCR 卡片让位（截图翻译一键链的切换点）
        setOcrBusy(false);
        setOcrCard(null);
        setOcrSaved(false); // 同 sn-status：取消挂起的 Esc 延迟关闭
      },
    );
    const un2 = listen<{
      gen: number;
      final: string;
      ms: number;
      firstMs: number;
      autoCopied?: boolean;
      copyFailed?: boolean;
      structured?: string;
    }>('sn-translate-result', (e) => {
      setTrans((prev) => {
        // 旧会话的迟到结果不覆盖新卡片（新 start 已把卡片重置为 streaming）
        if (!prev || e.payload.gen < prev.gen) return prev;
        return {
          ...prev,
          status: 'done',
          final: e.payload.final,
          stream: e.payload.final,
          ms: e.payload.ms,
          firstMs: e.payload.firstMs,
          autoCopied: !!e.payload.autoCopied,
          copyFailed: !!e.payload.copyFailed,
          structured: e.payload.structured ?? '',
        };
      });
      setTransBusy(false);
      if (soundRef.current) playTones([880, 1175, 1568], 0.07);
    });
    const un3 = listen<{ message: string; gen?: number }>('sn-translate-error', (e) => {
      const p = e.payload;
      const cur = transRef.current;
      // 会话错误（带 gen）按代数过滤：更旧的迟到错误直接忽略；卡片已不在
      // （Esc 作废 / 被新卡取代）也不再凭空重建错误卡。独立错误（取词失败
      // 等，无 gen）没有卡片可依附，仍然建卡提示。播音与建卡同一判定，
      // 避免 superseded 中止在窗口隐藏后还响一声错误音
      if (cur ? p.gen !== undefined && p.gen < cur.gen : p.gen !== undefined) return;
      setTrans((prev) =>
        prev
          ? { ...prev, status: 'error', error: p.message }
          : {
              text: '',
              target: '',
              second: '',
              gen: p.gen ?? 0,
              status: 'error',
              stream: '',
              thinking: '',
              final: '',
              error: p.message,
              ms: 0,
              firstMs: 0,
              autoCopied: false,
              copyFailed: false,
              structured: '',
            },
      );
      setTransBusy(false);
      setOcrBusy(false); // 截图翻译链在翻译阶段失败：OCR 卡片同样让位给错误卡
      if (soundRef.current) playTones([340, 230], 0.12);
    });
    /* 翻译会话的流式增量：仅消费 scope=translate 的流（听写优化/重优化共用本
       频道，并发时互不串字，C2），且仅卡片处于 streaming 时累计 */
    const un4 = listen<LlmDelta>('sn-llm-delta', (e) => {
      if (e.payload.scope !== 'translate') return;
      setTrans((prev) => {
        if (!prev || prev.status !== 'streaming') return prev;
        if (e.payload.kind === 'content' && e.payload.text !== undefined) {
          return { ...prev, stream: e.payload.text };
        }
        if (e.payload.kind === 'reasoning' && e.payload.delta) {
          return { ...prev, thinking: (prev.thinking + (e.payload.delta ?? '')).slice(-160) };
        }
        return prev;
      });
    });
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
      un3.then((f) => f());
      un4.then((f) => f());
    };
  }, []);

  /* 翻译卡片：Esc 关闭（完成态守存：译文先落剪贴板、闪提示后延迟关闭） */
  useEffect(() => {
    if (!trans) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        /* 完成态且有译文：译文不进剪贴板历史找不回，先把 final 写入剪贴板并
           闪提示，再延迟关闭；期间再按 Esc 立即关闭。trans 的字段进依赖是
           为了读到最新 final 而非旧闭包（同 OCR 卡的 ocrEdit 依赖） */
        if (trans.status === 'done' && trans.final.trim() && !transSaved) {
          void copyText(trans.final)
            .then(() => setTransSaved(true))
            .catch(() => {
              // 剪贴板被占用等失败：不谎报「已复制」，直接关闭
              setTrans(null);
              void dismissOverlay();
            });
          return;
        }
        setTrans(null);
        void dismissOverlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [!!trans, trans?.status, trans?.final, transSaved]);

  /* 翻译守存提示展示 900ms 后自动关闭；卡片被听写 / 新翻译接管时
     setTransSaved(false) 触发 cleanup 取消定时器，避免迟到的关闭吞掉新会话 */
  useEffect(() => {
    if (!transSaved) return;
    const t = setTimeout(() => {
      setTrans(null);
      void dismissOverlay();
    }, 900);
    return () => clearTimeout(t);
  }, [transSaved]);

  /* 全局 Esc 兜底：done/error 阶段没有专属 Esc 处理器，此处补齐关闭入口。
     翻译卡 / OCR 卡 / 审阅编辑框各自的 Esc 处理器会先行 preventDefault 并接管
     （关闭或守存），这里以「卡片在场即整体让位」+ defaultPrevented 双保险，
     无论监听器注册先后都不会双触发 */
  useEffect(() => {
    if (stage !== 'done' && stage !== 'error') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (trans || ocrBusy || ocrCard || ocrErr) return;
      e.preventDefault();
      void dismissOverlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage, !!trans, !!ocrBusy, !!ocrCard, !!ocrErr]);

  /* 翻译卡片：按内容自适应窗口高度（流式与完成共用一条估算） */
  const transBody = trans
    ? trans.status === 'done'
      ? trans.final
      : trans.status === 'streaming'
        ? trans.stream
        : ''
    : '';
  const transH = useMemo(() => {
    if (!trans) return WIN_NORMAL.h;
    if (trans.status === 'error') return WIN_NORMAL.h;
    const srcLines = trans.text ? estimateDisplayLines(trans.text, 430) * 0.5 : 0;
    const bodyLines = estimateDisplayLines(transBody || '…', 430);
    return Math.min(Math.max(232 + Math.round((srcLines + bodyLines) * 25), WIN_NORMAL.h), 620);
  }, [!!trans, trans?.status, trans?.text, transBody]);
  useEffect(() => {
    if (!trans) return;
    void getCurrentWindow().setSize(winSize(WIN_NORMAL.w, transH));
  }, [!!trans, transH]);

  /* 操作反馈自动消退 */
  useEffect(() => {
    if (!transCopied) return;
    const t = setTimeout(() => setTransCopied(false), 1600);
    return () => clearTimeout(t);
  }, [transCopied]);
  useEffect(() => {
    if (!transActionErr) return;
    const t = setTimeout(() => setTransActionErr(''), 3500);
    return () => clearTimeout(t);
  }, [transActionErr]);
  /* done 卡复制 / 错误卡复制反馈自动消退 */
  useEffect(() => {
    if (!doneCopied) return;
    const t = setTimeout(() => setDoneCopied(false), 1600);
    return () => clearTimeout(t);
  }, [doneCopied]);
  useEffect(() => {
    if (!errCopied) return;
    const t = setTimeout(() => setErrCopied(false), 1600);
    return () => clearTimeout(t);
  }, [errCopied]);

  /* ---- 截图取词（OCR）卡片：生命周期事件 + 动作 ---- */
  useEffect(() => {
    const un1 = listen('sn-ocr-start', () => {
      setOcrBusy(true);
      setOcrCard(null);
      setOcrErr('');
      setOcrCopied(false);
      setOcrSaved(false);
    });
    const un2 = listen<{ text: string; ms: number; copyFailed?: boolean }>('sn-ocr-result', (e) => {
      setOcrBusy(false);
      // copyFailed：「识别后自动复制」开启了但写入失败（剪贴板被占用）——
      // 卡片如实提示手动复制，否则用户粘贴出旧内容还以为识别错了
      setOcrCard({ text: e.payload.text, ms: e.payload.ms, copyFailed: !!e.payload.copyFailed });
      setOcrEdit(e.payload.text);
      if (soundRef.current) playTones([880, 1175, 1568], 0.07);
    });
    const un3 = listen<{ message: string }>('sn-ocr-error', (e) => {
      setOcrBusy(false);
      setOcrErr(e.payload.message);
      if (soundRef.current) playTones([340, 230], 0.12);
    });
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
      un3.then((f) => f());
    };
  }, []);

  const closeOcrCard = () => {
    setOcrBusy(false);
    setOcrCard(null);
    setOcrErr('');
    setOcrEdit('');
    setOcrSaved(false);
    void dismissOverlay();
  };

  const onOcrCopy = async () => {
    if (!ocrEdit.trim()) return;
    try {
      await copyText(ocrEdit);
      setOcrCopied(true);
    } catch (e) {
      setOcrErr(String(e));
    }
  };

  /* OCR 卡片「翻译」：切换到流式翻译卡片（语言条/复制/替换全沿用） */
  const onOcrTranslate = async () => {
    if (!ocrEdit.trim()) return;
    try {
      await translateAnnounce(ocrEdit);
    } catch (e) {
      setOcrErr(String(e));
    }
  };

  const onOcrPaste = async () => {
    if (!ocrEdit.trim() || ocrPasting) return;
    setOcrPasting(true);
    try {
      await ocrPaste(ocrEdit);
      // 后端粘贴成功后发 idle 状态，卡片由 sn-status 监听统一清场
    } catch (e) {
      setOcrErr(String(e));
    } finally {
      setOcrPasting(false);
    }
  };

  /* OCR 卡片：Esc 关闭（与翻译卡片同语义；有手改内容时先落剪贴板再关） */
  useEffect(() => {
    if (!ocrCard && !ocrBusy && !ocrErr) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        /* OCR 结果不进历史，直接丢弃找不回：编辑稿与识别原文有差异时，
           先把修改稿写入剪贴板并在卡片上闪提示，再延迟关闭；期间再按
           Esc 立即关闭。ocrEdit 进依赖是为了读到最新编辑值而非旧闭包 */
        if (ocrCard && ocrEdit.trim() && ocrEdit !== ocrCard.text && !ocrSaved) {
          void copyText(ocrEdit)
            .then(() => setOcrSaved(true))
            .catch(() => closeOcrCard());
          return;
        }
        closeOcrCard();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [!!ocrCard, !!ocrBusy, !!ocrErr, ocrEdit, ocrSaved]);

  /* 守存提示展示 900ms 后自动关闭；卡片被翻译/听写接管时 setOcrSaved(false)
     触发 cleanup 取消定时器，避免迟到的关闭吞掉新会话 */
  useEffect(() => {
    if (!ocrSaved) return;
    const t = setTimeout(() => closeOcrCard(), 900);
    return () => clearTimeout(t);
  }, [ocrSaved]);

  /* OCR 卡片：按内容自适应窗口高度（跟随编辑中的文本；编辑框另有滚动上限） */
  const ocrH = useMemo(() => {
    if (ocrErr) return WIN_NORMAL.h;
    if (!ocrCard) return WIN_NORMAL.h;
    const lines = estimateDisplayLines(ocrEdit || ocrCard.text, 430);
    return Math.min(Math.max(232 + Math.round(lines * 25), WIN_NORMAL.h), 560);
  }, [!!ocrCard, ocrEdit, !!ocrErr]);
  useEffect(() => {
    if (!ocrCard && !ocrBusy && !ocrErr) return;
    void getCurrentWindow().setSize(winSize(WIN_NORMAL.w, ocrH));
  }, [!!ocrCard, ocrH, !!ocrBusy, !!ocrErr]);
  /* 编辑框随内容长高（基线 4 行，封顶 300px 后滚动），编辑不丢光标 */
  useEffect(() => {
    const el = ocrEditRef.current;
    if (!el || !ocrCard) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 300)}px`;
  }, [!!ocrCard, ocrEdit]);
  useEffect(() => {
    if (!ocrCard && !ocrErr) {
      // 卡片清场（听写/翻译接管）后交还尺寸控制权；翻译卡片在场时由它接管高度
      if (!trans && stage !== 'review') {
        void getCurrentWindow().setSize(winSize(WIN_NORMAL.w, WIN_NORMAL.h));
      }
    }
  }, [!!ocrCard, !!ocrErr, !!trans, stage]);

  useEffect(() => {
    if (!ocrCopied) return;
    const t = setTimeout(() => setOcrCopied(false), 1600);
    return () => clearTimeout(t);
  }, [ocrCopied]);
  useEffect(() => {
    if (!ocrErr) return;
    const t = setTimeout(() => setOcrErr(''), 6000);
    return () => clearTimeout(t);
  }, [ocrErr]);

  /* 语言条切换目标语言并重译（持久化，托盘/设置页同步） */
  const onTransTarget = (code: string) => {
    /* 流式中允许直接换语言：后端 gen 代数会作废旧流（superseded 迟到结果
       被忽略），无需用 transBusy 在前端拦死 */
    if (!trans || code === trans.target) return;
    setTrans((prev) =>
      prev
        ? // 乐观更新即占用下一代号：旧会话同代的 superseded 错误若在乐观更新
          // 与新 start 事件之间到达，会因 gen 相等漏过过滤、闪一下「已被取代」
          {
            ...prev,
            gen: prev.gen + 1,
            target: code,
            status: 'streaming',
            stream: '',
            thinking: '',
            final: '',
            error: '',
          }
        : prev,
    );
    setTransBusy(true);
    setTransCopied(false);
    setTransActionErr('');
    translateRetarget(trans.text, code).catch((e) => {
      setTransBusy(false);
      setTrans((prev) => (prev ? { ...prev, status: 'error', error: prettyError(e) } : prev));
    });
  };

  /* 重译（同一目标语言；静默会话，不落盘配置） */
  const onTransRetry = () => {
    if (!trans || transBusy || !trans.text.trim()) return;
    setTrans((prev) =>
      prev ? { ...prev, status: 'streaming', stream: '', thinking: '', final: '', error: '' } : prev,
    );
    setTransBusy(true);
    setTransActionErr('');
    translateText(trans.text, trans.target)
      .then((t) => {
        setTrans((prev) =>
          prev ? { ...prev, status: 'done', final: t, stream: t } : prev,
        );
        setTransBusy(false);
      })
      .catch((e) => {
        setTrans((prev) => (prev ? { ...prev, status: 'error', error: prettyError(e) } : prev));
        setTransBusy(false);
      });
  };

  const onTransCopy = () => {
    const t = trans?.status === 'done' ? trans.final : trans?.stream ?? '';
    if (!t.trim()) return;
    void copyText(t)
      .then(() => setTransCopied(true))
      .catch((e) => setTransActionErr(String(e)));
  };

  const onTransReplace = () => {
    if (!trans || transReplacing || !trans.final.trim()) return;
    setTransReplacing(true);
    translateReplace(trans.final)
      .catch((e) => {
        setTransReplacing(false);
        setTransActionErr(String(e));
      });
  };

  const closeTrans = () => {
    setTrans(null);
    void dismissOverlay();
  };

  const onEnter = () => {
    setHovered(true);
    void overlayPin(true);
  };
  const onLeave = () => {
    setHovered(false);
    void overlayPin(false);
  };

  const onConfirm = async () => {
    if (!editText.trim() || confirming || optimizing) return;
    setConfirming(true);
    try {
      await confirmEdit(editText);
    } catch (e) {
      // 拒绝（无待确认项/粘贴失败）不能只吞掉：给出行内提示，用户才知道
      // 为什么没输入出去（notice 会随下一次 sn-review 重置）
      setNotice({ ok: false, msg: `输入失败：${String(e)}` });
    } finally {
      // 窗口隐藏不卸载 React 状态：成功路径也必须复位，否则下一次审阅的
      // 「↵ 输入」永久停在「输入中…」且被 confirming 守卫拦死
      setConfirming(false);
    }
  };

  const onReoptimize = async () => {
    if (optimizing || !editText.trim()) return;
    setOptimizing(true);
    setNotice(null);
    reoptStreamRef.current = true;
    streamTextRef.current = '';
    try {
      const t = await optimizeText(editText, reoptMode || undefined);
      setEditText(t);
      setNotice({ ok: true, msg: '已重新优化' });
    } catch (e) {
      // 失败时保留已流出的部分文本（与旧版逐 token 回填的行为一致）
      if (streamTextRef.current) setEditText(streamTextRef.current);
      setNotice({ ok: false, msg: `重新优化失败：${String(e)}` });
    } finally {
      reoptStreamRef.current = false;
      setOptimizing(false);
    }
  };

  /* 审阅窗口操作反馈自动消退 */
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  /* done 卡「复制」：复制当前终稿（重新优化后为最新稿） */
  const onDoneCopy = () => {
    if (!result.trim()) return;
    void copyText(result)
      .then(() => setDoneCopied(true))
      .catch(() => {});
  };

  /* done/error 卡键盘可达：无焦点窗口够不到卡上的按钮（鼠标专属），补
     C=复制 / R=重试 快捷键；带修饰键的组合不拦截（防误吞系统快捷键），
     翻译 / OCR 卡在场时整体让位（与 Esc 兜底同一互斥条件） */
  useEffect(() => {
    if (stage !== 'done' && stage !== 'error') return;
    if (trans || ocrBusy || ocrCard || ocrErr) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 'c') {
        e.preventDefault();
        if (stage === 'done') onDoneCopy();
        else if (message) {
          void copyText(message)
            .then(() => setErrCopied(true))
            .catch(() => {});
        }
      } else if (k === 'r' && stage === 'error' && retryable && !retrying) {
        e.preventDefault();
        setRetrying(true);
        void retryLast().catch(() => setRetrying(false));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // onDoneCopy 是闭包内稳定引用的普通函数（依赖 result），进依赖以读取最新值
  }, [stage, !!trans, !!ocrBusy, !!ocrCard, !!ocrErr, retryable, retrying, result, message]);

  /* done 卡「重新优化」：复用审阅卡的 optimize_text 通道（后端纯计算 + 流式
     sn-llm-delta，不改 stage、不动待确认项与历史），结果直接更新终稿显示；
     不经审阅编辑框，无需切换窗口形态，状态最短闭环 */
  const onDoneReoptimize = async () => {
    if (doneReopt || !result.trim()) return;
    setDoneReopt(true);
    setNotice(null);
    try {
      const t = await optimizeText(result);
      setResult(t);
      setResultId((n) => n + 1); // 换 diff 键：重放逐词入场动效与词级高亮
      setUsedLlm(true);
      setNotice({ ok: true, msg: '已重新优化' });
    } catch (e) {
      setNotice({ ok: false, msg: `重新优化失败：${prettyError(e)}` });
    } finally {
      setDoneReopt(false);
    }
  };

  /* 流式字幕段尾切分（录音卡字幕区渲染用，见 splitPartialTail） */
  const partialSplit = splitPartialTail(partial);

  /* OCR 取词链路里后端先发 stage=idle 再发 sn-ocr-start（ocr.rs）：
     早退条件必须放行 OCR 三态，否则截图取词的结果卡/错误卡永远渲染不出来 */
  if (stage === 'idle' && !trans && !ocrBusy && !ocrCard && !ocrErr)
    return <div className="h-screen w-screen" />;

  // 阶段主题色描边：录音=玫红 识别=天蓝 优化=靛紫 完成=翠绿 审阅=琥珀 出错=红；翻译卡=青绿
  const glow = trans
    ? 'from-emerald-400/50 via-teal-400/25 to-emerald-400/50'
    : stage === 'recording'
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
      className="overlay-feather flex h-screen w-screen items-start justify-center pt-4"
      /* 录音中误点不隐藏窗口：麦克风仍在采集，结果会无 UI 地粘进当时聚焦的应用；
         审阅模式本就不整体关闭 */
      onClick={
        stage === 'review' || stage === 'recording'
          ? undefined
          : (e) => {
              // 拖选文本松手也产生 click 冒泡：有选区说明用户在选取内容
              // （完成卡手动复制片段），不当作关闭意图
              if (window.getSelection()?.toString()) return;
              void dismissOverlay();
            }
      }
    >
      <div
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        className={`anim-pop overlay-edge relative w-[500px] rounded-[22px] bg-gradient-to-r ${glow} p-[1.5px]`}
        style={
          {
            ...(stage === 'review' ? { width: CARD_W_REVIEW } : null),
            '--stage-glow': trans
              ? GLOW_COLORS.translate
              : (GLOW_COLORS[stage] ?? GLOW_COLORS.transcribing),
          } as CSSProperties
        }
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
          {(stage === 'done' || stage === 'error') && !trans && (
            <span
              key={`${stage}-${resultId}`}
              className={`countdown-bar absolute bottom-0 left-0 h-[2px] ${
                stage === 'done'
                  ? 'bg-gradient-to-r from-emerald-400 to-sky-400'
                  : 'bg-gradient-to-r from-red-400 to-amber-400'
              }`}
              style={{
                animationDuration: `${COUNTDOWN_MS * lingerMult}ms`,
                animationPlayState: hovered ? 'paused' : 'running',
              }}
              aria-hidden
            />
          )}
          {trans?.status === 'done' && (
            <span
              className="countdown-bar absolute bottom-0 left-0 h-[2px] bg-gradient-to-r from-emerald-400 to-teal-300"
              style={{
                animationDuration: `${TRANS_COUNTDOWN_MS * lingerMult}ms`,
                animationPlayState: hovered ? 'paused' : 'running',
              }}
              aria-hidden
            />
          )}

          {ocrCard?.text && !trans && (
            <span
              className="countdown-bar absolute bottom-0 left-0 h-[2px] bg-gradient-to-r from-sky-400 to-cyan-300"
              style={{
                animationDuration: `${15000 * lingerMult}ms`,
                animationPlayState: hovered ? 'paused' : 'running',
              }}
              aria-hidden
            />
          )}

          {(ocrBusy || ocrCard || ocrErr) && !trans && (
            <div className="anim-rise" onClick={(e) => e.stopPropagation()}>
              {/* 标题行 */}
              <div className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-[13px]">
                  📷
                </span>
                <span className="text-[13px] font-medium text-sky-300">截图取词</span>
                {ocrBusy && (
                  <span className="flex items-center gap-0.5 text-[11px] text-slate-500">
                    识别中
                    <span className="dot ml-1 inline-block h-1 w-1 rounded-full bg-sky-400" />
                    <span
                      className="dot ml-0.5 inline-block h-1 w-1 rounded-full bg-sky-400"
                      style={{ animationDelay: '0.15s' }}
                    />
                    <span
                      className="dot ml-0.5 inline-block h-1 w-1 rounded-full bg-sky-400"
                      style={{ animationDelay: '0.3s' }}
                    />
                  </span>
                )}
                {ocrCard && (
                  <span className="rounded-full border border-sky-400/25 bg-sky-400/10 px-2 py-0.5 text-[10px] text-sky-300">
                    本地识别{ocrCard.ms ? ` · ${fmtMs(ocrCard.ms)}` : ''}
                  </span>
                )}
                <button
                  type="button"
                  onClick={closeOcrCard}
                  title="关闭（Esc）"
                  className="ml-auto flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-black/25 text-[11px] text-slate-500 transition hover:border-white/25 hover:text-slate-200"
                >
                  ✕
                </button>
              </div>

              {/* 错误信息（语言包缺失 / 引擎失败等，附引导） */}
              {ocrErr && (
                <div className="mt-2.5 rounded-lg border border-red-400/20 bg-red-500/[0.07] px-3 py-2.5 text-[12.5px] leading-relaxed text-red-200">
                  {ocrErr}
                </div>
              )}

              {/* 识别文本：可直接编辑（错字先改再用，复制/翻译/输入都取编辑后文本） */}
              {ocrCard?.text && (
                <div className="mt-2.5">
                  <textarea
                    ref={ocrEditRef}
                    value={ocrEdit}
                    rows={4}
                    spellCheck={false}
                    onChange={(e) => setOcrEdit(e.target.value)}
                    className="sn-scroll max-h-[300px] w-full resize-none whitespace-pre-wrap break-words rounded-lg border border-sky-400/15 bg-sky-500/[0.05] px-3 py-2.5 text-[13.5px] leading-[1.85] text-slate-100 outline-none transition select-text hover:border-sky-400/30 focus:border-sky-400/60 focus:ring-2 focus:ring-sky-500/15"
                  />
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-600">
                    <span>{ocrEdit.trim() ? `${[...ocrEdit.trim()].length} 字` : ''}</span>
                    {/* Esc 守存反馈 / 自动复制失败提示：与事实相符的卡片状态 */}
                    <span
                      className={`ml-auto ${ocrSaved ? 'text-emerald-300' : ocrCard?.copyFailed ? 'text-amber-400' : ''}`}
                    >
                      {ocrSaved
                        ? '已复制修改后的文本'
                        : ocrCard?.copyFailed
                          ? '⚠ 自动复制失败，请点「复制」手动复制'
                          : '可直接修改 · Esc 关闭'}
                    </span>
                  </div>
                </div>
              )}

              {/* 操作行 */}
              <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-2.5">
                <button
                  type="button"
                  disabled={!ocrEdit.trim()}
                  onClick={onOcrCopy}
                  className="rounded-full border border-white/10 bg-black/25 px-3 py-1.5 text-[12px] text-slate-300 transition hover:border-white/25 disabled:opacity-40"
                >
                  {ocrCopied ? '已复制 ✓' : '⧉ 复制'}
                </button>
                <button
                  type="button"
                  disabled={!ocrEdit.trim()}
                  onClick={onOcrTranslate}
                  title="识别文本送入翻译（目标语言与划词翻译一致）"
                  className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-[12px] text-emerald-300 transition hover:bg-emerald-400/20 disabled:opacity-40"
                >
                  🌐 翻译
                </button>
                <button
                  type="button"
                  disabled={!ocrEdit.trim() || ocrPasting}
                  onClick={onOcrPaste}
                  title="把识别文本粘贴到光标处（Ctrl+Z 可撤销）"
                  className="rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1.5 text-[12px] text-sky-300 transition hover:bg-sky-400/20 disabled:opacity-40"
                >
                  {ocrPasting ? '输入中…' : '⌨ 输入到光标'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOcrCard(null);
                    setOcrErr('');
                    setOcrBusy(false);
                    void ocrCapture();
                  }}
                  title="重新框选一块区域"
                  className="rounded-full border border-white/10 bg-black/25 px-3 py-1.5 text-[12px] text-slate-400 transition hover:border-white/25 disabled:opacity-40"
                >
                  ↻ 再截一次
                </button>
                <span className="ml-auto text-[10px] text-slate-600">
                  悬停可暂停 · Esc 关闭
                </span>
              </div>
            </div>
          )}

          {trans && (
            <div className="anim-rise" onClick={(e) => e.stopPropagation()}>
              {/* 标题行 */}
              <div className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-[13px]">
                  🌐
                </span>
                <span className="text-[13px] font-medium text-emerald-300">划词翻译</span>
                {trans.structured && (
                  <span
                    className="rounded-full border border-teal-400/30 bg-teal-400/10 px-2 py-0.5 text-[10px] text-teal-300"
                    title="检测到结构化文本：只翻译了字符串值，键名、注释与格式原样保留"
                  >
                    📄 {trans.structured} · 只译值
                  </span>
                )}
                {trans.status === 'streaming' && (
                  <span className="flex items-center gap-0.5 text-[11px] text-slate-500">
                    译成{langName(trans.target)}
                    <span className="dot ml-1 inline-block h-1 w-1 rounded-full bg-emerald-400" />
                    <span
                      className="dot ml-0.5 inline-block h-1 w-1 rounded-full bg-emerald-400"
                      style={{ animationDelay: '0.15s' }}
                    />
                    <span
                      className="dot ml-0.5 inline-block h-1 w-1 rounded-full bg-emerald-400"
                      style={{ animationDelay: '0.3s' }}
                    />
                  </span>
                )}
                {trans.status === 'done' && (
                  <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-300">
                    {langName(trans.target)}
                    {trans.ms ? ` · ${fmtMs(trans.ms)}` : ''}
                  </span>
                )}
                {/* 第二目标语言：仅提示文案，不改变语言条高亮（高亮恒等于目标语） */}
                {trans.status === 'done' && trans.second && trans.second !== trans.target && (
                  <span
                    className="text-[10px] text-slate-500"
                    title={`已启用第二目标语言：原文已是${langName(trans.target)}时会改译成${langName(trans.second)}`}
                  >
                    原文为{langName(trans.target)}时输出{langName(trans.second)}
                  </span>
                )}
                {trans.autoCopied && !trans.copyFailed && (
                  <span className="rounded-full border border-sky-400/25 bg-sky-400/[0.07] px-2 py-0.5 text-[10px] text-sky-300/90">
                    已自动复制
                  </span>
                )}
                {trans.autoCopied && trans.copyFailed && (
                  <button
                    type="button"
                    onClick={onTransCopy}
                    title="自动复制写入剪贴板失败（可能被其他应用占用），点击手动复制"
                    className="rounded-full border border-red-400/30 bg-red-400/10 px-2 py-0.5 text-[10px] text-red-300 transition hover:bg-red-400/20 active:scale-[0.97]"
                  >
                    自动复制失败 · 点此复制
                  </button>
                )}
                <button
                  type="button"
                  onClick={closeTrans}
                  title="关闭（Esc）"
                  className="ml-auto flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-black/25 text-[11px] text-slate-500 transition hover:border-white/25 hover:text-slate-200"
                >
                  ✕
                </button>
              </div>

              {/* 源文（默认两行折叠，点击展开核对） */}
              {trans.text && (
                <button
                  type="button"
                  onClick={() => setSrcExpanded((v) => !v)}
                  title={srcExpanded ? '收起源文' : '展开完整源文'}
                  className="mt-2.5 block w-full rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2 text-left transition hover:bg-white/[0.04]"
                >
                  <span
                    className={`block whitespace-pre-wrap break-words text-[12px] leading-5 text-slate-400 ${
                      srcExpanded ? '' : 'line-clamp-2'
                    }`}
                  >
                    {trans.text}
                  </span>
                  <span className="mt-1 block text-[10px] text-slate-600">
                    {srcExpanded
                      ? '收起源文'
                      : `源文 ${[...trans.text].length} 字 · 点击展开`}
                  </span>
                </button>
              )}

              {/* 译文 / 错误 */}
              {trans.status === 'error' ? (
                <div className="mt-2.5 flex items-start gap-2.5 rounded-lg border border-red-400/15 bg-red-500/[0.06] px-3 py-2.5">
                  <span className="mt-0.5 text-[13px] font-bold text-red-400">!</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] leading-5 text-red-300">{trans.error}</div>
                    {trans.error.includes('管理员') && (
                      <button
                        type="button"
                        onClick={() => {
                          void restartElevated().catch(() => {});
                        }}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-amber-500/90 to-orange-500/90 px-3 py-1 text-[11.5px] font-medium text-white shadow-lg shadow-amber-500/20 transition hover:brightness-110 active:scale-[0.97]"
                      >
                        🛡 以管理员身份重启 SpeakNow
                      </button>
                    )}
                  </div>
                </div>
              ) : transBody || trans.status === 'streaming' ? (
                <div
                  onMouseDown={(e) => {
                    // 只在双击序列的第一次 mousedown 记录「是否已有手动选区」；
                    // 第二次 mousedown（e.detail===2）会摧毁旧选区并自动选中
                    // 双击词，那时再读 getSelection 已无法区分来源
                    if (e.detail === 1)
                      hadSelBeforeDbl.current = !!window.getSelection()?.toString();
                  }}
                  onDoubleClick={() => {
                    // 双击前已有手动选区（用户在选取内容）：不打断、不整段复制；
                    // 双击自动选词产生的选区不算（见上 mousedown 注释）
                    if (hadSelBeforeDbl.current) return;
                    onTransCopy();
                  }}
                  title="双击复制译文"
                  className="sn-scroll mt-2.5 max-h-[300px] cursor-copy select-text overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-emerald-400/15 bg-emerald-500/[0.05] px-3 py-2.5 text-[13.5px] leading-[1.85] text-slate-100"
                >
                  {transBody}
                  {trans.status === 'streaming' && (
                    <span className="llm-cursor text-emerald-300">▍</span>
                  )}
                </div>
              ) : null}

              {/* 思考型模型：正文未出时先暗色展示思考片段 */}
              {trans.status === 'streaming' && !trans.stream && trans.thinking && (
                <div className="mt-2 rounded-lg border border-white/[0.05] bg-black/20 px-3 py-2">
                  <div className="text-[10px] text-slate-600">深度思考中…</div>
                  <div className="mt-0.5 line-clamp-2 break-all text-[11px] leading-5 text-slate-500">
                    {trans.thinking}
                  </div>
                </div>
              )}

              {/* 目标语言条：点击即换语言重译（持久化，托盘/设置页同步） */}
              {trans.text && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {TRANSLATE_LANGS.map(([code, name]) => {
                    const active = code === trans.target;
                    return (
                      <button
                        key={code}
                        type="button"
                        onClick={() => onTransTarget(code)}
                        /* 流式中可点（点击即换语言重译），仅用脉动样式标注「进行中」 */
                        className={`rounded-full border px-2.5 py-[5px] text-[11px] transition active:scale-[0.97] ${
                          active
                            ? `border-emerald-400/60 bg-emerald-400/15 font-medium text-emerald-200 ${
                                transBusy ? 'animate-pulse' : ''
                              }`
                            : 'border-white/10 bg-black/25 text-slate-400 hover:border-white/25 hover:text-slate-200'
                        }`}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* 操作行 */}
              <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-2.5">
                <button
                  type="button"
                  disabled={!transBody.trim()}
                  onClick={onTransCopy}
                  className="rounded-full border border-white/10 bg-black/25 px-3 py-1.5 text-[12px] text-slate-300 transition hover:border-white/25 disabled:opacity-40"
                >
                  {transCopied ? '已复制 ✓' : '⧉ 复制'}
                </button>
                <button
                  type="button"
                  disabled={trans.status !== 'done' || transReplacing || !trans.final.trim()}
                  onClick={onTransReplace}
                  title="把译文粘贴覆盖原应用中选中的文字（Ctrl+Z 可撤销）"
                  className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-[12px] text-emerald-300 transition hover:bg-emerald-400/20 disabled:opacity-40"
                >
                  {transReplacing ? '替换中…' : '⇄ 替换原文'}
                </button>
                <button
                  type="button"
                  disabled={transBusy || !trans.text.trim()}
                  onClick={onTransRetry}
                  className="rounded-full border border-white/10 bg-black/25 px-3 py-1.5 text-[12px] text-slate-400 transition hover:border-white/25 disabled:opacity-40"
                >
                  ↻ 重译
                </button>
                <span
                  className={`ml-auto text-[10px] ${
                    transSaved ? 'text-emerald-300' : 'text-slate-600'
                  }`}
                >
                  {transSaved ? '已复制译文' : '悬停暂停 · 双击复制 · 点空白关闭'}
                </span>
              </div>
              {transActionErr && (
                <div className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-red-300">
                  {transActionErr}
                </div>
              )}
            </div>
          )}

          {/* 翻译卡在场时听写各阶段卡片一律让位（sn-status 已清 trans，这里的
              !trans 兜底 done 驻留期等无 status 事件时到来的划词翻译，
              避免两卡纵向堆叠被按 transH 计高的窗口 overflow-hidden 裁切） */}
          {stage === 'recording' && !trans && (
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
                    {meta?.skip
                      ? '快速模式 · 不经 AI 优化'
                      : meta?.translate
                        ? `翻译模式 · 输出${langName(translateTarget)}`
                        : (meta?.asrModel ?? '')}
                  </div>
                </div>
                <RecTimer />
              </div>
              <LevelBars />
              {/* 流式实时字幕：前面的段正常色；最后一段是停顿切出的暂存段
                  （之后仍会续说新段），暗色 + 虚线下划线标出段边界。
                  段计数徽标 segs>1 时显示——1 段无边界可标，避免噪音 */}
              {partial.text && (
                <div className="mt-2 flex items-end gap-2">
                  <div className="min-w-0 flex-1 text-[13px] leading-6 text-slate-300">
                    <div className="line-clamp-2">
                      {partialSplit.head}
                      {partialSplit.tail && (
                        <span
                          className="text-slate-400/75 underline decoration-dotted underline-offset-4"
                          title="本句为分段暂存，继续说或停顿定稿"
                        >
                          {partialSplit.tail}
                        </span>
                      )}
                    </div>
                  </div>
                  {partial.segs > 1 && (
                    <span
                      className="mb-1 shrink-0 rounded-full border border-white/10 bg-black/25 px-1.5 py-0.5 text-[9.5px] leading-none text-slate-500"
                      title="已完成分段数：每次停顿切一段，此为已定稿句数"
                    >
                      第 {partial.segs} 段
                    </span>
                  )}
                </div>
              )}
              <div className="mt-1.5 text-center text-[11px] text-slate-500">
                {message || '再次按下快捷键结束'}
              </div>
              {/* 临近最长录音时长提示（琥珀色小字，每会话一次，自动结束前预警） */}
              {recHint && (
                <div className="mt-1 text-center text-[11px] text-amber-400/90">{recHint}</div>
              )}
            </div>
          )}

          {stage === 'transcribing' && !rawText && !partial.text && !trans && (
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

          {((stage === 'transcribing' && (rawText || partial.text)) || stage === 'optimizing') &&
            !trans && (
              <LlmStream stage={stage} meta={meta} rawText={rawText} partial={partial.text} />
            )}

          {/* 审阅卡与翻译卡互斥（同 recording/done 块）：审阅期剪贴板监听/划词
              热键仍可触发翻译卡，两卡纵向堆叠会被 overflow-hidden 裁切 */}
          {stage === 'review' && !trans && (
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
                {/* 耗时徽标：与 done 卡对齐（识别 X · 优化 Y，值为 0/缺省的段省略） */}
                {(timing.asr || timing.llm) && (
                  <span className="rounded-full border border-white/10 bg-black/25 px-2 py-0.5 font-mono text-[10px] text-slate-500">
                    {timing.asr ? `识别 ${fmtMs(timing.asr)}` : ''}
                    {timing.asr && timing.llm ? ' · ' : ''}
                    {timing.llm ? `优化 ${fmtMs(timing.llm)}` : ''}
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
                readOnly={optimizing}
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
                className={`w-full resize-none rounded-lg border bg-black/30 px-3 py-2.5 text-[13.5px] leading-7 text-slate-100 outline-none transition focus:ring-2 focus:ring-sky-500/15 ${
                  optimizing
                    ? 'border-indigo-400/40 focus:border-indigo-400/60'
                    : 'border-white/10 hover:border-white/[0.18] focus:border-sky-500/60'
                }`}
              />
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {llmEnabled && (
                  <select
                    value={reoptMode}
                    onChange={(e) => setReoptMode(e.target.value)}
                    disabled={optimizing}
                    title="重新优化时使用的模式"
                    className="cursor-pointer rounded-full border border-white/10 bg-black/25 px-2.5 py-[7px] text-[11.5px] text-slate-300 outline-none transition hover:border-white/25 disabled:opacity-50"
                  >
                    <option value="" style={{ background: '#1b1e33' }}>
                      跟随设置（{MODE_LABELS[llmMode] ?? '仅纠错'}）
                    </option>
                    {Object.entries(MODE_LABELS).map(([v, label]) => (
                      <option key={v} value={v} style={{ background: '#1b1e33' }}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
                {llmEnabled && (
                  <button
                    type="button"
                    disabled={optimizing || !editText.trim()}
                    onClick={onReoptimize}
                    className="rounded-full border border-white/10 bg-black/25 px-3.5 py-1.5 text-[12px] text-slate-300 transition hover:border-white/25 disabled:opacity-50"
                  >
                    {optimizing ? '✨ AI 生成中…' : '✨ 重新优化'}
                  </button>
                )}
                <button
                  type="button"
                  disabled={optimizing || !reviewRaw || editText === reviewRaw}
                  onClick={() => setEditText(reviewRaw)}
                  title="放弃 AI 与手动修改，回到原始转写"
                  className="rounded-full border border-white/10 bg-black/25 px-3.5 py-1.5 text-[12px] text-slate-400 transition hover:border-white/25 disabled:opacity-40"
                >
                  恢复原文
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
                  disabled={!editText.trim() || confirming || optimizing}
                  onClick={onConfirm}
                  className="ml-auto rounded-lg bg-gradient-to-r from-sky-500 to-indigo-500 px-4 py-1.5 text-[12px] font-medium text-white shadow-lg shadow-sky-500/25 transition hover:brightness-110 active:scale-[0.97] disabled:opacity-50"
                >
                  {confirming ? '输入中…' : '↵ 输入'}
                </button>
              </div>
              {notice && (
                <div
                  className={`mt-1.5 line-clamp-2 text-[11px] leading-4 ${
                    notice.ok ? 'text-emerald-300' : 'text-red-300'
                  }`}
                >
                  {notice.msg}
                </div>
              )}
            </div>
          )}

          {stage === 'done' && !trans && (
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
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2 text-[10px] text-slate-600">
                <span className="flex flex-wrap items-center gap-2.5 font-mono">
                  {result ? <span>{[...result].length} 字</span> : null}
                  {timing.audioSecs && timing.audioSecs > 0 ? (
                    <span>音频 {timing.audioSecs.toFixed(1)}s</span>
                  ) : null}
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
                <span className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={!result.trim()}
                    /* 外层容器「点击空白即关闭」，按钮点击不能冒泡上去 */
                    onClick={(e) => {
                      e.stopPropagation();
                      onDoneCopy();
                    }}
                    className="rounded-full border border-white/10 bg-black/25 px-2.5 py-1 text-[11px] text-slate-300 transition hover:border-white/25 disabled:opacity-40"
                  >
                    {doneCopied ? '已复制 ✓' : '⧉ 复制'}
                  </button>
                  {/* 与审阅卡同源判定：配置态为准（meta 为会话开始时的快照，作兜底） */}
                  {(llmEnabled || meta?.llmEnabled) && (
                    <button
                      type="button"
                      disabled={doneReopt || !result.trim()}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDoneReoptimize();
                      }}
                      title="对终稿再跑一次 AI 优化（模式跟随设置）"
                      className="rounded-full border border-white/10 bg-black/25 px-2.5 py-1 text-[11px] text-slate-300 transition hover:border-white/25 disabled:opacity-40"
                    >
                      {doneReopt ? '✨ 优化中…' : '✨ 重新优化'}
                    </button>
                  )}
                  <span>悬停可暂停 · C 复制 · 点击关闭</span>
                </span>
              </div>
              {notice && (
                <div
                  className={`mt-1.5 line-clamp-2 text-[11px] leading-4 ${
                    notice.ok ? 'text-emerald-300' : 'text-red-300'
                  }`}
                >
                  {notice.msg}
                </div>
              )}
            </div>
          )}

          {stage === 'error' && !trans && (
            <div
              className="anim-rise"
              /* 重试/管理员重启按钮的点击不冒泡到外层关闭悬浮窗（与翻译/OCR 卡
                 一致），否则后台 retry_last 的结果全程不可见 */
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start gap-3 py-0.5">
                <span className="anim-pop mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-[13px] font-bold text-red-400 ring-2 ring-red-500/20">
                  !
                </span>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="text-[13px] leading-5 text-red-300">{message}</div>
                  {/* 裸 anyhow 错误链不便口述转述：一键复制原文给排查/报错用 */}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void copyText(message)
                          .then(() => setErrCopied(true))
                          .catch(() => {});
                      }}
                      className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/25 px-2.5 py-1 text-[11px] text-slate-400 transition hover:border-white/25 hover:text-slate-200"
                    >
                      {errCopied ? '已复制 ✓' : '⧉ 复制错误信息'}
                    </button>
                    {/* 凭据类错误给出直达出口：401/403 一律是 Key 问题，报错
                        文案再可读也不如一键跳到填写处 */}
                    {/40[13]|API Key|鉴权|凭据|Key 未/.test(message) && (
                      <button
                        type="button"
                        onClick={() => {
                          void openSettings('asr').catch(() => {});
                        }}
                        className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-sky-500/90 to-indigo-500/90 px-3 py-1 text-[11.5px] font-medium text-white shadow-lg shadow-sky-500/20 transition hover:brightness-110 active:scale-[0.97]"
                      >
                        ⚙ 打开设置去填 Key
                      </button>
                    )}
                  </div>
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
