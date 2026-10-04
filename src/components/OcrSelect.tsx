import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ocrCancel, ocrRegionSelected, ocrScreenSource } from '../api';

/**
 * 全屏截图取词条选层（overlay.html?ocr=N 路由，每屏一窗）。两阶段交互：
 *
 *   阶段一「画框」：pointerdown 起笔拖出矩形（十字准线 + 实时尺寸角标），
 *     Esc / 右键 / 原地单击（<8px）= 取消；
 *   阶段二「调整」：松手后选区保留不直接提交——四角手柄拖拽微调对应角
 *     （任一边 <8px 的缩放被整体拒绝，保持上一合法矩形，天然杜绝反向矩形），
 *     拖选区内部整体平移（钳制在视口内），Enter / 双击选区内部提交
 *     （ocrRegionSelected），Esc / 右键取消，点选区外重新画框。
 *
 * 小字号文本（代码、表格数字）框选易偏：调整态把「选偏只能整轮重来」
 * 变成「拖角两三像素微调后确认」。屏幕内容不冻结——确认瞬间后端按物理
 * 像素重截选区，所见即所识别。
 *
 * 放大镜：每轮起笔画框时异步截一次选区窗自身整窗 PNG，调整态拖角 /
 * 整体移动中在指针旁显示 3 倍镜头（十字准线正中对准被拖的角）。截屏
 * 失败或空 png（浏览器 mock / 后端不支持）时静默降级——无镜头，主流程不变。
 */

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type Corner = 'nw' | 'ne' | 'sw' | 'se';
/** 一次拖拽会话的模式：画新框 / 整体移动 / 拖某个角 */
type Grab = 'draw' | 'move' | Corner;

const MIN_SIZE = 8; // 逻辑像素：画框小于此视为误触单击（取消）；调整态缩放下限同值

/* 放大镜镜头：调整态拖拽中贴指针显示的截屏 3 倍放大视口 */
const LENS_W = 144; // 逻辑像素
const LENS_H = 108;
const LENS_GAP = 24; // 与指针的偏移；贴近视口右/下缘时翻转到左上
const LENS_ZOOM = 3;

/* 四角手柄：dx/dy 为该角在选区上的归一化位置（0/1）。可视圆点 10px、
   命中热区 16px（外层容器）；cursor 类名必须是完整字面量，Tailwind
   扫描不到运行时拼接的类名 */
const HANDLES: { key: Corner; dx: 0 | 1; dy: 0 | 1; cls: string }[] = [
  { key: 'nw', dx: 0, dy: 0, cls: 'cursor-nwse-resize' },
  { key: 'ne', dx: 1, dy: 0, cls: 'cursor-nesw-resize' },
  { key: 'sw', dx: 0, dy: 1, cls: 'cursor-nesw-resize' },
  { key: 'se', dx: 1, dy: 1, cls: 'cursor-nwse-resize' },
];

/* 拖拽进行中把根元素 cursor 钉成对应方向：pointer capture 会把后续事件
   （含 hover）重定向到根元素，手柄自身的 cursor 类在拖出后即失效 */
const DRAG_CURSOR: Record<Grab, string> = {
  draw: 'crosshair',
  move: 'move',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
};

export default function OcrSelect() {
  /** 交互阶段：draw=画框（含未起笔），adjust=松手后的调整态 */
  const [phase, setPhase] = useState<'draw' | 'adjust'>('draw');
  const [rect, setRect] = useState<Rect | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  /** 进行中的拖拽模式（驱动根元素 cursor 切换）；几何计算走 ref 免闭包过期 */
  const [drag, setDrag] = useState<Grab | null>(null);
  const dragRef = useRef<Grab | null>(null);
  /** 移动 / 拖角的锚点：按下时的指针坐标 + 当时的矩形快照（增量式，不漂移） */
  const anchorRef = useRef<{ px: number; py: number; rect: Rect } | null>(null);
  /** 放大镜底图：起笔画框时截的整窗 PNG（物理像素）。null = 本轮无镜头（降级） */
  const [shot, setShot] = useState<{ url: string; width: number; height: number } | null>(null);
  /** 截屏代次：复位 / 新一轮起笔时递增，丢弃迟到的旧结果 */
  const shotSeqRef = useRef(0);

  /** 起笔画框时截一次选区窗自身（每轮一次，非每次移动）。后端在起笔时机
   *  截屏时窗口尚无已绘制元素（设计前提）。失败 / 空 png 静默降级不报错 */
  const captureSource = async () => {
    const seq = ++shotSeqRef.current;
    setShot(null);
    try {
      const win = getCurrentWindow();
      const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
      const r = await ocrScreenSource(pos.x, pos.y, size.width, size.height);
      if (seq !== shotSeqRef.current) return; // 已被复位 / 新一轮截屏取代
      if (r?.png && r.width > 0 && r.height > 0) {
        setShot({ url: `data:image/png;base64,${r.png}`, width: r.width, height: r.height });
      }
    } catch {
      /* 浏览器 mock / 后端不支持：保持无镜头 */
    }
  };

  useEffect(() => {
    // 选区窗必须完全透明（styles.css 为悬浮窗设置的背景不能带进来）
    document.body.style.background = 'transparent';
    document.documentElement.style.background = 'transparent';
  }, []);

  /* 窗口复用复位：后端对已建的选区窗只 show 不重载页面（ocr.rs 复用分支），
     上一轮的调整态选区会原样留存——新一轮截图必须以干净的十字准线开场，
     否则旧选区上的 Enter 会把过期矩形真实提交。窗口重新可见/聚焦即复位 */
  useEffect(() => {
    const reset = () => {
      dragRef.current = null;
      anchorRef.current = null;
      shotSeqRef.current++; // 在途截屏作废：复位时清空缓存，新一轮重新截
      setShot(null);
      setDrag(null);
      setRect(null);
      setPhase('draw');
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') reset();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, []);

  // 键盘：Esc 任意阶段取消；Enter 仅调整态提交。rect 进依赖保证读到最新选区
  // 而非注册监听器时的旧闭包（重挂 addEventListener 的开销可忽略）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void ocrCancel();
      } else if (e.key === 'Enter' && phase === 'adjust' && rect) {
        const x = Math.min(rect.x0, rect.x1);
        const y = Math.min(rect.y0, rect.y1);
        const w = Math.abs(rect.x1 - rect.x0);
        const h = Math.abs(rect.y1 - rect.y0);
        if (w < MIN_SIZE || h < MIN_SIZE) return;
        e.preventDefault();
        void ocrRegionSelected(x, y, w, h);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, rect]);

  const cancel = () => void ocrCancel();

  /** 提交当前选区（Enter / 双击选区内部共用） */
  const submit = () => {
    if (!rect) return;
    const x = Math.min(rect.x0, rect.x1);
    const y = Math.min(rect.y0, rect.y1);
    const w = Math.abs(rect.x1 - rect.x0);
    const h = Math.abs(rect.y1 - rect.y0);
    if (w < MIN_SIZE || h < MIN_SIZE) return;
    void ocrRegionSelected(x, y, w, h);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.isPrimary) return; // 右键走 contextmenu 取消；只跟踪主指针
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId); // 拖出窗口边界仍持续跟踪
    } catch {
      /* 指针已消失（触控笔抬起等）：捕获失败不阻断起笔 */
    }
    const grab = (e.target as HTMLElement).closest?.('[data-grab]')?.getAttribute('data-grab');
    if (phase === 'adjust' && rect && grab && grab !== 'draw' && grab in DRAG_CURSOR) {
      // 调整态：命中手柄 / 选区内部（data-grab 由渲染层标注）
      dragRef.current = grab as Grab;
      setDrag(grab as Grab);
      anchorRef.current = { px: e.clientX, py: e.clientY, rect: { ...rect } };
      return;
    }
    // 未起笔 / 调整态点在选区外：（重新）画框
    dragRef.current = 'draw';
    setDrag('draw');
    setPhase('draw');
    setRect({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
    void captureSource(); // 异步截整窗作放大镜底图，不阻断起笔
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) return;
    /* draw 阶段全程跟随（十字准线）；adjust 阶段仅拖拽中跟随（放大镜锚点） */
    if (phase === 'draw' || dragRef.current) setCursor({ x: e.clientX, y: e.clientY });
    const g = dragRef.current;
    if (!g) return;
    /* 按键全松却仍有拖拽态（pointercancel 被系统吞掉 / 触控笔抬起）：
       结束拖拽，避免后续悬停移动继续改写选框 */
    if (e.buttons === 0) {
      dragRef.current = null;
      anchorRef.current = null;
      setDrag(null);
      return;
    }
    if (g === 'draw') {
      setRect((r) => (r ? { ...r, x1: e.clientX, y1: e.clientY } : r));
      return;
    }
    const a = anchorRef.current;
    if (!a) return;
    const dx = e.clientX - a.px;
    const dy = e.clientY - a.py;
    if (g === 'move') {
      // 整体平移：钳制在视口内，选区不会被整块拖出屏幕后找不回
      const w = a.rect.x1 - a.rect.x0;
      const h = a.rect.y1 - a.rect.y0;
      const x0 = Math.max(Math.min(a.rect.x0 + dx, window.innerWidth - w), 0);
      const y0 = Math.max(Math.min(a.rect.y0 + dy, window.innerHeight - h), 0);
      setRect({ x0, y0, x1: x0 + w, y1: y0 + h });
      return;
    }
    // 拖角：只动对应角；任一边 < MIN_SIZE 时放弃该帧更新（保持上一合法矩形）
    let { x0, y0, x1, y1 } = a.rect;
    if (g === 'nw') {
      x0 += dx;
      y0 += dy;
    } else if (g === 'ne') {
      x1 += dx;
      y0 += dy;
    } else if (g === 'sw') {
      x0 += dx;
      y1 += dy;
    } else {
      x1 += dx;
      y1 += dy;
    }
    if (Math.abs(x1 - x0) < MIN_SIZE || Math.abs(y1 - y0) < MIN_SIZE) return;
    setRect({ x0, y0, x1, y1 });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) return;
    const g = dragRef.current;
    if (!g || !rect) return;
    dragRef.current = null;
    setDrag(null);
    if (g !== 'draw') return; // 调整拖拽结束：保留选区，仍停留在调整态
    // 终点直接取事件坐标（state 可能滞后一帧）
    const x0 = Math.min(rect.x0, e.clientX);
    const x1 = Math.max(rect.x0, e.clientX);
    const y0 = Math.min(rect.y0, e.clientY);
    const y1 = Math.max(rect.y0, e.clientY);
    if (x1 - x0 < MIN_SIZE || y1 - y0 < MIN_SIZE) {
      cancel(); // 原地单击：当作用户取消
      return;
    }
    setRect({ x0, y0, x1, y1 }); // 归一化定格，作为调整态的初始矩形
    setPhase('adjust'); // 不再直接提交：先进入调整态
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

  /* 放大镜（仅 adjust 阶段拖拽中渲染）：镜头中心对准被拖的角（整体移动时
     对准指针）的 CSS 坐标。位图坐标 = CSS × devicePixelRatio；背景图按
     3 倍铺放，backgroundPosition = 镜头中心 - 目标点位图坐标 × 3（即负偏移
     方向平移，让目标点落在镜头正中）。位置走 transform，随现有 pointermove
     节奏逐帧更新；贴近视口右/下缘时翻转到指针左上，再做整体钳制兜底 */
  const lens = (() => {
    if (phase !== 'adjust' || !drag || drag === 'draw' || !shot || !cursor || !rect) return null;
    const dpr = window.devicePixelRatio || 1;
    /* 对准点取「随指针移动的那个角」：锚点矩形的对应边 + 指针位移。直接取
       rect.x0/x1 会在拖角越过对角（反向矩形）时对准不动的那只角 */
    const a = anchorRef.current;
    const aim =
      drag === 'move' || !a
        ? cursor
        : {
            x:
              (drag === 'nw' || drag === 'sw' ? a.rect.x0 : a.rect.x1) +
              (cursor.x - a.px),
            y:
              (drag === 'nw' || drag === 'ne' ? a.rect.y0 : a.rect.y1) +
              (cursor.y - a.py),
          };
    let x = cursor.x + LENS_GAP;
    let y = cursor.y + LENS_GAP;
    if (x + LENS_W > window.innerWidth - 8) x = cursor.x - LENS_W - LENS_GAP;
    if (y + LENS_H > window.innerHeight - 8) y = cursor.y - LENS_H - LENS_GAP;
    x = Math.max(8, Math.min(x, window.innerWidth - LENS_W - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - LENS_H - 8));
    return {
      x,
      y,
      bgSize: `${shot.width * LENS_ZOOM}px ${shot.height * LENS_ZOOM}px`,
      bgPos: `${LENS_W / 2 - aim.x * dpr * LENS_ZOOM}px ${LENS_H / 2 - aim.y * dpr * LENS_ZOOM}px`,
    };
  })();

  return (
    <div
      className="fixed inset-0 select-none"
      style={{ cursor: drag ? DRAG_CURSOR[drag] : 'crosshair' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        // 触控笔/触摸的指针捕获被系统取消：与松手同样收尾（保留选区，不提交）
        dragRef.current = null;
        anchorRef.current = null;
        setDrag(null);
      }}
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
          /* 调整态：选区本体可命中（整体移动）+ 双击提交；画框期保持穿透 */
          data-grab="move"
          onDoubleClick={submit}
          className={`fixed border border-sky-400/90 ${
            phase === 'adjust' ? 'cursor-move' : 'pointer-events-none'
          }`}
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
      {/* 调整态：四角手柄（16px 热区 > 10px 可视圆点，便于精确抓取） */}
      {phase === 'adjust' &&
        sel &&
        HANDLES.map((h) => (
          <div
            key={h.key}
            data-grab={h.key}
            className={`absolute flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center ${h.cls}`}
            style={{ left: sel.left + sel.width * h.dx, top: sel.top + sel.height * h.dy }}
          >
            <span className="pointer-events-none h-2.5 w-2.5 rounded-full border border-white/70 bg-sky-400 shadow-[0_0_5px_rgba(2,132,199,0.4)]" />
          </div>
        ))}
      {/* 调整态拖拽中的放大镜：3 倍镜头贴指针右下（贴边翻转）。无截屏数据时
          整体不渲染——静默降级，框选主流程不受影响；松手/取消/提交即随 drag 清空隐藏 */}
      {lens && shot && (
        <div
          className="pointer-events-none fixed left-0 top-0 z-50 overflow-hidden rounded-lg border border-white/20 bg-[#0b0b12] shadow-xl"
          style={{
            width: LENS_W,
            height: LENS_H,
            transform: `translate3d(${lens.x}px, ${lens.y}px, 0)`,
            backgroundImage: `url("${shot.url}")`,
            backgroundRepeat: 'no-repeat',
            backgroundSize: lens.bgSize,
            backgroundPosition: lens.bgPos,
          }}
        >
          {/* 快照角标：底图是起笔时的静态截屏，非实时画面 */}
          <span className="absolute right-1 top-1 rounded bg-black/55 px-1 text-[9px] leading-4 text-slate-300">
            快照
          </span>
          {/* 十字准线：两条 1px sky 细线交于镜头中心（0.5px 修正线宽偏移） */}
          <div
            className="absolute left-0 w-full"
            style={{ top: 'calc(50% - 0.5px)', height: 1, background: 'rgba(56,189,248,0.55)' }}
          />
          <div
            className="absolute top-0 h-full"
            style={{ left: 'calc(50% - 0.5px)', width: 1, background: 'rgba(56,189,248,0.55)' }}
          />
        </div>
      )}
      {/* 调整态操作提示：选区下方一行小字，贴屏幕底边时收进视口内 */}
      {phase === 'adjust' && sel && (
        <div
          className="pointer-events-none absolute whitespace-nowrap rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-sky-200"
          style={{
            left: sel.left,
            top: Math.min(sel.top + sel.height + 6, window.innerHeight - 22),
          }}
        >
          Enter 确认 · Esc 取消 · 拖角调整
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
