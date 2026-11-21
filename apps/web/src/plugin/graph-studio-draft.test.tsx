import { TestFeatureProvider, type TestContext } from './test-bindings'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '@/test/language-provider'
import { type NodeTypeDefinition, type WorkflowDocument } from './sdk'
import { Studio } from './builtin/studio'
import { applyQuickNodeOverride } from './builtin/workflows'
import { resourceKey } from './runtime/workflow-resources'
import { builtinSlots } from '@/App'
import { bindTestComponent } from './test-bindings'

const Page = bindTestComponent(Studio, ['draftStore', 'request', 'navigate', 'useQuery', 'useSlot', 'useWorkflowDocuments', 'useWorkflowResources'])

const definitions: NodeTypeDefinition[] = [
  {
    type: 'test.process',
    version: '1',
    providerId: 'test',
    operation: 'process',
    label: '处理',
    category: 'media',
    provider: { id: 'test', operations: [] },
    inputs: [],
    outputs: [],
    configSchema: {},
    defaults: {},
    runtimeInputSchema: { type: 'object', properties: { note: { type: 'string', 'x-title': '运行备注' } } },
  },
  {
    type: 'test.text',
    version: '1',
    providerId: 'test',
    operation: 'text',
    label: '文本处理',
    category: 'text',
    provider: { id: 'test', operations: [] },
    inputs: [],
    outputs: [],
    configSchema: {},
    defaults: {},
  },
  {
    type: 'youdub.download',
    version: '1',
    providerId: 'media',
    operation: 'download',
    label: '下载',
    category: 'input',
    provider: { id: 'media', operations: [] },
    inputs: [],
    outputs: [{ name: 'video', kind: 'artifact', schemaId: 'video/mp4/v1', required: true }],
    configSchema: {},
    defaults: {},
  },
]

function textGraph(id: string, title: string): WorkflowDocument {
  return {
    format: 'youdub.workflow',
    formatVersion: 1,
    id,
    title,
    inputs: [{ id: 'document', label: '文档', kind: 'artifact', schemaId: 'text/plain/v1', required: true, acceptedMimeTypes: ['text/plain'], maxBytes: 100 }],
    nodes: [{ id: 'text-node', type: 'test.text', typeVersion: '1', provider: { id: 'test' }, config: {}, autoContinue: true }],
    edges: [],
    outputs: [],
    presentation: { positions: {}, viewport: { x: 0, y: 0, zoom: 1 } },
  }
}

function videoGraph(id: string, title: string): WorkflowDocument {
  return {
    format: 'youdub.workflow',
    formatVersion: 1,
    id,
    title,
    inputs: [{ id: 'video', label: '视频', kind: 'artifact', schemaId: 'video/mp4/v1', required: true, acceptedMimeTypes: ['video/*'], maxBytes: 100 }],
    nodes: [{ id: 'process', type: 'test.process', typeVersion: '1', provider: { id: 'test' }, config: {}, autoContinue: true }],
    edges: [],
    outputs: [],
    presentation: { positions: {}, viewport: { x: 0, y: 0, zoom: 1 } },
  }
}

afterEach(() => { cleanup(); window.localStorage.clear() })

function mount() {
  const documents = [textGraph('first', '第一个工作流'), videoGraph('second', '第二个工作流')]
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/workflow-documents?')) return { items: documents.map((document) => ({ id: document.id, revision: 1, origin: 'builtin', document })) }
    if (path === '/api/node-types') return { items: definitions }
    if (path.endsWith('/resources/check')) return { status: 'ready', requirements: [] }
    if (path.endsWith('/validate')) return { valid: true, diagnostics: [] }
    if (path.startsWith('/api/tasks?')) return { items: [] }
    if (path === '/api/tasks' && init?.method === 'POST') throw new Error('Connection interrupted')
    if (path.startsWith('/api/imports/') && init?.method === 'DELETE') return undefined
    throw new Error(`Unexpected request ${path}`)
  })
  const context = {
    apiClient: { request },
    navigation: { push: vi.fn() },
    slots: { subscribe: () => () => {}, getSnapshot: () => 0, list: () => [] },
    effect: (effect: () => unknown) => effect(),
  } as unknown as TestContext
  const page = <TestFeatureProvider context={context}><LanguageProvider><Page /></LanguageProvider></TestFeatureProvider>
  const view = render(page)
  return { request, user: userEvent.setup(), revisit: () => { view.rerender(<div>设置</div>); view.rerender(page) } }
}

async function selectWorkflow(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByRole('button', { name: '工作流' }))
  await user.click(await screen.findByRole('menuitem', { name: title }))
}

it('preserves the selected graph, file and node runtime draft across another workflow', async () => {
  const { request, user } = mount()
  await screen.findByLabelText('文档 *')
  await selectWorkflow(user, '第二个工作流')
  await user.upload(screen.getByLabelText('视频 *'), new File(['video'], 'keep.mp4', { type: 'video/mp4' }))
  await user.type(screen.getByLabelText('运行备注'), '保留第二个工作流的备注')
  await selectWorkflow(user, '第一个工作流')
  expect(screen.queryByText('keep.mp4')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('运行备注')).not.toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: '开始处理' })).toHaveLength(1)
  expect(screen.getByRole('button', { name: '开始处理' })).toBeDisabled()
  const textInput = screen.getByLabelText('文档 *') as HTMLInputElement
  expect(textInput).toHaveAttribute('accept', 'text/plain')
  expect((screen.getByText('文档 *') as HTMLLabelElement).control).toBe(textInput)
  expect(screen.queryByLabelText('视频 *')).not.toBeInTheDocument()
  await selectWorkflow(user, '第二个工作流')
  expect(screen.getByText('keep.mp4')).toBeVisible()
  expect(screen.getByLabelText('运行备注')).toHaveValue('保留第二个工作流的备注')
  expect(screen.queryByRole('link', { name: '编辑工作流' })).not.toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: '开始处理' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '开始处理' }))
  await screen.findByText('Connection interrupted')
  const calls = request.mock.calls.filter(([path]) => path === '/api/tasks')
  expect(calls).toHaveLength(1)
  const body = calls[0][1]!.body as FormData
  expect((body.get('input.video') as File).name).toBe('keep.mp4')
  expect(JSON.parse(String(body.get('request')))).toMatchObject({ graphDocument: { id: 'second' }, nodeRuntimeInputs: { process: { note: '保留第二个工作流的备注' } } })
  expect(screen.getByRole('button', { name: '工作流' })).toBeDisabled()
})

it('stops inactive graph resource checks, preserves its URL and keeps submission locked until cleared', async () => {
  const { request, user } = mount()
  await screen.findByLabelText('文档 *')
  await selectWorkflow(user, '第二个工作流')
  fireEvent.change(screen.getByLabelText('视频链接'), { target: { value: 'https://youtu.be/abcdefghijk' } })
  await waitFor(() => expect(screen.getByRole('button', { name: '下载并处理' })).toBeEnabled())
  const checks = () => request.mock.calls.filter(([path]) => path.endsWith('/resources/check'))
  const signal = checks().at(-1)![1]!.signal!
  expect(signal.aborted).toBe(false)
  await selectWorkflow(user, '第一个工作流')
  await waitFor(() => expect(signal.aborted).toBe(true))
  const countWhileHidden = checks().length
  await user.upload(screen.getByLabelText('文档 *'), new File(['text'], 'document.txt', { type: 'text/plain' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '开始处理' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '开始处理' }))
  await screen.findByText('Connection interrupted')
  expect(screen.getByRole('button', { name: '工作流' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '查询创建结果' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '下载并处理' })).not.toBeInTheDocument()
  expect(checks()).toHaveLength(countWhileHidden)
  let submissions = request.mock.calls.filter(([path]) => path === '/api/tasks')
  expect(submissions).toHaveLength(1)
  expect(JSON.parse(String((submissions[0][1]!.body as FormData).get('request'))).graphDocument.id).toBe('first')
  await user.click(screen.getByRole('button', { name: '放弃本次提交并修改' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '工作流' })).toBeEnabled())
  await selectWorkflow(user, '第二个工作流')
  expect(screen.getByLabelText('视频链接')).toHaveValue('https://youtu.be/abcdefghijk')
  await waitFor(() => expect(screen.getByRole('button', { name: '下载并处理' })).toBeEnabled())
  // Returning to unchanged requirements reuses their completed readiness check.
  expect(checks()).toHaveLength(countWhileHidden)
  expect(JSON.parse(String(checks().at(-1)![1]!.body)).document.id).toBe('second')
  await user.click(screen.getByRole('button', { name: '下载并处理' }))
  await screen.findByText('Connection interrupted')
  submissions = request.mock.calls.filter(([path]) => path === '/api/tasks')
  expect(submissions).toHaveLength(2)
  const body = submissions[1][1]!.body as FormData
  expect(body.has('input.video')).toBe(false)
  expect(JSON.parse(String(body.get('request')))).toMatchObject({ workflowId: 'youdub.graph', graphDocument: { id: 'second' }, nodeRuntimeInputs: { 'source-download': { url: 'https://www.youtube.com/watch?v=abcdefghijk' } } })
})

it('retains the workflow, File and node options after visiting settings', async () => {
  const { request, user, revisit } = mount()
  await screen.findByLabelText('文档 *')
  await selectWorkflow(user, '第二个工作流')
  const file = new File(['video'], 'settings-return.mp4', { type: 'video/mp4' })
  await user.upload(screen.getByLabelText('视频 *'), file)
  await user.type(screen.getByLabelText('运行备注'), '设置返回保留')
  revisit()
  expect(await screen.findByText('settings-return.mp4')).toBeVisible()
  expect(screen.getByRole('button', { name: '工作流' })).toHaveTextContent('第二个工作流')
  expect(screen.getByLabelText('运行备注')).toHaveValue('设置返回保留')
  await waitFor(() => expect(screen.getByRole('button', { name: '开始处理' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '开始处理' }))
  await screen.findByText('Connection interrupted')
  const body = request.mock.calls.find(([path]) => path === '/api/tasks')![1]!.body as FormData
  expect(body.get('input.video')).toBe(file)
})

it('propagates quick sourceLanguage and targetLanguage overrides across all matching pipeline nodes and registers review slots', () => {
  const detailIds = builtinSlots.list('workflow.node.details').map((entry) => entry.id)
  expect(detailIds).toEqual(expect.arrayContaining(['youdub.transcript', 'youdub.translation']))

  const langTypes: NodeTypeDefinition[] = [
    {
      type: 'youdub.transcribe',
      version: '1.0.0',
      providerId: 'whisper',
      operation: 'speech.transcribe/v1',
      label: '语音识别',
      category: 'asr',
      provider: { id: 'whisper', operations: [] },
      inputs: [],
      outputs: [],
      configSchema: {
        type: 'object',
        properties: {
          sourceLanguage: {
            type: 'string',
            'x-options': [{ value: 'auto', label: '自动' }, { value: 'en', label: 'English' }, { value: 'ja', label: '日本語' }],
          },
        },
      },
      defaults: { sourceLanguage: 'auto' },
    },
    {
      type: 'youdub.translate',
      version: '1.0.0',
      providerId: 'openai',
      operation: 'text.translate/v1',
      label: '字幕翻译',
      category: 'translation',
      provider: { id: 'openai', operations: [] },
      inputs: [],
      outputs: [],
      configSchema: {
        type: 'object',
        properties: {
          sourceLanguage: {
            type: 'string',
            'x-options': [{ value: 'auto', label: '自动' }, { value: 'en', label: 'English' }, { value: 'ja', label: '日本語' }],
          },
          targetLanguage: {
            type: 'string',
            'x-options': [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }, { value: 'ja', label: '日本語' }],
          },
        },
      },
      defaults: { sourceLanguage: 'auto', targetLanguage: 'zh' },
    },
    {
      type: 'youdub.synthesize',
      version: '1.0.0',
      providerId: 'voxcpm',
      operation: 'speech.synthesize/v1',
      label: '语音合成',
      category: 'tts',
      provider: { id: 'voxcpm', operations: [] },
      inputs: [],
      outputs: [],
      configSchema: {
        type: 'object',
        properties: {
          targetLanguage: {
            type: 'string',
            'x-options': [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }, { value: 'ja', label: '日本語' }],
          },
        },
      },
      defaults: { targetLanguage: 'zh' },
    },
    {
      type: 'youdub.align',
      version: '1.0.0',
      providerId: 'qwen_forced_aligner',
      operation: 'subtitles.align/v1',
      label: '字幕对齐',
      category: 'subtitles',
      provider: { id: 'qwen_forced_aligner', operations: [] },
      inputs: [],
      outputs: [],
      configSchema: {
        type: 'object',
        properties: {
          targetLanguage: {
            type: 'string',
            'x-options': [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }, { value: 'ja', label: '日本語' }],
          },
        },
      },
      defaults: { targetLanguage: 'zh' },
    },
    {
      type: 'youdub.export',
      version: '1.0.0',
      providerId: 'youdub.media',
      operation: 'media.export/v1',
      label: '合成导出',
      category: 'export',
      provider: { id: 'youdub.media', operations: [] },
      inputs: [],
      outputs: [],
      configSchema: {
        type: 'object',
        properties: {
          sourceLanguage: {
            type: 'string',
            'x-options': [{ value: 'auto', label: '自动' }, { value: 'en', label: 'English' }, { value: 'ja', label: '日本語' }],
          },
          targetLanguage: {
            type: 'string',
            'x-options': [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }, { value: 'ja', label: '日本語' }],
          },
        },
      },
      defaults: { sourceLanguage: 'auto', targetLanguage: 'zh' },
    },
  ]

  const doc: WorkflowDocument = {
    format: 'youdub.workflow',
    formatVersion: 1,
    id: 'youdub.subtitles-dubbing',
    title: '字幕＋配音',
    inputs: [],
    nodes: [
      { id: 'recognize', type: 'youdub.transcribe', typeVersion: '1.0.0', provider: { id: 'whisper' }, config: { sourceLanguage: 'auto' }, autoContinue: false },
      { id: 'translate', type: 'youdub.translate', typeVersion: '1.0.0', provider: { id: 'openai' }, config: { sourceLanguage: 'auto', targetLanguage: 'zh' }, autoContinue: false },
      { id: 'synthesize', type: 'youdub.synthesize', typeVersion: '1.0.0', provider: { id: 'voxcpm' }, config: { targetLanguage: 'zh' }, autoContinue: true },
      { id: 'align', type: 'youdub.align', typeVersion: '1.0.0', provider: { id: 'qwen_forced_aligner' }, config: { targetLanguage: 'zh' }, autoContinue: true },
      { id: 'export', type: 'youdub.export', typeVersion: '1.0.0', provider: { id: 'youdub.media' }, config: { sourceLanguage: 'auto', targetLanguage: 'zh' }, autoContinue: true },
    ],
    edges: [],
    outputs: [],
    presentation: { positions: {}, viewport: { x: 0, y: 0, zoom: 1 } },
  }

  const afterTarget = applyQuickNodeOverride(doc, doc, langTypes, undefined, 'translate', { sourceLanguage: 'auto', targetLanguage: 'ja' })
  expect(afterTarget.translate.targetLanguage).toBe('ja')
  expect(afterTarget.synthesize.targetLanguage).toBe('ja')
  expect(afterTarget.align.targetLanguage).toBe('ja')
  expect(afterTarget.export.targetLanguage).toBe('ja')

  const jaDoc: WorkflowDocument = {
    ...doc,
    nodes: doc.nodes.map((node) => (afterTarget[node.id] ? { ...node, config: { ...node.config, ...afterTarget[node.id] } } : node)),
  }
  expect(resourceKey(jaDoc)).not.toBe(resourceKey(doc))

  const afterSource = applyQuickNodeOverride(doc, doc, langTypes, afterTarget, 'recognize', { sourceLanguage: 'en' })
  expect(afterSource.recognize.sourceLanguage).toBe('en')
  expect(afterSource.translate.sourceLanguage).toBe('en')
  expect(afterSource.translate.targetLanguage).toBe('ja')
  expect(afterSource.export.sourceLanguage).toBe('en')
  expect(afterSource.export.targetLanguage).toBe('ja')
})
