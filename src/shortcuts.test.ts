import { describe, expect, it } from 'vitest';
import { prettyPart, shortcutChips } from './shortcuts';

describe('prettyPart', () => {
  it('修饰键按平台输出字形（Windows / mac）', () => {
    expect(prettyPart('Ctrl', false)).toBe('Ctrl');
    expect(prettyPart('control', false)).toBe('Ctrl');
    expect(prettyPart('Ctrl', true)).toBe('⌃');
    expect(prettyPart('Alt', true)).toBe('⌥');
    expect(prettyPart('Shift', true)).toBe('⇧');
    // meta 的别名统一（win/cmd/super），大小写不敏感
    expect(prettyPart('Win', false)).toBe('Win');
    expect(prettyPart('cmd', true)).toBe('⌘');
    expect(prettyPart('SUPER', true)).toBe('⌘');
  });

  it('code 命名按键转可读形式', () => {
    expect(prettyPart('KeyA', false)).toBe('A');
    expect(prettyPart('KeyZ', true)).toBe('Z');
    expect(prettyPart('Digit5', false)).toBe('5');
    expect(prettyPart('F12', false)).toBe('F12');
    expect(prettyPart('Numpad7', false)).toBe('Num7');
    // CODE_LABELS 映射：标点与控制键
    expect(prettyPart('Comma', false)).toBe(',');
    expect(prettyPart('Return', false)).toBe('Enter');
    expect(prettyPart('Escape', false)).toBe('Esc');
  });

  it('未知名原样返回', () => {
    expect(prettyPart('StrangeKey', false)).toBe('StrangeKey');
  });
});

describe('shortcutChips', () => {
  it('按 + 拆分为徽章数组', () => {
    expect(shortcutChips('ctrl+shift+Space', false)).toEqual([
      'Ctrl',
      'Shift',
      'Space',
    ]);
    expect(shortcutChips('Control+Shift+Space', true)).toEqual(['⌃', '⇧', 'Space']);
  });

  it('空串与残缺分隔符安全', () => {
    expect(shortcutChips('', false)).toEqual([]);
    // 尾部悬空 + 产生的空段被过滤
    expect(shortcutChips('ctrl+', false)).toEqual(['Ctrl']);
    expect(shortcutChips('Alt++A', false)).toEqual(['Alt', 'A']);
  });
});
