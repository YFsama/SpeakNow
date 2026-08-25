import { useEffect, useState } from 'react';
import { shortcutChips } from '../api';

const MODS = new Set(['Control', 'Shift', 'Alt', 'Meta']);
// JS KeyboardEvent.code 与 keyboard-types Code 名的差异映射
const CODE_FIX: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

export default function HotkeyRecorder({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!capturing) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(false);
        return;
      }
      if (MODS.has(e.key) || e.repeat) return;
      const parts: string[] = [];
      if (e.ctrlKey) parts.push('ctrl');
      if (e.altKey) parts.push('alt');
      if (e.shiftKey) parts.push('shift');
      if (e.metaKey) parts.push('meta');
      parts.push(CODE_FIX[e.code] ?? e.code);
      onChange(parts.join('+'));
      setCapturing(false);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [capturing, onChange]);

  const chips = shortcutChips(value);

  return (
    <button
      type="button"
      onClick={() => setCapturing((c) => !c)}
      className={`flex min-h-[42px] w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-medium transition active:scale-[0.99] ${
        capturing
          ? 'animate-pulse border-sky-500/70 bg-sky-500/10 text-sky-300'
          : 'border-white/10 bg-black/30 hover:border-white/25'
      }`}
    >
      {capturing ? (
        <span className="text-sky-300">请按下组合键（按 Esc 取消）…</span>
      ) : chips.length > 0 ? (
        chips.map((c, i) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-slate-600">+</span>}
            <span className="kbd">{c}</span>
          </span>
        ))
      ) : (
        <span className="text-slate-400">点击后按下快捷键</span>
      )}
    </button>
  );
}
