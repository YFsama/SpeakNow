import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button, ConfirmButton, Field, Section, Spinner, TextArea, TextInput, Toggle } from '../Controls';
import { MemGraph } from './MemGraph';
import { MemInsights } from './MemInsights';
import {
  copyText,
  exportText,
  memAddNote,
  memClear,
  memDeleteBatch,
  memImportBackup,
  memImportFiles,
  memImportFolder,
  memImportUrl,
  memList,
  memPurgeSuperseded,
  memRestore,
  memRestoreBackup,
  memSetPinned,
  memStorageStats,
  memUsed,
  typingClipboardText,
} from '../../api';
import { NumberInput, isLocalBaseUrl } from './shared';
import { fmtBytes } from '../../release-notes';
import type {
  MemEntry,
  MemImportProgress,
  MemImportSummary,
  MemListResult,
  MemStorageStats,
  TabProps,
} from '../../types';
import { resolvedLlmCreds } from '../../types';

/* ============ 记忆库（Mem） ============ */

const KIND_LABEL: Record<MemEntry['kind'], string> = {
  dictation: '听写',
  ocr: '取词',
  translate: '翻译',
  note: '快记',
  web: '网页',
  file: '文件',
};

/* 类型配色沿用占位版（听写=sky / 取词=violet / 翻译=emerald），
   三色与历史页的类型语义一致，用户跨页不会重新学习；
   v3 导入来源用 amber/teal/rose 区分 */
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

/** 置顶小节标题：无查询时后端本就把置顶排最前，前端单独成节
 *  （与历史页「⭐ 已收藏」同一范式：置顶不参与日期分组、不占保留名额） */
const PINNED_SECTION = '⭐ 已置顶';

/** 卡片时刻：日期由分组头承载，卡内只留 HH:MM 省空间 */
function fmtHM(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 分组日期标签：今天 / 昨天 / 今年「M月D日」/ 跨年补年份 */
function dayLabel(ts: number, now: Date): string {
  const d = new Date(ts);
  const dayOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((dayOf(now) - dayOf(d)) / 86_400_000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return now.getFullYear() === d.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

/** 正则元字符转义（搜索词按字面匹配）——与历史页同款 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 与后端 llm::llm_ready 同口径：enabled 且地址非空，且（Key 非空或本机端点免 Key）。
 *  只看 enabled 会漏报「开关开了但凭据没填」——那正是蒸馏静默跳过的场景 */
function llmReady(c: TabProps['cfg']): boolean {
  const { baseUrl, apiKey } = resolvedLlmCreds(c);
  return (
    c.llm.enabled &&
    baseUrl.trim() !== '' &&
    (apiKey.trim() !== '' || isLocalBaseUrl(baseUrl))
  );
}

/** 大小写不敏感地高亮命中片段（amber 底色）。用 split+捕获组而非
 *  indexOf(toLowerCase)：规避「İ」等小写化后长度变化导致的索引漂移。
 *  多词搜索按词分别高亮（检索是分词 AND，整串字面匹配永远落空） */
function Highlight({ text, q }: { text: string; q: string }) {
  const terms = q.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi'));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-amber-400/25 px-0.5 text-amber-200">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** 导出 Markdown：按「置顶小节 + 日期」分组，与页面时间轴同一结构；
 *  正文逐行缩进两格，多行文本不打断列表层级 */
function buildMarkdown(items: MemEntry[]): string {
  const now = new Date();
  const lines = [
    '# SpeakNow 记忆库',
    '',
    `> 共 ${items.length} 条 · 导出于 ${now.toLocaleString()}`,
    '',
  ];
  let prevDay = '';
  for (const it of items) {
    // 全量拉取（无查询）时后端已是「置顶优先 + 时间倒序」，置顶天然连续成节
    const day = it.pinned ? PINNED_SECTION : dayLabel(it.ts, now);
    if (day !== prevDay) {
      lines.push(`## ${day}`, '');
      prevDay = day;
    }
    const flags = `${it.pinned ? '★' : ''}${it.distilled ? '✨' : ''}`;
    lines.push(`- **${flags}[${KIND_LABEL[it.kind]}|${it.app || '未知应用'}] ${it.title}**`);
    for (const l of it.text.split('\n')) lines.push(`  ${l}`);
    if (it.keywords.length > 0) lines.push(`  > 关键词：${it.keywords.join('、')}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** 导入摘要统一文案：跳过为 0 时不渲染该段，「跳过 0」只是噪音 */
const summaryText = (s: MemImportSummary) =>
  `新增 ${s.added} / 合并 ${s.merged}${s.skipped > 0 ? ` / 跳过 ${s.skipped}` : ''}`;

/** 软作废判定与后端同口径：supersededBy > 0 即被取代（0/缺省 = 在世） */
const isSuperseded = (it: MemEntry): boolean => (it.supersededBy ?? 0) > 0;

export function MemTab({ cfg, set, toast, navigate }: TabProps) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'' | MemEntry['kind']>('');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [data, setData] = useState<MemListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(false);
  /* 展开态用集合：多条同时展开便于对照，长文各自滚动 */
  const [expandedSet, setExpandedSet] = useState<Set<number>>(new Set());
  /* 两段式删除确认（历史页同款）：单条删除不可撤销，3 秒未复点自动回退 */
  const [confirmDelTs, setConfirmDelTs] = useState<number | null>(null);
  /* 复制成功的行内反馈：按钮短暂变「已复制 ✓」，替代无反馈的静默复制 */
  const [copiedTs, setCopiedTs] = useState<number | null>(null);
  /* 批量删除：多选模式（与行内操作互斥），selected 为按 ts 勾选的集合 */
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /* 乐观置顶：ts → { from: 点击时的服务端真值, to: 目标值 }。服务端真值一旦
     变化（sn-mem-changed 刷新追上，或超 20 上限被后端拒绝）覆盖自动失效，
     无需手动清理，也不会挡住后续刷新 */
  const [pinOverride, setPinOverride] = useState<
    Record<number, { from: boolean; to: boolean }>
  >({});
  const [exporting, setExporting] = useState(false);
  /* 软作废过滤（本地开关，默认关 = 与召回同口径隐藏被取代条目） */
  const [showSuperseded, setShowSuperseded] = useState(false);
  /* 导入中心：快记输入 / 网址输入 / 各通道忙碌态（防重复提交）。
     'bak' = 备份合并导入（v4），与文件/目录导入共用互斥的忙碌态 */
  const [note, setNote] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [urlBusy, setUrlBusy] = useState(false);
  const [dlgBusy, setDlgBusy] = useState<'' | 'files' | 'folder' | 'bak'>('');
  /* 存储卡统计：与列表分开口径（含字节数），随 sn-mem-changed 刷新 */
  const [stats, setStats] = useState<MemStorageStats | null>(null);
  /* 批量导入进度（v4）：只承载 sn-mem-import-progress 的最后一帧；
     null = 无进行中的批次（结束帧停留 600ms 后归位） */
  const [importProg, setImportProg] = useState<MemImportProgress | null>(null);
  /* 视图切换（v5）：时间轴（默认）/ 知识图谱 / 洞察。纯前端 state，
     切换不影响时间轴的检索/多选/导出等既有状态 */
  const [view, setView] = useState<'timeline' | 'graph' | 'insights'>('timeline');
  /* 图谱/洞察的全量数据（与时间轴的 500 条查询分开拉取，进入视图才拉） */
  const [full, setFull] = useState<MemEntry[] | null>(null);
  const [fullErr, setFullErr] = useState(false);
  const fullSeq = useRef(0);
  /* 检索防抖句柄 + 请求序号：250ms 内合并键击；序号守卫防慢的旧响应覆盖新响应 */
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seqRef = useRef(0);

  const refresh = useCallback(() => {
    const seq = ++seqRef.current;
    setLoading(true);
    memList(query, kind || null, 500)
      .then((r) => {
        if (seqRef.current !== seq) return;
        setData(r);
        setLoadErr(false);
        /* 外部变化（超限滚动清理/悬浮窗入库）刷新后，选择集可能残留已消失的
           ts，按新列表修剪，否则「已选 N 条」计数失真 */
        setSelected((s) => {
          const alive = new Set(r.items.map((x) => x.ts));
          const next = new Set([...s].filter((t) => alive.has(t)));
          return next.size === s.size ? s : next;
        });
      })
      .catch(() => {
        if (seqRef.current === seq) setLoadErr(true);
      })
      .finally(() => {
        if (seqRef.current === seq) setLoading(false);
      });
  }, [query, kind]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(refresh, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [refresh]);

  /* 事件订阅只挂一次（query/kind 变化只换回调不换订阅）：
     避免每敲一个字符都走一轮 listen/unlisten IPC 往返 */
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const un = listen('sn-mem-changed', () => refreshRef.current());
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (confirmDelTs === null) return;
    const t = setTimeout(() => setConfirmDelTs(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDelTs]);

  /* 存储卡统计：挂载拉取 + sn-mem-changed（采集/导入/删除/清理）后刷新。
     提为 useCallback 让事件订阅与治理按钮回调共用同一份口径——清理/整库
     回滚后即便后端漏发事件，按钮路径也保证数字即时对齐 */
  const pullStats = useCallback(() => {
    memStorageStats()
      .then(setStats)
      .catch(() => {
        /* 旧后端无此命令：存储卡静默不显示，不打扰既有功能 */
      });
  }, []);

  useEffect(() => {
    pullStats();
    const un = listen('sn-mem-changed', pullStats);
    return () => {
      un.then((f) => f());
    };
  }, [pullStats]);

  /* 批量导入进度（v4）：后端逐文件广播 sn-mem-import-progress，挂载订阅一次。
     与列表刷新解耦——进度只是瞬时反馈，不应牵动防抖检索。
     单文件批次（total<=1）不出条：完成走既有 summary toast 即可；
     结束帧（done==total 且 label 空）延迟 600ms 收起，让 100% 被看见 */
  const progHideRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const un = listen<MemImportProgress>('sn-mem-import-progress', (e) => {
      const p = e.payload;
      if (!p || p.total <= 1) return;
      if (progHideRef.current) clearTimeout(progHideRef.current);
      setImportProg(p);
      if (p.done >= p.total && p.label === '') {
        progHideRef.current = setTimeout(() => setImportProg(null), 600);
      }
    });
    return () => {
      un.then((f) => f());
      if (progHideRef.current) clearTimeout(progHideRef.current);
    };
  }, []);

  /* 图谱/洞察（v5）：进入视图时全量拉取一次（10000 上限兜底），视图内订阅
     sn-mem-changed 保持同步；回到时间轴即退订——时间轴仍走上方 500 条防抖
     链路，两条数据通道互不牵动 */
  const pullFull = useCallback(() => {
    const seq = ++fullSeq.current;
    setFullErr(false);
    memList('', null, 10000)
      .then((r) => {
        if (fullSeq.current === seq) setFull(r.items);
      })
      .catch(() => {
        if (fullSeq.current === seq) setFullErr(true);
      });
  }, []);

  useEffect(() => {
    if (view === 'timeline') return;
    pullFull();
    const un = listen('sn-mem-changed', pullFull);
    return () => {
      un.then((f) => f());
    };
  }, [view, pullFull]);

  /* 软作废与时间轴默认口径一致地滤掉；useMemo 稳定引用是图谱物理不重启的
     前提（items 引用变一次 = 整张图重新布局） */
  const aliveFull = useMemo(
    () => (full ?? []).filter((it) => !isSuperseded(it)),
    [full],
  );

  /* 图谱/洞察能看到的关键词 → 回填搜索并切回时间轴：复用既有防抖检索链路 */
  const pickKeyword = useCallback((kw: string) => {
    setQuery(kw);
    setView('timeline');
  }, []);

  /* 图谱/洞察共用加载门面：全量数据未就绪/失败时统一占位 */
  const fullGate = (child: ReactNode): ReactNode =>
    fullErr ? (
      <div className="rounded-lg border border-dashed border-red-500/25 py-8 text-center text-xs leading-6 text-slate-500">
        记忆加载失败
        <button
          type="button"
          onClick={pullFull}
          className="ml-2 text-sky-400 transition-colors duration-150 hover:text-sky-300"
        >
          重试
        </button>
      </div>
    ) : full === null ? (
      <div className="rounded-lg border border-dashed border-white/10 py-8 text-center text-xs text-[var(--sn-text-4)]">
        加载中…
      </div>
    ) : (
      child
    );

  const m = cfg.mem;
  const items = data?.items ?? [];
  const searching = query.trim() !== '';
  const hasFilter = searching || kind !== '' || pinnedOnly;

  const pinOf = (it: MemEntry): boolean => {
    const ov = pinOverride[it.ts];
    if (!ov || ov.from !== it.pinned) return it.pinned;
    return ov.to;
  };

  /* 点击即本地翻转星标（不等事件往返），成功后由 sn-mem-changed 广播自然对齐；
     失败 toast 报错并回退到服务端真值 */
  const onTogglePin = async (it: MemEntry) => {
    const next = !pinOf(it);
    setPinOverride((map) => ({ ...map, [it.ts]: { from: it.pinned, to: next } }));
    try {
      await memSetPinned(it.ts, next);
    } catch (e) {
      setPinOverride((map) => {
        const n = { ...map };
        delete n[it.ts];
        return n;
      });
      toast(`置顶失败：${String(e)}`, 'error');
    }
  };

  /* 置顶过滤在前端做：memList 只接受 query/kind 两参；无查询时后端本就把
     置顶排最前，保序过滤即可，不违反「前端不重排序」的口径。
     软作废同为本端过滤：默认隐藏（与召回同口径），开「已作废」开关才可见 */
  const visible = items.filter(
    (it) => (showSuperseded || !isSuperseded(it)) && (!pinnedOnly || pinOf(it)),
  );

  const toggleSel = (ts: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(ts)) n.delete(ts);
      else n.add(ts);
      return n;
    });

  /* 进入多选时收起单条删除的待确认态（两套操作互斥） */
  const enterSelect = () => {
    setSelectMode(true);
    setConfirmDelTs(null);
  };
  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  /* 全选当前筛选结果；已全选时清空（起反选作用） */
  const selectAll = () =>
    setSelected((s) => {
      const all = new Set(visible.map((x) => x.ts));
      if (all.size === s.size && [...all].every((t) => s.has(t))) return new Set();
      return all;
    });

  /* 没有独立的单删命令：mem_delete_batch([ts]) 一次调用等价 */
  const onDeleteBatch = async (tsList: number[]) => {
    if (tsList.length === 0) return;
    try {
      const n = await memDeleteBatch(tsList);
      /* 批量删除收起多选并提示条数；单条删除的反馈是条目本身消失，不弹 toast */
      if (tsList.length > 1) {
        exitSelect();
        toast(`已删除 ${n} 条`, 'ok');
      }
      refresh();
    } catch (e) {
      toast(`删除失败：${String(e)}`, 'error');
    }
  };

  /* 行内两段式删除（历史页同款）：首击进入待确认态，3 秒内复击才真正删除 */
  const onDeleteOne = async (ts: number) => {
    if (confirmDelTs !== ts) {
      setConfirmDelTs(ts);
      return;
    }
    setConfirmDelTs(null);
    await onDeleteBatch([ts]);
  };

  const onClear = async () => {
    try {
      await memClear();
      exitSelect();
      toast('记忆库已清空', 'ok');
    } catch (e) {
      toast(`清空失败：${String(e)}`, 'error');
    }
  };

  /* ---- 软作废治理 / 备份（v4） ---- */

  /* 恢复一条软作废：选乐观更新而非等 sn-mem-changed——软作废是本端过滤
     口径，事件往返期间卡片会带着「已被取代」徽章滞留，先本地清零
     supersededBy 让徽章即刻摘掉；失败时用 refresh 回滚到服务端真值。
     不像置顶需要 override map：恢复是一锤子买卖，没有快速连点场景 */
  const onRestore = async (ts: number) => {
    setData((d) =>
      d
        ? {
            ...d,
            items: d.items.map((x) => (x.ts === ts ? { ...x, supersededBy: 0 } : x)),
          }
        : d,
    );
    try {
      await memRestore(ts);
      toast('已恢复', 'ok');
    } catch (e) {
      toast(`恢复失败：${String(e)}`, 'error');
      refresh();
    }
  };

  /* 物理清理全部软作废（不可恢复，ConfirmButton 已做两段确认）：
     toast 用后端返回值——并发变动下实际清理数可能与存储卡显示不同 */
  const onPurge = async () => {
    try {
      const n = await memPurgeSuperseded();
      toast(`已清理 ${n} 条`, 'ok');
      refresh();
      pullStats();
    } catch (e) {
      toast(`清理失败：${String(e)}`, 'error');
    }
  };

  /* 整库回滚：后端先把当前库另存 mem.pre-restore.json 再用备份顶替
     （ConfirmButton 文案已点明后果）；Err 文案（如「没有可恢复的备份」）
     由后端给出，这里原样透出 */
  const onRestoreBackup = async () => {
    try {
      const n = await memRestoreBackup();
      toast(`已恢复 ${n} 条`, 'ok');
      refresh();
      pullStats();
    } catch (e) {
      toast(`恢复失败：${String(e)}`, 'error');
    }
  };

  /* 多设备迁移：选另一台设备「导出 JSON」得到的备份文件做合并导入。
     只增不覆盖（近重复走既有合并）；与文件/目录导入共用 dlgBusy 互斥 */
  const onImportBackup = async () => {
    if (dlgBusy !== '') return;
    let path: string | null = null;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      path = await open({
        multiple: false,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
    } catch {
      toast('浏览器预览不支持选择文件', 'info');
      return;
    }
    if (!path) return; // 对话框取消
    setDlgBusy('bak');
    try {
      const s = await memImportBackup(path);
      toast(`合并完成（${summaryText(s)}）`, 'ok');
    } catch (e) {
      toast(`合并导入失败：${String(e)}`, 'error');
    } finally {
      setDlgBusy('');
    }
  };

  /* 导出始终全量拉库（limit 10000 上限兜底），而非当前筛选视图：
     导出的心智是「备份带走全部」，且不受本页 limit 500 截断影响 */
  const onExport = async (fmt: 'md' | 'json') => {
    if ((data?.total ?? 0) === 0) {
      toast('记忆库为空，没有可导出的内容', 'info');
      return;
    }
    setExporting(true);
    try {
      const full = await memList('', null, 10000);
      const content =
        fmt === 'json'
          ? JSON.stringify(full.items, null, 2)
          : buildMarkdown(full.items);
      const path = await exportText(
        fmt === 'json' ? 'memory_export.json' : 'memory_export.md',
        content,
      );
      if (path) toast(`已导出 ${full.items.length} 条：${path}`, 'ok');
      else toast('已取消导出', 'info');
    } catch (e) {
      toast(`导出失败：${String(e)}`, 'error');
    } finally {
      setExporting(false);
    }
  };

  /* ---- 导入与快记（v3） ----
     所有通道共用 MemImportSummary 口径的 toast；后端负责近重复合并与蒸馏 */

  /* 快记入库（输入框与剪贴板共用一条路径，成功后由 sn-mem-changed 刷新列表） */
  const addNote = async (raw: string) => {
    const text = raw.trim();
    if (!text || noteBusy) return;
    setNoteBusy(true);
    try {
      const s = await memAddNote(text);
      toast(`已记下（新增 ${s.added} / 合并 ${s.merged}）`, 'ok');
      setNote('');
    } catch (e) {
      toast(`记下失败：${String(e)}`, 'error');
    } finally {
      setNoteBusy(false);
    }
  };

  /* 从剪贴板记一条：先只读探测（typingClipboardText 不写剪贴板），空文本单独提示 */
  const onClipNote = async () => {
    if (noteBusy) return;
    let text = '';
    try {
      text = await typingClipboardText();
    } catch (e) {
      toast(`读取剪贴板失败：${String(e)}`, 'error');
      return;
    }
    if (!text.trim()) {
      toast('剪贴板没有文本', 'info');
      return;
    }
    await addNote(text);
  };

  /* 导入网页：前端只挡明显非 http(s) 的输入，其余（超时/超大/非网页）由后端
     校验并 reject，这里统一 catch 出文案 */
  const onImportUrl = async () => {
    const u = url.trim();
    if (!u || urlBusy) return;
    if (!/^https?:\/\//i.test(u)) {
      toast('请输入 http:// 或 https:// 开头的网址', 'info');
      return;
    }
    setUrlBusy(true);
    try {
      const s = await memImportUrl(u);
      toast(`导入完成（${summaryText(s)}）`, 'ok');
      setUrl('');
    } catch (e) {
      toast(`导入失败：${String(e)}`, 'error');
    } finally {
      setUrlBusy(false);
    }
  };

  /* mock 环境下 dialog 桥接返回单个字符串、真机 multiple 返回数组——归一成 string[] */
  const onImportFiles = async () => {
    if (dlgBusy !== '') return;
    let paths: string[] = [];
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: true,
        filters: [{ name: '文本', extensions: ['txt', 'md'] }],
      });
      paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    } catch {
      toast('浏览器预览不支持选择文件，请输入 URL 或快记体验', 'info');
      return;
    }
    if (paths.length === 0) return; // 对话框取消
    setDlgBusy('files');
    try {
      const s = await memImportFiles(paths);
      toast(`导入完成（${summaryText(s)}）`, 'ok');
    } catch (e) {
      toast(`导入失败：${String(e)}`, 'error');
    } finally {
      setDlgBusy('');
      // 兜底清进度条：结束帧事件若因异常丢失（emit 失败被后端吞掉），
      // 600ms 收条定时器永远不会挂上，靠动作收尾强清
      if (progHideRef.current) clearTimeout(progHideRef.current);
      setImportProg(null);
    }
  };

  const onImportFolder = async () => {
    if (dlgBusy !== '') return;
    let dir: string | null = null;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      dir = await open({ directory: true });
    } catch {
      toast('浏览器预览不支持选择文件，请输入 URL 或快记体验', 'info');
      return;
    }
    if (!dir) return; // 对话框取消
    setDlgBusy('folder');
    try {
      const s = await memImportFolder(dir);
      toast(`导入完成（${summaryText(s)}）`, 'ok');
    } catch (e) {
      toast(`导入失败：${String(e)}`, 'error');
    } finally {
      setDlgBusy('');
      // 同文件导入：结束帧丢失时的进度条强清兜底
      if (progHideRef.current) clearTimeout(progHideRef.current);
      setImportProg(null);
    }
  };

  /* ---- 分组 ----
     无查询 = 置顶小节 + 按日期分组（后端已按时间倒序，前端只分组不排序）；
     有查询 = 后端按命中加权分排序（非时间序），日期头会来回跳，改单组平铺。
     每组一个 wrapper：粘性日期头只在本组范围内吸附（组尾把它顶出去），
     半透明磨砂底也能保证任意时刻至多一个日期头停在顶部、互不叠字 */
  const now = new Date();
  const groups: { day: string; items: MemEntry[] }[] = [];
  if (!searching) {
    const pinned = visible.filter((it) => pinOf(it));
    if (pinned.length > 0) groups.push({ day: PINNED_SECTION, items: pinned });
    let prevDay = '';
    for (const it of visible.filter((x) => !pinOf(x))) {
      const day = dayLabel(it.ts, now);
      const cur = groups[groups.length - 1];
      if (cur && day === prevDay) cur.items.push(it);
      else {
        groups.push({ day, items: [it] });
        prevDay = day;
      }
    }
  } else if (visible.length > 0) {
    groups.push({ day: '', items: visible });
  }

  /* ---- 安全态势（v4）：三条「记忆内容会不会离开本机」的通道 ----
     纯展示无独立状态，全部由 cfg 现值推导；行文案即结论，用户不必自行
     拼装「服务开没开 × 允不允许局域网 × 有没有令牌」的布尔矩阵 */
  const ext = cfg.externalDisplay;
  const token = m.apiToken.trim();
  const lanOpen = ext.enabled && ext.allowLan;
  const blLines = m.captureBlacklist.split('\n').filter((l) => l.trim() !== '').length;
  /* 蒸馏的出网判定借用 llmReady：凭据不齐时后端本就静默跳过蒸馏，
     此时标「将发送」是吓唬用户；真正的修复引导由上方 LLM 未就绪横幅承担 */
  const llmBase = resolvedLlmCreds(cfg).baseUrl;
  const distillActive = m.distill && llmReady(cfg);
  const posture: { label: string; text: string; warn: boolean }[] = [
    {
      label: 'REST 暴露面',
      text: !ext.enabled
        ? '未启用（记忆仅本机）'
        : !lanOpen
          ? '仅本机'
          : token !== ''
            ? '局域网 · 令牌保护'
            : '局域网 · ⚠ 未生成令牌（远程将被拒绝）',
      warn: lanOpen && token === '',
    },
    {
      label: '采集黑名单',
      text: blLines > 0 ? `内置名单 + 自定义 ${blLines} 行` : '仅内置名单',
      warn: false,
    },
    {
      label: 'AI 蒸馏',
      text: !m.distill
        ? '关闭（内容不出本机）'
        : !distillActive
          ? '开启 · LLM 未就绪（蒸馏跳过，内容不出本机）'
          : isLocalBaseUrl(llmBase)
            ? '开启 · 本地推理'
            : '开启 · 内容将发送至配置的 LLM 接口',
      warn: distillActive && !isLocalBaseUrl(llmBase),
    },
  ];

  return (
    <>
      <Section
        icon="🧠"
        title="记忆库"
        desc="听写、截图取词、翻译的产出自动沉淀为可检索的个人记忆——「说过/看过/译过」皆可追索。"
      >
        {/* 统计带：三项均为后端累计口径（不受当前筛选影响）。
            T9：数字首次入场 anim-rise，数值变化靠 key 重挂触发 wordInFade */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: '累计记忆', value: data?.total, unit: '条' },
            { label: '今日新增', value: data?.todayCount, unit: '条' },
            { label: '累计字数', value: data?.totalChars, unit: '字' },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-xl border border-[var(--sn-border)] bg-[var(--sn-surface-3)] px-4 py-3"
            >
              <div className="text-[11px] text-slate-500">{s.label}</div>
              <div className="anim-rise tabular-nums mt-1 text-xl font-semibold text-[var(--sn-text-1)]">
                <span key={s.value ?? 'na'} className="word-in-fade">
                  {s.value == null ? '—' : s.value.toLocaleString()}
                </span>
                <span className="ml-1 text-[11px] font-normal text-slate-500">
                  {s.unit}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* 存储卡：磁盘占用与条目构成（软作废条目仍占存储、近重复合并不增条数，
            所以占用与上方「累计记忆」是两套口径）。样式与统计带同一卡片语言 */}
        {stats && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-[var(--sn-border)] bg-[var(--sn-surface-3)] px-4 py-2.5 text-[11.5px] leading-5 text-slate-500">
            <span className="shrink-0">📦 存储</span>
            <span className="tabular-nums font-medium text-[var(--sn-text-2)]">
              {stats.items} 条
            </span>
            <span className="tabular-nums">
              （置顶 {stats.pinned} / 已作废 {stats.superseded}）
            </span>
            <span className="text-slate-700">·</span>
            <span className="tabular-nums font-medium text-[var(--sn-text-2)]">
              {fmtBytes(stats.bytes)}
            </span>
            {stats.bakBytes > 0 && (
              <span className="tabular-nums">（备份 {fmtBytes(stats.bakBytes)}）</span>
            )}
            <span className="text-slate-700">·</span>
            <span className="tabular-nums font-medium text-[var(--sn-text-2)]">
              {stats.chars.toLocaleString()} 字
            </span>
          </div>
        )}

        {/* 治理与备份（v4）：软作废物理清理 / 整库回滚 / 多设备合并导入。
            与存储条同一卡片语言成对出现（「看存储 → 管存储」动线），可见性
            跟随 stats——旧后端无统计时整块隐藏。ConfirmButton 无 disabled
            通道，空态退化为同款样式的禁用 Button 提示原因 */}
        {stats && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-[var(--sn-border)] bg-[var(--sn-surface-3)] px-4 py-2.5">
            <span className="shrink-0 text-[11.5px] leading-5 text-slate-500">🧹 治理</span>
            {stats.superseded > 0 ? (
              <ConfirmButton
                label="清理已作废"
                confirmLabel={`确认清理 ${stats.superseded} 条？`}
                onConfirm={() => void onPurge()}
                title="物理删除全部已作废条目（不可恢复）；已作废条目即使置顶也会一并清理，在世记忆不受影响"
              />
            ) : (
              <Button disabled title="暂无已作废条目">
                清理已作废
              </Button>
            )}
            <span className="text-slate-700">·</span>
            {stats.bakBytes > 0 ? (
              <ConfirmButton
                label="从备份恢复"
                confirmLabel="确认整库回滚？"
                onConfirm={() => void onRestoreBackup()}
                title="当前库会先另存 mem.pre-restore.json，然后整库回滚到最近一次自动备份"
              />
            ) : (
              <Button disabled title="暂无备份">
                从备份恢复
              </Button>
            )}
            <Button
              onClick={() => void onImportBackup()}
              disabled={dlgBusy !== ''}
              title="选择另一台设备「导出 JSON」的备份文件合并进本机：只增不覆盖，近重复走既有合并"
            >
              {dlgBusy === 'bak' ? <Spinner size={14} /> : '从备份合并导入'}
            </Button>
            <span className="min-w-[240px] flex-1 text-[11px] leading-5 text-[var(--sn-text-4)]">
              合并导入是多设备迁移路径：另一台设备导出的 JSON 拿来合并，不覆盖本机记忆
            </span>
          </div>
        )}

        {/* 视图切换（v5）：时间轴 / 图谱 / 洞察。图谱与洞察自带过滤
            （时间档位/模式），切换后隐藏搜索与类型 chips 避免两套过滤器打架。
            T6：绝对定位 thumb 随索引滑动（spring 曲线 200ms），三等分等宽段 */}
        <div className="relative flex rounded-full border border-white/10 bg-[var(--sn-surface-3)] p-0.5">
          <span
            aria-hidden
            className="absolute bottom-0.5 left-0.5 top-0.5 rounded-full bg-sky-500/15 transition-[left] duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
            style={{
              width: 'calc((100% - 4px) / 3)',
              left: `calc(2px + ${
                view === 'timeline' ? 0 : view === 'graph' ? 1 : 2
              } * (100% - 4px) / 3)`,
            }}
          />
          {(
            [
              { v: 'timeline', label: '📋 时间轴' },
              { v: 'graph', label: '🕸 图谱' },
              { v: 'insights', label: '📊 洞察' },
            ] as const
          ).map((o) => (
            <button
              key={o.v}
              type="button"
              onClick={() => setView(o.v)}
              aria-pressed={view === o.v}
              className={`relative z-10 flex-1 rounded-full px-3.5 py-1.5 text-[11.5px] transition-colors duration-150 ${
                view === o.v
                  ? 'font-medium text-sky-300'
                  : 'text-[var(--sn-text-3)] hover:text-[var(--sn-text-2)]'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {/* 搜索 + 结果数 + 多选入口 */}
        {view === 'timeline' && (
          <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[200px] flex-1">
            <TextInput
              value={query}
              onChange={setQuery}
              placeholder="搜索标题 / 正文 / 关键词（多词空格分隔，全部命中才返回）…"
            />
            {query && (
              <button
                type="button"
                title="清空搜索"
                onClick={() => setQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded px-1 text-[13px] leading-none text-slate-500 transition-colors duration-150 hover:text-[var(--sn-text-2)]"
              >
                ✕
              </button>
            )}
          </div>
          {data && (
            <span
              title={hasFilter ? '筛选结果 / 全部记忆' : '库内全部记忆'}
              className="rounded-full border border-white/[0.08] bg-[var(--sn-surface-3)] px-2.5 py-1 font-mono text-[10.5px] text-slate-500"
            >
              {hasFilter ? `${visible.length} 条结果` : `共 ${data.total} 条`}
            </span>
          )}
          {items.length > 0 && (
            <Button
              onClick={() => (selectMode ? exitSelect() : enterSelect())}
              title="勾选多条记忆后批量删除"
              kind={selectMode ? 'primary' : 'ghost'}
            >
              {selectMode ? '退出选择' : '选择'}
            </Button>
          )}
          </div>
        )}

        {/* 类型过滤 + 置顶过滤 + 导出/清空：类型 chips 仅时间轴可见（图谱/洞察
            自带过滤）；导出/清空对全库操作，任何视图都保持可达 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {view === 'timeline' && (
            <div className="flex flex-wrap items-center gap-1.5">
            {/* 类型 chips 含 v3 导入来源（快记/网页/文件）：导入的内容也要能一键筛出 */}
            {(
              ['', 'dictation', 'ocr', 'translate', 'note', 'web', 'file'] as const
            ).map((k) => {
              const active = kind === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors duration-150 ${
                    active
                      ? 'border-sky-500/60 bg-sky-500/10 text-sky-300'
                      : 'border-white/10 bg-[var(--sn-surface-3)] text-[var(--sn-text-3)] hover:border-[var(--sn-border-strong)] hover:text-[var(--sn-text-2)]'
                  }`}
                >
                  {k === '' ? '全部' : `${KIND_ICON[k]} ${KIND_LABEL[k]}`}
                </button>
              );
            })}
            {/* 置顶过滤：本地开关（后端无此参数），active 用 amber 与类型色区分 */}
            <button
              type="button"
              onClick={() => setPinnedOnly((v) => !v)}
              aria-pressed={pinnedOnly}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors duration-150 ${
                pinnedOnly
                  ? 'border-amber-400/50 bg-amber-400/10 text-amber-300'
                  : 'border-white/10 bg-[var(--sn-surface-3)] text-[var(--sn-text-3)] hover:border-[var(--sn-border-strong)] hover:text-[var(--sn-text-2)]'
              }`}
            >
              ★ 置顶
            </button>
            {/* 软作废过滤：独立小开关而非塞进类型 chips——「已作废」是状态不是来源，
               默认关 = 与召回同口径隐藏；开启后时间轴可见（可对照/导出） */}
            <button
              type="button"
              onClick={() => setShowSuperseded((v) => !v)}
              aria-pressed={showSuperseded}
              title="软作废条目默认隐藏（与召回一致）；开启后在此查看，导出始终保留"
              className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors duration-150 ${
                showSuperseded
                  ? 'border-slate-400/50 bg-slate-400/10 text-[var(--sn-text-2)]'
                  : 'border-white/10 bg-[var(--sn-surface-3)] text-[var(--sn-text-3)] hover:border-[var(--sn-border-strong)] hover:text-[var(--sn-text-2)]'
              }`}
            >
              ⊘ 已作废
            </button>
            </div>
          )}
          {(data?.total ?? 0) > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-slate-500">导出</span>
              {(
                [
                  { fmt: 'md' as const, label: '导出 Markdown' },
                  { fmt: 'json' as const, label: '导出 JSON' },
                ]
              ).map((e) => (
                <button
                  key={e.fmt}
                  type="button"
                  disabled={exporting}
                  onClick={() => void onExport(e.fmt)}
                  title="全量导出（不受当前搜索/筛选影响），保存位置由系统对话框选择"
                  className="rounded-full border border-white/10 bg-[var(--sn-surface-3)] px-2.5 py-1 text-[11px] text-[var(--sn-text-2)] transition-colors duration-150 hover:border-[var(--sn-border-strong)] hover:text-[var(--sn-text-1)] disabled:opacity-50"
                >
                  {e.label}
                </button>
              ))}
              <ConfirmButton
                label="清空"
                confirmLabel="确认清空全部？"
                onConfirm={() => void onClear()}
                title="清空会删除全部记忆（含置顶），不可恢复"
              />
            </div>
          )}
        </div>

        {/* 采集关闭横幅：只提醒不藏列表，既有记忆仍可检索导出 */}
        {!m.enabled && (
          <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3.5 py-2.5 text-[11.5px] leading-5 text-amber-200/90">
            ⏸ 采集已关闭：不再沉淀新记忆，仍可检索、置顶与导出既有内容（开关见下方「采集设置」）
          </div>
        )}

        {/* 主体区按视图切换：图谱/洞察只换这一块，采集横幅与统计带全视图共享 */}
        {view === 'graph'
          ? fullGate(
              <MemGraph
                items={aliveFull}
                onPickKeyword={pickKeyword}
                onGoDictate={() => navigate('dash')}
              />,
            )
          : view === 'insights'
            ? fullGate(<MemInsights items={aliveFull} onPickKeyword={pickKeyword} />)
            : loadErr ? (
          <div className="rounded-lg border border-dashed border-red-500/25 py-8 text-center text-xs leading-6 text-slate-500">
            记忆加载失败
            <button
              type="button"
              onClick={refresh}
              className="ml-2 text-sky-400 transition-colors duration-150 hover:text-sky-300"
            >
              重试
            </button>
          </div>
        ) : data === null ? (
          /* T7 骨架卡：首帧（列表未到）用 3 张与实体卡同构的骨架占位，
             比「加载中…」更能锚定即将出现的内容版式 */
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="rounded-lg border border-[var(--sn-border)] bg-[var(--sn-surface-3)] px-4 py-3"
              >
                <div className="flex h-6 items-center gap-2">
                  <div className="skeleton h-4 w-14 rounded-full" />
                  <div className="skeleton h-3.5 min-w-0 max-w-[260px] flex-1" />
                </div>
                <div className="skeleton mt-2 h-3 w-full" />
                <div className="skeleton mt-2 h-3 w-2/3" />
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          /* 空态四分（T8）：图标 + 主/副文 + 行动按钮，按成因给各自出路
             （空库→去听写 / 搜索落空→清空搜索 / 类型落空→切回全部 / 无置顶→纯引导） */
          <div className="rounded-lg border border-dashed border-white/10 px-4 py-10 text-center">
            {data.total === 0 ? (
              <>
                <div className="text-[28px] leading-none opacity-60">🧠</div>
                <div className="mt-3 text-[13px] leading-6 text-[var(--sn-text-3)]">
                  记忆库还是空的
                </div>
                <div className="mt-1 text-[11px] leading-5 text-[var(--sn-text-4)]">
                  使用听写、截图取词、划词翻译后，产出会自动沉淀到这里，随时可检索
                </div>
                <div className="mt-3">
                  <Button kind="primary" onClick={() => navigate('dash')}>
                    去听写 →
                  </Button>
                </div>
              </>
            ) : searching ? (
              <>
                <div className="text-[28px] leading-none opacity-60">🔍</div>
                <div className="mt-3 text-[13px] leading-6 text-[var(--sn-text-3)]">
                  没有匹配「{query.trim()}」的记忆
                </div>
                <div className="mt-1 text-[11px] leading-5 text-[var(--sn-text-4)]">
                  试试更短的关键词，或切换类型筛选（多词之间是「与」关系）
                </div>
                <div className="mt-3">
                  <Button onClick={() => setQuery('')}>清空搜索</Button>
                </div>
              </>
            ) : kind !== '' ? (
              <>
                <div className="text-[28px] leading-none opacity-60">{KIND_ICON[kind]}</div>
                <div className="mt-3 text-[13px] leading-6 text-[var(--sn-text-3)]">
                  该类型暂无记忆
                </div>
                <div className="mt-1 text-[11px] leading-5 text-[var(--sn-text-4)]">
                  切换「全部」查看所有记忆
                </div>
                <div className="mt-3">
                  <Button onClick={() => setKind('')}>切回全部</Button>
                </div>
              </>
            ) : (
              <>
                <div className="text-[28px] leading-none opacity-60">⭐</div>
                <div className="mt-3 text-[13px] leading-6 text-[var(--sn-text-3)]">
                  还没有置顶的记忆
                </div>
                <div className="mt-1 text-[11px] leading-5 text-[var(--sn-text-4)]">
                  点击条目标题行的 ☆ 置顶常用记忆，置顶不占保留条数名额
                </div>
              </>
            )}
          </div>
        ) : (
          <div
            className={`sn-scroll max-h-[480px] overflow-y-auto pr-1 transition-opacity duration-150 ${
              loading ? 'opacity-60' : ''
            }`}
          >
            {groups.map((g) => (
              <div key={g.day || '搜索结果'} className="mt-4 space-y-2 first:mt-0">
                {g.day && (
                  /* 粘性日期头：滚动时贴在本组顶部、组尾把它顶出去——组 wrapper
                     限定吸附范围，保证半透明磨砂底下任意时刻至多一个日期头在
                     顶部、互不叠字；bg-black/45 深浅两主题都有浅色映射
                     （black/70 无浅色覆盖会呈纯黑）。
                     T5：左文字 + 右延发丝线（after 伪元素 flex-1），去掉两侧破折号 */
                  <div
                    className={`sticky top-0 z-10 flex items-center gap-2 bg-black/45 py-1.5 pl-0.5 text-[10px] tracking-widest backdrop-blur after:h-px after:flex-1 after:bg-[var(--sn-border)] after:content-[''] ${
                      g.day === PINNED_SECTION
                        ? 'text-amber-500/80'
                        : 'text-[var(--sn-text-4)]'
                    }`}
                  >
                    {g.day}
                  </div>
                )}
                {g.items.map((it) => {
                  const isSel = selected.has(it.ts);
                  const isPinned = pinOf(it);
                  const expanded = expandedSet.has(it.ts);
                  /* 软作废整体降不透明度：徽章 + 淡化双通道表达「还在但已退场」 */
                  const dead = isSuperseded(it);
                  return (
                    <div
                      key={it.ts}
                      className={`group rounded-lg border px-4 py-3 transition-colors duration-150 ${
                        isSel
                          ? 'border-sky-500/40 bg-sky-500/[0.04]'
                          : 'border-[var(--sn-border)] bg-[var(--sn-surface-3)] hover:border-[var(--sn-border-strong)]'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {selectMode && (
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={isSel}
                            onClick={() => toggleSel(it.ts)}
                            title="选中 / 取消选中"
                            aria-label="选中该条记忆"
                            className={`mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border text-[10px] font-bold leading-none transition-colors duration-150 ${
                              isSel
                                ? 'border-sky-400 bg-sky-500/80 text-white'
                                : 'border-white/25 text-transparent hover:border-sky-400/60'
                            }`}
                          >
                            ✓
                          </button>
                        )}
                        <div className={`min-w-0 flex-1 ${dead ? 'opacity-60' : ''}`}>
                          {/* 标题行：类型徽章 + 软作废标 + 蒸馏标 + 标题 + 置顶星标（可点）+ 时刻。
                              T2：行高固定 h-6，多行徽章/星标不再撑高抖动 */}
                          <div className="flex h-6 items-center gap-2">
                            <span
                              className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${KIND_CLS[it.kind]}`}
                            >
                              {KIND_LABEL[it.kind]}
                            </span>
                            {dead && (
                              <span
                                title="被更新的记忆取代，召回不再出现，可在导出中保留"
                                className="shrink-0 rounded-full border border-slate-500/25 bg-slate-500/10 px-2 py-0.5 text-[10px] text-[var(--sn-text-3)]"
                              >
                                已被取代
                              </span>
                            )}
                            {it.distilled && (
                              <span title="AI 蒸馏" className="shrink-0 text-[11px]">
                                ✨
                              </span>
                            )}
                            <span
                              className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--sn-text-2)]"
                              title={it.title}
                            >
                              <Highlight text={it.title} q={query} />
                            </span>
                            {!selectMode && (
                              <button
                                type="button"
                                onClick={() => void onTogglePin(it)}
                                title={
                                  isPinned
                                    ? '取消置顶'
                                    : '置顶（排最前，不占保留条数名额）'
                                }
                                aria-label={isPinned ? '取消置顶' : '置顶'}
                                aria-pressed={isPinned}
                                className={`shrink-0 text-[11px] leading-none transition-colors duration-150 ${
                                  isPinned
                                    ? 'text-amber-400'
                                    : 'text-[var(--sn-text-4)] hover:text-amber-300'
                                }`}
                              >
                                {isPinned ? '⭐' : '☆'}
                              </button>
                            )}
                            {/* T3：时刻 hover（卡悬停）提亮 + title 完整时间，11px */}
                            <span
                              title={new Date(it.ts).toLocaleString()}
                              className="tabular-nums shrink-0 font-mono text-[11px] text-[var(--sn-text-4)] transition-colors duration-150 group-hover:text-[var(--sn-text-3)]"
                            >
                              {fmtHM(it.ts)}
                            </span>
                          </div>
                          {/* 正文：默认 2 行截断，点击展开全文（长文区内滚动） */}
                          <div
                            onClick={() =>
                              setExpandedSet((s) => {
                                const n = new Set(s);
                                if (n.has(it.ts)) n.delete(it.ts);
                                else n.add(it.ts);
                                return n;
                              })
                            }
                            title={expanded ? '点击收起' : '点击展开全文'}
                            className={
                              expanded
                                ? 'sn-scroll mt-1.5 max-h-72 cursor-pointer overflow-y-auto whitespace-pre-wrap text-[12px] leading-5 text-[var(--sn-text-3)]'
                                : 'mt-1.5 line-clamp-2 cursor-pointer whitespace-pre-wrap text-[12px] leading-5 text-[var(--sn-text-3)]'
                            }
                          >
                            <Highlight text={it.text} q={query} />
                          </div>
                          {/* 关键词：可点回填搜索，蒸馏产出即刻可追索。
                              T10：hover 补 bg 提示可点性 */}
                          {it.keywords.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {it.keywords.map((kw) => (
                                <button
                                  key={kw}
                                  type="button"
                                  onClick={() => setQuery(kw)}
                                  title="点击检索该关键词"
                                  className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 transition-colors duration-150 hover:bg-white/10 hover:text-[var(--sn-text-2)]"
                                >
                                  # {kw}
                                </button>
                              ))}
                            </div>
                          )}
                          {/* 元信息 + 行内操作：多选模式与行内操作互斥，进入即隐藏 */}
                          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10.5px] text-[var(--sn-text-4)]">
                            {it.app && (
                              <span className="font-mono" title="采集时的前台应用">
                                {it.app}
                              </span>
                            )}
                            <span className="tabular-nums">{it.chars} 字</span>
                            {/* 使用/命中计数：弱色小字与 app/字数同排，0 视为未发生不渲染 */}
                            {!!it.uses && (
                              <span
                                className="tabular-nums"
                                title="实际使用次数（召回注入 / 复制全文），用过在新近度排序中浮顶"
                              >
                                ⏱×{it.uses}
                              </span>
                            )}
                            {!!it.hits && (
                              <span
                                className="tabular-nums"
                                title="近重复内容再次采到的次数（同源高度相似不另立条目，只累计）"
                              >
                                🔁×{it.hits}
                              </span>
                            )}
                            <span className="flex-1" />
                            {!selectMode && (
                              /* T4 hover-reveal：静置 40% 淡出、卡悬停与键盘聚焦
                                 （focus-within，Tab 导航到按钮时）全显 */
                              <span className="flex items-center gap-1 opacity-40 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
                                {/* 恢复只出现在软作废卡上：软作废默认隐藏，能看到
                                    本按钮即代表用户已开「⊘ 已作废」开关在治理视图中 */}
                                {dead && (
                                  <button
                                    type="button"
                                    onClick={() => void onRestore(it.ts)}
                                    title="撤销软作废：清空「被取代」标记，重新进入召回与检索"
                                    className="rounded px-1.5 py-1 text-emerald-400 transition-colors duration-150 hover:bg-white/10 hover:text-emerald-300"
                                  >
                                    恢复
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    void copyText(it.text)
                                      .then(() => {
                                        setCopiedTs(it.ts);
                                        window.setTimeout(
                                          () =>
                                            setCopiedTs((cur) =>
                                              cur === it.ts ? null : cur,
                                            ),
                                          1500,
                                        );
                                        /* 使用反馈闭环：复制视为一次实际使用
                                           （uses+1、召回排序浮顶）；记数失败
                                           静默——统计是增益，不能打断复制体验 */
                                        void memUsed(it.ts).catch(() => {});
                                      })
                                      .catch((e) => toast(String(e), 'error'));
                                  }}
                                  className={`rounded px-1.5 py-1 transition-colors duration-150 ${
                                    copiedTs === it.ts
                                      ? 'text-emerald-400'
                                      : 'text-sky-400 hover:bg-white/10 hover:text-sky-300'
                                  }`}
                                >
                                  {copiedTs === it.ts ? '已复制 ✓' : '复制全文'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void onDeleteOne(it.ts)}
                                  className={`rounded px-1.5 py-1 transition-colors duration-150 ${
                                    confirmDelTs === it.ts
                                      ? 'text-red-400'
                                      : 'text-slate-500 hover:bg-white/10 hover:text-red-400'
                                  }`}
                                >
                                  {confirmDelTs === it.ts ? '确认删除' : '删除'}
                                </button>
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* 多选模式底部操作条：全选当前筛选结果 → 一次批量删除。
            bg-black/45 而非历史页的 black/70：后者无浅色主题覆盖 */}
        {selectMode && (
          <div className="sticky bottom-0 z-20 flex flex-wrap items-center gap-3 rounded-xl border border-sky-400/20 bg-black/45 px-4 py-2.5 backdrop-blur">
            <span className="text-xs text-[var(--sn-text-2)]">已选 {selected.size} 条</span>
            <Button
              kind="subtle"
              onClick={selectAll}
              disabled={visible.length === 0}
              title="全选当前筛选结果（已全选时点击清空选择）"
            >
              全选
            </Button>
            {selected.size > 0 ? (
              <ConfirmButton
                label="删除"
                confirmLabel={`确认删除 ${selected.size} 条？`}
                onConfirm={() => void onDeleteBatch([...selected])}
              />
            ) : (
              <Button kind="danger" disabled title="先勾选要删除的记忆">
                删除
              </Button>
            )}
            <Button onClick={exitSelect}>取消</Button>
          </div>
        )}
      </Section>

      <Section
        icon="⚙️"
        title="采集设置"
        desc="哪些产出自动入库、保留多久、是否用 AI 蒸馏；改动保存后即时生效。"
      >
        <Toggle
          checked={m.enabled}
          onChange={(enabled) => set('mem', { enabled })}
          label="启用记忆库采集"
          desc="关闭后不再采集新记忆，已有记忆仍可查看、检索与导出"
        />
        {m.enabled && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Toggle
                checked={m.captureDictation}
                onChange={(captureDictation) => set('mem', { captureDictation })}
                label="🎤 听写"
                desc="听写终稿入库"
              />
              <Toggle
                checked={m.captureOcr}
                onChange={(captureOcr) => set('mem', { captureOcr })}
                label="📷 截图取词"
                desc="OCR 识别文本入库"
              />
              <Toggle
                checked={m.captureTranslate}
                onChange={(captureTranslate) => set('mem', { captureTranslate })}
                label="🌐 翻译"
                desc="划词与输入框翻译的译文入库"
              />
            </div>
            <Toggle
              checked={m.distill}
              onChange={(distill) => set('mem', { distill })}
              label="AI 蒸馏关键词与标题"
              desc="入库时用「AI 优化」已配置的 LLM 提炼检索关键词与一句话标题；失败自动降级为截取正文，不影响入库"
            />
            {/* 蒸馏依赖 LLM：凭据不齐就打开开关只会静默跳过，提前点破避免误判失效 */}
            {m.distill && !llmReady(cfg) && (
              <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3.5 py-2.5 text-[11.5px] leading-5 text-amber-200/90">
                ⚠ 「AI 优化」LLM 未就绪（未启用或地址/Key 未填写）：蒸馏将静默跳过，记忆以纯文本入库
              </div>
            )}
            <Field
              label="保留条数"
              hint="超出后按时间先后滚动清理；置顶条目不占名额（50~10000，步进 50）"
            >
              <div className="w-36">
                <NumberInput
                  value={m.limit}
                  normalize={(v) => {
                    const n = Number(v);
                    /* 空串/非法输入回退当前配置值；量化到 50 的倍数保持步进口径 */
                    const base =
                      Number.isFinite(n) && n > 0 ? n : m.limit;
                    return Math.min(10000, Math.max(50, Math.round(base / 50) * 50));
                  }}
                  onCommit={(limit) => set('mem', { limit })}
                />
              </div>
            </Field>
            {/* 采集黑名单：与划词翻译黑名单同款多行 textarea（每行一个关键字） */}
            <Field
              label="采集黑名单（每行一个进程名关键字）"
              hint="命中关键字的应用产出的内容不入库（子串匹配进程名）；密码管理器类应用（1Password / KeePass / Bitwarden 等）的内置名单始终生效，此处不可关闭"
            >
              <TextArea
                rows={3}
                value={m.captureBlacklist}
                onChange={(captureBlacklist) => set('mem', { captureBlacklist })}
                placeholder={'wechat\n隐私笔记.exe'}
              />
            </Field>
          </>
        )}

        {/* 安全态势卡（v4）：放在采集设置末尾而不进 m.enabled 门内——
            REST 暴露面与采集黑名单在关闭采集时依然生效，蒸馏在导入中心
            手动导入时也可能触发；三行状态点给「内容出不出本机」一个直答 */}
        <div className="space-y-2 rounded-xl border border-[var(--sn-border)] bg-[var(--sn-surface-3)] px-4 py-3">
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <span>🛡</span>
            <span>安全态势</span>
            <span className="text-[var(--sn-text-4)]">记忆内容的暴露面，随上方配置即时更新</span>
          </div>
          {posture.map((r) => (
            <div key={r.label} className="flex items-center gap-2 text-[11.5px] leading-5">
              {/* 状态点只分正常/提醒两档：这张卡没有红色级别风险（最重是
                  amber 提醒），三色反而暗示存在「危险」档误导用户 */}
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  r.warn ? 'bg-amber-400' : 'bg-emerald-400'
                }`}
              />
              <span className="w-[72px] shrink-0 text-slate-500">{r.label}</span>
              <span
                className={`min-w-0 flex-1 ${r.warn ? 'text-amber-200/90' : 'text-[var(--sn-text-2)]'}`}
              >
                {r.text}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* 导入中心（v3）：手动把外部资料灌进记忆库；与自动采集同一套入库管线
          （近重复合并 + 可选蒸馏），所以与采集设置相邻放置 */}
      <Section
        icon="📥"
        title="导入与快记"
        desc="把网页、文件与临时念头灌进记忆库。所有导入都会做近重复合并（重复内容不另立条目，只累计次数）；「AI 蒸馏」开启时自动提炼关键词与标题，便于日后检索。"
      >
        {/* 批量导入细进度条（v4）：置于导入区顶部而非某个 Field 内——
            文件/目录/备份合并任一通道的批次都在这里反馈；窄条不抢焦点，
            完成仍以各通道的 summary toast 为准 */}
        {importProg && (
          <div className="rounded-xl border border-sky-400/20 bg-sky-500/[0.05] px-4 py-2.5">
            <div className="flex items-center justify-between gap-3 text-[11px]">
              <span className="truncate font-mono text-[var(--sn-text-3)]" title={importProg.label}>
                {importProg.label || '正在导入…'}
              </span>
              <span className="tabular-nums shrink-0 text-slate-500">
                {importProg.done} / {importProg.total}
              </span>
            </div>
            {/* total<=1 的批次根本不会进这个状态，Math.max 只是防御畸形 payload */}
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-sky-400 transition-[width] duration-300"
                style={{
                  width: `${Math.min(100, (importProg.done / Math.max(1, importProg.total)) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        <Field
          label="快速记一条"
          hint="临时信息一键入库（如「例会改到周二上午」），与听写 / 取词同库同检索"
        >
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[220px] flex-1">
              <TextInput
                value={note}
                onChange={setNote}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addNote(note);
                }}
                placeholder="想到什么记什么，Enter 或「记下」入库"
              />
            </div>
            <Button
              kind="primary"
              disabled={noteBusy || note.trim() === ''}
              onClick={() => void addNote(note)}
            >
              {noteBusy ? <Spinner size={14} /> : '记下'}
            </Button>
            <Button
              disabled={noteBusy}
              onClick={() => void onClipNote()}
              title="读取剪贴板文本并作为快记入库"
            >
              📋 从剪贴板记一条
            </Button>
          </div>
        </Field>

        <Field
          label="导入网页"
          hint="后端抓取并抽取正文入库（限 http/https、5MB 以内、15 秒超时，超限会提示失败）"
        >
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[220px] flex-1">
              <TextInput
                value={url}
                onChange={setUrl}
                mono
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onImportUrl();
                }}
                placeholder="https://example.com/article"
              />
            </div>
            <Button
              kind="primary"
              disabled={urlBusy || url.trim() === ''}
              onClick={() => void onImportUrl()}
            >
              {urlBusy ? <Spinner size={14} /> : '抓取并导入'}
            </Button>
          </div>
        </Field>

        <Field
          label="导入文件与项目文档"
          hint="文件按段落分块入库；项目文档递归收集目录下 .md / .txt（最多 200 个文件），来源应用记为目录名"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={dlgBusy !== ''}
              onClick={() => void onImportFiles()}
              title="选择一个或多个 .txt / .md 文件导入"
            >
              {dlgBusy === 'files' ? <Spinner size={14} /> : '📄'} 选择文件（.txt / .md）
            </Button>
            <Button
              disabled={dlgBusy !== ''}
              onClick={() => void onImportFolder()}
              title="递归收集目录下 .md/.txt（最多 200 个文件）"
            >
              {dlgBusy === 'folder' ? <Spinner size={14} /> : '📂'} 导入项目文档（选目录）
            </Button>
          </div>
        </Field>
      </Section>
    </>
  );
}
