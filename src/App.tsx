import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  applyAppearance,
  builtinModels,
  getConfig,
  getHistory,
  listDevices,
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
} from './types';
import { Spinner } from './components/Controls';
import Dashboard from './components/Dashboard';
import {
  AboutTab,
  AsrTab,
  HistoryTab,
  HotkeyTab,
  LlmTab,
  MicTab,
  OutputTab,
} from './components/sections';
import './styles.css';

const NAV: { id: TabId; icon: string; label: string }[] = [
  { id: 'dash', icon: '🏠', label: '总览' },
  { id: 'hotkey', icon: '⌨️', label: '快捷键' },
  { id: 'mic', icon: '🎙️', label: '麦克风' },
  { id: 'asr', icon: '📝', label: '语音识别' },
  { id: 'llm', icon: '✨', label: 'AI 优化' },
  { id: 'output', icon: '⌨', label: '输入方式' },
  { id: 'history', icon: '🕘', label: '历史' },
  { id: 'about', icon: 'ℹ️', label: '关于' },
];

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
  transcribing: { text: '识别中', cls: 'bg-sky-500/15 text-sky-300', dot: 'bg-sky-400 animate-pulse' },
  optimizing: { text: 'AI 优化中', cls: 'bg-indigo-500/15 text-indigo-300', dot: 'bg-indigo-400 animate-pulse' },
  review: { text: '待确认', cls: 'bg-amber-500/15 text-amber-300', dot: 'bg-amber-400 animate-pulse' },
  done: { text: '完成', cls: 'bg-emerald-500/15 text-emerald-300', dot: 'bg-emerald-400' },
  error: { text: '出错', cls: 'bg-red-500/15 text-red-300', dot: 'bg-red-500' },
};

function MicLogo({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" fill="white" />
      <path
        d="M5 11a7 7 0 0 0 14 0"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M12 18v3" stroke="white" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function App() {
  const [tab, setTab] = useState<TabId>('dash');
  const [cfg, setCfg] = useState<Config | null>(null);
  const savedRef = useRef('');
  const cfgRef = useRef<Config | null>(null);
  cfgRef.current = cfg;
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [localModels, setLocalModels] = useState<LocalModelStatus[]>([]);
  const [stage, setStage] = useState<Stage>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [toast, setToast] = useState('');
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    getConfig().then((c) => {
      setCfg(c);
      savedRef.current = JSON.stringify(c);
    });
    listDevices().then(setDevices);
    getHistory().then(setHistory);
    builtinModels().then(setLocalModels);
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
    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      un1.then((f) => f());
      un2.then((f) => f());
      un3.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  // 主题与缩放实时应用
  useEffect(() => {
    if (cfg) applyAppearance(cfg.general.theme, cfg.general.fontScale);
  }, [cfg?.general.theme, cfg?.general.fontScale]);

  const dirty = cfg !== null && JSON.stringify(cfg) !== savedRef.current;

  const set = useCallback(
    <K extends keyof Config>(key: K, patch: Partial<Config[K]>) => {
      setCfg((c) => (c ? { ...c, [key]: { ...c[key], ...patch } } : c));
    },
    [],
  );

  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const saveFailsRef = useRef(0);

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
      if (!silent) setToast('已保存 ✓');
    } catch (e) {
      saveFailsRef.current += 1;
      if (saveFailsRef.current === 1 || !silent) setToast(`保存失败：${e}`);
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
    listDevices().then(setDevices);
  }, []);

  // 设备列表自动刷新：无线接收器休眠/重新枚举后设备会迟到，
  // 只在启动时拉一次会让已保存的麦克风在列表里「消失」，看起来像配置丢失
  useEffect(() => {
    const iv = setInterval(() => refreshDevices(), 10000);
    const onFocus = () => refreshDevices();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(iv);
      window.removeEventListener('focus', onFocus);
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
      setToast(String(e));
    }
  }, [recording]);

  if (!cfg) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner size={24} />
      </div>
    );
  }

  const stageInfo = STAGE_LABEL[stage];
  const hotkeyChips = shortcutChips(cfg.hotkey.key);
  const quickChips = shortcutChips(cfg.hotkey.keyQuick);

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
  };

  return (
    <div className="flex min-h-screen">
      {/* 侧边栏 */}
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-white/[0.06] bg-[#0d0d14]/80 backdrop-blur-xl">
        <div className="relative flex items-center gap-2.5 px-5 pb-7 pt-7">
          <span
            className="aurora pointer-events-none absolute -left-6 -top-8 h-24 w-24 rounded-full bg-sky-500/20 blur-2xl"
            aria-hidden
          />
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 shadow-lg shadow-sky-500/30">
            <MicLogo />
          </div>
          <div>
            <div className="text-[14px] font-semibold text-slate-50">SpeakNow</div>
            <div className="text-[10px] text-slate-500">语音输入助手</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4">
          {NAV.map((n) => {
            const active = tab === n.id;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => setTab(n.id)}
                className={`relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] transition active:scale-[0.98] ${
                  active
                    ? 'nav-glow font-medium text-sky-300'
                    : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
                }`}
              >
                {active && (
                  <span
                    className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-gradient-to-b from-sky-400 to-indigo-500 shadow-[0_0_8px_rgba(56,189,248,0.6)]"
                    aria-hidden
                  />
                )}
                <span className="w-5 text-center text-[13px]">{n.icon}</span>
                <span>{n.label}</span>
                {n.id === 'history' && history.length > 0 && (
                  <span className="ml-auto rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[10px] text-slate-500">
                    {history.length}
                  </span>
                )}
                {n.id === 'asr' &&
                  cfg.asr.provider === 'local' &&
                  !localModels.find((m) => m.id === cfg.asr.localModel)?.downloaded && (
                    <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />
                  )}
              </button>
            );
          })}
        </nav>

        {/* 底部状态卡 */}
        <div className="p-3.5">
          <div className="rounded-xl border border-white/[0.06] bg-black/30 p-3">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${stageInfo.dot}`} aria-hidden />
              <span className="text-[12px] font-medium text-slate-300">
                {stageInfo.text}
              </span>
              <span className="text-[10px] text-slate-600">
                {STAGE_HINT[stage] ?? ''}
              </span>
              {dirty && (
                <span className="ml-auto text-[10.5px] text-sky-400/90">自动保存中…</span>
              )}
            </div>
            {hotkeyChips.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {hotkeyChips.map((c, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <span className="text-[10px] text-slate-600">+</span>}
                    <span className="kbd">{c}</span>
                  </span>
                ))}
                {quickChips.length > 0 && (
                  <span className="ml-1 rounded border border-amber-400/25 bg-amber-400/10 px-1 py-0.5 text-[9.5px] text-amber-300">
                    快速
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* 主内容（按 tab 切换动画） */}
      <main className="min-w-0 flex-1 px-8 pb-32 pt-8">
        <div key={tab} className="anim-page mx-auto max-w-2xl space-y-5">
          {tab === 'dash' && <Dashboard {...tabProps} />}
          {tab === 'hotkey' && <HotkeyTab {...tabProps} />}
          {tab === 'mic' && <MicTab {...tabProps} />}
          {tab === 'asr' && <AsrTab {...tabProps} />}
          {tab === 'llm' && <LlmTab {...tabProps} />}
          {tab === 'output' && <OutputTab {...tabProps} />}
          {tab === 'history' && <HistoryTab {...tabProps} />}
          {tab === 'about' && <AboutTab {...tabProps} />}
        </div>
      </main>

      {/* 保存栏：自动保存状态提示 */}
      {dirty && (
        <div className="anim-rise fixed inset-x-0 bottom-5 z-30 flex justify-center">
          <div className="flex items-center gap-3 rounded-full border border-sky-500/20 bg-[#17171f]/95 py-2 pl-5 pr-5 shadow-2xl shadow-sky-950/50 backdrop-blur">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-400" />
            </span>
            <span className="text-[13px] text-slate-300">
              正在自动保存…
            </span>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="anim-rise fixed left-1/2 top-5 z-40 max-w-[520px] -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#17171f]/95 px-4 py-2 text-xs leading-5 text-slate-200 shadow-xl">
            {(() => {
              const isError = /失败|错误|无法|未找到|不支持|未检测/.test(toast);
              const isOk = /成功|完成|就绪|已保存|已设置|已导出|已恢复|已下载/.test(toast);
              return (
                <span className={isError ? 'text-red-400' : isOk ? 'text-emerald-400' : 'text-sky-400'}>
                  {isError ? '⚠' : isOk ? '✓' : '✦'}
                </span>
              );
            })()}
            <span className="min-w-0">{toast}</span>
          </div>
        </div>
      )}
    </div>
  );
}
