import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsActionContext } from '@/lib/settings-navigation'
import { LanguageProvider } from '@/test/language-provider'
import { TaskErrorAlert, taskErrorSummary } from './task-error-guidance'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('TaskErrorAlert and taskErrorSummary', () => {
  it('renders actionable cookie setup guidance for YOUTUBE_COOKIES_REQUIRED and hides raw yt-dlp details behind disclosure', async () => {
    const openSettings = vi.fn()
    const rawMsg =
      "DownloadError: ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication."

    render(
      <SettingsActionContext.Provider value={openSettings}>
        <LanguageProvider>
          <TaskErrorAlert error={{ code: 'YOUTUBE_COOKIES_REQUIRED', message: rawMsg }} />
        </LanguageProvider>
      </SettingsActionContext.Provider>,
    )

    expect(screen.getByText('YouTube 需要登录态验证（Cookies）')).toBeInTheDocument()
    expect(screen.getByText(/导出 cookies\.txt/)).toBeInTheDocument()
    expect(screen.queryByText(/--cookies-from-browser/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '前往配置 YouTube Cookies' }))
    expect(openSettings).toHaveBeenCalledWith('general', 'youtube-cookies')

    await userEvent.click(screen.getByRole('button', { name: '查看原始错误信息' }))
    expect(screen.getByText(rawMsg)).toBeVisible()
  })

  it('also guides legacy STAGE_FAILED bot-check errors cleanly', () => {
    const openSettings = vi.fn()
    render(
      <SettingsActionContext.Provider value={openSettings}>
        <LanguageProvider>
          <TaskErrorAlert
            error={{
              code: 'STAGE_FAILED',
              message: "ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies for the authentication.",
            }}
          />
        </LanguageProvider>
      </SettingsActionContext.Provider>,
    )

    expect(screen.getByText('YouTube 需要登录态验证（Cookies）')).toBeInTheDocument()
    expect(
      taskErrorSummary(
        {
          code: 'STAGE_FAILED',
          message: "Sign in to confirm you're not a bot",
        },
        (key) => (key === 'task.error.youtubeCookiesRequired.title' ? 'YouTube 需要登录态验证（Cookies）' : key),
      ),
    ).toBe('YouTube 需要登录态验证（Cookies）')
  })

  it('guides expired cookies, missing formats, network failures, and LLM auth errors to exact targets', async () => {
    const user = userEvent.setup()
    const openSettings = vi.fn()
    const navigate = vi.fn()

    const { rerender } = render(
      <SettingsActionContext.Provider value={openSettings}>
        <LanguageProvider>
          <TaskErrorAlert
            error={{ code: 'YOUTUBE_COOKIES_EXPIRED', message: 'Sign in to confirm you are not a bot' }}
            navigate={navigate}
          />
        </LanguageProvider>
      </SettingsActionContext.Provider>,
    )
    expect(screen.getByText('当前 YouTube Cookies 已失效或需要重新验证')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '更新 YouTube Cookies' }))
    expect(openSettings).toHaveBeenLastCalledWith('general', 'youtube-cookies')

    rerender(
      <SettingsActionContext.Provider value={openSettings}>
        <LanguageProvider>
          <TaskErrorAlert
            error={{ code: 'DOWNLOAD_NO_FORMATS', message: 'No video formats found!' }}
            navigate={navigate}
          />
        </LanguageProvider>
      </SettingsActionContext.Provider>,
    )
    await user.click(screen.getByRole('button', { name: '前往更新 yt-dlp' }))
    expect(navigate).toHaveBeenLastCalledWith('/resources')
    await user.click(screen.getByRole('button', { name: '检查 YouTube Cookies' }))
    expect(openSettings).toHaveBeenLastCalledWith('general', 'youtube-cookies')

    rerender(
      <SettingsActionContext.Provider value={openSettings}>
        <LanguageProvider>
          <TaskErrorAlert
            error={{ code: 'DOWNLOAD_NETWORK_ERROR', message: 'Unable to download webpage: timed out' }}
            navigate={navigate}
          />
        </LanguageProvider>
      </SettingsActionContext.Provider>,
    )
    await user.click(screen.getByRole('button', { name: '检查代理设置' }))
    expect(openSettings).toHaveBeenLastCalledWith('general', 'proxy')

    rerender(
      <SettingsActionContext.Provider value={openSettings}>
        <LanguageProvider>
          <TaskErrorAlert
            error={{ code: 'llm_auth', message: '401 Unauthorized: invalid API key' }}
            navigate={navigate}
          />
        </LanguageProvider>
      </SettingsActionContext.Provider>,
    )
    await user.click(screen.getByRole('button', { name: '前往模型设置' }))
    expect(openSettings).toHaveBeenLastCalledWith('llm', undefined)

    rerender(
      <SettingsActionContext.Provider value={openSettings}>
        <LanguageProvider>
          <TaskErrorAlert
            error={{
              code: 'STAGE_FAILED',
              message: 'DownloadError: ERROR: [youtube] aaaaaaaaaaa: This video is unavailable',
            }}
            navigate={navigate}
          />
        </LanguageProvider>
      </SettingsActionContext.Provider>,
    )
    expect(screen.getByText('该视频无法访问或受地区/权限限制')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '检查代理设置' }))
    expect(openSettings).toHaveBeenLastCalledWith('general', 'proxy')
  })

  it('keeps generic unknown error messages unchanged', () => {
    render(
      <LanguageProvider>
        <TaskErrorAlert error={{ code: 'FAILED', message: 'Fifth node unavailable' }} />
      </LanguageProvider>,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Fifth node unavailable')
    expect(screen.queryByRole('button', { name: '查看原始错误信息' })).not.toBeInTheDocument()
  })
})
