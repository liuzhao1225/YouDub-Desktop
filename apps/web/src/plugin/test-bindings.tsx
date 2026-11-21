import { type ComponentType, type ReactNode } from 'react'
import { createFeatures, FeatureProvider, NavigationContext, useFeatures } from '@/runtime/features'
import type { ClientBindings, Request } from './sdk'

export type TestContext = {
  apiClient: { request: Request }
  navigation?: { push(path: string): void; block?(handler: (path: string) => Promise<boolean>): () => void }
  slots?: { list?(slot: string): any[]; subscribe?(listener: () => void): () => void; getSnapshot?(): number }
}

const hosts = new WeakMap<TestContext, ReturnType<typeof createTestHost>>()

export function createTestHost(context: TestContext) {
  const navigate = (path: string) => context.navigation?.push(path)
  const slots = (name: string) => context.slots?.list?.(name.replace(/^youdub\./, '')) ?? []
  const features = createFeatures(
    navigate,
    context.navigation?.block ?? (() => () => {}),
    context.apiClient.request,
    {
      list: (slot) => slots(slot),
      subscribe: context.slots?.subscribe,
      getSnapshot: context.slots?.getSnapshot,
    },
  )
  return {
    value: {
      ...features,
      renderSlot(name: string, props: object, options: { only: string }) {
        const entry = slots(name).find((item) => item.id === options.only)
        if (!entry) throw new Error(`Missing fixture slot ${name}: ${options.only}`)
        const Component = entry.component
        return <Component {...props} />
      },
    },
  }
}

export function testHost(context: TestContext) {
  let host = hosts.get(context)
  if (!host) { host = createTestHost(context); hosts.set(context, host) }
  return host
}

export function TestFeatureProvider({ context, children }: { context: TestContext; children: ReactNode }) {
  const { value } = testHost(context)
  return (
    <NavigationContext.Provider value={value.navigate}>
      <FeatureProvider value={value}>{children}</FeatureProvider>
    </NavigationContext.Provider>
  )
}

export function bindTestComponent<P extends object, K extends keyof ClientBindings>(Component: ComponentType<P>, keys: readonly K[]) {
  return function TestComponent(props: Omit<P, K>) {
    const features = useFeatures()
    return <Component {...props as P} {...Object.fromEntries(keys.map(key => [key, features[key]]))} />
  }
}
