import { useEffect, useState } from 'react';
import { Button, ConfirmButton, Field, Section, TextArea } from '../Controls';
import { appVersion, exportText, openConfigDir, resetConfig } from '../../api';
import type { Config, TabProps } from '../../types';

/* 历史更新（CHANGELOG 摘要）：默认只展开最近 2 期，其余折叠 */
const RELEASES: { v: string; date: string; title: string; items: string[] }[] = [
  {
    v: '开发中',
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

/* ============ 关于 ============ */
export function AboutTab({ cfg, set, toast }: TabProps) {
  const [version, setVersion] = useState('');
  useEffect(() => {
    void appVersion().then(setVersion);
  }, []);

  /* ---- 更新记录折叠：默认展开最近 2 期 ---- */
  const [showAll, setShowAll] = useState(false);

  /* ---- 配置备份：导出 / 粘贴导入 ---- */
  const [importText, setImportText] = useState('');
  const [importErr, setImportErr] = useState('');
  const [importOk, setImportOk] = useState(false);

  const onExport = async () => {
    try {
      await exportText('speaknow-config-backup.json', JSON.stringify(cfg, null, 2));
      toast('配置备份已导出 ✓');
    } catch (e) {
      toast(`导出失败：${e}`);
    }
  };

  /** 导入：JSON.parse + 基本结构校验（hotkey / asr / llm 三节齐全）→ 逐节套用 */
  const onImport = () => {
    setImportErr('');
    setImportOk(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
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

  const onReset = async () => {
    try {
      await resetConfig();
      toast('已恢复默认设置');
      window.location.reload();
    } catch (e) {
      toast(`重置失败：${e}`);
    }
  };

  return (
    <>
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
      desc="导出全部设置为 JSON 文件随身迁移；换机 / 重装时粘贴备份内容一键恢复。"
    >
      <Field label="导出配置" hint="含全部页面的设置与凭据组，可在另一台机器导入恢复">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void onExport()}>⬇ 导出配置 JSON</Button>
          <span className="text-[11px] leading-4 text-red-300/90">
            ⚠ 备份含 API Key 明文，请妥善保管
          </span>
        </div>
      </Field>
      <Field
        label="导入配置"
        hint="粘贴备份 JSON → 校验并应用；凭据组列表整体替换，备份中缺失的节保持现状"
      >
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
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button kind="primary" onClick={onImport} disabled={!importText.trim()}>
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
