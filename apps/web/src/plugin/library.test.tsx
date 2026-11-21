import { TestFeatureProvider, type TestContext } from './test-bindings'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '@/test/language-provider'
import { type TaskView } from './sdk'
import { Library, TaskDetail } from './builtin/library'
import { bindTestComponent } from './test-bindings'

const TasksPage = bindTestComponent(Library, ['useQuery', 'navigate'])
const TaskPage = bindTestComponent(TaskDetail, ['request', 'navigate', 'useQuery', 'useSlot'])

const task: TaskView = {
  id: 'original',
  attempt: 2,
  status: 'succeeded',
  sourceName: 'document.txt',
  createdAt: '2026-10-09T00:00:00Z',
  workflowId: 'youdub.graph',
  workflowVersion: '1.0.0',
  config: {},
  steps: [],
  outputs: [],
  allowedActions: ['delete'],
}

function mount(request: ReturnType<typeof vi.fn>, route = 'task-detail') {
  const push = vi.fn()
  const Page = route === 'library' ? TasksPage : TaskPage
  const context = {
    apiClient: { request },
    navigation: { push },
    slots: { subscribe: () => () => {}, getSnapshot: () => 0, list: () => [] },
    effect: (effect: () => unknown) => effect(),
  } as unknown as TestContext
  const show = () => render(<TestFeatureProvider context={context}><LanguageProvider><Page params={{ id: task.id }} /></LanguageProvider></TestFeatureProvider>)
  const view = show()
  return Object.assign(push, { unmount: view.unmount, show })
}

afterEach(() => { cleanup(); window.localStorage.clear(); vi.restoreAllMocks() })

it('continues a failed task through its existing retry endpoint and refreshes the same task', async () => {
  const failed = { ...task, status: 'failed', allowedActions: ['retry', 'delete'], error: { code: 'FAILED', message: 'Fifth node unavailable' } }
  let current = failed
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/retry')) {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(init!.body as string)).toEqual({ expectedAttempt: 2 })
      current = { ...failed, status: 'queued', allowedActions: ['cancel'] }
    }
    return current
  })
  const push = mount(request)
  await userEvent.setup().click(await screen.findByRole('button', { name: '继续任务' }))
  await screen.findByRole('button', { name: '取消任务' })
  expect(request).toHaveBeenCalledWith('/api/tasks/original/retry', expect.anything())
  expect(push).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '从头重试' })).not.toBeInTheDocument()
})

it('keeps the continuation error visible when retry is rejected', async () => {
  mount(vi.fn(async (path: string) => {
    if (path.endsWith('/retry')) throw new Error('Saved result file is missing')
    return { ...task, status: 'failed', allowedActions: ['retry'] }
  }))
  await userEvent.setup().click(await screen.findByRole('button', { name: '继续任务' }))
  expect(await screen.findByText('Saved result file is missing')).toBeVisible()
  expect(screen.getByRole('button', { name: '继续任务' })).toBeEnabled()
})

it('shows the running step and completed step count without inventing total progress', async () => {
  const current: TaskView = {
    ...task,
    status: 'running',
    sourceName: 'very-long-video-title-without-any-spaces-to-keep-the-status-readable.mp4',
    cover: { url: '/cover/current.jpg' },
    steps: [
      ...Array.from({ length: 5 }, (_, index) => ({ id: `done-${index}`, label: 'Done', status: 'completed', progress: 1 })),
      { id: 'synthesize', label: '生成配音', status: 'running', progress: null },
      { id: 'align', label: '字幕对齐', status: 'pending', progress: null },
      { id: 'export', label: '导出', status: 'pending', progress: null },
    ],
  }
  mount(vi.fn(async () => ({ items: [current], hasMore: false, limit: 20, offset: 0 })), 'library')
  const heading = await screen.findByRole('heading', { name: current.sourceName })
  expect(heading).toHaveAttribute('title', current.sourceName)
  expect(screen.getByText('生成配音')).toBeInTheDocument()
  expect(screen.getByText('已完成 5/8 步')).toBeInTheDocument()
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  expect(screen.queryByText('youdub.graph')).not.toBeInTheDocument()
  expect(document.querySelector('img')).toHaveAttribute('src', '/cover/current.jpg')
})

it('filters cancelling tasks and distinguishes an empty filter from an empty library', async () => {
  const request = vi.fn(async () => ({ items: [], hasMore: false, limit: 20, offset: 0 }))
  mount(request, 'library')
  await screen.findByText('还没有任务')
  expect(screen.queryByRole('button', { name: '上一页' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '下一页' })).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByLabelText('任务状态'))
  await userEvent.setup().click(screen.getByRole('menuitem', { name: '正在取消' }))
  await screen.findByText('没有符合此状态的任务')
  expect(screen.queryByText('还没有任务')).not.toBeInTheDocument()
  expect(request).toHaveBeenCalledWith('/api/tasks?limit=20&offset=0&status=cancelling', expect.objectContaining({ signal: expect.any(AbortSignal) }))
})

it('keeps a way back when the last page becomes empty', async () => {
  const request = vi.fn(async (path: string) => ({ items: path.includes('offset=20') ? [] : [task], hasMore: !path.includes('offset=20'), limit: 20, offset: path.includes('offset=20') ? 20 : 0 }))
  mount(request, 'library')
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '下一页' }))
  await screen.findByText('本页没有任务')
  expect(screen.queryByText('还没有任务')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '上一页' }))
  await screen.findByRole('heading', { name: 'document.txt' })
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
})

it('releases audio reads before allowing task deletion', async () => {
  const request = vi.fn(async () => ({ ...task, outputs: [{ id: 'audio', label: 'Audio', mimeType: 'audio/wav', url: '/api/tasks/original/files/audio' }] }))
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  mount(request)
  await screen.findByRole('button', { name: '删除任务' })
  const audio = document.querySelector('audio')!
  Object.defineProperty(audio, 'paused', { value: false })
  Object.defineProperty(audio, 'networkState', { value: 2 })
  await userEvent.setup().click(screen.getByRole('button', { name: '删除任务' }))
  expect(audio.getAttribute('src')).toBeNull()
  expect(pause).toHaveBeenCalledOnce()
  expect(load).toHaveBeenCalledOnce()
})

it('shows graph results before a collapsed step list and uses the workflow title', async () => {
  const graph = { format: 'youdub.workflow', formatVersion: 1, id: 'graph', title: '字幕校对', nodes: [], edges: [], inputs: [], outputs: [], presentation: { positions: {}, viewport: { x: 0, y: 0, zoom: 1 } } }
  mount(vi.fn(async () => ({ ...task, sourceName: 'youdub.graph', workflowId: 'youdub.graph', graphSnapshot: graph, outputs: [{ id: 'subtitle', label: '中文字幕', mimeType: 'application/x-subrip', url: '/subtitle.srt' }], steps: [{ id: 'translate', label: '翻译', status: 'completed', progress: 1 }] })))
  await screen.findByRole('heading', { name: '字幕校对', level: 1 })
  expect(screen.queryByText(/youdub.graph/)).not.toBeInTheDocument()
  const results = screen.getByRole('heading', { name: '生成文件' })
  const steps = screen.getByRole('button', { name: /步骤列表/ })
  expect(steps).toHaveAttribute('aria-expanded', 'false')
  expect(results.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await userEvent.setup().click(screen.getByText(/步骤列表/))
  expect(steps).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('link', { name: '翻译' })).toHaveAttribute('href', '/tasks/original/nodes/translate')
})

it('previews subtitle cues in a dialog instead of opening the raw file', async () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,500\n你好\n\n2\n00:00:03,000 --> 00:00:04,000\n再见\n'
  const request = vi.fn(async (path: string) => path.endsWith('/files/subtitle') ? srt : { ...task, outputs: [{ id: 'subtitle', label: '中文字幕', mimeType: 'application/x-subrip', size: 2048, url: '/subtitle.srt' }] })
  mount(request)
  await userEvent.setup().click(await screen.findByRole('button', { name: '预览文本' }))
  const dialog = await screen.findByRole('dialog', { name: '中文字幕' })
  expect(await screen.findByText('你好')).toBeVisible()
  expect(screen.getByText('00:00:01,000 → 00:00:02,500')).toBeVisible()
  expect(dialog.querySelector('a[download]')).toHaveAttribute('href', '/subtitle.srt')
  expect(request.mock.calls.some(([path]) => path === '/api/tasks/original/files/subtitle')).toBe(true)
})

it('keeps ordinary text complete even when it contains arrows and subtitle timestamps', async () => {
  const content = '说明\n需要保留的开头\n\nA --> B\n执行步骤\n\n00:00:01,000 --> 00:00:02,500\n时间示例\n\n结论\n需要保留的结尾'
  const request = vi.fn(async (path: string) => path.endsWith('/files/text') ? content : { ...task, outputs: [{ id: 'text', name: 'notes.txt', mimeType: 'text/plain', url: '/notes.txt' }] })
  mount(request)
  await userEvent.setup().click(await screen.findByRole('button', { name: '预览文本' }))
  const dialog = await screen.findByRole('dialog', { name: 'notes.txt' })
  await waitFor(() => expect(dialog.querySelector('pre')?.textContent).toBe(content))
})

it('retains unrecognized subtitle blocks alongside formatted cues', async () => {
  const content = '说明\n需要保留的开头\n\n1\n00:00:01,000 --> 00:00:02,500\n你好\n\n2\n损坏的时间轴\n这段文字不能消失'
  const request = vi.fn(async (path: string) => path.endsWith('/files/subtitle') ? content : { ...task, outputs: [{ id: 'subtitle', name: 'subtitles.srt', mimeType: 'text/plain', url: '/subtitles.srt' }] })
  mount(request)
  await userEvent.setup().click(await screen.findByRole('button', { name: '预览文本' }))
  const dialog = await screen.findByRole('dialog', { name: 'subtitles.srt' })
  expect(await screen.findByText('00:00:01,000 → 00:00:02,500')).toBeVisible()
  expect(dialog).toHaveTextContent('需要保留的开头')
  expect(dialog).toHaveTextContent('损坏的时间轴')
  expect(dialog).toHaveTextContent('这段文字不能消失')
})

it('uses one unified status bar without duplicate filter controls for primary statuses', async () => {
  const request = vi.fn(async () => ({ items: [], hasMore: false, limit: 20, offset: 0 }))
  mount(request, 'library')
  await screen.findByText('还没有任务')

  const user = userEvent.setup()
  const finishedBtn = screen.getByRole('button', { name: '已完成' })
  expect(finishedBtn).toHaveAttribute('aria-pressed', 'false')

  await user.click(finishedBtn)
  expect(finishedBtn).toHaveAttribute('aria-pressed', 'true')
  expect(request).toHaveBeenCalledWith('/api/tasks?limit=20&offset=0&status=succeeded', expect.anything())

  await user.click(screen.getByLabelText('任务状态'))
  expect(screen.queryByRole('menuitem', { name: '已完成' })).not.toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: '排队中' })).toBeInTheDocument()
})
