/* ============ 空态插画集（零依赖 SVG） ============
   统一视觉语言：细线 + 双灰阶 + 单 accent 点缀——
   · 主线：var(--sn-text-4) 半透明（opacity .55）、stroke-width 1.5、圆头、不填充
   · 结构面：var(--sn-surface-2) 填充 + var(--sn-border-strong) 1px 描边
   · 点缀：var(--sn-accent) 每张 1~2 处
   颜色全部走主题变量（不写 hex），深浅主题自动翻转；surface-2 是
   半透明叠加色，深色底呈暗面、浅色底呈浅灰面，两种底都成立。
   构图网格统一 viewBox 0 0 120 90；size 为渲染宽（默认 104），
   高 = 宽 × 3/4 ≈ 78px，落在 72~88px 区间。 */

export type EmptyArtName = 'history' | 'memory' | 'search' | 'hotkey' | 'star';

/** 主线组公共描边参数（子元素按需覆盖 opacity / stroke） */
const LINE = {
  stroke: 'var(--sn-text-4)',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  fill: 'none',
} as const;

/** 结构面的公共填充参数（键帽 / 卡片 / 抽屉前板） */
const FACE = {
  fill: 'var(--sn-surface-2)',
  stroke: 'var(--sn-border-strong)',
  strokeWidth: 1,
} as const;

/* history：话音散场——麦克风说完，声波一圈圈变短变淡走远 */
function HistoryArt() {
  return (
    <g>
      <g {...LINE} opacity={0.55}>
        {/* 小麦克风：胶囊 + 托弧 + 支杆 + 底座 */}
        <rect x="36" y="38" width="8" height="14" rx="4" />
        <path d="M31 44a9 9 0 0 0 18 0" />
        <path d="M40 53v6" />
        <path d="M34 59h12" />
      </g>
      {/* 三条同心弧逐条变短渐隐，末梢一点 accent 是散尽前的余音 */}
      <g {...LINE}>
        <path d="M55.3 35.5A18 18 0 0 1 55.3 54.5" opacity={0.6} />
        <path d="M65.5 36.2A27 27 0 0 1 65.5 53.8" opacity={0.35} />
        <path d="M75.3 38.1A36 36 0 0 1 75.3 51.9" stroke="var(--sn-accent)" opacity={0.15} />
      </g>
    </g>
  );
}

/* memory：记忆抽屉半开，两张小卡片正向上漂出来——用过的话自己浮上来 */
function MemoryArt() {
  return (
    <g>
      <g {...LINE} opacity={0.55}>
        {/* 抽屉腔体（U 形开口向上）+ 前板把手 */}
        <path d="M42 46V58H80V46" />
        <path d="M57 64h8" />
      </g>
      <rect x="38" y="58" width="46" height="12" rx="2" {...FACE} />
      {/* 上漂的两张卡片：距抽屉口 6 / 12 px，错位 + 微倾示意「升起」 */}
      <g transform="rotate(6 60 36)">
        <rect x="54" y="32" width="12" height="8" rx="1.5" {...FACE} />
      </g>
      <g transform="rotate(-8 72 30)">
        <rect x="66" y="26" width="12" height="8" rx="1.5" {...FACE} />
        {/* 折角：accent 点缀，记忆被「翻牌」标记 */}
        <path d="M75 26h3v3z" fill="var(--sn-accent)" stroke="none" />
      </g>
    </g>
  );
}

/* search：镜片里的波形正在消失——要找的那句话还没被记下来 */
function SearchArt() {
  return (
    <g>
      <g {...LINE} opacity={0.55}>
        <circle cx="52" cy="42" r="14" />
        {/* 镜内波形两条常亮 */}
        <path d="M46 38v8" />
        <path d="M52 34v15" />
        {/* 柄：自镜缘向右下 24° */}
        <path d="M64.8 47.7 77.6 53.4" strokeWidth={2} />
      </g>
      {/* 第三条波形半透明 accent——「消失中」的那一条 */}
      <path
        d="M58 39v7"
        stroke="var(--sn-accent)"
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
        opacity={0.45}
      />
    </g>
  );
}

/* hotkey：两枚空白键帽等着被点亮——设好快捷键，一切从此开始 */
function HotkeyArt() {
  return (
    <g>
      <rect x="38" y="50" width="16" height="16" rx="4" {...FACE} />
      <rect x="60" y="44" width="16" height="16" rx="4" {...FACE} />
      <g {...LINE} opacity={0.55}>
        {/* 两枚键帽各一枚「+」：待指派的空位 */}
        <path d="M43 58h6M46 55v6" />
        <path d="M65 52h6M68 49v6" />
      </g>
      {/* 右上角 accent 光点 + 两条放射短线：新快捷键的火花 */}
      <circle cx="86" cy="28" r="2.5" fill="var(--sn-accent)" stroke="none" />
      <g stroke="var(--sn-accent)" strokeWidth={1.5} strokeLinecap="round" fill="none" opacity={0.7}>
        <path d="M90.5 23.5l4-4" />
        <path d="M92 30.5l5 2" />
      </g>
    </g>
  );
}

/* star：虚线星形是还没落下的置顶位，卡片角上那颗实心小星在等它 */
const STAR = 'M0 -16L3.8 -5.2 15.2 -4.9 6.1 2 9.4 12.9 0 6.4 -9.4 12.9 -6.1 2 -15.2 -4.9 -3.8 -5.2Z';

function StarArt() {
  return (
    <g>
      <path
        d={STAR}
        transform="translate(56 36)"
        {...LINE}
        opacity={0.55}
        strokeDasharray="4 3"
      />
      <rect x="52" y="58" width="24" height="15" rx="2" {...FACE} />
      {/* 卡面两笔文字示意线 */}
      <path d="M56 64.5h14M56 68.5h9" {...LINE} opacity={0.4} strokeWidth={1} />
      {/* 卡片右上角 accent 实心小星（同 STAR 缩放 0.26） */}
      <path d={STAR} transform="translate(71 56) scale(0.26)" fill="var(--sn-accent)" stroke="none" />
    </g>
  );
}

function artOf(name: EmptyArtName) {
  switch (name) {
    case 'history':
      return <HistoryArt />;
    case 'memory':
      return <MemoryArt />;
    case 'search':
      return <SearchArt />;
    case 'hotkey':
      return <HotkeyArt />;
    case 'star':
      return <StarArt />;
  }
}

/** 空态插画：name 选构图，size 为渲染宽度（高 = 3/4 宽，默认 104×78） */
export function EmptyArt({ name, size = 104 }: { name: EmptyArtName; size?: number }) {
  return (
    <svg
      width={size}
      height={(size * 3) / 4}
      viewBox="0 0 120 90"
      fill="none"
      aria-hidden
      className="mx-auto block"
    >
      {artOf(name)}
    </svg>
  );
}

/** 「声波渐隐」横向装饰线（关于页 logo 下方）：与 history 空态同一弧线
    节奏——左侧三弧逐条渐淡，向右化作三段发丝线收尾；宽 120 / 高 16 / 最亮 0.5 */
export function SoundFadeLine() {
  return (
    <svg width={120} height={16} viewBox="0 0 120 16" fill="none" aria-hidden className="block">
      <g stroke="var(--sn-text-4)" strokeLinecap="round" fill="none">
        <path d="M4 1.5A6.5 6.5 0 0 1 4 14.5" strokeWidth={1.5} opacity={0.5} />
        <path d="M4 4A4 4 0 0 1 4 12" strokeWidth={1.5} opacity={0.3} />
        <path d="M4 6A2 2 0 0 1 4 10" strokeWidth={1.5} opacity={0.15} />
        <path d="M14 8h28" strokeWidth={1} opacity={0.3} />
        <path d="M48 8h28" strokeWidth={1} opacity={0.18} />
        <path d="M82 8h30" strokeWidth={1} opacity={0.08} />
      </g>
    </svg>
  );
}
