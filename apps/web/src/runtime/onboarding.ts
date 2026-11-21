import type { ResourceSelection, SetupAction, SetupState } from '@/runtime/setup-contracts'
import { createStore, type StoreApi } from '@/lib/store'
import type { Request } from '@/plugin/runtime/types'

class SnapshotStore<T extends object> {
  private readonly store: StoreApi<T>
  constructor(initial: T) { this.store = createStore<T>(() => initial) }
  protected get snapshot() { return this.store.getState() }
  getSnapshot = () => this.store.getState()
  subscribe = (listener: () => void) => this.store.subscribe(listener)
  protected update(patch: Partial<T>) { this.store.setState(patch) }
}

interface SetupSnapshot { state: SetupState | null; error: string; busy: boolean }

/** Owns setup requests and polling for the mounted preparation gate. */
export class SetupController extends SnapshotStore<SetupSnapshot> {
  private controller: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private mutationRevision = 0
  constructor(private readonly api: Request) { super({ state: null, error: '', busy: false }) }
  start = () => {
    this.stop()
    this.controller = new AbortController()
    this.update({ error: '', busy: false })
    void this.poll(this.controller)
  }
  stop = () => {
    this.controller?.abort()
    this.controller = null
    clearTimeout(this.timer)
  }
  private current(controller: AbortController) { return this.controller === controller && !controller.signal.aborted }
  private async request(controller: AbortController, init?: RequestInit): Promise<SetupState> {
    return this.api<SetupState>('/api/setup', { ...init, signal: controller.signal })
  }
  private async poll(controller: AbortController) {
    const revision = this.mutationRevision
    try {
      const state = await this.request(controller)
      if (!this.current(controller)) return
      // A read started before an applied action cannot restore its old state.
      if (revision === this.mutationRevision && !this.snapshot.busy) this.update({ state })
      if (this.snapshot.state?.phase !== 'ready' && !this.snapshot.error) this.timer = setTimeout(() => void this.poll(controller), 800)
    } catch (failure) {
      if (this.current(controller)) this.update({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }
  action = (action: SetupAction, id?: string) => this.mutate({ action, id })
  configure = (path: string) => this.mutate({ action: 'configure', path })
  prepare = (selections: ResourceSelection[]) => this.mutate({ action: 'prepare', selections })
  private async mutate(body: { action: SetupAction; id?: string } | { action: 'prepare'; selections: ResourceSelection[] } | { action: 'configure'; path: string }) {
    const { state, busy } = this.snapshot
    const controller = this.controller
    if (!state || busy || !controller) return
    this.update({ busy: true })
    try {
      const next = await this.request(controller, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (this.current(controller)) { this.mutationRevision++; this.update({ state: next }) }
    } catch (failure) {
      if (this.current(controller)) {
        // Directory submission errors belong to the form that can correct them.
        if (body.action === 'configure') throw failure
        clearTimeout(this.timer)
        this.update({ error: failure instanceof Error ? failure.message : String(failure) })
      }
    } finally {
      if (this.current(controller)) this.update({ busy: false })
    }
  }
}
