import { createStore } from '@/lib/store'
import type { Request } from './types'
import type { WorkflowDocument } from '../contracts'
import type { ResourceInventory, ResourcePreparation, ResourceSelection, SetupAction, ResourceEntry } from '@/runtime/setup-contracts'

export type ResourceState = {
  entries?: ResourceEntry[]
  status: string; error?: string | { message?: string }
  requirements?: { resourceId?: string; providerId: string; model?: string; ready: boolean; automatic: boolean; reason?: string; configurationRequired?: boolean }[]
  environment?: { id: string; name: string; status: string; detail?: string }[]
  models?: { id: string; name: string; status: string; error?: string; received?: number; total?: number; speed?: number }[]
  activePreparation?: { status: string; error?: string }
}
type ResourceSnapshot = { result?: ResourceState; inventory?: ResourceInventory; inspection?: ResourcePreparation; error?: string; checking: boolean }
export type WorkflowResourcesResult = ResourceSnapshot & { ready: boolean; prepare(): void; check(): void; action(action: SetupAction, id?: string): void }

function coverSourceNeedsFfmpeg(document: WorkflowDocument, nodeId: string): boolean {
  const edge = (document.edges ?? []).find((item) => item.target.nodeId === nodeId && item.target.portId === 'cover')
  if (!edge) return false
  if (edge.source.nodeId === '$inputs') {
    const schema = document.inputs?.find((inp) => inp.id === edge.source.portId)?.schemaId ?? ''
    return !schema.startsWith('image/')
  }
  const sourceNode = document.nodes.find((item) => item.id === edge.source.nodeId)
  return sourceNode?.type !== 'youdub.download' && edge.source.portId !== 'cover'
}
export function resourceKey(document: WorkflowDocument) {
  return JSON.stringify([...new Set(document.nodes.map(node => JSON.stringify([node.type, node.typeVersion, node.provider.id, node.provider.model ?? null, node.type === 'youdub.align' ? String(node.config.targetLanguage ?? 'zh') : node.type === 'youdub.translateCover' ? (coverSourceNeedsFfmpeg(document, node.id) ? 'ffmpeg' : 'image') : null])))].sort())
}
export function changesResources(path: string, method: string, body?: BodyInit | null) {
  if (path === '/api/settings' && method === 'PATCH') {
    if (typeof body !== 'string') return true
    const patch = JSON.parse(body) as Record<string, unknown>
    return Object.keys(patch).some(key => key !== 'ui_language' && key !== 'theme')
  }
  return method === 'POST' && /^\/api\/(?:resources\/(?:prepare|action|yt-dlp\/update)|workflow-documents\/resources\/prepare)$/.test(path)
    || ((path.startsWith('/api/llm/') || path.startsWith('/api/image/')) && ['PUT', 'DELETE'].includes(method))
}

/** One API session owns a check for each distinct provider/model requirement set. */
export class WorkflowResourceChecks {
  private entries = new Map<string, ResourcesController>()
  private invalidationQueued = false
  constructor(private request: Request, private onReady: () => void) {}
  get(document: WorkflowDocument) {
    const key = resourceKey(document)
    let resource = this.entries.get(key)
    if (!resource) { resource = new ResourcesController(this.request, document, this.onReady); this.entries.set(key, resource) }
    resource.setDocument(document)
    return resource
  }
  invalidate = () => {
    if (this.invalidationQueued) return
    this.invalidationQueued = true
    queueMicrotask(() => { this.invalidationQueued = false; for (const resource of this.entries.values()) resource.invalidate() })
  }
  clear = () => { for (const resource of this.entries.values()) resource.dispose(); this.entries.clear() }
}

/** Polling belongs to the view; preparation itself continues in SetupService after navigation. */
export class ResourcesController {
  private readonly state = createStore<ResourceSnapshot>(() => ({ checking: true }))
  private controller?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private subscribers = 0
  private stale = true
  constructor(private readonly request: Request, private document?: WorkflowDocument, private readonly onReady: () => void = () => {}) {}
  getSnapshot = () => this.state.getState()
  setDocument(document: WorkflowDocument) { this.document = document }
  subscribe = (listener: () => void) => {
    const unsubscribe = this.state.subscribe(listener)
    if (++this.subscribers === 1 && (this.stale || this.preparing() && !this.state.getState().error)) this.check()
    return () => { unsubscribe(); if (--this.subscribers === 0) this.stop() }
  }
  private preparing() { const snapshot = this.state.getState(); return snapshot.result?.status === 'preparing' || snapshot.result?.activePreparation?.status === 'preparing' || snapshot.inventory?.resources?.status === 'preparing' }
  private stop() {
    if (this.state.getState().checking) this.stale = true
    this.controller?.abort(); if (this.timer) clearTimeout(this.timer); this.timer = undefined
    this.state.setState({ checking: false })
  }
  dispose = () => { this.stop(); this.stale = true; this.state.setState({ checking: false }, true) }
  invalidate = () => { this.stale = true; if (this.subscribers && !this.state.getState().checking) this.check() }
  check = () => this.document ? this.run('check') : this.runInventory()
  prepare = (selections?: ResourceSelection[]) => this.document ? this.run('prepare') : this.runInventory({ action: 'prepare', selections })
  prepareResources = (resourceIds: string[]) => this.runInventory({ action: 'prepare', resourceIds })
  prepareResource = (id: string) => this.prepareResources([id])
  action = (action: SetupAction, id?: string) => this.document ? this.run('check', { action, id }) : this.runInventory({ action, id })
  private runInventory(operation?: { action: SetupAction | 'prepare'; id?: string; selections?: ResourceSelection[]; resourceIds?: string[] }) {
    this.stop()
    const controller = new AbortController()
    this.controller = controller
    this.stale = false
    this.state.setState({ checking: true, error: undefined })
    const current = () => this.controller === controller && !controller.signal.aborted
    const load = async (inspect: boolean) => {
      try {
        const previous = this.state.getState().inventory
        const inventory = await this.request<ResourceInventory>('/api/resources', { signal: controller.signal })
        if (!current()) return
        this.state.setState({ inventory })
        if (inspect || (previous?.resources?.status === 'preparing' && inventory.resources?.status !== 'preparing')) {
          const selections = inventory.items.map(({ providerId, model }) => ({ providerId, ...(model ? { model } : {}) }))
          const inspection = await this.request<ResourcePreparation>('/api/resources/check', { method: 'POST', body: JSON.stringify({ selections }), signal: controller.signal })
          if (!current()) return
          this.state.setState({ inspection, result: inspection })
        }
        this.state.setState({ checking: false })
        if (inventory.resources?.status === 'preparing') this.timer = setTimeout(() => void load(false), 1200)
        else if (this.stale && this.subscribers) this.check()
      } catch (failure) {
        if (current()) { this.stale = false; this.state.setState({ checking: false, inspection: undefined, result: undefined, error: failure instanceof Error ? failure.message : String(failure) }) }
      }
    }
    void (async () => {
      if (operation) {
        try {
          await this.request(`/api/resources/${operation.action === 'prepare' ? 'prepare' : 'action'}`, { method: 'POST',
            body: JSON.stringify(operation.action === 'prepare' ? { selections: operation.selections, resourceIds: operation.resourceIds } : { action: operation.action, resourceId: operation.id }), signal: controller.signal })
        } catch (failure) {
          if (current()) { this.stale = false; this.state.setState({ checking: false, error: failure instanceof Error ? failure.message : String(failure) }) }
          return
        }
        if (!current()) return
      }
      await load(true)
    })()
  }
  private run(action: 'check' | 'prepare', operation?: { action: SetupAction; id?: string }) {
    this.stop()
    const controller = new AbortController()
    this.controller = controller
    this.stale = false
    const load = async (nextAction: 'check' | 'prepare') => {
      this.state.setState({ checking: true, error: undefined })
      try {
        const result = await this.request<ResourceState>(`/api/workflow-documents/resources/${nextAction}`, { method: 'POST', body: JSON.stringify({ document: this.document }), signal: controller.signal })
        if (controller.signal.aborted) return
        const wasReady = this.state.getState().result?.status === 'ready'
        this.state.setState({ result, checking: false }, true)
        if (result.status === 'ready' && !wasReady) this.onReady()
        if (result.status === 'preparing' || result.activePreparation?.status === 'preparing') this.timer = setTimeout(() => void load('check'), 1200)
        else if (this.stale && this.subscribers) this.check()
      } catch (failure) {
        if (!controller.signal.aborted) { this.stale = false; this.state.setState({ checking: false, error: failure instanceof Error ? failure.message : String(failure) }) }
      }
    }
    if (!operation) void load(action)
    else {
      this.state.setState({ checking: true, error: undefined })
      void this.request('/api/resources/action', { method: 'POST', body: JSON.stringify(operation), signal: controller.signal })
        .then(() => { if (!controller.signal.aborted) return load('check') })
        .catch(failure => { if (!controller.signal.aborted) this.state.setState({ checking: false, error: failure instanceof Error ? failure.message : String(failure) }) })
    }
  }
}
