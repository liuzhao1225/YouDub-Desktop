import { useState, type ReactNode } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsModal, type ImageProviderView } from '@/components/settings/SettingsModal'
import { TaskErrorAlert } from '@/components/task-error-guidance'
import { SettingsActionContext } from '@/lib/settings-navigation'
import { ThemeProvider } from '@/lib/theme'
import { translateMessage } from '@/locales'
import { createFeatures, FeatureProvider } from '@/runtime/features'
import { StudioDraftStore } from '@/runtime/studio-draft'
import { LanguageProvider } from '@/test/language-provider'
import { TaskDetail } from './builtin/library'
import { UploadSlot } from './builtin/media-upload'
import { taskProgressMessage } from './builtin/task-status'
import { GraphPorts, NodeSettings } from './builtin/workflow-settings'
import { TaskNodePage } from './builtin/workflow-task'
import { changesResources, resourceKey } from './runtime/workflow-resources'
import type { NodeTypeDefinition, Request, TaskNodeDetail, TaskView, WorkflowDocument } from './sdk'
import { bindTestComponent, TestFeatureProvider } from './test-bindings'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

const defaultModel = 'doubao-seedream-5-5-261028'
const model4 = 'doubao-seedream-4-5-251128'
const seedEdit = 'doubao-seededit-3-0-i2i-250628'
const endpoint = 'ep-20260101-test'
const providerName = '火山方舟 (Seedream)'
const providerPath = '/api/image/providers/volcengine'

function mountSettings(focusSection?: 'volcengine', initialProvider?: Partial<ImageProviderView>) {
  const settings = {
    ui_language: 'zh',
    theme: 'system',
    ...(initialProvider ? {
      image_providers: [{
        id: 'volcengine', name: providerName, preset: 'volcengine',
        base_url: 'https://ark.cn-beijing.volces.com/api/v3', default_model: defaultModel,
        models: [defaultModel], enabled: true, requiresApiKey: true, hasApiKey: true,
        apiKeyHint: '***old', available: true, ...initialProvider,
      }],
    } : {}),
  }
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/settings') return settings
    if (path === '/api/llm/providers' || path === '/api/llm/presets') return { items: [] }
    if (path === providerPath + '/test' && init?.method === 'POST') {
      return { ok: true, model: model4, profile: 'seedream-4.x', latencyMs: 187 }
    }
    if (path === providerPath && init?.method === 'PUT') {
      const { name, preset, base_url, default_model, models, enabled } = JSON.parse(String(init.body))
      return {
        id: 'volcengine', name, preset, base_url, default_model, models, enabled,
        requiresApiKey: true, hasApiKey: true, apiKeyHint: '***demo', available: true,
      } satisfies ImageProviderView
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`)
  })
  render(
    <ThemeProvider>
      <LanguageProvider>
        <SettingsModal open initialTab="llm" focusSection={focusSection} onClose={vi.fn()} request={request as Request} />
      </LanguageProvider>
    </ThemeProvider>,
  )
  return request
}

it('opens the focused Seedream provider at the latest default and updates compatibility as the model changes', async () => {
  const user = userEvent.setup()
  mountSettings('volcengine')

  const provider = await screen.findByRole('button', { name: /火山方舟 \(Seedream\)/ })
  expect(provider).toHaveAttribute('aria-current', 'true')
  const model = screen.getByRole('textbox', { name: '默认模型' })
  expect(model).toHaveValue(defaultModel)
  const selected = screen.getByRole('button', { name: new RegExp(defaultModel), pressed: true })
  expect(within(selected).getByText('最新 · 默认')).toBeVisible()
  const indicator = screen.getByText('兼容模式').closest('[aria-live="polite"]')!
  expect(indicator).toHaveTextContent('Seedream 5.5 / Pro 模式')

  await user.click(screen.getByRole('button', { name: new RegExp(model4) }))
  expect(model).toHaveValue(model4)
  expect(indicator).toHaveTextContent('Seedream 4.x / 5.0 模式')

  await user.click(screen.getByRole('button', { name: new RegExp(seedEdit) }))
  expect(model).toHaveValue(seedEdit)
  expect(indicator).toHaveTextContent('SeedEdit 3.0 模式')
  expect(indicator).not.toHaveTextContent('接入点 ID')

  await user.clear(model)
  await user.type(model, endpoint)
  expect(indicator).toHaveTextContent('Seedream 5.5 / Pro 模式')
  expect(indicator).toHaveTextContent('接入点 ID 按 Seedream 5.5 的参数调用')
})

it('opens Ark from the image generation group, tests the draft connection, and saves its key and model', async () => {
  const user = userEvent.setup()
  const request = mountSettings()
  const groupLabel = await screen.findByText('封面生图')
  const provider = within(groupLabel.parentElement!).getByRole('button', { name: /火山方舟 \(Seedream\)/ })
  expect(groupLabel.compareDocumentPosition(provider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await user.click(provider)
  const model = screen.getByLabelText('默认模型')
  await user.clear(model)
  await user.type(model, endpoint)
  await user.type(screen.getByLabelText('API Key'), 'fixture-key')
  await user.click(screen.getByRole('button', { name: '测试连接' }))

  expect(await screen.findByText(`连接成功（${model4} · Seedream 4.x / 5.0 模式，187 ms）`)).toBeVisible()
  await user.click(screen.getByRole('button', { name: '保存' }))
  expect(await screen.findByText('已保存')).toBeVisible()
  for (const [path, method] of [[providerPath + '/test', 'POST'], [providerPath, 'PUT']]) {
    const call = request.mock.calls.find(([url, init]) => url === path && init?.method === method)
    expect(call).toBeDefined()
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({ default_model: endpoint, api_key: 'fixture-key' })
  }
  const putCall = request.mock.calls.find(([url, init]) => url === providerPath && init?.method === 'PUT')
  expect(JSON.parse(String(putCall![1]!.body)).models[0]).toBe(endpoint)
})

it('sends clear_api_key when testing after clearing the saved image key and invalidates resources on PUT', async () => {
  const user = userEvent.setup()
  const request = mountSettings('volcengine', { hasApiKey: true, apiKeyHint: '***old' })
  await user.click(await screen.findByRole('button', { name: '清除已保存密钥' }))
  await user.click(screen.getByRole('button', { name: '测试连接' }))
  const probeCall = request.mock.calls.find(([url, init]) => url === providerPath + '/test' && init?.method === 'POST')
  expect(JSON.parse(String(probeCall![1]!.body))).toMatchObject({ clear_api_key: true })

  expect(changesResources(providerPath, 'PUT')).toBe(true)
  const raw = vi.fn(async (url: string) => {
    if (url === '/api/node-types') return { items: [] }
    if (url === '/api/workflow-documents/resources/check') return { status: 'missing', requirements: [] }
    return {}
  })
  const features = createFeatures(vi.fn(), vi.fn(), raw as Request)
  function Observer() {
    features.useQuery('/api/node-types')
    features.useWorkflowResources(graph)
    return null
  }
  render(<FeatureProvider value={features}><Observer /></FeatureProvider>)
  await waitFor(() => {
    expect(raw).toHaveBeenCalledWith('/api/node-types', expect.anything())
    expect(raw).toHaveBeenCalledWith('/api/workflow-documents/resources/check', expect.anything())
  })
  raw.mockClear()
  await features.request(providerPath, { method: 'PUT', body: '{}' })
  await waitFor(() => {
    expect(raw).toHaveBeenCalledWith('/api/node-types', expect.anything())
    expect(raw).toHaveBeenCalledWith('/api/workflow-documents/resources/check', expect.anything())
  })
})

const definition: NodeTypeDefinition = {
  type: 'youdub.translateCover', version: '1.0.0', label: '翻译封面', category: 'cover',
  providerId: 'volcengine', operation: 'cover.translate/v1',
  provider: {
    id: 'volcengine', label: providerName, capability: 'cover_translation', execution: 'remote',
    operations: [{ id: 'cover.translate/v1' }], available: true,
  },
  inputs: [{ id: 'cover', label: '封面或视频', kind: 'artifact', required: true, acceptedSchemaIds: ['image/file/v1', 'video/mp4/v1'] }],
  outputs: [
    { name: 'cover', kind: 'artifact', required: true, schemaId: 'image/jpeg/v1' },
    { name: 'coverMeta', kind: 'json', required: false, schemaId: 'youdub.coverMeta/v1' },
  ],
  configSchema: { type: 'object' }, defaults: {},
}
const node = {
  id: 'translate-cover', type: definition.type, typeVersion: definition.version,
  provider: { id: definition.providerId }, config: {}, autoContinue: true,
}
const graph: WorkflowDocument = {
  format: 'youdub.workflow', formatVersion: 1, id: 'cover-flow', title: '封面翻译', nodes: [node],
  inputs: [{ id: 'source', label: '来源', kind: 'artifact', required: true, schemaId: 'file/v1', acceptedMimeTypes: ['*/*'] }],
  edges: [{ id: 'source-cover', source: { nodeId: '$inputs', portId: 'source' }, target: { nodeId: node.id, portId: 'cover' } }],
  outputs: [{ id: 'cover', label: '翻译后封面', kind: 'artifact', required: true, schemaId: 'image/jpeg/v1', source: { nodeId: node.id, portId: 'cover' } }],
  presentation: { positions: {}, viewport: { x: 0, y: 0, zoom: 1 } },
}

it('changes a graph input to the image schema and accepts image uploads', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(<GraphPorts document={graph} direction="inputs" types={[definition]} disabled={false} onChange={onChange} />, { wrapper: LanguageProvider })
  await user.click(screen.getByRole('button', { name: '输入类型' }))
  await user.click(screen.getByRole('menuitem', { name: '图片' }))
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
    inputs: [{ ...graph.inputs[0], schemaId: 'image/file/v1', acceptedMimeTypes: ['image/*'] }],
  }))
  const imageGraph = { ...graph, inputs: [{ ...graph.inputs[0], schemaId: 'image/file/v1', acceptedMimeTypes: ['image/*'] }] }
  const pngGraph = { ...graph, inputs: [{ ...graph.inputs[0], schemaId: 'image/png/v1', acceptedMimeTypes: ['image/*'] }] }
  const videoGraph = { ...graph, inputs: [{ ...graph.inputs[0], schemaId: 'video/mp4/v1', acceptedMimeTypes: ['video/*'] }] }
  expect(resourceKey(imageGraph)).toBe(resourceKey(pngGraph))
  expect(resourceKey(imageGraph)).not.toBe(resourceKey(videoGraph))
  expect(resourceKey(videoGraph)).toBe(resourceKey(graph))
})

const BoundNodeSettings = bindTestComponent(NodeSettings, ['useSlot'])
const BoundTaskNode = bindTestComponent(TaskNodePage, ['request', 'navigate', 'blockNavigation', 'useQuery', 'useSlot'])
const BoundTaskDetail = bindTestComponent(TaskDetail, ['request', 'navigate', 'useQuery', 'useSlot'])

function renderPlugin(children: ReactNode, request: Request) {
  return render(
    <TestFeatureProvider context={{ apiClient: { request } }}>
      <LanguageProvider>{children}</LanguageProvider>
    </TestFeatureProvider>,
  )
}

it('links an unconfigured cover node directly to Volcengine settings', () => {
  const unconfigured = { ...definition, provider: { ...definition.provider, available: false } }
  renderPlugin(<BoundNodeSettings node={node} document={graph} types={[unconfigured]} readOnly={false} onChange={vi.fn()} />, vi.fn())
  expect(screen.getByRole('link', { name: '配置火山方舟 API' })).toHaveAttribute('href', '/settings/models?section=volcengine')
})

it('previews the selected image and releases its object URL on removal and unmount', async () => {
  const user = userEvent.setup()
  const create = vi.fn().mockReturnValueOnce('blob:cover-first').mockReturnValueOnce('blob:cover-second')
  const revoke = vi.fn()
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = create
    static revokeObjectURL = revoke
  })
  function ImageUpload() {
    const [file, setFile] = useState<File>()
    return <UploadSlot slot={{ name: 'cover', label: '封面', required: true, acceptedMimeTypes: ['image/*'] }}
      alternative={false} disabled={false} file={file} onChange={setFile} />
  }
  const view = render(<ImageUpload />, { wrapper: LanguageProvider })
  const input = screen.getByLabelText('封面 *')
  expect(input).toHaveAttribute('accept', 'image/*')
  expect(screen.getByText('拖入封面图片，或点击选择')).toBeVisible()
  const file = new File(['cover'], 'cover.jpg', { type: 'image/jpeg' })
  await user.upload(input, file)
  expect(await screen.findByRole('img', { name: file.name })).toHaveAttribute('src', 'blob:cover-first')
  expect(create).toHaveBeenCalledWith(file)
  expect(revoke).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '移除 cover.jpg' }))
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  expect(revoke.mock.calls).toEqual([['blob:cover-first']])

  await user.upload(input, file)
  expect(await screen.findByRole('img', { name: file.name })).toHaveAttribute('src', 'blob:cover-second')
  view.unmount()
  expect(revoke.mock.calls).toEqual([['blob:cover-first'], ['blob:cover-second']])
})

const task: TaskView = {
  id: 'task', attempt: 1, revision: 1, status: 'succeeded', sourceName: '封面素材',
  createdAt: '2026-10-29T00:00:00Z', workflowId: 'youdub.graph', workflowVersion: '1',
  config: {}, graphSnapshot: graph, allowedActions: ['delete'],
  steps: [{ id: node.id, label: definition.label, status: 'completed', progress: 1 }],
  outputs: [{ id: 'cover', label: '翻译后封面', name: 'cover.jpg', mimeType: 'image/jpeg', url: '/api/tasks/task/files/cover' }],
}

function renderCoverNode(source: { id: string; schemaId: string }, sourceCover?: { id: string; schemaId: string }) {
  const outputs = {
    cover: { id: 'translated.jpg', schemaId: 'image/jpeg/v1' },
    coverMeta: {
      model: defaultModel, profile: 'seedream-5.5', width: 2048, height: 1152,
      aspectRatio: '16:9', coverTitle: '月球之旅', ...(sourceCover ? { sourceCover } : {}),
    },
  }
  const detail: TaskNodeDetail = {
    taskId: task.id, nodeId: node.id, taskRevision: 1, attempt: 1, status: task.status,
    step: { ...task.steps[0], outputs }, spec: { operation: definition.operation, outputs: definition.outputs, input: {} },
    inputs: { cover: source }, outputRevision: 1,
    resultRevisions: [{ revision: 1, source: 'computed', outputs, createdAt: task.createdAt }],
  }
  const request = async (path: string) => {
    if (path === '/api/tasks/task') return task
    if (path === '/api/tasks/task/nodes/translate-cover') return detail
    if (path === '/api/node-types') return { items: [definition] }
    throw new Error(`Unexpected request: ${path}`)
  }
  renderPlugin(<BoundTaskNode params={{ id: task.id, nodeId: node.id }} submissionStore={new StudioDraftStore()} />, request as Request)
}

it('shows both cover images and their generation metadata in the node result', async () => {
  renderCoverNode({ id: 'original.png', schemaId: 'image/png/v1' })
  const panel = await screen.findByRole('tabpanel')
  const [original, translated] = within(panel).getAllByRole('figure')
  const comparison = original.parentElement!
  expect(comparison).toHaveClass('grid', '@min-[640px]/page:grid-cols-2')
  expect(translated.parentElement).toBe(comparison)
  expect(within(original).getByRole('img', { name: '原封面' })).toHaveAttribute('src', '/api/tasks/task/artifacts/original.png')
  expect(within(translated).getByRole('img', { name: '翻译后封面' })).toHaveAttribute('src', '/api/tasks/task/artifacts/translated.jpg')
  for (const [label, value] of [
    ['模型', defaultModel], ['兼容模式', 'Seedream 5.5 / Pro 模式'], ['分辨率', '2048 × 1152'], ['画幅比例', '16:9'], ['封面标题', '月球之旅'],
  ]) {
    const term = within(panel).getByText(label, { selector: 'dt' })
    expect(within(term.parentElement!).getByRole('definition')).toHaveTextContent(value)
  }
})

it('compares sourceCover artifact even when the upstream edge is video/mp4/v1 and previews images in file/v1 slots', async () => {
  renderCoverNode(
    { id: 'download:video', schemaId: 'video/mp4/v1' },
    { id: 'translate-cover:sourceCover', schemaId: 'image/jpeg/v1' },
  )
  const panel = await screen.findByRole('tabpanel')
  expect(within(panel).getByRole('img', { name: '原封面' })).toHaveAttribute('src', '/api/tasks/task/artifacts/translate-cover%3AsourceCover')
  expect(within(panel).getByRole('img', { name: '翻译后封面' })).toHaveAttribute('src', '/api/tasks/task/artifacts/translated.jpg')
  cleanup()

  const create = vi.fn().mockReturnValue('blob:generic-cover')
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = vi.fn() })
  const user = userEvent.setup()
  function GenericUpload() {
    const [file, setFile] = useState<File>()
    return <UploadSlot slot={{ name: 'cover', label: '源文件', required: true, acceptedMimeTypes: ['*/*'] }}
      alternative={false} disabled={false} file={file} onChange={setFile} />
  }
  render(<GenericUpload />, { wrapper: LanguageProvider })
  const file = new File(['cover'], 'thumb.jpg', { type: 'image/jpeg' })
  await user.upload(screen.getByLabelText('源文件 *'), file)
  expect(await screen.findByRole('img', { name: file.name })).toHaveAttribute('src', 'blob:generic-cover')
})

it('shows only the translated image and explains the missing original when the source is video', async () => {
  renderCoverNode({ id: 'original.mp4', schemaId: 'video/mp4/v1' })
  const panel = await screen.findByRole('tabpanel')
  expect(within(panel).getByText('来源是视频，没有可对比的原封面，仅显示翻译后的封面。')).toBeVisible()
  const translated = within(panel).getByRole('img', { name: '翻译后封面' })
  expect(translated).toHaveAttribute('src', '/api/tasks/task/artifacts/translated.jpg')
  expect(Array.from(panel.querySelectorAll('img'))).toEqual([translated])
})

it('shows an inline JPEG preview alongside its task output download', async () => {
  renderPlugin(<BoundTaskDetail params={{ id: task.id }} />, vi.fn(async () => task) as Request)
  const preview = await screen.findByRole('img', { name: '翻译后封面' })
  expect(preview).toHaveAttribute('src', task.outputs[0].url)
  const download = within(preview.closest('li')!).getByRole('link', { name: '下载 翻译后封面' })
  expect(download).toHaveAttribute('download')
  expect(download).toHaveAttribute('href', task.outputs[0].url)
})

it('opens Volcengine settings from an image authentication error', async () => {
  const user = userEvent.setup()
  const openSettings = vi.fn()
  render(
    <SettingsActionContext.Provider value={openSettings}>
      <TaskErrorAlert error={{ code: 'IMAGE_AUTH_ERROR', message: '401 Unauthorized' }} />
    </SettingsActionContext.Provider>, { wrapper: LanguageProvider },
  )
  expect(screen.getByRole('alert')).toHaveTextContent('封面生图服务认证失败')
  await user.click(screen.getByRole('button', { name: '前往封面生图设置' }))
  expect(openSettings).toHaveBeenCalledWith('llm', 'volcengine')
})

it.each([
  ['Preparing source cover', '正在准备原封面'],
  ['Translating cover with Volcengine Seedream', '正在用火山方舟 Seedream 翻译封面'],
  ['Finalizing translated cover', '正在整理翻译后的封面'],
])('localizes the persisted progress message "%s"', (message, expected) => {
  expect(taskProgressMessage(message, (key, params) => translateMessage('zh', key, params))).toBe(expected)
})
