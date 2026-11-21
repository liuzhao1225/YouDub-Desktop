import { useCallback, useSyncExternalStore } from 'react'
import { getDesktopBridge, type DesktopUpdateState, type YoudubDesktopBridge } from '@/lib/desktop-bridge'
import type { useText } from '@/lib/i18n'

export interface UseDesktopUpdatesResult {
  supported: boolean
  version: string
  state: DesktopUpdateState | null
  checkForUpdates: () => Promise<void>
  quitAndInstall: () => Promise<void>
}

type Translator = ReturnType<typeof useText>

export function formatDesktopUpdateText(state: DesktopUpdateState | null, tx: Translator): string {
  switch (state?.status) {
    case 'checking':
      return tx('app.updates.checking')
    case 'downloading':
      if (!state.version) return tx('app.updates.downloading')
      return tx('app.updates.downloadingVersionPercent', {
        version: state.version,
        percent: state.percent ?? 0,
      })
    case 'downloaded':
      return state.version
        ? tx('app.updates.readyToInstallVersion', { version: state.version })
        : tx('app.updates.readyToInstall')
    case 'not-available':
      return tx('app.updates.upToDate')
    case 'unsupported':
      if (state.reason === 'unpackaged') return tx('app.updates.unsupportedUnpackaged')
      if (state.reason === 'windows-portable') return tx('app.updates.unsupportedPortable')
      return tx('app.updates.unsupportedPlatform')
    case 'error':
      return state.error || tx('settings.general.updatesHint')
    default:
      return tx('settings.general.updatesHint')
  }
}

let storeBridge: YoudubDesktopBridge | undefined
let storeState: DesktopUpdateState | null = null
let storeVersion = 0
let storeUnsubscribe: (() => void) | undefined
const listeners = new Set<() => void>()

function setStoreState(next: DesktopUpdateState | null): void {
  storeVersion += 1
  storeState = next
  for (const listener of listeners) listener()
}

function teardownStore(): void {
  storeUnsubscribe?.()
  storeUnsubscribe = undefined
  storeBridge = undefined
  storeState = null
  storeVersion += 1
}

function attachBridge(bridge: YoudubDesktopBridge): void {
  if (storeBridge === bridge) return
  teardownStore()
  storeBridge = bridge
  const attachVersion = storeVersion
  storeUnsubscribe = bridge.onUpdateState((next) => {
    if (storeBridge === bridge) setStoreState(next)
  })
  void bridge
    .getUpdateState()
    .then((initial) => {
      if (storeBridge === bridge && storeVersion === attachVersion && initial) {
        setStoreState(initial)
      }
    })
    .catch(() => {})
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const bridge = getDesktopBridge()
  if (bridge) attachBridge(bridge)
  else if (storeBridge) teardownStore()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) teardownStore()
  }
}

function getSnapshot(): DesktopUpdateState | null {
  const bridge = getDesktopBridge()
  if (!bridge || bridge !== storeBridge) return null
  return storeState
}

const getServerSnapshot = (): DesktopUpdateState | null => null

export function useDesktopUpdates(): UseDesktopUpdatesResult {
  const desktop = getDesktopBridge()
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const checkForUpdates = useCallback(async () => {
    const bridge = getDesktopBridge()
    if (!bridge) return
    attachBridge(bridge)
    const callVersion = storeVersion
    try {
      const next = await bridge.checkForUpdates()
      if (storeBridge === bridge && storeVersion === callVersion && next) {
        setStoreState(next)
      }
    } catch (error) {
      if (storeBridge === bridge && storeVersion === callVersion) {
        setStoreState({
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }, [])

  const quitAndInstall = useCallback(async () => {
    await getDesktopBridge()?.quitAndInstall()
  }, [])

  return {
    supported: Boolean(desktop),
    version: desktop?.version ?? '',
    state,
    checkForUpdates,
    quitAndInstall,
  }
}
