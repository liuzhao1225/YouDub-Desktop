export type ResourceStatus = 'pending' | 'checking' | 'preparing' | 'paused' | 'ready' | 'failed' | 'blocked'
export type ResourcePhase = 'downloading' | 'installing' | 'verifying'
export type ResourceAction = 'prepare' | 'pause' | 'resume' | 'retry'

export interface ResourceEntry {
  id: string
  downloadId?: string
  name: string
  variant?: string
  group: 'environment' | 'model'
  status: ResourceStatus
  phase?: ResourcePhase
  actions: ResourceAction[]
  dependencies: string[]
  detail?: string
  error?: string
  source?: string
  progress?: { received: number; total: number; speed?: number }
}

type ResourceEntriesInput = {
  status?: string
  error?: string
  environment?: Array<{
    id: string; name: string; status: string; detail?: string; error?: string; source?: string
    phase?: ResourcePhase; progress?: { received: number; total: number; speed?: number }
  }>
  models?: Array<{
    id: string; name: string; variant?: string; status: string; received?: number; total?: number; speed?: number
    source?: string; error?: string
  }>
  requirements?: Array<{
    providerId: string; resourceId?: string; name?: string; downloadId?: string
    automatic?: boolean; ready?: boolean; dependencies?: string[]
  }>
}

function mapEnvStatus(status: string): ResourceStatus {
  if (status === 'running') return 'preparing'
  if (status === 'ready' || status === 'failed' || status === 'pending' || status === 'blocked') return status
  return 'pending'
}

export function resourceEntries(input: ResourceEntriesInput): ResourceEntry[] {
  const entries: ResourceEntry[] = []
  for (const step of input.environment ?? []) {
    const status = mapEnvStatus(step.status)
    entries.push({
      id: step.id,
      name: step.name,
      group: 'environment',
      status,
      phase: step.phase,
      actions: status === 'pending' ? ['prepare'] : status === 'failed' ? ['retry'] : [],
      dependencies: [],
      detail: step.detail,
      error: step.error,
      source: step.source,
      progress: step.progress,
    })
  }

  const reqByModelId = new Map<string, NonNullable<ResourceEntriesInput['requirements']>[number]>()
  for (const req of input.requirements ?? []) {
    const key = req.downloadId ?? req.resourceId ?? req.providerId
    reqByModelId.set(key, req)
  }

  const seenModels = new Set<string>()
  for (const model of input.models ?? []) {
    seenModels.add(model.id)
    const req = reqByModelId.get(model.id)
    const envBlocked = (req?.dependencies ?? []).length > 0 && input.environment?.some((e) => req!.dependencies!.includes(e.id) && e.status !== 'ready')
    let status: ResourceStatus
    let phase: ResourcePhase | undefined
    let actions: ResourceAction[] = []
    if (model.status === 'downloading') {
      status = 'preparing'
      phase = 'downloading'
      actions = ['pause']
    } else if (model.status === 'paused') {
      status = 'paused'
      phase = 'downloading'
      actions = ['resume']
    } else if (model.status === 'failed') {
      status = 'failed'
      actions = ['retry']
    } else if (model.status === 'ready' && input.status !== 'models') {
      status = 'ready'
    } else if (envBlocked) {
      status = 'blocked'
    } else {
      status = 'pending'
      actions = ['prepare']
    }
    entries.push({
      id: model.id,
      downloadId: req?.downloadId ?? model.id,
      name: model.name,
      variant: model.variant,
      group: 'model',
      status,
      phase,
      actions,
      dependencies: req?.dependencies ?? [],
      source: model.source,
      error: model.error,
      progress: (model.total ?? 0) > 0 || (model.received ?? 0) > 0 ? { received: model.received ?? 0, total: model.total ?? 0, speed: model.speed } : undefined,
    })
  }
  return entries
}

export function mergeResourceEntries(inspected: ResourceEntry[], live?: ResourceEntry[]): ResourceEntry[] {
  if (!live?.length) return inspected
  if (!inspected.length) return live
  const byId = new Map(live.map((entry) => [entry.id, entry]))
  const merged = inspected.map((entry) => byId.get(entry.id) ?? entry)
  for (const entry of live) {
    if (!inspected.some((item) => item.id === entry.id)) merged.push(entry)
  }
  return merged
}
