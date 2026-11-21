import { TestFeatureProvider, testHost, type TestContext } from './test-bindings'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '@/test/language-provider'
import { type NodeTypeDefinition, type TaskView, type WorkflowDocument } from './sdk'
import { Studio } from './builtin/studio'
import { bindTestComponent } from './test-bindings'

const Page = bindTestComponent(Studio, ['draftStore', 'request', 'navigate', 'useQuery', 'useSlot', 'useWorkflowDocuments', 'useWorkflowResources'])

const baseDefinitions: NodeTypeDefinition[] = [
  {
    type: 'youdub.transcribe',
    version: '1.0.0',
    providerId: 'whisper',
    operation: 'transcribe',
    provider: { id: 'whisper', operations: [] },
    label: '识别',
    category: 'text',
    inputs: [],
    outputs: [],
    defaults: {},
    configSchema: {
      type: 'object',
      properties: {
        sourceLanguage: { type: 'string', enum: ['auto', 'en', 'ja'], 'x-title': '原文语言' },
        initialPrompt: { type: 'string', 'x-title': '识别提示词' },
      },
    },
    ui: { quickFields: ['sourceLanguage'] },
  },
]

const downloadDefinition: NodeTypeDefinition = {
  type: 'youdub.download',
  version: '1',
  label: '下载视频',
  category: 'media',
  providerId: 'youdub.download',
  provider: { id: 'youdub.download', operations: [] },
  operation: 'download',
  inputs: [],
  outputs: [{ name: 'video', kind: 'artifact', schemaId: 'video/mp4/v1', required: true }],
  configSchema: {
    type: 'object',
    properties: {
      proxyPort: { type: 'integer', minimum: 0, maximum: 65535, default: 0, 'x-title': '本机 HTTP 代理端口（0 为直连）' },
    },
  },
  defaults: { proxyPort: 0 },
}

function makeWorkflow(id = 'youdub.subtitles', title = '字幕翻译', inputId = 'video'): WorkflowDocument {
  return {
    format: 'youdub.workflow',
    formatVersion: 1,
    id,
    title,
    inputs: [{ id: inputId, label: '视频', kind: 'artifact', schemaId: 'file/v1', required: true, acceptedMimeTypes: ['video/*'] }],
    outputs: [],
    nodes: [
      { id: 'recognize', label: '第一段识别', type: 'youdub.transcribe', typeVersion: '1.0.0', provider: { id: 'whisper' }, config: { sourceLanguage: 'auto', initialPrompt: 'preserved' }, autoContinue: false },
      { id: 'recognize-second', label: '第二段识别', type: 'youdub.transcribe', typeVersion: '1.0.0', provider: { id: 'whisper' }, config: { sourceLanguage: 'en', initialPrompt: 'second' }, autoContinue: false },
    ],
    edges: [],
    presentation: { positions: {}, viewport: { x: 0, y: 0, zoom: 1 } },
  }
}

function createContext(request: (path: string, init?: RequestInit) => Promise<unknown>, push = vi.fn()): TestContext {
  const defaultDoc = makeWorkflow()
  const context = {
    apiClient: {
      request: async (path: string, init?: RequestInit) => {
        if (path.startsWith('/api/workflow-documents?')) {
          return { items: [{ id: defaultDoc.id, revision: 0, origin: 'builtin', document: defaultDoc }] }
        }
        if (path === '/api/node-types') return { items: baseDefinitions }
        if (path.includes('/resources/check')) return { status: 'ready', requirements: [] }
        if (path.includes('/validate')) return { valid: true, diagnostics: [] }
        return request(path, init)
      },
    },
    navigation: { push },
  } as TestContext
  testHost(context)
  return context
}

function mount(request: (path: string, init?: RequestInit) => Promise<unknown>, direct = false) {
  const push = vi.fn()
  const context = direct ? ({ apiClient: { request }, navigation: { push } } as TestContext) : createContext(request, push)
  render(<TestFeatureProvider context={context}><LanguageProvider><Page /></LanguageProvider></TestFeatureProvider>)
  return push
}

afterEach(() => { cleanup(); window.localStorage.clear() })

it('keeps dropped media across workflows and edits only each node’s declared basic settings for this run', async () => {
  const template = makeWorkflow()
  const another = makeWorkflow('another', '另一个工作流', 'renamed-video')
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/workflow-documents?')) return { items: [template, another].map((document) => ({ id: document.id, revision: 1, origin: 'builtin', document })) }
    if (path === '/api/node-types') return { items: baseDefinitions }
    if (path.includes('/resources/check')) return { status: 'ready', requirements: [] }
    if (path.includes('/validate')) return { valid: true, diagnostics: [] }
    if (path.startsWith('/api/tasks?')) return { items: [] }
    if (path === '/api/tasks' && init?.method === 'POST') throw new Error('Connection interrupted')
    throw new Error(`Unexpected request ${path}`)
  })
  mount(request, true)
  await screen.findByText('拖入视频，或点击选择文件')
  expect(screen.getByRole('heading', { name: '让视频说另一种语言' })).toBeInTheDocument()
  expect(screen.queryByText('处理流程')).not.toBeInTheDocument()
  expect(screen.queryByText('其他处理方式')).not.toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(screen.getByLabelText('工作流'))
  expect(screen.queryByRole('menuitem', { name: '旧视频流程' })).not.toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: 'Text workflow' })).not.toBeInTheDocument()
  expect(screen.getAllByRole('menuitem', { name: template.title })).toHaveLength(1)
  await user.keyboard('{Escape}')
  expect(screen.queryByLabelText('识别提示词')).not.toBeInTheDocument()
  const input = screen.getByLabelText('视频 *')
  fireEvent.drop(input.parentElement!, { dataTransfer: { files: [new File(['video'], 'dropped.mp4', { type: 'video/mp4' })] } })
  await user.click(screen.getByLabelText('第一段识别 · 原文语言'))
  await user.click(await screen.findByRole('menuitem', { name: 'ja' }))
  expect(screen.getByLabelText('第二段识别 · 原文语言')).toHaveTextContent('en')
  await user.click(screen.getByLabelText('工作流'))
  await user.click(await screen.findByRole('menuitem', { name: '另一个工作流' }))
  expect(screen.getByText('dropped.mp4')).toBeInTheDocument()
  await user.click(screen.getByLabelText('工作流'))
  await user.click(await screen.findByRole('menuitem', { name: template.title }))
  expect(screen.getByLabelText('第一段识别 · 原文语言')).toHaveTextContent('ja')
  expect(template.nodes[0].config.sourceLanguage).toBe('auto')
  await waitFor(() => expect(screen.getByRole('button', { name: '开始处理' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '开始处理' }))
  await screen.findByText('Connection interrupted')
  const body = request.mock.calls.find(([path, init]) => path === '/api/tasks' && init?.method === 'POST')![1]!.body as FormData
  const submitted = JSON.parse(String(body.get('request')))
  expect(submitted).toMatchObject({ workflowId: 'youdub.graph', documentRevision: null })
  expect(submitted.graphDocument.nodes[0].config).toEqual({ sourceLanguage: 'ja', initialPrompt: 'preserved' })
  expect(submitted.graphDocument.nodes[1].config.sourceLanguage).toBe('en')
  expect(submitted.graphDocument.nodes[0].autoContinue).toBe(false)
  expect((body.get('input.video') as File).name).toBe('dropped.mp4')
  expect(screen.getByLabelText('工作流')).toBeDisabled()
  expect(screen.getByLabelText('第一段识别 · 原文语言')).toBeDisabled()
})

it('submits declared input slots and preserves an uncertain creation ID until explicitly cleared', async () => {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/tasks?')) return { items: [], hasMore: false, limit: 12, offset: 0 }
    if (init?.method === 'DELETE') return undefined
    throw new Error('Connection interrupted')
  })
  const context = createContext(request)
  render(<TestFeatureProvider context={context}><LanguageProvider><Page /></LanguageProvider></TestFeatureProvider>)
  const input = await screen.findByLabelText('视频 *')
  expect(screen.getByRole('link', { name: '查看官网示例' })).toHaveAttribute('href', 'https://liuzhao1225.github.io/YouDub-webui/#demo')
  const user = userEvent.setup()
  await user.upload(input, new File(['video'], 'input.mp4', { type: 'video/mp4' }))
  expect((input as HTMLInputElement).files).toHaveLength(1)
  await waitFor(() => expect(screen.getByRole('button', { name: '开始处理' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '开始处理' }))
  await screen.findByText('Connection interrupted')
  const first = request.mock.calls.find(([path, init]) => path === '/api/tasks' && init?.method === 'POST')![1]!.body as FormData
  const firstRequest = JSON.parse(first.get('request') as string)
  expect(firstRequest).toMatchObject({ workflowId: 'youdub.graph', config: {} })
  expect((first.get('input.video') as File).name).toBe('input.mp4')
  expect(input).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '查询创建结果' }))
  await waitFor(() => expect(request).toHaveBeenCalledWith(`/api/tasks/${firstRequest.id}`, undefined))
  expect(input).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '放弃本次提交并修改' }))
  await waitFor(() => expect(input).toBeEnabled())
  expect(request).toHaveBeenCalledWith(`/api/imports/${firstRequest.id}`, { method: 'DELETE' })
})

it('locks workflow selection while a submitted import still needs reconciliation', async () => {
  const firstDoc = makeWorkflow('first', '第一个工作流')
  const secondDoc = makeWorkflow('second', '另一个工作流', 'other-video')
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/workflow-documents?')) return { items: [firstDoc, secondDoc].map((document) => ({ id: document.id, revision: 1, origin: 'builtin', document })) }
    if (path === '/api/node-types') return { items: baseDefinitions }
    if (path.includes('/resources/check')) return { status: 'ready', requirements: [] }
    if (path.includes('/validate')) return { valid: true, diagnostics: [] }
    if (path.startsWith('/api/tasks?')) return { items: [], hasMore: false, limit: 12, offset: 0 }
    if (init?.method === 'DELETE') return undefined
    throw new Error('Connection interrupted')
  })
  mount(request, true)
  const input = await screen.findByLabelText('视频 *')
  const user = userEvent.setup()
  await user.upload(input, new File(['video'], 'input.mp4', { type: 'video/mp4' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '开始处理' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '开始处理' }))
  await screen.findByText('Connection interrupted')
  expect(screen.getByLabelText('工作流')).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '放弃本次提交并修改' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '工作流' })).toBeEnabled())
  await user.click(screen.getByLabelText('工作流'))
  await user.click(screen.getByRole('menuitem', { name: '另一个工作流' }))
  expect(screen.getByLabelText('工作流')).toHaveTextContent('另一个工作流')
})

it('counts review nodes even while their independent branch is running', async () => {
  const active: TaskView = {
    id: 'review',
    status: 'running',
    attempt: 1,
    sourceName: 'review.mp4',
    createdAt: '2026-10-09T01:00:00Z',
    workflowId: 'youdub.graph',
    workflowVersion: '1',
    config: {},
    outputs: [],
    allowedActions: [],
    steps: [
      { id: 'translate', label: '翻译', status: 'awaiting_review', progress: 1 },
      { id: 'audio', label: '生成配音', status: 'running', progress: 0.5 },
    ],
  }
  mount(vi.fn(async () => ({ items: [active], hasMore: false })))
  const review = await screen.findByRole('link', { name: '1 个节点待确认' })
  expect(review).toHaveAttribute('href', '/tasks/review/nodes/translate')
  expect(screen.getByRole('link', { name: '1 个任务正在处理' })).toBeInTheDocument()
  expect(screen.getByRole('progressbar', { name: '生成配音 进度' })).toHaveAttribute('aria-valuenow', '50')
})

it('shows the selected file and clears it before allowing a fresh selection', async () => {
  mount(vi.fn(async () => ({ items: [], hasMore: false, limit: 12, offset: 0 })))
  const user = userEvent.setup()
  const input = await screen.findByLabelText('视频 *')
  expect(screen.getByRole('button', { name: '开始处理' })).toBeDisabled()
  await user.upload(input, new File(['hello'], 'first.mp4', { type: 'video/mp4' }))
  expect(screen.getByText('first.mp4')).toBeInTheDocument()
  expect(screen.getByText(/5 B/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '开始处理' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: '移除 first.mp4' }))
  expect(screen.queryByText('first.mp4')).not.toBeInTheDocument()
  expect(input).toHaveValue('')
  expect(screen.getByRole('button', { name: '开始处理' })).toBeDisabled()
  await user.upload(input, new File(['again'], 'second.mp4', { type: 'video/mp4' }))
  expect(screen.getByText('second.mp4')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '开始处理' })).toBeEnabled()
})

it('keeps active tasks separate from recent results and links to their detail pages', async () => {
  const task = (id: string, status: TaskView['status']): TaskView => ({
    id,
    status,
    attempt: 1,
    sourceName: `${id}.mp4`,
    createdAt: '2026-10-09T01:00:00Z',
    workflowId: 'youdub.graph',
    workflowVersion: '1.0.0',
    config: {},
    steps: [],
    outputs: [],
    allowedActions: [],
    cover: { url: `/cover/${id}.jpg` },
  })
  const items = [task('running', 'running'), task('completed', 'succeeded'), task('failed', 'failed'), task('cancelling', 'cancelling')]
  items[0].steps = [{ id: 'synthesize', label: '生成配音', status: 'running', progress: null }, { id: 'export', label: '导出', status: 'pending', progress: null }]
  const push = mount(vi.fn(async () => ({ items, hasMore: false, limit: 12, offset: 0 })))
  const active = await screen.findByRole('region', { name: '进行中' })
  const recent = screen.getByRole('region', { name: '最近任务' })
  expect(active).toHaveTextContent('running.mp4')
  expect(active).toHaveTextContent('cancelling.mp4')
  expect(active).not.toHaveTextContent('completed.mp4')
  expect(active).toHaveTextContent('生成配音')
  expect(active).toHaveTextContent('已完成 0/2 步')
  expect(active.querySelector('img')).toHaveAttribute('src', '/cover/running.jpg')
  expect(active.querySelector('progress')).toBeNull()
  expect(recent).toHaveTextContent('completed.mp4')
  expect(recent).toHaveTextContent('failed.mp4')
  expect(recent).not.toHaveTextContent('running.mp4')
  expect(recent.querySelector('img')).toHaveAttribute('src', '/cover/completed.jpg')
  await userEvent.setup().click(screen.getByRole('link', { name: /completed.mp4/ }))
  expect(push).toHaveBeenCalledWith('/tasks/completed')
})

it('places the link first, switches between sources and submits a canonical URL without a file', async () => {
  const doc = makeWorkflow()
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/workflow-documents?')) return { items: [{ id: doc.id, revision: 1, origin: 'builtin', document: doc }] }
    if (path === '/api/node-types') return { items: [...baseDefinitions, downloadDefinition] }
    if (path.includes('/resources/check')) return { status: 'ready', requirements: [] }
    if (path.includes('/validate')) return { valid: true, diagnostics: [] }
    if (init?.method === 'POST') return { id: 'download' }
    return { items: [], hasMore: false, limit: 12, offset: 0 }
  })
  const push = mount(request, true)
  const user = userEvent.setup()
  const link = await screen.findByLabelText('视频链接')
  const file = screen.getByLabelText('视频 *') as HTMLInputElement
  expect(link.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByRole('button', { name: '开始处理' })).toBeDisabled()
  await user.upload(file, new File(['video'], 'clip.mp4', { type: 'video/mp4' }))
  await user.type(link, 'https://youtu.be/jNQXAC9IVRw')
  expect(file.files).toHaveLength(0)
  expect(screen.queryByText('clip.mp4')).not.toBeInTheDocument()
  await user.upload(file, new File(['video'], 'clip.mp4', { type: 'video/mp4' }))
  expect(link).toHaveValue('')
  await user.type(link, 'http://127.0.0.1/secret')
  await user.tab()
  expect(screen.getByRole('button', { name: '开始处理' })).toBeDisabled()
  expect(screen.getByText('仅支持 YouTube 和 Bilibili 视频链接')).toBeInTheDocument()
  await user.clear(link)
  await user.type(link, 'https://youtu.be/jNQXAC9IVRw')
  const proxy = screen.getByRole('spinbutton', { name: '本机 HTTP 代理端口（0 为直连）' })
  fireEvent.change(proxy, { target: { value: '7897' } })
  await user.click(screen.getByRole('button', { name: '下载并处理' }))
  await waitFor(() => expect(push).toHaveBeenCalledWith('/tasks/download'))
  const body = request.mock.calls.find(([path, init]) => path === '/api/tasks' && init?.method === 'POST')![1]!.body as FormData
  const submitted = JSON.parse(body.get('request') as string)
  expect(submitted.nodeRuntimeInputs['source-download']).toEqual({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' })
  expect(submitted.graphDocument.nodes[0].config.proxyPort).toBe(7897)
  expect(body.has('input.video')).toBe(false)
})

it('retains a submission across a route unmount and does not navigate from its late response', async () => {
  let finish!: (task: { id: string }) => void
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/tasks?')) return { items: [] }
    if (path === '/api/tasks' && init?.method === 'POST') return new Promise<{ id: string }>(resolve => { finish = resolve })
    throw new Error('Unexpected request ' + path)
  })
  const push = vi.fn()
  const context = createContext(request, push)
  const show = () => render(<TestFeatureProvider context={context}><LanguageProvider><Page /></LanguageProvider></TestFeatureProvider>)
  const first = show(), user = userEvent.setup()
  const input = await screen.findByLabelText('视频 *')
  await user.upload(input, new File(['data'], 'pending.mp4', { type: 'video/mp4' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '开始处理' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '开始处理' }))
  await waitFor(() => expect(finish).toBeDefined())
  first.unmount()
  await act(async () => finish({ id: 'created-while-away' }))
  expect(push).not.toHaveBeenCalled()
  show()
  expect(await screen.findByText('pending.mp4')).toBeInTheDocument()
  expect(screen.getByLabelText('视频 *')).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '查询创建结果' }))
  expect(push).toHaveBeenCalledWith('/tasks/created-while-away')
  expect(request.mock.calls.filter(([path, init]) => path === '/api/tasks' && init?.method === 'POST')).toHaveLength(1)
})
