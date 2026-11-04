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
  /** 文本模拟输入快捷键（可选）：打开 Typist 小窗，粘贴大段文本后模拟键盘逐字敲进目标窗口 */
  keyTypist: string;
  /** 输入框翻译快捷键：读取聚焦输入框的未发送草稿，翻译后替换回输入框；空 = 未启用 */
  keyTranslateInput: string;
  /** 记忆召回快捷键：呼出悬浮搜索卡，检索记忆库并一键注入当前输入框；空 = 未启用 */
  keyMemRecall: string;
  mode: HotkeyMode;
  enabled: boolean;
  /** 短于该时长的录音视为误触忽略（ms，默认 800；hold 模式说短口令可调低） */
  minDurationMs: number;
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
  /** 双击判定窗口（ms，默认 350；慢手按不出可放宽到 500~600） */
  cccWindowMs: number;
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

/** 文本模拟输入（Typist）节奏配置：目标应用对连发按键的承受力差异很大 */
export interface TypistConfig {
  /** 每个按键之间的间隔（ms）。UI 为速度滑杆（档位见 typist-logic 的 SPEED_LEVELS） */
  charDelayMs: number;
  /** 每次回车后的额外停顿（ms）：目标应用对回车的响应多为异步，行尾立刻跟下一行容易丢字 */
  lineDelayMs: number;
  /** 点击开始后到落下第一个字符的倒计时（ms）：留时间确认焦点已回到目标输入框 */
  startDelayMs: number;
  /** 小窗置顶（对照原文抄录时目标页面要滚动查看，小窗不能被盖住） */
  alwaysOnTop?: boolean;
}

export interface OutputConfig {
  method: PasteMethod;
  pasteKey: PasteKey;
  autoPaste: boolean;
  autoSubmit: boolean;
  restoreClipboard: boolean;
  /** 输入前在悬浮窗中确认（可编辑后再输入） */
  review: boolean;
  /** 「自动回车」进程黑名单（关键字，大小写不敏感子串匹配）：命中只输入不回车，
   *  防微信/QQ 等聊天工具把半句话直接发送 */
  autoSubmitBlocklist: string[];
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
  /** 本地引擎空闲自动释放（分钟，0=常驻不释放）：llama-server 常驻可达 ~10GB 提交内存 */
  localIdleMin?: number;
  /** 悬浮卡驻留时长乘子（0.6 短 / 1 标准 / 1.8 长）：各卡默认驻留统一缩放 */
  lingerMult?: number;
  /** 启动时自动检查 GitHub Release 更新（只提示，不自动安装） */
  autoCheckUpdate?: boolean;
  /** 已选择「跳过此版本」的版本号：该版本不再提示，清空恢复 */
  skipVersion?: string;
  /** 强调色主题 id（sky/indigo/violet/teal/amber）：驱动 data-accent 与全套强调色变量 */
  accent?: string;
  /** 更新包下载镜像前缀（空 = GitHub 直连；仅前缀拼接，内容仍过 sha256 校验） */
  downloadMirror?: string;
  /** 发现新版本后后台静默预下载（受 autoCheckUpdate 约束；就绪后提示安装） */
  autoDownloadUpdate?: boolean;
  /** 本地优先模式（隐私开关）：强制本地识别/优化/翻译引擎，语音与文字数据
   *  不出本机——云端 ASR 与 LLM 暂停（本机自建 Ollama 等端点不受影响），
   *  翻译强制本地引擎；需要已下载的本地模型 */
  localOnly?: boolean;
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

/** 记忆库（Mem）：把听写 / 截图取词 / 翻译的产出自动沉淀为可检索的个人记忆
 *  （借鉴 Nowledge Mem 的「记忆层」理念：本地优先、可蒸馏、可检索） */
export interface MemConfig {
  /** 功能总开关：关闭后不再采集，已有记忆仍可查看 */
  enabled: boolean;
  /** 听写结果自动入库 */
  captureDictation: boolean;
  /** 截图取词结果自动入库 */
  captureOcr: boolean;
  /** 划词 / 输入框翻译结果自动入库 */
  captureTranslate: boolean;
  /** 入库时用已配置的 LLM 蒸馏关键词与一句话摘要（失败静默跳过，纯文本照常入库） */
  distill: boolean;
  /** 采集黑名单（每行一个关键字，子串匹配进程名）：命中不入库；密码管理器内置名单始终生效 */
  captureBlacklist: string;
  /** 记忆 REST 令牌：loopback 免钥，局域网访问 /mem/* 必须携带 X-SN-API-Key；空 = 未生成 */
  apiToken: string;
  /** 保留条数（滚动清理） */
  limit: number;
}

/** 一条记忆：由听写 / 截图取词 / 翻译产出自动沉淀，或经导入中心（网页 / 文件 / 项目 / 快记）录入 */
export interface MemEntry {
  ts: number;
  /** dictation（听写）/ ocr（截图取词）/ translate（划词·输入框翻译）/
   *  note（快记·剪贴板）/ web（网页导入）/ file（文件·项目文档导入） */
  kind: 'dictation' | 'ocr' | 'translate' | 'note' | 'web' | 'file';
  /** 采集时的前台应用名（exe 基名，如 chrome；取不到为空串） */
  app: string;
  /** 展示标题：LLM 蒸馏摘要或正文前若干字 */
  title: string;
  /** 正文（听写终稿 / OCR 文本 / 译文） */
  text: string;
  /** LLM 蒸馏关键词（未蒸馏为空数组） */
  keywords: string[];
  distilled: boolean;
  /** 置顶：不占保留条数名额（后端上限 20 个） */
  pinned: boolean;
  /** 正文字符数（码点口径，与前端 [...str].length 一致） */
  chars: number;
  /** 近重复再次出现次数（同源高度相似内容不另立条目，只累计） */
  hits?: number;
  /** 实际使用次数（召回注入 / 复制才算，检索命中不算——防错误记忆自我强化） */
  uses?: number;
  /** 上次实际使用时间戳（ms，0 = 从未）；用过即在新近度排序中浮顶 */
  lastUsedAt?: number;
  /** 软作废：被哪条记忆的时间戳取代（0 = 在世）。AI 蒸馏判定语义重复/过时后
   *  标记；召回与 context.md 默认过滤，设置页可见、导出保留（作废优先于删除） */
  supersededBy?: number;
}

/** 导入结果摘要（网页 / 文件 / 项目 / 快记共用） */
export interface MemImportSummary {
  /** 新建条数 */
  added: number;
  /** 近重复合并进既有条目（hits +1）的条数 */
  merged: number;
  /** 因大小超限/解析失败/非法路径等跳过的条数（显式导入不走采集黑名单） */
  skipped: number;
}

/** 存储统计（记忆页存储卡与容量管理用） */
export interface MemStorageStats {
  items: number;
  pinned: number;
  superseded: number;
  /** mem.json 字节数 */
  bytes: number;
  /** mem.bak 字节数（0 = 无备份） */
  bakBytes: number;
  chars: number;
}

/** 导入进度（批量导入时后端逐文件广播；label 为当前文件/来源描述） */
export interface MemImportProgress {
  done: number;
  total: number;
  label: string;
}

/** mem_list 返回：条目 + 概览统计（统计不受查询过滤影响） */
export interface MemListResult {
  items: MemEntry[];
  total: number;
  todayCount: number;
  totalChars: number;
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
  /** 文本模拟输入（Typist）：整段文本模拟键盘逐字敲进目标窗口 */
  typist: TypistConfig;
  output: OutputConfig;
  general: GeneralConfig;
  externalDisplay: ExternalDisplayConfig;
  /** 记忆库（Mem） */
  mem: MemConfig;
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

/** GitHub Release 检查结果（Rust update::UpdateInfo 的前端镜像） */
export interface UpdateInfo {
  current: string;
  latest: string;
  tag: string;
  updateAvailable: boolean;
  /** Release 说明（markdown 原文） */
  notes: string;
  /** 本平台安装包下载地址（空 = 无可用安装包） */
  downloadUrl: string;
  /** 安装包大小（字节，未知为 0） */
  assetSize: number;
  publishedAt: string;
  htmlUrl: string;
}

export type TabId =
  | 'dash'
  | 'mem'
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
  /** 启动时自动检查到的更新结果（null = 未检查或无新版本）；关于页复用展示 */
  updateInfo?: UpdateInfo | null;
}
