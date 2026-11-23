import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '@/test/language-provider'
import { resourceEntries } from '@/runtime/setup-contracts'
import type { ResourceInventory, ResourcePreparation } from '@/runtime/setup-contracts'
import { SettingsResources } from './settings-resources'

afterEach(cleanup)
const inventory: ResourceInventory = {
  version: '0.0.7', platform: 'darwin', arch: 'arm64', osVersion: '25', homeDir: '/Users/test',
  environment: [{ id: 'python', name: 'Python 3.12', status: 'ready' }],
  items: [{ providerId: 'youdub.media', label: 'FFmpeg', automatic: true }, { providerId: 'whisper', model: 'tiny', label: 'Whisper', automatic: true, downloadId: 'whisper' }],
  models: [{ id: 'whisper', name: 'Whisper', variant: 'tiny', purpose: '语音识别', received: 0, total: 100, speed: 0, status: 'pending' }],
}
const inspection: ResourcePreparation = { status: 'missing', selections: [],
  environment: [{ id: 'python', name: 'Python 3.12', status: 'ready' }, { id: 'ffmpeg', name: 'FFmpeg', status: 'pending' }],
  models: inventory.models, requirements: [{ providerId: 'youdub.media', automatic: true, ready: false, missingPackages: [] },
    { providerId: 'whisper', model: 'tiny', automatic: true, ready: false, missingPackages: [] }],
}

inspection.entries = resourceEntries({ ...inspection, requirements: inspection.requirements.map(item => ({ ...item, resourceId: item.providerId === 'youdub.media' ? 'ffmpeg' : 'whisper', name: item.providerId === 'youdub.media' ? 'FFmpeg' : 'Whisper', downloadId: item.model ? 'whisper' : undefined })) })

it('shows one FFmpeg row and downloads only the clicked model without redundant pending text', async () => {
  const request = vi.fn(async (path: string) => path.endsWith('/resources') ? inventory : inspection)
  render(<LanguageProvider><SettingsResources title="资源" request={request as never} /></LanguageProvider>)
  await waitFor(() => expect(screen.getByRole('button', { name: '下载 Whisper' })).toBeEnabled())
  const whisperRow = screen.getByRole('group', { name: 'Whisper' })
  expect(within(whisperRow).queryByText('待准备')).not.toBeInTheDocument()
  const ffmpegRow = screen.getByRole('group', { name: 'FFmpeg' })
  expect(within(ffmpegRow).getByRole('button', { name: '安装 FFmpeg' })).toBeInTheDocument()
  expect(within(ffmpegRow).queryByText('待准备')).not.toBeInTheDocument()
  expect(screen.getAllByText('FFmpeg')).toHaveLength(1)
  expect(request.mock.calls.some(([path]) => path.endsWith('/prepare'))).toBe(false)
  await userEvent.setup().click(screen.getByRole('button', { name: '下载 Whisper' }))
  const mutation = (request.mock.calls as unknown as [string, RequestInit][]).find(([path]) => path.endsWith('/prepare'))
  expect(JSON.parse(mutation![1].body as string)).toEqual({ resourceIds: ['whisper'] })
  expect(screen.getByRole('region', { name: '诊断日志' })).toBeInTheDocument()
})

it('keeps uninspected resource readiness explicit when the initial check fails', async () => {
  const request = vi.fn().mockResolvedValueOnce(inventory).mockRejectedValue(new Error('Python path unavailable'))
  render(<LanguageProvider><SettingsResources title="资源" request={request} /></LanguageProvider>)
  await waitFor(() => expect(screen.getByText('环境尚未检测')).toBeInTheDocument())
  expect(screen.queryByText('已就绪')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /^(?:准备|下载|安装) / })).not.toBeInTheDocument()
  expect((screen.getByRole('textbox', { name: '诊断日志内容' }) as HTMLTextAreaElement).value).toContain('Python path unavailable')
})

it('renders yt-dlp update action with error feedback and Whisper model variants', async () => {
  const richInventory: ResourceInventory = {
    ...inventory,
    ytDlp: { version: '2025.03.01', installed: true },
    whisperVariants: [
      { id: 'large-v3-turbo', downloadId: 'whisper:large-v3-turbo', recommended: true, status: 'pending', installed: false, received: 0, total: 1600 },
      { id: 'tiny', downloadId: 'whisper:tiny', recommended: false, status: 'ready', installed: true, received: 75000, total: 75000 },
    ],
  }
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/resources') return richInventory
    if (path === '/api/resources/check') return inspection
    if (path === '/api/resources/yt-dlp/update' && init?.method === 'POST') {
      throw new Error('Network timeout updating yt-dlp')
    }
    if (path === '/api/resources/prepare' && init?.method === 'POST') return inspection
    return inspection
  })

  render(<LanguageProvider><SettingsResources title="资源" request={request as never} /></LanguageProvider>)
  expect(await screen.findByText('yt-dlp 2025.03.01')).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Whisper 语音识别模型变体' })).not.toBeInTheDocument()
  const variantSelect = screen.getByLabelText('Whisper 模型变体')
  expect(variantSelect).toHaveTextContent('large-v3-turbo (推荐)')

  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '更新 yt-dlp' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Network timeout updating yt-dlp')

  await user.click(screen.getByRole('button', { name: '下载 Whisper' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/api/resources/prepare',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ resourceIds: ['whisper:large-v3-turbo'] }),
      }),
    ),
  )

  await user.click(variantSelect)
  await user.click(await screen.findByRole('menuitem', { name: 'tiny · 可用' }))
  expect(screen.getByRole('button', { name: '移除模型权重 Whisper tiny' })).toBeInTheDocument()
})

it('shows clickable 待更新 badge when newer yt-dlp is detected and distinguishes actual update vs already latest', async () => {
  const richInventory: ResourceInventory = {
    ...inventory,
    ytDlp: { version: '2026.10.26', installed: true },
  }
  let postCount = 0
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/resources') return richInventory
    if (path === '/api/resources/check') return inspection
    if (path.startsWith('/api/resources/yt-dlp/check')) {
      return {
        version: '2026.10.26',
        installed: true,
        latestVersion: '2026.12.01',
        updateAvailable: true,
        checked: true,
      }
    }
    if (path === '/api/resources/yt-dlp/update' && init?.method === 'POST') {
      postCount += 1
      if (postCount === 1) {
        return { ok: true, version: '2026.12.01', previousVersion: '2026.10.26', updated: true }
      }
      return { ok: true, version: '2026.12.01', previousVersion: '2026.12.01', updated: false }
    }
    return inspection
  })

  render(<LanguageProvider><SettingsResources title="资源" request={request as never} /></LanguageProvider>)
  expect(await screen.findByText('yt-dlp 2026.10.26 → 2026.12.01')).toBeInTheDocument()
  const updatePill = screen.getByRole('button', { name: '更新 yt-dlp' })
  expect(updatePill).toHaveTextContent('待更新')

  const user = userEvent.setup()
  await user.click(updatePill)
  expect(await screen.findByText('yt-dlp 已更新至 2026.12.01')).toBeInTheDocument()
  expect(screen.getByText('yt-dlp 2026.12.01 · 已是最新')).toBeInTheDocument()

  // Once up-to-date, the quiet ghost button on the left remains usable and reports already-latest accurately
  const quietUpdateBtn = screen.getByRole('button', { name: '更新 yt-dlp' })
  expect(quietUpdateBtn).toHaveTextContent('更新 yt-dlp')
  await user.click(quietUpdateBtn)
  expect(await screen.findByText('yt-dlp 已是最新版本 (2026.12.01)')).toBeInTheDocument()
})

it('supports preset batch prepare, active variant pause, 2-step delete, yt-dlp success notice, and hides noise disclosures', async () => {
  const richInventory: ResourceInventory = {
    version: '0.1.1',
    platform: 'darwin',
    arch: 'arm64',
    osVersion: '25',
    homeDir: '/Users/test',
    environment: [
      { id: 'python', name: 'Python 3.12', status: 'ready', detail: '/Users/test/YouDub/venv/bin/python' },
      { id: 'ffmpeg', name: 'FFmpeg', status: 'pending', detail: 'FFmpeg binary not found.' },
    ],
    items: [
      { providerId: 'youdub.media', label: 'FFmpeg', automatic: true },
      { providerId: 'whisper', model: 'large-v3-turbo', label: 'Whisper', automatic: true, downloadId: 'whisper:large-v3-turbo' },
      { providerId: 'demucs', model: 'htdemucs', label: 'Demucs', automatic: true, downloadId: 'demucs' },
    ],
    models: [
      { id: 'whisper', name: 'Whisper', variant: 'large-v3-turbo', purpose: '语音识别', received: 0, total: 1618873216, speed: 0, status: 'pending' },
      { id: 'demucs', name: 'Demucs', variant: 'htdemucs', purpose: '人声分离', received: 84141911, total: 84141911, speed: 0, status: 'ready' },
    ],
    ytDlp: { version: '2026.10.26', installed: true },
    storage: {
      dataDir: '/Users/test/YouDub',
      modelsDir: '/Users/test/YouDub/models',
      diskBytes: 159714000,
      proxyConfigured: false,
    },
    llmReady: false,
    whisperVariants: [
      {
        id: 'large-v3-turbo',
        downloadId: 'whisper:large-v3-turbo',
        recommended: true,
        status: 'downloading',
        installed: false,
        received: 500_000_000,
        total: 1618873216,
        speed: 12_500_000,
      },
      {
        id: 'tiny',
        downloadId: 'whisper:tiny',
        recommended: false,
        status: 'ready',
        installed: true,
        received: 75572083,
        total: 75572083,
        diskBytes: 75572083,
      },
    ],
  }
  const richInspection: ResourcePreparation = {
    status: 'missing',
    selections: [],
    environment: richInventory.environment,
    models: richInventory.models,
    requirements: [
      { providerId: 'youdub.media', automatic: true, ready: false, missingPackages: [] },
      { providerId: 'whisper', model: 'large-v3-turbo', automatic: true, ready: false, missingPackages: [] },
      { providerId: 'demucs', model: 'htdemucs', automatic: true, ready: true, missingPackages: [] },
    ],
    storage: richInventory.storage,
    llmReady: false,
  }
  richInspection.entries = resourceEntries({
    ...richInspection,
    requirements: [
      { providerId: 'youdub.media', resourceId: 'ffmpeg', name: 'FFmpeg', automatic: true, ready: false },
      { providerId: 'whisper', resourceId: 'whisper', name: 'Whisper', downloadId: 'whisper:large-v3-turbo', automatic: true, ready: false },
      { providerId: 'demucs', resourceId: 'demucs', name: 'Demucs', downloadId: 'demucs', automatic: true, ready: true },
    ],
  })

  const onOpenSettings = vi.fn()
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/resources') return richInventory
    if (path === '/api/resources/check') return richInspection
    if (path === '/api/resources/yt-dlp/update' && init?.method === 'POST') {
      return { ok: true, version: '2026.11.20' }
    }
    if (path === '/api/resources/prepare' && init?.method === 'POST') return richInspection
    if (path === '/api/resources/action' && init?.method === 'POST') return richInventory
    return richInspection
  })

  render(
    <LanguageProvider>
      <SettingsResources title="资源" request={request as never} onOpenSettings={onOpenSettings} />
    </LanguageProvider>,
  )

  expect(await screen.findByRole('heading', { name: '工作流就绪概览' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '诊断详情' })).not.toBeInTheDocument()
  expect(screen.getByText('未检测到可执行文件')).toBeInTheDocument()
  expect(screen.getByText('/Users/test/YouDub/models')).toBeInTheDocument()

  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: '配置翻译服务…' }))
  expect(onOpenSettings).toHaveBeenCalledWith('llm')

  await user.click(screen.getByRole('button', { name: '存储与代理' }))
  expect(onOpenSettings).toHaveBeenCalledWith('general')

  await user.click(screen.getByRole('button', { name: '更新 yt-dlp' }))
  expect(await screen.findByText('yt-dlp 已更新至 2026.11.20')).toBeInTheDocument()

  // Note: tiny Whisper variant is already ready, so subtitle workflow only needs ffmpeg!
  await user.click(screen.getByRole('button', { name: '一键准备字幕资源' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/api/resources/prepare',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ resourceIds: ['ffmpeg'] }),
      }),
    ),
  )

  // Switch inline variant back and pause active large-v3-turbo Whisper download
  await user.click(screen.getByLabelText('Whisper 模型变体'))
  await user.click(await screen.findByRole('menuitem', { name: 'large-v3-turbo (推荐)' }))
  const pauseButtons = screen.getAllByRole('button', { name: /暂停/ })
  await user.click(pauseButtons[pauseButtons.length - 1]!)
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/api/resources/action',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'pause', resourceId: 'whisper:large-v3-turbo' }),
      }),
    ),
  )

  // Switch inline Whisper variant selector to installed tiny and perform 2-step delete
  await user.click(screen.getByLabelText('Whisper 模型变体'))
  await user.click(await screen.findByRole('menuitem', { name: 'tiny · 可用' }))
  await user.click(screen.getByRole('button', { name: '移除模型权重 Whisper tiny' }))
  await user.click(screen.getByRole('button', { name: '确认移除 Whisper tiny' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/api/resources/action',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'delete', resourceId: 'whisper:tiny' }),
      }),
    ),
  )
})

it('renders MPS backend, live environment preparing banner/activity without pause, and failed yt-dlp retry state', async () => {
  const envInventory: ResourceInventory = {
    version: '0.1.2',
    platform: 'darwin',
    arch: 'arm64',
    osVersion: '27',
    homeDir: '/Users/test',
    environment: [
      { id: 'python', name: 'Python 3.12', status: 'ready', detail: '/Users/test/YouDub/runtime/venv/bin/python' },
      { id: 'ffmpeg', name: 'FFmpeg', status: 'ready', detail: '/Users/test/YouDub/runtime/ffmpeg/ffmpeg' },
      {
        id: 'dependencies',
        name: 'Python 依赖',
        status: 'running',
        phase: 'downloading',
        source: 'mirrors.aliyun.com',
        activity: 'Downloading numpy',
      },
      { id: 'acceleration', name: '计算加速', status: 'ready', detail: 'Backend: mps' },
    ],
    items: [{ providerId: 'youdub.media', label: 'FFmpeg', automatic: true }],
    models: [],
    ytDlp: { version: null, installed: false },
    resources: {
      status: 'preparing',
      selections: [],
      requirements: [],
      environment: [],
      models: [],
      entries: [
        {
          id: 'python',
          name: 'Python 3.12',
          group: 'environment',
          status: 'ready',
          actions: [],
          dependencies: [],
          detail: '/Users/test/YouDub/runtime/venv/bin/python',
        },
        {
          id: 'ffmpeg',
          name: 'FFmpeg',
          group: 'environment',
          status: 'ready',
          actions: [],
          dependencies: [],
          detail: '/Users/test/YouDub/runtime/ffmpeg/ffmpeg',
        },
        {
          id: 'dependencies',
          name: 'Python 依赖',
          group: 'environment',
          status: 'preparing',
          phase: 'downloading',
          actions: [],
          dependencies: [],
          source: 'mirrors.aliyun.com',
          activity: 'Downloading numpy',
        },
        {
          id: 'acceleration',
          name: '计算加速',
          group: 'environment',
          status: 'ready',
          actions: [],
          dependencies: [],
          detail: 'Backend: mps',
        },
        {
          id: 'youdub.download',
          name: 'yt-dlp',
          group: 'environment',
          status: 'failed',
          actions: ['retry'],
          dependencies: ['python'],
          error: 'pypi unreachable',
        },
      ],
    },
  }
  const envInspection: ResourcePreparation = {
    status: 'preparing',
    selections: [],
    environment: envInventory.environment,
    models: [],
    requirements: [{ providerId: 'youdub.media', automatic: true, ready: false, missingPackages: ['numpy'] }],
    entries: envInventory.resources!.entries,
  }
  let failedMode = false
  const request = vi.fn(async (path: string) => {
    if (!failedMode) return path === '/api/resources' ? envInventory : envInspection
    const failedEntries = envInventory.resources!.entries!.map((entry) =>
      entry.id === 'dependencies' ? { ...entry, status: 'ready' as const, activity: undefined, source: undefined } : entry,
    )
    if (path === '/api/resources') {
      return {
        ...envInventory,
        resources: { ...envInventory.resources!, status: 'failed' as const, entries: failedEntries },
      }
    }
    return { ...envInspection, status: 'failed' as const, entries: failedEntries }
  })

  render(<LanguageProvider><SettingsResources title="资源" request={request as never} /></LanguageProvider>)

  expect(await screen.findByText('当前加速后端：MPS')).toBeInTheDocument()
  expect(screen.getByText('正在准备：Python 依赖')).toBeInTheDocument()
  expect(screen.getAllByText('mirrors.aliyun.com · Downloading numpy').length).toBeGreaterThanOrEqual(1)
  expect(screen.queryByRole('button', { name: /暂停/ })).not.toBeInTheDocument()

  failedMode = true
  await userEvent.setup().click(screen.getByRole('button', { name: '重新检测' }))

  const dlRow = screen.getByRole('group', { name: '视频下载工具' })
  await waitFor(() => expect(within(dlRow).getByRole('button', { name: '重试 视频下载工具' })).toBeEnabled())
  expect(within(dlRow).getByText('pypi unreachable')).toBeInTheDocument()
})
