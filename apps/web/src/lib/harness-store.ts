import { createStore as createVanillaStore } from 'zustand/vanilla'
import { produce } from 'immer'

export type SnapshotSelectorHook<T> = {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
  set: (updater: T | ((draft: T) => T | void)) => void
}

export type SnapshotStore<T> = SnapshotSelectorHook<T>

/** Lightweight immer-backed snapshot store compatible with useSyncExternalStore. */
export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  const store = createVanillaStore<T>(() => initial)
  return {
    getSnapshot: () => store.getState(),
    subscribe: (listener) => store.subscribe(listener),
    set: (updater) => {
      if (typeof updater === 'function') {
        store.setState((current) => produce(current, updater as (draft: T) => T | void))
      } else {
        store.setState(updater, true)
      }
    },
  }
}
