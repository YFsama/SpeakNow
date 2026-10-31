import { useEffect, useState } from 'react';
import { Button, Field, Section, Spinner, Toggle } from '../Controls';
import { copyText, displayStatus, memGenToken, openDisplayPage } from '../../api';
import type { DisplayStatus } from '../../api';
import type { TabProps } from '../../types';
import { NumberInput } from './shared';

/* ============ 外接显示 ============ */

/** 令牌打码展示：保留「sn-」前缀与末 4 位（口头核对刚好够用），中间遮星号。
 *  太短的异常值整体遮掉，不泄露任何片段 */
function maskToken(t: string): string {
  return t.length > 8 ? `${t.slice(0, 3)}****${t.slice(-4)}` : '****';
}

export function DisplayTab({ cfg, set, toast }: TabProps) {
  const [st, setSt] = useState<DisplayStatus | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);

  // 服务状态轮询：配置保存后端口/启停会变化，3 秒刷新足够跟手；
  // 后端每次都返回新对象，浅比较关键字段无变化时跳过 setState，避免白白重渲染本页
  useEffect(() => {
    const sameStatus = (a: DisplayStatus | null, b: DisplayStatus | null) =>
      a === b ||
      (!!a &&
        !!b &&
        a.running === b.running &&
        a.port === b.port &&
        (a.error ?? null) === (b.error ?? null) &&
        a.urls.length === b.urls.length &&
        a.urls.every((u, i) => u === b.urls[i]));
    const refresh = () =>
      displayStatus()
        .then((s) => setSt((prev) => (sameStatus(prev, s) ? prev : s)))
        .catch(() => {});
    refresh();
    const iv = setInterval(refresh, 3000);
    return () => clearInterval(iv);
  }, [cfg.externalDisplay.enabled, cfg.externalDisplay.port, cfg.externalDisplay.allowLan]);

  const ext = cfg.externalDisplay;
  const token = cfg.mem.apiToken;

  /* 生成/轮换令牌：后端 mem_gen_token 已落盘并广播，这里拿到返回值必须同步
     本地 cfg——否则页面上任何一处改动触发的自动保存会把旧（空）值写回 */
  const onGenToken = async () => {
    if (genBusy) return;
    setGenBusy(true);
    try {
      const t = await memGenToken();
      set('mem', { apiToken: t });
      toast('已生成新令牌，旧令牌（若有）立即失效', 'ok');
    } catch (e) {
      toast(`生成令牌失败：${String(e)}`, 'error');
    } finally {
      setGenBusy(false);
    }
  };

  /* 复制完整令牌（界面上只展示打码版，复制的是真值） */
  const onCopyToken = () => {
    copyText(token).then(
      () => {
        setCopiedToken(true);
        window.setTimeout(() => setCopiedToken(false), 1500);
      },
      () => toast('复制失败', 'error'),
    );
  };

  return (
    <Section
      icon="📡"
      title="外接显示（硬件字幕屏）"
      desc="把聆听窗口的实时字幕推送到外接硬件——平板、树莓派、副屏电脑用浏览器打开即是一块字幕屏；也预留 WebSocket API 供自研硬件接入。"
    >
      <Toggle
        checked={ext.enabled}
        onChange={(enabled) => set('externalDisplay', { enabled })}
        label="启用外接显示 API"
        desc="本机启动轻量 HTTP + WebSocket 服务（默认端口 8866），字幕事件实时推送"
      />

      {ext.enabled && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="服务端口" hint="修改保存后服务自动重启；端口被占用会在下方提示">
              <NumberInput
                value={ext.port}
                normalize={(v) => Math.min(65535, Math.max(1, Number(v) || 8866))}
                onCommit={(port) => set('externalDisplay', { port })}
                placeholder="8866"
              />
            </Field>
            <div className="flex flex-col justify-end">
              <Toggle
                checked={ext.allowLan}
                onChange={(allowLan) => set('externalDisplay', { allowLan })}
                label="允许局域网设备连接"
                desc="开启后同一网络的硬件可访问；首次可能需在 Windows 防火墙放行该端口"
              />
              {ext.allowLan && (
                <div className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11px] leading-5 text-amber-200/90">
                  ⚠ 开启后同一网络内的设备都可看到实时字幕与窗口标题，请仅在可信网络使用
                </div>
              )}
            </div>
          </div>

          <Toggle
            checked={ext.hideLocalOverlay}
            onChange={(hideLocalOverlay) => set('externalDisplay', { hideLocalOverlay })}
            label="外接显示时隐藏本地悬浮窗"
            desc="聆听字幕只在外接硬件上显示，本机不再弹出窗口（「输入前确认」会临时退回直接输入）"
          />

          <div className="anim-rise rounded-xl border border-white/[0.06] bg-black/20 p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] font-medium text-slate-300">
              {st?.running ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-[11px] text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
                  服务运行中 · {st.port}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-500/25 bg-slate-500/10 px-2.5 py-1 text-[11px] text-slate-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-500" aria-hidden />
                  服务未运行（保存后启动）
                </span>
              )}
              {st?.error && (
                <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] text-red-300">
                  {st.error}
                </span>
              )}
            </div>
            <div className="space-y-1.5">
              {(st?.urls ?? []).map((u) => (
                <div key={u} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg bg-black/30 px-2.5 py-1.5 font-mono text-[11.5px] text-sky-300">
                    {u}
                  </code>
                  <button
                    type="button"
                    onClick={() =>
                      copyText(u).then(
                        () => toast('已复制地址'),
                        () => toast('复制失败'),
                      )
                    }
                    className="shrink-0 rounded-md px-2 py-1 text-[11px] text-sky-400 transition hover:bg-sky-500/10 hover:text-sky-300"
                  >
                    复制
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      openDisplayPage(u).catch((e) => toast(`打开失败：${e}`))
                    }
                    className="shrink-0 rounded-md px-2 py-1 text-[11px] text-slate-400 transition hover:bg-white/10 hover:text-slate-200"
                  >
                    打开
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-2 text-[11px] leading-5 text-slate-500">
              在外接硬件的浏览器打开上面的地址即可显示字幕；页面支持
              <code className="mx-1 rounded bg-black/30 px-1 font-mono">?scale=1.5</code>
              参数整体放大字号，适配小屏设备
            </div>
          </div>

          <div className="rounded-lg border border-sky-500/15 bg-sky-500/[0.05] px-3.5 py-2.5 text-[11.5px] leading-5 text-sky-200/70">
            🔌 自研硬件接入（预留 API）：WebSocket 连接
            <code className="mx-1 rounded bg-black/30 px-1 font-mono">
              ws://&lt;本机IP&gt;:{ext.port}/api/events
            </code>
            ，事件为版本化信封
            <code className="mx-1 rounded bg-black/30 px-1 font-mono">
              {'{v, type, data, ts}'}
            </code>
            ，type 含 status / partial / raw / delta / result / level / meta，
            未知 type 请忽略（前向兼容）。字段说明见项目
            <code className="mx-1 rounded bg-black/30 px-1 font-mono">
              docs/external-display-api.md
            </code>
          </div>

          {/* 记忆开放端点与本服务同生命周期，说明文案与上方 WS API 同一款式 */}
          <div className="rounded-lg border border-sky-500/15 bg-sky-500/[0.05] px-3.5 py-2.5 text-[11.5px] leading-5 text-sky-200/70">
            🧠 记忆开放 API：
            <code className="mx-1 rounded bg-black/30 px-1 font-mono">
              GET /mem/search?q=&amp;k=
            </code>
            与
            <code className="mx-1 rounded bg-black/30 px-1 font-mono">
              GET /mem/context.md
            </code>
            —— 把 SpeakNow 记忆暴露给本机其他 AI 工具（随本服务启停，默认仅本机可访问）
          </div>

          {/* REST 令牌管理：loopback 免钥、局域网必验，所以放在 mem API 说明旁 */}
          <div className="rounded-lg border border-white/[0.08] bg-black/20 px-3.5 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-medium text-slate-300">记忆 REST 令牌</span>
              <code
                className="rounded bg-black/30 px-2 py-1 font-mono text-[11.5px] text-sky-300"
                title={token ? '出于安全只显示首尾，复制按钮取完整令牌' : '尚未生成令牌'}
              >
                {token ? maskToken(token) : '未生成'}
              </code>
              <Button kind="subtle" disabled={genBusy} onClick={() => void onGenToken()}>
                {genBusy && <Spinner size={13} />}
                {token ? '重新生成' : '生成'}
              </Button>
              {token && (
                <Button kind="subtle" onClick={onCopyToken}>
                  {copiedToken ? '已复制 ✓' : '复制'}
                </Button>
              )}
            </div>
            <div className="mt-1.5 text-[11px] leading-5 text-slate-500">
              本机访问免令牌；开启局域网后 /mem/* 需携带请求头
              <code className="mx-1 rounded bg-black/30 px-1 font-mono">
                X-SN-API-Key: &lt;令牌&gt;
              </code>
              。重新生成后旧令牌立即失效
            </div>
          </div>
        </>
      )}
    </Section>
  );
}
