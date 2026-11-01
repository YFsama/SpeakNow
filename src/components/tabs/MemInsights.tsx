import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { MemEntry } from '../../types';

/* ============ 记忆洞察面板（MemInsights，v5） ============
   纯 DOM/CSS 无 canvas：活跃热力图 + 关键词/来源/类型统计 + 最久未使用。
   数据口径：MemTab 传入的全量在世条目（软作废已滤），无独立时间过滤
   （热力图本身就是时间维度，Top 榜看全库更符合「总览」心智）。 */

/* 类型文案/图标/配色与 MemTab 同源（导出会动到既有文件，就地复制；改色两处同步） */
const KIND_LABEL: Record<MemEntry['kind'], string> = {
  dictation: '听写',
  ocr: '取词',
  translate: '翻译',
  note: '快记',
  web: '网页',
  file: '文件',
};
const KIND_CLS: Record<MemEntry['kind'], string> = {
  dictation: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
  ocr: 'border-violet-400/25 bg-violet-400/10 text-violet-300',
  translate: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  note: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  web: 'border-teal-400/25 bg-teal-400/10 text-teal-300',
  file: 'border-rose-400/25 bg-rose-400/10 text-rose-300',
};
const KIND_ICON: Record<MemEntry['kind'], string> = {
  dictation: '🎤',
  ocr: '📷',
  translate: '🌐',
  note: '✏️',
  web: '🔗',
  file: '📄',
};

const DAY = 86_400_000;
const WEEKS = 26; // 热力图跨度：半年（GitHub 同款口径）

/** 热力图五档色阶（I1：0.20/0.40/0.65/0.95 量化，档间对比更均匀）；
 *  0 档用 bg-black/20（浅色主题有 CSS 覆盖） */
const LEVEL_CLS = [
  'bg-black/20',
  'bg-sky-400/20',
  'bg-sky-400/40',
  'bg-sky-400/65',
  'bg-sky-400/95',
] as const;
const levelOf = (n: number): 0 | 1 | 2 | 3 | 4 =>
  n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 6 ? 3 : 4;

/** 关键词 4 档量化字号（I3）：连续插值改为离散档，视觉上「档」可数；
 *  强度用字重（前两档 medium / 后两档 semibold）而不是无限渐变 */
const KW_TIER_PX = [11, 12, 13.5, 15] as const;

const dayKey = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** 块标题：洞察卡的小节头（I7：text-xs + 令牌四级弱化色 + 顶部 8px 呼吸） */
function BlockTitle({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-2 text-xs text-[var(--sn-text-4)]">
      <span>{children}</span>
    </div>
  );
}

export function MemInsights({
  items,
  onPickKeyword,
}: {
  items: MemEntry[];
  onPickKeyword: (kw: string) => void;
}) {
  const data = useMemo(() => {
    /* ---- 热力图：近 26 周按天计数，列=周（周一起始），行=周一~周日 ---- */
    const counts = new Map<string, number>();
    for (const it of items) counts.set(dayKey(it.ts), (counts.get(dayKey(it.ts)) ?? 0) + 1);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dow = (today.getDay() + 6) % 7; // 对齐周一：让最后一列以今天收尾
    const start = today.getTime() - (dow + (WEEKS - 1) * 7) * DAY;
    const weeks: { ts: number; n: number }[][] = [];
    let activeDays = 0;
    let total26 = 0;
    for (let w = 0; w < WEEKS; w++) {
      const col: { ts: number; n: number }[] = [];
      for (let d = 0; d < 7; d++) {
        const ts = start + (w * 7 + d) * DAY;
        const n = ts > today.getTime() + DAY ? -1 : (counts.get(dayKey(ts)) ?? 0);
        if (n > 0) {
          activeDays++;
          total26 += n;
        }
        col.push({ ts, n });
      }
      weeks.push(col);
    }
    /* 月份标签：每月第一列才显示（GitHub 同款稀疏标注） */
    const monthMarks: { w: number; label: string }[] = [];
    let prevM = -1;
    for (let w = 0; w < WEEKS; w++) {
      const d = new Date(start + w * 7 * DAY);
      if (d.getMonth() !== prevM) {
        prevM = d.getMonth();
        monthMarks.push({ w, label: `${d.getMonth() + 1}月` });
      }
    }

    /* ---- 关键词 Top 15（按关联条数） ---- */
    const kwRank = new Map<string, number>();
    for (const it of items)
      for (const kw of it.keywords) kwRank.set(kw, (kwRank.get(kw) ?? 0) + 1);
    const topKws = [...kwRank.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 15);

    /* ---- 来源应用 Top 8 ---- */
    const appRank = new Map<string, number>();
    for (const it of items) {
      const k = it.app || '未知应用';
      appRank.set(k, (appRank.get(k) ?? 0) + 1);
    }
    const topApps = [...appRank.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 8);

    /* ---- kind 分布 ---- */
    const kindCount = new Map<MemEntry['kind'], number>();
    for (const it of items) kindCount.set(it.kind, (kindCount.get(it.kind) ?? 0) + 1);

    /* ---- 最久未使用 Top 3：max(ts, lastUsedAt) 最旧（「遗忘上下文」零成本版） ---- */
    const lastUsed = (it: MemEntry): number => Math.max(it.ts, it.lastUsedAt ?? 0);
    const oldest = [...items].sort((a, b) => lastUsed(a) - lastUsed(b)).slice(0, 3);

    return {
      weeks,
      monthMarks,
      activeDays,
      total26,
      topKws,
      topApps,
      kindCount,
      oldest,
      lastUsed,
    };
  }, [items]);

  if (items.length === 0)
    return (
      <div className="rounded-lg border border-dashed border-white/10 py-8 text-center text-xs leading-6 text-slate-600">
        记忆库还是空的，暂无可统计的洞察
      </div>
    );

  const maxKw = data.topKws[0]?.[1] ?? 1;
  const maxApp = data.topApps[0]?.[1] ?? 1;
  /* 今日 key（I2 今日格判定）与关键词档位（I3：频次归一后 4 段量化） */
  const todayK = dayKey(Date.now());
  const tierOf = (c: number): 0 | 1 | 2 | 3 => {
    const t = (c - 1) / Math.max(1, maxKw - 1);
    return t < 0.25 ? 0 : t < 0.5 ? 1 : t < 0.75 ? 2 : 3;
  };

  return (
    <div className="space-y-4">
      {/* 活跃热力图 */}
      <div className="rounded-xl border border-white/[0.06] bg-black/20 px-4 py-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <BlockTitle>📅 活跃热力图（近 26 周）</BlockTitle>
          <span className="tabular-nums text-[11px] text-slate-600">
            {data.total26} 条 · 活跃 {data.activeDays} 天
          </span>
        </div>
        {/* 点击某天过滤时间轴需要给时间轴加日期过滤链路（后端 mem_list 无日期参数），
            为不动既有检索逻辑，这里按约定的简化口径：仅 title 提示「M月D日 · N 条」 */}
        <div className="sn-scroll overflow-x-auto pb-1">
          <div className="inline-block min-w-full">
            <div className="mb-1 flex gap-[3px] pl-6">
              {Array.from({ length: WEEKS }, (_, w) => {
                const mark = data.monthMarks.find((m) => m.w === w);
                return (
                  <span
                    key={w}
                    className="w-[11px] text-[9px] leading-3 text-slate-600"
                  >
                    {mark ? mark.label : ''}
                  </span>
                );
              })}
            </div>
            <div className="flex gap-[3px]">
              {/* 星期标注：只标一/三/五行，全标太密 */}
              <div className="mr-1 flex w-4 flex-col gap-[3px] text-[9px] leading-[11px] text-slate-600">
                {['一', '', '三', '', '五', '', '日'].map((s, i) => (
                  <span key={i} className="h-[11px]">
                    {s}
                  </span>
                ))}
              </div>
              {data.weeks.map((col, w) => (
                <div key={w} className="flex flex-col gap-[3px]">
                  {col.map((c) => {
                    const d = new Date(c.ts);
                    const label = `${d.getMonth() + 1}月${d.getDate()}日 · ${c.n} 条`;
                    /* 今日格（I2）：选 3px 角标点而非 ring——11px 小格上 1px 描边环
                       读起来像色档边缘（与色阶混淆），点状标记语义更明确；
                       bg-current 借格子的 text-sky-400 取色 */
                    const isToday = dayKey(c.ts) === todayK;
                    return c.n < 0 ? (
                      <span key={c.ts} className="h-[11px] w-[11px]" title={label} />
                    ) : (
                      <span
                        key={c.ts}
                        title={label}
                        className={`h-[11px] w-[11px] rounded-[2px] transition-[background-color] duration-150 hover:brightness-110 ${
                          LEVEL_CLS[levelOf(c.n)]
                        }${isToday ? ' relative text-sky-400' : ''}`}
                      >
                        {isToday && (
                          <span className="absolute right-[1.5px] top-[1.5px] h-[3px] w-[3px] rounded-full bg-current opacity-70" />
                        )}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 关键词 Top 15：度数大者字大/色深，点击回填检索（切回时间轴视图） */}
      {data.topKws.length > 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-black/20 px-4 py-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <BlockTitle>🏷 关键词 Top {data.topKws.length}</BlockTitle>
            <span className="text-[11px] text-slate-600">点击检索该关键词</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
            {data.topKws.map(([kw, c], i) => {
              const tr = tierOf(c);
              return (
                <button
                  key={kw}
                  type="button"
                  onClick={() => onPickKeyword(kw)}
                  title={`关联 ${c} 条 · 点击检索`}
                  className={`rounded bg-black/30 px-1.5 py-0.5 font-mono transition-colors duration-150 hover:bg-sky-400/15 hover:text-sky-200 ${
                    tr < 2 ? 'font-medium' : 'font-semibold'
                  }`}
                  style={{
                    fontSize: `${KW_TIER_PX[tr]}px`,
                    color: i < 3 ? 'rgb(125,211,252)' : undefined,
                  }}
                >
                  {kw}
                  <span className="ml-1 inline-block min-w-[3ch] text-right tabular-nums text-[9px] text-slate-600">
                    {c}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 来源应用 Top 8 + 类型分布 并排（窄屏堆叠） */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {data.topApps.length > 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-black/20 px-4 py-3">
            <div className="mb-2">
              <BlockTitle>🖥 来源应用 Top {data.topApps.length}</BlockTitle>
            </div>
            <div className="space-y-1.5">
              {data.topApps.map(([app, c]) => (
                <div key={app} className="flex items-center gap-2 text-[11px]">
                  <span className="w-24 shrink-0 truncate font-mono text-slate-400" title={app}>
                    {app}
                  </span>
                  <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-sky-500/70 to-sky-400 transition-[width] duration-300"
                      style={{ width: `${Math.max(4, (c / maxApp) * 100)}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-right tabular-nums text-slate-500">
                    <span className="inline-block min-w-[3ch] text-right">{c}</span>
                    <span className="ml-0.5 text-slate-600">
                      {Math.round((c / items.length) * 100)}%
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="rounded-xl border border-white/[0.06] bg-black/20 px-4 py-3">
          <div className="mb-2">
            <BlockTitle>🗂 类型分布</BlockTitle>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(KIND_LABEL) as MemEntry['kind'][]).map((k) => (
              <div
                key={k}
                className={`rounded-lg border px-2 py-1.5 ${
                  data.kindCount.get(k)
                    ? KIND_CLS[k]
                    : 'border-white/[0.06] text-slate-600 opacity-50'
                }`}
              >
                <div className="text-[15px] font-semibold leading-6 tabular-nums">
                  {data.kindCount.get(k) ?? 0}
                </div>
                <div className="text-[10px] opacity-80">
                  {KIND_ICON[k]} {KIND_LABEL[k]}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 最久未使用：Mem「遗忘上下文」的零成本版——不是自动删，只是让用户看见 */}
      {data.oldest.length > 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-black/20 px-4 py-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <BlockTitle>💤 最久未使用</BlockTitle>
            <span className="text-[11px] text-slate-600">
              蒸馏已判定语义重复/过时才会被取代；长期不用的记忆可考虑在时间轴删除
            </span>
          </div>
          <div className="space-y-1.5">
            {data.oldest.map((it) => {
              const lu = data.lastUsed(it);
              const days = Math.floor((Date.now() - lu) / DAY);
              return (
                <div
                  key={it.ts}
                  className="flex items-center gap-2 text-[11.5px]"
                  title={`最后使用：${new Date(lu).toLocaleString()}`}
                >
                  {/* 状态点（I6）：≥30 天未用 amber（遗忘风险），更近的 emerald */}
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      days >= 30 ? 'bg-amber-400' : 'bg-emerald-400'
                    }`}
                  />
                  <span className="shrink-0 text-[10px]">{KIND_ICON[it.kind]}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-400">{it.title}</span>
                  <span className="tabular-nums shrink-0 text-slate-600">
                    {days < 1 ? '今天' : `${days} 天未用`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
