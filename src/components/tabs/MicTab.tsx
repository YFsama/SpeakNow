import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button, Field, Section, Spinner, Toggle } from '../Controls';
import {
  autoCalibrate,
  isMac,
  micDiagnose,
  micTest,
  micTestAll,
  micHwLevels,
  micVolumeInfo,
  openMicSettings,
  setMicHwLevel,
  setMicVolume,
} from '../../api';
import type {
  DeviceScanRow,
  HwLevel,
  MicDiagnosis,
  MicVolumeInfo,
} from '../../api';
import type {
  DeviceInfo,
  MicTestResult,
  TabProps,
} from '../../types';
import { DEFAULT_DEVICE_KEY } from '../../types';

/* ============ 麦克风 ============ */
const fmtRate = (hz: number | null) =>
  hz ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)}kHz` : '';

function specText(d: DeviceInfo): string {
  const parts = [fmtRate(d.sampleRate), d.channels ? `${d.channels} 声道` : ''].filter(
    Boolean,
  );
  return parts.join(' · ') || '规格未知';
}

/** 设备键：null（系统默认模式）用固定键，其余用设备名 */
const deviceKey = (d: string | null) => d ?? DEFAULT_DEVICE_KEY;

/* 设备卡片：memo 隔离——回调以 (value) 形式传入且保持稳定引用，
  测试/电平等高频状态变化不再连带重渲染全部设备卡 */
const DeviceCard = memo(function DeviceCard({
  name,
  value,
  spec,
  isDefault,
  selected,
  onSelect,
  onQuick,
  testing,
  result,
  gainDb,
}: {
  name: string;
  /** 传给回调的设备标识（null=系统默认；展示名可能与标识不同） */
  value: string | null;
  spec: string;
  isDefault?: boolean;
  selected: boolean;
  onSelect: (value: string | null) => void;
  onQuick: (value: string | null) => void;
  testing: boolean;
  result?: MicTestResult;
  /** 该设备记忆的软件增益（dB），> 0 时展示徽章 */
  gainDb?: number;
}) {
  return (
    <div
      onClick={() => onSelect(value)}
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
        {gainDb !== undefined && gainDb > 0 && (
          <span
            title="该设备记忆的软件增益"
            className="shrink-0 rounded-full border border-sky-400/25 bg-sky-400/10 px-1.5 py-0.5 font-mono text-[10px] text-sky-300"
          >
            +{gainDb.toFixed(gainDb % 1 ? 1 : 0)}dB
          </span>
        )}
        <button
          type="button"
          disabled={testing}
          onClick={(e) => {
            e.stopPropagation();
            onQuick(value);
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
});

/* 采集中的实时电平条：独立子组件持有 sn-mic-level 监听（约 20Hz），
   电平跳动只重渲染这一排条，不再带动整个麦克风页重渲染 */
function LiveBars() {
  const [live, setLive] = useState<number[]>(() => Array(44).fill(0));
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
  return (
    <div className="flex h-8 items-center gap-[2px]">
      {live.map((v, i) => (
        <span
          key={i}
          className="flex-1 rounded-full bg-gradient-to-t from-sky-500/80 to-indigo-400/80 transition-[height] duration-75"
          style={{ height: `${Math.max(4, v * 30)}px`, opacity: 0.4 + v * 0.6 }}
        />
      ))}
    </div>
  );
}

/* 全设备并发采集的实时电平行：独立子组件持有 sn-mic-level-all 监听 */
function AllLiveBars() {
  const [allLive, setAllLive] = useState<Record<string, number>>({});
  useEffect(() => {
    const un = listen<Record<string, number>>('sn-mic-level-all', (e) => {
      setAllLive(e.payload);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);
  return (
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
  const [fullResult, setFullResult] = useState<MicTestResult | null>(null);
  const [playing, setPlaying] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<MicDiagnosis | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanRows, setScanRows] = useState<DeviceScanRow[] | null>(null);
  const [sysVol, setSysVol] = useState<MicVolumeInfo | null>(null);
  const [hwLevels, setHwLevels] = useState<HwLevel[] | null>(null);

  // 异步回调（自动校准等）里读取最新配置，避免闭包拿到过期值
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  // 写入当前所选设备的增益（滑杆 / 校准共用），同步映射表
  const setGainDb = (db: number) => {
    const cur = cfgRef.current;
    if (!cur) return;
    set('audio', {
      gainDb: db,
      gainDbByDevice: {
        ...(cur.audio.gainDbByDevice ?? {}),
        [deviceKey(cur.audio.device)]: db,
      },
    });
  };

  // 新设备首次选用：后台自动校准一次增益（需用户对着麦克风说话）
  const calibrateFirstUse = useCallback(
    async (name: string | null) => {
      const label = name ?? '系统默认';
      toast(`「${label}」首次使用，自动校准增益中——请对麦克风说几句话`);
      try {
        const r = await autoCalibrate(name);
        const cur = cfgRef.current;
        if (!cur || cur.audio.device !== name) return; // 校准期间又切走了
        if (r.suggestedDb == null) {
          toast('未检测到足够信号，暂不校准；录音时自动增益仍会按需提升');
          return;
        }
        set('audio', {
          gainDb: r.suggestedDb,
          gainDbByDevice: {
            ...(cur.audio.gainDbByDevice ?? {}),
            [deviceKey(name)]: r.suggestedDb,
          },
        });
        toast(`「${label}」增益已自动校准为 ${r.suggestedDb}dB（按设备记忆）`);
      } catch {
        // 校准失败不阻塞选用；录音期 AGC 仍会兜底
      }
    },
    [set, toast],
  );

  // 切换设备：先把当前增益记到当前设备名下，再换入新设备记忆的增益；
  // 新设备无记忆且开了自动增益时后台校准一次
  const selectDevice = useCallback(
    (name: string | null) => {
      const cur = cfgRef.current;
      if (!cur || name === cur.audio.device) return;
      const byDev = { ...(cur.audio.gainDbByDevice ?? {}) };
      byDev[deviceKey(cur.audio.device)] = cur.audio.gainDb;
      const stored = byDev[deviceKey(name)];
      set('audio', {
        device: name,
        gainDb: stored ?? 0,
        gainDbByDevice: byDev,
      });
      const label = name ?? '系统默认';
      if (stored !== undefined) {
        toast(`已切换到「${label}」· 增益 ${stored}dB（按设备记忆）`);
      } else if (cur.audio.autoGain !== false) {
        void calibrateFirstUse(name);
      } else {
        toast(`已切换到「${label}」，增益从 0dB 起步`);
      }
    },
    [set, toast, calibrateFirstUse],
  );

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

  const quick = useCallback(
    async (name: string | null) => {
      setQuickTesting(name);
      try {
        // 用该设备自己记忆的增益测试（无记忆则 0dB），不套用当前所选设备的增益
        const r = await micTest(
          name,
          false,
          cfgRef.current.audio.gainDbByDevice?.[deviceKey(name)] ?? 0,
        );
        setQuickResult((p) => ({ ...p, [name ?? '']: r }));
        if (r.avgLevel < 3)
          toast(`「${name ?? '系统默认'}」电平过低：可尝试下方「自动校准增益」`);
      } catch (e) {
        toast(`测试失败：${e}`);
      } finally {
        setQuickTesting(undefined);
      }
    },
    [toast],
  );

  const full = async () => {
    setFullTesting(true);
    setFullResult(null);
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
          isMac
            ? '几乎检测不到信号：请检查 系统设置 → 隐私与安全性 → 麦克风 是否允许 SpeakNow、系统设置 → 声音 → 输入 音量是否为 0、以及耳机是否被硬件静音'
            : '几乎检测不到信号：请检查 Windows 设置 → 系统 → 声音 → 输入 音量是否为 0、耳机是否硬件静音、以及 隐私和安全性 → 麦克风 是否允许桌面应用',
        );
      } else {
        setGainDb(r.suggestedDb);
        toast(
          `原始峰值 ${r.peakPercent.toFixed(0)}%，已为「${
            cfg.audio.device ?? '系统默认'
          }」设置增益 ${r.suggestedDb}dB（按设备记忆，保存后生效）`,
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

  const scan = async () => {
    setScanning(true);
    setScanRows(null);
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
              {isMac && diagnosis.systemPrivacy.toLowerCase() === 'unknown' ? (
                <span className="text-slate-400">
                  macOS 请在 系统设置 → 隐私与安全性 → 麦克风 中确认已允许 SpeakNow
                </span>
              ) : (
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
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-slate-500">本应用授权</span>
              {isMac ? (
                <span className="text-slate-400">
                  首次使用时系统会弹窗询问；若曾拒绝，可在 隐私与安全性 → 麦克风 中重新开启
                </span>
              ) : (
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
              )}
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
              打开{isMac ? 'macOS' : 'Windows'}麦克风设置
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
          <AllLiveBars />
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
                        onClick={() => selectDevice(row.name)}
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
          <LiveBars />
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
              {isMac ? (
                <>
                  2. 系统设置 → 声音 → 输入：把输入音量拉到 80–100
                  <br />
                  3. 系统设置 → 隐私与安全性 → 麦克风：确认允许 SpeakNow
                  <br />
                  4. 确认耳机没有硬件静音（如麦克风孔/线控开关）
                </>
              ) : (
                <>
                  2. Windows 设置 → 系统 → 声音 → 输入：把输入音量拉到 80–100
                  <br />
                  3. Windows 设置 → 隐私和安全性 → 麦克风：允许桌面应用访问
                  <br />
                  4. 确认耳机没有硬件静音（如麦克风孔/线控开关）
                </>
              )}
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
            value={null}
            spec="跟随操作系统当前选择的输入设备"
            selected={!cfg.audio.device}
            onSelect={selectDevice}
            onQuick={quick}
            testing={quickTesting === null}
            result={quickResult['']}
            gainDb={cfg.audio.gainDbByDevice?.[DEFAULT_DEVICE_KEY]}
          />
          {devices.map((d) => (
            <DeviceCard
              key={d.name}
              name={d.name}
              value={d.name}
              spec={specText(d)}
              isDefault={d.isDefault}
              selected={cfg.audio.device === d.name}
              onSelect={selectDevice}
              onQuick={quick}
              testing={quickTesting === d.name}
              result={quickResult[d.name]}
              gainDb={cfg.audio.gainDbByDevice?.[d.name]}
            />
          ))}
          {/* 已保存但当前未枚举到的设备（无线接收器休眠/重枚举/刚重启）：
              置顶展示保留选择，设备就绪后自动恢复，避免看起来像配置丢失 */}
          {cfg.audio.device &&
            !devices.some((d) => d.name === cfg.audio.device) && (
              <DeviceCard
                name={cfg.audio.device}
                value={cfg.audio.device}
                spec="已保存 · 当前未检测到，设备就绪后自动恢复使用（录音会临时走系统默认）"
                selected
                onSelect={selectDevice}
                onQuick={quick}
                testing={quickTesting === cfg.audio.device}
                gainDb={cfg.audio.gainDbByDevice?.[cfg.audio.device]}
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
        label={`麦克风增益（软件）· ${cfg.audio.device ?? '系统默认'}：${cfg.audio.gainDb.toFixed(
          1,
        )} dB / 上限 45dB`}
        hint="每个设备独立记忆：切换麦克风自动换入对应增益。原始信号弱（无线耳机常见）时拉高；信号峰值到 40–70% 即可，过大可能放大底噪。增益本身不损失音质（上限内自动防削波）"
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={45}
            step={0.5}
            value={cfg.audio.gainDb}
            onChange={(e) => setGainDb(Number(e.target.value))}
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
          校准方式：对麦克风正常说几句话（2.6 秒），自动将峰值校准到 ~60%，结果按当前设备记忆
        </div>
      </Field>

      <Toggle
        checked={cfg.audio.autoGain !== false}
        onChange={(autoGain) => set('audio', { autoGain })}
        label="录音时自动增益（AGC）"
        desc="输入过小且确有语音时自动提升、接近削波时回落；学到的增益按设备记忆，下次录音直接生效，不再重复爬升"
      />

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
