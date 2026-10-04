import { useEffect, useState } from 'react';
import { Button, Field, Section, Segmented, Select, TextArea, Toggle } from '../Controls';
import { isElevated, isMac, restartElevated } from '../../api';
import type { Config, TabProps } from '../../types';

/* ============ 输出 ============ */
export function OutputTab({ cfg, set }: TabProps) {
  const [elevated, setElevated] = useState<boolean | null>(null);
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    // 管理员提权是 Windows 概念（is_elevated 恒 false、重启必失败）：mac 跳过探测
    if (isMac) return;
    isElevated()
      .then(setElevated)
      .catch(() => setElevated(null));
  }, []);

  return (
    <Section
      icon="⌨"
      title="文字输入方式"
      desc="识别完成后，文字如何进入 Codex / ZCode 等目标输入框。"
    >
      <Field label="输入方式">
        <Segmented
          value={cfg.output.method}
          onChange={(method) => set('output', { method })}
          options={[
            {
              value: 'clipboard',
              label: '剪贴板粘贴（推荐）',
              desc: '瞬时完成，支持中文与多行文本',
            },
            {
              value: 'typing',
              label: '模拟键盘逐字输入',
              desc: '不占用剪贴板，长文本较慢',
            },
          ]}
        />
      </Field>
      {/* 运行权限整块仅 Windows：mac 上 is_elevated 恒 false、提权重启静默失败，
          UIPI/UAC 文案也无意义，直接隐藏（对齐 AsrTab/OcrTab 的平台门控方式） */}
      {!isMac && (
        <Field
          label="运行权限"
          hint="终端 / PowerShell 若以管理员身份运行，系统（UIPI）会阻止普通权限程序向其粘贴或键入；SpeakNow 需同样以管理员运行才能输入"
        >
          <div className="flex flex-wrap items-center gap-3">
            {elevated ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1.5 text-[12px] text-emerald-300">
                ✓ 已以管理员身份运行 · 可向管理员窗口输入
              </span>
            ) : (
              <>
                <Button
                  kind="primary"
                  disabled={restarting}
                  onClick={() => {
                    setRestarting(true);
                    restartElevated().catch(() => setRestarting(false));
                  }}
                >
                  {restarting ? '正在请求提权…' : '🛡 以管理员身份重启'}
                </Button>
                <span className="text-[11px] text-slate-500">
                  会弹出 UAC 确认；热键、配置与悬浮窗均保持不变
                </span>
              </>
            )}
          </div>
        </Field>
      )}
      {cfg.output.method === 'clipboard' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="粘贴按键" hint="自动模式：Windows Terminal / WSL 等用 Ctrl+Shift+V，传统控制台用 Shift+Insert，其余窗口用 Ctrl+V；终端键入模式不依赖任何粘贴快捷键">
            <Select
              value={cfg.output.pasteKey}
              onChange={(pasteKey) =>
                set('output', { pasteKey: pasteKey as Config['output']['pasteKey'] })
              }
              options={[
                { value: 'auto', label: '自动（推荐 · 按窗口类型智能选择）' },
                {
                  value: 'terminal-typing',
                  label: '终端键入 · 其余粘贴（右键粘贴类终端推荐）',
                },
                { value: 'ctrl+v', label: 'Ctrl + V（macOS 为 ⌘V）' },
                { value: 'ctrl+shift+v', label: 'Ctrl + Shift + V（终端风格）' },
                { value: 'shift+insert', label: 'Shift + Insert（传统控制台）' },
              ]}
            />
          </Field>
          <div className="flex items-end">
            <Toggle
              checked={cfg.output.restoreClipboard}
              onChange={(restoreClipboard) => set('output', { restoreClipboard })}
              label="输入后还原剪贴板"
              desc="保留你之前复制的内容"
            />
          </div>
        </div>
      )}
      <Toggle
        checked={cfg.output.autoPaste}
        onChange={(autoPaste) => set('output', { autoPaste })}
        label="自动输入到当前光标处"
        desc="关闭后只复制到剪贴板，由你手动粘贴"
      />
      {cfg.output.autoPaste && (
        <Toggle
          checked={cfg.output.review}
          onChange={(review) => set('output', { review })}
          label="输入前确认"
          desc="结果先显示在悬浮窗中，可修改或重新优化：Enter 输入 · Esc 取消"
        />
      )}
      <Toggle
        checked={cfg.output.autoSubmit}
        onChange={(autoSubmit) => set('output', { autoSubmit })}
        label="输入后自动按回车提交"
        desc="配合 Codex / ZCode 等可实现「说完即发送」；聊天类应用已由下方黑名单保护（只输入不回车）"
      />
      {cfg.output.autoSubmit && (
        <Field
          label="回车黑名单（每行一个关键字）"
          hint="前台进程名包含关键字时只输入文本、不模拟回车——微信 / QQ 等聊天工具里回车会把还没改完的话直接发送。已预置常见 IM，可增删"
        >
          <TextArea
            rows={3}
            value={cfg.output.autoSubmitBlocklist.join('\n')}
            onChange={(v) =>
              set('output', {
                autoSubmitBlocklist: v
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder={'wechat\nqq\ntelegram'}
          />
        </Field>
      )}
    </Section>
  );
}
