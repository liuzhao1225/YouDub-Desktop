import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '@/test/language-provider'
import { createMockDesktopBridge } from '@/test/desktop-bridge'
import { ThemeProvider } from '@/lib/theme'
import type { DesktopUpdateState } from '@/lib/desktop-bridge'
import { AppShell } from '@/components/shell/AppShell'
import { SettingsModal, type LLMProviderView, type SettingsTab } from './SettingsModal'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  delete window.youdubDesktop
  vi.restoreAllMocks()
})

const openaiProvider: LLMProviderView = {
  id: 'openai-1',
  name: 'OpenAI',
  protocol: 'openai',
  preset: 'openai',
  base_url: 'https://api.openai.com/v1',
  default_model: 'gpt-4o-mini',
  models: ['gpt-4o-mini', 'gpt-4.1'],
  enabled: true,
  requiresApiKey: true,
  hasApiKey: true,
  apiKeyHint: 'sk-***1234',
  available: true,
  unavailableReason: null,
}

const defaultPresets = [
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    base_url: 'https://api.openai.com/v1',
    default_model: 'gpt-4o-mini',
    models: ['gpt-4o-mini'],
    requires_api_key: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    base_url: 'https://api.deepseek.com/v1',
    default_model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    requires_api_key: true,
  },
]

function mountModal(initialTab: SettingsTab = 'general', initialProviders: LLMProviderView[] = [openaiProvider]) {
  const settings = {
    ui_language: 'zh',
    theme: 'system',
    data_dir: '/Users/test/.youdub',
    default_data_dir: '/Users/test/.youdub',
    proxy_url: 'http://127.0.0.1:7897',
  }
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/settings' && (!init?.method || init.method === 'GET')) return { ...settings }
    if (path === '/api/settings' && init?.method === 'PATCH') {
      Object.assign(settings, JSON.parse(String(init.body)))
      return { ...settings }
    }
    if (path === '/api/llm/providers') return { items: initialProviders }
    if (path === '/api/llm/presets') return { items: defaultPresets }
    if (path.endsWith('/models') && init?.method === 'POST') {
      return { items: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3'] }
    }
    if (path.endsWith('/test') && init?.method === 'POST') {
      return { ok: true, model: 'deepseek-reasoner', latencyMs: 142 }
    }
    if (path.startsWith('/api/llm/providers/') && init?.method === 'PUT') {
      const payload = JSON.parse(String(init.body))
      const id = decodeURIComponent(path.split('/').pop()!)
      return {
        id,
        name: payload.name,
        protocol: payload.protocol,
        preset: payload.preset,
        base_url: payload.base_url,
        default_model: payload.default_model,
        models: payload.models,
        enabled: payload.enabled,
        requiresApiKey: true,
        hasApiKey: payload.clear_api_key ? false : Boolean(payload.api_key || true),
        apiKeyHint: payload.clear_api_key ? '' : 'sk-***new',
        available: true,
        unavailableReason: null,
      } satisfies LLMProviderView
    }
    if (path.startsWith('/api/llm/providers/') && init?.method === 'DELETE') {
      return undefined
    }
    throw new Error(`Unexpected request: ${path}`)
  })

  render(
    <ThemeProvider>
      <LanguageProvider>
        <SettingsModal open onClose={() => {}} initialTab={initialTab} request={request as never} />
      </LanguageProvider>
    </ThemeProvider>,
  )
  return { request }
}

it('updates language, theme, data directory (with directory picker), and proxy URL in the General tab', async () => {
  const pickDirectory = vi.fn(async () => '/Volumes/Media/YouDub')
  window.youdubDesktop = createMockDesktopBridge({ pickDirectory })

  const { request } = mountModal('general')
  const user = userEvent.setup()

  const dataInput = await screen.findByLabelText('数据目录')
  await waitFor(() => expect(dataInput).toHaveValue('/Users/test/.youdub'))

  await user.click(screen.getByLabelText('界面语言'))
  await user.click(await screen.findByRole('menuitem', { name: 'English' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ ui_language: 'en' }),
      }),
    ),
  )

  await user.click(screen.getByRole('tab', { name: 'Dark' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ theme: 'dark' }),
      }),
    ),
  )

  await user.click(screen.getByRole('button', { name: 'Choose folder' }))
  await waitFor(() => expect(dataInput).toHaveValue('/Volumes/Media/YouDub'))
  await user.click(within(dataInput.closest('div')!).getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ data_dir: '/Volumes/Media/YouDub' }),
      }),
    ),
  )

  const proxyInput = screen.getByLabelText('Network proxy URL')
  await user.clear(proxyInput)
  await user.type(proxyInput, 'socks5://127.0.0.1:1080')
  await user.click(within(proxyInput.closest('div')!).getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ proxy_url: 'socks5://127.0.0.1:1080' }),
      }),
    ),
  )
})

it('adds from preset, discovers models, tests connection, saves, clears API key, and deletes a provider', async () => {
  const { request } = mountModal('llm')
  const user = userEvent.setup()

  expect(await screen.findByRole('button', { name: /OpenAI/ })).toBeInTheDocument()

  await user.click(screen.getByLabelText('服务预设'))
  await user.click(await screen.findByRole('menuitem', { name: 'DeepSeek' }))
  await user.click(screen.getByRole('button', { name: '添加服务商' }))

  expect(screen.getByLabelText('名称')).toHaveValue('DeepSeek')
  expect(screen.getByLabelText('服务地址 (Base URL)')).toHaveValue('https://api.deepseek.com/v1')

  await user.type(screen.getByLabelText('API Key'), 'sk-test-key')
  await user.click(screen.getByRole('button', { name: '获取模型列表' }))
  expect(await screen.findByText('已获取 3 个模型')).toBeInTheDocument()

  await user.click(screen.getByLabelText('可用模型列表'))
  await user.click(await screen.findByRole('menuitem', { name: 'deepseek-reasoner' }))
  expect(screen.getByLabelText('默认模型')).toHaveValue('deepseek-reasoner')

  await user.click(screen.getByRole('button', { name: '测试连接' }))
  expect(await screen.findByText('连接成功（deepseek-reasoner，142 ms）')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => {
    const putCall = request.mock.calls.find(([p, init]) => p.startsWith('/api/llm/providers/') && init?.method === 'PUT')
    expect(putCall).toBeDefined()
    expect(JSON.parse(String(putCall![1]!.body))).toMatchObject({
      name: 'DeepSeek',
      protocol: 'openai',
      preset: 'deepseek',
      base_url: 'https://api.deepseek.com/v1',
      default_model: 'deepseek-reasoner',
      api_key: 'sk-test-key',
      enabled: true,
    })
  })

  await user.click(screen.getByRole('button', { name: /OpenAI/ }))
  expect(screen.getByLabelText('API Key')).toHaveAttribute('placeholder', 'sk-***1234')
  await user.click(screen.getByRole('button', { name: '清除已保存密钥' }))
  expect(screen.getByLabelText('API Key')).toHaveAttribute('placeholder', '保存后将清除已有密钥')
  await user.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => {
    const clearCall = request.mock.calls.find(
      ([p, init]) => p === '/api/llm/providers/openai-1' && init?.method === 'PUT',
    )
    expect(JSON.parse(String(clearCall![1]!.body))).toMatchObject({ clear_api_key: true })
  })

  await user.click(screen.getByRole('button', { name: '删除' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/api/llm/providers/openai-1',
      expect.objectContaining({ method: 'DELETE' }),
    ),
  )
})

it('renders desktop version & update controls in the General tab across check, progress, ready, and error states', async () => {
  let listener: ((state: DesktopUpdateState) => void) | undefined
  const getUpdateState = vi.fn(async (): Promise<DesktopUpdateState> => ({ status: 'idle' }))
  const checkForUpdates = vi.fn(async (): Promise<DesktopUpdateState> => ({ status: 'not-available', version: '2.0.0' }))
  const quitAndInstall = vi.fn(async () => {})

  window.youdubDesktop = createMockDesktopBridge({
    getUpdateState,
    checkForUpdates,
    quitAndInstall,
    onUpdateState: (cb) => {
      listener = cb
      return () => {}
    },
  })

  mountModal('general')
  const user = userEvent.setup()

  expect(await screen.findByText('版本与更新')).toBeInTheDocument()
  expect(screen.getByText('当前版本 v2.0.0')).toBeInTheDocument()
  await waitFor(() => expect(getUpdateState).toHaveBeenCalledTimes(1))

  await user.click(screen.getByRole('button', { name: '检查更新' }))
  expect(checkForUpdates).toHaveBeenCalledTimes(1)
  expect(await screen.findByText('当前已是最新版本')).toBeInTheDocument()

  act(() => {
    listener?.({ status: 'downloading', version: '2.1.0', percent: 42 })
  })
  expect(await screen.findByText('正在下载 v2.1.0 (42%)')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '正在下载更新…' })).toBeDisabled()

  act(() => {
    listener?.({ status: 'error', error: 'net::ERR_CONNECTION_TIMED_OUT' })
  })
  expect(await screen.findByText('net::ERR_CONNECTION_TIMED_OUT')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '重试检查' })).toBeEnabled()

  act(() => {
    listener?.({ status: 'downloaded', version: '2.1.0' })
  })
  expect(await screen.findByText('重启安装 v2.1.0')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '重启以安装更新' }))
  expect(quitAndInstall).toHaveBeenCalledTimes(1)
})

it('shows Releases download link and hides update actions when desktop updates are unsupported', async () => {
  let resolveInitial!: (state: DesktopUpdateState) => void
  let listener: ((state: DesktopUpdateState) => void) | undefined

  window.youdubDesktop = createMockDesktopBridge({
    platform: 'win32',
    getUpdateState: vi.fn(
      () =>
        new Promise<DesktopUpdateState>((resolve) => {
          resolveInitial = resolve
        }),
    ),
    onUpdateState: (cb) => {
      listener = cb
      return () => {}
    },
  })

  mountModal('general')

  // Live unsupported state arrives before slow getUpdateState resolves; slow hydration must not clobber it
  act(() => {
    listener?.({ status: 'unsupported', reason: 'windows-portable' })
  })
  await act(async () => {
    resolveInitial({ status: 'idle' })
    await Promise.resolve()
  })

  expect(await screen.findByText(/Windows 便携版/)).toBeInTheDocument()
  const link = screen.getByRole('link', { name: '打开下载页' })
  expect(link).toHaveAttribute('href', 'https://github.com/liuzhao1225/YouDub-Desktop/releases/latest')
  expect(link).toHaveAttribute('target', '_blank')
  expect(screen.queryByRole('button', { name: '检查更新' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '重启以安装更新' })).not.toBeInTheDocument()
})

it('shares one desktop update store across AppShell and SettingsModal without duplicate subscriptions', async () => {
  let listener: ((state: DesktopUpdateState) => void) | undefined
  const getUpdateState = vi.fn(async (): Promise<DesktopUpdateState> => ({ status: 'idle' }))
  const checkForUpdates = vi.fn(
    async (): Promise<DesktopUpdateState> => ({ status: 'downloading', version: '2.1.0', percent: 35 }),
  )
  const onUpdateState = vi.fn((cb: (state: DesktopUpdateState) => void) => {
    listener = cb
    return () => {}
  })

  window.youdubDesktop = createMockDesktopBridge({
    getUpdateState,
    checkForUpdates,
    onUpdateState,
  })

  const request = vi.fn(async (path: string) => {
    if (path === '/api/settings') {
      return {
        ui_language: 'zh',
        theme: 'system',
        data_dir: '/Users/test/.youdub',
        default_data_dir: '/Users/test/.youdub',
        proxy_url: '',
      }
    }
    return { items: [] }
  })

  render(
    <ThemeProvider>
      <LanguageProvider>
        <AppShell pathname="/" onNavigate={() => {}} onOpenSettings={() => {}}>
          <SettingsModal open onClose={() => {}} initialTab="general" request={request as never} />
        </AppShell>
      </LanguageProvider>
    </ThemeProvider>,
  )

  await waitFor(() => expect(getUpdateState).toHaveBeenCalledTimes(1))
  expect(onUpdateState).toHaveBeenCalledTimes(1)

  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '检查更新' }))
  await waitFor(() => expect(screen.getAllByText('正在下载 v2.1.0 (35%)')).toHaveLength(2))

  act(() => {
    listener?.({ status: 'downloaded', version: '2.1.0' })
  })
  expect(screen.getAllByText('重启安装 v2.1.0')).toHaveLength(2)
})
