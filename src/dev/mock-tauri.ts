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
    mode: 'toggle',
    enabled: true,
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
  output: {
    method: 'clipboard',
    pasteKey: 'auto',
    autoPaste: true,
    autoSubmit: false,
    restoreClipboard: true,
    review: false,
  },
  general: {
    showOverlay: true,
    closeToTray: true,
    soundFeedback: true,
    autostart: true,
    theme: 'dark',
    fontScale: 1,
    historyLimit: 50,
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
        case 'update_history_final': {
          const { ts, finalText } = args as { ts: number; finalText: string };
          const item = mockHistory.find((h) => h.ts === ts);
          if (item) item.final = finalText;
          resolve(undefined);
          return;
        }
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
          resolve('连接成功：glm-4.7 (mock)');
          return;
        case 'list_models':
          resolve(['glm-4.7', 'glm-4.7-air', 'glm-4.7-flash', 'glm-4.6', 'glm-4.5-air']);
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
        case 'ocr_capture_cmd':
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
  tab: (tab) => emit('sn-navigate', { tab }),
  config: mockConfig,
};

console.info(
  '[mock-tauri] 浏览器 mock 已启用。可用：__mock.stage() / __mock.emit() / __mock.tab() / __mock.config',
);
