import React from 'react';
import ReactDOM from 'react-dom/client';
import Overlay from './components/Overlay';
import OcrSelect from './components/OcrSelect';
import './styles.css';

// 同一入口两个角色：默认渲染悬浮卡片；?ocr=N（每屏一窗）渲染截图取词条选层
const isOcrSelect = new URLSearchParams(window.location.search).has('ocr');

// 浏览器视觉验证：dev 下带 ?mock=1 时先装上 Tauri API mock 再渲染（不进生产包）
if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) {
  await import('./dev/mock-tauri');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isOcrSelect ? <OcrSelect /> : <Overlay />}
  </React.StrictMode>,
);
