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
  // 裸单键被拒时的提示：录入 A/Tab/Space 这类无修饰键会注册成全局热键，全系统打字被拦
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!capturing) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setErr('');
        setCapturing(false);
        return;
      }
      // 录制态按 Backspace/Delete = 清除该槽位：写入空串（后端 hotkey.rs 对空串
      // 跳过注册，等价「未设置」），给出此前没有的解绑入口
      if (e.key === 'Backspace' || e.key === 'Delete') {
        setErr('');
        onChange('');
        setCapturing(false);
        return;
      }
      if (MODS.has(e.key) || e.repeat) return;
      const parts: string[] = [];
      if (e.ctrlKey) parts.push('ctrl');
      if (e.altKey) parts.push('alt');
      if (e.shiftKey) parts.push('shift');
      if (e.metaKey) parts.push('meta');
      // 仅主键无修饰键：全局热键会吞掉所有应用里对该键的正常输入，拒绝保存
      // 并留在录制态，让用户直接补按一个带修饰键的组合
      if (parts.length === 0) {
        setErr('请加 Ctrl/Alt/Shift/Win 修饰键，单键会拦截正常打字');
        return;
      }
      parts.push(CODE_FIX[e.code] ?? e.code);
      setErr('');
      onChange(parts.join('+'));
      setCapturing(false);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [capturing, onChange]);

  const chips = shortcutChips(value);

  return (
    <div className="w-full">
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
          // 录制态仍展示当前绑定键位（灰色禁用样式）：让「替换谁」可见
          chips.length > 0 ? (
            <>
              <span className="flex flex-wrap items-center justify-center gap-1.5 opacity-50 grayscale">
                {chips.map((c, i) => (
                  <span key={i} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-[11px] text-slate-600">+</span>}
                    <span className="kbd">{c}</span>
                  </span>
                ))}
              </span>
              <span className="ml-1.5 text-[11px] font-normal text-sky-300/90">
                将替换此键位 · Esc 取消 · Backspace 清除
              </span>
            </>
          ) : (
            <span className="text-sky-300">
              请按下组合键（Esc 取消 · Backspace 清除）
            </span>
          )
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
      {/* 拒绝提示样式与 HotkeyTab 的组合键重复警告一致（红字小号脚注） */}
      {err && <div className="mt-1.5 text-[11px] leading-4 text-red-400">{err}</div>}
    </div>
  );
}
