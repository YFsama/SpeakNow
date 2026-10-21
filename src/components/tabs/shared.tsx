import { useRef, useState } from 'react';
import { Button, Spinner, TextInput } from '../Controls';
import type { ProviderProfile } from '../../types';

/* ============ 统一凭据组（共享 UI） ============ */

/** 凭据组下拉选项：已有凭据组 + 「自定义（本页独立填写）」 */
export function providerOptions(providers: ProviderProfile[]) {
  return [
    ...providers.map((p) => ({
      value: p.id,
      label: `${p.name || '未命名'}${p.apiKey.trim() ? '' : '（Key 未填写）'}`,
    })),
    { value: '', label: '自定义（本页独立填写地址与 Key）' },
  ];
}

/** 本机自建服务（Ollama / LM Studio / llama.cpp，免 Key）。与后端
 *  http::is_local_base 同口径：localhost / 127.0.0.1 / 0.0.0.0 / [::1] */
export function isLocalBaseUrl(baseUrl: string): boolean {
  const b = baseUrl.trim().toLowerCase();
  return (
    b.includes('localhost') ||
    b.includes('127.0.0.1') ||
    b.includes('0.0.0.0') ||
    b.includes('[::1]')
  );
}

/** 服务商预设的推荐模型档位：首个为选预设时的默认值。服务商出新版时
 *  只需把新名字插到数组头部，用户点一下 chip 即可升级 */
export interface ModelPreset {
  value: string;
  label: string;
  baseUrl: string;
  models: string[];
}

/* 已被厂商正式停用的模型名 → 官方替代名（2026-07 DeepSeek 停用
   deepseek-chat / deepseek-reasoner）。只列确定停用的；「不在推荐列表」
   不算停用——用户可能在用我们预设还没收录的新模型，误报比漏报更糟 */
export const DEPRECATED_MODELS: Record<string, string> = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'kimi-k2-0905-preview': 'kimi-k3',
};

/* 模型列表会话内缓存（按地址）：⟳ 拉一次后切页 / 切回来不再重拉 */
const modelListCache = new Map<string, string[]>();

export function cachedModelList(baseUrl: string): string[] | null {
  return modelListCache.get(baseUrl.trim()) ?? null;
}

export function cacheModelList(baseUrl: string, list: string[]): void {
  modelListCache.set(baseUrl.trim(), list);
}

/* 手动输入过的模型名（跨重启记忆）：datalist 补全提示，免得每次重敲 */
const MODEL_HISTORY_KEY = 'sn:model-history';

export function modelHistory(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(MODEL_HISTORY_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberModel(model: string): void {
  const v = model.trim();
  if (!v) return;
  try {
    const cur = modelHistory().filter((x) => x !== v);
    localStorage.setItem(MODEL_HISTORY_KEY, JSON.stringify([v, ...cur].slice(0, 8)));
  } catch {
    /* 隐私模式等 localStorage 不可写：跳过记忆 */
  }
}

/** 从预设列表里按生效地址找当前命中的预设（找不到返回 null，如自定义地址） */
export function matchPreset<T extends ModelPreset>(
  presets: readonly T[],
  baseUrl: string,
): T | null {
  return presets.find((p) => p.baseUrl !== '' && p.baseUrl === baseUrl.trim()) ?? null;
}

/** 模型选择：输入框（datalist 下拉）+ 获取列表按钮 + 预设候选 chips 一键切换
 *  + 停用模型升级提示。datalist 合并预设候选、已获取列表与手动输入历史
 *  （候选在前、去重）——「⟳ 获取」依赖服务商实现且有的不支持 /v1/models，
 *  预设 chips 保证常见厂商开箱可选 */
export function ModelInput({
  value,
  onChange,
  listId,
  candidates = [],
  modelList = null,
  fetching,
  onFetch,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  /** datalist 元素 id（同页多处使用时需不同 id） */
  listId: string;
  /** 当前命中预设的推荐模型；无命中时为空，仅显示输入框 */
  candidates?: readonly string[];
  /** 「⟳ 获取」到的模型列表；null = 尚未获取过 */
  modelList?: string[] | null;
  fetching: boolean;
  onFetch: () => void;
  placeholder?: string;
}) {
  const merged = [
    ...new Set([...candidates, ...(modelList ?? []), ...modelHistory()]),
  ];
  const deprecation = DEPRECATED_MODELS[value.trim()];
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <input
          list={listId}
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => rememberModel(value)}
          placeholder={placeholder}
          className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-sky-500/60 focus:ring-2 focus:ring-sky-500/15"
        />
        <Button onClick={onFetch} disabled={fetching} title="从接口获取模型列表">
          {fetching ? <Spinner size={13} /> : '⟳'}
        </Button>
      </div>
      <datalist id={listId}>
        {merged.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {deprecation && (
        <div className="flex flex-wrap items-center gap-1 text-[11px] leading-4 text-amber-300/90">
          <span>⚠ 「{value.trim()}」已被厂商停用（调用会失败）</span>
          <button
            type="button"
            onClick={() => onChange(deprecation)}
            className="text-sky-400 underline decoration-sky-400/40 underline-offset-2 transition hover:text-sky-300"
          >
            切换到 {deprecation} ›
          </button>
        </div>
      )}
      {candidates.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10.5px] text-slate-600">推荐</span>
          {candidates.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onChange(m)}
              title={m === candidates[0] ? '当前预设推荐的默认模型' : m}
              className={`rounded-full border px-2 py-0.5 font-mono text-[10.5px] transition ${
                value === m
                  ? 'border-sky-400/50 bg-sky-400/10 text-sky-300'
                  : 'border-white/10 bg-white/[0.04] text-slate-400 hover:border-white/25 hover:text-slate-200'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}



/** 新建凭据组的临时 id：时间戳 base36 + 4 位随机后缀（同一毫秒内多次新建也不碰撞） */
export function newProviderId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* 延迟提交的数字输入：键入期间不钳制（避免“一清空就弹回默认值”），
   失焦或按 Enter 时才规范化并提交；空值按各字段 normalize 内的默认回退 */
export function NumberInput({
  value,
  normalize,
  onCommit,
  placeholder,
}: {
  value: number;
  normalize: (v: string) => number;
  onCommit: (n: number) => void;
  placeholder?: string;
}) {
  const [raw, setRaw] = useState<string | null>(null); // null = 未在编辑，展示配置值
  /* 外部值跟踪：托盘/其他窗口改了配置（value 换成不同数值）时同步显示，
     不让编辑框留着过时文本；键入本身不改变 value，不会被此逻辑打断 */
  const lastExternalRef = useRef(value);
  if (value !== lastExternalRef.current) {
    lastExternalRef.current = value;
    setRaw(null);
  }
  return (
    <TextInput
      mono
      value={raw ?? String(value)}
      placeholder={placeholder}
      onChange={(v) => setRaw(v)}
      onBlur={() => {
        if (raw === null) return;
        const n = normalize(raw);
        setRaw(null);
        if (n !== value) onCommit(n);
      }}
      onKeyDown={(e) => {
        // Enter 视同失焦：立即规范化并提交
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}
