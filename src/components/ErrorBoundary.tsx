import { Component, type ErrorInfo, type ReactNode } from 'react';

/* ============ 顶层错误边界 ============ */

/* 渲染期异常的兜底：子树 throw 后 React 会卸载整棵树（整窗白屏），边界把
   崩溃收敛成可读的降级卡 + 重试（重置错误态即重挂子树）。主窗口与悬浮窗
   各挂一层，一个窗口崩溃不牵连另一个 */
interface ErrorBoundaryProps {
  children: ReactNode;
  /** 自定义降级渲染（悬浮窗用紧凑卡贴合毛玻璃风）；reset = 重置错误态重挂子树 */
  fallback?: (reset: () => void, error: Error) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/* 错误摘要：报文常带整段堆栈 / JSON 网关报文，截断 160 字保降级卡可读 */
function errSummary(e: Error): string {
  const s = (e.message || String(e)).trim();
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 用户侧只看降级卡；完整堆栈与组件栈进控制台供排查
    console.error('[ErrorBoundary] 渲染崩溃', error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.reset, error);
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#101226] p-6">
        <div className="w-full max-w-md rounded-2xl border border-red-500/25 bg-[#171a30] p-6 text-center shadow-2xl">
          <div className="text-[26px] leading-none">⚠️</div>
          <div className="mt-2.5 text-[15px] font-semibold text-slate-100">界面出错了</div>
          <div className="mt-2 break-all text-[12px] leading-5 text-red-300/80">
            {errSummary(error)}
          </div>
          <button
            type="button"
            onClick={this.reset}
            className="mt-4 rounded-lg border border-white/15 bg-white/[0.06] px-4 py-1.5 text-[12.5px] text-slate-200 transition hover:border-white/30 hover:bg-white/[0.1] active:scale-95"
          >
            ↻ 重试
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
