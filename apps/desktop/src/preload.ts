import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DesktopUpdateState } from './update-manager'

interface BootstrapPayload {
  platform: string
  version: string
  backendUrl: string
  authToken?: string
  isFullScreen?: boolean
}

const bootstrap = ipcRenderer.sendSync('youdub:bootstrap') as BootstrapPayload

function applyDocumentAttributes(): void {
  const root = document.documentElement as HTMLElement | null
  if (!root) return
  root.dataset.platform = bootstrap.platform
  if (bootstrap.platform === 'win32') {
    root.dataset.windowsTitlebar = ''
    root.style.setProperty('--dsh-windows-titlebar-height', '40px')
  }
  if (bootstrap.isFullScreen) {
    root.dataset.fullscreen = 'true'
  }
}

if (document.documentElement) {
  applyDocumentAttributes()
} else {
  window.addEventListener('DOMContentLoaded', applyDocumentAttributes, { once: true })
}

if (bootstrap.platform === 'darwin' || bootstrap.platform === 'win32') {
  ipcRenderer.on('youdub:fullscreen', (_event: IpcRendererEvent, fullscreen: boolean) => {
    const root = document.documentElement as HTMLElement | null
    if (!root) return
    if (fullscreen) root.dataset.fullscreen = 'true'
    else delete root.dataset.fullscreen
  })
}

function onChannel<Args extends unknown[]>(channel: string, listener: (...args: Args) => void): () => void {
  const handler = (_event: IpcRendererEvent, ...args: Args) => listener(...args)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('youdubDesktop', {
  platform: bootstrap.platform,
  version: bootstrap.version,
  backendUrl: bootstrap.backendUrl,
  authToken: bootstrap.authToken,
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('youdub:pick-directory'),
  openPath: (targetPath: string): Promise<void> => ipcRenderer.invoke('youdub:open-path', targetPath),
  getUpdateState: (): Promise<DesktopUpdateState> => ipcRenderer.invoke('youdub:get-update-state'),
  checkForUpdates: (): Promise<DesktopUpdateState> => ipcRenderer.invoke('youdub:check-updates'),
  quitAndInstall: (): Promise<void> => ipcRenderer.invoke('youdub:quit-and-install'),
  setLanguage: (language: string): void => ipcRenderer.send('youdub:set-language', language),
  onOpenSettings: (listener: () => void): (() => void) => onChannel('youdub:open-settings', listener),
  onUpdateState: (listener: (state: DesktopUpdateState) => void): (() => void) =>
    onChannel<[DesktopUpdateState]>('youdub:update-state', listener),
})
