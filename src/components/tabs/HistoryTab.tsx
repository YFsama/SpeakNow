import { useEffect, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Button, ConfirmButton, Section, Select, TextArea, TextInput } from '../Controls';
import {
  clearHistory,
  copyText,
  deleteHistory,
  deleteHistoryBatch,
  exportText,
  historySetPin,
  openConfigDir,
  regenerate,
  updateHistoryFinal,
  shortcutChips,
} from '../../api';
import type { HistoryItem, TabProps } from '../../types';

/* ============ 历史 ============ */
/* 历史时间戳：旧记录为秒、新记录为毫秒，统一折算成毫秒再构造 Date */
const tsMs = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);

function fmtTime(ts: number): string {
  const d = new Date(tsMs(ts));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 耗时展示：>1s 用秒（1 位小数），否则毫秒 */
const fmtMs = (ms: number) => (ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

/** 按自然日分组标签：今天 / 昨天 / 更早 */
function dayKey(ts: number): string {
  const dayOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((dayOf(new Date()) - dayOf(new Date(tsMs(ts)))) / 86_400_000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  return '更早';
}

/** 记录类型：kind 字段存在用之；旧数据按 asrMs==null 推断为翻译 */
type HistKind = 'dictation' | 'translate' | 'ocr';
const kindOf = (h: HistoryItem): HistKind =>
  h.kind ?? (h.asrMs == null ? 'translate' : 'dictation');
const KIND_META: Record<HistKind, { icon: string; label: string }> = {
  dictation: { icon: '🎤', label: '听写' },
  translate: { icon: '🌐', label: '翻译' },
  ocr: { icon: '📷', label: 'OCR' },
};
const KIND_FILTERS: { value: 'all' | HistKind; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'dictation', label: '🎤 听写' },
  { value: 'translate', label: '🌐 翻译' },
  { value: 'ocr', label: '📷 OCR' },
];

/** 置顶小节标题：置顶条目固定排在最前、不参与日期分组（也不占保留条数名额） */
const PINNED_SECTION = '⭐ 已收藏';

/** 重优化模式：空 = 跟随全局配置；其余只影响本次调用（后端不落盘） */
const REGEN_MODES = [
  { value: '', label: '当前模式' },
  { value: 'correct', label: '纠错' },
  { value: 'polish', label: '润色' },
  { value: 'prompt', label: '提示词' },
];

/** 正则元字符转义（搜索词按字面匹配） */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 大小写不敏感地高亮命中片段（amber 底色）；q 为空原样返回。
 *  用 split+捕获组而非 indexOf(toLowerCase)：规避「İ」等小写化后长度
 *  变化导致的索引漂移 */
function Highlight({ text, q }: { text: string; q: string }) {
  const query = q.trim();
  if (!query) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRe(query)})`, 'gi'));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark
            key={i}
            className="rounded bg-amber-400/25 px-0.5 text-amber-200"
          >
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function HistoryTab({ cfg, set, history, toast, refreshHistory }: TabProps) {
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | HistKind>('all');
  const [busy, setBusy] = useState<number | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  /** 重优化模式（'' = 跟随「AI 优化」页的全局设置） */
  const [regenMode, setRegenMode] = useState('');
  /* 行内编辑终稿：editingTs 命中的行切换为 textarea */
  const [editingTs, setEditingTs] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  /* 历史容量（10~2000）：输入期间走草稿，失焦/回车钳制后提交 */
  const [limitDraft, setLimitDraft] = useState('');
  /* 两段式删除确认（模式同 TranslateTab 删除本地模型的 confirmDel）：
     单条删除不可撤销，第一次点变红「确认删除」，3 秒未复点自动回退 */
  const [confirmDelTs, setConfirmDelTs] = useState<number | null>(null);
  useEffect(() => {
    if (confirmDelTs === null) return;
    const t = setTimeout(() => setConfirmDelTs(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDelTs]);
  /* 复制成功的行内反馈：按钮短暂变「已复制 ✓」，替代无反馈的静默复制 */
  const [copiedTs, setCopiedTs] = useState<number | null>(null);
  /* 批量删除：多选模式（与行内单条删除/编辑互斥），selected 为按 ts 勾选的集合 */
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  /* 乐观置顶：ts → { from: 点击时的服务端真值, to: 目标值 }。合并规则见 pinnedOf——
     服务端真值一旦变化（sn-history-changed 刷新追上，或后端 20 上限自动取消），
     覆盖自动失效回落真值，因此无需手动清理，也不会挡住后续刷新 */
  const [pinOverride, setPinOverride] = useState<Record<number, { from: boolean; to: boolean }>>(
    {},
  );
  const pinnedOf = (h: HistoryItem): boolean => {
    const ov = pinOverride[h.ts];
    const server = h.pinned ?? false;
    if (!ov || ov.from !== server) return server;
    return ov.to;
  };

  /* 点击即本地翻转星标（不等事件往返），成功后由 sn-history-changed 广播自然对齐；
     失败 toast 报错并回退到服务端真值 */
  const onTogglePin = async (h: HistoryItem) => {
    const next = !pinnedOf(h);
    setPinOverride((m) => ({ ...m, [h.ts]: { from: h.pinned ?? false, to: next } }));
    try {
      await historySetPin(h.ts, next);
    } catch (e) {
      setPinOverride((m) => {
        const n = { ...m };
        delete n[h.ts];
        return n;
      });
      toast(`置顶失败：${String(e)}`, 'error');
    }
  };

  /* 空状态提示用当前主快捷键动态渲染（原硬编码 Ctrl+Shift+Space 改键后即误导） */
  const hotkeyChips = shortcutChips(cfg.hotkey.key);

  const historyLimit = cfg.general.historyLimit ?? 50;

  /* 搜索（大小写不敏感）+ 类型筛选叠加 */
  const q = query.trim();
  const re = q ? new RegExp(escapeRe(q), 'i') : null;
  const filtered = history.filter((h) => {
    if (kindFilter !== 'all' && kindOf(h) !== kindFilter) return false;
    if (!re) return true;
    return re.test(h.final) || re.test(h.raw);
  });

  /* 导出内容构造：txt 平铺 / md 按日期分组 / json 全字段（含 kind 与耗时） */
  const exportContent = (kind: 'txt' | 'md' | 'json'): string => {
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp = (h: HistoryItem) => {
      const d = new Date(tsMs(h.ts));
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    if (kind === 'json') return JSON.stringify(history, null, 2);
    if (kind === 'txt') {
      return history
        .map((h) => {
          let s = `[${stamp(h)}] ${h.final}`;
          if (h.raw !== h.final) s += `\n  原文：${h.raw}`;
          return s;
        })
        .join('\n\n');
    }
    const lines = [
      '# SpeakNow 识别历史',
      '',
      `> 共 ${history.length} 条 · 导出于 ${new Date().toLocaleString()}`,
      '',
    ];
    let prevDay = '';
    for (const h of history) {
      const day = dayKey(h.ts);
      if (day !== prevDay) {
        lines.push(`## ${day}`, '');
        prevDay = day;
      }
      const meta = KIND_META[kindOf(h)];
      const parts = [stamp(h), meta.label];
      if (h.asrMs != null) parts.push(`识别 ${fmtMs(h.asrMs)}`);
      if (h.llmMs != null && h.llmMs > 0) parts.push(`优化 ${fmtMs(h.llmMs)}`);
      lines.push(`- **${meta.icon} ${parts.join(' · ')}**`, '', h.final, '');
      if (h.raw !== h.final) lines.push(`  > 原文：${h.raw}`, '');
    }
    return lines.join('\n');
  };

  const onExport = async (kind: 'txt' | 'md' | 'json') => {
    if (history.length === 0) return;
    try {
      const path = await exportText(`history_export.${kind}`, exportContent(kind));
      toast(`已导出到配置目录：${path}`, 'ok');
    } catch (e) {
      toast(`导出失败：${String(e)}`, 'error');
    }
  };

  const onRegenerate = async (ts: number) => {
    setBusy(ts);
    try {
      const mode = REGEN_MODES.find((m) => m.value === regenMode && m.value !== '');
      const item = await regenerate(ts, mode?.value ?? null);
      toast(
        `已重新优化${mode ? `（${mode.label}）` : ''}：${item.final.slice(0, 30)}${item.final.length > 30 ? '…' : ''}`,
        'ok',
      );
      refreshHistory();
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  /* 行内编辑：保存走 update_history_final，列表由 sn-history-changed 事件刷新 */
  const startEdit = (h: HistoryItem) => {
    setEditingTs(h.ts);
    setEditDraft(h.final);
  };
  const saveEdit = async (ts: number) => {
    try {
      await updateHistoryFinal(ts, editDraft);
      setEditingTs(null);
      toast('终稿已保存', 'ok');
    } catch (e) {
      toast(`保存失败：${String(e)}`, 'error');
    }
  };
  const onEditKeys = (e: ReactKeyboardEvent<HTMLTextAreaElement>, ts: number) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setEditingTs(null);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void saveEdit(ts);
    }
  };

  /* 历史容量：钳制到 10~2000 后写配置（后端 push 按此值截断） */
  const commitLimit = () => {
    if (limitDraft === '') return;
    const n = parseInt(limitDraft, 10);
    setLimitDraft('');
    const v = Number.isFinite(n) ? Math.min(2000, Math.max(10, n)) : historyLimit;
    if (v !== historyLimit) set('general', { historyLimit: v });
  };

  const onDelete = async (ts: number) => {
    // 与「清空」的 window.confirm 对齐成显式二次确认，但用行内两段式不打断
    if (confirmDelTs !== ts) {
      setConfirmDelTs(ts);
      return;
    }
    setConfirmDelTs(null);
    try {
      await deleteHistory(ts);
    } catch (e) {
      toast(`删除失败：${String(e)}`, 'error');
      return;
    }
    refreshHistory();
  };

  const onClear = async () => {
    try {
      await clearHistory();
    } catch (e) {
      toast(`清空失败：${String(e)}`, 'error');
      return;
    }
    refreshHistory();
  };

  /* ---- 批量删除（多选模式）---- */
  const toggleSel = (ts: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(ts)) n.delete(ts);
      else n.add(ts);
      return n;
    });

  /* 进入多选时收起行内编辑与单条删除的待确认态（两套操作互斥） */
  const enterSelect = () => {
    setSelectMode(true);
    setEditingTs(null);
    setConfirmDelTs(null);
  };
  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  /* 全选当前筛选结果；已全选时清空（起反选作用） */
  const selectAll = () =>
    setSelected((s) => {
      const all = new Set(filtered.map((h) => h.ts));
      if (all.size === s.size && [...all].every((t) => s.has(t))) return new Set();
      return all;
    });

  const onDeleteBatch = async () => {
    if (selected.size === 0) return;
    try {
      const n = await deleteHistoryBatch([...selected]);
      exitSelect();
      toast(`已删除 ${n} 条`, 'ok');
      refreshHistory();
    } catch (e) {
      toast(`删除失败：${String(e)}`, 'error');
    }
  };

  /* 分组行：置顶条目稳定排最前（filter 保序即 stable 排序），独立成「⭐ 已收藏」小节
     且不参与日期判定；其余按原新→旧序走「今天/昨天/更早」分组 */
  const rows: { h: HistoryItem; day: string; firstOfDay: boolean }[] = [];
  filtered.filter((h) => pinnedOf(h)).forEach((h, i) => {
    rows.push({ h, day: PINNED_SECTION, firstOfDay: i === 0 });
  });
  let prevDay = '';
  for (const h of filtered.filter((x) => !pinnedOf(x))) {
    const day = dayKey(h.ts);
    rows.push({ h, day, firstOfDay: day !== prevDay });
    prevDay = day;
  }

  return (
    <Section
      icon="🕘"
      title="识别历史"
      desc={`本地保存最近 ${historyLimit} 条，支持搜索、类型筛选、对比原文、行内编辑、批量删除、按模式重优化与导出。`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] flex-1">
          <TextInput value={query} onChange={setQuery} placeholder="搜索结果或原文…" />
          {query && (
            <button
              type="button"
              title="清空搜索"
              onClick={() => setQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded px-1 text-[13px] leading-none text-slate-500 transition hover:text-slate-200"
            >
              ✕
            </button>
          )}
        </div>
        {history.length > 0 && (
          <span
            title={`筛选结果 / 全部记录`}
            className="rounded-full border border-white/[0.08] bg-black/20 px-2.5 py-1 font-mono text-[10.5px] text-slate-500"
          >
            {filtered.length} / 共 {history.length}
          </span>
        )}
        <Button onClick={() => setShowRaw((v) => !v)}>
          {`对比原文：${showRaw ? '开' : '关'}`}
        </Button>
        {history.length > 0 && (
          <Button
            onClick={() => (selectMode ? exitSelect() : enterSelect())}
            title="勾选多条记录后批量删除"
            kind={selectMode ? 'primary' : 'ghost'}
          >
            {selectMode ? '退出选择' : '选择'}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {KIND_FILTERS.map((k) => {
            const active = kindFilter === k.value;
            return (
              <button
                key={k.value}
                type="button"
                onClick={() => setKindFilter(k.value)}
                className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                  active
                    ? 'border-sky-500/60 bg-sky-500/10 text-sky-300'
                    : 'border-white/10 bg-black/20 text-slate-400 hover:border-white/25 hover:text-slate-200'
                }`}
              >
                {k.label}
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-2 text-[11px] text-slate-500">
          保留条数
          <input
            type="number"
            min={10}
            max={2000}
            value={limitDraft === '' ? String(historyLimit) : limitDraft}
            onChange={(e) => setLimitDraft(e.target.value)}
            onBlur={commitLimit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitLimit();
            }}
            className="w-20 rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-[12px] text-slate-200 outline-none transition hover:border-white/[0.18] focus:border-sky-500/60"
          />
          <span>条（10~2000）</span>
        </label>
      </div>

      {history.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          {cfg.llm.enabled && (
            <label className="flex items-center gap-2 text-[11px] text-slate-500">
              重优化模式
              <div className="w-32">
                <Select value={regenMode} onChange={setRegenMode} options={REGEN_MODES} />
              </div>
            </label>
          )}
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-slate-500">导出</span>
            {(['txt', 'md', 'json'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => onExport(k)}
                className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] text-slate-300 transition hover:border-white/25 hover:text-slate-100"
              >
                {k}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void openConfigDir().catch((e) => toast(String(e), 'error'))}
              title="打开配置目录（导出文件所在位置）"
              className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] text-slate-400 transition hover:border-white/25 hover:text-slate-100"
            >
              📂 打开文件夹
            </button>
          </div>
          <div className="ml-auto">
            <ConfirmButton
              label="清空"
              confirmLabel="确认清空全部？"
              onConfirm={() => void onClear()}
              title="使用统计为累计口径（里程表式），清空历史不影响统计数字"
            />
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/10 py-8 text-center text-xs leading-6 text-slate-600">
          {query ? (
            <>
              没有匹配「{query}」的记录
              <br />
              <span className="text-[11px]">试试更短的关键词，或切换类型筛选</span>
            </>
          ) : kindFilter !== 'all' ? (
            <>
              该类型暂无记录
              <br />
              <span className="text-[11px]">切换「全部」查看所有历史</span>
            </>
          ) : (
            <>
              {hotkeyChips.length > 0 ? (
                <>
                  还没有记录
                  <br />
                  <span className="text-[11px]">
                    在任意输入框按下
                    {hotkeyChips.map((c, i) => (
                      <span key={i}>
                        {i > 0 && '+'}
                        <span className="kbd mx-1">{c}</span>
                      </span>
                    ))}
                    说出第一句话
                  </span>
                </>
              ) : (
                <>
                  还没有记录
                  <br />
                  <span className="text-[11px] text-amber-300/80">
                    尚未设置快捷键——到「快捷键」页设置后即可开始听写
                  </span>
                </>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
          {rows.map(({ h, day, firstOfDay }, idx) => {
            const kind = kindOf(h);
            const meta = KIND_META[kind];
            const editing = editingTs === h.ts;
            const isPinned = pinnedOf(h);
            /* 对照视图：全局开关，或搜索词仅命中原文时该行自动展开 */
            const matchFinal = !re || re.test(h.final);
            const matchRaw = !!re && re.test(h.raw);
            const expanded = h.raw !== h.final && (showRaw || (matchRaw && !matchFinal));
            return (
              <div key={`${h.ts}-${idx}`}>
                {firstOfDay && (
                  <div
                    title={day === PINNED_SECTION ? '收藏不占保留条数名额；最多 20 条，超出自动取消最早的' : undefined}
                    className={`text-[10px] tracking-widest ${
                      day === PINNED_SECTION ? 'text-amber-500/80' : 'text-slate-600'
                    } ${idx > 0 ? 'mt-3' : ''} mb-1`}
                  >
                    ── {day} ──
                  </div>
                )}
                <div className="group rounded-lg border border-white/[0.06] bg-black/20 px-3.5 py-2.5 transition hover:border-white/[0.14]">
                  <div className="flex items-start gap-3">
                    {selectMode && (
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={selected.has(h.ts)}
                        onClick={() => toggleSel(h.ts)}
                        title="选中 / 取消选中"
                        aria-label="选中该条记录"
                        className={`mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border text-[10px] font-bold leading-none transition ${
                          selected.has(h.ts)
                            ? 'border-sky-400 bg-sky-500/80 text-white'
                            : 'border-white/25 text-transparent hover:border-sky-400/60'
                        }`}
                      >
                        ✓
                      </button>
                    )}
                    <div className="min-w-0 flex-1">
                      {editing ? (
                        <div className="space-y-2">
                          <TextArea
                            value={editDraft}
                            onChange={setEditDraft}
                            rows={4}
                            onKeyDown={(e) => onEditKeys(e, h.ts)}
                          />
                          <div className="text-[10.5px] text-slate-600">
                            Ctrl+Enter 保存 · Esc 取消
                          </div>
                        </div>
                      ) : expanded ? (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <div className="rounded-lg border border-white/[0.06] bg-black/30 p-2.5">
                            <div className="mb-1 text-[10px] text-slate-600">原文（识别）</div>
                            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] leading-5 text-slate-400">
                              <Highlight text={h.raw} q={query} />
                            </div>
                          </div>
                          <div className="rounded-lg border border-sky-400/15 bg-sky-500/[0.04] p-2.5">
                            <div className="mb-1 text-[10px] text-sky-400/60">终稿（输出）</div>
                            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] leading-5 text-slate-200">
                              <Highlight text={h.final} q={query} />
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="line-clamp-2 whitespace-pre-wrap text-[13px] leading-5 text-slate-200">
                          <Highlight text={h.final} q={query} />
                        </div>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10.5px] text-slate-600">
                        <span title={meta.label}>{meta.icon}</span>
                        {/* 置顶收藏：星标常显（置顶态 amber），多选模式下与行内按钮一起隐藏 */}
                        {!selectMode && (
                          <button
                            type="button"
                            onClick={() => void onTogglePin(h)}
                            title={isPinned ? '取消置顶' : '置顶收藏'}
                            aria-label={isPinned ? '取消置顶' : '置顶收藏'}
                            aria-pressed={isPinned}
                            className={`text-[11px] leading-none transition ${
                              isPinned
                                ? 'text-amber-400'
                                : 'text-slate-600 hover:text-amber-300'
                            }`}
                          >
                            {isPinned ? '⭐' : '☆'}
                          </button>
                        )}
                        <span className="font-mono">{fmtTime(h.ts)}</span>
                        {h.asrMs != null && <span>识别 {fmtMs(h.asrMs)}</span>}
                        {h.llmMs != null && h.llmMs > 0 && <span>优化 {fmtMs(h.llmMs)}</span>}
                        <span>{[...h.final].length} 字</span>
                      </div>
                    </div>
                    {/* 多选模式与行内操作（复制/重优化/编辑/单条删除）互斥：进入多选即隐藏 */}
                    {!selectMode && (
                      <div className="flex shrink-0 flex-col items-end gap-1 opacity-70 transition group-hover:opacity-100">
                      {editing ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void saveEdit(h.ts)}
                            className="text-[11px] text-emerald-400 hover:text-emerald-300"
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingTs(null)}
                            className="text-[11px] text-slate-500 hover:text-slate-300"
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              // 成功后按钮态短暂变「已复制 ✓」（1.5s 后复原），失败走 toast
                              void copyText(h.final)
                                .then(() => {
                                  setCopiedTs(h.ts);
                                  window.setTimeout(
                                    () => setCopiedTs((cur) => (cur === h.ts ? null : cur)),
                                    1500,
                                  );
                                })
                                .catch((e) => toast(String(e), 'error'));
                            }}
                            className={`text-[11px] transition ${
                              copiedTs === h.ts
                                ? 'text-emerald-400'
                                : 'text-sky-400 hover:text-sky-300'
                            }`}
                          >
                            {copiedTs === h.ts ? '已复制 ✓' : '复制'}
                          </button>
                          {cfg.llm.enabled && (
                            <button
                              type="button"
                              disabled={busy === h.ts}
                              onClick={() => onRegenerate(h.ts)}
                              className="text-[11px] text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
                            >
                              {busy === h.ts ? '优化中…' : '重新优化'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => startEdit(h)}
                            className="text-[11px] text-slate-500 transition hover:text-sky-300"
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            onClick={() => onDelete(h.ts)}
                            className={`text-[11px] transition ${
                              confirmDelTs === h.ts
                                ? 'text-red-400'
                                : 'text-slate-500 hover:text-red-400'
                            }`}
                          >
                            {confirmDelTs === h.ts ? '确认删除' : '删除'}
                          </button>
                        </>
                      )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 多选模式底部操作条：全选当前筛选结果 → 一次批量删除 */}
      {selectMode && (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-3 rounded-xl border border-sky-400/20 bg-black/70 px-4 py-2.5 backdrop-blur">
          <span className="text-xs text-slate-300">已选 {selected.size} 条</span>
          <Button
            kind="subtle"
            onClick={selectAll}
            disabled={filtered.length === 0}
            title="全选当前筛选结果（已全选时点击清空选择）"
          >
            全选
          </Button>
          {selected.size > 0 ? (
            <ConfirmButton
              label="删除"
              confirmLabel={`确认删除 ${selected.size} 条？`}
              onConfirm={() => void onDeleteBatch()}
            />
          ) : (
            <Button kind="danger" disabled title="先勾选要删除的记录">
              删除
            </Button>
          )}
          <Button onClick={exitSelect}>取消</Button>
        </div>
      )}
    </Section>
  );
}
