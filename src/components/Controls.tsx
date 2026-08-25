import type { ReactNode } from 'react';

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

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  mono = false,
}: {
  value: string | null | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
}) {
  return (
    <input
      type={type}
      value={value ?? ''}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputBase} ${mono ? 'font-mono text-xs leading-6' : ''}`}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string | null | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      value={value ?? ''}
      placeholder={placeholder}
      spellCheck={false}
      rows={rows}
      onChange={(e) => onChange(e.target.value)}
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

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; desc?: string }[];
}) {
  const cols = options.length <= 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3';
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

/* ============ 按钮 ============ */

export function Button({
  children,
  onClick,
  kind = 'ghost',
  disabled,
  full = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'ghost' | 'danger' | 'subtle';
  disabled?: boolean;
  full?: boolean;
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
      className={`${base} ${kinds[kind]} ${full ? 'w-full' : ''}`}
    >
      {children}
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
