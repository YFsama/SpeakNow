import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Button,
  Field,
  Section,
  Segmented,
  Select,
  Spinner,
  TextArea,
  TextInput,
  Toggle,
} from './Controls';
import HotkeyRecorder from './HotkeyRecorder';
import {
  appVersion,
  autoCalibrate,
  clearHistory,
  copyText,
  deleteHistory,
  deleteBuiltin,
  displayStatus,
  downloadBuiltin,
  exportText,
  isElevated,
  listLlmModels,
  micDiagnose,
  micTest,
  micTestAll,
  micHwLevels,
  micVolumeInfo,
  openConfigDir,
  openDisplayPage,
  openMicSettings,
  regenerate,
  resetConfig,
  restartElevated,
  setMicHwLevel,
  setMicVolume,
  testAsr,
  testLlm,
} from '../api';
import type {
  DeviceScanRow,
  DisplayStatus,
  HwLevel,
  MicDiagnosis,
  MicVolumeInfo,
} from '../api';
import type { Config, DeviceInfo, MicTestResult, TabProps } from '../types';

/* ============ 快捷键 ============ */
export function HotkeyTab({ cfg, set }: TabProps) {
  return (
    <Section
      icon="⌨️"
      title="触发快捷键"
      desc="任意应用内全局触发，无需切换窗口；可另设一个跳过 AI 的快速键。"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="主快捷键"
          hint={`当前为「${
            cfg.hotkey.mode === 'hold' ? '按住说话' : '按一下开始'
          }」模式，点击后直接录入新组合键`}
        >
          <HotkeyRecorder value={cfg.hotkey.key} onChange={(key) => set('hotkey', { key })} />
        </Field>
        <Field
          label="快速模式（可选）"
          hint="识别后不经 AI 直接输出原文，追求最快速度时使用"
        >
          <HotkeyRecorder
            value={cfg.hotkey.keyQuick}
            onChange={(keyQuick) => set('hotkey', { keyQuick })}
          />
        </Field>
      </div>
      <Field label="触发方式">
        <Segmented
          value={cfg.hotkey.mode}
          onChange={(mode) => set('hotkey', { mode })}
          options={[
            { value: 'toggle', label: '按一下开始', desc: '再按一下结束 · 适合长指令' },
            { value: 'hold', label: '按住说话', desc: '松开自动结束 · 节奏更快' },
          ]}
        />
      </Field>
      <Toggle
        checked={cfg.hotkey.enabled}
        onChange={(enabled) => set('hotkey', { enabled })}
        label="启用主快捷键"
        desc="关闭后仍可通过快速键、托盘菜单或本页触发"
      />
    </Section>
  );
}

/* ============ 麦克风 ============ */
const fmtRate = (hz: number | null) =>
  hz ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)}kHz` : '';

function specText(d: DeviceInfo): string {
  const parts = [fmtRate(d.sampleRate), d.channels ? `${d.channels} 声道` : ''].filter(
    Boolean,
  );
  return parts.join(' · ') || '规格未知';
}

function DeviceCard({
  name,
  spec,
  isDefault,
  selected,
  onSelect,
  onQuick,
  testing,
  result,
}: {
  name: string;
  spec: string;
  isDefault?: boolean;
  selected: boolean;
  onSelect: () => void;
  onQuick: () => void;
  testing: boolean;
  result?: MicTestResult;
}) {
  return (
    <div
      onClick={onSelect}
      className={`cursor-pointer rounded-xl border px-3.5 py-3 transition ${
        selected
          ? 'border-sky-500/70 bg-sky-500/[0.08]'
          : 'border-white/[0.07] bg-black/20 hover:border-white/20'
      }`}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 transition ${
            selected
              ? 'border-sky-400 bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.6)]'
              : 'border-slate-600'
          }`}
          aria-hidden
        />
        <span className="min-w-0 truncate text-[13px] font-medium text-slate-200">
          {name}
        </span>
        {isDefault && (
          <span className="shrink-0 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
            默认
          </span>
        )}
        <button
          type="button"
          disabled={testing}
          onClick={(e) => {
            e.stopPropagation();
            onQuick();
          }}
          className="ml-auto shrink-0 rounded-md px-2 py-1 text-[11px] text-sky-400 transition hover:bg-sky-500/10 hover:text-sky-300 disabled:opacity-50"
        >
          {testing ? '测试中…' : '⚡ 测试'}
        </button>
      </div>
      <div className="mt-1 pl-[26px] font-mono text-[11px] text-slate-500">{spec}</div>
      {result && !testing && (
        <div className="anim-rise mt-1.5 pl-[26px] text-[11px] text-slate-500">
          均值{' '}
          <b className={result.avgLevel < 3 ? 'text-red-400' : 'text-emerald-400'}>
            {result.avgLevel.toFixed(0)}%
          </b>{' '}
          · 峰值 {result.peakLevel.toFixed(0)}%
          {result.avgLevel < 3 && (
            <span className="ml-1 text-red-300">（几乎无信号）</span>
          )}
        </div>
      )}
    </div>
  );
}

function LevelBar({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11px] text-slate-500">
        <span>{label}</span>
        <span>{value.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full transition-all ${
            value < 3 ? 'bg-red-500' : 'bg-gradient-to-r from-sky-500 to-emerald-400'
          }`}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
    </div>
  );
}

export function MicTab({ cfg, set, devices, refreshDevices, toast }: TabProps) {
  // undefined=空闲；null=测试系统默认；string=测试指定设备
  const [quickTesting, setQuickTesting] = useState<string | null | undefined>(undefined);
  const [quickResult, setQuickResult] = useState<Record<string, MicTestResult>>({});
  const [fullTesting, setFullTesting] = useState(false);
  const [live, setLive] = useState<number[]>(() => Array(44).fill(0));
  const [fullResult, setFullResult] = useState<MicTestResult | null>(null);
  const [playing, setPlaying] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<MicDiagnosis | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanRows, setScanRows] = useState<DeviceScanRow[] | null>(null);
  const [allLive, setAllLive] = useState<Record<string, number>>({});
  const [sysVol, setSysVol] = useState<MicVolumeInfo | null>(null);
  const [hwLevels, setHwLevels] = useState<HwLevel[] | null>(null);

  // 读取系统端点音量 + 驱动硬件增益控件（仅 Windows）
  useEffect(() => {
    setSysVol(null);
    setHwLevels(null);
    micVolumeInfo(cfg.audio.device)
      .then(setSysVol)
      .catch(() => setSysVol(null));
    micHwLevels(cfg.audio.device)
      .then(setHwLevels)
      .catch(() => setHwLevels([]));
  }, [cfg.audio.device]);

  const applyHwLevel = async (l: HwLevel, db: number) => {
    setHwLevels((prev) =>
      prev?.map((x) => (x.name === l.name ? { ...x, curDb: db } : x)) ?? prev,
    );
    try {
      const applied = await setMicHwLevel(cfg.audio.device, l.name, db);
      setHwLevels((prev) =>
        prev?.map((x) => (x.name === l.name ? { ...x, curDb: applied } : x)) ??
        prev,
      );
    } catch (e) {
      toast(`设置硬件增益失败：${e}`);
    }
  };

  const applySysVol = async (volume: number, unmute = false) => {
    setSysVol((v) => (v ? { ...v, volume, muted: unmute ? false : v.muted } : v));
    try {
      await setMicVolume(cfg.audio.device, volume, unmute);
      micVolumeInfo(cfg.audio.device).then(setSysVol).catch(() => {});
    } catch (e) {
      toast(`设置系统音量失败：${e}`);
    }
  };

  useEffect(() => {
    const un = listen<number>('sn-mic-level', (e) => {
      setLive((prev) => {
        const next = prev.slice(1);
        next.push(Math.max(0.03, Math.min(1, e.payload * 3.2)));
        return next;
      });
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const quick = async (name: string | null) => {
    setQuickTesting(name);
    try {
      const r = await micTest(name, false, cfg.audio.gainDb);
      setQuickResult((p) => ({ ...p, [name ?? '']: r }));
      if (r.avgLevel < 3)
        toast(`「${name ?? '系统默认'}」电平过低：可尝试下方「自动校准增益」`);
    } catch (e) {
      toast(`测试失败：${e}`);
    } finally {
      setQuickTesting(undefined);
    }
  };

  const full = async () => {
    setFullTesting(true);
    setFullResult(null);
    setLive(Array(44).fill(0));
    try {
      const r = await micTest(cfg.audio.device, true, cfg.audio.gainDb);
      setFullResult(r);
    } catch (e) {
      toast(`测试失败：${e}`);
    } finally {
      setFullTesting(false);
    }
  };

  const calibrate = async () => {
    setCalibrating(true);
    try {
      const r = await autoCalibrate(cfg.audio.device);
      if (r.suggestedDb == null) {
        toast(
          '几乎检测不到信号：请检查 Windows 设置 → 系统 → 声音 → 输入 音量是否为 0、耳机是否硬件静音、以及 隐私和安全性 → 麦克风 是否允许桌面应用',
        );
      } else {
        set('audio', { gainDb: r.suggestedDb });
        toast(
          `原始峰值 ${r.peakPercent.toFixed(0)}%，已设置增益 ${r.suggestedDb}dB（保存后生效，可再跑完整测试验证）`,
        );
      }
    } catch (e) {
      toast(`校准失败：${e}`);
    } finally {
      setCalibrating(false);
    }
  };

  const diagnose = async () => {
    setDiagnosing(true);
    setDiagnosis(null);
    try {
      setDiagnosis(await micDiagnose(cfg.audio.device));
    } catch (e) {
      toast(`诊断失败：${e}`);
    } finally {
      setDiagnosing(false);
    }
  };

  useEffect(() => {
    const un = listen<Record<string, number>>('sn-mic-level-all', (e) => {
      setAllLive(e.payload);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const scan = async () => {
    setScanning(true);
    setScanRows(null);
    setAllLive({});
    try {
      toast('已同时打开全部输入设备，请持续说话 3 秒…');
      setScanRows(await micTestAll(3200));
    } catch (e) {
      toast(`扫描失败：${e}`);
    } finally {
      setScanning(false);
    }
  };

  const play = () => {
    if (!fullResult?.wavBase64) return;
    const a = new Audio(`data:audio/wav;base64,${fullResult.wavBase64}`);
    a.onended = () => setPlaying(false);
    setPlaying(true);
    a.play().catch(() => setPlaying(false));
  };

  const hasDji = devices.some((d) => /dji/i.test(d.name));
  const testingNow = fullTesting || quickTesting !== undefined;

  return (
    <Section
      icon="🎙️"
      title="麦克风"
      desc="支持一切系统输入设备：USB / 2.4G 接收器 / 蓝牙 / 内置麦克风，均可单独测试。"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={refreshDevices}>⟳ 刷新设备</Button>
        <Button
          kind="primary"
          onClick={full}
          disabled={testingNow}
        >
          {fullTesting ? (
            <>
              <Spinner size={13} /> 采集中，请说话…
            </>
          ) : (
            '🎤 完整测试（3 秒 · 可试听）'
          )}
        </Button>
        <Button onClick={diagnose} disabled={testingNow || diagnosing}>
          {diagnosing ? (
            <>
              <Spinner size={13} /> 诊断中…
            </>
          ) : (
            '🔧 深度诊断'
          )}
        </Button>
        <Button onClick={scan} disabled={testingNow || scanning}>
          {scanning ? (
            <>
              <Spinner size={13} /> 并发采集中，请说话…
            </>
          ) : (
            '📡 同测全部设备'
          )}
        </Button>
        <span className="text-[11px] text-slate-500">
          测试对象：{cfg.audio.device ?? '系统默认'}
        </span>
      </div>

      {sysVol && (
        <div className="anim-rise rounded-xl border border-white/[0.06] bg-black/20 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] font-medium text-slate-300">
            🎚 系统输入音量
            <span className="min-w-0 truncate font-mono text-[10.5px] font-normal text-slate-500">
              {sysVol.device}
            </span>
            {sysVol.muted && (
              <button
                type="button"
                onClick={() => void applySysVol(sysVol.volume, true)}
                className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] text-red-300"
              >
                ⛔ 静音中 · 点击解除
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={sysVol.volume}
              onChange={(e) => void applySysVol(Number(e.target.value))}
              className="min-w-0 flex-1"
            />
            <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-sky-300">
              {sysVol.volume.toFixed(0)}%
            </span>
            <Button onClick={() => void applySysVol(85, true)}>设为 85%</Button>
          </div>
          <div className="mt-1.5 text-[11px] text-slate-500">
            直接写入 Windows 端点音量，拖动即时生效（无需保存）
          </div>
        </div>
      )}

      {hwLevels && hwLevels.length > 0 && (
        <div className="anim-rise rounded-xl border border-white/[0.06] bg-black/20 p-4">
          <div className="mb-2 text-[12px] font-medium text-slate-300">
            🎚 驱动硬件增益（dB）
            <span className="ml-2 text-[10.5px] font-normal text-slate-500">
              治本方案：在驱动层拉高信号，之后软件增益可调回 0
            </span>
          </div>
          <div className="space-y-3">
            {hwLevels.map((l) => (
              <div key={l.name} className="flex items-center gap-3">
                <span
                  className="w-36 shrink-0 truncate text-[11.5px] text-slate-400"
                  title={l.name}
                >
                  {/boost|加强/i.test(l.name) && '⚡ '}
                  {l.name}
                </span>
                <input
                  type="range"
                  min={l.minDb}
                  max={l.maxDb}
                  step={Math.max(l.stepDb, 0.5)}
                  value={l.curDb}
                  onChange={(e) => void applyHwLevel(l, Number(e.target.value))}
                  className="min-w-0 flex-1"
                />
                <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-sky-300">
                  {l.curDb.toFixed(1)}dB
                </span>
                <span className="w-20 shrink-0 text-right font-mono text-[10px] text-slate-500">
                  {l.minDb.toFixed(0)}~{l.maxDb.toFixed(0)}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-1.5 text-[11px] text-slate-500">
            立即写入驱动（无需保存）；「Mic Boost / 麦克风加强」类控件效果最明显
          </div>
        </div>
      )}

      {hwLevels && hwLevels.length === 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-black/20 px-4 py-3 text-[11.5px] leading-5 text-slate-400">
          该设备驱动未暴露硬件 dB 增益（USB / 无线耳机普遍如此）——用上方{' '}
          <b className="text-slate-300">软件增益</b>
          补偿即可，效果等同。游戏耳机也可在 Armoury Crate / 厂商面板里调「麦克风音量/增益」。
        </div>
      )}

      {diagnosing && (
        <div className="anim-rise rounded-xl border border-sky-500/25 bg-sky-500/[0.07] px-3.5 py-3 text-[12.5px] text-sky-200">
          <Spinner size={12} /> 正在采集约 2 秒 ——{' '}
          <b>请现在对着麦克风持续说话</b>，安静环境下测出的「静音」没有参考意义
        </div>
      )}

      {diagnosis && !diagnosing && (
        <div className="anim-rise rounded-xl border border-white/[0.06] bg-black/20 p-4">
          <div className="mb-3 text-[12px] font-medium text-slate-300">
            🔍 深度诊断结果
            <span className="ml-2 font-mono text-[10.5px] font-normal text-slate-500">
              采集 {diagnosis.frames} 帧 · 峰值 {diagnosis.peakPercent.toFixed(1)}%
            </span>
          </div>
          <div className="space-y-1.5 text-[11.5px]">
            <div className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-slate-500">系统麦克风权限</span>
              <span
                className={
                  diagnosis.systemPrivacy.toLowerCase() === 'deny'
                    ? 'text-red-400'
                    : diagnosis.systemPrivacy.toLowerCase() === 'allow'
                      ? 'text-emerald-400'
                      : 'text-slate-500'
                }
              >
                {diagnosis.systemPrivacy.toLowerCase() === 'deny'
                  ? '⛔ 已禁止（这就是无信号的原因）'
                  : diagnosis.systemPrivacy.toLowerCase() === 'allow'
                    ? '✅ 允许'
                    : '❔ 未知'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-slate-500">本应用授权</span>
              <span
                className={
                  diagnosis.appPrivacy.toLowerCase() === 'deny'
                    ? 'text-red-400'
                    : diagnosis.appPrivacy.toLowerCase() === 'allow'
                      ? 'text-emerald-400'
                      : 'text-slate-500'
                }
              >
                {diagnosis.appPrivacy.toLowerCase() === 'deny'
                  ? '⛔ 已被单独拒绝'
                  : diagnosis.appPrivacy.toLowerCase() === 'allow'
                    ? '✅ 允许'
                    : '❔ 尚未记录（首次使用时系统会询问）'}
              </span>
            </div>
            {diagnosis.systemVolume != null && (
              <div className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-slate-500">系统输入音量</span>
                <span
                  className={
                    diagnosis.systemMuted
                      ? 'text-red-400'
                      : diagnosis.systemVolume < 20
                        ? 'text-amber-400'
                        : 'text-emerald-400'
                  }
                >
                  {diagnosis.systemMuted
                    ? `⛔ 静音中（音量 ${diagnosis.systemVolume.toFixed(0)}%）`
                    : `${diagnosis.systemVolume.toFixed(0)}%${
                        diagnosis.systemVolume < 20 ? ' ← 过低' : ' ✅'
                      }`}
                </span>
              </div>
            )}
            {diagnosis.channelPeaks.length > 1 && (
              <div className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-slate-500">
                  声道峰值（{diagnosis.channelPeaks.length} 声道）
                </span>
                <span className="font-mono text-slate-400">
                  {diagnosis.channelPeaks
                    .map((p, i) => `#${i + 1}: ${p.toFixed(0)}%`)
                    .join('  ')}
                </span>
              </div>
            )}
          </div>
          <div className="mt-3 space-y-1 border-t border-white/[0.06] pt-3 text-[11.5px] leading-5 text-slate-300">
            {diagnosis.findings.map((f, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-sky-400">·</span>
                <span>{f}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button kind="primary" onClick={() => void openMicSettings()}>
              打开 Windows 麦克风设置
            </Button>
            <Button onClick={diagnose}>重新诊断</Button>
          </div>
        </div>
      )}

      {scanning && (
        <div className="anim-rise rounded-xl border border-sky-500/20 bg-sky-500/[0.04] p-4">
          <div className="mb-3 flex items-center gap-2 text-[12px] font-medium text-slate-300">
            <Spinner size={13} /> 所有输入设备正在同时采集
            <span className="animate-pulse text-sky-400">请现在持续说话…</span>
          </div>
          <div className="space-y-1.5">
            {Object.entries(allLive).map(([name, lv]) => (
              <div key={name} className="flex items-center gap-2.5">
                <span
                  className="w-64 min-w-0 shrink-0 truncate text-[11px] text-slate-400"
                  title={name}
                >
                  {name}
                </span>
                <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className={`h-full rounded-full transition-[width] duration-100 ${
                      lv > 0.03
                        ? 'bg-gradient-to-r from-sky-500 to-emerald-400'
                        : 'bg-slate-600/60'
                    }`}
                    style={{ width: `${Math.min(1, lv * 4) * 100}%` }}
                  />
                </div>
                <span className="w-10 shrink-0 text-right font-mono text-[10px] tabular-nums text-slate-500">
                  {(lv * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {scanRows && !scanning && (
        <div className="anim-rise rounded-xl border border-white/[0.06] bg-black/20 p-4">
          <div className="mb-3 text-[12px] font-medium text-slate-300">
            📡 全设备同时测试结果
            <span className="ml-2 text-[10.5px] font-normal text-slate-500">
              绿色 = 有信号，就是你在说话的麦克风；可一键选用
            </span>
          </div>
          <div className="space-y-2">
            {[...scanRows]
              .sort((a, b) => b.peakPercent - a.peakPercent)
              .map((row, idx) => {
                const best = row.peakPercent > 5;
                const isTop = best && idx === 0;
                return (
                  <div
                    key={row.name}
                    className={`flex flex-wrap items-center gap-2.5 rounded-lg border px-3 py-2 ${
                      isTop
                        ? 'border-emerald-500/40 bg-emerald-500/[0.08]'
                        : best
                          ? 'border-emerald-500/25 bg-emerald-500/[0.05]'
                          : 'border-white/[0.05]'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-slate-200">
                      {isTop && <span className="mr-1.5">🏆</span>}
                      {row.name}
                      {row.isDefault && (
                        <span className="ml-2 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-1.5 py-0.5 text-[9.5px] text-emerald-300">
                          系统默认
                        </span>
                      )}
                      {isTop && cfg.audio.device !== row.name && (
                        <span className="ml-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[9.5px] text-amber-300">
                          建议选用
                        </span>
                      )}
                    </span>
                    <span className="font-mono text-[10.5px] text-slate-500">
                      {fmtRate(row.sampleRate)}
                      {row.channels ? ` · ${row.channels}ch` : ''}
                    </span>
                    <span
                      title={row.error ?? undefined}
                      className={`w-28 shrink-0 font-mono text-[11px] ${
                        !row.ok
                          ? 'text-red-400'
                          : row.peakPercent > 5
                            ? 'text-emerald-400'
                            : row.peakPercent > 0.5
                              ? 'text-amber-400'
                              : 'text-slate-600'
                      }`}
                    >
                      {!row.ok
                        ? '无法打开'
                        : row.peakPercent > 5
                          ? `● 峰值 ${row.peakPercent.toFixed(0)}%`
                          : `峰值 ${row.peakPercent.toFixed(1)}%`}
                    </span>
                    {row.ok && (
                      <button
                        type="button"
                        onClick={() => {
                          set('audio', { device: row.name });
                          toast(`已选用「${row.name}」，保存后生效`);
                        }}
                        className={`shrink-0 rounded-md px-2 py-1 text-[11px] transition ${
                          isTop
                            ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                            : 'text-sky-400 hover:bg-sky-500/10'
                        }`}
                      >
                        选用
                      </button>
                    )}
                  </div>
                );
              })}
          </div>
          {scanRows.every((r) => !r.ok || r.peakPercent < 3) && (
            <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5 text-[11.5px] leading-5 text-amber-200/90">
              所有设备都没有听到声音 → 问题在系统/硬件层，与应用无关。按顺序检查：
              ① 耳机麦克风杆是否插紧、有没有物理静音开关；② 2.4G 接收器是否插在本机且未被其他电脑占用；
              ③ Windows 设置 → 系统 → 声音 → 输入，对着系统自带的「测试麦克风」条说话确认系统层有没有信号；
              ④ 重插接收器或重启 Armoury Crate / 声卡驱动面板后再试。
            </div>
          )}
        </div>
      )}

      {(fullTesting || quickTesting !== undefined) && (
        <div className="anim-rise rounded-xl border border-sky-500/20 bg-sky-500/[0.05] px-3.5 py-3">
          <div className="flex h-8 items-center gap-[2px]">
            {live.map((v, i) => (
              <span
                key={i}
                className="flex-1 rounded-full bg-gradient-to-t from-sky-500/80 to-indigo-400/80 transition-[height] duration-75"
                style={{ height: `${Math.max(4, v * 30)}px`, opacity: 0.4 + v * 0.6 }}
              />
            ))}
          </div>
          <div className="mt-1.5 text-center text-[11px] text-slate-400">
            正在采集实时电平，对着选定的麦克风说几句话
          </div>
        </div>
      )}

      {fullResult && !fullTesting && (
        <div className="anim-rise rounded-xl border border-white/[0.06] bg-black/20 p-4">
          <div className="mb-3 text-[12px] font-medium text-slate-300">
            📊 {cfg.audio.device ?? '系统默认'} · 测试结果
          </div>
          <div className="grid grid-cols-2 gap-4">
            <LevelBar value={fullResult.avgLevel} label="平均电平" />
            <LevelBar value={fullResult.peakLevel} label="峰值电平" />
          </div>
          {fullResult.avgLevel < 3 && (
            <div className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11px] leading-5 text-amber-200/90">
              信号过弱，按顺序排查：
              <br />
              1. 点下方「🎯 自动校准增益」——多数无线耳机只需软件增益即可解决
              <br />
              2. Windows 设置 → 系统 → 声音 → 输入：把输入音量拉到 80–100
              <br />
              3. Windows 设置 → 隐私和安全性 → 麦克风：允许桌面应用访问
              <br />
              4. 确认耳机没有硬件静音（如麦克风孔/线控开关）
            </div>
          )}
          {fullResult.wavBase64 && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button onClick={play} disabled={playing}>
                {playing ? '▶ 播放中…' : '▶ 试听刚才的录音'}
              </Button>
              <span className="text-[11px] text-slate-500">
                听不清 / 有底噪？优先用 USB 接收器，或调高发射器增益
              </span>
            </div>
          )}
        </div>
      )}

      <Field
        label={`输入设备（${devices.length + 1} 个可选）`}
        hint="点击卡片选择用于语音输入的设备；每张卡片可单独快测 1.4 秒"
      >
        <div className="space-y-2">
          <DeviceCard
            name="系统默认"
            spec="跟随操作系统当前选择的输入设备"
            selected={!cfg.audio.device}
            onSelect={() => set('audio', { device: null })}
            onQuick={() => void quick(null)}
            testing={quickTesting === null}
            result={quickResult['']}
          />
          {devices.map((d) => (
            <DeviceCard
              key={d.name}
              name={d.name}
              spec={specText(d)}
              isDefault={d.isDefault}
              selected={cfg.audio.device === d.name}
              onSelect={() => set('audio', { device: d.name })}
              onQuick={() => void quick(d.name)}
              testing={quickTesting === d.name}
              result={quickResult[d.name]}
            />
          ))}
          {/* 已保存但当前未枚举到的设备（无线接收器休眠/重枚举/刚重启）：
              置顶展示保留选择，设备就绪后自动恢复，避免看起来像配置丢失 */}
          {cfg.audio.device &&
            !devices.some((d) => d.name === cfg.audio.device) && (
              <DeviceCard
                name={cfg.audio.device}
                spec="已保存 · 当前未检测到，设备就绪后自动恢复使用（录音会临时走系统默认）"
                selected
                onSelect={() => set('audio', { device: cfg.audio.device })}
                onQuick={() => void quick(cfg.audio.device)}
                testing={quickTesting === cfg.audio.device}
              />
            )}
          {devices.length === 0 && (
            <div className="rounded-lg border border-dashed border-white/10 py-5 text-center text-xs text-slate-600">
              未发现其他输入设备，插入 USB 麦克风 / DJI 接收器后点「刷新设备」
            </div>
          )}
        </div>
      </Field>

      <Field
        label={`麦克风增益（软件）：${cfg.audio.gainDb.toFixed(1)} dB / 上限 45dB`}
        hint="原始信号弱（无线耳机常见）时用软件增益拉高；信号峰值到 40–70% 即可，过大可能放大底噪。增益本身不损失音质（上限内自动防削波）"
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={45}
            step={0.5}
            value={cfg.audio.gainDb}
            onChange={(e) => set('audio', { gainDb: Number(e.target.value) })}
            className="min-w-0 flex-1"
          />
          <Button onClick={calibrate} disabled={calibrating}>
            {calibrating ? (
              <>
                <Spinner size={13} /> 录制中…
              </>
            ) : (
              '🎯 自动校准'
            )}
          </Button>
        </div>
        <div className="mt-1.5 text-[11px] leading-5 text-slate-500">
          校准方式：对麦克风正常说几句话（2.6 秒），自动将峰值校准到 ~60%
        </div>
      </Field>

      {hasDji && (
        <div className="rounded-lg border border-amber-400/15 bg-amber-400/[0.05] px-3.5 py-2.5 text-[11.5px] leading-5 text-amber-200/80">
          🎧 已检测到 DJI 设备：USB-C 接收器模式为高音质 USB 音频（约 48kHz）；蓝牙模式为通话
          HFP（8–16kHz 单声道，音质明显下降）。追求识别准确率建议使用接收器，并用「完整测试」对比试听。
        </div>
      )}

      <Toggle
        checked={cfg.audio.vadEnabled}
        onChange={(vadEnabled) => set('audio', { vadEnabled })}
        label="静音自动结束（VAD）"
        desc="检测到停止说话一段时间后自动结束录音，无需再按快捷键"
      />
      {cfg.audio.vadEnabled && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={`静音判定时长：${(cfg.audio.vadSilenceMs / 1000).toFixed(1)} 秒`}>
            <input
              type="range"
              min={600}
              max={4000}
              step={100}
              value={cfg.audio.vadSilenceMs}
              onChange={(e) => set('audio', { vadSilenceMs: Number(e.target.value) })}
              className="w-full"
            />
          </Field>
          <Field
            label={`触发灵敏度：${(cfg.audio.vadThreshold * 1000).toFixed(0)}`}
            hint="数值越低越灵敏；环境嘈杂时调高"
          >
            <input
              type="range"
              min={3}
              max={80}
              step={1}
              value={Math.round(cfg.audio.vadThreshold * 1000)}
              onChange={(e) =>
                set('audio', { vadThreshold: Number(e.target.value) / 1000 })
              }
              className="w-full"
            />
          </Field>
        </div>
      )}
    </Section>
  );
}

/* ============ ASR ============ */
interface AsrPreset {
  value: string;
  label: string;
  provider: 'http' | 'local' | 'mimo';
  baseUrl: string;
  model: string;
  endpointPath: string;
}

const ASR_PRESETS: AsrPreset[] = [
  {
    value: 'mimo',
    label: '小米 MiMo-V2.5-ASR（OpenAI Chat 兼容）',
    provider: 'mimo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-asr',
    endpointPath: '/chat/completions',
  },
  {
    value: 'zhipu',
    label: '智谱 GLM-ASR（推荐，支持热词）',
    provider: 'http',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-asr-2512',
    endpointPath: '/audio/transcriptions',
  },
  {
    value: 'groq',
    label: 'Groq Whisper Large v3（海外，速度快）',
    provider: 'http',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3',
    endpointPath: '/audio/transcriptions',
  },
  {
    value: 'openai',
    label: 'OpenAI 官方',
    provider: 'http',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-transcribe',
    endpointPath: '/audio/transcriptions',
  },
  {
    value: 'siliconflow',
    label: 'SiliconFlow（国内）',
    provider: 'http',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
    endpointPath: '/audio/transcriptions',
  },
  {
    value: 'local-server',
    label: '本地 whisper.cpp / Speaches 服务',
    provider: 'http',
    baseUrl: 'http://127.0.0.1:8080',
    model: 'whisper-1',
    endpointPath: '/inference',
  },
  {
    value: 'custom',
    label: '自定义 / 其他兼容接口',
    provider: 'http',
    baseUrl: '',
    model: '',
    endpointPath: '/audio/transcriptions',
  },
];

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024).toFixed(0)}KB`;
}

export function AsrTab({ cfg, set, toast, localModels, refreshLocalModels }: TabProps) {
  const [test, setTest] = useState<{ loading: boolean; ok?: boolean; msg?: string }>({
    loading: false,
  });
  const [progress, setProgress] = useState<
    Record<string, { file: string; downloaded: number; total: number }>
  >({});
  const [downloading, setDownloading] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  useEffect(() => {
    const un = listen<{ model: string; file: string; downloaded: number; total: number }>(
      'sn-model-progress',
      (e) => {
        setProgress((p) => ({
          ...p,
          [e.payload.model]: {
            file: e.payload.file,
            downloaded: e.payload.downloaded,
            total: e.payload.total,
          },
        }));
      },
    );
    const un2 = listen('sn-models-changed', () => refreshLocalModels());
    return () => {
      un.then((f) => f());
      un2.then((f) => f());
    };
  }, [refreshLocalModels]);

  const preset =
    ASR_PRESETS.find(
      (p) =>
        p.baseUrl !== '' &&
        p.baseUrl === cfg.asr.baseUrl &&
        p.endpointPath === cfg.asr.endpointPath,
    )?.value ?? 'custom';

  const run = async () => {
    setTest({ loading: true });
    try {
      setTest({ loading: false, ok: true, msg: await testAsr(cfg.asr) });
    } catch (e) {
      setTest({ loading: false, ok: false, msg: String(e) });
    }
  };

  const onDownload = async (id: string) => {
    setDownloading(id);
    setConfirmDel(null);
    setTest({ loading: false });
    try {
      await downloadBuiltin(id, cfg.asr.mirror);
      toast(`本地模型 ${id} 下载完成 ✓`);
    } catch (e) {
      toast(`下载失败：${e}`);
    } finally {
      setDownloading(null);
      refreshLocalModels();
    }
  };

  const onDelete = async (id: string) => {
    if (confirmDel !== id) {
      setConfirmDel(id);
      return;
    }
    setConfirmDel(null);
    try {
      await deleteBuiltin(id);
      toast('已删除，磁盘空间已释放');
    } catch (e) {
      toast(`删除失败：${e}`);
    } finally {
      refreshLocalModels();
    }
  };

  const fmtSize = (mb: number) =>
    mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`;

  const isLocal = cfg.asr.provider === 'local';

  return (
    <Section
      icon="📝"
      title="语音识别（ASR）"
      desc="云端接口即配即用；或切换本地离线引擎，下载一次模型后零 Key、零联网。"
    >
      <Field label="识别引擎">
        <Segmented
          value={cfg.asr.provider === 'mimo' ? 'mimo' : cfg.asr.provider}
          onChange={(provider) => set('asr', { provider })}
          options={[
            { value: 'mimo', label: 'MiMo 云端', desc: '小米 MiMo-V2.5-ASR' },
            { value: 'http', label: '云端 API', desc: 'GLM-ASR / Whisper 等 · 需 Key' },
            { value: 'local', label: '本地离线', desc: 'Whisper / Qwen3-ASR · 免 Key 免联网' },
          ]}
        />
      </Field>

      {!isLocal && (
        <>
          <Field label="服务商预设">
            <Select
              value={preset}
              onChange={(v) => {
                const p = ASR_PRESETS.find((x) => x.value === v);
                if (!p) return;
                set('asr', {
                  provider: p.provider,
                  baseUrl: p.baseUrl || cfg.asr.baseUrl,
                  model: p.model || cfg.asr.model,
                  endpointPath: p.endpointPath,
                });
              }}
              options={ASR_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="接口地址 Base URL">
              <TextInput
                mono
                value={cfg.asr.baseUrl}
                onChange={(baseUrl) => set('asr', { baseUrl })}
                placeholder="https://open.bigmodel.cn/api/paas/v4"
              />
            </Field>
            <Field label="模型名称">
              <TextInput
                mono
                value={cfg.asr.model}
                onChange={(model) => set('asr', { model })}
                placeholder="glm-asr-2512 / whisper-large-v3 / mimo-asr …"
              />
            </Field>
          </div>
          <Field label="API Key">
            <TextInput
              type="password"
              mono
              value={cfg.asr.apiKey}
              onChange={(apiKey) => set('asr', { apiKey })}
              placeholder="sk-…"
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="端点路径" hint="whisper.cpp 本地服务为 /inference">
              <TextInput
                mono
                value={cfg.asr.endpointPath}
                onChange={(endpointPath) => set('asr', { endpointPath })}
              />
            </Field>
            <Field label="请求超时（秒）">
              <TextInput
                mono
                value={String(cfg.asr.timeoutSec)}
                onChange={(v) =>
                  set('asr', { timeoutSec: Math.max(5, Number(v) || 60) })
                }
              />
            </Field>
          </div>
          <Field
            label="ASR 热词（专业行业字库）"
            hint="每行一个或用逗号分隔。GLM-ASR 等支持热词的模型会显著提升专有名词、行业术语的识别准确率（最多 100 个）"
          >
            <TextArea
              rows={3}
              value={cfg.asr.hotwords}
              onChange={(hotwords) => set('asr', { hotwords })}
              placeholder={'Kubernetes\nRedux Toolkit\n向量数据库'}
            />
          </Field>
        </>
      )}

      {isLocal && (
        <>
          <Field
            label="本地模型"
            hint="首次下载需联网（Whisper 走镜像、Qwen3-ASR 走 HuggingFace 官方源直连），之后识别过程完全离线、数据不出本机"
          >
            <div className="space-y-2">
              {localModels.map((m) => {
                const selected = cfg.asr.localModel === m.id;
                const prog = progress[m.id];
                const busy = downloading === m.id;
                const isQwen = m.kind === 'qwen';
                return (
                  <div
                    key={m.id}
                    onClick={() => {
                      set('asr', { localModel: m.id });
                      setConfirmDel(null);
                    }}
                    className={`cursor-pointer rounded-xl border px-3.5 py-3 transition ${
                      selected
                        ? isQwen
                          ? 'border-violet-500/70 bg-violet-500/[0.08]'
                          : 'border-sky-500/70 bg-sky-500/[0.08]'
                        : 'border-white/[0.07] bg-black/20 hover:border-white/20'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 transition ${
                          selected
                            ? isQwen
                              ? 'border-violet-400 bg-violet-400 shadow-[0_0_8px_rgba(167,139,250,0.6)]'
                              : 'border-sky-400 bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.6)]'
                            : 'border-slate-600'
                        }`}
                        aria-hidden
                      />
                      <span className="text-[13px] font-medium text-slate-200">
                        {m.name}
                      </span>
                      {isQwen && (
                        <span className="rounded-full border border-violet-400/30 bg-violet-400/10 px-1.5 py-0.5 text-[9.5px] text-violet-300">
                          新一代
                        </span>
                      )}
                      <span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                        {fmtSize(m.sizeMb)}
                      </span>
                      {isQwen && m.downloaded && (
                        <span
                          className={`rounded-full border px-1.5 py-0.5 text-[9.5px] ${
                            m.runtimeReady
                              ? 'border-white/10 bg-white/[0.04] text-slate-400'
                              : 'border-amber-400/30 bg-amber-400/10 text-amber-300'
                          }`}
                        >
                          {m.runtimeReady
                            ? `llama.cpp · ${m.backend === 'vulkan' ? 'GPU 加速' : 'CPU'}`
                            : '运行时缺失 · 点下载补全'}
                        </span>
                      )}
                      <span className="ml-auto flex shrink-0 items-center gap-1.5">
                        {m.downloaded ? (
                          <>
                            <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[10.5px] text-emerald-300">
                              已就绪 ✓
                            </span>
                            <button
                              type="button"
                              disabled={downloading !== null}
                              onClick={(e) => {
                                e.stopPropagation();
                                void onDelete(m.id);
                              }}
                              title="删除已下载的模型文件，释放磁盘空间"
                              className={`rounded-md px-1.5 py-1 text-[11px] transition disabled:opacity-50 ${
                                confirmDel === m.id
                                  ? 'bg-red-500/15 text-red-300'
                                  : 'text-slate-500 hover:bg-white/10 hover:text-slate-300'
                              }`}
                            >
                              {confirmDel === m.id ? '确认删除？' : '🗑'}
                            </button>
                          </>
                        ) : busy ? (
                          <span className="text-[11px] text-sky-400">下载中…</span>
                        ) : (
                          <button
                            type="button"
                            disabled={downloading !== null}
                            onClick={(e) => {
                              e.stopPropagation();
                              void onDownload(m.id);
                            }}
                            className="rounded-md px-2 py-1 text-[11px] text-sky-400 transition hover:bg-sky-500/10 hover:text-sky-300 disabled:opacity-50"
                          >
                            ↓ 下载
                          </button>
                        )}
                      </span>
                    </div>
                    <div className="mt-1 pl-[26px] text-[11px] leading-4 text-slate-500">
                      {m.desc}
                    </div>
                    {busy && prog && (
                      <div className="anim-rise mt-2 pl-1">
                        <div className="mb-1 flex justify-between font-mono text-[10px] text-slate-500">
                          <span className="truncate">{prog.file}</span>
                          <span>
                            {fmtBytes(prog.downloaded)}
                            {prog.total > 0 ? ` / ${fmtBytes(prog.total)}` : ''}
                          </span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-slate-800">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-sky-500 to-indigo-400 transition-all"
                            style={{
                              width: `${
                                prog.total > 0
                                  ? Math.min(100, (prog.downloaded / prog.total) * 100)
                                  : 0
                              }%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Field>
          <Field
            label="下载镜像"
            hint="仅作用于 Whisper 系列模型；Qwen3-ASR 始终从 HuggingFace 官方源直连下载"
          >
            <Select
              value={cfg.asr.mirror}
              onChange={(mirror) => set('asr', { mirror })}
              options={[
                { value: 'https://hf-mirror.com', label: 'hf-mirror.com（国内镜像）' },
                { value: 'https://huggingface.co', label: 'huggingface.co（官方）' },
              ]}
            />
          </Field>
          <div className="rounded-lg border border-sky-500/15 bg-sky-500/[0.05] px-3.5 py-2.5 text-[11.5px] leading-5 text-sky-200/70">
            💡 本地模式零联网、零
            Key，语音数据不出本机。中文准确率可再搭配 AI 优化（支持本地
            Ollama，见「AI 优化」页）进一步提升。
            <br />
            ⚡ Qwen3-ASR：引擎在首次识别时自动启动（加载约 3GB
            模型需十几秒），之后常驻秒级响应；有显卡自动走 Vulkan
            加速，失败自动回退 CPU。
            <br />
            🐢 Whisper 系列推理速度取决于构建：安装版约为实时的一半；tauri dev
            调试模式会慢 10 倍以上。
          </div>
        </>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="识别语言"
          hint="中文语音建议固定「中文」：本地模型会自动引导输出简体中文，避免繁体与语言误判"
        >
          <Select
            value={cfg.asr.language}
            onChange={(language) => set('asr', { language })}
            options={[
              { value: 'auto', label: '自动检测' },
              { value: 'zh', label: '中文' },
              { value: 'en', label: '英语' },
              { value: 'ja', label: '日语' },
              { value: 'ko', label: '韩语' },
            ]}
          />
        </Field>
      </div>

      <Toggle
        checked={cfg.asr.stripFillers}
        onChange={(stripFillers) => set('asr', { stripFillers })}
        label="清理语气词"
        desc="自动去除「嗯 / 呃 / yeah」等口头语气词与呼吸声幻听，输出更干净"
      />

      <Toggle
        checked={cfg.asr.streaming}
        onChange={(streaming) => set('asr', { streaming })}
        label="边说边出字（流式分段）"
        desc="说话时按停顿自动分段识别，悬浮窗实时滚动字幕；云端与本地引擎通用"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={run} disabled={test.loading}>
          {test.loading ? (
            <>
              <Spinner size={13} /> 测试中…
            </>
          ) : (
            '测试连接'
          )}
        </Button>
        {test.msg && (
          <span
            className={`text-xs leading-5 ${test.ok ? 'text-emerald-300' : 'text-red-300'}`}
          >
            {test.msg}
          </span>
        )}
      </div>
    </Section>
  );
}

/* ============ AI 优化 ============ */
const LLM_PRESETS = [
  {
    value: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6',
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  {
    value: 'kimi',
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-0905-preview',
  },
  {
    value: 'ollama',
    label: 'Ollama 本地（免 Key，推荐小模型 qwen3:4b）',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3:4b',
  },
  {
    value: 'lmstudio',
    label: 'LM Studio 本地（免 Key）',
    baseUrl: 'http://localhost:1234/v1',
    model: '',
  },
  {
    value: 'llamacpp',
    label: 'llama.cpp server 本地（免 Key）',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: '',
  },
  {
    value: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  {
    value: 'custom',
    label: '自定义（任意 OpenAI 兼容接口）',
    baseUrl: '',
    model: '',
  },
];

export function LlmTab({ cfg, set, toast }: TabProps) {
  const [test, setTest] = useState<{ loading: boolean; ok?: boolean; msg?: string }>({
    loading: false,
  });
  const [modelList, setModelList] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const preset =
    LLM_PRESETS.find((p) => p.baseUrl !== '' && p.baseUrl === cfg.llm.baseUrl)?.value ??
    'custom';

  const run = async () => {
    setTest({ loading: true });
    try {
      setTest({ loading: false, ok: true, msg: await testLlm(cfg.llm) });
    } catch (e) {
      setTest({ loading: false, ok: false, msg: String(e) });
    }
  };

  const fetchModels = async () => {
    setFetching(true);
    try {
      const list = await listLlmModels(cfg.llm.baseUrl, cfg.llm.apiKey);
      setModelList(list);
      toast(`发现 ${list.length} 个模型，可在「模型名称」中选择`);
    } catch (e) {
      toast(String(e));
    } finally {
      setFetching(false);
    }
  };

  return (
    <Section
      icon="✨"
      title="AI 纠错与优化"
      desc="转写结果先经大模型纠正错字、标点与术语，再输入目标输入框，准确率大幅提升。"
    >
      <Toggle
        checked={cfg.llm.enabled}
        onChange={(enabled) => set('llm', { enabled })}
        label="启用 AI 优化"
        desc="关闭后直接输出原始转写（更快）；快速键也可按次临时跳过"
      />
      {cfg.llm.enabled && (
        <>
          <Field label="服务商预设">
            <Select
              value={preset}
              onChange={(v) => {
                const p = LLM_PRESETS.find((x) => x.value === v);
                if (!p) return;
                set('llm', {
                  baseUrl: p.baseUrl || cfg.llm.baseUrl,
                  model: p.model || cfg.llm.model,
                });
              }}
              options={LLM_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="接口地址 Base URL">
              <TextInput
                mono
                value={cfg.llm.baseUrl}
                onChange={(baseUrl) => set('llm', { baseUrl })}
                placeholder="https://open.bigmodel.cn/api/paas/v4"
              />
            </Field>
            <Field
              label="模型名称"
              hint={
                modelList
                  ? `发现 ${modelList.length} 个模型，输入框可下拉选择`
                  : '点右侧按钮可自动获取本机/云端模型列表'
              }
            >
              <div className="flex gap-2">
                <input
                  list="llm-model-list"
                  value={cfg.llm.model}
                  spellCheck={false}
                  onChange={(e) => set('llm', { model: e.target.value })}
                  placeholder="glm-4.6 / qwen3:4b / deepseek-chat …"
                  className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-sky-500/60 focus:ring-2 focus:ring-sky-500/15"
                />
                <Button onClick={fetchModels} disabled={fetching}>
                  {fetching ? <Spinner size={13} /> : '⟳'}
                </Button>
              </div>
              <datalist id="llm-model-list">
                {(modelList ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
          </div>
          <Field label="API Key">
            <TextInput
              type="password"
              mono
              value={cfg.llm.apiKey}
              onChange={(apiKey) => set('llm', { apiKey })}
              placeholder="sk-…（与 ASR 相同厂商时可填同一个）"
            />
          </Field>
          <Field label="优化模式">
            <Segmented
              value={cfg.llm.mode}
              onChange={(mode) => set('llm', { mode })}
              options={[
                { value: 'correct', label: '仅纠错', desc: '修错别字/标点，保留口语原貌' },
                { value: 'polish', label: '纠错 + 润色', desc: '整理为通顺书面表达' },
                { value: 'prompt', label: '优化为编程提示词', desc: '整理成给 Codex/AI 的指令' },
              ]}
            />
          </Field>
          <Field
            label="术语表（纠错词库）"
            hint="纠正结果会优先采用以下写法，适合团队黑话、项目代号、专业名词"
          >
            <TextArea
              rows={3}
              value={cfg.llm.glossary}
              onChange={(glossary) => set('llm', { glossary })}
              placeholder={'Tauri\n低代码平台\n增量训练'}
            />
          </Field>
          <Field
            label="自定义处理指令（可选）"
            hint="用 {text} 代表原始转写文本；留空使用内置指令。例如：把 {text} 翻译成英文后输出"
          >
            <TextArea
              rows={2}
              value={cfg.llm.customPrompt}
              onChange={(customPrompt) => set('llm', { customPrompt })}
              placeholder="{text}"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={run} disabled={test.loading}>
              {test.loading ? (
                <>
                  <Spinner size={13} /> 测试中…
                </>
              ) : (
                '测试连接'
              )}
            </Button>
            {test.msg && (
              <span
                className={`text-xs leading-5 ${test.ok ? 'text-emerald-300' : 'text-red-300'}`}
              >
                {test.msg}
              </span>
            )}
          </div>
        </>
      )}
    </Section>
  );
}

/* ============ 输出 ============ */
export function OutputTab({ cfg, set }: TabProps) {
  const [elevated, setElevated] = useState<boolean | null>(null);
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    isElevated()
      .then(setElevated)
      .catch(() => setElevated(null));
  }, []);

  return (
    <Section
      icon="⌨"
      title="文字输入方式"
      desc="识别完成后，文字如何进入 Codex / ZCode 等目标输入框。"
    >
      <Field label="输入方式">
        <Segmented
          value={cfg.output.method}
          onChange={(method) => set('output', { method })}
          options={[
            {
              value: 'clipboard',
              label: '剪贴板粘贴（推荐）',
              desc: '瞬时完成，支持中文与多行文本',
            },
            {
              value: 'typing',
              label: '模拟键盘逐字输入',
              desc: '不占用剪贴板，长文本较慢',
            },
          ]}
        />
      </Field>
      <Field
        label="运行权限"
        hint="终端 / PowerShell 若以管理员身份运行，系统（UIPI）会阻止普通权限程序向其粘贴或键入；SpeakNow 需同样以管理员运行才能输入"
      >
        <div className="flex flex-wrap items-center gap-3">
          {elevated ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1.5 text-[12px] text-emerald-300">
              ✓ 已以管理员身份运行 · 可向管理员窗口输入
            </span>
          ) : (
            <>
              <Button
                kind="primary"
                disabled={restarting}
                onClick={() => {
                  setRestarting(true);
                  restartElevated().catch(() => setRestarting(false));
                }}
              >
                {restarting ? '正在请求提权…' : '🛡 以管理员身份重启'}
              </Button>
              <span className="text-[11px] text-slate-500">
                会弹出 UAC 确认；热键、配置与悬浮窗均保持不变
              </span>
            </>
          )}
        </div>
      </Field>
      {cfg.output.method === 'clipboard' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="粘贴按键" hint="自动模式：Windows Terminal / WSL 等用 Ctrl+Shift+V，传统控制台用 Shift+Insert，其余窗口用 Ctrl+V；终端键入模式不依赖任何粘贴快捷键">
            <Select
              value={cfg.output.pasteKey}
              onChange={(pasteKey) =>
                set('output', { pasteKey: pasteKey as Config['output']['pasteKey'] })
              }
              options={[
                { value: 'auto', label: '自动（推荐 · 按窗口类型智能选择）' },
                {
                  value: 'terminal-typing',
                  label: '终端键入 · 其余粘贴（右键粘贴类终端推荐）',
                },
                { value: 'ctrl+v', label: 'Ctrl + V（macOS 为 ⌘V）' },
                { value: 'ctrl+shift+v', label: 'Ctrl + Shift + V（终端风格）' },
                { value: 'shift+insert', label: 'Shift + Insert（传统控制台）' },
              ]}
            />
          </Field>
          <div className="flex items-end">
            <Toggle
              checked={cfg.output.restoreClipboard}
              onChange={(restoreClipboard) => set('output', { restoreClipboard })}
              label="输入后还原剪贴板"
              desc="保留你之前复制的内容"
            />
          </div>
        </div>
      )}
      <Toggle
        checked={cfg.output.autoPaste}
        onChange={(autoPaste) => set('output', { autoPaste })}
        label="自动输入到当前光标处"
        desc="关闭后只复制到剪贴板，由你手动粘贴"
      />
      {cfg.output.autoPaste && (
        <Toggle
          checked={cfg.output.review}
          onChange={(review) => set('output', { review })}
          label="输入前确认"
          desc="结果先显示在悬浮窗中，可修改或重新优化：Enter 输入 · Esc 取消"
        />
      )}
      <Toggle
        checked={cfg.output.autoSubmit}
        onChange={(autoSubmit) => set('output', { autoSubmit })}
        label="输入后自动按回车提交"
        desc="配合 Codex / ZCode 可实现「说完即发送」；终端类应用请谨慎开启"
      />
    </Section>
  );
}

/* ============ 外接显示 ============ */
export function DisplayTab({ cfg, set, toast }: TabProps) {
  const [st, setSt] = useState<DisplayStatus | null>(null);

  // 服务状态轮询：配置保存后端口/启停会变化，3 秒刷新足够跟手
  useEffect(() => {
    const refresh = () => displayStatus().then(setSt).catch(() => {});
    refresh();
    const iv = setInterval(refresh, 3000);
    return () => clearInterval(iv);
  }, [cfg.externalDisplay.enabled, cfg.externalDisplay.port, cfg.externalDisplay.allowLan]);

  const ext = cfg.externalDisplay;

  return (
    <Section
      icon="📡"
      title="外接显示（硬件字幕屏）"
      desc="把聆听窗口的实时字幕推送到外接硬件——平板、树莓派、副屏电脑用浏览器打开即是一块字幕屏；也预留 WebSocket API 供自研硬件接入。"
    >
      <Toggle
        checked={ext.enabled}
        onChange={(enabled) => set('externalDisplay', { enabled })}
        label="启用外接显示 API"
        desc="本机启动轻量 HTTP + WebSocket 服务（默认端口 8866），字幕事件实时推送"
      />

      {ext.enabled && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="服务端口" hint="修改保存后服务自动重启；端口被占用会在下方提示">
              <TextInput
                mono
                value={String(ext.port)}
                onChange={(v) =>
                  set('externalDisplay', {
                    port: Math.min(65535, Math.max(1, Number(v) || 8866)),
                  })
                }
                placeholder="8866"
              />
            </Field>
            <div className="flex items-end">
              <Toggle
                checked={ext.allowLan}
                onChange={(allowLan) => set('externalDisplay', { allowLan })}
                label="允许局域网设备连接"
                desc="开启后同一网络的硬件可访问；首次可能需在 Windows 防火墙放行该端口"
              />
            </div>
          </div>

          <Toggle
            checked={ext.hideLocalOverlay}
            onChange={(hideLocalOverlay) => set('externalDisplay', { hideLocalOverlay })}
            label="外接显示时隐藏本地悬浮窗"
            desc="聆听字幕只在外接硬件上显示，本机不再弹出窗口（「输入前确认」会临时退回直接输入）"
          />

          <div className="anim-rise rounded-xl border border-white/[0.06] bg-black/20 p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] font-medium text-slate-300">
              {st?.running ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-[11px] text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
                  服务运行中 · {st.port}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-500/25 bg-slate-500/10 px-2.5 py-1 text-[11px] text-slate-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-500" aria-hidden />
                  服务未运行（保存后启动）
                </span>
              )}
              {st?.error && (
                <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] text-red-300">
                  {st.error}
                </span>
              )}
            </div>
            <div className="space-y-1.5">
              {(st?.urls ?? []).map((u) => (
                <div key={u} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg bg-black/30 px-2.5 py-1.5 font-mono text-[11.5px] text-sky-300">
                    {u}
                  </code>
                  <button
                    type="button"
                    onClick={() =>
                      copyText(u).then(
                        () => toast('已复制地址'),
                        () => toast('复制失败'),
                      )
                    }
                    className="shrink-0 rounded-md px-2 py-1 text-[11px] text-sky-400 transition hover:bg-sky-500/10 hover:text-sky-300"
                  >
                    复制
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      openDisplayPage(u).catch((e) => toast(`打开失败：${e}`))
                    }
                    className="shrink-0 rounded-md px-2 py-1 text-[11px] text-slate-400 transition hover:bg-white/10 hover:text-slate-200"
                  >
                    打开
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-2 text-[11px] leading-5 text-slate-500">
              在外接硬件的浏览器打开上面的地址即可显示字幕；页面支持
              <code className="mx-1 rounded bg-black/30 px-1 font-mono">?scale=1.5</code>
              参数整体放大字号，适配小屏设备
            </div>
          </div>

          <div className="rounded-lg border border-sky-500/15 bg-sky-500/[0.05] px-3.5 py-2.5 text-[11.5px] leading-5 text-sky-200/70">
            🔌 自研硬件接入（预留 API）：WebSocket 连接
            <code className="mx-1 rounded bg-black/30 px-1 font-mono">
              ws://&lt;本机IP&gt;:{ext.port}/api/events
            </code>
            ，事件为版本化信封
            <code className="mx-1 rounded bg-black/30 px-1 font-mono">
              {'{v, type, data, ts}'}
            </code>
            ，type 含 status / partial / raw / delta / result / level / meta，
            未知 type 请忽略（前向兼容）。字段说明见项目
            <code className="mx-1 rounded bg-black/30 px-1 font-mono">
              docs/external-display-api.md
            </code>
          </div>
        </>
      )}
    </Section>
  );
}

/* ============ 历史 ============ */
function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
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
      const d = new Date(h.ts * 1000);
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
          {filtered.map((h) => (
            <div
              key={h.ts}
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

/* ============ 关于 ============ */
export function AboutTab({ toast }: TabProps) {
  const [version, setVersion] = useState('');
  useEffect(() => {
    void appVersion().then(setVersion);
  }, []);

  const onReset = async () => {
    if (!window.confirm('确定恢复全部设置为默认值？（API Key 也会被清除）')) return;
    try {
      await resetConfig();
      toast('已恢复默认设置');
      window.location.reload();
    } catch (e) {
      toast(`重置失败：${e}`);
    }
  };

  return (
    <Section icon="ℹ️" title="关于 SpeakNow">
      <div className="flex items-center gap-4 rounded-xl border border-white/[0.06] bg-black/20 p-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-600 shadow-lg shadow-sky-500/25">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
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
        </div>
        <div>
          <div className="text-[15px] font-semibold text-slate-100">
            SpeakNow {version && <span className="ml-1 font-mono text-[12px] font-normal text-slate-500">v{version}</span>}
          </div>
          <div className="mt-0.5 text-xs leading-5 text-slate-400">
            按下快捷键，说出想法 —— 转写、纠错、输入，一步完成
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {['Tauri 2', 'React 19', 'Rust', 'Vite', 'Tailwind 4'].map((t) => (
              <span
                key={t}
                className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-400"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>

      <Field label="配置与数据" hint="API Key、模型与历史仅保存在本机，不会上传到任何服务器">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => openConfigDir().catch((e) => toast(String(e)))}>
            打开配置文件夹
          </Button>
          <Button kind="danger" onClick={onReset}>
            恢复默认设置
          </Button>
        </div>
      </Field>

      <Field
        label={`更新记录${version ? ` · 当前 v${version}` : ''}`}
        hint="完整记录见项目目录 CHANGELOG.md"
      >
        <div className="space-y-2.5">
          {[
            {
              v: 'v0.4.5',
              date: '2026-08-24',
              title: '管理员终端支持 + 麦克风选择修复',
              items: [
                '一键以管理员身份重启（悬浮窗报错处 / 设置·输出页），可向管理员终端输入',
                'UIPI 拦截报错带上目标进程名（如 WindowsTerminal.exe）',
                '麦克风选择不再「重启丢失」：已保存设备置顶显示、列表自动刷新',
                '录音设备名模糊匹配 + 缺位时回退系统默认，不再整次失败',
              ],
            },
            {
              v: 'v0.4.4',
              date: '2026-08-24',
              title: '模型吞吐观测',
              items: [
                'ASR 实时率（音频时长 / 识别耗时）入日志与悬浮窗',
                'AI 净生成速度（字/s，扣首字等待）入日志与悬浮窗',
              ],
            },
            {
              v: 'v0.4.3',
              date: '2026-08-24',
              title: '右键粘贴终端支持',
              items: [
                '终端键入模式：终端单行文本模拟键入，不依赖粘贴快捷键',
                '被新录音取代的结果自动复制到剪贴板，可手动粘贴',
              ],
            },
            {
              v: 'v0.4.2',
              date: '2026-08-24',
              title: '延迟观测',
              items: [
                '每次听写记录 识别/优化/首字/合计 耗时到 pipeline.log',
                '悬浮窗完成态新增合计耗时',
              ],
            },
            {
              v: 'v0.4.1',
              date: '2026-08-24',
              title: '终端粘贴键与语气词标点修复',
              items: [
                'WSL / Windows Terminal 自动粘贴改用 Ctrl+Shift+V',
                '语气词清理后遗留的混合标点自动收敛，句首孤悬标点清除',
              ],
            },
            {
              v: 'v0.4.0',
              date: '2026-08-24',
              title: '全链路流式体验',
              items: [
                'AI 优化流式逐字输出：结果带光标逐字打出，不等完整响应',
                '思考型模型推理过程暗色先行展示（MiMo 等）',
                '悬浮窗优化阶段重设计：流式卡片 + 原文参照',
                '识别启用「边说边出字」分段流式',
              ],
            },
            {
              v: 'v0.3.1',
              date: '2026-08-24',
              title: '录音提前结束与说话中插入修复',
              items: [
                '热键 300ms 去抖：键盘连击不再造成「话没说完就结束」',
                '粘贴前探测麦克风：正在说话时暂缓输入，旧结果不会插进新话',
                '新增 pipeline.log 链路追踪，时序问题可精确诊断',
              ],
            },
            {
              v: 'v0.3.0',
              date: '2026-08-24',
              title: '稳定性与可靠性',
              items: [
                '修复设置自动保存卡死（主线程阻塞）',
                '修复 WSL / 终端无法自动输入（智能粘贴键 + 松键等待）',
                '修复旧句子晚到插入新内容（粘贴代数守卫 + 串行化）',
                '配置原子写入 + 自动备份，强杀进程不再丢 API Key',
                '悬浮窗长文本自适应高度，可滚动阅读',
              ],
            },
            {
              v: 'v0.2.0',
              date: '2026-08',
              title: '识别引擎与效率',
              items: [
                'Qwen3-ASR 1.7B 本地离线引擎（llama.cpp · Vulkan/CPU）',
                '边说边出字（流式分段识别）、语气词清理',
                '光标跟随悬浮窗、预览编辑模式',
                '麦克风深度调校（硬件增益 / 全设备同测 / 自动校准）',
              ],
            },
            {
              v: 'v0.1.0',
              date: '2026-08',
              title: '首个版本',
              items: ['快捷键语音输入核心链路', 'MiMo / 云端 API / 本地 Whisper 三引擎', 'AI 纠错与优化（含本地 Ollama）'],
            },
          ].map((rel) => (
            <div
              key={rel.v}
              className="rounded-xl border border-white/[0.06] bg-black/20 px-3.5 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[12px] font-medium text-sky-300">{rel.v}</span>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-400">
                  {rel.title}
                </span>
                <span className="ml-auto font-mono text-[10px] text-slate-600">{rel.date}</span>
              </div>
              <ul className="mt-1.5 space-y-0.5 pl-1">
                {rel.items.map((it) => (
                  <li key={it} className="text-[11.5px] leading-5 text-slate-400">
                    · {it}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Field>

      <Field label="macOS 权限（Windows 无需配置）">
        <div className="rounded-lg border border-white/[0.06] bg-black/20 px-3.5 py-2.5 text-xs leading-6 text-slate-400">
          首次使用需在「系统设置 → 隐私与安全性」中授予：
          <br />
          · 麦克风 —— 采集音频
          <br />
          · 辅助功能 —— 模拟按键 / 剪贴板粘贴输入
        </div>
      </Field>

      <Field label="相关链接">
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
          {[
            ['智谱开放平台（GLM-ASR / GLM）', 'https://bigmodel.cn'],
            ['Groq（Whisper）', 'https://console.groq.com'],
            ['DeepSeek', 'https://platform.deepseek.com'],
            ['Tauri', 'https://tauri.app'],
          ].map(([label, url]) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 underline decoration-sky-400/30 underline-offset-2 hover:text-sky-300"
            >
              {label}
            </a>
          ))}
        </div>
      </Field>
    </Section>
  );
}
