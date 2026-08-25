import { useMemo } from 'react';
import type { Stage, TabProps } from '../types';
import { shortcutChips } from '../api';
import { Button, Toggle } from './Controls';

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
    dot: 'bg-sky-400 animate-pulse',
    text: 'text-sky-300',
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

const STAT_ICONS = ['🔤', '✍️', '📅', '⚡'];

export default function Dashboard({
  cfg,
  set,
  navigate,
  stage,
  statusMsg,
  recording,
  history,
  localModels,
  onRecordToggle,
}: TabProps) {
  const stats = useMemo(() => {
    const total = history.length;
    const chars = history.reduce((n, h) => n + h.final.length, 0);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const today = history.filter((h) => h.ts * 1000 >= todayStart.getTime()).length;
    const proc = history
      .map((h) => (h.asrMs ?? 0) + (h.llmMs ?? 0))
      .filter((v) => v > 0);
    const avg = proc.length
      ? (proc.reduce((a, b) => a + b, 0) / proc.length / 1000).toFixed(1) + 's'
      : '—';
    return { total, chars, today, avg };
  }, [history]);

  const info = STAGE_INFO[stage];
  const hotkeyChips = shortcutChips(cfg.hotkey.key);
  const quickChips = shortcutChips(cfg.hotkey.keyQuick);

  const asrLocalReady =
    cfg.asr.provider === 'local' &&
    localModels.find((m) => m.id === cfg.asr.localModel)?.downloaded === true;
  const llmIsLocal = /\/\/(localhost|127\.0\.0\.1)/.test(cfg.llm.baseUrl);

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
          ok: cfg.asr.apiKey.trim() !== '',
          label:
            cfg.asr.apiKey.trim() !== '' ? '云端 ASR 已配置' : 'ASR API Key 未填写',
          tab: 'asr' as const,
        },
    {
      ok: !cfg.llm.enabled || llmIsLocal || cfg.llm.apiKey.trim() !== '',
      label: cfg.llm.enabled
        ? llmIsLocal
          ? 'AI 优化 · 本地服务（免 Key）'
          : cfg.llm.apiKey.trim() !== ''
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
    {
      ok: true,
      label: cfg.audio.device ? `麦克风：${cfg.audio.device}` : '麦克风：系统默认',
      tab: 'mic' as const,
    },
  ];

  return (
    <div className="space-y-5">
      {/* 状态主卡片（极光背景） */}
      <section className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-br from-sky-500/[0.08] via-indigo-500/[0.04] to-transparent p-5">
        <span
          className="aurora pointer-events-none absolute -right-14 -top-20 h-52 w-52 rounded-full bg-sky-500/15 blur-3xl"
          aria-hidden
        />
        <span
          className="aurora-2 pointer-events-none absolute -bottom-24 -left-10 h-52 w-52 rounded-full bg-indigo-500/10 blur-3xl"
          aria-hidden
        />
        <div className="relative flex flex-wrap items-center gap-4">
          <span className="relative flex h-12 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/20 to-indigo-500/20">
            <span className={`h-3.5 w-3.5 rounded-full ${info.dot}`} aria-hidden />
            {stage === 'recording' && (
              <span
                className="absolute inset-0 animate-ping rounded-2xl border border-red-500/30"
                aria-hidden
              />
            )}
          </span>
          <div className="min-w-0">
            <div className={`text-lg font-semibold ${info.text}`}>{info.label}</div>
            <div className="truncate text-xs text-slate-400">
              {statusMsg && stage === 'error' ? statusMsg : info.hint}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
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
          <span className="ml-auto text-[11px] text-slate-600">修改 ›</span>
        </button>
      </section>

      {/* 统计 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: '累计使用', value: String(stats.total), unit: '次' },
          { label: '累计输入', value: String(stats.chars), unit: '字' },
          { label: '今日', value: String(stats.today), unit: '次' },
          { label: '平均处理', value: stats.avg, unit: '' },
        ].map((s, i) => (
          <div
            key={s.label}
            className="card-lift rounded-xl border border-white/[0.06] bg-white/[0.025] px-4 py-3.5"
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-500">{s.label}</span>
              <span className="text-[12px] opacity-70">{STAT_ICONS[i]}</span>
            </div>
            <div className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-slate-100">
              {s.value}
              {s.unit && (
                <span className="ml-1 text-[11px] font-normal text-slate-500">
                  {s.unit}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 配置自检 */}
      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-5">
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
      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-5">
        <h2 className="mb-3 text-[15px] font-semibold text-slate-100">⚡ 快速开关</h2>
        <div className="space-y-2">
          <Toggle
            checked={cfg.llm.enabled}
            onChange={(enabled) => set('llm', { enabled })}
            label="AI 纠错与优化"
            desc="关闭后直接输出 ASR 原文，速度最快"
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
            checked={cfg.general.autostart}
            onChange={(autostart) => set('general', { autostart })}
            label="开机自动启动"
            desc="开机后驻留后台，快捷键随时可用"
          />
        </div>
      </section>

      {/* 外观 */}
      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-5">
        <h2 className="mb-3 text-[15px] font-semibold text-slate-100">🎨 外观</h2>
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-slate-300/90">主题</div>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { v: 'dark', label: '🌙 夜间', desc: '深色 · 护眼默认' },
                  { v: 'light', label: '☀️ 日间', desc: '浅色 · 明亮清爽' },
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
                        ? 'border-sky-500/70 bg-gradient-to-br from-sky-500/[0.12] to-indigo-500/[0.08]'
                        : 'border-white/[0.08] bg-black/20 hover:border-white/20'
                    }`}
                  >
                    <span
                      className={`block text-[13px] font-medium ${
                        active ? 'text-sky-300' : 'text-slate-200'
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
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[13px] font-medium text-slate-300/90">界面缩放</span>
              <span className="font-mono text-xs text-sky-300">
                {Math.round((cfg.general.fontScale || 1) * 100)}%
              </span>
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
        <section className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-slate-100">🕘 最近使用</h2>
            <button
              type="button"
              onClick={() => navigate('history')}
              className="text-xs text-sky-400 transition hover:text-sky-300"
            >
              查看全部 ›
            </button>
          </div>
          <div className="space-y-2">
            {history.slice(0, 3).map((h) => (
              <div
                key={h.ts}
                className="card-lift truncate rounded-lg border border-white/[0.05] bg-black/20 px-3.5 py-2.5 text-[13px] text-slate-300"
              >
                {h.final}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
