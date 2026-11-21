import { vi } from 'vitest'
import type { DesktopUpdateState, YoudubDesktopBridge } from '@/lib/desktop-bridge'

export function createMockDesktopBridge(
  overrides: Partial<YoudubDesktopBridge> = {},
): YoudubDesktopBridge {
  return {
    platform: 'darwin',
    version: '2.0.0',
    backendUrl: 'http://127.0.0.1:8765',
    pickDirectory: vi.fn(async () => null),
    openPath: vi.fn(async () => {}),
    getUpdateState: vi.fn(async (): Promise<DesktopUpdateState> => ({ status: 'idle' })),
    checkForUpdates: vi.fn(async (): Promise<DesktopUpdateState> => ({ status: 'not-available', version: '2.0.0' })),
    quitAndInstall: vi.fn(async () => {}),
    setLanguage: vi.fn(),
    onOpenSettings: vi.fn(() => () => {}),
    onUpdateState: vi.fn(() => () => {}),
    ...overrides,
  }
}
