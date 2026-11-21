import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '@/test/language-provider'
import { createMockDesktopBridge } from '@/test/desktop-bridge'
import { EventStreamClient } from '@/lib/api'
import { createFeatures, FeatureProvider } from '@/runtime/features'
import { TaskLog } from './task-log'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  delete window.youdubDesktop
  vi.restoreAllMocks()
})

it('loads tail logs, expands full logs, copies full logs, and tokenizes download links', async () => {
  window.youdubDesktop = createMockDesktopBridge({ authToken: 'secret-token' })

  const tailLines = Array.from({ length: 200 }, (_, i) => `line-${i + 1}`).join('\n')
  const fullContent = `earlier-line\n${tailLines}`
  const request = vi.fn(async (path: string) => {
    if (path === '/api/tasks/task-1/log?lines=200') return tailLines
    if (path === '/api/tasks/task-1/log?full=true') return fullContent
    throw new Error(`Unexpected path: ${path}`)
  })

  render(
    <LanguageProvider>
      <TaskLog taskId="task-1" active={false} request={request as never} />
    </LanguageProvider>,
  )

  expect(await screen.findByText('仅显示最后 200 行')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '下载日志' })).toHaveAttribute(
    'href',
    'http://127.0.0.1:8765/api/tasks/task-1/log?download=true&token=secret-token',
  )

  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText')
  await user.click(screen.getByRole('button', { name: '复制完整日志' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(fullContent))
  expect(await screen.findByRole('button', { name: '已复制' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: '加载完整日志' }))
  await waitFor(() => expect(screen.queryByText('仅显示最后 200 行')).not.toBeInTheDocument())
  expect(screen.getByText(/earlier-line/)).toBeInTheDocument()
})

it('shows load failures with reload recovery', async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error('Log file temporarily locked'))
    .mockResolvedValueOnce('recovered log line')

  render(
    <LanguageProvider>
      <TaskLog taskId="task-2" active={false} request={request as never} />
    </LanguageProvider>,
  )

  expect(await screen.findByRole('alert')).toHaveTextContent('Log file temporarily locked')
  await userEvent.setup().click(screen.getByRole('button', { name: '重新加载日志' }))
  expect(await screen.findByText('recovered log line')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('appends live SSE log chunks from EventStreamClient prop and FeatureProvider context', async () => {
  const listeners = new Map<string, Set<(chunk: string) => void>>()
  const mockEvents = {
    on: () => () => {},
    onTaskLog: (taskId: string, listener: (chunk: string) => void) => {
      const set = listeners.get(taskId) ?? new Set()
      set.add(listener)
      listeners.set(taskId, set)
      return () => set.delete(listener)
    },
  } as unknown as EventStreamClient

  const request = vi.fn(async () => 'initial output\n')
  const features = createFeatures(() => {}, () => () => {}, request as never, undefined, mockEvents)

  const view = render(
    <FeatureProvider value={features}>
      <LanguageProvider>
        <TaskLog taskId="task-live" active request={request as never} />
      </LanguageProvider>
    </FeatureProvider>,
  )

  expect(await screen.findByText(/initial output/)).toBeInTheDocument()

  act(() => {
    listeners.get('task-live')?.forEach((fn) => fn('streamed step 1\n'))
    listeners.get('other-task')?.forEach((fn) => fn('ignored line\n'))
  })

  expect(screen.getByText(/streamed step 1/)).toBeInTheDocument()
  expect(screen.queryByText(/ignored line/)).not.toBeInTheDocument()

  const propListeners = new Set<(chunk: string) => void>()
  const propEvents = {
    on: () => () => {},
    onTaskLog: (_id: string, fn: (chunk: string) => void) => {
      propListeners.add(fn)
      return () => propListeners.delete(fn)
    },
  } as unknown as EventStreamClient

  view.rerender(
    <LanguageProvider>
      <TaskLog taskId="task-live" active request={request as never} events={propEvents} />
    </LanguageProvider>,
  )

  act(() => {
    propListeners.forEach((fn) => fn('prop chunk\n'))
  })
  expect(screen.getByText(/prop chunk/)).toBeInTheDocument()
})
