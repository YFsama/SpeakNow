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
} from '../Controls';
import { deleteBuiltin, downloadBuiltin, isMac, testAsr } from '../../api';
import type { ProviderProfile, TabProps } from '../../types';
import { resolvedAsrCreds } from '../../types';
import { NumberInput, newProviderId, providerOptions } from './shared';

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

/** 热词条数（与后端同规则：换行 / 中英文逗号分割，去空白后计非空项，上限 100） */
function hotwordCount(s: string): number {
  return s
    .split(/[\n,，]/)
    .map((t) => t.trim())
    .filter(Boolean).length;
}

export function AsrTab({
  cfg,
  set,
  toast,
  navigate,
  localModels,
  refreshLocalModels,
}: TabProps) {
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

  // 引用凭据组时以组内 baseUrl 为准（后端凭据组迁移后本页内联 baseUrl 已清空）：
  // 横幅与预设匹配都基于生效地址，与「AI 优化」页 / Dashboard 的解析逻辑一致
  const asrCreds = resolvedAsrCreds(cfg);

  const preset =
    ASR_PRESETS.find(
      (p) =>
        p.baseUrl !== '' &&
        p.baseUrl === asrCreds.baseUrl &&
        p.endpointPath === cfg.asr.endpointPath,
    )?.value ?? 'custom';

  const run = async () => {
    setTest({ loading: true });
    try {
      setTest({
        loading: false,
        ok: true,
        msg: await testAsr(cfg.asr, cfg.providers ?? []),
      });
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
          onChange={(provider) =>
            set('asr', {
              provider,
              // 切引擎时同步纠正端点路径：MiMo 走 chat/completions（从云端 API
              // 切过来带着 /audio/transcriptions 会静默失败），切回云端 API 则还原
              // transcriptions（否则残留 MiMo 端点同样失败）；本地引擎不用端点
              ...(provider === 'mimo'
                ? { endpointPath: '/chat/completions' }
                : provider === 'http'
                  ? { endpointPath: '/audio/transcriptions' }
                  : {}),
            })
          }
          options={[
            { value: 'mimo', label: 'MiMo 云端', desc: '小米 MiMo-V2.5-ASR' },
            { value: 'http', label: '云端 API', desc: 'GLM-ASR / Whisper 等 · 需 Key' },
            { value: 'local', label: '本地离线', desc: 'Whisper / Qwen3-ASR · 免 Key 免联网' },
          ]}
        />
      </Field>

      {!isLocal && (
        <>
          {(cfg.providers ?? []).length > 0 && (
            <Field
              label="API 凭据组"
              hint="使用「AI 优化」页统一管理的凭据组——同一家服务商（如智谱）只需填一次 Key，语音识别与 AI 优化共用"
            >
              <Select
                // 悬空 providerId（组已被删）回退显示「自定义」，避免下拉空白
                value={
                  cfg.providers.some((x) => x.id === cfg.asr.providerId)
                    ? cfg.asr.providerId ?? ''
                    : ''
                }
                onChange={(providerId) => {
                  // 只切引用，不清内联地址与 Key：内联字段在引用期间被后端
                  // 忽略，组删除后退回使用，避免 Key 被无恢复地清掉
                  set('asr', { providerId });
                }}
                options={providerOptions(cfg.providers)}
              />
            </Field>
          )}
          <Field label="服务商预设">
            <Select
              value={preset}
              onChange={(v) => {
                const p = ASR_PRESETS.find((x) => x.value === v);
                if (!p) return;
                // 引用了凭据组时预设地址写入凭据组（本页 baseUrl 保持镜像）；
                // 自定义模式则直接写内联字段
                const pid = cfg.asr.providerId ?? '';
                const group = cfg.providers.find((x) => x.id === pid);
                // 凭据组被「AI 优化」页共用且预设地址与组内不同：新建独立组
                // 只供本页引用（原组不动），避免改组地址把另一页一并重定向
                if (
                  group &&
                  p.baseUrl &&
                  p.baseUrl !== group.baseUrl &&
                  cfg.asr.providerId === cfg.llm.providerId
                ) {
                  const np: ProviderProfile = {
                    id: newProviderId(),
                    name: p.label,
                    baseUrl: p.baseUrl,
                    apiKey: '',
                  };
                  set('providers', [...cfg.providers, np]);
                  set('asr', {
                    providerId: np.id,
                    provider: p.provider,
                    baseUrl: p.baseUrl,
                    model: p.model || cfg.asr.model,
                    endpointPath: p.endpointPath,
                  });
                  return;
                }
                if (group) {
                  set(
                    'providers',
                    cfg.providers.map((x) =>
                      x.id === pid ? { ...x, baseUrl: p.baseUrl || x.baseUrl } : x,
                    ),
                  );
                }
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
          {!(cfg.asr.providerId && cfg.providers.some((x) => x.id === cfg.asr.providerId)) && (
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
          )}
          {cfg.asr.providerId && cfg.providers.some((x) => x.id === cfg.asr.providerId) ? (
            <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/[0.04] px-3.5 py-2.5 text-[11.5px] leading-5 text-emerald-200/80">
              🔑 正在使用凭据组「
              {cfg.providers.find((x) => x.id === cfg.asr.providerId)?.name || '未命名'}」
              · 地址 {asrCreds.baseUrl || '（未填写）'} · Key{' '}
              {cfg.providers.find((x) => x.id === cfg.asr.providerId)?.apiKey.trim() ? (
                '已配置'
              ) : (
                <>
                  未填写 ·{' '}
                  <button
                    type="button"
                    onClick={() => navigate('llm')}
                    className="text-sky-400 underline decoration-sky-400/40 underline-offset-2 transition hover:text-sky-300"
                  >
                    去 AI 优化页填写 ›
                  </button>
                </>
              )}
            </div>
          ) : (
            <Field label="API Key">
              <TextInput
                type="password"
                mono
                value={cfg.asr.apiKey}
                onChange={(apiKey) => set('asr', { apiKey })}
                placeholder="sk-…"
              />
            </Field>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="端点路径" hint="whisper.cpp 本地服务为 /inference">
              <TextInput
                mono
                value={cfg.asr.endpointPath}
                onChange={(endpointPath) => set('asr', { endpointPath })}
              />
            </Field>
            <Field label="请求超时（秒）">
              <NumberInput
                value={cfg.asr.timeoutSec}
                normalize={(v) => Math.max(5, Number(v) || 60)}
                onCommit={(timeoutSec) => set('asr', { timeoutSec })}
              />
            </Field>
          </div>
          <Field
            label="ASR 热词（专业行业字库）"
            badge={
              <span
                className={`rounded-full border px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${
                  hotwordCount(cfg.asr.hotwords) >= 100
                    ? 'border-red-400/30 bg-red-400/10 text-red-300'
                    : 'border-white/10 bg-white/[0.04] text-slate-400'
                }`}
              >
                {Math.min(hotwordCount(cfg.asr.hotwords), 100)}/100
              </span>
            }
            hint="每行一个或用逗号分隔。GLM-ASR 等支持热词的模型会显著提升专有名词、行业术语的识别准确率（最多 100 个）。「AI 优化」页术语表中的术语会自动并入，无需重复填写"
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
              {/* Qwen3-ASR 引擎（llama.cpp Vulkan/CPU）目前仅支持 Windows，mac 上隐藏卡片避免误选 */}
              {localModels
                // ppocr 属于「截图取词」页的模型，不在语音识别页展示
                .filter((m) => !(isMac && m.kind === 'qwen') && m.kind !== 'ppocr')
                .map((m) => {
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

      {/* 识别语言与两端 Toggle 同为全宽字段，独占一行（原两列 grid 只有一格，右半留白） */}
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
