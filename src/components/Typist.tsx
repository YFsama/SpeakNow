import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  applyAppearance,
  getConfig,
  isMac,
  saveConfig,
  typingClipboardText,
  typingSetSpeed,
  typingStart,
  typingStatus,
  typingStop,
  typistReadDraft,
  typistSaveDraft,
  typistSetTop,
} from '../api';
import type { TypistConfig } from '../types';
import {
  SPEED_LEVELS,
  levelFromCharMs,
  lineDelayFor,
  remainingAfter,
} from '../typist-logic';
import { Button } from './Controls';

/* ============ 文本模拟输入（Typist）独立窗口 ============ */

/** 一轮模拟输入的结束原因（后端 sn-typing-done 的 reason） */
type DoneReason = 'done' | 'stopped' | 'error';

interface DoneInfo {
  reason: DoneReason;
  done: number;
  total: number;
  error: string | null;
}

const fmtSec = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `约 ${s} 秒` : `约 ${Math.floor(s / 60)} 分 ${s % 60} 秒`;
};

export default function Typist() {
  /** 草稿：窗口隐藏保活（后端拦关闭）+ 跨启动落盘（typist-draft.txt） */
  const [text, setText] = useState('');
  const [pref, setPref] = useState<TypistConfig | null>(null);
  const [active, setActive] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  /** 本轮输入的目标窗口标题（首拍进度事件带出；敲错窗口要第一时间可见） */
  const [target, setTarget] = useState('');
  const [lastDone, setLastDone] = useState<DoneInfo | null>(null);
  const [startErr, setStartErr] = useState<string | null>(null);
  const [onTop, setOnTop] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  // 挂载：拉配置（主题/缩放/置顶）+ 恢复草稿 + 进度事件。窗口重开时组件
  // 不重挂（WebView 保活），active 状态由 typing_status 恢复
  useEffect(() => {
    let alive = true;
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<{ done: number; total: number; target?: string }>(
        'sn-typing-progress',
        (e) => {
          setProgress({ done: e.payload.done, total: e.payload.total });
          if (e.payload.target) setTarget(e.payload.target);
        },
      ),
      listen<DoneInfo>('sn-typing-done', (e) => {
        setActive(false);
        setLastDone(e.payload);
      }),
    ];
    getConfig().then((cfg) => {
      if (!alive) return;
      applyAppearance(cfg.general.theme, cfg.general.fontScale);
      setPref(cfg.typist);
      setOnTop(!!cfg.typist.alwaysOnTop);
    });
    // 草稿恢复：只在输入框仍为空时填入，不覆盖用户抢先输入的内容
    typistReadDraft().then((d) => {
      if (alive && d) setText((t) => t || d);
    });
    typingStatus().then((s) => {
      if (alive && s.active) {
        setActive(true);
        setProgress({ done: s.done, total: s.total });
        setTarget(s.target || '');
      }
    });
    return () => {
      alive = false;
      for (const p of unlisteners) p.then((f) => f());
    };
  }, []);

  // 草稿落盘：编辑去抖 1.2s；空串即清文件（后端语义）
  useEffect(() => {
    const t = setTimeout(() => {
      void typistSaveDraft(text).catch(() => {});
    }, 1200);
    return () => clearTimeout(t);
  }, [text]);

  // 草稿即时落盘兜底：窗口隐藏后 WebView 定时器会被节流（去抖可能拖到分钟
  // 级），应用退出时未触发的定时器直接丢——可见性一变就同步刷一次
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') {
        void typistSaveDraft(text).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, [text]);

  // Esc 收起窗口（输入进行中窗口本就隐藏；后端拦了关闭按钮，这里补键盘路径）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !active) {
        void getCurrentWindow().hide().catch(() => {});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  /* 节奏/置顶偏好持久化：单飞队列合并连续改动，保存前重拉整份配置再改
     typist，尽量不覆盖主设置窗口同期的其他改动（与托盘保存同口径） */
  const pendingRef = useRef<Partial<TypistConfig>>({});
  const savingRef = useRef(false);
  const persistPref = (patch: Partial<TypistConfig>) => {
    setPref((p) => (p ? { ...p, ...patch } : p));
    Object.assign(pendingRef.current, patch);
    const flush = async () => {
      if (savingRef.current) return;
      savingRef.current = true;
      try {
        while (Object.keys(pendingRef.current).length > 0) {
          const patch2 = pendingRef.current;
          pendingRef.current = {};
          const cfg = await getConfig();
          cfg.typist = { ...cfg.typist, ...patch2 };
          await saveConfig(cfg);
        }
      } catch {
        /* 保存失败不打断使用：本次会话仍按内存值执行，重启回落旧值 */
      } finally {
        savingRef.current = false;
      }
    };
    void flush();
  };

  // 码点级计数/切片是 O(n) 展开（大文本每击键一次）， memo 到 text 变化
  const chars = useMemo(() => [...text].length, [text]);
  const lines = useMemo(() => Math.max(0, text.split('\n').length - 1), [text]);
  const level = pref ? levelFromCharMs(pref.charDelayMs) : 3;
  const sp = SPEED_LEVELS[level]!;
  const estimate = useMemo(
    () =>
      pref && chars > 0
        ? fmtSec(
            pref.startDelayMs +
              chars * pref.charDelayMs +
              lines * (pref.charDelayMs + pref.lineDelayMs),
          )
        : null,
    [pref, chars, lines],
  );

  /** 速度滑杆变更：写配置（下一轮基准）+ 进行中则实时生效（下一个字符起） */
  const onSpeedChange = (i: number) => {
    const next = SPEED_LEVELS[i]!;
    const line = lineDelayFor(next.ms);
    persistPref({ charDelayMs: next.ms, lineDelayMs: line });
    if (active) void typingSetSpeed(next.ms, line).catch(() => {});
  };

  /** 启动指定文本的模拟输入（草稿整体 / 中止后的剩余部分共用一条路径） */
  const startWith = async (t: string) => {
    setStartErr(null);
    setLastDone(null);
    try {
      await typingStart(t);
      setActive(true);
      setProgress({ done: 0, total: [...t].length });
      setTarget('');
    } catch (e) {
      setStartErr(String(e));
    }
  };

  const onStart = () => void startWith(text);

  /** 从剪贴板开始：读文本 → 填入输入框（可见可改）→ 直接启动 */
  const onClipboardStart = async () => {
    setStartErr(null);
    try {
      const t = await typingClipboardText();
      if (!t) {
        setStartErr('剪贴板里没有文本内容');
        return;
      }
      setText(t);
      await startWith(t);
    } catch (e) {
      setStartErr(String(e));
    }
  };

  /** 中止续输：textarea 换成剩余文本再原路启动，界面与实际输入保持一致 */
  const onResume = (done: number) => {
    const remaining = remainingAfter(text, done);
    if (!remaining) return;
    setText(remaining);
    void startWith(remaining);
  };

  const onStop = () => {
    void typingStop();
  };

  const toggleTop = () => {
    const next = !onTop;
    setOnTop(next);
    void typistSetTop(next).catch(() => {});
    persistPref({ alwaysOnTop: next });
  };

  const pct =
    progress.total > 0
      ? Math.min(100, (progress.done / progress.total) * 100)
      : 0;

  /** 中止横幅的续输候选：无剩余时不显示按钮 */
  const resumeText = useMemo(
    () =>
      lastDone?.reason === 'stopped' ? remainingAfter(text, lastDone.done) : '',
    [text, lastDone],
  );

  /** 清空输入框并立即删除草稿文件（隐私：考试答案一类内容不留盘） */
  const onClear = () => {
    setText('');
    setLastDone(null);
    setStartErr(null);
    void typistSaveDraft('').catch(() => {});
    areaRef.current?.focus();
  };

  return (
    <div className="flex min-h-screen flex-col gap-4 px-6 py-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-title text-[17px] font-semibold text-slate-100">
            文本模拟输入
          </h1>
          <p className="mt-1 text-[12px] leading-5 text-slate-400">
            把大段文本粘贴到这里，点「开始」后本窗口自动隐藏，焦点回到上一个应用，
            按设定的节奏模拟键盘逐字敲入——用于禁用粘贴 / 屏蔽剪贴板的网站与软件。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <button
            type="button"
            onClick={toggleTop}
            title={onTop ? '取消置顶' : '置顶小窗（对照原文抄录时不被目标窗口盖住）'}
            className={`rounded-full px-3 py-1.5 text-[12px] transition ${
              onTop
                ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40'
                : 'bg-white/[0.05] text-slate-400 hover:bg-white/10 hover:text-slate-200'
            }`}
          >
            📌 {onTop ? '已置顶' : '置顶'}
          </button>
          <button
            type="button"
            onClick={() => void onClipboardStart()}
            title="读取剪贴板文本并立即开始模拟输入"
            className="rounded-full bg-white/[0.05] px-3 py-1.5 text-[12px] text-slate-400 transition hover:bg-white/10 hover:text-slate-200"
          >
            📋 从剪贴板开始
          </button>
        </div>
      </header>

      <textarea
        ref={areaRef}
        autoFocus
        value={text}
        disabled={active}
        spellCheck={false}
        placeholder={'在此粘贴或输入要模拟键入的文本…\n换行会真的按一次回车（聊天应用里回车 = 发送，请留意）'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !active && chars > 0) {
            e.preventDefault();
            void onStart();
          }
        }}
        className="min-h-[220px] flex-1 resize-y rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-[13.5px] leading-6 text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-sky-500/50 focus:bg-black/40 disabled:opacity-60"
      />

      {/* 输入速度：单滑杆 + 档位刻度；输入进行中拖动即实时生效 */}
      {pref && (
        <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-slate-400">输入速度</span>
            <span className="tabular text-slate-300">
              {sp.label} · 每键 {sp.ms}ms · 约 {Math.round(1000 / sp.ms)} 字/秒
              {active && <span className="ml-2 text-sky-300">拖动实时生效</span>}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={SPEED_LEVELS.length - 1}
            step={1}
            value={level}
            onChange={(e) => onSpeedChange(Number(e.target.value))}
            className="mt-2 w-full"
          />
          <div className="mt-1 flex justify-between text-[10.5px] text-slate-600">
            {SPEED_LEVELS.map((s) => (
              <span
                key={s.label}
                className={s === sp ? 'text-sky-300' : undefined}
              >
                {s.label}
              </span>
            ))}
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-slate-500 tabular">
            <span>
              {chars > 0
                ? `${chars} 字 · ${lines} 个换行 · 全部输入 ${estimate}（目标应用丢字时往右拖降速）`
                : 'Ctrl+Enter 也可直接开始'}
            </span>
            {chars > 0 && !active && (
              <button
                type="button"
                onClick={onClear}
                title="清空输入框并立即删除草稿文件"
                className="shrink-0 text-slate-500 transition hover:text-red-400"
              >
                清空并删除草稿
              </button>
            )}
          </div>
        </div>
      )}

      {/* 进行中：进度条 + 目标窗口 + 停止 */}
      {active && (
        <div className="rounded-2xl border border-sky-500/25 bg-sky-500/[0.06] px-4 py-3">
          <div className="flex items-center justify-between gap-3 text-[12.5px] text-sky-200">
            <span className="min-w-0">
              正在模拟输入 {progress.done} / {progress.total} 字
              {target && (
                <span className="ml-2 truncate text-[11.5px] text-sky-300/70">
                  → {target}
                </span>
              )}
            </span>
            <Button kind="danger" onClick={onStop}>
              停止
            </Button>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-gradient-to-r from-sky-400 to-indigo-400 transition-[width] duration-150"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {/* 结束横幅：done / stopped / error 三态；中止后可续输剩余 */}
      {lastDone && !active && (
        <div
          className={`rounded-2xl border px-4 py-2.5 text-[12.5px] leading-5 ${
            lastDone.reason === 'error'
              ? 'border-red-500/30 bg-red-500/[0.08] text-red-300'
              : 'border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-300'
          }`}
        >
          {lastDone.reason === 'done' && `已完成：共输入 ${lastDone.total} 字`}
          {lastDone.reason === 'stopped' && (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span>已中止：输入到 {lastDone.done} / {lastDone.total} 字</span>
              {resumeText && (
                <button
                  type="button"
                  onClick={() => onResume(lastDone.done)}
                  className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11.5px] text-emerald-200 transition hover:bg-emerald-500/20"
                >
                  继续输入剩余 {[...resumeText].length} 字 →
                </button>
              )}
            </span>
          )}
          {lastDone.reason === 'error' && `输入失败：${lastDone.error ?? '未知错误'}`}
        </div>
      )}
      {startErr && !active && (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/[0.08] px-4 py-2.5 text-[12.5px] leading-5 text-red-300">
          无法开始：{startErr}
        </div>
      )}

      <footer className="flex items-center justify-between gap-4">
        <p className="text-[11px] leading-4 text-slate-500">
          {isMac
            ? 'Esc 收起本窗口；输入过程中可点托盘打开本窗口停止；目标窗口以管理员运行时会被系统拦截'
            : 'Esc 收起本窗口；输入过程中按键盘上任意物理按键立即中止；目标窗口以管理员运行时会被系统拦截'}
        </p>
        <Button
          kind="primary"
          disabled={active || chars === 0}
          onClick={onStart}
          title="隐藏本窗口，倒计时后开始逐字输入（Ctrl+Enter）"
        >
          {active ? '输入中…' : chars > 0 ? `开始模拟输入（${chars} 字）` : '开始模拟输入'}
        </Button>
      </footer>
    </div>
  );
}
