export type HotkeyMode = 'hold' | 'toggle';
export type LlmMode = 'correct' | 'polish' | 'prompt';
export type PasteMethod = 'clipboard' | 'typing';
export type PasteKey = 'auto' | 'ctrl+v' | 'ctrl+shift+v' | 'shift+insert' | 'terminal-typing';

export interface HotkeyConfig {
  key: string;
  /** 快速模式快捷键（可选）：跳过 AI 优化直接输出原文 */
  keyQuick: string;
  mode: HotkeyMode;
  enabled: boolean;
}

/** 「系统默认输入」模式在按设备增益映射中的键 */
export const DEFAULT_DEVICE_KEY = '__default__';

export interface AudioConfig {
  device: string | null;
  vadEnabled: boolean;
  vadSilenceMs: number;
  vadThreshold: number;
  maxDurationSec: number;
  /** 软件输入增益（dB，0~45）；始终等于当前所选设备的增益 */
  gainDb: number;
  /** 各设备独立记住的软件增益（键 = 设备名，"__default__" = 系统默认模式）；旧配置缺省为空 */
  gainDbByDevice?: Record<string, number>;
  /** 录音期自动增益：输入过小自动提升、接近削波回落，学到的值按设备记忆 */
  autoGain?: boolean;
}

export interface AsrConfig {
  /** http（云端/自建接口）| local（内置离线 Whisper） */
  provider: 'http' | 'local' | 'mimo';
  baseUrl: string;
  apiKey: string;
  model: string;
  language: string;
  endpointPath: string;
  /** 热词（行业术语），每行一个或用逗号分隔，直接传给支持热词的 ASR（如 GLM-ASR） */
  hotwords: string;
  timeoutSec: number;
  /** 内置本地模型 id */
  localModel: string;
  /** 模型下载镜像 */
  mirror: string;
  /** 边说边出字：录音期间按停顿自动分段识别 */
  streaming: boolean;
  // **u8EBA6C148BCD6E057406**
  stripFillers: boolean;
}

/** 内置本地模型状态 */
export interface LocalModelStatus {
  id: string;
  name: string;
  desc: string;
  sizeMb: number;
  downloaded: boolean;
  /** whisper（内置 candle）| qwen（llama.cpp 子进程） */
  kind?: 'whisper' | 'qwen';
  /** qwen：llama.cpp 运行时是否就绪 */
  runtimeReady?: boolean;
  /** qwen：运行时后端（vulkan / cpu） */
  backend?: string;
}

export interface LlmConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  mode: LlmMode;
  glossary: string;
  customPrompt: string;
  timeoutSec: number;
}

export interface OutputConfig {
  method: PasteMethod;
  pasteKey: PasteKey;
  autoPaste: boolean;
  autoSubmit: boolean;
  restoreClipboard: boolean;
  /** 输入前在悬浮窗中确认（可编辑后再输入） */
  review: boolean;
}

export interface GeneralConfig {
  showOverlay: boolean;
  closeToTray: boolean;
  /** 开始/结束录音时的声音反馈 */
  soundFeedback: boolean;
  /** 开机自启动 */
  autostart: boolean;
  /** dark / light */
  theme: 'dark' | 'light';
  /** 界面缩放 0.85 ~ 1.30 */
  fontScale: number;
}

/** 外接显示（硬件字幕屏）API */
export interface ExternalDisplayConfig {
  /** 启用外接显示 API 服务 */
  enabled: boolean;
  /** 服务端口 */
  port: number;
  /** 允许局域网设备连接（false=仅本机） */
  allowLan: boolean;
  /** 外接显示时不再弹出本地聆听悬浮窗 */
  hideLocalOverlay: boolean;
}

export interface Config {
  hotkey: HotkeyConfig;
  audio: AudioConfig;
  asr: AsrConfig;
  llm: LlmConfig;
  output: OutputConfig;
  general: GeneralConfig;
  externalDisplay: ExternalDisplayConfig;
}

export interface HistoryItem {
  ts: number;
  raw: string;
  final: string;
  asrMs?: number | null;
  llmMs?: number | null;
}

export type Stage =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'optimizing'
  | 'review'
  | 'done'
  | 'error';

export interface StatusPayload {
  stage: Stage;
  message: string;
  sound?: boolean;
}

/** 一次会话使用的模型链路（Rust 在识别开始时广播） */
export interface MetaPayload {
  asrModel: string;
  llmEnabled: boolean;
  llmModel: string;
  skip: boolean;
}

/** 输入设备（含默认标记与规格） */
export interface DeviceInfo {
  name: string;
  isDefault: boolean;
  channels: number | null;
  sampleRate: number | null;
  sampleFormat: string | null;
}

/** 麦克风测试结果（电平 0~100） */
export interface MicTestResult {
  avgLevel: number;
  peakLevel: number;
  wavBase64?: string | null;
}

export type TabId =
  | 'dash'
  | 'hotkey'
  | 'mic'
  | 'asr'
  | 'llm'
  | 'output'
  | 'display'
  | 'history'
  | 'about';

/** 各设置分页共享的 props */
export interface TabProps {
  cfg: Config;
  set: <K extends keyof Config>(key: K, patch: Partial<Config[K]>) => void;
  toast: (s: string) => void;
  navigate: (tab: TabId) => void;
  stage: Stage;
  statusMsg: string;
  recording: boolean;
  devices: DeviceInfo[];
  refreshDevices: () => void;
  localModels: LocalModelStatus[];
  refreshLocalModels: () => void;
  history: HistoryItem[];
  refreshHistory: () => void;
  onRecordToggle: () => void;
}
