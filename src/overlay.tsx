import React from 'react';
import ReactDOM from 'react-dom/client';
import Overlay from './components/Overlay';
import OcrSelect from './components/OcrSelect';
import './styles.css';

// 同一入口两个角色：默认渲染悬浮卡片；?ocr=N（每屏一窗）渲染截图取词条选层
const isOcrSelect = new URLSearchParams(window.location.search).has('ocr');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isOcrSelect ? <OcrSelect /> : <Overlay />}
  </React.StrictMode>,
);
