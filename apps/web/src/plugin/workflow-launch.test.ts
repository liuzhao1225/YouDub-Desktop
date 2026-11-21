import { expect, it } from 'vitest'
import { nodeDescriptors } from '@/lib/node-descriptors'
import { videoSource } from '@/lib/video-source'
import type { NodeTypeDefinition, WorkflowDocument } from './contracts'
import { compatibleInputFiles, videoLinkInput, withVideoLink } from './builtin/workflow-launch'
import { canConnect } from './builtin/workflow-utils'

const document: WorkflowDocument = {
  format: 'youdub.workflow',
  formatVersion: 1,
  id: 'youdub.subtitles',
  title: '字幕翻译',
  inputs: [{ id: 'video', label: '视频', kind: 'artifact', schemaId: 'file/v1', required: true, acceptedMimeTypes: ['video/*'] }],
  outputs: [],
  nodes: [
    { id: 'prepare', type: 'youdub.prepare', typeVersion: '1', provider: { id: 'youdub.media' }, config: {}, autoContinue: true },
    { id: 'recognize', type: 'youdub.recognize', typeVersion: '1', provider: { id: 'whisper' }, config: {}, autoContinue: false },
    { id: 'translate', type: 'youdub.translate', typeVersion: '1', provider: { id: 'llm' }, config: {}, autoContinue: false },
    { id: 'export', type: 'youdub.export', typeVersion: '1', provider: { id: 'youdub.media' }, config: {}, autoContinue: true },
  ],
  edges: [
    { id: 'e1', source: { nodeId: '$inputs', portId: 'video' }, target: { nodeId: 'prepare', portId: 'media' } },
    { id: 'e2', source: { nodeId: '$inputs', portId: 'video' }, target: { nodeId: 'export', portId: 'video' } },
    { id: 'e3', source: { nodeId: 'prepare', portId: 'audio' }, target: { nodeId: 'recognize', portId: 'audio' } },
    { id: 'e4', source: { nodeId: 'recognize', portId: 'transcript' }, target: { nodeId: 'translate', portId: 'transcript' } },
    { id: 'e5', source: { nodeId: 'translate', portId: 'translation' }, target: { nodeId: 'export', portId: 'translation' } },
  ],
  presentation: { positions: {}, viewport: { x: 0, y: 0, zoom: 1 } },
}

const types: NodeTypeDefinition[] = [
  {
    type: 'youdub.download',
    version: '1',
    label: '下载视频',
    category: 'media',
    providerId: 'youdub.download',
    provider: { id: 'youdub.download', operations: [] },
    operation: 'download',
    inputs: [],
    outputs: [{ name: 'video', kind: 'artifact', schemaId: 'video/mp4/v1', required: true }],
    configSchema: { type: 'object', properties: { proxyPort: { type: 'integer', minimum: 0, maximum: 65535, default: 0 } } },
    defaults: { proxyPort: 0 },
  },
  {
    type: 'youdub.prepare',
    version: '1',
    label: '提取音频',
    category: 'media',
    providerId: 'youdub.media',
    provider: { id: 'youdub.media', operations: [] },
    operation: 'prepare',
    inputs: [{ id: 'media', label: '视频', kind: 'artifact', acceptedSchemaIds: ['file/v1', 'video/mp4/v1'], required: true }],
    outputs: [{ name: 'audio', kind: 'artifact', schemaId: 'audio/wav/v1', required: true }],
    configSchema: { type: 'object', properties: {} },
    defaults: {},
  },
  {
    ...nodeDescriptors.recognize,
    version: '1',
    providerId: 'youdub.media',
    provider: { id: 'youdub.media', operations: [] },
    operation: 'recognize',
    inputs: [{ id: 'audio', label: '音频', kind: 'artifact', acceptedSchemaIds: ['audio/wav/v1'], required: true }],
    outputs: [{ name: 'transcript', kind: 'json', schemaId: 'transcript/v1', required: true }],
  },
  {
    ...nodeDescriptors.translate,
    version: '1',
    providerId: 'youdub.media',
    provider: { id: 'youdub.media', operations: [] },
    operation: 'translate',
    inputs: [{ id: 'transcript', label: '原文', kind: 'json', acceptedSchemaIds: ['transcript/v1'], required: true }],
    outputs: [{ name: 'translation', kind: 'json', schemaId: 'translation/v1', required: true }],
  },
  {
    ...nodeDescriptors.export,
    version: '1',
    providerId: 'youdub.media',
    provider: { id: 'youdub.media', operations: [] },
    operation: 'export',
    inputs: [
      { id: 'video', label: '视频', kind: 'artifact', acceptedSchemaIds: ['file/v1', 'video/mp4/v1'], required: false },
      { id: 'translation', label: '译文', kind: 'json', acceptedSchemaIds: ['translation/v1'], required: true },
    ],
    outputs: [],
  },
] as NodeTypeDefinition[]

it('imports links into the real reviewed-subtitles template without changing the template or its review gates', () => {
  const original = structuredClone(document)
  expect(document.inputs[0].schemaId).toBe('file/v1')
  expect(videoLinkInput(document, types)?.id).toBe('video')
  const result = withVideoLink(document, types, 'video', 'https://www.youtube.com/watch?v=12345678901', 0)
  expect(document).toEqual(original)
  expect(result.document.inputs).toEqual([])
  const added = result.document.nodes.find((node) => node.type === 'youdub.download')!
  expect(added.config.proxyPort).toBe(0)
  expect(result.runtime[added.id]).toEqual({ url: 'https://www.youtube.com/watch?v=12345678901' })
  expect(JSON.stringify(result.document)).not.toContain('youtube.com')
  expect(result.document.nodes.slice(1)).toEqual(document.nodes)
  expect(result.document.nodes.filter((node) => !node.autoContinue).map((node) => node.id)).toEqual(['recognize', 'translate'])
  const edges = result.document.edges.filter((edge) => edge.source.nodeId === added.id)
  expect(edges).toHaveLength(document.edges.filter((edge) => edge.source.nodeId === '$inputs').length)
  for (const edge of edges) expect(canConnect(result.document, types, edge.source, edge.target)).toBe(true)
})

it('keeps the selected proxy port on the download node and keeps the URL in per-run inputs', () => {
  const result = withVideoLink(document, types, 'video', 'https://www.youtube.com/watch?v=jNQXAC9IVRw', 7897)
  const added = result.document.nodes[0]
  expect(added.config.proxyPort).toBe(7897)
  expect(result.runtime[added.id]).toEqual({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' })
  const prepare = result.document.edges.find((edge) => edge.target.nodeId === 'prepare')!
  expect(prepare.source).toEqual({ nodeId: added.id, portId: 'video' })
  expect(canConnect(result.document, types, prepare.source, prepare.target)).toBe(true)
})

it('does not offer links when a consumer cannot accept downloaded video', () => {
  const incompatible = types.map((type) => type.type === 'youdub.prepare' ? { ...type, inputs: type.inputs.map((input) => ({ ...input, acceptedSchemaIds: ['file/v1'] })) } : type)
  expect(videoLinkInput(document, incompatible)).toBeUndefined()
  expect(() => withVideoLink(document, incompatible, 'video', 'https://youtu.be/12345678901', 0)).toThrow()
})

it('preserves each compatible file once and reserves exact input matches before renamed ones', () => {
  const first = document.inputs[0], second = { ...first, id: 'second' }
  const a = new File(['a'], 'a.mp4', { type: 'video/mp4' }), b = new File(['b'], 'b.mp4', { type: 'video/mp4' })
  expect(compatibleInputFiles([{ input: first, file: a }, { input: second, file: b }], [{ ...first, id: 'renamed' }, first])).toEqual({ video: a, renamed: b })
  expect(compatibleInputFiles([{ input: first, file: a }], [{ ...first, schemaId: 'text/v1' }])).toEqual({})
})

it('extracts and normalizes Bilibili and YouTube links from share copy text', () => {
  expect(
    videoSource('【双语科普】令人惊叹的AI声学模型 https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333&p=2'),
  ).toEqual({
    platform: 'Bilibili',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2',
  })
  expect(
    videoSource('Check out https://youtu.be/jNQXAC9IVRw?si=abc!'),
  ).toEqual({
    platform: 'YouTube',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  })
  expect(() => videoSource('not a valid url')).toThrow()
})
