import React from 'react';
import ReactDOM from 'react-dom/client';
import Overlay from './components/Overlay';
import OcrSelect from './components/OcrSelect';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

// 同一入口两个角色：默认渲染悬浮卡片；?ocr=N（每屏一窗）渲染截图取词条选层
const isOcrSelect = new URLSearchParams(window.location.search).has('ocr');

// 浏览器视觉验证：dev 下带 ?mock=1 时先装上 Tauri API mock 再渲染（不进生产包）
if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) {
  await import('./dev/mock-tauri');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* 渲染崩溃兜底：降级卡用紧凑尺寸贴合悬浮窗毛玻璃风，透明窗口不留大片色块 */}
    <ErrorBoundary
      fallback={(reset, error) => (
        <div className="flex h-screen w-screen items-start justify-center pt-4">
          <div className="w-[360px] rounded-[18px] border border-red-500/30 bg-[#171a30]/95 p-4 text-center shadow-2xl backdrop-blur">
            <div className="text-[20px] leading-none">⚠️</div>
            <div className="mt-2 text-[13px] font-medium text-slate-100">悬浮窗出错了</div>
            <div className="mt-1.5 break-all text-[11px] leading-4 text-red-300/70">
              {error.message.length > 120 ? `${error.message.slice(0, 120)}…` : error.message}
            </div>
            <button
              type="button"
              onClick={reset}
              className="mt-3 rounded-full border border-white/15 bg-white/[0.06] px-3.5 py-1 text-[11.5px] text-slate-200 transition hover:border-white/30 active:scale-95"
            >
              ↻ 重试
            </button>
          </div>
        </div>
      )}
    >
      {isOcrSelect ? <OcrSelect /> : <Overlay />}
    </ErrorBoundary>
  </React.StrictMode>,
);
