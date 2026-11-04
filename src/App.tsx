import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  applyAppearance,
  appVersion,
  builtinModels,
  checkUpdate,
  getConfig,
  getHistory,
  listDevices,
  memList,
  saveConfig,
  shortcutChips,
  startRecording,
  stopRecording,
} from './api';
import type {
  Config,
  DeviceInfo,
  HistoryItem,
  LocalModelStatus,
  Stage,
  TabId,
  UpdateInfo,
} from './types';
import { DEFAULT_DEVICE_KEY } from './types';
import Dashboard from './components/Dashboard';
import { LogoBadge } from './components/Logo';
import './styles.css';

/* 各设置分页按需加载（懒加载分包）；默认页 dash=总览为 Dashboard，
   保持静态导入，首屏渲染不经过 Suspense、无加载占位闪烁 */
const HotkeyTab = lazy(() =>
  import('./components/tabs/HotkeyTab').then((m) => ({ default: m.HotkeyTab })),
);
const MemTab = lazy(() =>
  import('./components/tabs/MemTab').then((m) => ({ default: m.MemTab })),
);
const MicTab = lazy(() =>
  import('./components/tabs/MicTab').then((m) => ({ default: m.MicTab })),
);
const AsrTab = lazy(() =>
  import('./components/tabs/AsrTab').then((m) => ({ default: m.AsrTab })),
);
const LlmTab = lazy(() =>
  import('./components/tabs/LlmTab').then((m) => ({ default: m.LlmTab })),
);
const TranslateTab = lazy(() =>
  import('./components/tabs/TranslateTab').then((m) => ({ default: m.TranslateTab })),
);
const OcrTab = lazy(() =>
  import('./components/tabs/OcrTab').then((m) => ({ default: m.OcrTab })),
);
const OutputTab = lazy(() =>
  import('./components/tabs/OutputTab').then((m) => ({ default: m.OutputTab })),
);
const DisplayTab = lazy(() =>
  import('./components/tabs/DisplayTab').then((m) => ({ default: m.DisplayTab })),
);
const HistoryTab = lazy(() =>
  import('./components/tabs/HistoryTab').then((m) => ({ default: m.HistoryTab })),
);
const AboutTab = lazy(() =>
  import('./components/tabs/AboutTab').then((m) => ({ default: m.AboutTab })),
);

/* 导航信息架构 v2：分组即产品叙事——使用 / 记忆 / 输入与识别 / 增强 / 输出与数据 / 关于。
   desc 供主区 sticky 页头做一句定位（页面给「页在哪」，Section 给「功能块是什么」，
   各司其职避免标题重复）；keys 供侧栏搜索按拼音/别名命中 */
const NAV: { id: TabId; label: string; group: string; keys: string; desc: string }[] = [
  {
    id: 'dash',
    label: '总览',
    group: '使用',
    keys: '总览 概览 状态 统计 上手',
    desc: '运行状态、使用统计与快速入口，一屏尽收眼底',
  },
  {
    id: 'mem',
    label: '记忆',
    group: '记忆',
    keys: '记忆 mem 知识库 检索 时间线 沉淀 蒸馏 关键词 导入 网页 文件 项目 备份 令牌 召回 已作废 黑名单 图谱 思维图 洞察 热力',
    desc: '听写、取词与翻译自动沉淀为可检索的个人记忆',
  },
  {
    id: 'hotkey',
    label: '快捷键',
    group: '输入与识别',
    keys: '热键 快捷键 hotkey 触发 误触 录音时长',
    desc: '全局触发键、按住 / 点按模式与误触防护',
  },
  {
    id: 'mic',
    label: '麦克风',
    group: '输入与识别',
    keys: '麦克风 设备 增益 音量 agc 测试',
    desc: '输入设备选择、增益与麦克风测试',
  },
  {
    id: 'asr',
    label: '语音识别',
    group: '输入与识别',
    keys: '识别 语音 asr whisper qwen 引擎 模型 热词',
    desc: '云端或本地识别引擎、模型下载与热词',
  },
  {
    id: 'ocr',
    label: '截图取词',
    group: '输入与识别',
    keys: '截图 取词 ocr 框选 屏幕 文字识别',
    desc: '框选屏幕任意区域，离线识别出文字',
  },
  {
    id: 'llm',
    label: 'AI 优化',
    group: '增强',
    keys: 'ai 优化 纠错 润色 llm key 凭据 提示词 术语',
    desc: '纠错与润色引擎、凭据组与提示词',
  },
  {
    id: 'translate',
    label: '翻译',
    group: '增强',
    keys: '翻译 translation 语言 划词 复制即翻译 双击',
    desc: '划词 / 复制即翻译与目标语言',
  },
  {
    id: 'output',
    label: '输入方式',
    group: '输出与数据',
    keys: '输出 粘贴 输入方式 回车 剪贴板 还原 键入',
    desc: '结果送达方式：粘贴、键入与确认节奏',
  },
  {
    id: 'display',
    label: '外接显示',
    group: '输出与数据',
    keys: '外接 显示 字幕屏 display 局域网',
    desc: '把实时字幕推送到外接硬件字幕屏',
  },
  {
    id: 'history',
    label: '历史',
    group: '输出与数据',
    keys: '历史 记录 收藏 统计',
    desc: '最近听写记录，收藏与统计',
  },
  {
    id: 'about',
    label: '关于',
    group: '关于',
    keys: '关于 版本 更新',
    desc: '版本信息、检查更新与开源致谢',
  },
];

/* 侧栏 16px 线性 stroke 图标：stroke=currentColor，激活态自动跟随 sky-300 */
const iconSvgProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const ICONS: Record<TabId, ReactNode> = {
  dash: (
    <svg {...iconSvgProps} aria-hidden>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V21h13V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </svg>
  ),
  mem: (
    <svg {...iconSvgProps} aria-hidden>
      {/* 大脑双叶轮廓：记忆是产品新主线，给它区别于「数据库」的身份图标 */}
      <path d="M12 5.2a2.6 2.6 0 0 0-4.8 1.3A2.4 2.4 0 0 0 5 8.9c0 .7.3 1.3.8 1.7-.5.4-.8 1-.8 1.7a2.4 2.4 0 0 0 2.2 2.4A2.6 2.6 0 0 0 12 17z" />
      <path d="M12 5.2a2.6 2.6 0 0 1 4.8 1.3 2.4 2.4 0 0 1 2.2 2.4c0 .7-.3 1.3-.8 1.7.5.4.8 1 .8 1.7a2.4 2.4 0 0 1-2.2 2.4A2.6 2.6 0 0 1 12 17z" />
      <path d="M12 5.2V17" />
    </svg>
  ),
  hotkey: (
    <svg {...iconSvgProps} aria-hidden>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <path d="M6.5 10h.01M10.5 10h.01M14.5 10h.01M18 10h.01M6.5 14h.01M18.2 14h.01M9.5 14h5" />
    </svg>
  ),
  mic: (
    <svg {...iconSvgProps} aria-hidden>
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v3" />
    </svg>
  ),
  asr: (
    <svg {...iconSvgProps} aria-hidden>
      <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
    </svg>
  ),
  llm: (
    <svg {...iconSvgProps} aria-hidden>
      <path d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9L12 3.5z" />
      <path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z" />
    </svg>
  ),
  translate: (
    <svg {...iconSvgProps} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" />
    </svg>
  ),
  ocr: (
    <svg {...iconSvgProps} aria-hidden>
      <path d="M6.5 2.5V16a2 2 0 0 0 2 2h13" />
      <path d="M17.5 21.5V8a2 2 0 0 0-2-2h-13" />
    </svg>
  ),
  output: (
    <svg {...iconSvgProps} aria-hidden>
      <path d="M4.5 3.5l7.2 17 2.4-6.4 6.4-2.4-16-8.2z" />
    </svg>
  ),
  display: (
    <svg {...iconSvgProps} aria-hidden>
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M9 21h6M12 17v4" />
    </svg>
  ),
  history: (
    <svg {...iconSvgProps} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  ),
  about: (
    <svg {...iconSvgProps} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.8h.01" />
    </svg>
  ),
};

const STAGE_HINT: Record<string, string> = {
  idle: '等待触发',
  recording: '按快捷键结束',
  transcribing: '声音转文字中',
  optimizing: 'AI 纠错中',
  review: '等待确认',
  done: '已送达',
  error: '请查看悬浮窗',
};

const STAGE_LABEL: Record<Stage, { text: string; cls: string; dot: string }> = {
  idle: { text: '就绪', cls: 'bg-emerald-500/15 text-emerald-300', dot: 'bg-emerald-400' },
  recording: { text: '● 录音中', cls: 'bg-red-500/15 text-red-300', dot: 'bg-red-500 animate-pulse' },
  /* 识别中用固定 cyan 而非 accent：accent 若与 indigo/amber 撞档，
     会和「AI 优化中」「待确认」难以区分（cyan 不在 sky→accent 兜底映射内） */
  transcribing: { text: '识别中', cls: 'bg-cyan-500/15 text-cyan-300', dot: 'bg-cyan-400 animate-pulse' },
  optimizing: { text: 'AI 优化中', cls: 'bg-indigo-500/15 text-indigo-300', dot: 'bg-indigo-400 animate-pulse' },
  review: { text: '待确认', cls: 'bg-amber-500/15 text-amber-300', dot: 'bg-amber-400 animate-pulse' },
  done: { text: '完成', cls: 'bg-emerald-500/15 text-emerald-300', dot: 'bg-emerald-400' },
  error: { text: '出错', cls: 'bg-red-500/15 text-red-300', dot: 'bg-red-500' },
};

/* ============ Toast（类型化 + 队列） ============ */

type ToastKind = 'ok' | 'error' | 'info';
interface ToastItem {
  id: number;
  msg: string;
  kind: ToastKind;
}

const TOAST_META: Record<ToastKind, { glyph: string; cls: string }> = {
  ok: { glyph: '✓', cls: 'text-emerald-400' },
  error: { glyph: '⚠', cls: 'text-red-400' },
  info: { glyph: '✦', cls: 'text-accent' },
};

/* kind 缺省时按文案正则推断（向后兼容旧 toast('...') 调用） */
function inferToastKind(msg: string): ToastKind {
  if (/失败|错误|无法|未找到|不支持|未检测/.test(msg)) return 'error';
  if (/成功|完成|就绪|已保存|已设置|已导出|已恢复|已下载/.test(msg)) return 'ok';
  return 'info';
}

function Toast({ item, onClose }: { item: ToastItem; onClose: (id: number) => void }) {
  useEffect(() => {
    // error 停留更久；挂载时起表，后续兄弟 toast 增减不会重置计时
    const t = setTimeout(() => onClose(item.id), item.kind === 'error' ? 6000 : 2800);
    return () => clearTimeout(t);
  }, [item.id, onClose]);
  const meta = TOAST_META[item.kind];
  return (
    <div
      role="status"
      onClick={() => onClose(item.id)}
      className="anim-rise flex cursor-pointer items-center gap-2 rounded-full border border-white/10 bg-[#17171f]/95 px-4 py-2 text-xs leading-5 text-slate-200 shadow-xl"
    >
      <span className={meta.cls}>{meta.glyph}</span>
      <span className="min-w-0">{item.msg}</span>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<TabId>('dash');
  const [cfg, setCfg] = useState<Config | null>(null);
  // 侧栏搜索：按 label/关键词过滤 NAV；空串显示全部
  const [navQuery, setNavQuery] = useState('');
  const navItems = useMemo(() => {
    const q = navQuery.trim().toLowerCase();
    if (!q) return NAV;
    return NAV.filter(
      (n) =>
        n.label.toLowerCase().includes(q) || n.keys.toLowerCase().includes(q),
    );
  }, [navQuery]);
  const savedRef = useRef('');
  const cfgRef = useRef<Config | null>(null);
  cfgRef.current = cfg;
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [localModels, setLocalModels] = useState<LocalModelStatus[]>([]);
  const [stage, setStage] = useState<Stage>('idle');
  // 品牌区版本徽标（mock 返回 dev 版本号；真机为当前发版号）
  const [version, setVersion] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  // Toast 队列：同屏最多渲染 2 条，其余在数组中排队，前面的过期后依次补位
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const setToast = useCallback((s: string, kind?: ToastKind) => {
    setToasts((ts) => [
      ...ts,
      { id: ++toastSeq.current, msg: s, kind: kind ?? inferToastKind(s) },
    ]);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);
  const [recording, setRecording] = useState(false);
  // 启动时检查到的可用更新（null = 无/未检查）：侧栏红点提示 + 关于页复用展示
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  // dev StrictMode 双挂载会把下面的启动检查跑两次（两条 toast、两次请求）：
  // 仅对这一副作用防重，effect 其余初始化保持原语义（挂载-清理-再挂载）
  const updateCheckedRef = useRef(false);
  /* 首屏配置加载失败（getConfig reject）：骨架会永久停留，转为可重试的
     错误卡；reloadKey 递增后重启整个挂载 effect（listen 有清理，可安全重跑） */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /* 记忆徽标计数：只取 total（limit=1 不拉正文），与历史徽章同一交互语言。
     后端采集/删除/清空都广播 sn-mem-changed，监听刷新保持侧栏数字实时 */
  const [memTotal, setMemTotal] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const pull = () => {
      memList('', null, 1)
        .then((r) => {
          if (alive) setMemTotal(r.total);
        })
        .catch(() => {
          /* 旧后端无 mem_list：徽标静默不显示 */
        });
    };
    pull();
    const un = listen('sn-mem-changed', pull);
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const updateGuarded = updateCheckedRef.current;
    updateCheckedRef.current = true;
    getConfig()
      .then((c) => {
        setCfg(c);
        savedRef.current = JSON.stringify(c);
        // 启动自动检查更新（可在关于页关闭）：只提示不下载安装；
        // 已「跳过此版本」的不再打扰。失败静默——网络受限不该开屏报错
        if (!updateGuarded && c.general.autoCheckUpdate !== false) {
          checkUpdate()
            .then((r) => {
              if (r.updateAvailable && r.latest !== c.general.skipVersion) {
                setUpdateInfo(r);
                setToast(`发现新版本 v${r.latest}，前往「关于」页更新`, 'info');
              }
            })
            .catch(() => {});
        }
      })
      .catch((e) => {
        // 配置加载失败是致命的（首屏骨架永久停留）：转成可重试的错误卡
        setLoadError(String(e));
      });
    // 其余挂载请求失败只缺对应数据（列表空 / 版本号空），不拦首屏
    listDevices()
      .then(setDevices)
      .catch((e) => console.error('设备列表加载失败', e));
    appVersion()
      .then(setVersion)
      .catch((e) => console.error('版本号读取失败', e));
    getHistory()
      .then(setHistory)
      .catch((e) => console.error('历史记录加载失败', e));
    builtinModels()
      .then(setLocalModels)
      .catch((e) => console.error('本地模型列表加载失败', e));
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const un1 = listen<{ stage: Stage; message: string }>('sn-status', (e) => {
      setStage(e.payload.stage);
      setStatusMsg(e.payload.message ?? '');
      setRecording(e.payload.stage === 'recording');
      // done/error 后若后端事件丢失，前端兜底 4 秒回到 idle，避免按钮状态卡死
      if (idleTimer) clearTimeout(idleTimer);
      if (e.payload.stage === 'done' || e.payload.stage === 'error') {
        idleTimer = setTimeout(() => {
          setStage('idle');
          setStatusMsg('');
        }, 4000);
      }
    });
    const un2 = listen('sn-history-changed', () => {
      getHistory().then(setHistory);
    });
    const un3 = listen('sn-models-changed', () => {
      builtinModels().then(setLocalModels);
    });
    // 录音期 AGC 学到的增益：按设备写回记忆；若正是当前所用设备则同步滑杆
    const un4 = listen<{ device: string | null; gainDb: number }>(
      'sn-gain-learned',
      (e) => {
        const { device, gainDb } = e.payload;
        const key = device ?? DEFAULT_DEVICE_KEY;
        const cur = cfgRef.current;
        const isCurrent = !!cur && (cur.audio.device ?? null) === (device ?? null);
        const known = cur?.audio.gainDbByDevice?.[key];
        const unchanged =
          known !== undefined &&
          Math.abs(known - gainDb) < 0.1 &&
          (!isCurrent || Math.abs(cur.audio.gainDb - gainDb) < 0.1);
        if (unchanged) return;
        if (isCurrent) setToast(`🎧 已自动记忆本设备增益 ${gainDb.toFixed(1)}dB`);
        setCfg((c) => {
          if (!c) return c;
          return {
            ...c,
            audio: {
              ...c.audio,
              gainDb: isCurrent ? gainDb : c.audio.gainDb,
              gainDbByDevice: { ...(c.audio.gainDbByDevice ?? {}), [key]: gainDb },
            },
          };
        });
      },
    );
    // 托盘切换 llm.mode / translateTarget 等会广播配置变更：拉回最新配置，
    // 防止本窗口内存里的旧配置被 800ms 自动保存写回、静默撤销托盘改动。
    // 本窗口有未保存编辑（dirty）时保留编辑不覆盖；本窗口自己 save_config
    // 后也会触发该事件，故 dirty 守卫必不可少
    const un5 = listen('sn-config-changed', () => {
      getConfig().then((c) => {
        const cur = cfgRef.current;
        if (cur && JSON.stringify(cur) !== savedRef.current) return;
        setCfg(c);
        savedRef.current = JSON.stringify(c);
      });
    });
    // 悬浮窗错误卡「打开设置」：后端 open_settings 命令开窗后广播本事件，
    // tab 未识别（旧后端/异常值）时保持当前页
    const un6 = listen<string>('sn-navigate', (e) => {
      const hit = NAV.find((n) => n.id === e.payload);
      if (hit) setTab(hit.id);
    });
    // 快捷键注册失败不再静默：保存/启动时后端广播结果，失败即 toast
    // （设置页「快捷键」另有常驻横幅展示同一状态）
    const un7 = listen<{ error: string | null }>('sn-hotkey-status', (e) => {
      if (e.payload?.error) setToast(`快捷键注册失败：${e.payload.error}`, 'error');
    });
    // 后台预下载就绪：提示安装入口；顺带补一次检查点亮侧栏红点（启动检查
    // 失败/被跳过时 updateInfo 可能为空，复用同一状态而不是另起炉灶）
    const un8 = listen<{ version: string; path: string }>('sn-update-ready', (e) => {
      setToast(`新版本 v${e.payload.version} 已就绪，到「关于」页安装`, 'info');
      checkUpdate()
        .then((r) => {
          if (r.updateAvailable) setUpdateInfo(r);
        })
        .catch(() => {});
    });
    // 词典自动学习：同一改法修正满 2 次，后端已把新词写进术语表（顺带广播
    // 过 sn-config-changed，本窗 glossary 已刷新）；误学的词可到「AI 优化」
    // 页术语表删除
    const un9 = listen<{ word: string }>('sn-dict-learned', (e) => {
      setToast(`已根据你的修正学习新词「${e.payload.word}」，已加入 AI 优化页术语表`, 'info');
    });
    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      un1.then((f) => f());
      un2.then((f) => f());
      un3.then((f) => f());
      un4.then((f) => f());
      un5.then((f) => f());
      un6.then((f) => f());
      un7.then((f) => f());
      un8.then((f) => f());
      un9.then((f) => f());
    };
    // reloadKey：错误卡「重试」递增后重启整套挂载初始化
  }, [reloadKey]);

  // 主题/缩放/强调色实时应用（accent 写 <html data-accent>，CSS 预设块随之翻转）
  useEffect(() => {
    if (cfg)
      applyAppearance(cfg.general.theme, cfg.general.fontScale, cfg.general.accent);
  }, [cfg?.general.theme, cfg?.general.fontScale, cfg?.general.accent]);

  // 序列化较重，用 useMemo 只在 cfg 变化时重算一次（dirty 判断与下方保存栏共用）
  const cfgJson = useMemo(() => (cfg ? JSON.stringify(cfg) : ''), [cfg]);
  const dirty = cfg !== null && cfgJson !== savedRef.current;

  const set = useCallback(
    <K extends keyof Config>(key: K, patch: Partial<Config[K]> | Config[K]) => {
      setCfg((c) => {
        if (!c) return c;
        const cur = c[key];
        // 数组字段（如 providers 凭据组列表）整体替换；对象字段做浅合并
        if (Array.isArray(cur) || Array.isArray(patch)) {
          return { ...c, [key]: patch } as Config;
        }
        return { ...c, [key]: { ...cur, ...patch } } as Config;
      });
    },
    [],
  );

  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  // ref 供保存流程内同步读取；state 驱动侧栏/保存条的失败 UI
  const saveFailsRef = useRef(0);
  const [saveFails, setSaveFails] = useState(0);

  const onSave = useCallback(async (silent = false) => {
    const c = cfgRef.current;
    if (!c || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      // 看门狗：后端卡住时 15s 超时止损，避免「正在自动保存…」永久挂起
      await Promise.race([
        saveConfig(c),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('超时（后台繁忙，稍后自动重试）')), 15000),
        ),
      ]);
      savedRef.current = JSON.stringify(c);
      saveFailsRef.current = 0;
      setSaveFails(0);
      if (!silent) setToast('已保存 ✓', 'ok');
    } catch (e) {
      saveFailsRef.current += 1;
      setSaveFails(saveFailsRef.current);
      if (saveFailsRef.current === 1 || !silent) setToast(`保存失败：${e}`, 'error');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, []);

  // 自动保存：修改后 800ms 无操作自动写入（配置即改即生效）；保存期间的新改动会在
  // 本轮结束后自动补存（saving 变化会重新触发调度）；失败后 5s 静默重试
  useEffect(() => {
    if (!cfg || !dirty) return;
    const delay = saveFailsRef.current > 0 ? 5000 : 800;
    const t = setTimeout(() => void onSave(true), delay);
    return () => clearTimeout(t);
  }, [cfg, dirty, saving, onSave]);

  // Ctrl/Cmd + S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty) void onSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, onSave]);

  const refreshHistory = useCallback(() => {
    getHistory().then(setHistory);
  }, []);

  const refreshDevices = useCallback(() => {
    listDevices().then((next) => {
      // 10s 轮询：名称+默认标记签名一致时跳过 setState，避免无谓重渲染
      const sig = (ds: DeviceInfo[]) =>
        ds.map((d) => `${d.name}|${d.isDefault ? 1 : 0}`).join(';');
      setDevices((prev) => (sig(prev) === sig(next) ? prev : next));
    });
  }, []);

  // 设备列表自动刷新：无线接收器休眠/重新枚举后设备会迟到，
  // 只在启动时拉一次会让已保存的麦克风在列表里「消失」，看起来像配置丢失。
  // 窗口最小化到托盘后页面不可见：跳过轮询（WASAPI 枚举并非零开销，
  // 部分驱动枚举还会引发音频卡顿），重新可见时立即补拉一次
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState === 'visible') refreshDevices();
    }, 10000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshDevices();
    };
    const onFocus = () => refreshDevices();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(iv);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshDevices]);

  const refreshLocalModels = useCallback(() => {
    builtinModels().then(setLocalModels);
  }, []);

  const onRecordToggle = useCallback(async () => {
    try {
      if (recording) await stopRecording();
      else await startRecording();
    } catch (e) {
      setToast(String(e), 'error');
    }
  }, [recording]);

  /* 首屏骨架：配置未就绪时渲染完整侧栏 + 页头占位 + 主区 skeleton 卡，
     降低白屏 / 孤零 Spinner 感；结构与正式外壳一致（含 sticky 页头占位） */
  if (!cfg) {
    // 配置加载失败：骨架会让用户永远等下去，换成带重试的错误卡
    if (loadError) {
      return (
        <div className="sn-shell-bg flex min-h-screen items-center justify-center p-6">
          <div className="w-full max-w-md rounded-[20px] border border-red-500/25 bg-[#17171f]/95 p-6 text-center shadow-2xl">
            <div className="text-[26px] leading-none">⚠️</div>
            <div className="mt-2.5 text-[15px] font-semibold text-slate-100">
              配置加载失败
            </div>
            <div className="mt-2 break-all text-[12px] leading-5 text-red-300/80">
              {loadError}
            </div>
            <button
              type="button"
              onClick={() => {
                setLoadError(null);
                setReloadKey((k) => k + 1);
              }}
              className="mt-4 rounded-lg border border-white/15 bg-white/[0.06] px-4 py-1.5 text-[12.5px] text-slate-200 transition hover:border-white/30 hover:bg-white/[0.1] active:scale-95"
            >
              ↻ 重试
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="sn-shell-bg flex min-h-screen">
        <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-[var(--sn-border)] bg-[var(--sn-sidebar)] backdrop-blur-xl">
          <div className="flex items-center gap-2.5 px-5 pb-7 pt-7">
            <div className="skeleton h-9 w-9 rounded-xl" />
            <div className="space-y-1.5">
              <div className="skeleton h-3 w-[72px]" />
              <div className="skeleton h-2 w-[52px]" />
            </div>
          </div>
          <div className="flex-1 space-y-1.5 overflow-hidden px-3 pb-4">
            {Array.from({ length: 11 }, (_, i) => (
              <div key={i} className="flex items-center gap-2.5 px-3 py-2">
                <div className="skeleton h-4 w-4 rounded-md" />
                <div
                  className="skeleton h-3 rounded-full"
                  style={{ width: 52 + ((i * 13) % 30) }}
                />
              </div>
            ))}
          </div>
          <div className="p-3.5">
            <div className="rounded-2xl border border-[var(--sn-border)] bg-[var(--sn-surface-3)] p-3">
              <div className="skeleton h-2.5 w-2/3 rounded-full" />
              <div className="skeleton mt-2.5 h-3 w-1/2 rounded-full" />
            </div>
          </div>
        </aside>
        <main className="relative min-w-0 flex-1">
          {/* sticky 页头占位 */}
          <div className="sn-pagehead sticky top-0 z-20">
            <div className="mx-auto flex max-w-2xl items-center gap-3.5 px-8 pb-4 pt-7">
              <div className="skeleton h-10 w-10 rounded-[14px]" />
              <div className="flex-1 space-y-1.5">
                <div className="skeleton h-3.5 w-28 rounded-full" />
                <div className="skeleton h-2.5 w-52 rounded-full" />
              </div>
            </div>
          </div>
          <div className="px-8 pb-32 pt-4">
            <div className="mx-auto max-w-2xl space-y-5">
              <div className="rounded-[20px] border border-[var(--sn-border)] bg-[var(--sn-surface)] p-5">
                <div className="flex items-center gap-3">
                  <div className="skeleton h-9 w-9 rounded-xl" />
                  <div className="flex-1 space-y-1.5">
                    <div className="skeleton h-3.5 w-1/3 rounded-full" />
                    <div className="skeleton h-2.5 w-1/2 rounded-full" />
                  </div>
                </div>
                <div className="skeleton mt-5 h-[104px] rounded-xl" />
              </div>
              <div className="rounded-[20px] border border-[var(--sn-border)] bg-[var(--sn-surface)] p-5">
                <div className="skeleton h-3.5 w-1/4 rounded-full" />
                <div className="mt-4 space-y-2.5">
                  <div className="skeleton h-10 rounded-2xl" />
                  <div className="skeleton h-10 rounded-2xl" />
                </div>
              </div>
              <div className="skeleton h-24 rounded-[20px]" />
            </div>
          </div>
        </main>
      </div>
    );
  }

  const stageInfo = STAGE_LABEL[stage];
  const hotkeyChips = shortcutChips(cfg.hotkey.key);
  const quickChips = shortcutChips(cfg.hotkey.keyQuick);
  const translateChips = shortcutChips(cfg.hotkey.keyTranslate);
  const translateSelChips = shortcutChips(cfg.hotkey.keyTranslateSel);

  const tabProps = {
    cfg,
    set,
    toast: setToast,
    navigate: setTab,
    stage,
    statusMsg,
    recording,
    devices,
    refreshDevices,
    localModels,
    refreshLocalModels,
    history,
    refreshHistory,
    onRecordToggle,
    updateInfo,
  };

  return (
    <div className="sn-shell-bg flex min-h-screen">
      {/* 侧边栏 */}
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-[var(--sn-border)] bg-[var(--sn-sidebar)] backdrop-blur-xl">
        <div className="relative flex items-center gap-3 px-5 pb-7 pt-7">
          {/* 双色氛围光：主/副强调色各一团（几何常量，颜色随主题），回声涟漪的「余波」 */}
          <span
            className="aurora pointer-events-none absolute -left-7 -top-9 h-28 w-28 rounded-full blur-2xl"
            style={{
              background:
                'color-mix(in srgb, var(--sn-accent, #38bdf8) 20%, transparent)',
            }}
            aria-hidden
          />
          <span
            className="aurora-2 pointer-events-none absolute -left-2 -top-4 h-16 w-16 rounded-full blur-xl"
            style={{
              background:
                'color-mix(in srgb, var(--sn-accent-2, #6366f1) 18%, transparent)',
            }}
            aria-hidden
          />
          {/* 品牌徽章：渐变随强调色联动，玻璃光泽 + 悬停涟漪呼吸见 .logo-badge */}
          <LogoBadge size={40} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="brand-title text-[14.5px] font-semibold leading-tight">
                SpeakNow
              </span>
              {version && (
                <span
                  className="rounded-full px-1.5 py-px font-mono text-[9px] leading-[14px] text-slate-500"
                  style={{ border: '1px solid var(--sn-border, rgba(255,255,255,0.08))' }}
                >
                  {version}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-500">语音输入 · 记忆助手</div>
          </div>
        </div>

        <nav className="sn-scroll flex-1 space-y-1 overflow-y-auto px-3 pb-4">
          {/* 设置项搜索：12 页设置靠翻找太慢，按名称/关键词过滤侧栏 */}
          <div className="sticky top-0 z-10 -mt-1 mb-2 bg-[var(--sn-sidebar)] pb-1 pt-1 backdrop-blur">
            <input
              type="text"
              value={navQuery}
              onChange={(e) => setNavQuery(e.target.value)}
              placeholder="搜索设置页…"
              spellCheck={false}
              className="w-full rounded-lg border border-[var(--sn-border)] bg-[var(--sn-surface-2)] px-2.5 py-1.5 text-[12px] text-slate-200 placeholder:text-slate-600 outline-none transition hover:border-[var(--sn-border-strong)] focus:border-accent focus:ring-[3px] focus:ring-[color:var(--sn-accent-ring)]"
            />
          </div>
          {navItems.map((n, i) => {
            const active = tab === n.id;
            const showGroup = n.group !== navItems[i - 1]?.group;
            return (
              <Fragment key={n.id}>
                {showGroup && (
                  <div
                    className={`sn-group-label ${i > 0 ? 'mb-1.5 mt-4' : 'mb-1.5 mt-1'}`}
                  >
                    {n.group}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setTab(n.id)}
                  className={`group relative flex w-full items-center gap-2.5 rounded-xl px-3 py-[7px] text-[13px] transition-all duration-200 active:scale-[0.98] ${
                    active
                      ? 'nav-glow font-medium text-accent-text'
                      : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
                  }`}
                >
                  {active && <span className="sn-nav-indicator" aria-hidden />}
                  <span
                    className={`flex w-5 shrink-0 items-center justify-center transition-colors duration-200 ${
                      active
                        ? 'text-accent-text'
                        : 'text-slate-500 group-hover:text-slate-300'
                    }`}
                  >
                    {ICONS[n.id]}
                  </span>
                  <span className="truncate">{n.label}</span>
                  {n.id === 'mem' && memTotal !== null && memTotal > 0 && (
                    <span className="sn-nav-badge">{memTotal}</span>
                  )}
                  {n.id === 'history' && history.length > 0 && (
                    <span className="sn-nav-badge">{history.length}</span>
                  )}
                  {n.id === 'asr' &&
                    cfg.asr.provider === 'local' &&
                    !localModels.find((m) => m.id === cfg.asr.localModel)?.downloaded && (
                      <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />
                    )}
                  {n.id === 'about' &&
                    updateInfo &&
                    updateInfo.latest !== cfg.general.skipVersion && (
                      <span
                        className="ml-auto h-1.5 w-1.5 rounded-full bg-accent"
                        title={`有新版本 v${updateInfo.latest}`}
                        aria-label={`有新版本 v${updateInfo.latest}`}
                      />
                    )}
                </button>
              </Fragment>
            );
          })}
        </nav>

        {/* 底部状态卡：上行会话状态（失败提示换行铺满），发丝线分隔，
            下行快捷键徽章 + 模式说明，flex-wrap 保证窄侧栏不溢出 */}
        <div className="p-3.5">
          <div className="rounded-2xl border border-[var(--sn-border)] bg-[var(--sn-surface-3)] p-3">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${stageInfo.dot}`} aria-hidden />
              <span className="shrink-0 text-[12px] font-medium text-slate-300">
                {stageInfo.text}
              </span>
              <span className="ml-auto truncate text-[10px] text-slate-600">
                {STAGE_HINT[stage] ?? ''}
              </span>
            </div>
            {saveFails > 0 && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-red-400">
                <span
                  className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-red-500"
                  aria-hidden
                />
                配置保存失败 · 将自动重试
              </div>
            )}
            {hotkeyChips.length > 0 && (
              <>
                <div className="my-2.5 h-px bg-[var(--sn-border)]" aria-hidden />
                <div className="flex flex-wrap items-center gap-1">
                  {hotkeyChips.map((c, i) => (
                    <span key={i} className="flex items-center gap-1">
                      {i > 0 && <span className="text-[10px] text-slate-600">+</span>}
                      <span className="kbd">{c}</span>
                    </span>
                  ))}
                  <span className="rounded border border-[var(--sn-border)] bg-[var(--sn-surface-2)] px-1 py-0.5 text-[9.5px] text-slate-400">
                    {cfg.hotkey.mode === 'hold' ? '按住说话' : '点按开关'}
                  </span>
                  {quickChips.length > 0 && (
                    <span className="rounded border border-amber-400/25 bg-amber-400/10 px-1 py-0.5 text-[9.5px] text-amber-300">
                      快速
                    </span>
                  )}
                  {translateChips.length > 0 && (
                    <span className="rounded border border-emerald-400/25 bg-emerald-400/10 px-1 py-0.5 text-[9.5px] text-emerald-300">
                      翻译
                    </span>
                  )}
                  {translateSelChips.length > 0 && (
                    <span className="rounded border border-teal-400/25 bg-teal-400/10 px-1 py-0.5 text-[9.5px] text-teal-300">
                      划词
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </aside>

      {/* 主内容：sticky 页头（页面定位）+ 按 tab 切换动画的内容区 */}
      <main className="relative min-w-0 flex-1">
        <div className="sn-pagehead sticky top-0 z-20">
          <div
            key={`head-${tab}`}
            className="anim-rise mx-auto flex max-w-2xl items-center gap-3.5 px-8 pb-3.5 pt-7"
          >
            {/* 页面图标：复用侧栏 16px 线性图标，经任意子选择器放大到 20px */}
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] border border-[var(--sn-border)] bg-gradient-to-br from-accent/[0.16] via-accent-2/[0.1] to-transparent text-accent-text shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] [&>svg]:h-5 [&>svg]:w-5">
              {ICONS[tab]}
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-[16px] font-semibold leading-6 tracking-wide text-slate-100">
                {(NAV.find((n) => n.id === tab) ?? NAV[0]).label}
              </h1>
              <p className="mt-0.5 truncate text-xs leading-4 text-slate-500">
                {(NAV.find((n) => n.id === tab) ?? NAV[0]).desc}
              </p>
            </div>
          </div>
        </div>
        <div className="px-8 pb-32 pt-4">
          <div key={tab} className="anim-page mx-auto max-w-2xl space-y-5">
            <Suspense
              fallback={
                <div className="flex min-h-[40vh] items-center justify-center text-xs text-slate-600">
                  加载中…
                </div>
              }
            >
              {tab === 'dash' && <Dashboard {...tabProps} />}
              {tab === 'mem' && <MemTab {...tabProps} />}
              {tab === 'hotkey' && <HotkeyTab {...tabProps} />}
              {tab === 'mic' && <MicTab {...tabProps} />}
              {tab === 'asr' && <AsrTab {...tabProps} />}
              {tab === 'llm' && <LlmTab {...tabProps} />}
              {tab === 'translate' && <TranslateTab {...tabProps} />}
              {tab === 'ocr' && <OcrTab {...tabProps} />}
              {tab === 'output' && <OutputTab {...tabProps} />}
              {tab === 'display' && <DisplayTab {...tabProps} />}
              {tab === 'history' && <HistoryTab {...tabProps} />}
              {tab === 'about' && <AboutTab {...tabProps} />}
            </Suspense>
          </div>
        </div>
      </main>

      {/* 保存栏：自动保存状态提示；失败时变红、点击立即重试 */}
      {dirty &&
        (saveFails > 0 ? (
          <div className="anim-rise fixed inset-x-0 bottom-5 z-30 flex justify-center">
            <button
              type="button"
              onClick={() => void onSave()}
              className="flex cursor-pointer items-center gap-3 rounded-full border border-red-500/25 bg-[#17171f]/95 py-2 pl-5 pr-5 shadow-2xl shadow-red-950/40 backdrop-blur transition hover:border-red-500/45"
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
              </span>
              <span className="text-[13px] text-red-300">保存失败 · 点击重试</span>
            </button>
          </div>
        ) : (
          <div className="anim-rise fixed inset-x-0 bottom-5 z-30 flex justify-center">
            <div className="flex items-center gap-3 rounded-full border border-accent/20 bg-[#17171f]/95 py-2 pl-5 pr-5 shadow-2xl shadow-sky-950/50 backdrop-blur">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
              </span>
              <span className="text-[13px] text-slate-300">
                正在自动保存…
              </span>
            </div>
          </div>
        ))}

      {/* Toast 队列：同屏最多 2 条，多余排队，逐条过期/点击关闭 */}
      {toasts.length > 0 && (
        <div className="fixed left-1/2 top-5 z-40 flex w-max max-w-[520px] -translate-x-1/2 flex-col items-center gap-2">
          {toasts.slice(0, 2).map((t) => (
            <Toast key={t.id} item={t} onClose={dismissToast} />
          ))}
        </div>
      )}
    </div>
  );
}
