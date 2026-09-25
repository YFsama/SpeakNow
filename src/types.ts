export type HotkeyMode = 'hold' | 'toggle';
export type LlmMode = 'correct' | 'polish' | 'prompt' | 'translate';
export type PasteMethod = 'clipboard' | 'typing';
export type PasteKey = 'auto' | 'ctrl+v' | 'ctrl+shift+v' | 'shift+insert' | 'terminal-typing';

/** 翻译目标语言候选（代码 → 展示名），与后端 config::TRANSLATE_LANGS 保持一致 */
export const TRANSLATE_LANGS: ReadonlyArray<[string, string]> = [
  ['zh', '中文'],
  ['en', 'English'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['es', 'Español'],
  ['ru', 'Русский'],
];

export const langName = (code: string) =>
  TRANSLATE_LANGS.find(([c]) => c === code)?.[1] ?? code;

/** 统一 API 凭据组：一处维护 base_url + api_key，语音识别与 AI 优化共同引用 */
export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
}

export interface HotkeyConfig {
  key: string;
  /** 快速模式快捷键（可选）：跳过 AI 优化直接输出原文 */
  keyQuick: string;
  /** 翻译模式快捷键（可选）：本次听写强制翻译，输出目标语言译文 */
  keyTranslate: string;
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
  /** 引用凭据组 id：命中时以凭据组的 baseUrl/apiKey 为准，空则用下方内联字段 */
  providerId?: string;
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
  /** 清理语气词（「嗯/呃/yeah」等口头音与呼吸声幻觉） */
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
  /** 引用凭据组 id：命中时以凭据组的 baseUrl/apiKey 为准，空则用下方内联字段 */
  providerId?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  mode: LlmMode;
  glossary: string;
  customPrompt: string;
  timeoutSec: number;
  /** 翻译目标语言代码（见 TRANSLATE_LANGS） */
  translateTarget: string;
  /** 第二目标语言：识别语言==目标语言时改译为此语言（如目标 en、第二 zh：说中出英、说英出中） */
  translateSecondTarget: string;
  /** translation（仅译文）| bilingual（原文 + 译文两行） */
  translateOutput: 'translation' | 'bilingual';
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
  /** 统一 API 凭据组（v2 配置；旧配置启动时自动迁移） */
  providers: ProviderProfile[];
  hotkey: HotkeyConfig;
  audio: AudioConfig;
  asr: AsrConfig;
  llm: LlmConfig;
  output: OutputConfig;
  general: GeneralConfig;
  externalDisplay: ExternalDisplayConfig;
}

/** 展开凭据组引用后的生效凭据（providerId 命中 → 凭据组，否则内联字段） */
export function resolvedAsrCreds(cfg: Config): { baseUrl: string; apiKey: string } {
  const p = cfg.providers?.find((x) => x.id === cfg.asr.providerId);
  return p
    ? { baseUrl: p.baseUrl, apiKey: p.apiKey }
    : { baseUrl: cfg.asr.baseUrl, apiKey: cfg.asr.apiKey };
}

export function resolvedLlmCreds(cfg: Config): { baseUrl: string; apiKey: string } {
  const p = cfg.providers?.find((x) => x.id === cfg.llm.providerId);
  return p
    ? { baseUrl: p.baseUrl, apiKey: p.apiKey }
    : { baseUrl: cfg.llm.baseUrl, apiKey: cfg.llm.apiKey };
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

/** 一次会话使用的模型链路（Rust 在识别开始时广播） */
export interface MetaPayload {
  asrModel: string;
  llmEnabled: boolean;
  llmModel: string;
  skip: boolean;
  /** 本次会话为翻译模式 */
  translate?: boolean;
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
  set: <K extends keyof Config>(key: K, patch: Partial<Config[K]> | Config[K]) => void;
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
