export interface DesktopUpdateState {
  status: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'not-available' | 'error' | 'unsupported'
  reason?: 'unpackaged' | 'windows-portable' | 'unsupported-platform'
  version?: string
  percent?: number
  error?: string
}

export const RELEASES_PAGE_URL = 'https://github.com/liuzhao1225/YouDub-Desktop/releases/latest'

export interface YoudubDesktopBridge {
  platform: string
  version: string
  backendUrl: string
  authToken?: string
  pickDirectory: () => Promise<string | null>
  openPath: (path: string) => Promise<void>
  getUpdateState: () => Promise<DesktopUpdateState>
  checkForUpdates: () => Promise<DesktopUpdateState>
  quitAndInstall: () => Promise<void>
  setLanguage?: (language: string) => void
  onOpenSettings?: (listener: () => void) => () => void
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void
}

declare global {
  interface Window {
    youdubDesktop?: YoudubDesktopBridge
  }
}

export function getDesktopBridge(): YoudubDesktopBridge | undefined {
  return typeof window !== 'undefined' ? window.youdubDesktop : undefined
}
