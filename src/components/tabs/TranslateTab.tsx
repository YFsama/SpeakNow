import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button, Field, Section, Segmented, Select, Spinner, TextArea, Toggle } from '../Controls';
import {
  copyText,
  deleteBuiltin,
  downloadBuiltin,
  isMac,
  shortcutChips,
  translateSelection,
  translateText,
} from '../../api';
import type { TabProps } from '../../types';
import { TRANSLATE_LANGS, langName, resolvedLlmCreds } from '../../types';

/* ============ 翻译 ============ */
const fmtSize = (mb: number) =>
  mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`;

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

/** 轻量结构预检（仅界面提示；权威判定在后端 trans_struct::split） */
function detectStructured(text: string): string | null {
  const t = text.trim();
  if (t.length < 2) return null;
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      JSON.parse(t);
      return 'JSON';
    } catch {
      /* 不是合法 JSON，继续按行判断 */
    }
  }
  const lines = t
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l !== '---' && l !== '...');
  if (lines.length < 3) return null;
  const mapping = lines.filter((l) => /^-?\s*[^:#[\]{}"']+:($|\s)/.test(l) || /^-\s+\S/.test(l)).length;
  const eq = lines.filter((l) => /^[A-Za-z_.][\w.[\]-]*\s*=/.test(l)).length;
  if (eq >= 3 && eq > mapping && eq / lines.length >= 0.7) return '键值';
  if (mapping >= 3 && mapping / lines.length >= 0.7) return 'YAML';
  return null;
}

export function TranslateTab({ cfg, set, toast, navigate, localModels, refreshLocalModels }: TabProps) {
  /* ---- 输入翻译工作台 ---- */
  const [input, setInput] = useState('');
  const [result, setResult] = useState('');
  const [stream, setStream] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /* 流式增量只在「本工作台自己的请求」期间累计（事件频道与听写/划词共用） */
  const busyRef = useRef(false);
  /* 结果区粘性滚动：流式输出自动跟到底部；用户上滚阅读后停止跟随，滚回底部恢复 */
  const resultRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = resultRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight - el.clientHeight;
  }, [stream, result]);

  /* ---- 本地翻译引擎：模型下载进度 / 删除（与语音识别页同一套事件） ---- */
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

  const onDownloadModel = async (id: string) => {
    setDownloading(id);
    setConfirmDel(null);
    try {
      await downloadBuiltin(id, cfg.asr.mirror);
      toast(`本地翻译模型下载完成 ✓`);
    } catch (e) {
      toast(`下载失败：${e}`);
    } finally {
      setDownloading(null);
      refreshLocalModels();
    }
  };

  const onDeleteModel = async (id: string) => {
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

  useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDel]);

  const llmModels = localModels.filter((m) => m.kind === 'llm');

  // macOS 无 llama.cpp sidecar，本地翻译引擎仅 Windows：旧配置/多端同步可能带着
  // engine=local 进来，检测到即自动回落云端并提示一次（回落写入后条件不再成立）
  useEffect(() => {
    if (isMac && cfg.translate.engine === 'local') {
      set('translate', { engine: 'cloud' });
      toast('本地翻译引擎仅支持 Windows，已切换回云端模型');
    }
  }, [cfg.translate.engine, set, toast]);

  useEffect(() => {
    const un = listen<{ kind: string; delta?: string; text?: string }>('sn-llm-delta', (e) => {
      if (!busyRef.current || e.payload.kind !== 'content' || e.payload.text === undefined)
        return;
      setStream(e.payload.text);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const run = async () => {
    const text = input.trim();
    if (!text || busy) return;
    busyRef.current = true;
    setBusy(true);
    setErr('');
    setStream('');
    setResult('');
    try {
      const t = await translateText(text, cfg.llm.translateTarget || 'en');
      setResult(t);
    } catch (e) {
      setErr(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const selChips = shortcutChips(cfg.hotkey.keyTranslateSel);
  const target = cfg.llm.translateTarget || 'en';
  // 凭据组迁移后内联 baseUrl 为空：按解析后的生效凭据判断；
  // 本地引擎只看模型是否已下载
  const llmReady =
    cfg.translate.engine === 'local'
      ? llmModels.some((m) => m.downloaded)
      : cfg.llm.enabled && !!resolvedLlmCreds(cfg).baseUrl.trim();

  return (
    <>
      <Section
        icon="🌐"
        title="划词翻译"
        desc="在任意应用里选中文字按热键：贴近选区弹出翻译卡片，流式出字，可复制或一键替换原文。经 AI 完成，模型与「AI 优化」共用。"
      >
        <div className="rounded-xl border border-white/[0.07] bg-black/20 p-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-[12.5px] font-medium text-slate-300">
              {selChips.length > 0 ? '划词翻译热键' : '尚未设置划词翻译热键'}
            </span>
            {selChips.length > 0 ? (
              <span className="flex items-center gap-1">
                {selChips.map((c, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <span className="text-[10px] text-slate-600">+</span>}
                    <span className="kbd">{c}</span>
                  </span>
                ))}
              </span>
            ) : (
              <Button onClick={() => navigate('hotkey')}>去设置热键</Button>
            )}
            <span className="text-[11px] leading-4 text-slate-500">
              也可用托盘菜单「划词翻译选中文字」触发
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              onClick={async () => {
                try {
                  await translateSelection();
                } catch (e) {
                  toast(`触发失败：${e}`);
                }
              }}
            >
              🖱 试一下（先在任意应用选中文字）
            </Button>
            <span className="text-[11px] leading-4 text-slate-500">
              取词链路：无障碍接口（UIA）→ 模拟复制兜底；悬浮窗会弹在选区旁边
            </span>
          </div>
        </div>
        <Toggle
          checked={cfg.translate.autoCopy}
          onChange={(autoCopy) => set('translate', { autoCopy })}
          label="译文自动复制到剪贴板"
          desc="划词翻译完成后无需点「复制」，直接可去任意位置粘贴"
        />
        <Toggle
          checked={cfg.translate.replaceMarker}
          onChange={(replaceMarker) => set('translate', { replaceMarker })}
          label="替换原文时加「翻 」标记"
          desc="译文替换进原文前加前缀，肉眼可辨、防止误以为是原文（Ctrl+Z 可撤销）"
        />
        <Toggle
          checked={cfg.translate.forcedCopy}
          onChange={(forcedCopy) => set('translate', { forcedCopy })}
          label="强制模拟复制取词"
          desc="跳过无障碍接口直接模拟 Ctrl+C / Cmd+C 读剪贴板。部分应用（自绘编辑器、某些游戏内文本框）UIA 取不到字，开启后兼容性最好，但会短暂闪动剪贴板（用完自动还原）"
        />
        <Toggle
          checked={cfg.translate.clipboardWatch}
          onChange={(clipboardWatch) => set('translate', { clipboardWatch })}
          label="复制即翻译（剪贴板监听）"
          desc="在任意应用里复制文字后自动弹出翻译卡片，无需再按热键（CopyTranslator 式）。本应用自己写入的内容（听写输出、译文复制、OCR 结果）不会触发；超长文本（4000 字以上）请用下方工作台。注意：开启后复制的所有文字都会发送给 AI 接口，密码管理器等敏感应用请加入黑名单"
        />
        {/* Ctrl+C+C 依赖 Windows 低级键盘钩子：mac 上后端不注册，隐藏开关避免无效配置 */}
        {!isMac && (
          <Toggle
            checked={cfg.translate.ccc === true}
            onChange={(ccc) => set('translate', { ccc })}
            label="Ctrl+C+C 双击复制即翻译"
            desc="DeepL 式：350ms 内连按两次 Ctrl+C，把刚复制的内容直接送进翻译卡片——只译你想译的那一段，不用像剪贴板监听那样逢复制必弹。守卫与黑名单同上；仅 Windows"
          />
        )}
        <Toggle
          checked={cfg.translate.structuredTranslate !== false}
          onChange={(structuredTranslate) => set('translate', { structuredTranslate })}
          label="结构化智能翻译（JSON / YAML / 键值文件）"
          desc="检测到结构化文本时只翻译字符串值：键名、注释、缩进与格式逐字节保留，文件翻译后可直接使用。占位符（{name}、%s、{{var}}、$var、HTML 标签）自动保护不译；URL / 路径 / 数字 / 布尔等非文本值自动跳过；重复值只译一次。适合 i18n 语言包、配置文件本地化"
        />
        <Field
          label="黑名单（每行一个关键字）"
          hint="前台窗口标题或进程名包含关键字时不触发划词翻译（静默跳过）。建议加入终端（Ctrl+C 是中断信号）与密码管理器，如：WindowsTerminal、mintty、1Password"
        >
          <TextArea
            rows={3}
            value={cfg.translate.blacklist}
            onChange={(blacklist) => set('translate', { blacklist })}
            placeholder={'WindowsTerminal\nmintty\n1Password'}
          />
        </Field>
      </Section>

      <Section
        icon="🔒"
        title="本地翻译引擎（离线 · 隐私）"
        desc="下载一个模型到本机，划词 / 复制即翻译 / 输入翻译全部离线完成——文本不出本机、零调用费。默认 Index-Translate（B 站开源翻译专项模型），llama.cpp 运行时与语音识别引擎共用。"
      >
        {/* 本地引擎档依赖 llama.cpp sidecar（仅 Windows）：mac 上不提供该档位
            （Segmented 无禁用态，直接不下发该选项，旁注说明），防止选了即坏 */}
        <Segmented
          value={cfg.translate.engine || 'cloud'}
          onChange={(engine) => set('translate', { engine })}
          options={[
            { value: 'cloud', label: '云端模型', desc: '质量最优 · 走「AI 优化」页配置' },
            ...(isMac
              ? []
              : [
                  {
                    value: 'local' as const,
                    label: '本地引擎',
                    desc: '离线 · 隐私 · 免费 · CPU 可跑',
                  },
                ]),
          ]}
        />
        {isMac && (
          <div className="mt-2 text-[11px] leading-4 text-slate-500">
            本地引擎仅 Windows
          </div>
        )}
        {cfg.translate.engine === 'local' && (
          <>
            <Field
              label="本地模型"
              hint="点击卡片选中；下载镜像沿用「语音识别」页设置（国内建议 hf-mirror.com）"
            >
              <div className="space-y-2">
                {llmModels.map((m) => {
                  const selected = (cfg.translate.localModel || 'index-translate-2b') === m.id;
                  const prog = progress[m.id];
                  const busy = downloading === m.id;
                  return (
                    <div
                      key={m.id}
                      onClick={() => {
                        set('translate', { localModel: m.id });
                        setConfirmDel(null);
                      }}
                      className={`cursor-pointer rounded-xl border px-3.5 py-3 transition ${
                        selected
                          ? 'border-teal-500/70 bg-teal-500/[0.08]'
                          : 'border-white/[0.07] bg-black/20 hover:border-white/20'
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 transition ${
                            selected
                              ? 'border-teal-400 bg-teal-400 shadow-[0_0_8px_rgba(45,212,191,0.6)]'
                              : 'border-slate-600'
                          }`}
                          aria-hidden
                        />
                        <span className="text-[13px] font-medium text-slate-200">{m.name}</span>
                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                          {fmtSize(m.sizeMb)}
                        </span>
                        {m.downloaded && (
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
                                  void onDeleteModel(m.id);
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
                            <span className="flex items-center gap-1.5 text-[11px] text-teal-400">
                              <Spinner size={12} /> 下载中…
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={downloading !== null}
                              onClick={(e) => {
                                e.stopPropagation();
                                void onDownloadModel(m.id);
                              }}
                              className="rounded-md px-2 py-1 text-[11px] text-teal-400 transition hover:bg-teal-500/10 hover:text-teal-300 disabled:opacity-50"
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
                              className="h-full rounded-full bg-gradient-to-r from-teal-500 to-emerald-400 transition-all"
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
            <div className="rounded-lg border border-teal-400/15 bg-teal-500/[0.04] px-3.5 py-2.5 text-[11px] leading-5 text-slate-400">
              选中本地引擎后，应用启动会自动预载（内存占用随所选模型 1.3~5.5GB，与语音识别引擎各占一份）；
              首次翻译前模型加载需十几秒，期间卡片显示「引擎启动中」。显卡自动加速（Vulkan），
              初始化失败自动回退 CPU；超时放宽到 300 秒，长文翻译不会被中途掐断。听写纠错仍走云端配置，不受影响。
              Index-Translate 家族会自动切换官方原生提示词（贪婪解码、模板层关思考），离线也拿到专项训练的翻译质量。
            </div>
          </>
        )}
      </Section>

      <Section
        icon="🎯"
        title="翻译语言"
        desc="目标语言与听写翻译共用（托盘菜单、悬浮窗语言条都能随时切换）；术语表在「AI 优化」页维护，翻译同样生效。"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="目标语言" hint="划词与听写翻译的默认输出语言">
            <Select
              value={target}
              onChange={(translateTarget) =>
                set('llm', {
                  translateTarget,
                  // 新目标语言与第二目标语言撞车时提示词会退化：同笔提交里清空
                  ...(cfg.llm.translateSecondTarget === translateTarget
                    ? { translateSecondTarget: '' }
                    : {}),
                })
              }
              options={TRANSLATE_LANGS.map(([v, l]) => ({ value: v, label: l }))}
            />
          </Field>
          <Field
            label="第二目标语言"
            hint="原文已是目标语言时改译为此语言（如目标 en、第二 zh：中译英、英译中）"
          >
            <Select
              value={cfg.llm.translateSecondTarget || 'none'}
              onChange={(v) => set('llm', { translateSecondTarget: v === 'none' ? '' : v })}
              options={[
                { value: 'none', label: '不启用' },
                ...TRANSLATE_LANGS.filter(([c]) => c !== target).map(([v, l]) => ({
                  value: v,
                  label: l,
                })),
              ]}
            />
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => navigate('llm')}>维护术语表</Button>
          <span className="text-[11px] leading-4 text-slate-500">
            人名、产品名、专有名词按你的规范写法翻译
          </span>
        </div>
      </Section>

      <Section
        icon="⌨️"
        title="输入翻译"
        desc="粘贴或输入整段文字翻译（大量文本、文档段落均可），流式出字，PDF 复制出的断行会自动拼接。Ctrl+Enter 快捷触发。"
      >
        <Field label="待翻译文本">
          <TextArea
            rows={5}
            value={input}
            onChange={setInput}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                void run();
              }
            }}
            placeholder="粘贴或输入要翻译的文本，Ctrl+Enter 直接触发…（也可选中本框文字后点上方「试一下」体验划词取词）"
          />
          {cfg.translate.structuredTranslate !== false &&
            (() => {
              const d = detectStructured(input);
              return d ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-emerald-300">
                    📄 检测到 {d}
                  </span>
                  <span className="text-slate-500">将只翻译字符串值——键名、注释与格式原样保留，占位符自动保护</span>
                </div>
              ) : null;
            })()}
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button kind="primary" onClick={run} disabled={busy || !input.trim() || !llmReady}>
            {busy ? (
              <>
                <Spinner size={13} /> 翻译中…
              </>
            ) : (
              <>🌐 翻译</>
            )}
          </Button>
          {/* 工作台 Select 与上方「翻译语言」共用同一持久化字段：明示切换会改全局默认，
              避免用户以为是工作台私有的临时选项（行为不变，只加说明） */}
          <div className="flex flex-col gap-1">
            <div className="w-32">
              <Select
                value={target}
                onChange={(translateTarget) =>
                  set('llm', {
                    translateTarget,
                    // 新目标语言与第二目标语言撞车时提示词会退化：同笔提交里清空
                    ...(cfg.llm.translateSecondTarget === translateTarget
                      ? { translateSecondTarget: '' }
                      : {}),
                  })
                }
                options={TRANSLATE_LANGS.map(([v, l]) => ({ value: v, label: l }))}
              />
            </div>
            <span className="text-[10.5px] leading-4 text-slate-600">
              切换会同步修改全局默认目标语言（听写翻译/划词翻译共用）
            </span>
          </div>
          {input && (
            <span className="font-mono text-[11px] text-slate-600">
              {input.length} 字
            </span>
          )}
          {(result || stream) && (
            <Button
              onClick={() => {
                const t = result || stream;
                if (!t.trim()) return;
                void copyText(t)
                  .then(() => toast('已复制译文 ✓'))
                  .catch((e) => toast(`复制失败：${e}`));
              }}
            >
              ⧉ 复制译文
            </Button>
          )}
          {(input || result || stream) && !busy && (
            <Button
              onClick={() => {
                setInput('');
                setResult('');
                setStream('');
                setErr('');
              }}
            >
              清空
            </Button>
          )}
          {!llmReady && (
            <span className="flex flex-wrap items-center gap-1 text-[11px] leading-4 text-amber-300">
              {cfg.translate.engine === 'local'
                ? '本地模型未下载：请在上方「本地翻译引擎」下载'
                : 'AI 接口未配置：'}
              {cfg.translate.engine !== 'local' && (
                <button
                  type="button"
                  onClick={() => navigate('llm')}
                  className="text-sky-400 underline decoration-sky-400/40 underline-offset-2 transition hover:text-sky-300"
                >
                  去 AI 优化页启用并填写 ›
                </button>
              )}
            </span>
          )}
        </div>
        {(result || stream || err) && (
          <div
            ref={resultRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            className={`sn-scroll max-h-[360px] select-text overflow-y-auto whitespace-pre-wrap break-words rounded-xl border px-3.5 py-3 text-[13.5px] leading-[1.9] ${
              err
                ? 'border-red-400/20 bg-red-500/[0.05] text-red-300'
                : 'border-emerald-400/15 bg-emerald-500/[0.04] text-slate-100'
            }`}
          >
            {err || result || stream}
            {busy && !result && <span className="llm-cursor text-emerald-300">▍</span>}
          </div>
        )}
      </Section>
    </>
  );
}
