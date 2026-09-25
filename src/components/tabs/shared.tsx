import { useRef, useState } from 'react';
import { TextInput } from '../Controls';
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
