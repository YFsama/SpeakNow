import { useState } from 'react';
import { Button, Field, Section, TextInput } from '../Controls';
import { clearHistory, copyText, deleteHistory, exportText, regenerate } from '../../api';
import type { TabProps } from '../../types';

/* ============ 历史 ============ */
/* 历史时间戳：旧记录为秒、新记录为毫秒，统一折算成毫秒再构造 Date */
const tsMs = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);

function fmtTime(ts: number): string {
  const d = new Date(tsMs(ts));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function HistoryTab({ cfg, history, toast, refreshHistory }: TabProps) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const filtered = query.trim()
    ? history.filter((h) => h.final.includes(query) || h.raw.includes(query))
    : history;

  const onExport = async () => {
    if (history.length === 0) return;
    const p = (n: number) => String(n).padStart(2, '0');
    const lines = history.map((h) => {
      const d = new Date(tsMs(h.ts));
      const head = `[${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}]`;
      let s = `${head} ${h.final}`;
      if (h.raw !== h.final) s += `\n  原文：${h.raw}`;
      return s;
    });
    try {
      const path = await exportText('history_export.txt', lines.join('\n\n'));
      toast(`已导出到：${path}`);
    } catch (e) {
      toast(String(e));
    }
  };

  const onRegenerate = async (ts: number) => {
    setBusy(ts);
    try {
      const item = await regenerate(ts);
      toast(`已重新优化：${item.final.slice(0, 30)}${item.final.length > 30 ? '…' : ''}`);
      refreshHistory();
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (ts: number) => {
    await deleteHistory(ts);
    refreshHistory();
  };

  const onClear = async () => {
    if (!window.confirm('确定清空全部识别历史？')) return;
    await clearHistory();
    refreshHistory();
  };

  return (
    <Section
      icon="🕘"
      title="识别历史"
      desc={`本地保存最近 50 条，支持搜索、对比原文、重新优化与导出。`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[200px] flex-1">
          <TextInput value={query} onChange={setQuery} placeholder="搜索结果或原文…" />
        </div>
        <Button onClick={() => setShowRaw((v) => !v)}>
          {`对比原文：${showRaw ? '开' : '关'}`}
        </Button>
        {history.length > 0 && (
          <>
            <Button onClick={onExport}>⬇ 导出</Button>
            <Button kind="danger" onClick={onClear}>
              清空
            </Button>
          </>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/10 py-8 text-center text-xs leading-6 text-slate-600">
          {query ? (
            <>
              没有匹配「{query}」的记录
              <br />
              <span className="text-[11px]">试试更短的关键词，或切换「对比原文」后搜索</span>
            </>
          ) : (
            <>
              还没有记录
              <br />
              <span className="text-[11px]">
                在任意输入框按下
                <span className="kbd mx-1">Ctrl</span>+
                <span className="kbd mx-1">Shift</span>+
                <span className="kbd mx-1">Space</span>
                说出第一句话
              </span>
            </>
          )}
        </div>
      ) : (
        <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
          {filtered.map((h, idx) => (
            <div
              key={`${h.ts}-${idx}`}
              className="group rounded-lg border border-white/[0.06] bg-black/20 px-3.5 py-2.5 transition hover:border-white/[0.14]"
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 whitespace-pre-wrap text-[13px] leading-5 text-slate-200">
                    {h.final}
                  </div>
                  {showRaw && h.raw !== h.final && (
                    <div className="mt-1 line-clamp-1 text-[11px] text-slate-600">
                      原文：{h.raw}
                    </div>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10.5px] text-slate-600">
                    <span className="font-mono">{fmtTime(h.ts)}</span>
                    {h.asrMs != null && <span>识别 {h.asrMs}ms</span>}
                    {h.llmMs != null && h.llmMs > 0 && <span>优化 {h.llmMs}ms</span>}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1 opacity-70 transition group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => copyText(h.final)}
                    className="text-[11px] text-sky-400 hover:text-sky-300"
                  >
                    复制
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
                    onClick={() => onDelete(h.ts)}
                    className="text-[11px] text-slate-500 hover:text-red-400"
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
