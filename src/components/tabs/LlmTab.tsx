import { useEffect, useState } from 'react';
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
import { listLlmModels, testLlm } from '../../api';
import type { ProviderProfile, TabProps } from '../../types';
import { TRANSLATE_LANGS, langName } from '../../types';
import { newProviderId, providerOptions } from './shared';

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
    value: 'qwenmt',
    label: '阿里 Qwen-MT（翻译专用 API，需 DashScope Key）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-mt-turbo',
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
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const providers = cfg.providers ?? [];
  const llmProfile = providers.find((x) => x.id === cfg.llm.providerId);
  const usingProfile = !!llmProfile;
  const creds = usingProfile
    ? { baseUrl: llmProfile!.baseUrl, apiKey: llmProfile!.apiKey }
    : { baseUrl: cfg.llm.baseUrl, apiKey: cfg.llm.apiKey };
  const preset =
    LLM_PRESETS.find((p) => p.baseUrl !== '' && p.baseUrl === creds.baseUrl)?.value ??
    'custom';

  /* ---- 凭据组管理 ---- */
  const addProvider = () => {
    set('providers', [
      ...providers,
      { id: newProviderId(), name: '', baseUrl: '', apiKey: '' },
    ]);
  };
  const updateProvider = (id: string, patch: Partial<ProviderProfile>) => {
    set(
      'providers',
      providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    );
  };
  // 删除凭据组：两步确认（首次点击变「确认删除?」，3 秒无操作自动复位），
  // 防止误点把 Key 连组一起被 800ms 自动保存不可逆清除
  const removeProvider = (id: string) => {
    if (confirmDel !== id) {
      setConfirmDel(id);
      return;
    }
    setConfirmDel(null);
    set('providers', providers.filter((p) => p.id !== id));
    if (cfg.asr.providerId === id) set('asr', { providerId: '' });
    if (cfg.llm.providerId === id) set('llm', { providerId: '' });
  };
  useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDel]);

  const run = async () => {
    setTest({ loading: true });
    try {
      setTest({
        loading: false,
        ok: true,
        msg: await testLlm(cfg.llm, providers),
      });
    } catch (e) {
      setTest({ loading: false, ok: false, msg: String(e) });
    }
  };

  const fetchModels = async () => {
    setFetching(true);
    try {
      const list = await listLlmModels(creds.baseUrl, creds.apiKey);
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
      desc="转写结果先经大模型纠正错字、标点与术语（或翻译成目标语言），再输入目标输入框。"
    >
      {/* ===== 统一凭据组 ===== */}
      <div className="rounded-xl border border-white/[0.07] bg-black/20 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] font-medium text-slate-300">🔑 API 凭据组</span>
          <span className="text-[11px] leading-4 text-slate-500">
            同一家服务商只需填一次 Key，「语音识别」与「AI 优化」共用（如智谱一个 Key 同用 GLM-ASR + GLM 纠错）
          </span>
          <Button onClick={addProvider}>＋ 添加</Button>
        </div>
        {providers.length === 0 && (
          <div className="text-[11.5px] leading-5 text-slate-500">
            尚无凭据组。添加后，两页的「API 凭据组」下拉即可引用；也可不建凭据组、在各页单独填写地址与 Key（行为与旧版一致）。
          </div>
        )}
        <div className="space-y-3">
          {providers.map((p) => {
            const refs = [
              cfg.asr.providerId === p.id ? '语音识别' : null,
              cfg.llm.providerId === p.id ? 'AI 优化' : null,
            ].filter(Boolean);
            return (
              <div
                key={p.id}
                className="rounded-lg border border-white/[0.06] bg-black/25 p-3"
              >
                <div className="mb-2 flex items-center gap-2">
                  <div className="w-44">
                    <TextInput
                      value={p.name}
                      onChange={(name) => updateProvider(p.id, { name })}
                      placeholder="名称（如 智谱 / DeepSeek）"
                    />
                  </div>
                  {refs.length > 0 && (
                    <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-300">
                      {refs.join(' + ')} 引用中
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeProvider(p.id)}
                    title="删除该凭据组（引用它的页面会退回各自的内联配置）"
                    className={`ml-auto rounded-md px-2 py-1 text-[11px] transition ${
                      confirmDel === p.id
                        ? 'bg-red-500/15 text-red-300'
                        : 'text-slate-500 hover:bg-red-500/10 hover:text-red-300'
                    }`}
                  >
                    {confirmDel === p.id ? '确认删除？' : '🗑 删除'}
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <TextInput
                    mono
                    value={p.baseUrl}
                    onChange={(baseUrl) => updateProvider(p.id, { baseUrl })}
                    placeholder="Base URL：https://open.bigmodel.cn/api/paas/v4"
                  />
                  <TextInput
                    type="password"
                    mono
                    value={p.apiKey}
                    onChange={(apiKey) => updateProvider(p.id, { apiKey })}
                    placeholder="API Key（sk-…）"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <Toggle
        checked={cfg.llm.enabled}
        onChange={(enabled) => set('llm', { enabled })}
        label="启用 AI 优化"
        desc="关闭后直接输出原始转写（更快）；快速键也可按次临时跳过"
      />
      {cfg.llm.enabled && (
        <>
          {providers.length > 0 && (
            <Field
              label="本页使用的凭据"
              hint="引用上方凭据组时，地址与 Key 以凭据组为准（Key 不再重复填写）"
            >
              <Select
                // 悬空 providerId（组已被删）回退显示「自定义」，避免下拉空白
                value={
                  providers.some((x) => x.id === cfg.llm.providerId)
                    ? cfg.llm.providerId ?? ''
                    : ''
                }
                onChange={(providerId) => {
                  // 只切引用，不清内联地址与 Key：内联字段在引用期间被后端
                  // 忽略，组删除后退回使用，避免 Key 被无恢复地清掉
                  set('llm', { providerId });
                }}
                options={providerOptions(providers)}
              />
            </Field>
          )}
          <Field label="服务商预设">
            <Select
              value={preset}
              onChange={(v) => {
                const p = LLM_PRESETS.find((x) => x.value === v);
                if (!p) return;
                // 引用了凭据组时预设地址写入凭据组；自定义模式直接写内联
                if (usingProfile) {
                  // 凭据组被「语音识别」页共用且预设地址与组内不同：新建独立组
                  // 只供本页引用（原组不动），避免改组地址把另一页一并重定向
                  if (
                    p.baseUrl &&
                    p.baseUrl !== llmProfile!.baseUrl &&
                    cfg.asr.providerId === llmProfile!.id
                  ) {
                    const np: ProviderProfile = {
                      id: newProviderId(),
                      name: p.label,
                      baseUrl: p.baseUrl,
                      apiKey: '',
                    };
                    set('providers', [...providers, np]);
                    set('llm', {
                      providerId: np.id,
                      baseUrl: p.baseUrl,
                      model: p.model || cfg.llm.model,
                    });
                    return;
                  }
                  updateProvider(llmProfile!.id, {
                    baseUrl: p.baseUrl || llmProfile!.baseUrl,
                  });
                }
                set('llm', {
                  baseUrl: p.baseUrl || cfg.llm.baseUrl,
                  model: p.model || cfg.llm.model,
                });
              }}
              options={LLM_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
            />
          </Field>
          {!usingProfile && (
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
          )}
          {usingProfile ? (
            <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/[0.04] px-3.5 py-2.5 text-[11.5px] leading-5 text-emerald-200/80">
              🔑 正在使用凭据组「{llmProfile!.name || '未命名'}」· 地址{' '}
              {llmProfile!.baseUrl || '（未填写）'} · Key{' '}
              {llmProfile!.apiKey.trim() ? '已配置' : '未填写（请在上方凭据组填写）'}
              <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
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
            </div>
          ) : (
            <Field label="API Key">
              <TextInput
                type="password"
                mono
                value={cfg.llm.apiKey}
                onChange={(apiKey) => set('llm', { apiKey })}
                placeholder="sk-…（与 ASR 相同厂商时可建凭据组共用）"
              />
            </Field>
          )}
          <Field label="优化模式">
            <Segmented
              value={cfg.llm.mode}
              onChange={(mode) => set('llm', { mode })}
              options={[
                { value: 'correct', label: '仅纠错', desc: '修错别字/标点，保留口语原貌' },
                { value: 'polish', label: '纠错 + 润色', desc: '整理为通顺书面表达' },
                { value: 'prompt', label: '编程提示词', desc: '整理成给 Codex/AI 的指令' },
                {
                  value: 'translate',
                  label: `翻译为${langName(cfg.llm.translateTarget || 'en')}`,
                  desc: '说完直接输出目标语言译文',
                },
              ]}
            />
          </Field>
          {cfg.llm.mode === 'translate' && (
            <div className="space-y-4 rounded-xl border border-emerald-500/15 bg-emerald-500/[0.04] p-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="目标语言">
                  <Select
                    value={cfg.llm.translateTarget || 'en'}
                    onChange={(translateTarget) =>
                      set('llm', {
                        translateTarget,
                        // 新目标语言与第二目标语言撞车时提示词会退化（译成同种
                        // 语言）：同笔提交里清空第二目标语言，避免留下无效组合
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
                  hint="识别语言==目标语言时改译为此语言（如目标 en、第二 zh：说中出英、说英出中）"
                >
                  <Select
                    value={cfg.llm.translateSecondTarget || 'none'}
                    onChange={(v) =>
                      set('llm', { translateSecondTarget: v === 'none' ? '' : v })
                    }
                    options={[
                      { value: 'none', label: '不启用' },
                      ...TRANSLATE_LANGS.filter(([c]) => c !== cfg.llm.translateTarget).map(
                        ([v, l]) => ({ value: v, label: l }),
                      ),
                    ]}
                  />
                </Field>
              </div>
              <Field label="输出格式">
                <Segmented
                  value={cfg.llm.translateOutput || 'translation'}
                  onChange={(translateOutput) => set('llm', { translateOutput })}
                  options={[
                    { value: 'translation', label: '仅译文', desc: '只输入译文（推荐）' },
                    { value: 'bilingual', label: '双语对照', desc: '原文一行 + 译文一行' },
                  ]}
                />
              </Field>
              <div className="text-[11px] leading-5 text-slate-500">
                💡 不想改默认模式？「快捷键」页可设一个<b className="text-slate-400">翻译快捷键</b>
                按次翻译；托盘右键菜单也能随时切换模式与目标语言。翻译时术语表同样生效
                （术语按规范写法翻译）。
              </div>
            </div>
          )}
          <Field
            label="术语表（纠错词库）"
            hint="每行一个术语，纠正结果优先采用。可声明常见误识形式（用 = 和 | 分隔），命中时强制纠正，如：Rust=拉斯特|拉斯。用智谱 ASR 时术语还会自动并入识别热词，从源头减少误识别"
          >
            <TextArea
              rows={3}
              value={cfg.llm.glossary}
              onChange={(glossary) => set('llm', { glossary })}
              placeholder={'Tauri\nRust=拉斯特|拉斯\n低代码平台'}
            />
          </Field>
          <Field
            label="自定义处理指令（可选）"
            hint="用 {text} 代表原始转写文本；留空使用内置指令。例如：把 {text} 翻译成英文后输出。设置后以上模式与翻译设置让位于该指令"
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
