declare global {
  interface Window {
    youdubDesktop?: {
      platform: string
      version: string
      backendUrl: string
      authToken?: string
      pickDirectory: () => Promise<string | null>
      openPath: (path: string) => Promise<void>
      checkForUpdates: () => Promise<void>
      quitAndInstall: () => Promise<void>
      onUpdateState: (listener: (state: { status: string; version?: string; error?: string }) => void) => () => void
    }
  }
}

export function assetUrl(path: string): string {
  if (typeof window === 'undefined') return path
  const backendUrl = window.youdubDesktop?.backendUrl?.replace(/\/+$/, '') || ''
  const token = window.youdubDesktop?.authToken
  const resolved = backendUrl && path.startsWith('/api/') ? `${backendUrl}${path}` : path
  if (!token) return resolved
  const isApi = resolved.startsWith('/api/') || (backendUrl !== '' && resolved.startsWith(`${backendUrl}/api/`))
  if (!isApi) return resolved
  const separator = resolved.includes('?') ? '&' : '?'
  return `${resolved}${separator}token=${encodeURIComponent(token)}`
}
