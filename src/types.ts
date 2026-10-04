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
  /** 快速模式快捷键（可选）：跳过 AI 优化直接输出 ASR 原文 */
  keyQuick: string;
  /** 翻译模式快捷键（可选）：本次听写强制翻译，输出目标语言译文 */
  keyTranslate: string;
  /** 划词翻译快捷键（可选）：翻译任意应用中选中的文字（弹悬浮窗，可复制/替换） */
  keyTranslateSel: string;
  /** 截图取词快捷键（可选）：框选屏幕区域 OCR 识别（弹悬浮窗，可复制/翻译/输入） */
  keyOcr: string;
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
  /** whisper（内置 candle）| qwen（llama.cpp 子进程）| llm（本地翻译引擎，llama.cpp 子进程）| ppocr（截图取词质量档，ort 进程内推理） */
  kind?: 'whisper' | 'qwen' | 'llm' | 'ppocr';
  /** qwen / llm：llama.cpp 运行时是否就绪 */
  runtimeReady?: boolean;
  /** qwen / llm：运行时后端（vulkan / cpu） */
  backend?: string;
}

/** 命名指令模板（llm.promptTemplates）：一键套用到 customPrompt */
export interface PromptTemplate {
  id: string;
  name: string;
  prompt: string;
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
  /** 指令模板库（可选，旧配置缺省为空） */
  promptTemplates?: PromptTemplate[];
}

/** 划词翻译行为配置。目标语言与听写翻译共用 llm.translateTarget */
export interface TranslateConfig {
  /** 译文出来后自动复制到剪贴板 */
  autoCopy: boolean;
  /** 强制模拟复制取词（跳过 UIA；兼容 UIA 取不到文字的应用） */
  forcedCopy: boolean;
  /** 「替换原文」时在译文前加「翻 」标记，防误替换（可关） */
  replaceMarker: boolean;
  /** 黑名单（每行一个关键字）：前台窗口标题或进程名命中时不触发划词翻译 */
  blacklist: string;
  /** 复制即翻译：监听剪贴板变化，复制文字后自动弹出翻译卡片（默认关，敏感内容慎用） */
  clipboardWatch: boolean;
  /** Ctrl+C+C 双击复制即翻译（DeepL 式低级键盘钩子，仅 Windows，默认关） */
  ccc: boolean;
  /** 结构化智能翻译：JSON/YAML/键值只翻译字符串值，键名、注释、格式原样保留（默认开） */
  structuredTranslate: boolean;
  /** 翻译引擎：cloud（云端 LLM，默认）| local（本地 llama.cpp，离线·隐私·免费） */
  engine: 'cloud' | 'local';
  /** 本地引擎模型 id（local_llm::MODELS） */
  localModel: string;
}

/** 截图取词（OCR）配置。引擎分层：system=Windows 内置离线引擎（零下载）；
 *  ppocr / vlm 为后续质量档预留 */
export interface OcrConfig {
  /** 功能总开关（关闭后热键/托盘不响应） */
  enabled: boolean;
  /** system（Windows.Media.Ocr）| ppocr | vlm（预留位） */
  engine: string;
  /** auto（跟随系统用户语言）或语言前缀（zh / en / ja / ko …） */
  language: string;
  /** 识别完成后不弹 OCR 卡片，直接进入翻译流程（截图翻译一键链） */
  autoTranslate: boolean;
  /** 识别完成后自动把文本复制到剪贴板 */
  copyOnCapture: boolean;
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
  /** dark / light / auto（auto=跟随系统） */
  theme: 'dark' | 'light' | 'auto';
  /** 界面缩放 0.85 ~ 1.30 */
  fontScale: number;
  /** 历史记录保留条数（后端默认 50） */
  historyLimit?: number;
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
  /** 划词翻译（DeepL 式客户端体验） */
  translate: TranslateConfig;
  /** 截图取词（OCR）：框选识别 → 复制/翻译/输入 */
  ocr: OcrConfig;
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
  /** dictation（听写）/ translate（划词·输入翻译）/ ocr（截图取词）；旧数据缺省时按 asrMs==null 推断为 translate */
  kind?: 'dictation' | 'translate' | 'ocr';
  /** 收藏置顶：不占保留条数名额，截断时始终保留（后端上限 20 个） */
  pinned?: boolean;
}

/** 全量使用统计（后端 stats.json 持久累计，不受历史保留窗口影响）。
 *  days 为 [YYYY-MM-DD, 条数]，按日期升序、只含最近 60 天；
 *  chars 与前端 [...str].length 同为码点口径。 */
export interface UsageStats {
  total: number;
  chars: number;
  days: [string, number][];
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
  | 'translate'
  | 'ocr'
  | 'output'
  | 'display'
  | 'history'
  | 'about';

/** 各设置分页共享的 props */
export interface TabProps {
  cfg: Config;
  set: <K extends keyof Config>(key: K, patch: Partial<Config[K]> | Config[K]) => void;
  /** kind 缺省时按文案正则推断（向后兼容） */
  toast: (s: string, kind?: 'ok' | 'error' | 'info') => void;
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
