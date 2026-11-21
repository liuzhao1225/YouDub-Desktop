import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TestFeatureProvider, bindTestComponent, type TestContext } from './test-bindings'
import type { Bindings } from './sdk'
import { createApiRequest } from '@/lib/api'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('keeps a slower runtime request alive when a concurrent query resolves through the API transport', async () => {
  const requests: Array<{ path: string; signal: AbortSignal; resolve(response: Response): void }> = []
  vi.stubGlobal('fetch', vi.fn((path: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init.signal as AbortSignal
    requests.push({ path, signal, resolve })
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })))
  const context: TestContext = { apiClient: { request: createApiRequest() } }
  function EditorQueries({ useQuery }: Bindings<'useQuery'>) {
    const runtime = useQuery<{ ready: boolean }>('/api/runtime')
    const nodeTypes = useQuery<{ ready: boolean }>('/api/node-types')
    return <><p data-testid="runtime">{runtime.data?.ready ? 'ready' : runtime.error || 'loading'}</p><p data-testid="node-types">{nodeTypes.data?.ready ? 'ready' : nodeTypes.error || 'loading'}</p></>
  }
  const BoundEditor = bindTestComponent(EditorQueries, ['useQuery'])
  render(<TestFeatureProvider context={context}><BoundEditor /></TestFeatureProvider>)
  await waitFor(() => expect(requests).toHaveLength(2))
  const runtime = requests.find((request) => request.path === '/api/runtime')!
  const nodeTypes = requests.find((request) => request.path === '/api/node-types')!
  nodeTypes.resolve(Response.json({ ready: true }))
  await waitFor(() => expect(screen.getByTestId('node-types')).toHaveTextContent('ready'))
  expect(runtime.signal.aborted).toBe(false)
  expect(requests).toHaveLength(2)
  runtime.resolve(Response.json({ ready: true }))
  await waitFor(() => expect(screen.getByTestId('runtime')).toHaveTextContent('ready'))
  expect(requests).toHaveLength(2)
})
it('does not show a previous query result or error after the query path changes', async () => {
  const request = vi.fn(async (path: string) => {
    if (path === '/first') return { name: 'first task' }
    throw new Error('Second filter failed')
  })
  const context = { apiClient: { request } } as unknown as TestContext
  function Viewer({ path, useQuery }: { path: string } & Bindings<'useQuery'>) {
    const { data, error } = useQuery<{ name: string }>(path)
    return <p>{data?.name || error || 'loading'}</p>
  }
  const BoundViewer = bindTestComponent(Viewer, ['useQuery'])
  const view = render(<TestFeatureProvider context={context}><BoundViewer path="/first" /></TestFeatureProvider>)
  await screen.findByText('first task')
  view.rerender(<TestFeatureProvider context={context}><BoundViewer path="/second" /></TestFeatureProvider>)
  expect(screen.queryByText('first task')).not.toBeInTheDocument()
  await screen.findByText('Second filter failed')
})
