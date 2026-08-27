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
export const scanDevices = () => invoke<DeviceScanRow[]>('scan_devices');
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
export const testAsr = (config: AsrConfig) =>
  invoke<string>('test_asr', { config });
export const builtinModels = () =>
  invoke<LocalModelStatus[]>('builtin_models');
export const downloadBuiltin = (id: string, mirror: string) =>
  invoke('download_builtin', { id, mirror });
/** 删除已下载的本地模型（释放磁盘空间） */
export const deleteBuiltin = (id: string) =>
  invoke('delete_builtin', { id });
export const listLlmModels = (baseUrl: string, apiKey: string) =>
  invoke<string[]>('list_models', { baseUrl, apiKey });
export const testLlm = (config: LlmConfig) =>
  invoke<string>('test_llm', { config });
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
export const optimizeText = (text: string) =>
  invoke<string>('optimize_text', { text });

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

/** 把 "ctrl+shift+Space" 这样的内部表示格式化为用户可读形式 */
export function prettyShortcut(s: string): string {
  if (!s) return '';
  return s
    .split('+')
    .filter(Boolean)
    .map(prettyPart)
    .join(isMac ? '' : ' + ');
}

/** 拆分为可渲染的键位徽章数组 */
export function shortcutChips(s: string): string[] {
  if (!s) return [];
  return s
    .split('+')
    .filter(Boolean)
    .map(prettyPart);
}
