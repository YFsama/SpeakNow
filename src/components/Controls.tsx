import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

/* ============ 通用卡片区块 ============ */

export function Section({
  icon,
  title,
  desc,
  children,
}: {
  icon: ReactNode;
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <section className="group relative overflow-hidden rounded-[20px] border border-white/[0.07] bg-white/[0.025] p-5 shadow-sm transition-colors hover:border-white/[0.12]">
      {/* 顶部微光渐变线 */}
      <span
        className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-sky-400/30 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100"
        aria-hidden
      />
      <div className="mb-5 flex items-start gap-3">
        <span className="card-lift relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/[0.07] bg-gradient-to-br from-sky-500/[0.16] via-indigo-500/[0.1] to-transparent text-[16px] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold leading-6 tracking-wide text-slate-100">
            {title}
          </h2>
          {desc && (
            <p className="mt-1 text-xs leading-5 text-slate-400/90">{desc}</p>
          )}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  badge,
  children,
}: {
  label: string;
  hint?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[13px] font-medium text-slate-300/90">{label}</span>
        {badge}
      </div>
      {hint && (
        <div className="mb-2 flex gap-1.5 text-xs leading-5 text-slate-500">
          <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-600" aria-hidden />
          <span>{hint}</span>
        </div>
      )}
      {children}
    </div>
  );
}

/* ============ 输入控件 ============ */

const inputBase =
  'w-full rounded-xl border border-white/10 bg-black/30 px-3.5 py-2.5 text-[13px] text-slate-100 outline-none transition placeholder:text-slate-600 hover:border-white/[0.18] hover:bg-black/[0.38] focus:border-sky-500/60 focus:bg-black/[0.42] focus:ring-[3px] focus:ring-sky-500/10';

/* 密码显隐眼睛图标（线性 stroke 风格，与整体一致） */
function EyeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
function EyeOffIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2 12s3.6-6.5 10-6.5c2.2 0 4 .8 5.4 1.9M22 12s-3.6 6.5-10 6.5c-2.2 0-4-.8-5.4-1.9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.5 19.5 19.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  mono = false,
  onBlur,
  onKeyDown,
}: {
  value: string | null | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
  /** 失焦回调：供延迟提交类输入（如数字钳制字段）在 blur 时规范化提交 */
  onBlur?: () => void;
  /** 按键回调：如数字输入按 Enter 视同失焦立即提交 */
  onKeyDown?: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
}) {
  // type=password 时右侧提供显隐切换；spellCheck=false 语义保持不变
  const isPwd = type === 'password';
  const [reveal, setReveal] = useState(false);
  return (
    <div className="relative">
      <input
        type={isPwd && reveal ? 'text' : type}
        value={value ?? ''}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        className={`${inputBase} ${mono ? 'font-mono text-xs leading-6' : ''} ${isPwd ? 'pr-11' : ''}`}
      />
      {isPwd && (
        <button
          type="button"
          onClick={() => setReveal((v) => !v)}
          aria-label={reveal ? '隐藏密码' : '显示密码'}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 text-slate-500 transition hover:text-slate-300"
        >
          {reveal ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      )}
    </div>
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
  onKeyDown,
}: {
  value: string | null | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  /** 按键回调：如工作台 Ctrl+Enter 直接触发翻译 */
  onKeyDown?: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  return (
    <textarea
      value={value ?? ''}
      placeholder={placeholder}
      spellCheck={false}
      rows={rows}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      className={`${inputBase} resize-y leading-6`}
    />
  );
}

export function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="relative">
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputBase} appearance-none pr-10`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-[#12121a]">
            {o.label}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-500"
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
      >
        <path
          d="M6 9l6 6 6-6"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/* ============ 开关 / 分段选择 ============ */

export function Toggle({
  checked,
  onChange,
  label,
  desc,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  desc?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`flex w-full items-center justify-between gap-4 rounded-2xl border px-3.5 py-3 text-left transition ${
        checked
          ? 'border-sky-500/25 bg-sky-500/[0.05] hover:border-sky-500/40'
          : 'border-white/[0.06] bg-black/20 hover:border-white/15'
      }`}
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-slate-200">
          {label}
        </span>
        {desc && (
          <span className="mt-0.5 block text-xs leading-4 text-slate-500">
            {desc}
          </span>
        )}
      </span>
      <span
        className={`relative h-6 w-11 shrink-0 rounded-full transition-all duration-300 ${
          checked
            ? 'bg-gradient-to-r from-sky-500 to-indigo-500 shadow-[0_0_12px_rgba(56,189,248,0.4)]'
            : 'bg-slate-700/90 shadow-[inset_0_1px_3px_rgba(0,0,0,0.4)]'
        }`}
      >
        <span
          className={`spring-thumb absolute top-0.5 h-5 w-5 rounded-full shadow-md transition-all ${
            checked ? 'left-[22px]' : 'left-0.5'
          } ${checked ? 'bg-white' : 'bg-slate-300/80'}`}
        />
      </span>
    </button>
  );
}

/* 列数映射表：类名必须是完整字面量，动态拼接 Tailwind 扫不到（JIT 不生成） */
const SEGMENTED_COLS: Record<number, string> = {
  1: '',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4',
};

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; desc?: string }[];
}) {
  const cols = SEGMENTED_COLS[options.length] ?? 'sm:grid-cols-3';
  return (
    <div className={`grid grid-cols-1 gap-2 ${cols}`}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`card-lift relative overflow-hidden rounded-2xl border px-3.5 py-2.5 text-left transition active:scale-[0.98] ${
              active
                ? 'border-sky-500/70 bg-gradient-to-br from-sky-500/[0.12] to-indigo-500/[0.08] shadow-[0_0_18px_-6px_rgba(56,189,248,0.45)]'
                : 'border-white/[0.08] bg-black/20 hover:border-white/20 hover:bg-black/[0.3]'
            }`}
          >
            {active && (
              <span
                className="absolute right-2.5 top-2.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-sky-400/20"
                aria-hidden
              >
                <span className="h-1.5 w-1.5 rounded-full bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.9)]" />
              </span>
            )}
            <span
              className={`block text-[13px] font-medium ${
                active ? 'text-sky-300' : 'text-slate-200'
              }`}
            >
              {o.label}
            </span>
            {o.desc && (
              <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">
                {o.desc}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ============ 单选卡片外壳（键盘/读屏可达） ============ */

/** 选择卡的语义化外壳：div + role="radio" + roving tabindex + 合成键盘操作。
    用 div 而非 button 是刻意的——卡片内部常含子按钮（⚡测试 / ↓下载 / 🗑删除），
    button 嵌套 button 是无效 HTML（React 告警 validateDOMNesting，读屏播报降级）；
    Enter/Space 由 onKeyDown 合成触发（带 e.target 守卫，不劫持卡内子按钮），
    方向键在组内兄弟卡间移动焦点并选中（WAI-ARIA radiogroup 模式）。
    不自带任何选中样式——选中态视觉差异由使用方经 className/children 传入；
    本组件只补焦点环与指针光标。roving tabindex：选中项 0、其余 -1；组内
    无选中项时第一张卡兜底 0（见 useEffect）。容器需标 role="radiogroup" + aria-label */
export function RadioCard({
  checked,
  onCheck,
  children,
  className = '',
  disabled = false,
  title,
}: {
  checked: boolean;
  onCheck: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  /* roving tabindex 兜底：组内无任何选中项（如已保存设备被拔出）时，
     第一张卡保持可聚焦，避免整组被 Tab 跳过。直接改 DOM 的 tabIndex 与
     React 属性共存——prop 值不变时 React 不会回写覆盖，本副作用每次
     渲染后自纠 */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (checked) {
      el.tabIndex = 0;
      return;
    }
    const group = el.parentElement;
    const hasChecked = !!group?.querySelector('[role="radio"][aria-checked="true"]');
    const isFirst = group?.querySelector('[role="radio"]') === el;
    el.tabIndex = !hasChecked && isFirst ? 0 : -1;
  });

  return (
    <div
      ref={ref}
      role="radio"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={checked ? 0 : -1}
      onClick={disabled ? undefined : onCheck}
      onKeyDown={(e) => {
        if (disabled) return;
        /* 只处理落在本卡上的按键：卡内子按钮（⚡测试 / ↓下载 / 🗑删除）的
           Enter/Space 冒泡到此处时不得劫持——否则键盘触发子按钮会变成选中整卡 */
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onCheck();
          return;
        }
        /* WAI-ARIA radiogroup 方向键导航：焦点与选中一起移到上/下一张卡 */
        const dir =
          e.key === 'ArrowLeft' || e.key === 'ArrowUp'
            ? -1
            : e.key === 'ArrowRight' || e.key === 'ArrowDown'
              ? 1
              : 0;
        if (dir === 0) return;
        e.preventDefault();
        const cards = [
          ...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
            '[role="radio"]:not([aria-disabled="true"])',
          ) ?? []),
        ];
        const i = cards.indexOf(e.currentTarget);
        const next = cards[(i + dir + cards.length) % cards.length];
        if (next && next !== e.currentTarget) {
          next.focus();
          next.click();
        }
      }}
      title={title}
      className={`cursor-pointer focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:outline-none ${className}`}
    >
      {children}
    </div>
  );
}

/* ============ 按钮 ============ */

export function Button({
  children,
  onClick,
  kind = 'ghost',
  disabled,
  full = false,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'ghost' | 'danger' | 'subtle';
  disabled?: boolean;
  full?: boolean;
  /** 悬停提示 */
  title?: string;
}) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100';
  const kinds = {
    primary:
      'bg-gradient-to-r from-sky-500 to-indigo-500 text-white shadow-lg shadow-sky-500/20 hover:brightness-110 hover:shadow-sky-500/35',
    ghost:
      'border border-white/10 bg-black/20 text-slate-200 hover:border-white/25 hover:bg-black/35',
    subtle:
      'bg-white/[0.05] text-slate-300 hover:bg-white/[0.09] hover:text-slate-100',
    danger:
      'border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20',
  } as const;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${kinds[kind]} ${full ? 'w-full' : ''}`}
    >
      {children}
    </button>
  );
}

/* ============ 两段式确认按钮 ============ */

/** 危险操作的行内二次确认：首击进入待确认态（红色、文案切换、timeoutMs 后自动复位），
    再击才触发 onConfirm。替代各处手写的 state+timer 模式（如 HistoryTab 的删除确认）。 */
export function ConfirmButton({
  label,
  confirmLabel = '确认执行？',
  onConfirm,
  className = '',
  timeoutMs = 3500,
  title,
}: {
  label: ReactNode;
  confirmLabel?: ReactNode;
  onConfirm: () => void;
  className?: string;
  /** 待确认态无操作多久自动复位 */
  timeoutMs?: number;
  /** 悬停提示（透传原生 title） */
  title?: string;
}) {
  const [arming, setArming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const reset = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setArming(false);
  };

  const onClick = () => {
    if (!arming) {
      setArming(true);
      timerRef.current = setTimeout(reset, timeoutMs);
      return;
    }
    reset();
    onConfirm();
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex items-center justify-center gap-1.5 rounded-full border px-4 py-2 text-[13px] font-medium transition active:scale-[0.97] ${
        arming
          ? 'border-red-400/30 bg-red-500/15 text-red-300'
          : 'border-white/10 bg-black/20 text-slate-200 hover:border-white/25 hover:bg-black/35'
      } ${className}`}
    >
      {arming ? confirmLabel : label}
    </button>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-sky-400/30 border-t-sky-400"
      style={{ width: size, height: size }}
    />
  );
}
