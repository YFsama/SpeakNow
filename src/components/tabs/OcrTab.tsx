import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button, Field, Section, Select, Toggle } from '../Controls';
import {
  deleteBuiltin,
  downloadBuiltin,
  isMac,
  ocrCapture,
  ocrLangs,
  openLanguageSettings,
  shortcutChips,
} from '../../api';
import type { TabProps } from '../../types';

/* ============ 截图取词（OCR） ============ */

const OCR_LANGS: { value: string; label: string }[] = [
  { value: 'auto', label: '自动（跟随系统）' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
];

function fmtSize(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

export function OcrTab({ cfg, set, toast, navigate, localModels, refreshLocalModels }: TabProps) {
  /* 系统 OCR 语言包：检测 + 中文缺失时引导安装（不静默失败） */
  const [langs, setLangs] = useState<string[] | null>(null);
  useEffect(() => {
    // 截图取词后端（框选窗/截屏/OCR 引擎）仅 Windows：mac 上跳过检测，
    // langs 保持 null 即不渲染语言包区块，避免恒报「未检测到中文 OCR 语言包」
    if (isMac) return;
    ocrLangs()
      .then(setLangs)
      .catch(() => setLangs([]));
  }, []);
  const zhMissing = langs !== null && !langs.some((t) => t.toLowerCase().startsWith('zh'));

  const chips = shortcutChips(cfg.hotkey.keyOcr);

  /* ---- PP-OCR 质量档模型管理（与本地 ASR 模型同协议的下载/进度/删除） ---- */
  const ppocr = localModels.find((m) => m.kind === 'ppocr');
  const [progress, setProgress] = useState<{
    file: string;
    downloaded: number;
    total: number;
  } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    const un = listen<{ model: string; file: string; downloaded: number; total: number }>(
      'sn-model-progress',
      (e) => {
        if (e.payload.model === 'ppocr-v5-mobile') {
          setProgress({
            file: e.payload.file,
            downloaded: e.payload.downloaded,
            total: e.payload.total,
          });
        }
      },
    );
    const un2 = listen('sn-models-changed', () => refreshLocalModels());
    return () => {
      un.then((f) => f());
      un2.then((f) => f());
    };
  }, [refreshLocalModels]);

  const onDownload = async () => {
    setDownloading(true);
    setConfirmDel(false);
    try {
      await downloadBuiltin('ppocr-v5-mobile', '');
      toast('PP-OCR 质量档模型下载完成 ✓');
    } catch (e) {
      toast(`下载失败：${e}`);
    } finally {
      setDownloading(false);
      setProgress(null);
      refreshLocalModels();
    }
  };

  const onDelete = async () => {
    if (!confirmDel) {
      setConfirmDel(true);
      return;
    }
    setConfirmDel(false);
    try {
      await deleteBuiltin('ppocr-v5-mobile');
      if (cfg.ocr.engine === 'ppocr') set('ocr', { engine: 'system' });
      toast('已删除，磁盘空间已释放');
    } catch (e) {
      toast(`删除失败：${e}`);
    }
    refreshLocalModels();
  };

  const engine = cfg.ocr.engine || 'system';
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <>
      <Section
        icon="📷"
        title="截图取词"
        desc="按热键框选屏幕任意区域：本地离线识别，结果弹在悬浮窗里，可复制、翻译或直接输入到光标处。全程不上传屏幕内容。"
      >
        <div className="rounded-xl border border-white/[0.07] bg-black/20 p-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-[12.5px] font-medium text-slate-300">
              {chips.length > 0 ? '截图取词热键' : '尚未设置截图取词热键'}
            </span>
            {chips.length > 0 ? (
              <span className="flex items-center gap-1">
                {chips.map((c, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <span className="text-[10px] text-slate-600">+</span>}
                    <span className="kbd">{c}</span>
                  </span>
                ))}
              </span>
            ) : (
              <Button onClick={() => navigate('hotkey')}>去设置热键</Button>
            )}
            <span className="text-[11px] leading-4 text-slate-500">
              也可用托盘菜单「截图取词（框选识别）」触发
            </span>
          </div>
          {/* 截图取词仅 Windows：mac 上后端调用立即报错，隐藏无效触发入口，
              换一段说明（处理方式与 AsrTab 对仅 Windows 的 Qwen3-ASR 一致） */}
          {isMac ? (
            <div className="mt-3 rounded-lg border border-white/[0.07] bg-black/20 px-3.5 py-2.5 text-[11.5px] leading-5 text-slate-400">
              📷 截图取词暂支持 Windows：macOS 端尚在规划（见本页下方路线图）。热键槽位可先在「快捷键」页设置，Windows 机器上即按即用。
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                onClick={async () => {
                  try {
                    await ocrCapture();
                  } catch (e) {
                    toast(`触发失败：${e}`);
                  }
                }}
              >
                📷 试一下（拖拽框选屏幕区域）
              </Button>
              <span className="text-[11px] leading-4 text-slate-500">
                Esc / 右键取消框选
              </span>
            </div>
          )}
        </div>

        <Toggle
          checked={cfg.ocr.enabled}
          onChange={(enabled) => set('ocr', { enabled })}
          label="启用截图取词"
          desc="关闭后热键与托盘菜单不再响应"
        />
        <Toggle
          checked={cfg.ocr.autoTranslate}
          onChange={(autoTranslate) => set('ocr', { autoTranslate })}
          label="识别后直接翻译"
          desc="跳过 OCR 结果卡片，框选松手直接进入流式翻译卡片（截图翻译一键链）。目标语言与划词翻译共用，需已配置「AI 优化」接口"
        />
        <Toggle
          checked={cfg.ocr.copyOnCapture}
          onChange={(copyOnCapture) => set('ocr', { copyOnCapture })}
          label="识别后自动复制"
          desc="识别完成即写入剪贴板，悬浮窗里还能继续选择翻译或输入"
        />
        <Field label="识别语言" hint="「系统内置」引擎按语言包识别；「自动」跟随系统用户语言列表">
          <Select
            value={cfg.ocr.language || 'auto'}
            onChange={(language) => set('ocr', { language })}
            options={OCR_LANGS}
          />
        </Field>

        {zhMissing && (
          <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.07] px-3.5 py-3 text-[12px] leading-relaxed text-amber-200">
            <div className="font-medium">未检测到中文 OCR 语言包</div>
            <div className="mt-1 text-amber-200/80">
              「系统内置」引擎识别中文需要先安装：系统「设置 → 时间和语言 → 语言和区域」中给中文启用「光学字符识别」可选功能；或直接下载下方 PP-OCR 质量档（自带中文模型，不依赖语言包）。
            </div>
            <div className="mt-2">
              <Button onClick={() => void openLanguageSettings()}>打开系统语言设置</Button>
            </div>
          </div>
        )}
        {langs !== null && langs.length > 0 && !zhMissing && (
          <div className="text-[11px] leading-4 text-slate-500">
            已装系统语言包：{langs.join('、')}
          </div>
        )}
      </Section>

      <Section
        icon="🧭"
        title="识别引擎"
        desc="系统内置引擎零下载、毫秒级；PP-OCR 质量档中文准确率更高（约 21MB 模型，离线推理零上传）。"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {/* 系统内置引擎卡 */}
          <button
            type="button"
            onClick={() => set('ocr', { engine: 'system' })}
            className={`rounded-xl border px-3.5 py-3 text-left transition ${
              engine === 'system'
                ? 'border-sky-500/70 bg-sky-500/[0.08] shadow-[0_0_18px_-6px_rgba(56,189,248,0.45)]'
                : 'border-white/[0.07] bg-black/20 hover:border-white/20'
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 transition ${
                  engine === 'system'
                    ? 'border-sky-400 bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.6)]'
                    : 'border-slate-600'
                }`}
                aria-hidden
              />
              <span className="text-[13px] font-medium text-slate-200">系统内置（Windows.Media.Ocr）</span>
            </div>
            <div className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
              零下载零依赖 · 毫秒级 · 依赖系统语言包
            </div>
          </button>

          {/* PP-OCR 质量档卡（含模型下载管理）。选中态与其他引擎卡统一为 sky；violet 仅作类别徽章色 */}
          <div
            className={`rounded-xl border px-3.5 py-3 transition ${
              engine === 'ppocr'
                ? 'border-sky-500/70 bg-sky-500/[0.08] shadow-[0_0_18px_-6px_rgba(56,189,248,0.45)]'
                : 'border-white/[0.07] bg-black/20'
            }`}
          >
            <button
              type="button"
              onClick={() => set('ocr', { engine: 'ppocr' })}
              className="flex w-full items-center gap-2 text-left"
            >
              <span
                className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 transition ${
                  engine === 'ppocr'
                    ? 'border-sky-400 bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.6)]'
                    : 'border-slate-600'
                }`}
                aria-hidden
              />
              <span className="text-[13px] font-medium text-slate-200">PP-OCRv5 质量档</span>
              <span className="shrink-0 rounded-full border border-violet-400/30 bg-violet-400/10 px-1.5 py-0.5 text-[9.5px] text-violet-300">
                本地高精度
              </span>
              {ppocr?.downloaded && (
                <span className="rounded-full border border-violet-400/30 bg-violet-400/10 px-1.5 py-0.5 text-[9.5px] text-violet-300">
                  已就绪
                </span>
              )}
              {ppocr && (
                <span className="ml-auto rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                  {fmtSize(ppocr.sizeMb)}
                </span>
              )}
            </button>
            <div className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
              中文准确率更高 · 离线推理零上传 · 首次识别加载约 1 秒
            </div>

            {ppocr && !ppocr.downloaded && !downloading && (
              <div className="mt-2.5">
                <Button onClick={onDownload}>↓ 下载模型（ModelScope 直连）</Button>
              </div>
            )}
            {downloading && (
              <div className="mt-2.5">
                <div className="flex items-center justify-between text-[10.5px] text-slate-400">
                  <span className="truncate">{progress?.file ?? '准备下载…'}</span>
                  <span className="tabular-nums">{pct !== null ? `${pct}%` : ''}</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-violet-400 transition-all"
                    style={{ width: `${pct ?? 0}%` }}
                  />
                </div>
              </div>
            )}
            {ppocr?.downloaded && (
              <div className="mt-2.5">
                <Button kind="ghost" onClick={onDelete}>
                  {confirmDel ? '再点一次确认删除' : '删除模型（释放空间）'}
                </Button>
              </div>
            )}
          </div>

          {/* 云端档引擎卡。选中态统一 sky；amber 仅作类别徽章色 */}
          <button
            type="button"
            onClick={() => set('ocr', { engine: 'cloud' })}
            className={`rounded-xl border px-3.5 py-3 text-left transition ${
              engine === 'cloud'
                ? 'border-sky-500/70 bg-sky-500/[0.08] shadow-[0_0_18px_-6px_rgba(56,189,248,0.45)]'
                : 'border-white/[0.07] bg-black/20 hover:border-white/20'
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 transition ${
                  engine === 'cloud'
                    ? 'border-sky-400 bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.6)]'
                    : 'border-slate-600'
                }`}
                aria-hidden
              />
              <span className="text-[13px] font-medium text-slate-200">云端视觉大模型</span>
              <span className="shrink-0 rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[9.5px] text-amber-300">
                需联网 · 上传
              </span>
            </div>
            <div className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
              GLM-4.6V-Flash 免费档起步 · 复杂版面最强 · 截图会上传
            </div>
          </button>
        </div>
        {engine === 'cloud' && (
          <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3.5 py-3 text-[11.5px] leading-relaxed text-amber-200/90">
            云端档复用「AI 优化」页的接口与 Key（智谱一个 Key 多用），默认调用免费的
            glm-4.6v-flash：把「AI 优化」的模型名临时改为其他 vision
            模型即可换挡（如 glm-4.6v / qwen-vl-ocr 兼容接口）。注意：截图内容会上传到所配置的服务商，敏感内容请用本地档。
          </div>
        )}
        <div className="text-[11px] leading-relaxed text-slate-500">
          路线图：PaddleOCR-VL 高精度档（复杂版面/表格/手写，约 1GB，复用 llama.cpp
          引擎设施，规划中）与批量 OCR 队列（拖入文件夹批量识别导出），详见 docs/ocr-research.md。
        </div>
      </Section>
    </>
  );
}
