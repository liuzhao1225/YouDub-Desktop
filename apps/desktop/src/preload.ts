import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

export interface DesktopUpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloaded' | 'error'
  version?: string
  error?: string
}

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

contextBridge.exposeInMainWorld('youdubDesktop', {
  platform: bootstrap.platform,
  version: bootstrap.version,
  backendUrl: bootstrap.backendUrl,
  authToken: bootstrap.authToken,
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('youdub:pick-directory'),
  openPath: (targetPath: string): Promise<void> => ipcRenderer.invoke('youdub:open-path', targetPath),
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('youdub:check-updates'),
  quitAndInstall: (): Promise<void> => ipcRenderer.invoke('youdub:quit-and-install'),
  onUpdateState: (listener: (state: DesktopUpdateState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: DesktopUpdateState) => listener(state)
    ipcRenderer.on('youdub:update-state', handler)
    return () => {
      ipcRenderer.removeListener('youdub:update-state', handler)
    }
  },
})
