import { InlineAlert } from '@/components/inline-alert'
import { type SettingsTab } from '@/components/settings/SettingsModal'
import { Button } from '@/components/ui/button'
import { Disclosure } from '@/components/ui/disclosure'
import { useText } from '@/lib/i18n'
import { useOpenSettings, type SettingsFocusSection } from '@/lib/settings-navigation'
import type { Text } from '@/locales'

export interface TaskErrorInfo {
  code?: string
  message: string
}

type GuidanceAction =
  | { kind: 'settings'; label: string; tab: SettingsTab; section?: SettingsFocusSection }
  | { kind: 'route'; label: string; path: string }

export interface TaskErrorGuidance {
  category:
    | 'youtubeCookiesExpired'
    | 'youtubeCookiesRequired'
    | 'downloadNoFormats'
    | 'downloadNetwork'
    | 'videoUnavailable'
    | 'llmAuth'
    | 'llmQuota'
  title: string
  summary: string
  steps: string[]
  actions: GuidanceAction[]
}

const COOKIE_ROTATED_RE = /cookies are no longer valid|cookies have been rotated/i
const COOKIE_REQUIRED_RE =
  /sign in to confirm you|not a bot|use --cookies|confirm your age|login required|members-only/i
const NO_FORMATS_RE =
  /no video formats found|requested format is not available|n challenge solving failed|signature extraction failed/i
const VIDEO_UNAVAILABLE_RE =
  /video(?: is)? unavailable|private video|this video is private|this video has been removed|no longer available|not available in your country|not made this video available|geo-restricted|account associated with this video has been terminated/i
const DOWNLOAD_NETWORK_RE =
  /unable to download webpage|cannot connect to proxy|proxy error|timed out|connection reset|connection refused|getaddrinfo|name resolution|http error 429|too many requests/i
const LLM_AUTH_RE = /(?:invalid|incorrect)\s+api[\s_-]*key|authentication\s+fail|401\s+unauthorized/i
const LLM_QUOTA_RE = /insufficient[\s_-]*(?:quota|balance|credit)|quota[\s_-]*exceeded|rate[\s_-]*limit/i

/** Resolve actionable guidance for recognizable task or step failures. */
export function resolveTaskErrorGuidance(
  error: TaskErrorInfo,
  tx: Text,
): TaskErrorGuidance | null {
  const code = (error.code ?? '').trim()
  const codeLower = code.toLowerCase()
  const message = error.message ?? ''

  if (code === 'YOUTUBE_COOKIES_EXPIRED' || COOKIE_ROTATED_RE.test(message)) {
    return {
      category: 'youtubeCookiesExpired',
      title: tx('task.error.youtubeCookiesExpired.title'),
      summary: tx('task.error.youtubeCookiesExpired.summary'),
      steps: [
        tx('task.error.youtubeCookiesExpired.step1'),
        tx('task.error.youtubeCookiesExpired.step2'),
        tx('task.error.youtubeCookiesExpired.step3'),
      ],
      actions: [
        {
          kind: 'settings',
          label: tx('task.error.youtubeCookiesExpired.action'),
          tab: 'general',
          section: 'youtube-cookies',
        },
      ],
    }
  }

  if (code === 'YOUTUBE_COOKIES_REQUIRED' || COOKIE_REQUIRED_RE.test(message)) {
    return {
      category: 'youtubeCookiesRequired',
      title: tx('task.error.youtubeCookiesRequired.title'),
      summary: tx('task.error.youtubeCookiesRequired.summary'),
      steps: [
        tx('task.error.youtubeCookiesRequired.step1'),
        tx('task.error.youtubeCookiesRequired.step2'),
        tx('task.error.youtubeCookiesRequired.step3'),
      ],
      actions: [
        {
          kind: 'settings',
          label: tx('task.error.youtubeCookiesRequired.action'),
          tab: 'general',
          section: 'youtube-cookies',
        },
      ],
    }
  }

  if (code === 'DOWNLOAD_NO_FORMATS' || NO_FORMATS_RE.test(message)) {
    return {
      category: 'downloadNoFormats',
      title: tx('task.error.downloadNoFormats.title'),
      summary: tx('task.error.downloadNoFormats.summary'),
      steps: [
        tx('task.error.downloadNoFormats.step1'),
        tx('task.error.downloadNoFormats.step2'),
        tx('task.error.downloadNoFormats.step3'),
      ],
      actions: [
        {
          kind: 'route',
          label: tx('task.error.downloadNoFormats.primaryAction'),
          path: '/resources',
        },
        {
          kind: 'settings',
          label: tx('task.error.downloadNoFormats.secondaryAction'),
          tab: 'general',
          section: 'youtube-cookies',
        },
      ],
    }
  }

  if (code === 'VIDEO_UNAVAILABLE' || VIDEO_UNAVAILABLE_RE.test(message)) {
    return {
      category: 'videoUnavailable',
      title: tx('task.error.videoUnavailable.title'),
      summary: tx('task.error.videoUnavailable.summary'),
      steps: [],
      actions: [
        {
          kind: 'settings',
          label: tx('task.error.videoUnavailable.action'),
          tab: 'general',
          section: 'proxy',
        },
      ],
    }
  }

  if (code === 'DOWNLOAD_NETWORK_ERROR' || DOWNLOAD_NETWORK_RE.test(message)) {
    return {
      category: 'downloadNetwork',
      title: tx('task.error.downloadNetwork.title'),
      summary: tx('task.error.downloadNetwork.summary'),
      steps: [
        tx('task.error.downloadNetwork.step1'),
        tx('task.error.downloadNetwork.step2'),
      ],
      actions: [
        {
          kind: 'settings',
          label: tx('task.error.downloadNetwork.action'),
          tab: 'general',
          section: 'proxy',
        },
      ],
    }
  }

  if (codeLower === 'llm_auth' || code === 'LLM_AUTH_ERROR' || LLM_AUTH_RE.test(message)) {
    return {
      category: 'llmAuth',
      title: tx('task.error.llmAuth.title'),
      summary: tx('task.error.llmAuth.summary'),
      steps: [],
      actions: [
        {
          kind: 'settings',
          label: tx('task.error.llmAuth.action'),
          tab: 'llm',
        },
      ],
    }
  }

  if (
    codeLower === 'llm_quota' ||
    codeLower === 'llm_rate_limit' ||
    code === 'LLM_QUOTA_EXCEEDED' ||
    LLM_QUOTA_RE.test(message)
  ) {
    return {
      category: 'llmQuota',
      title: tx('task.error.llmQuota.title'),
      summary: tx('task.error.llmQuota.summary'),
      steps: [],
      actions: [
        {
          kind: 'settings',
          label: tx('task.error.llmQuota.action'),
          tab: 'llm',
        },
      ],
    }
  }

  return null
}

/** Return a concise single-line title for cards and step rows when an error matches a known category. */
export function taskErrorSummary(error: TaskErrorInfo, tx: Text): string {
  return resolveTaskErrorGuidance(error, tx)?.title ?? error.message
}

/** Display localized troubleshooting steps, direct settings/page actions, and collapsible raw diagnostics. */
export function TaskErrorAlert({
  error,
  navigate,
  className,
}: {
  error: TaskErrorInfo
  navigate?: (path: string) => void
  className?: string
}) {
  const tx = useText()
  const openSettings = useOpenSettings()
  const guidance = resolveTaskErrorGuidance(error, tx)

  if (!guidance) {
    return <InlineAlert className={className}>{error.message}</InlineAlert>
  }

  const visibleActions = guidance.actions.filter(
    (action) =>
      (action.kind === 'settings' && openSettings !== null) ||
      (action.kind === 'route' && navigate !== undefined),
  )

  return (
    <InlineAlert className={className}>
      <div className="space-y-2.5 text-sm">
        <p className="font-semibold">{guidance.title}</p>
        <p className="text-xs leading-relaxed opacity-90">{guidance.summary}</p>
        {guidance.steps.length > 0 && (
          <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed opacity-90">
            {guidance.steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        )}
        {visibleActions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {visibleActions.map((action, index) => (
              <Button
                key={action.label}
                type="button"
                size="sm"
                variant={index === 0 ? 'secondary' : 'outline'}
                onClick={() => {
                  if (action.kind === 'settings') {
                    openSettings?.(action.tab, action.section)
                  } else {
                    navigate?.(action.path)
                  }
                }}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
        {error.message && (
          <Disclosure contained={false} title={tx('task.error.rawDetails')}>
            <pre className="whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
              {error.message}
            </pre>
          </Disclosure>
        )}
      </div>
    </InlineAlert>
  )
}
