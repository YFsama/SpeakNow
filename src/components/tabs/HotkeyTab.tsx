import { useState } from 'react';
import { Field, Section, Segmented, Toggle } from '../Controls';
import HotkeyRecorder from '../HotkeyRecorder';
import type { TabProps } from '../../types';
import { langName } from '../../types';

/* ============ 快捷键 ============ */
type HotkeyField = 'key' | 'keyQuick' | 'keyTranslate';

const HOTKEY_FIELD_LABELS: Record<HotkeyField, string> = {
  key: '主快捷键',
  keyQuick: '快速模式',
  keyTranslate: '翻译模式',
};

export function HotkeyTab({ cfg, set }: TabProps) {
  // 组合键查重：同一组合注册到多个快捷键会在后端静默失效，录入重复值时
  // 拒绝写入（保留原值）并在对应录入器下显示红色警告，直到冲突解除
  const [dup, setDup] = useState<{
    edited: HotkeyField;
    other: HotkeyField;
    combo: string;
  } | null>(null);

  const applyKey = (field: HotkeyField, v: string) => {
    const fields: HotkeyField[] = ['key', 'keyQuick', 'keyTranslate'];
    const hit = fields.find(
      (f) => f !== field && cfg.hotkey[f] !== '' && cfg.hotkey[f] === v,
    );
    if (hit) {
      setDup({ edited: field, other: hit, combo: v });
      return;
    }
    setDup(null);
    if (field === 'key') set('hotkey', { key: v });
    else if (field === 'keyQuick') set('hotkey', { keyQuick: v });
    else set('hotkey', { keyTranslate: v });
  };

  // 渲染时复核冲突是否仍在（另一字段改走后警告自动消失）
  const dupLive =
    dup && cfg.hotkey[dup.other] === dup.combo ? dup : null;
  const dupWarning = (field: HotkeyField) =>
    dupLive?.edited === field ? (
      <div className="mt-1.5 text-[11px] leading-4 text-red-400">
        与「{HOTKEY_FIELD_LABELS[dupLive.other]}」组合键重复，已保留原设置；请换一个组合键
      </div>
    ) : null;

  return (
    <Section
      icon="⌨️"
      title="触发快捷键"
      desc="任意应用内全局触发，无需切换窗口；可另设快速键（跳过 AI）与翻译键（本次听写直接输出译文）。"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="主快捷键"
          hint={`当前为「${
            cfg.hotkey.mode === 'hold' ? '按住说话' : '按一下开始'
          }」模式，点击后直接录入新组合键`}
        >
          <HotkeyRecorder
            value={cfg.hotkey.key}
            onChange={(key) => applyKey('key', key)}
          />
          {dupWarning('key')}
        </Field>
        <Field
          label="快速模式（可选）"
          hint="识别后不经 AI 直接输出原文，追求最快速度时使用"
        >
          <HotkeyRecorder
            value={cfg.hotkey.keyQuick}
            onChange={(keyQuick) => applyKey('keyQuick', keyQuick)}
          />
          {dupWarning('keyQuick')}
        </Field>
      </div>
      <Field
        label="翻译模式（可选）"
        hint={`本次听写强制翻译：说完直接输出${langName(
          cfg.llm.translateTarget || 'en',
        )}译文（目标语言在「AI 优化」页或托盘菜单切换），不改默认模式`}
      >
        <HotkeyRecorder
          value={cfg.hotkey.keyTranslate}
          onChange={(keyTranslate) => applyKey('keyTranslate', keyTranslate)}
        />
        {dupWarning('keyTranslate')}
      </Field>
      <Field label="触发方式">
        <Segmented
          value={cfg.hotkey.mode}
          onChange={(mode) => set('hotkey', { mode })}
          options={[
            { value: 'toggle', label: '按一下开始', desc: '再按一下结束 · 适合长指令' },
            { value: 'hold', label: '按住说话', desc: '松开自动结束 · 节奏更快' },
          ]}
        />
      </Field>
      <Toggle
        checked={cfg.hotkey.enabled}
        onChange={(enabled) => set('hotkey', { enabled })}
        label="启用主快捷键"
        desc="关闭后仍可通过快速键、翻译键、托盘菜单或本页触发"
      />
    </Section>
  );
}
