import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveDesktopLocale } from './desktop-locale'
import {
  DesktopUpdateManager,
  hasWindowsSetupUninstaller,
  type DesktopUpdateState,
  type UpdaterLike,
} from './update-manager'
import { DesktopUpdateDialogCoordinator, type UpdateDialogOptions } from './update-ui'

const flushAsync = () => new Promise<void>((resolve) => setImmediate(resolve))

class FakeUpdater extends EventEmitter implements UpdaterLike {
  checkCalls = 0
  downloadCalls = 0
  quitAndInstallCalls: Array<{ isSilent?: boolean; isForceRunAfter?: boolean }> = []

  checkHandler: () => Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null> =
    async () => ({
      isUpdateAvailable: false,
      updateInfo: { version: '0.1.2' },
    })
  downloadHandler: () => Promise<unknown> = async () => {
    this.emit('download-progress', { percent: 12.4 })
    this.emit('download-progress', { percent: 12.4 })
    this.emit('download-progress', { percent: 87.6 })
    this.emit('update-downloaded', { version: '0.1.3' })
    return []
  }
  quitAndInstallHandler: (isSilent?: boolean, isForceRunAfter?: boolean) => void = () => {}

  checkForUpdates() {
    this.checkCalls += 1
    return this.checkHandler()
  }

  downloadUpdate(): Promise<unknown> {
    this.downloadCalls += 1
    return this.downloadHandler()
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.quitAndInstallCalls.push({ isSilent, isForceRunAfter })
    this.quitAndInstallHandler(isSilent, isForceRunAfter)
  }
}

function createHarness(overrides?: {
  isPackaged?: boolean
  currentVersion?: string
  platform?: NodeJS.Platform | string
  arch?: string
  isWindowsSetup?: () => boolean
  updater?: UpdaterLike | null
  visible?: boolean
  dialogResponse?: number
  showDialog?: (options: UpdateDialogOptions) => Promise<{ response: number }>
  beforeInstall?: () => Promise<boolean>
}) {
  const updater = overrides && 'updater' in overrides ? overrides.updater : new FakeUpdater()
  const states: DesktopUpdateState[] = []
  const dialogs: UpdateDialogOptions[] = []
  let visible = overrides?.visible ?? true
  let forcedExitCount = 0
  let openDownloadsCalls = 0

  let coordinator: DesktopUpdateDialogCoordinator
  const manager = new DesktopUpdateManager({
    isPackaged: overrides?.isPackaged ?? true,
    currentVersion: overrides?.currentVersion ?? '0.1.2',
    platform: overrides?.platform ?? 'darwin',
    arch: overrides?.arch ?? 'arm64',
    isWindowsSetup: overrides?.isWindowsSetup,
    updater: updater ?? null,
    emitState: (state) => {
      states.push(state)
    },
    beforeInstall: overrides?.beforeInstall ?? (async () => true),
    onReady: (version) => {
      void coordinator.promptReady(version)
    },
    onPostStopInstallError: (message) => {
      void coordinator.handlePostStopInstallError(message)
    },
  })

  coordinator = new DesktopUpdateDialogCoordinator({
    manager,
    getMessages: () => resolveDesktopLocale('zh').messages,
    showDialog: async (options) => {
      dialogs.push(options)
      if (overrides?.showDialog) return overrides.showDialog(options)
      return { response: overrides?.dialogResponse ?? 1 }
    },
    isWindowVisible: () => visible,
    openDownloadsPage: () => {
      openDownloadsCalls += 1
    },
    onPostStopDialogClosed: () => {
      forcedExitCount += 1
    },
  })

  return {
    updater: updater as FakeUpdater,
    manager,
    coordinator,
    states,
    dialogs,
    setVisible: (next: boolean) => {
      visible = next
    },
    getForcedExitCount: () => forcedExitCount,
    getOpenDownloadsCalls: () => openDownloadsCalls,
  }
}

test('DesktopUpdateManager completes check -> progress -> downloaded -> single ready prompt', async () => {
  const h = createHarness({ visible: true, dialogResponse: 1 })
  assert.deepEqual(h.manager.getState(), { status: 'idle' })

  let resolveDownload!: () => void
  h.updater.checkHandler = async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: '0.1.3' },
  })
  h.updater.downloadHandler = () =>
    new Promise((resolve) => {
      resolveDownload = () => {
        h.updater.emit('download-progress', { percent: 15.2 })
        h.updater.emit('download-progress', { percent: 15.4 })
        h.updater.emit('download-progress', { percent: 68.7 })
        h.updater.emit('update-downloaded', { version: '0.1.3' })
        resolve([])
      }
    })

  const checkResult = await h.manager.check(false)
  assert.deepEqual(checkResult, { status: 'downloading', version: '0.1.3', percent: 0 })

  resolveDownload()
  await flushAsync()

  assert.deepEqual(h.manager.getState(), { status: 'downloaded', version: '0.1.3' })
  assert.deepEqual(
    h.states.map((s) => `${s.status}:${s.percent ?? ''}`),
    ['checking:', 'downloading:0', 'downloading:15', 'downloading:69', 'downloaded:'],
  )
  assert.equal(h.dialogs.length, 1)
  assert.match(h.dialogs[0].message, /0\.1\.3/)
  assert.equal(h.updater.quitAndInstallCalls.length, 0)

  await h.coordinator.promptReady()
  assert.equal(h.dialogs.length, 1)
})

test('DesktopUpdateManager defers ready prompt while window is hidden and installs when shown & accepted', async () => {
  const h = createHarness({ visible: false, dialogResponse: 0 })
  h.updater.checkHandler = async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: '0.1.3' },
  })

  await h.manager.check(false)
  await flushAsync()
  assert.equal(h.manager.getState().status, 'downloaded')
  assert.equal(h.dialogs.length, 0)

  h.setVisible(true)
  await h.coordinator.promptReady()
  assert.equal(h.dialogs.length, 1)
  assert.equal(h.updater.quitAndInstallCalls.length, 1)
  assert.deepEqual(h.updater.quitAndInstallCalls[0], { isSilent: true, isForceRunAfter: true })
})

test('DesktopUpdateManager handles not-available, check errors, and download retry cleanly while logging errors once', async (t) => {
  const errorLog = t.mock.method(console, 'error', () => {})
  const h = createHarness()

  const none = await h.manager.check(false)
  assert.deepEqual(none, { status: 'not-available', version: '0.1.2' })

  // Lower remote version with isUpdateAvailable: false must not treat version mismatch as an update
  h.updater.checkHandler = async () => ({
    isUpdateAvailable: false,
    updateInfo: { version: '0.1.1' },
  })
  assert.deepEqual(await h.manager.check(false), { status: 'not-available', version: '0.1.2' })

  h.updater.checkHandler = async () => {
    const err = new Error('network down')
    h.updater.emit('error', err)
    throw err
  }
  const checkErr = await h.manager.check(false)
  assert.deepEqual(checkErr, { status: 'error', error: 'network down' })
  assert.equal(errorLog.mock.callCount(), 1)

  h.updater.checkHandler = async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: '0.1.3' },
  })
  h.updater.downloadHandler = async () => {
    const err = new Error('SHA512 mismatch')
    h.updater.emit('error', err)
    throw err
  }
  await h.manager.check(true)
  await flushAsync()
  assert.deepEqual(h.manager.getState(), {
    status: 'error',
    version: '0.1.3',
    error: 'SHA512 mismatch',
  })
  assert.equal(errorLog.mock.callCount(), 2)

  // Silent error event followed by resolved downloadUpdate() must fail rather than mark downloaded
  h.updater.downloadHandler = async () => {
    h.updater.emit('error', new Error('corrupt archive'))
    return []
  }
  await h.manager.check(true)
  await flushAsync()
  assert.deepEqual(h.manager.getState(), {
    status: 'error',
    version: '0.1.3',
    error: 'corrupt archive',
  })
  assert.equal(h.dialogs.length, 0)

  const callsBeforeAutoRetry = h.updater.checkCalls
  const autoCheckResult = await h.manager.check(false)
  assert.equal(h.updater.checkCalls, callsBeforeAutoRetry)
  assert.equal(autoCheckResult.status, 'error')

  h.updater.downloadHandler = async () => {
    h.updater.emit('update-downloaded', { version: '0.1.3' })
    return []
  }
  await h.manager.check(true)
  await flushAsync()
  assert.equal(h.manager.getState().status, 'downloaded')
})

test('DesktopUpdateDialogCoordinator.openFromMenu shows accurate dialogs across states', async () => {
  const devHarness = createHarness({ isPackaged: false })
  await devHarness.coordinator.openFromMenu()
  assert.equal(devHarness.dialogs.length, 1)
  assert.match(devHarness.dialogs[0].message, /打包安装/)

  const upToDateHarness = createHarness()
  await upToDateHarness.coordinator.openFromMenu()
  assert.equal(upToDateHarness.dialogs.length, 1)
  assert.match(upToDateHarness.dialogs[0].message, /最新/)

  const downloadingHarness = createHarness()
  downloadingHarness.updater.checkHandler = async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: '0.1.3' },
  })
  downloadingHarness.updater.downloadHandler = () => new Promise(() => {})
  await downloadingHarness.coordinator.openFromMenu()
  assert.equal(downloadingHarness.dialogs.length, 1)
  assert.match(downloadingHarness.dialogs[0].message, /0\.1\.3/)

  const errorHarness = createHarness()
  errorHarness.updater.checkHandler = async () => {
    throw new Error('timeout')
  }
  await errorHarness.coordinator.openFromMenu()
  assert.equal(errorHarness.dialogs[0].type, 'error')
  assert.equal(errorHarness.dialogs[0].detail, 'timeout')
})

test('DesktopUpdateManager preserves downloaded state when beforeInstall cancels or throws, and exits safely after stop failure', async (t) => {
  t.mock.method(console, 'error', () => {})
  let mode: 'cancel' | 'throw' = 'cancel'
  const guardHarness = createHarness({
    beforeInstall: async () => {
      if (mode === 'throw') throw new Error('dialog closed unexpectedly')
      return false
    },
  })
  guardHarness.updater.checkHandler = async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: '0.1.3' },
  })
  await guardHarness.manager.check(true)
  await flushAsync()

  assert.equal(await guardHarness.manager.install(), false)
  assert.equal(guardHarness.getForcedExitCount(), 0)
  assert.equal(guardHarness.manager.getState().status, 'downloaded')

  mode = 'throw'
  assert.equal(await guardHarness.manager.install(), false)
  assert.equal(guardHarness.getForcedExitCount(), 0)
  assert.equal(guardHarness.updater.quitAndInstallCalls.length, 0)
  assert.equal(guardHarness.manager.getState().status, 'downloaded')

  const failHarness = createHarness({ dialogResponse: 0 })
  failHarness.updater.checkHandler = async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: '0.1.3' },
  })
  failHarness.updater.quitAndInstallHandler = () => {
    failHarness.updater.emit('error', new Error('shipit verification failed'))
  }
  await failHarness.manager.check(true)
  await flushAsync()
  assert.equal(failHarness.getForcedExitCount(), 1)
  assert.equal(failHarness.dialogs.at(-1)?.type, 'error')
  assert.equal(failHarness.dialogs.at(-1)?.detail, 'shipit verification failed')
})

test('DesktopUpdateManager.dispose detaches updater listeners cleanly', () => {
  const h = createHarness()
  assert.equal(h.updater.listenerCount('error'), 1)
  h.manager.dispose()
  h.coordinator.dispose()
  assert.equal(h.updater.listenerCount('error'), 0)
  assert.equal(h.updater.listenerCount('download-progress'), 0)
  assert.equal(h.updater.listenerCount('update-downloaded'), 0)
})

test('DesktopUpdateManager exposes unsupported reasons and opens Releases for portable/unsupported platforms', async (t) => {
  const devH = createHarness({ isPackaged: false })
  assert.deepEqual(devH.manager.getState(), { status: 'unsupported', reason: 'unpackaged' })
  assert.deepEqual(await devH.manager.check(true), { status: 'unsupported', reason: 'unpackaged' })
  assert.equal(devH.updater.checkCalls, 0)

  const portableH = createHarness({
    platform: 'win32',
    arch: 'x64',
    isWindowsSetup: () => false,
    dialogResponse: 0,
  })
  assert.deepEqual(portableH.manager.getState(), { status: 'unsupported', reason: 'windows-portable' })
  await portableH.coordinator.openFromMenu()
  assert.equal(portableH.dialogs.length, 1)
  assert.match(portableH.dialogs[0].message, /便携版/)
  assert.equal(portableH.getOpenDownloadsCalls(), 1)

  const archH = createHarness({
    platform: 'darwin',
    arch: 'x64',
    dialogResponse: 1,
  })
  assert.deepEqual(archH.manager.getState(), { status: 'unsupported', reason: 'unsupported-platform' })
  await archH.coordinator.openFromMenu()
  assert.equal(archH.dialogs.length, 1)
  assert.equal(archH.getOpenDownloadsCalls(), 0)

  const missingUpdaterH = createHarness({ updater: null })
  assert.deepEqual(missingUpdaterH.manager.getState(), {
    status: 'unsupported',
    reason: 'unsupported-platform',
  })

  const dir = mkdtempSync(join(tmpdir(), 'youdub-unins-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const exePath = join(dir, 'YouDub.exe')
  writeFileSync(exePath, '')
  assert.equal(hasWindowsSetupUninstaller(exePath), false)
  writeFileSync(join(dir, 'unins001.exe'), '')
  assert.equal(hasWindowsSetupUninstaller(exePath), true)
})

test('DesktopUpdateDialogCoordinator sets announcedVersion only after showDialog resolves and recovers dialogOpen on rejection', async () => {
  let failDialog = true
  const h = createHarness({
    visible: true,
    showDialog: async () => {
      if (failDialog) throw new Error('dialog failed')
      return { response: 1 }
    },
  })
  h.updater.checkHandler = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.1.3' } })
  h.updater.downloadHandler = async () => {
    h.updater.emit('update-downloaded', { version: '0.1.3' })
    return []
  }

  await h.manager.check(true)
  await flushAsync()
  assert.equal(h.dialogs.length, 1)

  failDialog = false
  await h.coordinator.promptReady()
  assert.equal(h.dialogs.length, 2)

  let failMenu = true
  const menuH = createHarness({
    visible: true,
    showDialog: async () => {
      if (failMenu) {
        failMenu = false
        throw new Error('menu dialog error')
      }
      return { response: 1 }
    },
  })
  menuH.updater.checkHandler = async () => {
    throw new Error('offline')
  }
  await assert.rejects(() => menuH.coordinator.openFromMenu(), /menu dialog error/)
  menuH.updater.checkHandler = async () => ({ isUpdateAvailable: false, updateInfo: { version: '0.1.2' } })
  await menuH.coordinator.openFromMenu()
  assert.equal(menuH.dialogs.length, 2)
})

test('DesktopUpdateManager polling runs after 5s delay, deduplicates focus checks within 600s, and stops on dispose', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = createHarness()
  t.after(() => {
    h.coordinator.dispose()
    h.manager.dispose()
  })

  h.manager.startPolling()
  await h.manager.checkIfDue()
  assert.equal(h.updater.checkCalls, 0)

  t.mock.timers.tick(5_000)
  await Promise.resolve()
  assert.equal(h.updater.checkCalls, 1)

  t.mock.timers.tick(4_000)
  await h.manager.checkIfDue()
  assert.equal(h.updater.checkCalls, 1)

  // Simulate system sleep advancing wall-clock past the 600s interval without firing timers
  t.mock.timers.setTime(Date.now() + 600_000)
  await h.manager.checkIfDue()
  assert.equal(h.updater.checkCalls, 2)

  h.manager.dispose()
  t.mock.timers.tick(700_000)
  await h.manager.checkIfDue()
  assert.equal(h.updater.checkCalls, 2)
})
