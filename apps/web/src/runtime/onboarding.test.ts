import { afterEach, expect, it, vi } from 'vitest'
import { SetupController } from './onboarding'

const setup = { phase: 'models', platform: 'darwin', arch: 'arm64', canRetry: true, environment: [], models: [] }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('stops setup polling at readiness and aborts owned requests on disposal', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn().mockResolvedValueOnce(setup).mockResolvedValue({ ...setup, phase: 'ready' })
  const controller = new SetupController(fetch as never)
  controller.start()
  await vi.advanceTimersByTimeAsync(800)
  expect(controller.getSnapshot().state?.phase).toBe('ready')
  expect(fetch).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(2400)
  expect(fetch).toHaveBeenCalledTimes(2)
  controller.stop()
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
})

it('does not let an abandoned setup request overwrite a reconnected session', async () => {
  let finish!: (value: unknown) => void
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue({ ...setup, phase: 'ready' })
  const controller = new SetupController(fetch as never)
  controller.start()
  controller.start()
  await vi.waitFor(() => expect(controller.getSnapshot().state?.phase).toBe('ready'))
  finish({ ...setup, phase: 'failed' })
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(controller.getSnapshot().state?.phase).toBe('ready')
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
  controller.stop()
})

it('keeps setup failures visible until an explicit reconnect', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn().mockRejectedValueOnce(new Error('service offline')).mockResolvedValue({ ...setup, phase: 'ready' })
  const controller = new SetupController(fetch as never)
  controller.start()
  await vi.advanceTimersByTimeAsync(3000)
  expect(controller.getSnapshot().error).toBe('service offline')
  expect(fetch).toHaveBeenCalledTimes(1)
  controller.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.getSnapshot()).toMatchObject({ error: '', state: { phase: 'ready' } })
  controller.stop()
})

it('does not restore a stale model selection after preparing the selected models', async () => {
  vi.useFakeTimers()
  const choosing = { ...setup, resourceSelection: { required: true, selections: [{ providerId: 'whisper', model: 'tiny' }], items: [], prepared: false } }
  const preparing = { ...choosing, resourceSelection: { ...choosing.resourceSelection, required: false } }
  let finishPoll!: (state: unknown) => void
  const request = vi.fn().mockResolvedValueOnce(choosing)
    .mockImplementationOnce(() => new Promise(resolve => { finishPoll = resolve }))
    .mockResolvedValueOnce(preparing)
    .mockResolvedValue({ ...preparing, phase: 'ready' })
  const controller = new SetupController(request as never)
  controller.start()
  await vi.advanceTimersByTimeAsync(800)
  await controller.prepare(choosing.resourceSelection.selections)
  expect(controller.getSnapshot().state?.resourceSelection?.required).toBe(false)
  finishPoll(choosing)
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.getSnapshot().state?.resourceSelection?.required).toBe(false)
  await vi.advanceTimersByTimeAsync(800)
  expect(controller.getSnapshot().state?.phase).toBe('ready')
  await vi.advanceTimersByTimeAsync(1600)
  expect(request).toHaveBeenCalledTimes(4)
  controller.stop()
})
