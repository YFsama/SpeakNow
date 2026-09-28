import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import type {
  AsrConfig,
  Config,
  DeviceInfo,
  HistoryItem,
  LlmConfig,
  LocalModelStatus,
  MicTestResult,
  ProviderProfile,
} from './types';

export const isMac =
  navigator.userAgent.includes('Mac') || navigator.platform.includes('Mac');

export const appVersion = async () => {
  try {
    return await getVersion();
  } catch {
    return '0.1.0';
  }
};

export const getConfig = () => invoke<Config>('get_config');
export const saveConfig = (config: Config) =>
  invoke<string>('save_config', { config });
export const resetConfig = () => invoke<Config>('reset_config');
export const openConfigDir = () => invoke('open_config_dir');
export const listDevices = () => invoke<DeviceInfo[]>('list_devices');
export const micTest = (
  device: string | null,
  playback = false,
  gainDb = 0,
) => invoke<MicTestResult>('mic_test', { device, playback, gainDb });
export const autoCalibrate = (device: string | null) =>
  invoke<{ peakPercent: number; suggestedDb: number | null }>('auto_calibrate', {
    device,
  });
export interface MicDiagnosis {
  frames: number;
  peakPercent: number;
  avgPercent: number;
  channelPeaks: number[];
  systemPrivacy: string;
  appPrivacy: string;
  systemVolume: number | null;
  systemMuted: boolean;
  systemDevice: string | null;
  findings: string[];
}
export interface MicVolumeInfo {
  device: string;
  volume: number;
  muted: boolean;
}
export const micDiagnose = (device: string | null) =>
  invoke<MicDiagnosis>('mic_diagnose', { device });
export interface DeviceScanRow {
  name: string;
  isDefault: boolean;
  channels: number | null;
  sampleRate: number | null;
  peakPercent: number;
  avgPercent: number;
  ok: boolean;
  error?: string | null;
  channelPeaks?: number[];
  frames?: number;
}
/** 同时打开所有输入设备并发采集（一次说话对比全部端点），期间发送 sn-mic-level-all 事件 */
export const micTestAll = (durationMs = 3200) =>
  invoke<DeviceScanRow[]>('mic_test_all', { durationMs });
export const openMicSettings = () => invoke('open_mic_settings');
export const micVolumeInfo = (device: string | null) =>
  invoke<MicVolumeInfo>('mic_volume_info', { device });
export const setMicVolume = (
  device: string | null,
  volume: number,
  unmute = false,
) => invoke('set_mic_volume', { device, volume, unmute });
export interface HwLevel {
  name: string;
  channels: number;
  minDb: number;
  maxDb: number;
  stepDb: number;
  curDb: number;
}
export const micHwLevels = (device: string | null) =>
  invoke<HwLevel[]>('mic_hw_levels', { device });
export const setMicHwLevel = (
  device: string | null,
  name: string,
  db: number,
) => invoke<number>('set_mic_hw_level', { device, name, db });
export const startRecording = () =>
  invoke<string>('start_recording', { fromUi: true });
export const stopRecording = () => invoke<string>('stop_recording');
export const testAsr = (config: AsrConfig, providers: ProviderProfile[]) =>
  invoke<string>('test_asr', { config, providers });
export const builtinModels = () =>
  invoke<LocalModelStatus[]>('builtin_models');
export const downloadBuiltin = (id: string, mirror: string) =>
  invoke('download_builtin', { id, mirror });
/** 删除已下载的本地模型（释放磁盘空间） */
export const deleteBuiltin = (id: string) =>
  invoke('delete_builtin', { id });
export const listLlmModels = (baseUrl: string, apiKey: string) =>
  invoke<string[]>('list_models', { baseUrl, apiKey });
export const testLlm = (config: LlmConfig, providers: ProviderProfile[]) =>
  invoke<string>('test_llm', { config, providers });
export const getHistory = () => invoke<HistoryItem[]>('get_history');
export const clearHistory = () => invoke('clear_history');
export const deleteHistory = (ts: number) => invoke('delete_history', { ts });
export const regenerate = (ts: number) =>
  invoke<HistoryItem>('regenerate', { ts });
export const copyText = (text: string) => invoke('copy_text', { text });
export const dismissOverlay = () => invoke('dismiss_overlay');
export const overlayPin = (pinned: boolean) => invoke('overlay_pin', { pinned });
/** 重试最近一次失败的识别（复用已录音频） */
export const retryLast = () => invoke<string>('retry_last');
/** 悬浮窗手动拖动后固定位置（false 恢复自动跟随输入框） */
export const overlaySetManual = (manual: boolean) =>
  invoke('overlay_set_manual', { manual });
export const exportText = (filename: string, content: string) =>
  invoke<string>('export_text', { filename, content });
export const confirmEdit = (text: string) => invoke('confirm_edit', { text });
export const cancelReview = () => invoke('cancel_review');
/** 审阅窗口重新优化；mode 可覆盖本次模式（correct / polish / prompt / translate），结果流式逐字回填 */
export const optimizeText = (text: string, mode?: string) =>
  invoke<string>('optimize_text', { text, mode: mode ?? null });

/* ============ 划词翻译 ============ */

/** 手动触发一次划词翻译（取当前前台应用的选中文字，悬浮窗展示结果） */
export const translateSelection = () =>
  invoke<string>('translate_selection_cmd');
/** 翻译指定文本（静默会话：不弹悬浮窗，流式增量走 sn-llm-delta，返回完整译文） */
export const translateText = (text: string, target?: string) =>
  invoke<string>('translate_text', { text, target: target ?? null });
/** 悬浮窗语言条切换目标语言并重译（持久化新目标，卡片收到 start/result 事件） */
export const translateRetarget = (text: string, target: string) =>
  invoke('translate_retarget', { text, target });
/** 把译文替换回原应用中选中的文字（选中状态下粘贴即覆盖，Ctrl+Z 可撤销） */
export const translateReplace = (text: string) =>
  invoke('translate_replace', { text });
/** 广播式翻译会话（OCR 卡片「翻译」按钮）：悬浮窗切到流式翻译卡片，目标语言不落盘 */
export const translateAnnounce = (text: string, target?: string) =>
  invoke('translate_announce', { text, target: target ?? null });

/* ============ 截图取词（OCR） ============ */

/** 触发一次截图取词（框选屏幕区域识别；设置页「试一下」同款入口） */
export const ocrCapture = () => invoke<string>('ocr_capture_cmd');
/** 框选完成回调（选区窗前端专用，逻辑像素矩形） */
export const ocrRegionSelected = (x: number, y: number, w: number, h: number) =>
  invoke('ocr_region_selected', { x, y, w, h });
/** 取消本轮框选 */
export const ocrCancel = () => invoke('ocr_cancel');
/** 把 OCR 文本粘贴输入到光标处（悬浮窗收回后执行） */
export const ocrPaste = (text: string) => invoke('ocr_paste', { text });
/** 系统 OCR 引擎已安装的语言包标签（判断中文语言包、引导安装） */
export const ocrLangs = () => invoke<string[]>('ocr_langs');
/** 打开系统语言设置页（安装 OCR 语言包） */
export const openLanguageSettings = () => invoke('open_language_settings');

/** 外接显示（硬件字幕屏）服务状态 */
export interface DisplayStatus {
  running: boolean;
  port?: number;
  allowLan?: boolean;
  urls: string[];
  error?: string | null;
}
export const displayStatus = () => invoke<DisplayStatus>('display_status');
/** 在系统默认浏览器打开外接显示页（仅限本机/局域网地址） */
export const openDisplayPage = (url: string) =>
  invoke('open_display_page', { url });

/** 本应用当前是否以管理员身份运行 */
export const isElevated = () => invoke<boolean>('is_elevated');
/** 以管理员身份重启（UAC 确认后旧实例自动退出） */
export const restartElevated = () => invoke('restart_elevated');

/** 应用主题与缩放到当前窗口 */
export function applyAppearance(theme: string, fontScale: number) {
  document.documentElement.classList.toggle('light', theme === 'light');
  document.body.style.zoom = String(fontScale || 1);
}

const CODE_LABELS: Record<string, string> = {
  Space: 'Space',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Insert: 'Ins',
  Delete: 'Del',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Return: 'Enter',
  Enter: 'Enter',
  Escape: 'Esc',
  Tab: 'Tab',
  CapsLock: 'Caps',
};

/** 把单个按键名格式化为用户可读形式 */
function prettyPart(part: string): string {
  const k = part.toLowerCase();
  if (k === 'ctrl' || k === 'control') return isMac ? '⌃' : 'Ctrl';
  if (k === 'alt' || k === 'option') return isMac ? '⌥' : 'Alt';
  if (k === 'shift') return isMac ? '⇧' : 'Shift';
  if (k === 'meta' || k === 'cmd' || k === 'super' || k === 'win')
    return isMac ? '⌘' : 'Win';
  if (/^Key[A-Z]$/.test(part)) return part.slice(3);
  if (/^Digit\d$/.test(part)) return part.slice(5);
  if (/^F\d{1,2}$/.test(part)) return part;
  if (/^Numpad\d$/.test(part)) return 'Num' + part.slice(6);
  return CODE_LABELS[part] ?? part;
}

/** 拆分为可渲染的键位徽章数组 */
export function shortcutChips(s: string): string[] {
  if (!s) return [];
  return s
    .split('+')
    .filter(Boolean)
    .map(prettyPart);
}
