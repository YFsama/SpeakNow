import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Vite 的默认目标浏览器已满足 Tauri 的 WebView 要求
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 5174 }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: 'chrome110',
    sourcemap: false,
    rollupOptions: {
      input: {
        main: new URL('./index.html', import.meta.url).pathname,
        overlay: new URL('./overlay.html', import.meta.url).pathname,
      },
      output: {
        // 共享依赖（主窗口与悬浮窗都用）单独成块，并命名为 vendor——
        // 否则 Rollup 默认会把共享块叫作入口名（如误导性的 "styles"）。
        // 两个入口直接 import 的是 react-dom/client（非 react-dom 入口），须一并列入
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-dom/client', '@tauri-apps/api'],
        },
      },
    },
  },
});
