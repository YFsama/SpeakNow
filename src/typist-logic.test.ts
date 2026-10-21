import { describe, expect, it } from 'vitest';
import {
  SPEED_LEVELS,
  levelFromCharMs,
  lineDelayFor,
  remainingAfter,
} from './typist-logic';

describe('输入速度档位', () => {
  it('档位单调递增（快 → 慢）且毫秒值唯一', () => {
    const ms = SPEED_LEVELS.map((s) => s.ms);
    for (let i = 1; i < ms.length; i++) {
      expect(ms[i]!).toBeGreaterThan(ms[i - 1]!);
    }
    expect(new Set(ms).size).toBe(ms.length);
  });

  it('自定义毫秒落到最近档（15 → 标准 12，而非稳妥 28）', () => {
    expect(levelFromCharMs(15)).toBe(levelFromCharMs(12));
    expect(SPEED_LEVELS[levelFromCharMs(15)]!.ms).toBe(12);
    expect(SPEED_LEVELS[levelFromCharMs(40)]!.ms).toBe(45);
    // 超出两端的值钳到端点档
    expect(SPEED_LEVELS[levelFromCharMs(1)]!.ms).toBe(3);
    expect(SPEED_LEVELS[levelFromCharMs(500)]!.ms).toBe(80);
  });

  it('行停顿随每键间隔缩放并钳在 40~800ms', () => {
    expect(lineDelayFor(3)).toBe(40); // 3×8=24 → 下限 40
    expect(lineDelayFor(12)).toBe(96);
    expect(lineDelayFor(80)).toBe(640);
    expect(lineDelayFor(200)).toBe(800); // 1600 → 上限 800
  });
});

describe('remainingAfter（中止后续输剩余文本）', () => {
  it('done=0 返回全文，done=总数返回空串', () => {
    expect(remainingAfter('abc', 0)).toBe('abc');
    expect(remainingAfter('abc', 3)).toBe('');
    expect(remainingAfter('', 0)).toBe('');
  });

  it('按码点切分，emoji 不被代理对劈开', () => {
    const t = '🎉🎉中';
    expect(remainingAfter(t, 1)).toBe('🎉中');
    expect(remainingAfter(t, 3)).toBe('');
  });

  it('CRLF 只算一次按键，剩余从第 done 个按键之后切', () => {
    // 'a\r\nb'：有效按键 a、\n(回车)、b。done=1（只敲了 a）时 \r\n 都还没
    // 处理——剩余含 \r\n，续输时会再跳过 \r、按一次回车
    const t = 'a\r\nb';
    expect(remainingAfter(t, 1)).toBe('\r\nb');
    expect(remainingAfter(t, 2)).toBe('b');
    expect(remainingAfter(t, 3)).toBe('');
  });

  it('孤立 \\r 与 Tab 都计入按键', () => {
    // done=1 敲完 a：孤立的 \r 是第 2 个按键（回车），还没敲——留在剩余里
    expect(remainingAfter('a\rb', 1)).toBe('\rb');
    expect(remainingAfter('a\rb', 2)).toBe('b');
    expect(remainingAfter('a\tb', 1)).toBe('\tb');
  });

  it('控制字符不计入计数，未处理过的保留在剩余里（续输时再跳一次）', () => {
    // 'a\x00b'：\x00 不产生按键。done=1（敲完 a）时 \x00 还没被越过——
    // 剩余含 \x00 与 b；续输会跳过 \x00 只敲 b，内容不丢
    expect(remainingAfter('a\x00b', 1)).toBe('\x00b');
    expect(remainingAfter('a\x7fb', 2)).toBe('');
    // 控制字符夹在 done 边界后：剩余从第 done 个按键之后整段带走
    expect(remainingAfter('ab\x00c', 2)).toBe('\x00c');
  });

  it('done 超过总数（异常输入）安全返回空串', () => {
    expect(remainingAfter('ab', 99)).toBe('');
  });
});
