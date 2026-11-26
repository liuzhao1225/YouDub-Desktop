import { createContext, useContext, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import type { ClientBindings, SlotMap, UseQuery } from '@/plugin/sdk'
import type { Request as ApiRequest } from '@/plugin/runtime/types'
import type { WorkflowDocument } from '@/plugin/contracts'
import { QueryClient, QueryResource } from '@/plugin/runtime/query'
import { WorkflowResourceChecks, changesResources } from '@/plugin/runtime/workflow-resources'
import { StudioDraftStore } from '@/runtime/studio-draft'
import { EventStreamClient } from '@/lib/api'

export type NavigateFn = (path: string) => void
export const NavigationContext = createContext<NavigateFn>(() => {})

export function Link({ href, onClick, target, rel, ...rest }: { href: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const navigate = useContext(NavigationContext)
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event)
    if (event.defaultPrevented || target === '_blank' || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    if (/^(?:https?:|mailto:|tel:)/i.test(href)) return
    event.preventDefault()
    navigate(href)
  }
  return <a href={href} target={target} rel={rel} onClick={handleClick} {...rest} />
}

export type SlotRegistry = {
  list<K extends keyof SlotMap>(slot: K): SlotMap[K][]
  subscribe?(listener: () => void): () => void
  getSnapshot?(): number
}

export function createFeatures(
  navigate: NavigateFn,
  blockNavigation: (handler: (path: string) => Promise<boolean>) => () => void,
  rawRequest: ApiRequest,
  slots: SlotRegistry = { list: () => [] },
  events?: EventStreamClient,
): ClientBindings {
  const queries = new Map<string, QueryResource<unknown>>()
  const resourceChecks = new WorkflowResourceChecks(rawRequest, () => {
    window.dispatchEvent(new CustomEvent('youdub:resources-ready'))
  })

  const refreshQueries = (predicate: (path: string) => boolean) => {
    for (const [path, resource] of queries.entries()) {
      if (predicate(path)) resource.refresh()
    }
  }

  const request: ApiRequest = async <T,>(path: string, init?: RequestInit) => {
    const result = await rawRequest<T>(path, init)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') {
      if (changesResources(path, method, init?.body)) resourceChecks.invalidate()
      if (path.startsWith('/api/llm/') || path.startsWith('/api/image/') || path.startsWith('/api/settings') || path.startsWith('/api/resources')) {
        refreshQueries((p) => p.startsWith('/api/node-types') || p.startsWith('/api/resources') || p.startsWith('/api/settings') || p.startsWith('/api/llm/') || p.startsWith('/api/image/'))
      }
      if (path === '/api/settings' && method === 'PATCH') {
        refreshQueries((p) => p.startsWith('/api/tasks') || p === 'workflow-documents')
      }
      if (path.startsWith('/api/tasks')) {
        refreshQueries((p) => p.startsWith('/api/tasks'))
      }
      if (path.startsWith('/api/workflow-documents')) {
        refreshQueries((p) => p.startsWith('/api/workflow-documents'))
      }
    }
    return result
  }

  const wrappedClient = new QueryClient(request)

  if (events) {
    events.on('task.updated', ({ taskId }: { taskId?: string }) => {
      refreshQueries((p) => p.startsWith('/api/tasks?') || (!!taskId && p.startsWith(`/api/tasks/${encodeURIComponent(taskId)}`)))
    })
    events.on('task.deleted', () => refreshQueries((p) => p.startsWith('/api/tasks')))
    events.on('resources.updated', () => {
      resourceChecks.invalidate()
      refreshQueries((p) => p.startsWith('/api/resources') || p.startsWith('/api/node-types'))
    })
    events.on('providers.updated', () => {
      resourceChecks.invalidate()
      refreshQueries((p) => p.startsWith('/api/llm/') || p.startsWith('/api/image/') || p.startsWith('/api/node-types'))
    })
    events.on('settings.updated', () => {
      resourceChecks.invalidate()
      refreshQueries((p) => p.startsWith('/api/settings'))
    })
  }

  const getQuery = <T,>(path: string, pollMs?: number, shouldPoll?: (value: T) => boolean): QueryResource<T> => {
    let resource = queries.get(path) as QueryResource<T> | undefined
    if (!resource) {
      resource = path === 'workflow-documents'
        ? (wrappedClient.workflowDocuments() as unknown as QueryResource<T>)
        : wrappedClient.query<T>(path, pollMs, shouldPoll)
      queries.set(path, resource as QueryResource<unknown>)
    }
    return resource
  }

  const useQuery: UseQuery = <T,>(path: string, pollMs?: number, shouldPoll?: (value: T) => boolean) => {
    const resource = getQuery<T>(path, pollMs, shouldPoll)
    const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot)
    return { ...snapshot, refresh: resource.refresh }
  }

  const useWorkflowDocuments = () => {
    const resource = getQuery<any>('workflow-documents')
    const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot)
    return { ...snapshot, refresh: resource.refresh }
  }

  const useWorkflowResources = (document: WorkflowDocument) => {
    const controller = resourceChecks.get(document)
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
    const ready = snapshot.result?.status === 'ready'
    return {
      ...snapshot,
      ready,
      prepare: controller.prepare,
      check: controller.check,
      action: controller.action,
    }
  }

  const useSlot = <K extends keyof SlotMap>(slot: K): SlotMap[K][] => {
    useSyncExternalStore(
      slots.subscribe ?? (() => () => {}),
      slots.getSnapshot ?? (() => 0),
      slots.getSnapshot ?? (() => 0),
    )
    return slots.list(slot)
  }

  return {
    request,
    navigate,
    blockNavigation,
    useQuery,
    useWorkflowDocuments,
    useWorkflowResources,
    useSlot,
    draftStore: new StudioDraftStore(),
    submissionStore: new StudioDraftStore(),
    events,
  }
}

const FeatureContext = createContext<ClientBindings | null>(null)

export function FeatureProvider({ value, children }: { value: ClientBindings; children: ReactNode }) {
  return <FeatureContext.Provider value={value}>{children}</FeatureContext.Provider>
}

export function useFeatures(): ClientBindings {
  const ctx = useContext(FeatureContext)
  if (!ctx) throw new Error('useFeatures must be used inside FeatureProvider')
  return ctx
}

export function useEvents(): EventStreamClient | undefined {
  return useContext(FeatureContext)?.events
}
