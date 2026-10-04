import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// 浏览器视觉验证：dev 下带 ?mock=1 时先装上 Tauri API mock 再渲染。
// 生产构建里 import.meta.env.DEV 为 false，整个分支与 mock 模块都不进产物
if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) {
  await import('./dev/mock-tauri');
}

// 主题预缓存：配置加载前先按上次外观给 <html> 上类，消除浅色用户首屏
// 骨架「先深后浅」闪变（配置到达后 applyAppearance 会做权威纠正）
try {
  if (localStorage.getItem('sn:light') === '1') {
    document.documentElement.classList.add('light');
  }
} catch {
  /* localStorage 不可用则维持默认深色 */
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
