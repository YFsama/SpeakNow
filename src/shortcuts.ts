/**
 * 快捷键描述串的纯格式化逻辑（无环境依赖，单测友好）。
 * api.ts 保留同名包装（按运行平台选 mac/win 字形），调用方零改动。
 */

const CODE_LABELS: Record<string, string> = {
  Space: 'Space',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Insert: 'Ins',
  Delete: 'Del',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Return: 'Enter',
  Enter: 'Enter',
  Escape: 'Esc',
  Tab: 'Tab',
  CapsLock: 'Caps',
};

/** 把单个按键名格式化为用户可读形式；mac=true 时修饰键用 ⌃⌥⇧⌘ 字形 */
export function prettyPart(part: string, mac: boolean): string {
  const k = part.toLowerCase();
  if (k === 'ctrl' || k === 'control') return mac ? '⌃' : 'Ctrl';
  if (k === 'alt' || k === 'option') return mac ? '⌥' : 'Alt';
  if (k === 'shift') return mac ? '⇧' : 'Shift';
  if (k === 'meta' || k === 'cmd' || k === 'super' || k === 'win')
    return mac ? '⌘' : 'Win';
  if (/^Key[A-Z]$/.test(part)) return part.slice(3);
  if (/^Digit\d$/.test(part)) return part.slice(5);
  if (/^F\d{1,2}$/.test(part)) return part;
  if (/^Numpad\d$/.test(part)) return 'Num' + part.slice(6);
  return CODE_LABELS[part] ?? part;
}

/** 拆分为可渲染的键位徽章数组：如 "ctrl+shift+Space" → ["Ctrl","Shift","Space"] */
export function shortcutChips(s: string, mac: boolean): string[] {
  if (!s) return [];
  return s
    .split('+')
    .filter(Boolean)
    .map((p) => prettyPart(p, mac));
}
