import { getDesktopBridge } from './desktop-bridge'

export function assetUrl(path: string): string {
  const desktop = getDesktopBridge()
  if (!desktop) return path
  const backendUrl = desktop.backendUrl?.replace(/\/+$/, '') || ''
  const token = desktop.authToken
  const resolved = backendUrl && path.startsWith('/api/') ? `${backendUrl}${path}` : path
  if (!token) return resolved
  const isApi = resolved.startsWith('/api/') || (backendUrl !== '' && resolved.startsWith(`${backendUrl}/api/`))
  if (!isApi) return resolved
  const separator = resolved.includes('?') ? '&' : '?'
  return `${resolved}${separator}token=${encodeURIComponent(token)}`
}
