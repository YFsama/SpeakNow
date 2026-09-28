import { useEffect, useRef, useState } from 'react';
import { ocrCancel, ocrRegionSelected } from '../api';

/**
 * 全屏截图取词条选层（overlay.html?ocr=N 路由，每屏一窗）。
 * 半透明遮罩 + 拖拽矩形：松开即回调物理换算后的逻辑矩形；
 * Esc / 右键 / 原地单击 = 取消。屏幕内容不冻结——确认瞬间后端按物理像素
 * 重截选区，所见即所识别。
 */

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const MIN_SIZE = 8; // 逻辑像素：小于此视为误触单击（取消）

export default function OcrSelect() {
  const [rect, setRect] = useState<Rect | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    // 选区窗必须完全透明（styles.css 为悬浮窗设置的背景不能带进来）
    document.body.style.background = 'transparent';
    document.documentElement.style.background = 'transparent';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void ocrCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const cancel = () => void ocrCancel();

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // 右键走 contextmenu 取消
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId); // 拖出窗口边界仍持续跟踪
    dragging.current = true;
    setRect({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    setCursor({ x: e.clientX, y: e.clientY });
    if (!dragging.current) return;
    setRect((r) => (r ? { ...r, x1: e.clientX, y1: e.clientY } : r));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !rect) return;
    dragging.current = false;
    // 终点直接取事件坐标（state 可能滞后一帧）
    const x = Math.min(rect.x0, e.clientX);
    const y = Math.min(rect.y0, e.clientY);
    const w = Math.abs(e.clientX - rect.x0);
    const h = Math.abs(e.clientY - rect.y0);
    if (w < MIN_SIZE || h < MIN_SIZE) {
      cancel(); // 原地单击：当作用户取消
      return;
    }
    void ocrRegionSelected(x, y, w, h);
  };

  const sel =
    rect &&
    Math.abs(rect.x1 - rect.x0) > 2 &&
    Math.abs(rect.y1 - rect.y0) > 2
      ? {
          left: Math.min(rect.x0, rect.x1),
          top: Math.min(rect.y0, rect.y1),
          width: Math.abs(rect.x1 - rect.x0),
          height: Math.abs(rect.y1 - rect.y0),
        }
      : null;

  return (
    <div
      className="fixed inset-0 select-none"
      style={{ cursor: 'crosshair' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        cancel();
      }}
    >
      {/* 未开始框选时的全屏轻遮罩 */}
      {!sel && (
        <div className="pointer-events-none fixed inset-0 bg-black/[0.14]" />
      )}
      {/* 十字准线：跟随光标的全宽/全高细线 + 实时坐标，起点看得准 */}
      {!sel && cursor && (
        <>
          <div
            className="pointer-events-none fixed left-0 w-full"
            style={{ top: cursor.y, height: 1, background: 'rgba(56,189,248,0.45)' }}
          />
          <div
            className="pointer-events-none fixed top-0 h-full"
            style={{ left: cursor.x, width: 1, background: 'rgba(56,189,248,0.45)' }}
          />
          <div
            className="pointer-events-none fixed -translate-x-1/2 whitespace-nowrap rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-sky-200"
            style={{ left: cursor.x, top: Math.min(cursor.y + 12, window.innerHeight - 24) }}
          >
            {Math.round(cursor.x)}, {Math.round(cursor.y)}
          </div>
        </>
      )}
      {sel && (
        <div
          className="pointer-events-none fixed border border-sky-400/90"
          style={{
            ...sel,
            // 巨量全向扩散的 box-shadow 从选区矩形向外压暗整屏，矩形内保持明亮（挖洞）
            boxShadow: `0 0 0 ${Math.max(
              window.innerWidth,
              window.innerHeight,
            )}px rgba(0,0,0,0.32), 0 0 18px rgba(2,132,199,0.25)`,
          }}
        >
          <div className="absolute -top-6 left-0 rounded bg-sky-500/90 px-1.5 py-0.5 text-[10px] font-medium text-white tabular-nums">
            {Math.round(sel.width)} × {Math.round(sel.height)}
          </div>
        </div>
      )}
      {!sel && (
        <div className="pointer-events-none absolute left-1/2 top-10 -translate-x-1/2 rounded-full border border-white/15 bg-black/55 px-3.5 py-1.5 text-[12px] text-slate-200 backdrop-blur-sm">
          拖拽框选要识别的区域 · Esc 取消
        </div>
      )}
    </div>
  );
}
