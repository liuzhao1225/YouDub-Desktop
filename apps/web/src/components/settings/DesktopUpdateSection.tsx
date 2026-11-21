import { ExternalLink, Loader2, RefreshCw } from '@/lib/icons'
import { Button, buttonVariants } from '@/components/ui/button'
import { Tag } from '@/components/ui/tag'
import { RELEASES_PAGE_URL } from '@/lib/desktop-bridge'
import { useText } from '@/lib/i18n'
import { formatDesktopUpdateText, useDesktopUpdates } from '@/lib/use-desktop-updates'
import { cn } from '@/lib/utils'

const STATUS_TEXT_CLASS: Record<string, string> = {
  error: 'text-destructive',
  downloaded: 'text-status-success-fg',
}

export function DesktopUpdateSection() {
  const tx = useText()
  const updates = useDesktopUpdates()
  if (!updates.supported) return null

  const status = updates.state?.status

  function renderAction() {
    if (status === 'downloaded') {
      return (
        <Button type="button" size="sm" onClick={() => void updates.quitAndInstall()}>
          <RefreshCw />
          {tx('app.updates.readyToInstall')}
        </Button>
      )
    }
    if (status === 'checking' || status === 'downloading') {
      return (
        <Button type="button" variant="outline" size="sm" disabled>
          <Loader2 className="animate-spin" />
          {status === 'checking' ? tx('app.updates.checking') : tx('app.updates.downloading')}
        </Button>
      )
    }
    if (status === 'unsupported') {
      const reason = updates.state?.reason
      if (reason !== 'windows-portable' && reason !== 'unsupported-platform') return null
      return (
        <a
          href={RELEASES_PAGE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <ExternalLink />
          {tx('app.updates.openDownloads')}
        </a>
      )
    }
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => void updates.checkForUpdates()}>
        <RefreshCw />
        {status === 'error' ? tx('app.updates.retry') : tx('app.updates.check.for.updates')}
      </Button>
    )
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 py-4">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{tx('settings.general.updates')}</span>
          {updates.version && (
            <Tag tone="neutral">
              {tx('settings.general.currentVersion', { version: updates.version })}
            </Tag>
          )}
        </div>
        <p className={cn('text-xs break-words', (status && STATUS_TEXT_CLASS[status]) || 'text-muted-foreground')}>
          {formatDesktopUpdateText(updates.state, tx)}
        </p>
      </div>
      <div className="shrink-0">{renderAction()}</div>
    </div>
  )
}
