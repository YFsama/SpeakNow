import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button, ConfirmButton, Field, Section, Segmented, TextArea, TextInput, Toggle } from '../Controls';
import { LogoBadge } from '../Logo';
import { SoundFadeLine } from '../EmptyArt';
import {
  appVersion,
  checkUpdate,
  downloadUpdate,
  exportText,
  exportTextTo,
  installUpdate,
  openConfigDir,
  openJsonDialog,
  openReleasePage,
  readTextFile,
  resetConfig,
  saveJsonDialog,
} from '../../api';
import type { Config, TabProps, UpdateInfo } from '../../types';
import { fmtBytes, releaseNotesItems } from '../../release-notes';

/* 历史更新（CHANGELOG 摘要）：默认只展开最近 2 期，其余折叠 */
const RELEASES: { v: string; date: string; title: string; items: string[] }[] = [
  {
    v: '开发中',
    date: '2026-10-18',
    title: 'GitHub 自动更新 + 配置备份升级 + AI 配置页重构',
    items: [
      'GitHub 自动更新：启动自动检查新版本，关于页一键下载并重启覆盖安装（配置与历史无损）',
      '可跳过指定版本、只提示不强制；更新面板内联展示更新日志',
      '配置备份升级：系统另存为对话框导出，可选脱敏（不含 API Key）；从文件一键导入',
      '「AI 优化」页配置区重构：生效配置摘要一目了然，模型输入统一，凭据组收纳为独立面板',
      '模型预设全面更新（2026-10）：智谱 GLM-5.3 系、DeepSeek V4、Kimi K3、GPT-5.2、Qwen-MT 全档位；模型推荐 chips 一键切换，「语音识别」页模型框常驻可改',
      '模型管理完善：停用模型（deepseek-chat 等）自动提示一键升级；模型列表切页缓存；手动输入过的模型名跨启动记忆补全',
    ],
  },
  {
    v: 'v0.4.9',
    date: '2026-10-03',
    title: '划词翻译 + 截图取词 + 本地翻译引擎 + 体验全面打磨',
    items: [
      '历史记录大升级：听写/翻译/OCR 类型筛选与图标、双栏对照、日期分组、行内编辑、按模式重优化、txt/md/json 导出、保留条数可配置；截图取词结果也入历史',
      '配置备份与迁移：一键导出/粘贴导入全部配置（含凭据组，带校验与危险值钳制）',
      '指令模板库：自定义指令存为命名模板一键套用',
      '浅色主题补齐 90+ 处交互态/文字/滑杆映射，浅色深色反馈一致',
      '悬浮窗：完成卡补字数/时长/复制/重新优化；自动复制失败如实提示；Esc 可关卡片；diff 高亮常驻',
      'Toast 三态排队、保存失败红色重试条、危险操作行内两段式确认',
      '侧栏分组 + 线性图标 + 骨架屏；主题跟随系统；统计 p50/p95、较昨日、近 7 天柱图',
      '划词翻译、截图取词 OCR、本地翻译引擎、结构化智能翻译、Ctrl+C+C（详见 CHANGELOG）',
    ],
  },
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
];

/** 导出脱敏：清空全部 Key（凭据组与内联），保留 baseUrl 等结构便于换机迁移 */
function redactConfig(cfg: Config): Config {
  return {
    ...cfg,
    providers: (cfg.providers ?? []).map((p) => ({ ...p, apiKey: '' })),
    asr: { ...cfg.asr, apiKey: '' },
    llm: { ...cfg.llm, apiKey: '' },
  };
}

/* ============ 关于 ============ */
export function AboutTab({ cfg, set, toast, updateInfo }: TabProps) {
  const [version, setVersion] = useState('');
  useEffect(() => {
    void appVersion().then(setVersion);
  }, []);

  /* ---- 更新记录折叠：默认展开最近 2 期 ---- */
  const [showAll, setShowAll] = useState(false);

  /* ---- 更新检查 / 下载 / 安装 ---- */
  // props.updateInfo：启动时已自动检查过则直接复用结果，免二次请求
  const [info, setInfo] = useState<UpdateInfo | null>(updateInfo ?? null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState('');
  const [dl, setDl] = useState<{
    busy: boolean;
    downloaded: number;
    total: number;
    /** 后端 2s 滑动窗口平均速度（B/s；0 = 尚无样本） */
    speed: number;
    /** 预计剩余秒数（总量/速度可知时才有） */
    etaSec: number | null;
    path?: string;
    err?: string;
  }>({ busy: false, downloaded: 0, total: 0, speed: 0, etaSec: null });
  const [showAllNotes, setShowAllNotes] = useState(false);

  useEffect(() => {
    // 手动下载与后台预下载共用同一组事件：进度事件置 busy，进度条对两者都生效；
    // ready 事件直接落就绪态（全局 toast 由 App.tsx 负责，这里只驱动界面）
    const un1 = listen<{
      downloaded: number;
      total: number;
      speed?: number;
      etaSec?: number | null;
      /** 失败终态（后台预下载失败也广播）：复位 busy 并给出可重试提示 */
      error?: string;
    }>('sn-update-progress', (e) => {
      // 失败终态与进度是同一事件的两种载荷：有 error 即收尾（数值字段缺省 0）
      if (e.payload.error) {
        setDl((d) => ({ ...d, busy: false, err: e.payload.error }));
        return;
      }
      setDl((d) => ({
        ...d,
        busy: true,
        err: undefined,
        downloaded: e.payload.downloaded,
        total: e.payload.total,
        speed: e.payload.speed ?? 0,
        etaSec: e.payload.etaSec ?? null,
      }));
    });
    const un2 = listen<{ version: string; path: string }>('sn-update-ready', (e) => {
      setDl((d) => ({ ...d, busy: false, path: e.payload.path, err: undefined }));
    });
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
    };
  }, []);

  const onCheck = async () => {
    setChecking(true);
    setCheckErr('');
    setDl({ busy: false, downloaded: 0, total: 0, speed: 0, etaSec: null });
    try {
      const r = await checkUpdate();
      setInfo(r);
      if (!r.updateAvailable) toast(`当前已是最新版本（v${r.latest}）`);
    } catch (e) {
      setCheckErr(String(e));
    } finally {
      setChecking(false);
    }
  };

  const onDownload = async () => {
    if (!info?.downloadUrl) return;
    setDl({ busy: true, downloaded: 0, total: info.assetSize || 0, speed: 0, etaSec: null });
    try {
      const path = await downloadUpdate(info.downloadUrl);
      setDl((d) => ({ ...d, busy: false, path }));
      toast('更新包下载完成 ✓');
    } catch (e) {
      // 后台预下载已在进行（single-flight 拒绝并发）：不打扰，进度事件接管 UI
      if (String(e).includes('正在下载')) return;
      setDl((d) => ({ ...d, busy: false, err: String(e) }));
      toast(`下载失败：${e}`, 'error');
    }
  };

  const onInstall = () => {
    if (!dl.path) return;
    // 成功路径：安装器拉起、应用退出，前端无需后续；失败 reject 正常提示
    installUpdate(dl.path).catch((e) => toast(`启动安装器失败：${e}`, 'error'));
  };

  const onSkip = () => {
    if (!info) return;
    set('general', { skipVersion: info.latest });
    toast(`已跳过 v${info.latest}，下一版本发布时再提示`);
  };

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('zh-CN');
  };

  /** B/s → 人类可读速度（下载进度行），如 12.3 MB/s */
  const fmtSpeed = (bps: number) => {
    if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
    if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
    return `${bps} B/s`;
  };

  /** 速度与剩余时间合为一行（如「12.3 MB/s · 约 40 秒」）；无样本时为空 */
  const speedText =
    dl.speed > 0
      ? ` ${fmtSpeed(dl.speed)}${
          dl.etaSec != null && dl.etaSec > 0 && dl.etaSec < 3600
            ? ` · 约 ${dl.etaSec < 60 ? `${Math.ceil(dl.etaSec)} 秒` : `${Math.ceil(dl.etaSec / 60)} 分钟`}`
            : ''
        }`
      : '';

  /* ---- 配置备份：导出 / 导入 ---- */
  const [importText, setImportText] = useState('');
  const [importErr, setImportErr] = useState('');
  const [importOk, setImportOk] = useState(false);
  const [exportMode, setExportMode] = useState<'full' | 'redact'>('full');

  /** 导入核心：JSON.parse + 基本结构校验（hotkey / asr / llm 三节齐全）→ 逐节套用。
   *  传入 text 供「从文件导入」读到内容后直接应用（state 更新是异步的）；缺省用粘贴框内容 */
  const applyImport = (source?: string) => {
    const text = source ?? importText;
    setImportText(text);
    setImportErr('');
    setImportOk(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setImportErr('不是合法的 JSON：请粘贴完整、未截断的备份内容');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setImportErr('结构不符：应为配置对象（含 hotkey / asr / llm 等节）');
      return;
    }
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.hotkey !== 'object' ||
      typeof obj.asr !== 'object' ||
      typeof obj.llm !== 'object'
    ) {
      setImportErr('缺少必要配置节（hotkey / asr / llm）：请确认粘贴的是 SpeakNow 导出的备份');
      return;
    }
    /* 逐节过安全闸：类型错误字段会造成「保存失败循环」，危险值（缩放/容量）
       会立即生效且难自救，导入前逐项校验/钳制 */
    const bad: string[] = [];
    const asSection = (v: unknown): Record<string, unknown> => {
      if (typeof v !== 'object' || v === null) return {};
      return v as Record<string, unknown>;
    };
    // providers 必须是数组且元素含 id/name 字符串
    if (obj.providers !== undefined) {
      if (!Array.isArray(obj.providers)) bad.push('providers 应为数组');
      else if (
        obj.providers.some(
          (p) =>
            typeof p !== 'object' ||
            p === null ||
            typeof (p as Record<string, unknown>).id !== 'string' ||
            typeof (p as Record<string, unknown>).name !== 'string',
        )
      )
        bad.push('providers 元素缺少 id / name');
    }
    // 数值字段类型 + 危险值钳制（fontScale 直接驱动 body.zoom）
    const general = asSection(obj.general);
    if (general.fontScale !== undefined) {
      const n = Number(general.fontScale);
      if (!Number.isFinite(n)) bad.push('general.fontScale 应为数字');
      else general.fontScale = Math.min(1.3, Math.max(0.85, n));
    }
    if (general.historyLimit !== undefined) {
      const n = Number(general.historyLimit);
      if (!Number.isFinite(n)) bad.push('general.historyLimit 应为数字');
      else general.historyLimit = Math.round(Math.min(2000, Math.max(10, n)));
    }
    for (const [sec, keys] of [
      ['audio', ['vadSilenceMs', 'vadThreshold', 'maxDurationSec', 'gainDb']],
      ['asr', ['timeoutSec']],
      ['llm', ['timeoutSec']],
    ] as const) {
      const s = asSection(obj[sec]);
      for (const k of keys) {
        if (s[k] !== undefined && !Number.isFinite(Number(s[k])))
          bad.push(`${sec}.${k} 应为数字`);
      }
    }
    if (bad.length) {
      setImportErr(`备份字段异常，未应用：${bad.join('；')}`);
      return;
    }
    // 逐节套用到当前配置：providers 数组整体替换，其余节浅覆盖；
    // 备份里缺的节保持现状不动
    const backup = parsed as Config;
    if (Array.isArray(backup.providers)) set('providers', backup.providers);
    if (backup.hotkey) set('hotkey', backup.hotkey);
    if (backup.audio) set('audio', backup.audio);
    if (backup.asr) set('asr', backup.asr);
    if (backup.llm) set('llm', backup.llm);
    if (backup.translate) set('translate', backup.translate);
    if (backup.ocr) set('ocr', backup.ocr);
    if (backup.output) set('output', backup.output);
    if (backup.general) set('general', backup.general);
    if (backup.externalDisplay) set('externalDisplay', backup.externalDisplay);
    setImportOk(true);
    toast('配置已导入并应用 ✓');
  };

  const onExportFile = async () => {
    try {
      const path = await saveJsonDialog('speaknow-config-backup.json');
      if (!path) return; // 用户取消
      const payload = exportMode === 'redact' ? redactConfig(cfg) : cfg;
      const saved = await exportTextTo(path, JSON.stringify(payload, null, 2));
      toast(`配置已导出 ✓ ${saved}`);
    } catch (e) {
      toast(`导出失败：${e}`, 'error');
    }
  };

  const onImportFile = async () => {
    setImportErr('');
    setImportOk(false);
    try {
      const path = await openJsonDialog();
      if (!path) return; // 用户取消
      const text = await readTextFile(path);
      // 后端已过 .json / 体积闸，读入后立即走同一套校验并自动应用
      applyImport(text);
    } catch (e) {
      toast(`读取失败：${e}`, 'error');
    }
  };

  const onReset = async () => {
    try {
      await resetConfig();
      toast('已恢复默认设置');
      window.location.reload();
    } catch (e) {
      toast(`重置失败：${e}`);
    }
  };

  /* 更新面板（发现新版本时） */
  const notes = info ? releaseNotesItems(info.notes) : [];
  const skipped = !!info && cfg.general.skipVersion === info.latest;

  const updatePanel = info?.updateAvailable && (
    <div className="rounded-xl border border-sky-500/25 bg-sky-500/[0.05] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-[10.5px] text-sky-300">
          可更新
        </span>
        <span className="text-[13px] font-medium text-slate-100">
          v{info.current} → <span className="text-sky-300">v{info.latest}</span>
        </span>
        {info.publishedAt && (
          <span className="font-mono text-[10.5px] text-slate-500">
            {fmtDate(info.publishedAt)} 发布
          </span>
        )}
        {info.assetSize > 0 && (
          <span className="font-mono text-[10.5px] text-slate-500">
            安装包 {fmtBytes(info.assetSize)}
          </span>
        )}
        {skipped && (
          <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-300">
            已跳过此版本
          </span>
        )}
      </div>
      {notes.length > 0 && (
        <ul className="mt-2 space-y-0.5 pl-1">
          {(showAllNotes ? notes : notes.slice(0, 6)).map((it, i) => (
            <li key={i} className="text-[11.5px] leading-5 text-slate-400">
              · {it}
            </li>
          ))}
        </ul>
      )}
      {notes.length > 6 && (
        <button
          type="button"
          onClick={() => setShowAllNotes((v) => !v)}
          className="mt-1 text-[11px] text-sky-400/80 transition hover:text-sky-300"
        >
          {showAllNotes ? '收起 ▴' : `展开全部 ${notes.length} 条 ▾`}
        </button>
      )}
      {/* 下载 / 进度 / 安装：一条流线，出错就地显示 */}
      <div className="mt-3 space-y-2">
        {dl.busy ? (
          <div>
            <div className="mb-1 flex justify-between font-mono text-[10.5px] text-slate-500">
              <span>正在下载更新包…{speedText}</span>
              <span>
                {fmtBytes(dl.downloaded)}
                {dl.total > 0 ? ` / ${fmtBytes(dl.total)}` : ''}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky-500 to-indigo-400 transition-all"
                style={{
                  width: `${
                    dl.total > 0 ? Math.min(100, (dl.downloaded / dl.total) * 100) : 8
                  }%`,
                }}
              />
            </div>
          </div>
        ) : dl.path ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button kind="primary" onClick={onInstall}>
              已下载就绪 · 安装并重启 v{info.latest}
            </Button>
            <Button onClick={() => void onDownload()}>重新下载</Button>
            <span className="text-[11px] leading-4 text-slate-500">
              安装器启动后应用自动退出，覆盖安装不影响已保存的配置与历史
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              kind="primary"
              onClick={() => void onDownload()}
              disabled={!info.downloadUrl}
            >
              ↓ 下载并安装更新
            </Button>
            {!info.downloadUrl && (
              <span className="text-[11px] leading-4 text-amber-300/80">
                本平台暂无自动安装包，请到发布页手动下载
              </span>
            )}
            <Button onClick={() => void openReleasePage(info.htmlUrl).catch((e) => toast(String(e), 'error'))}>
              发布页 ↗
            </Button>
            {!skipped && (
              <button
                type="button"
                onClick={onSkip}
                className="text-[11px] text-slate-500 underline decoration-slate-600 underline-offset-2 transition hover:text-slate-300"
              >
                跳过此版本
              </button>
            )}
          </div>
        )}
        {dl.err && <div className="text-[11px] leading-4 text-red-300">{dl.err}</div>}
      </div>
    </div>
  );

  return (
    <>
    <Section icon="ℹ️" title="关于 SpeakNow">
      <div className="flex items-center gap-4 rounded-xl border border-white/[0.06] bg-black/20 p-4">
        {/* 回声涟漪徽章（渐变随主题 accent 联动）+ 下方声波渐隐装饰线 */}
        <div className="flex shrink-0 flex-col items-center gap-2.5 py-1">
          <LogoBadge size={96} />
          <SoundFadeLine />
        </div>
        <div className="min-w-0 flex-1">
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
        {/* 检查更新：与版本信息同卡，一眼可见入口 */}
        <div className="shrink-0">
          <Button onClick={() => void onCheck()} disabled={checking}>
            {checking ? '检查中…' : info?.updateAvailable ? '重新检查' : '⟳ 检查更新'}
          </Button>
        </div>
      </div>

      {/* 检查状态一行：最新 / 失败 / 未检查 */}
      {!info && !checking && !checkErr && (
        <div className="text-[11.5px] leading-5 text-slate-500">
          尚未检查更新。启动时会按下方设置自动检查，也可随时手动检查。
        </div>
      )}
      {info && !info.updateAvailable && (
        <div className="text-[11.5px] leading-5 text-emerald-300/80">
          ✓ 当前 v{info.current} 已是最新版本（GitHub 最新 v{info.latest}）
        </div>
      )}
      {checkErr && (
        <div className="text-[11.5px] leading-5 text-red-300">
          检查失败：{checkErr}（网络受限或 GitHub 限流，稍后再试）
        </div>
      )}

      {updatePanel}

      <Toggle
        checked={cfg.general.autoCheckUpdate !== false}
        onChange={(autoCheckUpdate) => set('general', { autoCheckUpdate })}
        label="自动检查更新"
        desc="启动时与之后每 6 小时查询一次 GitHub 最新版本并提示，绝不自动安装；可通过上方「跳过此版本」屏蔽特定版本"
      />

      <Toggle
        checked={cfg.general.autoDownloadUpdate !== false}
        onChange={(autoDownloadUpdate) => set('general', { autoDownloadUpdate })}
        label="发现新版本自动后台下载"
        desc="后台静默下载安装包（断点续传、失败静默重试），就绪后可到本页一键安装，或退出应用时自动安装（不自动重启）；受「自动检查更新」总开关约束"
      />

      <Field
        label="下载镜像"
        hint="直连 GitHub 慢时可填加速前缀，如 https://gh-proxy.com/；留空 = 官方直连。镜像内容仍逐字节过官方 SHA-256 校验，官方未提供校验值时自动直连"
      >
        <TextInput
          value={cfg.general.downloadMirror ?? ''}
          onChange={(downloadMirror) => set('general', { downloadMirror })}
          placeholder="https://gh-proxy.com/"
          mono
        />
      </Field>

      <Field label="配置与数据" hint="API Key、模型与历史仅保存在本机，不会上传到任何服务器">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => openConfigDir().catch((e) => toast(String(e)))}>
            打开配置文件夹
          </Button>
          <ConfirmButton
            label="恢复默认设置"
            confirmLabel="确认重置？Key 会清除"
            timeoutMs={5000}
            onConfirm={() => void onReset()}
          />
        </div>
      </Field>

      <Field
        label={`更新记录${version ? ` · 当前 v${version}` : ''}`}
        hint="完整记录见项目目录 CHANGELOG.md"
      >
        <div className="space-y-2.5">
          {RELEASES.slice(0, showAll ? undefined : 2).map((rel) => (
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
          {/* 默认只展开最近 2 期，其余折叠一键展开 */}
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="w-full rounded-lg border border-white/[0.06] bg-black/20 py-2 text-[12px] text-slate-400 transition hover:border-white/15 hover:text-slate-200"
          >
            {showAll
              ? '收起历史更新 ▴'
              : `展开全部历史更新（${RELEASES.length - 2}） ▾`}
          </button>
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

    <Section
      icon="💾"
      title="配置备份"
      desc="导出全部设置为 JSON 文件随身迁移；换机 / 重装时从文件或粘贴内容一键恢复。"
    >
      <Field
        label="导出配置"
        hint="通过系统对话框选择保存位置；完整备份含全部设置与凭据组（API Key 明文），脱敏导出适合分享给他人排查问题"
      >
        <div className="space-y-2.5">
          <Segmented
            value={exportMode}
            onChange={setExportMode}
            options={[
              { value: 'full', label: '完整备份', desc: '含 API Key，可直接恢复' },
              { value: 'redact', label: '脱敏导出', desc: '不含 Key，可分享' },
            ]}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button kind="primary" onClick={() => void onExportFile()}>
              ⬇ 另存为…
            </Button>
            <Button
              onClick={() => {
                exportText(
                  'speaknow-config-backup.json',
                  JSON.stringify(exportMode === 'redact' ? redactConfig(cfg) : cfg, null, 2),
                )
                  .then((p) => toast(`已导出到配置文件夹 ✓ ${p}`))
                  .catch((e) => toast(`导出失败：${e}`, 'error'));
              }}
            >
              导出到配置文件夹
            </Button>
            {exportMode === 'full' && (
              <span className="text-[11px] leading-4 text-red-300/90">
                ⚠ 完整备份含 API Key 明文，请妥善保管
              </span>
            )}
          </div>
        </div>
      </Field>
      <Field
        label="导入配置"
        hint="从备份文件读取或粘贴 JSON → 校验并应用；凭据组列表整体替换，备份中缺失的节保持现状"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void onImportFile()}>📂 从文件导入…</Button>
          <span className="text-[11px] text-slate-500">或直接粘贴备份内容 ↓</span>
        </div>
        <div id="import-textarea" className="mt-2">
          <TextArea
            rows={5}
            value={importText}
            onChange={(v) => {
              setImportText(v);
              setImportErr('');
              setImportOk(false);
            }}
            placeholder="在此粘贴 speaknow-config-backup.json 的完整内容…"
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button kind="primary" onClick={() => applyImport()} disabled={!importText.trim()}>
            校验并应用
          </Button>
          {importErr && (
            <span className="text-[11px] leading-4 text-red-300">{importErr}</span>
          )}
          {importOk && (
            <span className="text-[11px] leading-4 text-emerald-300">
              已应用 ✓ 部分设置（快捷键 / 开机自启等）重启后完全生效
            </span>
          )}
        </div>
      </Field>
    </Section>
    </>
  );
}
