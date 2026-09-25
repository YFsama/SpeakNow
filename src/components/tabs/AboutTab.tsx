import { useEffect, useState } from 'react';
import { Button, Field, Section } from '../Controls';
import { appVersion, openConfigDir, resetConfig } from '../../api';
import type { TabProps } from '../../types';

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
              v: '开发中',
              date: '2026-08-27',
              title: '优化润色可用度 + 流式补全',
              items: [
                '审阅窗口「重新优化」流式逐字回填，可临时切换模式，新增「恢复原文」',
                '三种优化模式提示词重写：保留原意细节、标点与中英文间距、技术细节原样保留',
                '自定义指令改用中性系统提示，翻译/改写类指令不再与模式指令冲突',
                '流式 SSE 按行解析：修复中文跨网络分块被截成乱码的隐患',
                '思考型模型 <think> 推理混入正文时自动剥离；长文本上限 4096 → 8192',
                '优化期间开始新录音：立即中止旧请求并跳过，不浪费流量',
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
