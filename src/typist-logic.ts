/* ============ 文本模拟输入的纯逻辑（无 Tauri / React 依赖，可单测） ============ */

/* ---------- 输入速度档位（滑杆用） ---------- */

/** 速度档位（快 → 慢），ms 为每键间隔。间隔按指数曲线铺开：慢端档距大
 *  （丢字场景需要大步降速），快端档距小（快场景追求细调） */
export const SPEED_LEVELS: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 3, label: '风驰' },
  { ms: 5, label: '快速' },
  { ms: 8, label: '利落' },
  { ms: 12, label: '标准' },
  { ms: 18, label: '从容' },
  { ms: 28, label: '稳妥' },
  { ms: 45, label: '慢速' },
  { ms: 80, label: '极稳' },
];

/** 行停顿随每键间隔缩放（×8），下限 40ms 上限 800ms：快档行停顿不必等比
 *  缩到没有（回车的异步响应仍在），慢档不必无限放大 */
export function lineDelayFor(charMs: number): number {
  return Math.min(800, Math.max(40, Math.round(charMs * 8)));
}

/** 配置里的每键间隔 → 最近的档位下标（自定义值也能落到最接近的档显示） */
export function levelFromCharMs(ms: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < SPEED_LEVELS.length; i++) {
    const d = Math.abs(SPEED_LEVELS[i]!.ms - ms);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/* ---------- 中止续输 ---------- */

/**
 * 中止后续输剩余文本：给定已完成的有效按键数 done，返回尚未敲入的部分。
 * 切点在第 done 个有效按键**之后**——其后未被处理过的控制字符（后端
 * 本会跳过它们）保留在剩余里，续输时再跳一次即可，不丢内容。
 * 按键判定与后端 typist.rs 的 classify 严格一致：`\r\n` 只算一次回车
 * （记在 `\n` 上）、孤立 `\r` 算回车、Tab 算一次、其余控制字符不计入，
 * 否则前端切片与后端实际敲入的位置会错位（差一个字符就全盘错位）。
 */
export function remainingAfter(text: string, done: number): string {
  if (done <= 0) return text;
  const chars = [...text];
  let taps = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const next = i + 1 < chars.length ? chars[i + 1] : undefined;
    const isTap =
      c === '\r'
        ? next !== '\n' // \r\n 的 \r 跳过，回车记在 \n 上
        : c === '\n' || c === '\t' || !(c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
    if (!isTap) continue;
    taps++;
    if (taps === done) {
      // 第 done 个按键刚敲完，其后（含未处理的跳过字符）都是剩余
      return chars.slice(i + 1).join('');
    }
  }
  return '';
}
