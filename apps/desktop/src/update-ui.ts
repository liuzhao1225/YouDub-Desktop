import { formatDesktopMessage, type DesktopMessages } from './desktop-locale'
import { formatErrorMessage, type DesktopUpdateManager, type UpdateUnsupportedReason } from './update-manager'

export interface UpdateDialogOptions {
  type: 'info' | 'error' | 'warning'
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
  noLink?: boolean
}

export interface DesktopUpdateDialogCoordinatorOptions {
  manager: Pick<DesktopUpdateManager, 'currentVersion' | 'getState' | 'isInstalling' | 'check' | 'install'>
  getMessages: () => DesktopMessages
  showDialog: (options: UpdateDialogOptions) => Promise<{ response: number }>
  isWindowVisible: () => boolean
  openDownloadsPage: () => void
  onPostStopDialogClosed: () => void
}

export class DesktopUpdateDialogCoordinator {
  private dialogOpen = false
  private announcedVersion: string | undefined
  private disposed = false

  constructor(private readonly options: DesktopUpdateDialogCoordinatorOptions) {}

  async promptReady(version = this.options.manager.getState().version): Promise<void> {
    const state = this.options.manager.getState()
    if (
      this.disposed ||
      this.dialogOpen ||
      this.options.manager.isInstalling() ||
      state.status !== 'downloaded' ||
      !version ||
      this.announcedVersion === version ||
      !this.options.isWindowVisible()
    ) {
      return
    }
    this.dialogOpen = true
    try {
      await this.showReadyDialog(version)
    } catch (err) {
      console.error('[updater] Failed to display update ready prompt:', err)
    } finally {
      this.dialogOpen = false
    }
  }

  async openFromMenu(): Promise<void> {
    if (this.disposed || this.dialogOpen) return
    this.dialogOpen = true
    try {
      await this.presentMenuDialog()
    } finally {
      this.dialogOpen = false
      void this.promptReady()
    }
  }

  async handlePostStopInstallError(message: string): Promise<void> {
    if (this.disposed) return
    const messages = this.options.getMessages()
    try {
      await this.showUpdateDialog({
        type: 'error',
        message: messages.updateFailedMessage,
        detail: message,
        buttons: [messages.exitApplicationButton],
      })
    } catch (dialogErr) {
      console.error(`[updater] Failed to display update error dialog: ${formatErrorMessage(dialogErr)}`)
    } finally {
      this.options.onPostStopDialogClosed()
    }
  }

  dispose(): void {
    this.disposed = true
  }

  private showUpdateDialog(
    options: Omit<UpdateDialogOptions, 'title' | 'noLink' | 'buttons'> & { buttons?: string[] },
  ): Promise<{ response: number }> {
    const messages = this.options.getMessages()
    return this.options.showDialog({
      noLink: true,
      title: messages.updateTitle,
      buttons: [messages.updateCloseButton],
      ...options,
    })
  }

  private async presentMenuDialog(): Promise<void> {
    const { manager } = this.options
    const messages = this.options.getMessages()
    let state = manager.getState()
    if (state.status === 'unsupported') {
      await this.showUnsupportedDialog(state.reason ?? 'unsupported-platform')
      return
    }
    if (state.status !== 'downloaded' && state.status !== 'downloading') {
      state = await manager.check(true)
      if (this.disposed) return
    }

    switch (state.status) {
      case 'downloaded':
        if (state.version) await this.showReadyDialog(state.version)
        return
      case 'downloading':
        if (state.version) {
          await this.showUpdateDialog({
            type: 'info',
            message: formatDesktopMessage(messages.updateDownloadingMessage, { version: state.version }),
            detail: formatDesktopMessage(messages.updateDownloadingDetail, { percent: state.percent ?? 0 }),
          })
        }
        return
      case 'not-available':
        await this.showUpdateDialog({
          type: 'info',
          message: messages.updateCurrentMessage,
          detail: formatDesktopMessage(messages.updateCurrentDetail, { version: manager.currentVersion }),
        })
        return
      case 'error':
        await this.showUpdateDialog({
          type: 'error',
          message: messages.updateFailedMessage,
          detail: state.error,
        })
    }
  }

  private async showUnsupportedDialog(reason: UpdateUnsupportedReason): Promise<void> {
    const messages = this.options.getMessages()
    if (reason === 'unpackaged') {
      await this.showUpdateDialog({ type: 'info', message: messages.updateUnavailableDevMessage })
      return
    }
    const isPortable = reason === 'windows-portable'
    const result = await this.showUpdateDialog({
      type: 'info',
      message: isPortable ? messages.updatePortableMessage : messages.updateUnsupportedPlatformMessage,
      detail: isPortable ? messages.updatePortableDetail : messages.updateUnsupportedPlatformDetail,
      buttons: [messages.updateOpenDownloadsButton, messages.updateCloseButton],
      defaultId: 0,
      cancelId: 1,
    })
    if (result.response === 0) {
      this.options.openDownloadsPage()
    }
  }

  private async showReadyDialog(version: string): Promise<void> {
    const messages = this.options.getMessages()
    const result = await this.showUpdateDialog({
      type: 'info',
      message: formatDesktopMessage(messages.updateReadyMessage, { version }),
      detail: messages.updateReadyDetail,
      buttons: [messages.updateRestartButton, messages.updateLaterButton],
      defaultId: 0,
      cancelId: 1,
    })
    this.announcedVersion = version
    if (result.response === 0) {
      await this.options.manager.install()
    }
  }
}
