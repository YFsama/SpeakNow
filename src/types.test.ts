import { describe, expect, it } from 'vitest';
import type { Config } from './types';
import { langName, resolvedAsrCreds, resolvedLlmCreds } from './types';

/** 最小可用的 Config 骨架：凭据组解析只触及 providers / asr / llm 三处 */
function baseConfig(patch: {
  providerId?: string;
  asrKey?: string;
  llmKey?: string;
  providers?: Config['providers'];
}): Config {
  return {
    providers: patch.providers ?? [],
    hotkey: {
      key: '',
      keyQuick: '',
      keyTranslate: '',
      keyTranslateSel: '',
      keyOcr: '',
      mode: 'toggle',
      enabled: true,
      minDurationMs: 800,
    },
    audio: {
      device: null,
      vadEnabled: false,
      vadSilenceMs: 1800,
      vadThreshold: 0.012,
      maxDurationSec: 120,
      gainDb: 0,
      gainDbByDevice: {},
      autoGain: true,
    },
    asr: {
      provider: 'http',
      providerId: patch.providerId ?? '',
      baseUrl: 'https://asr-inline.example/v1',
      apiKey: patch.asrKey ?? '',
      model: 'whisper',
      endpointPath: '/audio/transcriptions',
      language: 'auto',
      hotwords: '',
      mirror: 'https://hf-mirror.com',
      localModel: 'base',
    },
    llm: {
      enabled: true,
      providerId: patch.providerId ?? '',
      baseUrl: 'https://llm-inline.example/v4',
      apiKey: patch.llmKey ?? '',
      model: 'glm-4.6',
      mode: 'correct',
      glossary: '',
      customPrompt: '',
      timeoutSec: 45,
      translateTarget: 'en',
      translateSecondTarget: 'zh',
      translateOutput: 'translation',
      promptTemplates: [],
    },
    translate: {
      autoCopy: false,
      forcedCopy: false,
      replaceMarker: true,
      blacklist: '',
      clipboardWatch: false,
      ccc: false,
      cccWindowMs: 350,
      structuredTranslate: true,
      engine: 'cloud',
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
      autoSubmitBlocklist: [],
    },
    general: {
      showOverlay: true,
      closeToTray: true,
      soundFeedback: true,
      autostart: false,
      theme: 'dark',
      fontScale: 1,
      historyLimit: 50,
      localIdleMin: 0,
      lingerMult: 1,
    },
    externalDisplay: {
      enabled: false,
      hideLocalOverlay: false,
      allowLan: false,
      port: 8866,
    },
  } as unknown as Config;
}

describe('resolvedAsrCreds / resolvedLlmCreds（凭据组契约镜像）', () => {
  it('未命中 providerId 时回退内联凭据', () => {
    const cfg = baseConfig({ asrKey: 'inline-asr', llmKey: 'inline-llm' });
    expect(resolvedAsrCreds(cfg)).toEqual({
      baseUrl: 'https://asr-inline.example/v1',
      apiKey: 'inline-asr',
    });
    expect(resolvedLlmCreds(cfg)).toEqual({
      baseUrl: 'https://llm-inline.example/v4',
      apiKey: 'inline-llm',
    });
  });

  it('命中凭据组时整组覆盖（base_url 与 key 一起换）', () => {
    const cfg = baseConfig({
      providerId: 'p1',
      asrKey: 'stale-inline',
      llmKey: 'stale-inline',
      providers: [
        {
          id: 'p1',
          name: '智谱',
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          apiKey: 'group-key',
        },
      ],
    });
    expect(resolvedAsrCreds(cfg).apiKey).toBe('group-key');
    expect(resolvedAsrCreds(cfg).baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(resolvedLlmCreds(cfg).apiKey).toBe('group-key');
  });
});

describe('langName', () => {
  it('已知代码给名称，未知原样返回', () => {
    expect(langName('en')).toBe('English');
    expect(langName('zh')).toBe('中文');
    expect(langName('xx')).toBe('xx');
  });
});
