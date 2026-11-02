/* ============================================================
 * 浏览器视觉验证 mock（仅 dev + ?mock=1 生效，不进生产包）
 *
 * 目的：让设置窗口 / 悬浮窗能在纯浏览器（无 Tauri shell）中带
 * 假数据渲染，供界面改动前后截图对比与视觉走查。
 *
 * 原理：@tauri-apps/api v2 的 invoke / transformCallback 全部路由到
 * window.__TAURI_INTERNALS__；在应用 bundle 加载前抢先注入即可拦截。
 *
 * 控制台驱动（截图各状态用）：
 *   __mock.tab('mic')                 // 切换设置页（主窗口）
 *   __mock.stage('recording', '说话中') // 广播 sn-status
 *   __mock.emit('sn-llm-delta', {…})   // 广播任意事件
 *   __mock.toast('已保存 ✓')
 * ============================================================ */

type Cb = (payload: unknown) => void;
const listeners = new Map<number, { event: string; cb: Cb }>();
const eventHandlers = new Map<string, Set<number>>();
let cbSeq = 1;

const now = Date.now();

const mockConfig = {
  providers: [
    {
      id: 'p1',
      name: '智谱 BigModel',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-mock-xxxxxxxxxxxxxxxx',
    },
  ],
  hotkey: {
    key: 'Control+Shift+Space',
    keyQuick: 'Control+Shift+Q',
    keyTranslate: '',
    keyTranslateSel: 'Alt+T',
    keyOcr: 'Alt+S',
    keyTypist: 'Alt+Y',
    keyTranslateInput: '',
    keyMemRecall: 'Alt+M',
    mode: 'toggle',
    enabled: true,
    minDurationMs: 800,
  },
  audio: {
    device: 'DJI Mic 2 (USB)',
    vadEnabled: true,
    vadSilenceMs: 900,
    vadThreshold: 2,
    maxDurationSec: 60,
    gainDb: 6.5,
    gainDbByDevice: { 'DJI Mic 2 (USB)': 6.5, __default__: 2 },
    autoGain: true,
  },
  asr: {
    provider: 'http',
    providerId: 'p1',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-asr',
    language: 'zh',
    endpointPath: '/audio/asr',
    hotwords: 'Tauri\nRust\nSpeakNow',
    timeoutSec: 30,
    localModel: 'whisper-base',
    mirror: 'https://hf-mirror.com',
    streaming: true,
    stripFillers: true,
  },
  llm: {
    enabled: true,
    providerId: 'p1',
    baseUrl: '',
    apiKey: '',
    model: 'glm-4.7',
    mode: 'polish',
    glossary: '',
    customPrompt: '',
    timeoutSec: 60,
    translateTarget: 'en',
    translateSecondTarget: 'zh',
    translateOutput: 'translation',
    promptTemplates: [
      {
        id: 't1',
        name: '代码评审要点',
        prompt: '把下面的口述整理成给 AI 编程助手的指令，重点突出：{text}',
      },
    ],
  },
  translate: {
    autoCopy: false,
    forcedCopy: false,
    replaceMarker: true,
    blacklist: '1Password\nKeePass',
    clipboardWatch: false,
    ccc: false,
    cccWindowMs: 350,
    structuredTranslate: true,
    engine: 'local',
    localModel: 'index-translate-2b',
  },
  ocr: {
    enabled: true,
    engine: 'system',
    language: 'auto',
    autoTranslate: false,
    copyOnCapture: false,
  },
  typist: {
    charDelayMs: 15,
    lineDelayMs: 120,
    startDelayMs: 800,
    alwaysOnTop: false,
  },
  output: {
    method: 'clipboard',
    pasteKey: 'auto',
    autoPaste: true,
    autoSubmit: false,
    restoreClipboard: true,
    review: false,
    autoSubmitBlocklist: ['wechat', 'weixin', 'qq', 'dingtalk', 'feishu', 'telegram', 'discord', 'slack'],
  },
  general: {
    showOverlay: true,
    closeToTray: true,
    soundFeedback: true,
    autostart: true,
    theme: 'dark',
    fontScale: 1,
    historyLimit: 50,
    localIdleMin: 0,
    lingerMult: 1,
    autoCheckUpdate: true,
    skipVersion: '',
    accent: 'sky',
  },
  mem: {
    enabled: true,
    captureDictation: true,
    captureOcr: true,
    captureTranslate: true,
    distill: false,
    captureBlacklist: '',
    apiToken: 'sn-demo-token-0000',
    limit: 500,
  },
  externalDisplay: {
    enabled: false,
    port: 8866,
    allowLan: false,
    hideLocalOverlay: false,
  },
};

const mockDevices = [
  {
    name: 'DJI Mic 2 (USB)',
    isDefault: true,
    channels: 1,
    sampleRate: 48000,
    sampleFormat: 'f32',
  },
  {
    name: '麦克风阵列 (Realtek Audio)',
    isDefault: false,
    channels: 2,
    sampleRate: 48000,
    sampleFormat: 'f32',
  },
  {
    name: 'Wireless Controller Mic',
    isDefault: false,
    channels: 1,
    sampleRate: 44100,
    sampleFormat: 'i16',
  },
];

const mockModels = [
  {
    id: 'whisper-tiny',
    name: 'Whisper Tiny 量化',
    desc: '最快验证档',
    sizeMb: 42,
    downloaded: true,
    kind: 'whisper',
  },
  {
    id: 'whisper-base',
    name: 'Whisper Base',
    desc: '推荐起步',
    sizeMb: 291,
    downloaded: true,
    kind: 'whisper',
  },
  {
    id: 'whisper-small',
    name: 'Whisper Small',
    desc: '更高精度',
    sizeMb: 967,
    downloaded: false,
    kind: 'whisper',
  },
  {
    id: 'qwen3-asr-1.7b',
    name: 'Qwen3-ASR 1.7B',
    desc: '离线高精度中文',
    sizeMb: 2400,
    downloaded: false,
    kind: 'qwen',
    runtimeReady: true,
    backend: 'vulkan',
  },
  {
    id: 'index-translate-2b',
    name: 'Index-Translate-2B',
    desc: '本地翻译引擎',
    sizeMb: 1300,
    downloaded: true,
    kind: 'llm',
    runtimeReady: true,
    backend: 'cpu',
  },
];

const mockHistory = [
  {
    ts: now - 1000 * 60 * 12,
    raw: '帮我把这个函数改成 async 的然后加一下错误处理',
    final: '帮我把这个函数改成 async 的，然后加一下错误处理。',
    asrMs: 640,
    llmMs: 980,
    kind: 'dictation',
  },
  {
    ts: now - 1000 * 60 * 55,
    raw: '明天下午三点提醒我参加设计评审',
    final: '明天下午 3 点提醒我参加设计评审。',
    asrMs: 590,
    llmMs: 760,
    kind: 'dictation',
  },
  {
    ts: now - 1000 * 60 * 60 * 5,
    raw: 'the quick brown fox jumps over the lazy dog',
    final: '敏捷的棕色狐狸跳过了懒惰的狗。',
    asrMs: null,
    llmMs: 1310,
    kind: 'translate',
  },
  {
    ts: now - 1000 * 60 * 60 * 26,
    raw: 'git checkout dash 再 cherry-pick 那个 commit',
    final: 'git checkout dash 分支，再 cherry-pick 那个 commit。',
    asrMs: 510,
    llmMs: 690,
    kind: 'dictation',
    pinned: true,
  },
  {
    ts: now - 1000 * 60 * 60 * 27,
    raw: '嗯那个我觉得这个地方可以优化一下',
    final: '这个地方可以优化一下。',
    asrMs: 480,
    llmMs: 820,
    kind: 'dictation',
  },
  {
    ts: now - 1000 * 60 * 60 * 28,
    raw: 'src/main.rs 中的 spawn_blocking 用法',
    final: 'src/main.rs 中的 spawn_blocking 用法',
    asrMs: 210,
    llmMs: null,
    kind: 'ocr',
  },
];

/** 记忆库示例数据（覆盖三类来源/多天/置顶/已蒸馏，供记忆页与总览在浏览器验证） */
const MIN = 1000 * 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const mockMem: {
  ts: number;
  kind: 'dictation' | 'ocr' | 'translate' | 'note' | 'web' | 'file';
  app: string;
  title: string;
  text: string;
  keywords: string[];
  distilled: boolean;
  pinned: boolean;
  chars: number;
  /** 近重复再次出现次数 */
  hits?: number;
  /** 实际使用（注入/复制）次数 */
  uses?: number;
  /** 上次使用时间戳（0=从未） */
  lastUsedAt?: number;
  /** 被哪条记忆取代（软作废，0=在世） */
  supersededBy?: number;
}[] = [
  {
    ts: now - 3 * MIN,
    kind: 'dictation',
    app: 'cursor',
    title: '关于记忆库检索的口述笔记',
    text: '记忆库的检索按空格分词做 AND 匹配，关键词命中权重最高，标题次之，正文最低。中英文都支持，数字与路径原样匹配。',
    keywords: ['记忆库', '检索'],
    distilled: true,
    pinned: false,
    chars: 62,
  },
  {
    ts: now - 26 * MIN,
    kind: 'translate',
    app: 'chrome',
    title: 'Hybrid retrieval design note',
    text: '混合检索设计说明：先向量召回再重排的方案延迟约 200ms，索引可全量重建。',
    keywords: ['混合检索', '重排'],
    distilled: true,
    pinned: true,
    // 刚用过一次：召回空查询里浮顶的示例
    uses: 1,
    lastUsedAt: now - 2 * MIN,
    chars: 44,
  },
  {
    ts: now - 2 * HOUR,
    kind: 'ocr',
    app: 'wechat',
    title: '会议白板照片里的排期表',
    text: 'v0.6 排期：蒸馏调度 10/30、图谱抽取 11/02、混合检索 11/05、灰度 11/08。',
    keywords: [],
    distilled: false,
    pinned: false,
    chars: 46,
  },
  {
    ts: now - 5 * HOUR,
    kind: 'dictation',
    app: 'wechat',
    title: '回复合作方的问题：数据存哪',
    text: '数据全部保存在本机的应用配置目录，不上传任何服务器；导出功能可以随时带走全部内容。',
    keywords: [],
    distilled: false,
    pinned: false,
    chars: 47,
  },
  {
    ts: now - 1 * DAY - 40 * MIN,
    kind: 'dictation',
    app: 'cursor',
    title: 'spawn_blocking 与主线程阻塞的复盘',
    text: '上次保存卡住的根因是 WASAPI 开流阻塞了主线程，重活必须走 spawn_blocking，热键回调里只做轻量调度。',
    keywords: ['spawn_blocking', '线程模型'],
    distilled: true,
    pinned: false,
    chars: 57,
    // 同一内容反复口述过三次：近重复合并的示例
    hits: 3,
    uses: 2,
    lastUsedAt: now - 4 * HOUR,
  },
  {
    ts: now - 2 * DAY,
    kind: 'translate',
    app: 'word',
    title: 'Local-first architecture translated',
    text: '本地优先架构：数据默认留在设备上，云能力全部可选，断网时核心功能不受影响。',
    keywords: [],
    distilled: false,
    pinned: false,
    chars: 39,
  },
  {
    ts: now - 3 * DAY,
    kind: 'ocr',
    app: 'chrome',
    title: '剪贴板还原逻辑的注释片段',
    text: '粘贴注入三重保障：PASTE_LOCK 串行化、写入后校验、延时还原原文；历史上出过串话事故，改动前先读头部注释。',
    keywords: ['剪贴板', 'PASTE_LOCK'],
    distilled: true,
    pinned: false,
    chars: 55,
  },
  {
    ts: now - 4 * DAY,
    kind: 'note',
    app: '',
    title: '快记：服务器年费续期日',
    text: '服务器年费每年 3 月 15 日续期，记得提前一周比价。',
    keywords: [],
    distilled: false,
    pinned: true,
    chars: 24,
  },
  {
    ts: now - 5 * DAY,
    kind: 'web',
    app: 'llvm.org',
    title: 'LLVM getting started',
    text: '从源码构建 LLVM：cmake 配置、Ninja 构建、运行测试套件的官方入门步骤。',
    keywords: ['LLVM', '构建'],
    distilled: true,
    pinned: false,
    chars: 39,
  },
  {
    ts: now - 6 * DAY,
    kind: 'file',
    app: 'SpeakNow',
    title: 'AGENTS.md — 危险区约定',
    text: 'unsafe 集中地与线程模型：热键/托盘回调在主线程，重活必须走 pipeline::post_* 或 spawn_blocking。',
    keywords: ['AGENTS.md', '线程模型'],
    distilled: true,
    pinned: false,
    chars: 47,
  },
  {
    ts: now - 7 * DAY,
    kind: 'note',
    app: '',
    title: '旧口径：例会定在周一',
    text: '团队例会定在每周一上午十点。',
    keywords: [],
    distilled: false,
    pinned: false,
    chars: 15,
    // 软作废示例：已被新快记取代（召回/上下文默认过滤，设置页可见）
    supersededBy: now - 4 * DAY,
  },
];

/** 与后端 mem_list 同口径的检索：空格分词 AND 匹配（关键词>标题>正文加权）；
 *  无查询时置顶优先 + 时间倒序，有查询时按命中分排序 */
let mockMemBak: (typeof mockMem) | null = null;
let mockMemPreRestore: (typeof mockMem) | null = null;
void mockMemPreRestore;
function mockMemSearch(
  query: string,
  kind: string | null,
  limit: number,
): {
  items: typeof mockMem;
  total: number;
  todayCount: number;
  totalChars: number;
} {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scoreOf = (m: (typeof mockMem)[number]) => {
    if (kind && m.kind !== kind) return null;
    let score = 0;
    for (const t of terms) {
      let s = 0;
      if (m.keywords.some((k) => k.toLowerCase().includes(t))) s = 3;
      else if (m.title.toLowerCase().includes(t)) s = 2;
      else if (m.text.toLowerCase().includes(t)) s = 1;
      if (s === 0) return null; // 任一词未命中即淘汰（AND）
      score += s;
    }
    return score;
  };
  const scored = mockMem
    .map((m) => ({ m, score: scoreOf(m) }))
    .filter((x): x is { m: (typeof mockMem)[number]; score: number } => x.score !== null);
  scored.sort((a, b) =>
    terms.length === 0
      ? Number(b.m.pinned) - Number(a.m.pinned) || b.m.ts - a.m.ts
      : b.score - a.score || b.m.ts - a.m.ts,
  );
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return {
    items: scored.slice(0, limit).map((x) => x.m),
    total: mockMem.length,
    todayCount: mockMem.filter((m) => m.ts >= todayStart.getTime()).length,
    totalChars: mockMem.reduce((s, m) => s + m.chars, 0),
  };
}

/** 模拟输入的进行中状态（typing_start/stop/status 三命令共享；真机由 Rust 原子量持有） */
const mockTyping: {
  active: boolean;
  done: number;
  total: number;
  /** 本轮目标窗口标题（真机在倒计时结束后由 Rust 捕获） */
  target: string;
  timers: ReturnType<typeof setTimeout>[];
} = { active: false, done: 0, total: 0, target: '', timers: [] };

/** 翻译会话代数（translate_input_cmd 递增）：悬浮窗按 gen 丢弃迟到的旧会话结果，
 *  固定值会被上一张卡片判为过期而丢弃，须像真机一样逐次 +1 */
let mockTranslateGen = 0;

function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      switch (cmd) {
        case 'plugin:event|listen': {
          const { event, handler } = args as { event: string; handler: number };
          const entry = listeners.get(handler);
          if (entry) {
            let set = eventHandlers.get(event);
            if (!set) eventHandlers.set(event, (set = new Set()));
            set.add(handler);
          }
          resolve(handler);
          return;
        }
        case 'plugin:event|unlisten': {
          const { event, event_id } = args as { event: string; event_id: number };
          eventHandlers.get(event)?.delete(event_id);
          resolve(undefined);
          return;
        }
        case 'plugin:app|version':
          resolve('0.4.8-dev-mock');
          return;
        case 'get_config':
          resolve(JSON.parse(JSON.stringify(mockConfig)));
          return;
        case 'save_config':
          Object.assign(mockConfig, JSON.parse(JSON.stringify(args.config)));
          resolve('ok');
          return;
        case 'reset_config':
          resolve(JSON.parse(JSON.stringify(mockConfig)));
          return;
        case 'open_config_dir':
        case 'open_mic_settings':
        case 'open_language_settings':
        case 'open_display_page':
        case 'restart_elevated':
        case 'download_builtin':
        case 'delete_builtin':
        case 'clear_history':
        case 'delete_history':
        case 'dismiss_overlay':
        case 'overlay_pin':
        case 'overlay_set_manual':
        case 'ocr_cancel':
        case 'start_recording':
        case 'stop_recording':
        case 'cancel_review':
          resolve('ok');
          return;
        case 'list_devices':
          resolve(mockDevices);
          return;
        case 'builtin_models':
          resolve(mockModels);
          return;
        case 'get_history':
          resolve(mockHistory);
          return;
        case 'get_stats': {
          // 从 mock 历史推算（与后端播种口径一致），days 覆盖近 7 天
          const byDay = new Map<string, number>();
          for (const h of mockHistory) {
            const d = new Date(h.ts);
            const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            byDay.set(k, (byDay.get(k) ?? 0) + 1);
          }
          resolve({
            total: mockHistory.length,
            chars: mockHistory.reduce((s, h) => s + [...h.final].length, 0),
            days: [...byDay.entries()].sort(),
          });
          return;
        }
        case 'update_history_final': {
          const { ts, finalText } = args as { ts: number; finalText: string };
          const item = mockHistory.find((h) => h.ts === ts);
          if (item) item.final = finalText;
          resolve(undefined);
          return;
        }
        case 'history_set_pin': {
          const { ts, pinned } = args as { ts: number; pinned: boolean };
          const item = mockHistory.find((h) => h.ts === ts);
          if (item) item.pinned = pinned;
          resolve(undefined);
          return;
        }
        case 'mem_list': {
          const { query, kind, limit } = args as {
            query: string;
            kind: string | null;
            limit: number;
          };
          resolve(mockMemSearch(query ?? '', kind ?? null, limit ?? 50));
          return;
        }
        case 'mem_delete_batch': {
          const { ts } = args as { ts: number[] };
          const dead = new Set(ts);
          // 与后端同口径：返回实际删除数（含已不存在的 ts 时不计入）
          let removed = 0;
          for (let i = mockMem.length - 1; i >= 0; i--) {
            if (dead.has(mockMem[i].ts)) {
              mockMem.splice(i, 1);
              removed++;
            }
          }
          emit('sn-mem-changed');
          resolve(removed);
          return;
        }
        case 'mem_set_pinned': {
          const { ts, pinned } = args as { ts: number; pinned: boolean };
          const item = mockMem.find((m) => m.ts === ts);
          if (item) item.pinned = pinned;
          emit('sn-mem-changed');
          resolve(undefined);
          return;
        }
        case 'mem_clear':
          mockMem.length = 0;
          emit('sn-mem-changed');
          resolve(undefined);
          return;
        case 'mem_recall': {
          // 与后端 mem_recall 同口径：软作废条目不进召回；空查询 = 置顶 + max(lastUsed,ts) 倒序；
          // 有查询 = 文本分(3/2/1) × 0.95^天数 × (1+log10(1+uses))
          const { query, limit } = args as { query: string; limit: number };
          const pool = mockMem.filter((m) => !(m.supersededBy ?? 0));
          const terms = (query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
          const nowMs = Date.now();
          const dayMs = 86400000;
          const ranked = pool
            .map((m) => {
              if (terms.length === 0) return { m, score: 0 };
              let s = 0;
              for (const t of terms) {
                let hit = 0;
                if (m.keywords.some((k) => k.toLowerCase().includes(t))) hit = 3;
                else if (m.title.toLowerCase().includes(t)) hit = 2;
                else if (m.text.toLowerCase().includes(t)) hit = 1;
                if (hit === 0) return { m, score: -1 };
                s += hit;
              }
              const base = m.lastUsedAt && m.lastUsedAt > 0 ? m.lastUsedAt : m.ts;
              const recency = Math.pow(0.95, (nowMs - base) / dayMs);
              return { m, score: s * recency * (1 + Math.log10(1 + (m.uses ?? 0))) };
            })
            .filter((x) => x.score >= 0)
            .sort((a, b) =>
              terms.length === 0
                ? Number(b.m.pinned) - Number(a.m.pinned) ||
                  Math.max(b.m.lastUsedAt ?? 0, b.m.ts) - Math.max(a.m.lastUsedAt ?? 0, a.m.ts) ||
                  b.m.ts - a.m.ts
                : b.score - a.score,
            );
          resolve(ranked.slice(0, limit ?? 12).map((x) => x.m));
          return;
        }
        case 'mem_used': {
          const { ts } = args as { ts: number };
          const item = mockMem.find((m) => m.ts === ts);
          if (item) {
            item.uses = (item.uses ?? 0) + 1;
            item.lastUsedAt = Date.now();
          }
          emit('sn-mem-changed');
          resolve(undefined);
          return;
        }
        case 'mem_recall_paste': {
          const { ts } = args as { ts: number };
          const item = mockMem.find((m) => m.ts === ts);
          if (item) {
            item.uses = (item.uses ?? 0) + 1;
            item.lastUsedAt = Date.now();
          }
          emit('sn-mem-changed');
          emit('sn-status', { stage: 'done', message: '已注入到光标处（mock）' });
          resolve('ok');
          return;
        }
        case 'mem_copy_used': {
          const { ts } = args as { ts: number };
          const item = mockMem.find((m) => m.ts === ts);
          if (item) {
            item.uses = (item.uses ?? 0) + 1;
            item.lastUsedAt = Date.now();
          }
          emit('sn-mem-changed');
          resolve(undefined);
          return;
        }
        case 'mem_add_note': {
          const { text } = args as { text: string };
          const t = (text ?? '').trim();
          if (!t) {
            resolve({ added: 0, merged: 0, skipped: 1 });
            return;
          }
          const dup = mockMem.find((m) => m.text === t);
          if (dup) {
            dup.hits = (dup.hits ?? 0) + 1;
            emit('sn-mem-changed');
            resolve({ added: 0, merged: 1, skipped: 0 });
            return;
          }
          mockMem.unshift({
            ts: Date.now(),
            kind: 'note',
            app: '',
            title: t.slice(0, 40),
            text: t,
            keywords: [],
            distilled: false,
            pinned: false,
            chars: [...t].length,
          });
          emit('sn-mem-changed');
          resolve({ added: 1, merged: 0, skipped: 0 });
          return;
        }
        case 'mem_import_url': {
          const { url } = args as { url: string };
          let host = '';
          try {
            host = new URL(url).hostname;
          } catch {
            resolve({ added: 0, merged: 0, skipped: 1 });
            return;
          }
          mockMem.unshift({
            ts: Date.now(),
            kind: 'web',
            app: host,
            title: `网页导入：${host}`,
            text: `（mock 模拟抓取）${url} 的正文内容示例，真机由后端抓取并抽取正文。`,
            keywords: [],
            distilled: false,
            pinned: false,
            chars: 60,
          });
          emit('sn-mem-changed');
          resolve({ added: 1, merged: 0, skipped: 0 });
          return;
        }
        case 'mem_import_files':
        case 'mem_import_folder': {
          const { paths } = args as { paths?: string[]; path?: string };
          const list = paths ?? (args.path ? [String(args.path)] : []);
          // 与真机同款逐文件进度广播（含收尾帧），进度条可在浏览器预览演练
          emit('sn-mem-import-progress', { done: 0, total: list.length, label: '' });
          for (let i = 0; i < list.length; i++) {
            const p = String(list[i]);
            const name = p.split(/[\\/]/).pop() ?? 'file';
            emit('sn-mem-import-progress', { done: i + 1, total: list.length, label: name });
            if (i < 3) {
              mockMem.unshift({
                ts: Date.now(),
                kind: 'file',
                app: '导入',
                title: name,
                text: `（mock）${name} 的文本内容示例。`,
                keywords: [],
                distilled: false,
                pinned: false,
                chars: 30,
              });
            }
          }
          emit('sn-mem-import-progress', { done: list.length, total: list.length, label: '' });
          emit('sn-mem-changed');
          resolve({ added: Math.min(list.length, 3), merged: 0, skipped: Math.max(list.length - 3, 0) });
          return;
        }
        case 'mem_storage_stats': {
          const chars = mockMem.reduce((s, m) => s + m.chars, 0);
          resolve({
            items: mockMem.length,
            pinned: mockMem.filter((m) => m.pinned).length,
            superseded: mockMem.filter((m) => (m.supersededBy ?? 0) > 0).length,
            bytes: JSON.stringify(mockMem).length,
            // mock 备份语义：曾点过「从备份恢复」后视为有备份，恢复按钮可演练
            bakBytes: mockMemBak ? JSON.stringify(mockMemBak).length : 0,
            chars,
          });
          return;
        }
        case 'mem_gen_token': {
          mockConfig.mem.apiToken = `sn-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
          resolve(mockConfig.mem.apiToken);
          return;
        }
        case 'mem_restore': {
          const { ts } = args as { ts: number };
          const item = mockMem.find((m) => m.ts === ts);
          if (item) item.supersededBy = 0;
          emit('sn-mem-changed');
          resolve(undefined);
          return;
        }
        case 'mem_purge_superseded': {
          // mock 无 bak 语义：直接过滤软作废条目
          const before = mockMem.length;
          for (let i = mockMem.length - 1; i >= 0; i--) {
            if ((mockMem[i].supersededBy ?? 0) > 0) mockMem.splice(i, 1);
          }
          emit('sn-mem-changed');
          resolve(before - mockMem.length);
          return;
        }
        case 'mem_restore_backup': {
          // mock：模拟从备份恢复——当前库存为 pre-restore，用备份快照顶替（首次数一份）
          if (!mockMemBak) {
            mockMemBak = mockMem.map((m) => ({ ...m }));
            resolve(mockMem.length);
            return;
          }
          mockMemPreRestore = mockMem.map((m) => ({ ...m }));
          mockMem.length = 0;
          mockMem.push(...mockMemBak.map((m) => ({ ...m })));
          emit('sn-mem-changed');
          resolve(mockMem.length);
          return;
        }
        case 'mem_import_backup': {
          // mock：合并导入两条示例（真机读 JSON 文件走 near-dup 合并）
          const sample: (typeof mockMem)[number] = {
            ts: Date.now(),
            kind: 'note',
            app: '',
            title: '备份合并示例条目',
            text: '从另一台设备备份合并进来的记忆示例。',
            keywords: [],
            distilled: false,
            pinned: false,
            chars: 18,
          };
          mockMem.unshift(sample);
          emit('sn-mem-changed');
          resolve({ added: 1, merged: 0, skipped: 0 });
          return;
        }
        case 'ocr_screen_source':
          // 浏览器无截屏能力：空图返回，前端放大镜据此自然禁用（真机才有）
          resolve({ png: '', width: 0, height: 0 });
          return;
        case 'mic_test':
          resolve({ avgLevel: 42, peakLevel: 87, wavBase64: null });
          return;
        case 'mic_test_all':
          resolve(
            mockDevices.map((d, i) => ({
              name: d.name,
              peak: [81, 12, 3][i] ?? 5,
              avg: [40, 6, 1][i] ?? 2,
              ok: i === 0,
            })),
          );
          return;
        case 'auto_calibrate':
          resolve({ peakPercent: 74, suggestedDb: 8.5 });
          return;
        case 'mic_diagnose':
          resolve({
            frames: 144000,
            peakPercent: 86,
            avgPercent: 38,
            channelPeaks: [86, 71],
            systemPrivacy: '已允许',
            appPrivacy: '正常',
            systemVolume: 82,
            systemMuted: false,
            systemDevice: 'DJI Mic 2 (USB)',
            findings: ['电平健康：峰值 86%', '双通道均正常'],
          });
          return;
        case 'mic_volume_info':
          resolve({ device: mockDevices[0].name, volume: 82, muted: false });
          return;
        case 'mic_hw_levels':
        case 'set_mic_hw_level':
          resolve([
            {
              name: 'Mic Boost',
              channels: 1,
              minDb: 0,
              maxDb: 30,
              stepDb: 1,
              curDb: 10,
            },
          ]);
          return;
        case 'test_asr':
          resolve('连接成功：glm-asr (mock)');
          return;
        case 'test_llm':
          resolve('连接成功：glm-5.3 (mock)');
          return;
        case 'list_models':
          resolve([
            'glm-5.3',
            'glm-5.3-flash',
            'glm-5.2',
            'glm-4.7',
            'glm-4.7-air',
            'glm-4.7-flash',
          ]);
          return;
        case 'regenerate':
          resolve(mockHistory[0]);
          return;
        case 'optimize_text':
          resolve('（mock 优化结果）');
          return;
        case 'translate_text':
        case 'translate_selection_cmd':
          resolve('（mock 译文）');
          return;
        case 'translate_input_cmd': {
          // 真机读草稿→弹既有翻译卡→替换回输入框；mock 推一轮 start→result
          // 事件供悬浮窗走查（600ms 模拟流式耗时）
          const gen = ++mockTranslateGen;
          emit('sn-translate-start', {
            gen,
            text: '输入框草稿示例文本',
            target: mockConfig.llm.translateTarget,
            second: mockConfig.llm.translateSecondTarget,
            input: true, // 契约：仅输入框翻译路径携带，悬浮窗据此显示「将替换回输入框」徽标
          });
          setTimeout(() => {
            emit('sn-translate-result', {
              gen,
              final: 'Translated draft text',
              ms: 620,
              firstMs: 180,
              autoCopied: false,
              copyFailed: false,
            });
          }, 600);
          resolve('ok');
          return;
        }
        case 'ocr_capture_cmd':
          resolve('ok');
          return;
        case 'ocr_region_selected':
          console.info('[mock-tauri] OCR 选区提交', args);
          resolve('ok');
          return;
        case 'ocr_langs':
          resolve(['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko']);
          return;
        case 'display_status':
          resolve({
            enabled: false,
            running: false,
            port: 8866,
            allowLan: false,
            urls: [
              'http://127.0.0.1:8866/display',
              'http://192.168.1.8:8866/display',
            ],
            error: null,
          });
          return;
        case 'is_elevated':
          resolve(false);
          return;
        case 'hotkey_status':
          resolve(null);
          return;
        case 'open_settings':
          console.info('[mock-tauri] 打开设置页', args);
          emit('sn-navigate', (args as { tab?: string }).tab ?? 'dash');
          resolve('ok');
          return;
        case 'export_text': {
          // 浏览器里真实落一个下载，截图导出流程可用
          const { filename, content } = args as { filename: string; content: string };
          const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = filename;
          a.click();
          resolve(filename);
          return;
        }
        case 'copy_text':
          navigator.clipboard?.writeText(String(args.text)).catch(() => {});
          resolve('ok');
          return;
        /* ---- 文本模拟输入（Typist 窗口视觉验证） ---- */
        case 'typing_start': {
          const total = [...String(args.text ?? '')].length;
          mockTyping.total = total;
          mockTyping.done = 0;
          mockTyping.active = true;
          mockTyping.target = '记事本 (mock)';
          // 1 秒内推 4 拍进度然后完成；typing_stop 可提前收尾（中止态走查）
          mockTyping.timers = [0.25, 0.5, 0.75, 1].map((f, i) =>
            setTimeout(() => {
              if (!mockTyping.active) return;
              mockTyping.done = Math.round(total * f);
              emit('sn-typing-progress', {
                done: mockTyping.done,
                total,
                target: mockTyping.target,
              });
              if (f === 1) {
                mockTyping.active = false;
                emit('sn-typing-done', {
                  reason: 'done',
                  done: total,
                  total,
                  error: null,
                });
              }
            }, 250 * (i + 1)),
          );
          resolve('started');
          return;
        }
        case 'typing_stop': {
          mockTyping.timers.forEach(clearTimeout);
          if (mockTyping.active) {
            mockTyping.active = false;
            emit('sn-typing-done', {
              reason: 'stopped',
              done: mockTyping.done,
              total: mockTyping.total,
              error: null,
            });
          }
          resolve('ok');
          return;
        }
        case 'typing_status':
          resolve({
            active: mockTyping.active,
            done: mockTyping.done,
            total: mockTyping.total,
            target: mockTyping.target,
          });
          return;
        case 'typing_set_speed':
          console.info('[mock-tauri] 实时调速', args);
          resolve('ok');
          return;
        case 'typing_clipboard_text':
          resolve('剪贴板示例文本：禁用粘贴的输入框里也能逐字敲进去。');
          return;
        case 'typing_start_clipboard':
          console.info('[mock-tauri] 剪贴板直输（mock 模拟一轮进度）');
          mockTyping.timers.forEach(clearTimeout);
          mockTyping.total = 14;
          mockTyping.done = 0;
          mockTyping.active = true;
          mockTyping.target = '记事本 (mock)';
          mockTyping.timers = [0.25, 0.5, 0.75, 1].map((f, i) =>
            setTimeout(() => {
              if (!mockTyping.active) return;
              mockTyping.done = Math.round(14 * f);
              emit('sn-typing-progress', {
                done: mockTyping.done,
                total: 14,
                target: mockTyping.target,
              });
              if (f === 1) {
                mockTyping.active = false;
                emit('sn-typing-done', {
                  reason: 'done',
                  done: 14,
                  total: 14,
                  error: null,
                });
              }
            }, 250 * (i + 1)),
          );
          resolve('started');
          return;
        case 'typist_read_draft':
          // 空 = 无草稿（视觉验证默认态；需要草稿态可临时改这里）
          resolve(null);
          return;
        case 'typist_save_draft':
          resolve('ok');
          return;
        case 'typist_set_top':
          console.info('[mock-tauri] typist 置顶', args);
          resolve('ok');
          return;
        case 'open_typist':
          console.info('[mock-tauri] 打开 typist 窗口', args);
          resolve('ok');
          return;
        /* ---- 更新 / 文件对话框（关于页更新面板与配置备份） ---- */
        case 'check_update':
          // 默认返回「有新版本」便于走查更新面板；__mock.config 可改
          resolve({
            current: '0.4.8-dev-mock',
            latest: '0.5.0',
            tag: 'v0.5.0',
            updateAvailable: true,
            notes:
              '## Changes\n\n- GitHub 自动更新：一键下载并重启覆盖安装\n- 配置备份：另存为导出与从文件导入\n- AI 优化页配置区重构\n\n---\nFull changelog: …',
            downloadUrl:
              'https://github.com/YFsama/SpeakNow/releases/download/v0.5.0/SpeakNow_0.5.0_x64-setup.exe',
            assetSize: 15 * 1024 * 1024,
            publishedAt: '2026-10-17T08:00:00Z',
            htmlUrl: 'https://github.com/YFsama/SpeakNow/releases/tag/v0.5.0',
          });
          return;
        case 'download_update': {
          const total = 15 * 1024 * 1024;
          [0.25, 0.6, 0.9, 1].forEach((f, i) => {
            setTimeout(
              () =>
                emit('sn-update-progress', {
                  downloaded: Math.round(total * f),
                  total,
                }),
              300 * (i + 1),
            );
          });
          setTimeout(
            () =>
              resolve(
                'C:/Users/demo/AppData/Local/Temp/speaknow-update/SpeakNow_0.5.0_x64-setup.exe',
              ),
            1500,
          );
          return;
        }
        case 'install_update':
          console.info('[mock-tauri] 模拟拉起安装器并退出应用', args);
          resolve('ok');
          return;
        case 'open_release_page':
          console.info('[mock-tauri] 打开发布页', args);
          resolve('ok');
          return;
        case 'read_text_file':
          // 读入当前 mock 配置：导入流程可完整走通
          resolve(JSON.stringify(mockConfig, null, 2));
          return;
        case 'export_text_to':
          console.info('[mock-tauri] 另存为导出', args.path);
          resolve(args.path);
          return;
        case 'plugin:dialog|save':
          resolve('C:/Users/demo/Documents/speaknow-config-backup.json');
          return;
        case 'plugin:dialog|open':
          resolve('C:/Users/demo/Documents/speaknow-config-backup.json');
          return;
        default:
          console.warn(`[mock-tauri] 未实现的命令：${cmd}`, args);
          resolve(null);
      }
      clearTimeout(t);
    }, 30 + Math.random() * 60); // 轻微延迟模拟 IPC
  });
}

function transformCallback(cb: Cb): number {
  const id = cbSeq++;
  listeners.set(id, { event: '', cb });
  return id;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __mock?: {
      emit: (event: string, payload?: unknown) => void;
      stage: (stage: string, message?: string) => void;
      toast: (msg: string) => void;
      tab: (tab: string) => void;
      config: typeof mockConfig;
      setHistory: (items: unknown[]) => void;
      setMem: (items: unknown[]) => void;
    };
  }
}

window.__TAURI_INTERNALS__ = { invoke, transformCallback, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } };

function emit(event: string, payload?: unknown) {
  for (const id of eventHandlers.get(event) ?? []) {
    listeners.get(id)?.cb({ event, id, payload });
  }
}

window.__mock = {
  emit,
  stage: (stage, message = '') => emit('sn-status', { stage, message }),
  toast: (msg) => emit('sn-toast', { message: msg }),
  tab: (tab) => emit('sn-navigate', tab),
  config: mockConfig,
  /** 替换 mock 历史并广播刷新（视觉验证用，如测试上手清单需要 <3 条） */
  setHistory: (items: unknown[]) => {
    mockHistory.length = 0;
    mockHistory.push(...(items as (typeof mockHistory)[number][]));
    emit('sn-history-changed');
  },
  /** 替换 mock 记忆并广播刷新（记忆页视觉验证用） */
  setMem: (items: unknown[]) => {
    mockMem.length = 0;
    mockMem.push(...(items as (typeof mockMem)[number][]));
    emit('sn-mem-changed');
  },
};

console.info(
  '[mock-tauri] 浏览器 mock 已启用。可用：__mock.stage() / __mock.emit() / __mock.tab() / __mock.config',
);
