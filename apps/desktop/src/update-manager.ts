import { readdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const RELEASES_PAGE_URL = 'https://github.com/liuzhao1225/YouDub-Desktop/releases/latest'

const INITIAL_CHECK_DELAY_MS = 5_000
const POLL_INTERVAL_MS = 600_000

export type UpdateUnsupportedReason = 'unpackaged' | 'windows-portable' | 'unsupported-platform'

export interface DesktopUpdateState {
  status: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'not-available' | 'error' | 'unsupported'
  reason?: UpdateUnsupportedReason
  version?: string
  percent?: number
  error?: string
}

export interface UpdaterLike {
  checkForUpdates(): Promise<{
    readonly isUpdateAvailable?: boolean
    readonly updateInfo?: { readonly version?: string }
  } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', listener: (info: { readonly percent?: number }) => void): unknown
  on(event: 'update-downloaded', listener: (info: { readonly version?: string }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'download-progress', listener: (info: { readonly percent?: number }) => void): unknown
  off(event: 'update-downloaded', listener: (info: { readonly version?: string }) => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
}

export interface DesktopUpdateManagerOptions {
  isPackaged: boolean
  currentVersion: string
  platform?: NodeJS.Platform | string
  arch?: string
  isWindowsSetup?: () => boolean
  updater: UpdaterLike | null
  emitState: (state: DesktopUpdateState) => void
  beforeInstall: () => Promise<boolean>
  onReady?: (version: string) => void
  onPostStopInstallError?: (message: string) => void
}

export function hasWindowsSetupUninstaller(exePath: string): boolean {
  try {
    // Inno Setup names uninstallers unins000.exe, unins001.exe, etc. beside the executable.
    return readdirSync(dirname(exePath)).some((name) => /^unins\d{3}\.exe$/i.test(name))
  } catch {
    return false
  }
}

export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resolveUnsupportedReason(options: DesktopUpdateManagerOptions): UpdateUnsupportedReason | null {
  if (!options.isPackaged) return 'unpackaged'
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (platform === 'darwin') {
    if (arch !== 'arm64') return 'unsupported-platform'
  } else if (platform !== 'win32' || arch !== 'x64') {
    return 'unsupported-platform'
  } else if (!(options.isWindowsSetup?.() ?? false)) {
    return 'windows-portable'
  }
  return options.updater ? null : 'unsupported-platform'
}

export class DesktopUpdateManager {
  readonly currentVersion: string
  private readonly updater: UpdaterLike | null
  private state: DesktopUpdateState
  private downloadFailed = false
  private installPhase: 'idle' | 'confirming' | 'stopped' | 'failed' = 'idle'
  private checkPromise: Promise<DesktopUpdateState> | undefined
  private downloadPromise: Promise<void> | undefined
  private lastUpdaterError: Error | undefined
  private disposed = false
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private nextCheckAt = 0

  private readonly onDownloadProgress = (info: { readonly percent?: number }): void => {
    if (this.disposed || this.installPhase !== 'idle' || this.state.status !== 'downloading') return
    const numeric = typeof info?.percent === 'number' && Number.isFinite(info.percent) ? info.percent : 0
    const percent = Math.max(0, Math.min(100, Math.round(numeric)))
    if (this.state.percent === percent) return
    this.setState({ status: 'downloading', version: this.state.version, percent })
  }

  private readonly onUpdateDownloaded = (info: { readonly version?: string }): void => {
    this.finishDownload(info?.version)
  }

  private readonly onUpdaterError = (error: Error): void => {
    if (this.disposed) return
    if (this.installPhase === 'stopped') {
      this.handlePostStopInstallError(error)
      return
    }
    this.lastUpdaterError = error
    if (
      this.state.status !== 'checking' &&
      this.state.status !== 'downloading' &&
      this.state.status !== 'downloaded' &&
      this.installPhase === 'idle'
    ) {
      const message = formatErrorMessage(error)
      console.error(`[updater] ${message}`)
      this.setState({ status: 'error', error: message })
    }
  }

  constructor(private readonly options: DesktopUpdateManagerOptions) {
    this.currentVersion = options.currentVersion
    const unsupportedReason = resolveUnsupportedReason(options)
    this.updater = unsupportedReason ? null : options.updater
    this.state = unsupportedReason ? { status: 'unsupported', reason: unsupportedReason } : { status: 'idle' }

    if (this.updater) {
      this.updater.on('download-progress', this.onDownloadProgress)
      this.updater.on('update-downloaded', this.onUpdateDownloaded)
      this.updater.on('error', this.onUpdaterError)
    }
  }

  getState(): DesktopUpdateState {
    return { ...this.state }
  }

  isInstalling(): boolean {
    return this.installPhase !== 'idle'
  }

  startPolling(): void {
    if (!this.updater || this.disposed || this.pollTimer) return
    this.nextCheckAt = Date.now() + INITIAL_CHECK_DELAY_MS
    this.schedulePoll(INITIAL_CHECK_DELAY_MS)
  }

  async checkIfDue(): Promise<DesktopUpdateState> {
    if (!this.updater || this.disposed || Date.now() < this.nextCheckAt) return this.getState()
    return this.check(false)
  }

  async check(manual = false): Promise<DesktopUpdateState> {
    if (this.disposed || !this.updater) return this.getState()
    if (this.state.status === 'downloaded' || this.installPhase !== 'idle' || this.downloadPromise) {
      return this.getState()
    }
    if (!manual && this.state.status === 'error' && this.downloadFailed) {
      return this.getState()
    }
    if (!this.checkPromise) {
      this.checkPromise = this.runCheck(this.updater).finally(() => {
        this.checkPromise = undefined
      })
    }
    return this.checkPromise
  }

  async install(): Promise<boolean> {
    if (
      this.disposed ||
      !this.updater ||
      this.installPhase !== 'idle' ||
      this.state.status !== 'downloaded'
    ) {
      return false
    }
    this.installPhase = 'confirming'
    let proceed = false
    try {
      proceed = await this.options.beforeInstall()
    } catch (err) {
      console.error('[updater] Pre-install check failed:', err)
    }
    if (!proceed || this.disposed) {
      this.installPhase = 'idle'
      return false
    }

    this.installPhase = 'stopped'
    try {
      this.updater.quitAndInstall(true, true)
      return true
    } catch (error) {
      this.handlePostStopInstallError(error)
      return false
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
    if (this.updater) {
      this.updater.off('download-progress', this.onDownloadProgress)
      this.updater.off('update-downloaded', this.onUpdateDownloaded)
      this.updater.off('error', this.onUpdaterError)
    }
  }

  private schedulePoll(delayMs: number): void {
    if (this.disposed || !this.updater) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      void this.check(false).finally(() => this.schedulePoll(POLL_INTERVAL_MS))
    }, delayMs)
    this.pollTimer.unref?.()
  }

  private setState(next: DesktopUpdateState): DesktopUpdateState {
    const clean: DesktopUpdateState = {
      status: next.status,
      ...(next.reason !== undefined ? { reason: next.reason } : {}),
      ...(next.version ? { version: next.version } : {}),
      ...(next.percent !== undefined ? { percent: next.percent } : {}),
      ...(next.error !== undefined ? { error: next.error } : {}),
    }
    if (this.disposed) return clean
    if (
      this.state.status === clean.status &&
      this.state.reason === clean.reason &&
      this.state.version === clean.version &&
      this.state.percent === clean.percent &&
      this.state.error === clean.error
    ) {
      return this.getState()
    }
    this.state = clean
    const snapshot = this.getState()
    this.options.emitState(snapshot)
    return snapshot
  }

  private async runCheck(updater: UpdaterLike): Promise<DesktopUpdateState> {
    this.nextCheckAt = Date.now() + POLL_INTERVAL_MS
    this.downloadFailed = false
    this.lastUpdaterError = undefined
    this.setState({ status: 'checking' })
    try {
      const result = await updater.checkForUpdates()
      if (this.disposed) return this.getState()
      if (!result && this.lastUpdaterError) throw this.lastUpdaterError

      const version = result?.updateInfo?.version?.trim()
      if (!result?.isUpdateAvailable || !version) {
        return this.setState({ status: 'not-available', version: this.currentVersion })
      }
      this.startDownload(updater, version)
      return this.getState()
    } catch (error) {
      const message = formatErrorMessage(error)
      console.error(`[updater] Update check failed: ${message}`)
      return this.setState({ status: 'error', error: message })
    }
  }

  private startDownload(updater: UpdaterLike, version: string): void {
    if (this.disposed || this.state.status === 'downloaded' || this.downloadPromise) return
    this.downloadFailed = false
    this.lastUpdaterError = undefined
    this.setState({ status: 'downloading', version, percent: 0 })

    this.downloadPromise = (async () => {
      try {
        await updater.downloadUpdate()
        if (this.disposed) return
        if (this.lastUpdaterError) throw this.lastUpdaterError
        this.finishDownload(version)
      } catch (error) {
        if (this.disposed) return
        const message = formatErrorMessage(error)
        this.downloadFailed = true
        console.error(`[updater] Update download failed (${version}): ${message}`)
        this.setState({ status: 'error', version, error: message })
      } finally {
        this.downloadPromise = undefined
      }
    })()
  }

  private finishDownload(version?: string): void {
    if (this.disposed || this.state.status === 'downloaded') return
    const resolved = version?.trim() || this.state.version
    this.downloadFailed = false
    this.setState({ status: 'downloaded', version: resolved })
    if (resolved) this.options.onReady?.(resolved)
  }

  private handlePostStopInstallError(error: unknown): void {
    if (this.installPhase !== 'stopped' || this.disposed) return
    this.installPhase = 'failed'
    const message = formatErrorMessage(error)
    console.error(`[updater] Update install failed: ${message}`)
    this.setState({ status: 'error', version: this.state.version, error: message })
    this.options.onPostStopInstallError?.(message)
  }
}
