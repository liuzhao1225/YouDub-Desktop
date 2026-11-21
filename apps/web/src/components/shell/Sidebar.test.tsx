import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '@/test/language-provider'
import { ThemeProvider } from '@/lib/theme'
import { AppShell } from './AppShell'
import type { DesktopUpdateState } from './Sidebar'

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })))
})

const defaultInnerWidth = window.innerWidth

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: defaultInnerWidth,
  })
  window.localStorage.clear()
  delete window.youdubDesktop
  delete document.documentElement.dataset.platform
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('renders the 4 core routes without Extensions, persists collapse, cycles theme, opens settings, and links GitHub', async () => {
  const onNavigate = vi.fn()
  const onOpenSettings = vi.fn()

  const { container } = render(
    <ThemeProvider>
      <LanguageProvider>
        <AppShell pathname="/tasks" onNavigate={onNavigate} onOpenSettings={onOpenSettings}>
          <main>Tasks content</main>
        </AppShell>
      </LanguageProvider>
    </ThemeProvider>,
  )

  const nav = screen.getByRole('navigation', { name: '主导航' })
  expect(nav.querySelectorAll('a')).toHaveLength(4)
  expect(screen.getByRole('link', { name: '工作台' })).toHaveAttribute('href', '/')
  expect(screen.getByRole('link', { name: '任务库' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('link', { name: '工作流' })).toHaveAttribute('href', '/workflows')
  expect(screen.getByRole('link', { name: '资源' })).toHaveAttribute('href', '/resources')
  expect(screen.queryByRole('link', { name: /插件|Extensions|Plugins/i })).not.toBeInTheDocument()

  expect(screen.getByRole('link', { name: '问题反馈' })).toHaveAttribute(
    'href',
    'https://github.com/liuzhao1225/YouDub-webui/issues',
  )
  expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/liuzhao1225/YouDub-webui',
  )

  const user = userEvent.setup()
  await user.click(screen.getByRole('link', { name: '工作流' }))
  expect(onNavigate).toHaveBeenCalledWith('/workflows')

  await user.click(screen.getByRole('button', { name: '设置' }))
  expect(onOpenSettings).toHaveBeenCalledTimes(1)

  const themeButton = screen.getByRole('button', { name: '主题：跟随系统' })
  await user.click(themeButton)
  await user.click(await screen.findByRole('menuitem', { name: '浅色' }))
  expect(screen.getByRole('button', { name: '主题：浅色' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '主题：浅色' }))
  await user.click(await screen.findByRole('menuitem', { name: '深色' }))
  expect(screen.getByRole('button', { name: '主题：深色' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: '收起侧边栏' }))
  expect(window.localStorage.getItem('youdub-sidebar-collapsed')).toBe('true')
  expect(container.querySelector('[data-sidebar-collapsed="true"]')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
  expect(window.localStorage.getItem('youdub-sidebar-collapsed')).toBe('false')
})

it('applies darwin platform attribute and exposes desktop update actions when downloaded', async () => {
  let listener: ((state: DesktopUpdateState) => void) | undefined
  const checkForUpdates = vi.fn(async () => {})
  const quitAndInstall = vi.fn(async () => {})

  window.youdubDesktop = {
    platform: 'darwin',
    version: '2.0.0',
    backendUrl: 'http://127.0.0.1:8765',
    pickDirectory: vi.fn(async () => null),
    openPath: vi.fn(async () => {}),
    checkForUpdates,
    quitAndInstall,
    onUpdateState: (cb) => {
      listener = cb
      return () => {}
    },
  }

  const { container } = render(
    <ThemeProvider>
      <LanguageProvider>
        <AppShell pathname="/" onNavigate={() => {}} onOpenSettings={() => {}}>
          <main>Studio content</main>
        </AppShell>
      </LanguageProvider>
    </ThemeProvider>,
  )

  expect(document.documentElement.dataset.platform).toBe('darwin')
  expect(container.querySelector('[data-platform="darwin"]')).toBeInTheDocument()

  act(() => {
    listener?.({ status: 'available', version: '2.1.0' })
  })
  const availablePill = screen.getByRole('button', { name: '发现新版本 v2.1.0' })
  await userEvent.setup().click(availablePill)
  expect(checkForUpdates).toHaveBeenCalledTimes(1)
  expect(quitAndInstall).not.toHaveBeenCalled()

  act(() => {
    listener?.({ status: 'downloaded', version: '2.1.0' })
  })
  const installPill = screen.getByRole('button', { name: '重启安装 v2.1.0' })
  await userEvent.setup().click(installPill)
  expect(quitAndInstall).toHaveBeenCalledTimes(1)
})

it('auto-collapses to an inline 56px rail on narrow viewports (< 1024px) and expands inline without a drawer', async () => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: 820,
  })
  const onNavigate = vi.fn()
  const user = userEvent.setup()

  const { container } = render(
    <ThemeProvider>
      <LanguageProvider>
        <AppShell pathname="/" onNavigate={onNavigate} onOpenSettings={() => {}}>
          <main>Studio content</main>
        </AppShell>
      </LanguageProvider>
    </ThemeProvider>,
  )

  const frame = container.querySelector('[data-sidebar-collapsed="true"]') as HTMLElement | null
  expect(frame).toBeInTheDocument()
  expect(frame?.style.gridTemplateColumns).toBe('56px minmax(0, 1fr)')
  expect(screen.queryByRole('button', { name: '打开导航' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '关闭导航' })).not.toBeInTheDocument()
  expect(container.querySelector('.fixed.inset-0')).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
  expect(container.querySelector('[data-sidebar-collapsed="true"]')).not.toBeInTheDocument()
  expect(frame?.style.gridTemplateColumns).toBe('240px minmax(0, 1fr)')
  expect(container.querySelector('.fixed.inset-0')).not.toBeInTheDocument()

  await user.click(screen.getByRole('link', { name: '工作流' }))
  expect(onNavigate).toHaveBeenCalledWith('/workflows')
  expect(frame?.style.gridTemplateColumns).toBe('240px minmax(0, 1fr)')

  await user.click(screen.getByRole('button', { name: '收起侧边栏' }))
  expect(frame?.style.gridTemplateColumns).toBe('56px minmax(0, 1fr)')
})
