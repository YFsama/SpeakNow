/* ============ SpeakNow 标志（回声涟漪） ============
   设计：中央声源圆点 + 两条向上开口的同心弧——读作「声波向外扩散」，
   也读作「记忆涟漪回荡」（语音输入 × 记忆库的双重隐喻）。几何与旧版
   麦克风的托弧同源，升级无突兀感；三元素在 16px 托盘尺寸仍可辨。
   坐标：24 网格；弧圆心 (12,16)，半径 7/11，弧段 200°→340°（上开口）。 */

const ARC_INNER = 'M5.42 13.6A7 7 0 0 1 18.58 13.6';
const ARC_OUTER = 'M1.66 12.24A11 11 0 0 1 22.34 12.24';

/** 线性版：单色 currentColor（描边弧 + 实心点）——放在渐变底/纯色底上用 */
export function LogoMark({ size = 17, strokeWidth = 2.2 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      aria-hidden
    >
      <path d={ARC_INNER} />
      <path d={ARC_OUTER} />
      <circle cx="12" cy="13.5" r="3.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 徽章版：强调色渐变圆角方底 + 白色涟漪——侧栏 / Dashboard hero / 关于页用。
 *  渐变两端走主题变量，随 accent 主题联动（变量缺省时回退天青/靛蓝）；
 *  自带玻璃光泽（顶部高光线 + 底部暗缘）与悬停涟漪呼吸（styles.css .logo-badge），
 *  因此这里不复用 LogoMark 而是给弧线挂上动画类 */
export function LogoBadge({
  size = 48,
  radiusRatio = 0.24,
  className = '',
}: {
  size?: number;
  /** 圆角比例（0~0.5）：48px 小徽章用小圆角，96px+ 大版用 squircle 感 */
  radiusRatio?: number;
  className?: string;
}) {
  return (
    <span
      className={`logo-badge inline-flex items-center justify-center ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * radiusRatio),
        background:
          'linear-gradient(135deg, var(--sn-accent, #38bdf8), var(--sn-accent-2, #6366f1))',
        // 双层外光（accent 辉光 + 深色立体）+ 双层内光（顶部高光线 + 底部暗缘）= 玻璃键帽质感
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -1px 0 rgba(0,0,0,0.16), 0 ${Math.round(
          size / 14,
        )}px ${Math.round(size / 5)}px -${Math.round(size / 10)}px color-mix(in srgb, var(--sn-accent, #38bdf8) 50%, transparent), 0 2px 5px rgba(2,6,23,0.35)`,
      }}
      aria-hidden
    >
      <svg
        width={Math.round(size * 0.62)}
        height={Math.round(size * 0.62)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#fff"
        strokeWidth={2.2}
        strokeLinecap="round"
      >
        <path className="logo-arc logo-arc-1" d={ARC_INNER} />
        <path className="logo-arc logo-arc-2" d={ARC_OUTER} />
        <circle cx="12" cy="13.5" r="3.5" fill="#fff" stroke="none" />
      </svg>
    </span>
  );
}
