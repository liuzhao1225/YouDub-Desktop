import type { ReactNode } from 'react'
import { Disclosure } from '@/components/ui/disclosure'
import { Check, CircleAlert, Download, Loader2, Pause, Play, RotateCcw } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { useText } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { MessageKey } from '@/locales'
import type { ResourceAction, ResourceEntry } from '@/runtime/setup-contracts'
import { Progress } from './ui/progress'
import { sizeLabel } from '@/lib/format'

const names: Record<string, MessageKey> = { acceleration: 'resource.inference', dependencies: 'resource.pythonDeps', resources: 'setup.resources', 'youdub.download': 'resource.videoDownload' }
const purposes: Record<string, MessageKey> = { whisper: 'setup.whisper', voxcpm: 'setup.voxcpm', demucs: 'setup.demucs', qwen: 'setup.qwen' }
const icons = { prepare: Download, retry: RotateCcw, pause: Pause, resume: Play }
export function ResourceRow({
  entry,
  busy,
  compact = false,
  hideVariant = false,
  subtitle,
  variantControl,
  badge,
  extraAction,
  statusSlot,
  onAction,
}: {
  entry: ResourceEntry
  busy: boolean
  compact?: boolean
  hideVariant?: boolean
  subtitle?: ReactNode
  variantControl?: ReactNode
  badge?: ReactNode
  extraAction?: ReactNode
  statusSlot?: ReactNode
  onAction?: (action: ResourceAction, entry: ResourceEntry) => void
}) {
  const tx = useText()
  const name = names[entry.id] ? tx(names[entry.id]) : entry.name
  const inProgress = entry.status === 'preparing' || entry.status === 'checking'
  const failed = entry.status === 'failed' || entry.status === 'blocked'
  const progress = entry.progress
  const showProgress = progress && (entry.phase === 'downloading' || entry.status === 'paused' || entry.status === 'failed')
  const action = entry.actions[0]
  const Icon = action && icons[action]
  const actionLabel = action
    ? action === 'prepare'
      ? tx(entry.group === 'model' ? 'resource.action.download' : 'resource.action.install')
      : tx(`resource.action.${action}`)
    : ''
  const hasPrepareButton = action === 'prepare' && Boolean(onAction)
  const hideRedundantStatus = !statusSlot && hasPrepareButton && entry.status === 'pending'
  // Subprocess errors prefix stderr with the executable path; keep the cause in
  // the row and retain the complete, unchanged output in the disclosure.
  const errorSummary = entry.error?.replace(/^[^\n]+ exited \([^\n]+\)\.\r?\n/, '').trim().split(/\r?\n/, 1)[0] || entry.error
  const inlineDetail = subtitle ?? entry.detail
  const liveText = inProgress
    ? [entry.source, entry.activity ?? (typeof inlineDetail === 'string' ? inlineDetail : undefined)]
        .filter(Boolean)
        .join(' · ')
    : undefined
  const showDiagnostics = compact
    ? Boolean(entry.error)
    : Boolean(entry.error || entry.detail || entry.source || (progress && !showProgress))
  return <div id={`resource-${entry.id}`} className="min-w-0 space-y-2 py-4" role="group" aria-label={name}>
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-auto space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <p title={[name, entry.variant].filter(Boolean).join(" ")} className="break-words text-sm font-medium">{name}{!variantControl && !hideVariant && entry.variant && <> <span className="ml-1 text-xs font-normal text-muted-foreground">{entry.variant}</span></>}</p>
          {variantControl}
          {badge}
        </div>
        {purposes[entry.id] ? (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{tx(purposes[entry.id])}</span>
            {compact && !showProgress && progress && progress.total > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{sizeLabel(progress.total)}</span>
              </>
            )}
            {subtitle && (
              <>
                <span aria-hidden="true">·</span>
                <span>{subtitle}</span>
              </>
            )}
          </p>
        ) : compact && !entry.error && (inProgress ? Boolean(liveText) : Boolean(inlineDetail)) ? (
          <p
            className="truncate text-xs text-muted-foreground"
            title={inProgress ? liveText : (typeof inlineDetail === 'string' ? inlineDetail : undefined)}
          >
            {inProgress ? liveText : inlineDetail}
          </p>
        ) : null}
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
      {extraAction}
      {action && Icon && onAction && <Button variant="outline" size="sm" disabled={busy} aria-label={`${actionLabel} ${name}`} onClick={() => onAction(action, entry)}><Icon />{actionLabel}</Button>}
      {statusSlot ?? (!hideRedundantStatus && <span role="status" className={cn('inline-flex items-center gap-1.5 text-xs', failed ? 'text-status-danger-fg' : entry.status === 'ready' ? 'text-status-success-fg' : 'text-muted-foreground')}>
        {inProgress ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : entry.status === 'ready' ? <Check aria-hidden="true" className="size-4" /> : failed ? <CircleAlert aria-hidden="true" className="size-4" /> : null}
        {inProgress && entry.phase ? tx(`resource.phase.${entry.phase}`) : tx(`resource.status.${entry.status}`)}
      </span>)}
      </div>
    </div>
    {entry.error && <p className="line-clamp-3 break-words text-xs text-status-danger-fg">{errorSummary}</p>}
    {entry.status === 'blocked' && entry.dependencies.length > 0 && <div className="flex flex-wrap gap-2 text-xs">{entry.dependencies.map(id => <a key={id} className="text-link hover:underline" href={`#resource-${id}`}>{tx('resource.dependency', { name: names[id] ? tx(names[id]) : id === 'python' ? 'Python' : id === 'ffmpeg' ? 'FFmpeg' : id })}</a>)}</div>}
    {showProgress && <div className="space-y-1"><Progress value={progress.total > 0 ? progress.received / progress.total : undefined} label={tx('setup.modelProgress', { model: name })} paused={entry.status === 'paused'} /><p className="text-xs tabular-nums text-muted-foreground">{sizeLabel(progress.received)}{progress.total > 0 && <> / {sizeLabel(progress.total)}</>}{entry.phase === 'downloading' && progress.speed ? ` · ${sizeLabel(progress.speed)}/s` : ''}</p></div>}
    {showDiagnostics && <Disclosure contained={false} title={tx('settings.resources.diagnostics')}><div className="mt-2 space-y-1 break-words">{entry.error && <pre tabIndex={0} aria-label={`${tx('settings.resources.diagnostics')} ${name}`} className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans">{entry.error}</pre>}{entry.detail && entry.detail !== entry.error && <p className="whitespace-pre-wrap">{entry.detail}</p>}{entry.source && <p>{entry.source}</p>}{progress && !showProgress && <p>{sizeLabel(progress.received)}{progress.total > 0 && <> / {sizeLabel(progress.total)}</>}</p>}</div></Disclosure>}
  </div>
}
