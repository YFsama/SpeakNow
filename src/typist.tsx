import React from 'react';
import ReactDOM from 'react-dom/client';
import Typist from './components/Typist';
import './styles.css';

// 浏览器视觉验证：dev 下带 ?mock=1 时先装上 Tauri API mock 再渲染（不进生产包）
if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) {
  await import('./dev/mock-tauri');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Typist />
  </React.StrictMode>,
);
