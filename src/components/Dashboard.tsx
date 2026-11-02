import { useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { MemListResult, Stage, TabProps, UsageStats } from '../types';
import { resolvedAsrCreds, resolvedLlmCreds } from '../types';
import {
  isMac,
  copyText,
  getStats,
  memList,
  ocrCapture,
  openTypist,
  shortcutChips,
  translateSelection,
} from '../api';
import { Button, Segmented, Toggle } from './Controls';
import { LogoBadge } from './Logo';

/* 记忆速览卡的大脑图标：与侧栏「记忆」导航同形（violet→sky 双色渐变着色） */
function BrainGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5.2a2.6 2.6 0 0 0-4.8 1.3A2.4 2.4 0 0 0 5 8.9c0 .7.3 1.3.8 1.7-.5.4-.8 1-.8 1.7a2.4 2.4 0 0 0 2.2 2.4A2.6 2.6 0 0 0 12 17z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 5.2a2.6 2.6 0 0 1 4.8 1.3 2.4 2.4 0 0 1 2.2 2.4c0 .7-.3 1.3-.8 1.7.5.4.8 1 .8 1.7a2.4 2.4 0 0 1-2.2 2.4A2.6 2.6 0 0 1 12 17z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 5.2V17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const STAGE_INFO: Record<
  Stage,
  { label: string; hint: string; dot: string; text: string }
> = {
  idle: {
    label: '一切就绪',
    hint: '在任意输入框按下快捷键，即可开始说话',
    dot: 'bg-emerald-400',
    text: 'text-emerald-300',
  },
  recording: {
    label: '正在聆听',
    hint: '说话中 · 再次触发快捷键结束',
    dot: 'bg-red-500 animate-pulse',
    text: 'text-red-300',
  },
  transcribing: {
    label: '语音识别中',
    hint: '正在将声音转成文字…',
    /* 固定 cyan 语义色（与 App 侧 STAGE_LABEL 同源），不随 accent 翻转 */
    dot: 'bg-cyan-400 animate-pulse',
    text: 'text-cyan-300',
  },
  optimizing: {
    label: 'AI 优化中',
    hint: '大模型正在纠错与润色…',
    dot: 'bg-indigo-400 animate-pulse',
    text: 'text-indigo-300',
  },
  review: {
    label: '待确认',
    hint: '在悬浮窗中编辑 · Enter 输入 · Esc 取消',
    dot: 'bg-amber-400 animate-pulse',
    text: 'text-amber-300',
  },
  done: {
    label: '已完成',
    hint: '文字已送达目标输入框',
    dot: 'bg-emerald-400',
    text: 'text-emerald-300',
  },
  error: {
    label: '出错了',
    hint: '详情见屏幕底部悬浮窗',
    dot: 'bg-red-500',
    text: 'text-red-300',
  },
};

/** 历史时间戳旧记录为秒、新记录为毫秒，统一折算为毫秒 */
const tsMs = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** 本地日期 YYYY-MM-DD（零填充，与后端 stats.json 的 days 键格式一致） */
const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;

/** 相对时间：刚刚 / X分钟前 / X小时前 / 昨天 / X天前 */
function relTime(ts: number): string {
  const diff = Date.now() - tsMs(ts);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  const yd = new Date();
  yd.setDate(yd.getDate() - 1);
  return dayKey(new Date(tsMs(ts))) === dayKey(yd)
    ? '昨天'
    : `${Math.floor(diff / 86_400_000)}天前`;
}

/** 星期缩写（getDay 下标） */
const WEEKDAY_ABBR = ['日', '一', '二', '三', '四', '五', '六'];

/** 强调色预设：id 与后端 config.general.accent 契约一致（缺省 sky）；
    swatch 取各预设深色档 400 档实色，深浅两种主题下作为色板填充都够醒目 */
const ACCENTS: { id: string; label: string; swatch: string }[] = [
  { id: 'sky', label: '天青', swatch: '#38bdf8' },
  { id: 'indigo', label: '靛蓝', swatch: '#818cf8' },
  { id: 'violet', label: '紫罗兰', swatch: '#a78bfa' },
  { id: 'teal', label: '青碧', swatch: '#2dd4bf' },
  { id: 'amber', label: '琥珀', swatch: '#fbbf24' },
];

/** 最近位次分位值（nearest-rank，ceil(q·N) 取秩）：空数组返回 null */
function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

export default function Dashboard({
  cfg,
  set,
  navigate,
  stage,
  statusMsg,
  recording,
  devices,
  history,
  localModels,
  onRecordToggle,
  toast,
}: TabProps) {
  /* 全量使用统计（后端 stats.json 累计口径，不受历史保留窗口影响）：
     挂载拉一次 + 历史变化重拉；拉取失败（旧后端无 get_stats 命令）置 null，
     下方统计卡自动回退从 props.history 推算——不白屏 */
  const [usage, setUsage] = useState<UsageStats | null>(null);
  useEffect(() => {
    let alive = true;
    let un: (() => void) | undefined;
    const pull = () => {
      getStats()
        .then((s) => {
          if (alive) setUsage(s);
        })
        .catch(() => {
          if (alive) setUsage(null);
        });
    };
    pull();
    void listen('sn-history-changed', pull).then((f) => {
      un = f;
    });
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  /* 记忆速览：只取统计（limit=1 不拉正文）。挂载拉一次 + sn-mem-changed 刷新；
     旧后端无 mem_list 时保持 null，卡片以空态文案展示而不是白屏 */
  const [mem, setMem] = useState<MemListResult | null>(null);
  useEffect(() => {
    let alive = true;
    let un: (() => void) | undefined;
    const pull = () => {
      memList('', null, 1)
        .then((r) => {
          if (alive) setMem(r);
        })
        .catch(() => {
          if (alive) setMem(null);
        });
    };
    pull();
    void listen('sn-mem-changed', pull).then((f) => {
      un = f;
    });
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  const stats = useMemo(() => {
    // 按本地日期分组（今日 / 昨日 / 近 7 天柱图共用一张表）：
    // 优先后端全量统计（isoDay 键）；无 stats 时从保留窗口推算（旧后端回退）
    const byDay = new Map<string, number>();
    if (usage) {
      for (const [d, n] of usage.days) byDay.set(d, n);
    } else {
      for (const h of history) {
        const k = isoDay(new Date(tsMs(h.ts)));
        byDay.set(k, (byDay.get(k) ?? 0) + 1);
      }
    }
    const total = usage ? usage.total : history.length;
    // 码点口径（与后端 .chars().count() 一致；回退路径同样用展开计数）
    const chars = usage
      ? usage.chars
      : history.reduce((n, h) => n + [...h.final].length, 0);
    const now = new Date();
    const today = byDay.get(isoDay(now)) ?? 0;
    // 昨日无记录（undefined）时不显示对比
    const yesterday = byDay.get(
      isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)),
    );
    // —— 以下为保留窗口性质：平均耗时与分位数只能从最近 N 条历史推算 ——
    const proc = history
      .map((h) => (h.asrMs ?? 0) + (h.llmMs ?? 0))
      .filter((v) => v > 0);
    const avg = proc.length
      ? (proc.reduce((a, b) => a + b, 0) / proc.length / 1000).toFixed(1) + 's'
      : '—';
    // 识别延迟分位（仅统计 asrMs 非空且 > 0 的记录）
    const asrLat = history
      .map((h) => h.asrMs)
      .filter((v): v is number => typeof v === 'number' && v > 0)
      .sort((a, b) => a - b);
    const p50 = percentile(asrLat, 0.5);
    const p95 = percentile(asrLat, 0.95);
    // 近 7 天（含今日，末位为今日）
    const week = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (6 - i));
      return {
        wd: d.getDay(),
        md: `${d.getMonth() + 1}/${d.getDate()}`,
        isToday: i === 6,
        count: byDay.get(isoDay(d)) ?? 0,
      };
    });
    // 连续使用天数（streak）：只认后端全量统计的 days（旧后端无 usage 时上方
    // 卡片直接隐藏）；「今天还没用」不算断档——起点取今天，今天无记录则宽限
    // 到昨天（昨天也没有即断档为 0），再往前逐日核对连续有记录的天数
    const activeDays = new Set(
      usage ? usage.days.filter(([, n]) => n > 0).map(([d]) => d) : [],
    );
    let streak = 0;
    if (usage) {
      const cur = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (!activeDays.has(isoDay(cur))) cur.setDate(cur.getDate() - 1);
      while (activeDays.has(isoDay(cur))) {
        streak++;
        cur.setDate(cur.getDate() - 1);
      }
    }
    return { total, chars, today, yesterday, avg, p50, p95, week, streak };
  }, [history, usage]);

  const info = STAGE_INFO[stage];
  const hotkeyChips = shortcutChips(cfg.hotkey.key);
  const quickChips = shortcutChips(cfg.hotkey.keyQuick);
  const translateChips = shortcutChips(cfg.hotkey.keyTranslate);
  const selChips = shortcutChips(cfg.hotkey.keyTranslateSel);
  const ocrChips = shortcutChips(cfg.hotkey.keyOcr);

  const asrLocalReady =
    cfg.asr.provider === 'local' &&
    localModels.find((m) => m.id === cfg.asr.localModel)?.downloaded === true;
  // 凭据组模式下 Key 存在 providers 里，须按引用解析后再判断
  const asrCreds = resolvedAsrCreds(cfg);
  const llmCreds = resolvedLlmCreds(cfg);
  const llmIsLocal = /\/\/(localhost|127\.0\.0\.1)/.test(llmCreds.baseUrl);

  const checklist = [
    cfg.asr.provider === 'local'
      ? {
          ok: asrLocalReady === true,
          label: asrLocalReady
            ? `本地识别模型已就绪（${cfg.asr.localModel}）`
            : `本地模型 ${cfg.asr.localModel} 未下载`,
          tab: 'asr' as const,
        }
      : {
          ok: asrCreds.apiKey.trim() !== '',
          label:
            asrCreds.apiKey.trim() !== ''
              ? '云端 ASR 已配置'
              : 'ASR API Key 未填写（可在「AI 优化」页凭据组统一配置）',
          tab: 'asr' as const,
        },
    {
      ok: !cfg.llm.enabled || llmIsLocal || llmCreds.apiKey.trim() !== '',
      label: cfg.llm.enabled
        ? llmIsLocal
          ? 'AI 优化 · 本地服务（免 Key）'
          : llmCreds.apiKey.trim() !== ''
            ? 'AI 优化已配置'
            : 'AI 优化已开启但 Key 未填写'
        : 'AI 优化未开启（可选）',
      tab: 'llm' as const,
    },
    {
      ok: cfg.hotkey.enabled && cfg.hotkey.key.trim() !== '',
      label: cfg.hotkey.enabled ? '全局快捷键已启用' : '全局快捷键未启用',
      tab: 'hotkey' as const,
    },
    // 已保存指定设备但当前系统枚举不到（接收器休眠/未插/重启后）：置为待完善，
    // 提示与 MicTab 里置顶的「已保存未检测到」卡片同口径
    (() => {
      const saved = cfg.audio.device;
      if (!saved) return { ok: true, label: '麦克风：系统默认', tab: 'mic' as const };
      return devices.some((d) => d.name === saved)
        ? { ok: true, label: `麦克风：${saved}`, tab: 'mic' as const }
        : {
            ok: false,
            label: `已保存设备当前未检测到：${saved}`,
            tab: 'mic' as const,
          };
    })(),
  ];

  /* 上手清单：新用户四步引导，位于状态卡之后。收起（或老用户首开）即写
     localStorage('sn:onboarded') 永久隐藏；能力级检查仍在下方「配置自检」卡保留 */
  const [onboarded, setOnboarded] = useState(() => {
    try {
      return localStorage.getItem('sn:onboarded') === '1';
    } catch {
      return false;
    }
  });
  // 老用户（已有 ≥3 条历史）默认收起：首次打开直接写入记忆，此后不再展示
  useEffect(() => {
    if (history.length >= 3 && !onboarded) {
      try {
        localStorage.setItem('sn:onboarded', '1');
      } catch {
        /* localStorage 不可用：仅本次会话收起 */
      }
      setOnboarded(true);
    }
  }, [history.length, onboarded]);

  // ① 语音识别引擎：云端（http/mimo）按解析后的生效 Key（凭据组或内联）判空，
  //    local 则要求所选模型已下载；② 麦克风：已指定设备或仅单一设备即视为无需选
  const obAsrOk =
    cfg.asr.provider === 'local'
      ? asrLocalReady === true
      : asrCreds.apiKey.trim() !== '';
  const obMicDevice = (cfg.audio.device ?? '').trim();
  const obMicOk = obMicDevice !== '' || devices.length === 1;
  const obFirstOk = history.length > 0;
  const obHotkeyOk = cfg.hotkey.key.trim() !== '';

  const onboard = [
    {
      ok: obAsrOk,
      title: '选择语音识别引擎',
      desc: obAsrOk
        ? cfg.asr.provider === 'local'
          ? `本地模型已就绪（${cfg.asr.localModel}）`
          : '云端识别已配置'
        : cfg.asr.provider === 'local'
          ? '先在「语音识别」页下载本地模型'
          : '填写 API Key，或在「AI 优化」页选凭据组',
      hint: '去设置',
      go: () => navigate('asr'),
    },
    {
      ok: obMicOk,
      title: '选择麦克风设备',
      desc: obMicDevice
        ? `已选择：${obMicDevice}`
        : devices.length === 1
          ? '仅检测到单一设备，无需选择'
          : devices.length === 0
            ? '未检测到输入设备，去检查权限'
            : `检测到 ${devices.length} 个设备，指定常用麦克风`,
      hint: '去选择',
      go: () => navigate('mic'),
    },
    {
      ok: obFirstOk,
      title: '完成第一次听写',
      desc: obFirstOk ? '第一条语音已送达输入框' : '按快捷键说话，或点此试录一段',
      hint: '去试录',
      go: onRecordToggle,
    },
    {
      ok: obHotkeyOk,
      title: '自定义快捷键（可选）',
      desc: obHotkeyOk ? '全局快捷键已配置' : '设置一个顺手的触发键',
      hint: '去设置',
      go: () => navigate('hotkey'),
    },
  ];
  const obDone = onboard.filter((o) => o.ok).length;

  return (
    <div className="space-y-5">
      {/* 状态主卡片（hero）：sn-hero 网格纹理 + 双强调色渐变 + 品牌徽章，
          状态点挪到徽章右下角——一眼同时读到「产品是谁」和「现在什么状态」 */}
      <section className="sn-hero relative overflow-hidden rounded-[22px] border border-[var(--sn-border)] p-5">
        <span
          className="aurora pointer-events-none absolute -right-14 -top-20 h-52 w-52 rounded-full bg-accent/15 blur-3xl"
          aria-hidden
        />
        <span
          className="aurora-2 pointer-events-none absolute -bottom-24 -left-10 h-52 w-52 rounded-full bg-accent-2/10 blur-3xl"
          aria-hidden
        />
        <div className="relative flex flex-wrap items-center gap-4">
          <span className="relative shrink-0">
            <LogoBadge size={48} />
            {stage === 'recording' && (
              <span
                className="absolute inset-0 animate-ping rounded-2xl border border-red-500/40"
                aria-hidden
              />
            )}
          </span>
          <div className="min-w-0">
            <div
              className={`flex items-center gap-2.5 text-lg font-semibold ${info.text}`}
            >
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${info.dot}`} aria-hidden />
              {info.label}
            </div>
            {/* 出错时完整展示错误信息（最多三行）；正常状态保持单行截断的提示 */}
            <div
              className={`mt-0.5 text-xs text-slate-400 ${
                statusMsg && stage === 'error'
                  ? 'line-clamp-3 break-all'
                  : 'truncate'
              }`}
            >
              {statusMsg && stage === 'error' ? statusMsg : info.hint}
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Button
              onClick={() => {
                void translateSelection().catch(() => {});
              }}
              title="先在任意应用选中文字，点击后贴近选区弹出翻译卡片"
            >
              🌐 翻译选中文字
            </Button>
            {/* 截图取词后端仅 Windows：mac 上隐藏入口，点了也会立即报错（门控与 OcrTab 一致） */}
            {!isMac && (
              <Button
                onClick={() => {
                  void ocrCapture().catch(() => {});
                }}
                title="框选屏幕任意区域，本地离线识别出文字（可复制/翻译/输入）"
              >
                📷 截图取词
              </Button>
            )}
            <Button
              onClick={() => {
                void openTypist().catch(() => {});
              }}
              title="打开文本模拟输入窗口：粘贴大段文本后模拟键盘逐字敲进目标输入框"
            >
              ⌨️ 文本模拟输入
            </Button>
            <Button kind="primary" onClick={onRecordToggle}>
              {recording ? '■ 结束并识别' : '🎤 试录一段'}
            </Button>
          </div>
        </div>
        <button
          type="button"
          onClick={() => navigate('hotkey')}
          className="card-lift relative mt-4 flex w-full flex-wrap items-center gap-2 rounded-xl border border-white/[0.08] bg-black/25 px-3.5 py-2.5 text-left"
        >
          {hotkeyChips.length > 0 ? (
            hotkeyChips.map((c, i) => (
              <span key={i} className="flex items-center gap-2">
                {i > 0 && <span className="text-[11px] text-slate-600">+</span>}
                <span className="kbd">{c}</span>
              </span>
            ))
          ) : (
            <span className="text-[12px] text-amber-300">未设置快捷键</span>
          )}
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10.5px] text-slate-400">
            {cfg.hotkey.mode === 'hold' ? '按住说话' : '按一下开始 / 结束'}
          </span>
          {quickChips.length > 0 && (
            <span className="flex items-center gap-1.5">
              {quickChips.map((c, i) => (
                <span key={i} className="kbd !border-amber-400/25 !text-amber-300">
                  {c}
                </span>
              ))}
              <span className="text-[10.5px] text-amber-300/80">快速 · 不经 AI</span>
            </span>
          )}
          {translateChips.length > 0 && (
            <span className="flex items-center gap-1.5">
              {translateChips.map((c, i) => (
                <span key={i} className="kbd !border-emerald-400/25 !text-emerald-300">
                  {c}
                </span>
              ))}
              <span className="text-[10.5px] text-emerald-300/80">翻译</span>
            </span>
          )}
          {selChips.length > 0 && (
            <span className="flex items-center gap-1.5">
              {selChips.map((c, i) => (
                <span key={i} className="kbd !border-teal-400/25 !text-teal-300">
                  {c}
                </span>
              ))}
              <span className="text-[10.5px] text-teal-300/80">划词</span>
            </span>
          )}
          {ocrChips.length > 0 && (
            <span className="flex items-center gap-1.5">
              {ocrChips.map((c, i) => (
                <span key={i} className="kbd !border-accent/25 !text-accent-text">
                  {c}
                </span>
              ))}
              <span className="text-[10.5px] text-accent-text/80">截图取词</span>
            </span>
          )}
          <span className="ml-auto text-[11px] text-slate-600">修改 ›</span>
        </button>
      </section>

      {/* 记忆速览：产品从「输入工具」到「输入 + 记忆」的主线入口，
          统计口径来自 memList（不受查询过滤影响）；点击整卡进记忆页 */}
      <button
        type="button"
        onClick={() => navigate('mem')}
        className="card-lift group flex w-full items-center gap-4 rounded-[20px] border border-[var(--sn-border)] bg-gradient-to-r from-violet-500/[0.08] via-sky-500/[0.05] to-transparent p-4 text-left transition-colors hover:border-violet-400/30"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] border border-violet-400/20 bg-gradient-to-br from-violet-500/[0.18] to-sky-500/[0.12] text-violet-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          <BrainGlyph />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-[14px] font-semibold text-slate-100">
            记忆库
            {mem && mem.todayCount > 0 && (
              <span className="rounded-full border border-violet-400/25 bg-violet-400/10 px-1.5 py-0.5 text-[10px] font-normal text-violet-300">
                今日 +{mem.todayCount}
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs text-slate-500">
            {mem
              ? mem.total > 0
                ? `累计 ${mem.total} 条记忆 · 共 ${mem.totalChars.toLocaleString()} 字 · 说过 / 看过 / 译过皆可追索`
                : '还没有记忆——完成一次听写、取词或翻译后自动沉淀'
              : '听写、截图取词、翻译的产出自动沉淀为可检索的个人记忆'}
          </span>
        </span>
        <span className="shrink-0 text-[12px] text-slate-500 transition-colors group-hover:text-violet-300">
          查看记忆 ›
        </span>
      </button>

      {/* 上手清单：新用户第一眼即见；收起后 localStorage 记忆，不再展示 */}
      {!onboarded && (
        <section className="rounded-[20px] border border-[var(--sn-border)] bg-[var(--sn-surface)] p-5">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-[15px] font-semibold text-slate-100">🚀 上手清单</h2>
              <p className="mt-0.5 text-[11px] text-slate-500">
                四步配好，语音输入随时待命
              </p>
            </div>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] ${
                obDone === onboard.length
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-accent/15 text-accent-text'
              }`}
            >
              {obDone} / {onboard.length}
            </span>
          </div>
          <div className="space-y-1.5">
            {onboard.map((o) => (
              <button
                key={o.title}
                type="button"
                onClick={o.ok ? undefined : o.go}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left ${
                  o.ok ? 'cursor-default' : 'transition hover:bg-white/[0.04]'
                }`}
              >
                <span
                  className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[9px] font-bold leading-none ${
                    o.ok ? 'bg-emerald-500/15 text-emerald-400' : 'border border-accent/40'
                  }`}
                >
                  {o.ok ? '✓' : ''}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-[13px] ${
                      o.ok ? 'text-slate-300' : 'text-slate-200'
                    }`}
                  >
                    {o.title}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                    {o.desc}
                  </span>
                </span>
                {!o.ok && (
                  <span className="shrink-0 text-[11px] text-accent/80">{o.hint} ›</span>
                )}
              </button>
            ))}
          </div>
          {obDone === onboard.length && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.08] px-3.5 py-2.5">
              <span className="text-[13px] text-emerald-300">🎉 全部就绪，开始使用吧！</span>
              <button
                type="button"
                onClick={() => {
                  try {
                    localStorage.setItem('sn:onboarded', '1');
                  } catch {
                    /* localStorage 不可用：仅本次会话收起 */
                  }
                  setOnboarded(true);
                }}
                className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-[11.5px] text-slate-300 transition hover:border-white/25 hover:bg-white/[0.06] active:scale-95"
              >
                收起
              </button>
            </div>
          )}
        </section>
      )}

      {/* 统计：累计/今日/柱图来自全量统计（超窗仍准确）；平均与分位数是
          窗口性质，只能从最近 N 条历史推算（tooltip 注明）。
          连续天数卡仅在有后端全量统计时出现（旧后端回退口径不同，直接隐藏） */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {(
          [
            { label: '累计使用', value: String(stats.total), unit: '次', icon: '🔤' },
            { label: '累计输入', value: stats.chars.toLocaleString(), unit: '字', icon: '✍️' },
            {
              label: '今日',
              value: String(stats.today),
              unit: '次',
              icon: '📅',
              // 昨日无数据（undefined）时不显示对比
              sub:
                stats.yesterday === undefined
                  ? undefined
                  : stats.today > stats.yesterday
                    ? `较昨日 +${stats.today - stats.yesterday}`
                    : stats.today < stats.yesterday
                      ? `较昨日 -${stats.yesterday - stats.today}`
                      : '与昨日持平',
            },
            ...(usage
              ? [
                  {
                    label: '连续使用',
                    value: stats.streak > 0 ? String(stats.streak) : '—',
                    unit: stats.streak > 0 ? '天' : '',
                    // 今日已有记录时明确「含今日」，否则提示今天还未断
                    sub:
                      stats.streak > 0
                        ? stats.today > 0
                          ? '含今日'
                          : '今日还未使用'
                        : undefined,
                    tip: '连续每天至少 1 条的天数；今天还没用不算断档（按最近 60 天窗口计）',
                    icon: '🔥',
                  },
                ]
              : []),
            {
              label: '平均处理',
              value: stats.avg,
              unit: '',
              icon: '⚡',
              tip: `最近 ${history.length} 条`,
            },
            {
              label: '识别 p50 / p95',
              value:
                stats.p50 !== null && stats.p95 !== null
                  ? `${(stats.p50 / 1000).toFixed(1)}s / ${(stats.p95 / 1000).toFixed(1)}s`
                  : '—',
              unit: '',
              icon: '⏱',
              tip: `最近 ${history.length} 条`,
            },
          ] as {
            label: string;
            value: string;
            unit: string;
            sub?: string;
            tip?: string;
            icon: string;
          }[]
        ).map((s) => (
          <div
            key={s.label}
            title={s.tip}
            className="card-lift rounded-xl border border-[var(--sn-border)] bg-[var(--sn-surface)] px-4 py-3.5"
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-500">{s.label}</span>
              <span className="text-[12px] opacity-70">{s.icon}</span>
            </div>
            <div className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-slate-100">
              {s.value}
              {s.unit && (
                <span className="ml-1 text-[11px] font-normal text-slate-500">
                  {s.unit}
                </span>
              )}
            </div>
            {s.sub && (
              <div
                className={`mt-1 text-[10.5px] ${
                  s.sub.startsWith('较昨日 +')
                    ? 'text-emerald-400/80'
                    : s.sub.startsWith('较昨日 -')
                      ? 'text-amber-400/80'
                      : 'text-slate-500'
                }`}
              >
                {s.sub}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 最近 7 天迷你柱图（纯 div，高度按当日条数归一） */}
      <section className="rounded-[20px] border border-[var(--sn-border)] bg-[var(--sn-surface)] px-4 py-3">
        {(() => {
          const max = Math.max(...stats.week.map((d) => d.count));
          return (
            <div className="flex items-center gap-4">
              <span className="shrink-0 text-[11px] text-slate-500">近 7 天</span>
              <div className="flex flex-1 items-end gap-1.5 sm:gap-2.5">
                {stats.week.map((d, i) => (
                  <div
                    key={i}
                    className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
                        title={`${d.md}：${d.count} 条`}
                  >
                    <div className="flex h-11 w-full items-end justify-center">
                      <div
                        className={`w-full max-w-6 rounded-t-[3px] transition-all ${
                          d.count === 0
                            ? 'h-[2px] bg-slate-700/60' // 无数据日 2px 底座灰柱
                            : d.isToday
                              ? 'bg-gradient-to-t from-accent to-accent-2'
                              : 'bg-accent/35'
                        }`}
                        style={
                          d.count > 0
                            ? {
                                height: `${Math.max(
                                  6,
                                  Math.round((d.count / (max || 1)) * 44),
                                )}px`,
                              }
                            : undefined
                        }
                      />
                    </div>
                    <span
                      className={`text-[10px] ${
                        d.isToday ? 'font-medium text-accent-text' : 'text-slate-600'
                      }`}
                    >
                      {WEEKDAY_ABBR[d.wd]}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </section>

      {/* 配置自检 */}
      <section className="rounded-[20px] border border-[var(--sn-border)] bg-[var(--sn-surface)] p-5">
        <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-slate-100">
          🔍 配置自检
          <span
            className={`rounded-full px-2 py-0.5 text-[10.5px] font-normal ${
              checklist.every((c) => c.ok)
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-amber-500/15 text-amber-300'
            }`}
          >
            {checklist.filter((c) => !c.ok).length === 0
              ? '全部就绪'
              : `${checklist.filter((c) => !c.ok).length} 项待完善`}
          </span>
        </h2>
        <div className="space-y-1.5">
          {checklist.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={() => navigate(c.tab)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-white/[0.04]"
            >
              <span
                className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[9px] font-bold leading-none ${
                  c.ok
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'bg-amber-500/15 text-amber-400'
                }`}
              >
                {c.ok ? '✓' : '!'}
              </span>
              <span
                className={`text-[13px] ${c.ok ? 'text-slate-300' : 'text-amber-300'}`}
              >
                {c.label}
              </span>
              <span className="ml-auto text-[11px] text-slate-600">去查看 ›</span>
            </button>
          ))}
        </div>
      </section>

      {/* 快速开关 */}
      <section className="rounded-[20px] border border-[var(--sn-border)] bg-[var(--sn-surface)] p-5">
        <h2 className="mb-3 text-[15px] font-semibold text-slate-100">⚡ 快速开关</h2>
        <div className="space-y-2">
          <Toggle
            checked={cfg.llm.enabled}
            onChange={(enabled) => set('llm', { enabled })}
            label="AI 纠错与优化"
            desc="关闭后直接输出 ASR 原文，速度最快"
          />
          <Toggle
            checked={cfg.translate.clipboardWatch}
            onChange={(clipboardWatch) => set('translate', { clipboardWatch })}
            label="复制即翻译"
            desc="在任意应用复制文字后自动弹出翻译卡片；复制的敏感内容也会发给 AI 接口（可在「翻译」页加黑名单）"
          />
          <Toggle
            checked={cfg.general.showOverlay}
            onChange={(showOverlay) => set('general', { showOverlay })}
            label="录音状态悬浮窗"
            desc="屏幕底部显示波形与进度"
          />
          <Toggle
            checked={cfg.general.soundFeedback}
            onChange={(soundFeedback) => set('general', { soundFeedback })}
            label="开始 / 结束提示音"
            desc="录音开始与结果就绪时播放短促音效"
          />
          <Toggle
            checked={cfg.general.closeToTray !== false}
            onChange={(closeToTray) => set('general', { closeToTray })}
            label="关闭主窗口时驻留托盘"
            desc="关闭后语音输入继续可用；取消则点 × 直接退出（托盘右键也随时可退出）"
          />
          <Toggle
            checked={cfg.general.autostart}
            onChange={(autostart) => set('general', { autostart })}
            label="开机自动启动"
            desc="开机后驻留后台，快捷键随时可用"
          />
        </div>
      </section>

      {/* 外观 */}
      <section className="rounded-[20px] border border-[var(--sn-border)] bg-[var(--sn-surface)] p-5">
        <h2 className="mb-3 text-[15px] font-semibold text-slate-100">🎨 外观</h2>
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-slate-300/90">主题</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(
                [
                  { v: 'dark', label: '🌙 夜间', desc: '深色 · 护眼默认' },
                  { v: 'light', label: '☀️ 日间', desc: '浅色 · 明亮清爽' },
                  { v: 'auto', label: '🖥 跟随系统', desc: '自动匹配系统外观' },
                ] as const
              ).map((o) => {
                const active = cfg.general.theme === o.v;
                return (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => set('general', { theme: o.v })}
                    className={`card-lift relative rounded-xl border px-3 py-2.5 text-left active:scale-[0.98] ${
                      active
                        ? 'border-accent bg-gradient-to-br from-accent/[0.12] to-accent-2/[0.08]'
                        : 'border-white/[0.08] bg-black/20 hover:border-white/20'
                    }`}
                  >
                    <span
                      className={`block text-[13px] font-medium ${
                        active ? 'text-accent-text' : 'text-slate-200'
                      }`}
                    >
                      {o.label}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">
                      {o.desc}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[13px] font-medium text-slate-300/90">强调色</span>
              <span className="text-[11px] text-slate-500">
                按钮/焦点/高亮与界面氛围随强调色联动
              </span>
            </div>
            <div className="flex items-center gap-3">
              {ACCENTS.map((a) => {
                /* 未保存旧配置无 accent 字段：缺省按 sky 处理 */
                const active = (cfg.general.accent ?? 'sky') === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => set('general', { accent: a.id })}
                    title={a.label}
                    aria-label={a.label}
                    aria-pressed={active}
                    className="flex h-[22px] w-[22px] items-center justify-center rounded-full transition hover:scale-110 active:scale-95"
                    /* 选中环用色板本色而非当前 accent（当前 sky 时选琥珀不该套天青环）；
                       双层 box-shadow 内层用卡面底色断开，等价 ring-offset */
                    style={
                      active
                        ? {
                            background: a.swatch,
                            boxShadow: `0 0 0 2px var(--sn-surface), 0 0 0 4px ${a.swatch}`,
                          }
                        : { background: a.swatch }
                    }
                  >
                    {active && (
                      <span className="h-[6px] w-[6px] rounded-full bg-white" aria-hidden />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-slate-300/90">卡片驻留时长</div>
            <Segmented
              value={String(cfg.general.lingerMult ?? 1)}
              onChange={(v) => set('general', { lingerMult: Number(v) })}
              options={[
                { value: '0.6', label: '短', desc: '快速连打' },
                { value: '1', label: '标准', desc: '默认节奏' },
                { value: '1.8', label: '长', desc: '从容阅读' },
              ]}
            />
            <div className="mt-1 text-[11px] text-slate-500">
              完成 / 翻译 / OCR 等悬浮卡的停留时间统一缩放（悬停可随时暂停计时）
            </div>
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[13px] font-medium text-slate-300/90">界面缩放</span>
              {/* 读数 chip 化：点击重置 100% */}
              <button
                type="button"
                onClick={() => set('general', { fontScale: 1 })}
                title="点击重置为 100%"
                className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 font-mono text-[11px] tabular-nums text-accent-text transition hover:border-accent/40 hover:bg-accent/20 active:scale-95"
              >
                {Math.round((cfg.general.fontScale || 1) * 100)}%
              </button>
            </div>
            <input
              type="range"
              min={85}
              max={130}
              step={5}
              value={Math.round((cfg.general.fontScale || 1) * 100)}
              onChange={(e) =>
                set('general', { fontScale: Number(e.target.value) / 100 })
              }
              className="w-full"
            />
            <div className="mt-1 text-[11px] text-slate-500">
              拖动即时预览 · 主窗口与悬浮窗同步缩放
            </div>
          </div>
        </div>
      </section>

      {/* 最近记录 */}
      {history.length > 0 && (
        <section className="rounded-[20px] border border-[var(--sn-border)] bg-[var(--sn-surface)] p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-slate-100">🕘 最近使用</h2>
            <button
              type="button"
              onClick={() => navigate('history')}
              className="text-xs text-accent transition hover:text-accent-text"
            >
              查看全部 ›
            </button>
          </div>
          <div className="space-y-2">
            {history.slice(0, 3).map((h, idx) => (
              <div
                key={`${h.ts}-${idx}`}
                className="card-lift group flex items-center gap-2.5 rounded-lg border border-white/[0.05] bg-black/20 px-3.5 py-2.5"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-slate-300">
                  {h.final || h.raw}
                </span>
                <span className="shrink-0 text-[10.5px] text-slate-600">
                  {relTime(h.ts)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void copyText(h.final || h.raw)
                      .then(() => toast('已复制 ✓'))
                      .catch((e) => toast(`复制失败：${e}`));
                  }}
                  title="复制该条文本"
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] text-accent opacity-0 transition hover:bg-accent/10 hover:text-accent-text focus:opacity-100 group-hover:opacity-100"
                >
                  复制
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
