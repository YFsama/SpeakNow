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
import type { PromptTemplate, ProviderProfile, TabProps } from '../../types';
import { TRANSLATE_LANGS, langName } from '../../types';
import {
  cacheModelList,
  cachedModelList,
  isLocalBaseUrl,
  matchPreset,
  ModelInput,
  newProviderId,
  providerOptions,
  type ModelPreset,
} from './shared';

/* ============ AI 优化 ============ */
/* 服务商预设：models 为推荐模型档位（首个 = 选预设时的默认值）。
   模型名随厂商迭代（2026-10 校准）：智谱 GLM-5.3 系、DeepSeek V4
   （deepseek-chat 已于 2026-07 弃用）、Kimi K3、OpenAI GPT-5.2 系 */
const LLM_PRESETS: ModelPreset[] = [
  {
    value: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-4.7', 'glm-4.6'],
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  {
    value: 'kimi',
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k3', 'kimi-k2.6', 'kimi-k2-0905-preview'],
  },
  {
    value: 'qwenmt',
    label: '阿里 Qwen-MT（翻译专用 API，需 DashScope Key）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-mt-turbo', 'qwen-mt-plus', 'qwen-mt-flash', 'qwen-mt-lite'],
  },
  {
    value: 'ollama',
    label: 'Ollama 本地（免 Key，推荐小模型 qwen3:4b）',
    baseUrl: 'http://localhost:11434/v1',
    models: ['qwen3:4b', 'qwen3:8b'],
  },
  {
    value: 'lmstudio',
    label: 'LM Studio 本地（免 Key）',
    baseUrl: 'http://localhost:1234/v1',
    models: [],
  },
  {
    value: 'llamacpp',
    label: 'llama.cpp server 本地（免 Key）',
    baseUrl: 'http://127.0.0.1:8080/v1',
    models: [],
  },
  {
    value: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.2', 'gpt-5.2-chat-latest', 'gpt-5-mini', 'gpt-4o-mini'],
  },
  {
    value: 'custom',
    label: '自定义（任意 OpenAI 兼容接口）',
    baseUrl: '',
    models: [],
  },
];

export function LlmTab({ cfg, set, toast }: TabProps) {
  const [test, setTest] = useState<{ loading: boolean; ok?: boolean; msg?: string }>({
    loading: false,
  });
  const [modelList, setModelList] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  /* ---- 指令模板库（行内命名 / 两段式删除） ---- */
  const [addingTpl, setAddingTpl] = useState(false);
  const [tplName, setTplName] = useState('');
  const [delTpl, setDelTpl] = useState<string | null>(null);
  /* ---- 凭据组管理面板：默认收起，常用路径（改模型/切预设）不被迫先滚过一长串 Key 输入框 ---- */
  const [providersOpen, setProvidersOpen] = useState(false);

  const providers = cfg.providers ?? [];
  const llmProfile = providers.find((x) => x.id === cfg.llm.providerId);
  const usingProfile = !!llmProfile;
  const creds = usingProfile
    ? { baseUrl: llmProfile!.baseUrl, apiKey: llmProfile!.apiKey }
    : { baseUrl: cfg.llm.baseUrl, apiKey: cfg.llm.apiKey };
  const preset = matchPreset(LLM_PRESETS, creds.baseUrl)?.value ?? 'custom';
  /* 命中预设时的推荐模型档位：模型框下方一键切换 chips（新版本随时插队到首位） */
  const modelCandidates = matchPreset(LLM_PRESETS, creds.baseUrl)?.models ?? [];

  /* 生效配置健康度：地址必填；Key 仅云端必填（本地 Ollama 等免 Key），
     与后端 LLM 空-Key-跳过逻辑同口径 */
  const localBase = isLocalBaseUrl(creds.baseUrl);
  const missingUrl = !creds.baseUrl.trim();
  const missingKey = !localBase && !creds.apiKey.trim();
  const connReady = !missingUrl && !missingKey;

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

  /* ---- 指令模板库 ---- */
  const templates = cfg.llm.promptTemplates ?? [];
  // 模板删除同样两段确认：3 秒无操作自动复位
  useEffect(() => {
    if (!delTpl) return;
    const t = setTimeout(() => setDelTpl(null), 3000);
    return () => clearTimeout(t);
  }, [delTpl]);

  const applyTemplate = (t: PromptTemplate) => {
    set('llm', { customPrompt: t.prompt });
    toast('已套用模板');
  };

  const saveTemplate = () => {
    const name = tplName.trim();
    if (!name || !cfg.llm.customPrompt.trim()) return;
    set('llm', {
      promptTemplates: [
        ...templates,
        { id: Date.now().toString(36), name, prompt: cfg.llm.customPrompt },
      ],
    });
    setAddingTpl(false);
    setTplName('');
    toast('模板已保存');
  };

  const removeTemplate = (id: string) => {
    if (delTpl !== id) {
      setDelTpl(id);
      return;
    }
    setDelTpl(null);
    set('llm', { promptTemplates: templates.filter((t) => t.id !== id) });
  };

  /* Key 未填写的「去填写」直达：引用凭据组 → 展开面板并聚焦组内 Key 框；
     独立配置 → 聚焦本页 Key 输入框 */
  const gotoKeyInput = () => {
    const focus = () => {
      const el = document.getElementById(
        usingProfile ? `llm-key-${llmProfile!.id}` : 'llm-inline-key',
      );
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.querySelector('input')?.focus();
    };
    if (usingProfile && !providersOpen) {
      setProvidersOpen(true);
      // 面板展开是异步渲染，等一帧再滚动
      window.setTimeout(focus, 80);
    } else {
      focus();
    }
  };

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
      cacheModelList(creds.baseUrl, list);
      toast(`发现 ${list.length} 个模型，可在「模型名称」中选择`);
    } catch (e) {
      toast(String(e));
    } finally {
      setFetching(false);
    }
  };

  /* 切换地址（换预设/换凭据组）时尝试恢复该地址已拉取过的列表，
     切页回来也不必重新 ⟳（会话级缓存在 shared） */
  useEffect(() => {
    setModelList(cachedModelList(creds.baseUrl));
  }, [creds.baseUrl]);

  /* 模型名称 + 获取列表 + 预设候选 chips：单一实现（此前凭据组/自定义两条分支
     各一份，行为却完全相同）。候选与获取列表在 datalist 内合并去重 */
  const modelField = (
    <Field
      label="模型名称"
      hint={
        modelList
          ? `发现 ${modelList.length} 个模型，输入框可下拉选择`
          : '下拉可选推荐模型，或点右侧按钮从接口获取完整列表'
      }
    >
      <ModelInput
        listId="llm-model-list"
        value={cfg.llm.model}
        onChange={(model) => set('llm', { model })}
        candidates={modelCandidates}
        modelList={modelList}
        fetching={fetching}
        onFetch={fetchModels}
        placeholder="glm-5.3 / qwen3:4b / kimi-k3 …"
      />
    </Field>
  );

  return (
    <Section
      icon="✨"
      title="AI 纠错与优化"
      desc="转写结果先经大模型纠正错字、标点与术语（或翻译成目标语言），再输入目标输入框。"
    >
      {/* ===== 凭据组管理（可折叠）：同一家服务商只填一次 Key，两页共用 ===== */}
      <div className="rounded-xl border border-white/[0.07] bg-black/20">
        <button
          type="button"
          onClick={() => setProvidersOpen((v) => !v)}
          className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left"
        >
          <span className="text-[12.5px] font-medium text-slate-300">🔑 API 凭据组</span>
          {providers.length > 0 && (
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
              {providers.length} 个
            </span>
          )}
          <span className="text-[11px] leading-4 text-slate-500">
            同一家服务商只需填一次 Key，「语音识别」与「AI 优化」共用（如智谱一个 Key 同用 GLM-ASR + GLM 纠错）
          </span>
          <span className="ml-auto text-[11px] text-slate-500">
            {providersOpen ? '收起 ▴' : '管理 ▾'}
          </span>
        </button>
        {providersOpen && (
          <div className="space-y-3 border-t border-white/[0.06] px-4 py-3">
            {providers.length === 0 && (
              <div className="text-[11.5px] leading-5 text-slate-500">
                尚无凭据组。添加后，两页的「凭据来源」下拉即可引用；也可不建凭据组、
                在下方直接填写地址与 Key（行为与旧版一致）。
              </div>
            )}
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
                    {/* id 供摘要卡「Key 未填写 · 去填写」直达滚动聚焦 */}
                    <div id={`llm-key-${p.id}`}>
                      <TextInput
                        type="password"
                        mono
                        value={p.apiKey}
                        onChange={(apiKey) => updateProvider(p.id, { apiKey })}
                        placeholder="API Key（sk-…）"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
            <Button onClick={addProvider}>＋ 添加凭据组</Button>
          </div>
        )}
      </div>

      <Toggle
        checked={cfg.llm.enabled}
        onChange={(enabled) => set('llm', { enabled })}
        label="启用 AI 优化"
        desc="关闭后直接输出原始转写（更快）；快速键也可按次临时跳过"
      />
      {cfg.llm.enabled && (
        <>
          {/* ===== 生效配置总览：来源 / 地址 / Key / 模型 一屏看清，就近测试 ===== */}
          <div
            className={`rounded-xl border p-4 ${
              connReady
                ? 'border-emerald-500/20 bg-emerald-500/[0.04]'
                : 'border-amber-500/25 bg-amber-500/[0.05]'
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  connReady ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'
                }`}
                aria-hidden
              />
              <span className="text-[12.5px] font-medium text-slate-200">
                当前生效配置
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10.5px] text-slate-300">
                {usingProfile ? `凭据组「${llmProfile!.name || '未命名'}」` : '本页独立配置'}
              </span>
              <span className="ml-auto">
                <Button onClick={run} disabled={test.loading}>
                  {test.loading ? (
                    <>
                      <Spinner size={13} /> 测试中…
                    </>
                  ) : (
                    '测试连接'
                  )}
                </Button>
              </span>
            </div>
            <div className="mt-2 space-y-0.5 text-[11.5px] leading-5">
              <div className="text-slate-400">
                接口地址{' '}
                {creds.baseUrl.trim() ? (
                  <span className="font-mono text-slate-200">{creds.baseUrl.trim()}</span>
                ) : (
                  <span className="text-amber-300">未填写 — 下方选择服务商预设</span>
                )}
              </div>
              <div className="text-slate-400">
                API Key{' '}
                {localBase ? (
                  <span className="text-emerald-300">本地服务 · 免 Key</span>
                ) : creds.apiKey.trim() ? (
                  <span className="text-emerald-300">已配置</span>
                ) : (
                  <span className="text-amber-300">
                    未填写 ·{' '}
                    <button
                      type="button"
                      onClick={gotoKeyInput}
                      className="text-sky-400 underline decoration-sky-400/40 underline-offset-2 transition hover:text-sky-300"
                    >
                      {usingProfile ? '去凭据组填写 ›' : '去下方填写 ›'}
                    </button>
                  </span>
                )}
              </div>
              <div className="text-slate-400">
                模型{' '}
                {cfg.llm.model.trim() ? (
                  <span className="font-mono text-slate-200">{cfg.llm.model.trim()}</span>
                ) : (
                  <span className="text-amber-300">未填写 — 下方选择或输入</span>
                )}
              </div>
            </div>
            {test.msg && (
              <div
                className={`mt-2 text-xs leading-5 ${test.ok ? 'text-emerald-300' : 'text-red-300'}`}
              >
                {test.msg}
              </div>
            )}
          </div>

          {providers.length > 0 && (
            <Field
              label="凭据来源"
              hint="引用凭据组时地址与 Key 以组为准；选「自定义」则在下方本页独立填写"
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
          <Field label="服务商预设" hint="选定后自动填入地址与推荐模型">
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
                      model: p.models[0] || cfg.llm.model,
                    });
                    return;
                  }
                  updateProvider(llmProfile!.id, {
                    baseUrl: p.baseUrl || llmProfile!.baseUrl,
                  });
                }
                set('llm', {
                  baseUrl: p.baseUrl || cfg.llm.baseUrl,
                  model: p.models[0] || cfg.llm.model,
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
              <Field label="API Key">
                {/* id 供摘要卡「去下方填写」聚焦 */}
                <div id="llm-inline-key">
                  <TextInput
                    type="password"
                    mono
                    value={cfg.llm.apiKey}
                    onChange={(apiKey) => set('llm', { apiKey })}
                    placeholder="sk-…（与 ASR 相同厂商时可建凭据组共用）"
                  />
                </div>
              </Field>
            </div>
          )}
          {modelField}
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
          {/* 指令模板库：chips 一键套用到上方指令框；＋ 把当前指令存为新模板 */}
          <div className="rounded-xl border border-white/[0.07] bg-black/20 p-4">
            <div className="mb-2.5 flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] font-medium text-slate-300">📋 指令模板</span>
              {templates.length > 0 && (
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                  {templates.length} 个
                </span>
              )}
              <span className="text-[11px] leading-4 text-slate-500">
                点击模板 = 套用到上方指令框
              </span>
              <Button
                onClick={() => {
                  setAddingTpl(true);
                  setTplName('');
                }}
              >
                ＋ 新模板
              </Button>
            </div>
            {addingTpl && (
              <div className="mb-2.5 flex flex-wrap items-center gap-2">
                <div className="w-60">
                  <TextInput
                    value={tplName}
                    onChange={setTplName}
                    placeholder="模板名称（如：翻译成英文）"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveTemplate();
                    }}
                  />
                </div>
                <Button
                  kind="primary"
                  onClick={saveTemplate}
                  disabled={!tplName.trim() || !cfg.llm.customPrompt.trim()}
                  title="把上方「自定义处理指令」当前内容存为该模板"
                >
                  保存当前指令
                </Button>
                <Button onClick={() => setAddingTpl(false)}>取消</Button>
                {!cfg.llm.customPrompt.trim() && (
                  <span className="text-[11px] text-amber-300/80">
                    先在上方指令框写好内容
                  </span>
                )}
              </div>
            )}
            {templates.length === 0 ? (
              !addingTpl && (
                <div className="text-[11.5px] leading-5 text-slate-500">
                  把常用指令存成模板，一键套用
                </div>
              )
            ) : (
              <div className="flex flex-wrap gap-2">
                {templates.map((t) => (
                  <span
                    key={t.id}
                    className="flex items-center overflow-hidden rounded-full border border-white/10 bg-white/[0.04]"
                  >
                    <button
                      type="button"
                      onClick={() => applyTemplate(t)}
                      title={t.prompt}
                      className="max-w-[260px] truncate px-3 py-1.5 text-[12px] text-slate-200 transition hover:bg-sky-500/10 hover:text-sky-300"
                    >
                      {t.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeTemplate(t.id)}
                      title="删除该模板"
                      className={`px-2 py-1.5 text-[11px] transition ${
                        delTpl === t.id
                          ? 'bg-red-500/15 text-red-300'
                          : 'text-slate-500 hover:bg-red-500/10 hover:text-red-300'
                      }`}
                    >
                      {delTpl === t.id ? '确认删除？' : '✕'}
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </Section>
  );
}
