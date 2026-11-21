import type { JsonSchema } from '@/plugin/contracts'

const LANGUAGE_AUTO = { default: 'Auto-detect', translations: { zh: '自动识别', ja: '自動検出' } }

export const nodeDescriptors = {
  recognize: {
    type: 'youdub.transcribe',
    configSchema: {
      type: 'object',
      properties: {
        sourceLanguage: {
          type: 'string',
          default: 'auto',
          'x-title': { default: 'Source language', translations: { zh: '原文语言', ja: '元の言語' } },
          'x-short-title': { default: 'Source language', translations: { zh: '原文语言', ja: '元の言語' } },
          'x-optionsFrom': 'source_languages',
          'x-options': [
            { value: 'auto', label: LANGUAGE_AUTO },
            { value: 'en', label: 'English' },
            { value: 'zh', label: '中文' },
            { value: 'ja', label: '日本語' },
          ],
        },
        initialPrompt: { type: 'string', default: '' },
      },
    } satisfies JsonSchema,
    ui: { quickFields: ['sourceLanguage'] },
  },
  translate: {
    type: 'youdub.translate',
    configSchema: {
      type: 'object',
      properties: {
        sourceLanguage: { type: 'string', default: 'auto' },
        targetLanguage: {
          type: 'string',
          default: 'zh',
          'x-title': { default: 'Target language', translations: { zh: '译文语言', ja: '翻訳先' } },
          'x-short-title': { default: 'Target language', translations: { zh: '译文语言', ja: '翻訳先' } },
          'x-optionsFrom': 'target_languages',
          'x-options': [
            { value: 'zh', label: '中文' },
            { value: 'en', label: 'English' },
            { value: 'ja', label: '日本語' },
          ],
        },
        maxCompletionTokens: { type: 'integer', minimum: 64, maximum: 32768 },
      },
    } satisfies JsonSchema,
    ui: { quickFields: ['targetLanguage'] },
  },
  synthesize: {
    type: 'youdub.synthesize',
    configSchema: {
      type: 'object',
      properties: {
        targetLanguage: { type: 'string', default: 'zh' },
        voice: { type: 'object', default: { mode: 'source_clone' } },
      },
    } satisfies JsonSchema,
    ui: { quickFields: [] as string[], editorId: 'youdub.synthesize' },
  },
  export: {
    type: 'youdub.export',
    configSchema: {
      type: 'object',
      properties: {
        renderSubtitles: {
          type: 'boolean',
          default: true,
          'x-title': { default: 'Burn subtitles', translations: { zh: '烧录字幕', ja: '字幕を焼き込む' } },
        },
      },
    } satisfies JsonSchema,
    ui: { quickFields: ['renderSubtitles'] },
  },
}
