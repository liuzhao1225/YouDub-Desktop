import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '@/test/language-provider'
import { ThemeProvider } from '@/lib/theme'
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
  window.youdubDesktop = {
    platform: 'darwin',
    version: '2.0.0',
    backendUrl: 'http://127.0.0.1:8765',
    pickDirectory,
    openPath: vi.fn(async () => {}),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    onUpdateState: vi.fn(() => () => {}),
  }

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
