import { assetUrl } from './asset-url'
import { responseBody } from '@/runtime/http'
import type { Request as ApiRequest } from '@/plugin/runtime/types'

export type ServerEvent =
  | { type: 'task.updated'; payload: { taskId: string; status?: string } }
  | { type: 'task.deleted'; payload: { taskId: string } }
  | { type: 'task.log'; payload: { taskId: string; text: string } }
  | { type: 'resources.updated'; payload: Record<string, unknown> }
  | { type: 'settings.updated'; payload: Record<string, unknown> }
  | { type: 'providers.updated'; payload: Record<string, unknown> }

export function createApiRequest(): ApiRequest {
  return async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = typeof window !== 'undefined' ? window.youdubDesktop?.authToken : undefined
    const backendUrl = typeof window !== 'undefined' ? window.youdubDesktop?.backendUrl?.replace(/\/+$/, '') : undefined
    const base = backendUrl && path.startsWith('/api/')
      ? `${backendUrl}${path}`
      : path
    const headers = new Headers(init.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    const response = await fetch(base, { ...init, headers })
    return responseBody<T>(response)
  }
}

export class EventStreamClient {
  private source: EventSource | null = null
  private listeners = new Map<string, Set<(payload: any) => void>>()
  private logListeners = new Map<string, Set<(chunk: string) => void>>()

  start() {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined' || this.source) return
    const url = assetUrl('/api/events')
    const source = new EventSource(url)
    this.source = source

    const forward = (eventName: string) => {
      source.addEventListener(eventName, (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data)
          if (eventName === 'task.log' && data?.taskId && typeof data.text === 'string') {
            this.logListeners.get(data.taskId)?.forEach((fn) => fn(data.text))
          }
          this.listeners.get(eventName)?.forEach((fn) => fn(data))
          this.listeners.get('*')?.forEach((fn) => fn({ type: eventName, payload: data }))
        } catch { /* ignore malformed SSE payload */ }
      })
    }

    for (const evt of ['task.updated', 'task.deleted', 'task.log', 'resources.updated', 'settings.updated', 'providers.updated']) {
      forward(evt)
    }
  }

  stop() {
    this.source?.close()
    this.source = null
  }

  on(eventType: string, listener: (payload: any) => void): () => void {
    const set = this.listeners.get(eventType) ?? new Set()
    set.add(listener)
    this.listeners.set(eventType, set)
    return () => { set.delete(listener) }
  }

  onTaskLog(taskId: string, listener: (chunk: string) => void): () => void {
    const set = this.logListeners.get(taskId) ?? new Set()
    set.add(listener)
    this.logListeners.set(taskId, set)
    return () => { set.delete(listener) }
  }
}
