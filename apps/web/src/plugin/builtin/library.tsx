import { Surface, surfaceVariants } from '@/components/ui/surface'
import { Progress } from '@/components/ui/progress'
import { Disclosure } from '@/components/ui/disclosure'
import { Menu } from '@/components/ui/primitives/Menu'
import { type Bindings } from '../sdk'
import { useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, AudioLines, Captions, Check, ChevronDown, Download, FileText, Film, Loader2, RotateCw, Search, Square, Trash2 } from '@/lib/icons'
import { Link, text, type PanelProps, type RouteProps, type TaskAction, type TaskNodeDetail, type TaskPage, type TaskView } from '../sdk'
import { Input } from '@/components/ui/input'
import { taskNeedsPolling } from '../runtime/query'
import { useI18n, useText } from '@/lib/i18n'
import { useReleaseMediaOnUnmount } from '@/lib/media'
import { formatBytes, formatDateTime } from '@/lib/format'
import { assetUrl } from '@/lib/asset-url'
import { cn } from '@/lib/utils'
import { TaskCover } from '@/components/task-cover'
import { TaskLog } from '@/components/task-log'
import { VideoPlayer } from '@/components/video-player'
import { InlineAlert } from '@/components/inline-alert'
import { TaskErrorAlert, taskErrorSummary } from '@/components/task-error-guidance'
import { Button, buttonVariants } from '@/components/ui/button'
import { Modal } from '../../components/ui/harness-primitives'
import { Page, PageHeader } from '@/components/page-layout'
import { workflowTemplateTitle, workflowPortLabel } from './workflow-utils'
import { STATUS_LABELS, TaskProgress, TaskState, taskDisplayName, taskProgressMessage } from './task-status'

const SECONDARY_STATUSES = ['queued', 'waiting', 'cancelling', 'cancelled'] as const

export function Library({ useQuery, navigate }: Bindings<'useQuery' | 'navigate'>) {
  const tx = useText(), { language } = useI18n()
  const [status, setStatus] = useState(''), [search, setSearch] = useState(''), [offset, setOffset] = useState(0)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const { data, error, refresh } = useQuery<TaskPage>(`/api/tasks?limit=20&offset=${offset}${status ? `&status=${status}` : ''}`, 3000)
  const items = (data?.items ?? []).filter((task) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return `${taskDisplayName(task)} ${task.sourceName ?? ''} ${task.workflowId}`.toLowerCase().includes(q)
  })
  const quickFilters = [
    { id: '', label: tx('library.all.statuses') },
    { id: 'running', label: tx(STATUS_LABELS.running) },
    { id: 'paused', label: tx(STATUS_LABELS.paused) },
    { id: 'succeeded', label: tx(STATUS_LABELS.succeeded) },
    { id: 'failed', label: tx(STATUS_LABELS.failed) },
  ]
  const secondaryActive = (SECONDARY_STATUSES as readonly string[]).includes(status)
  return <Page>
    <PageHeader title={tx("library.library")} actions={<Button size="sm" onClick={() => navigate('/')}>{tx("library.new.task")}</Button>} />
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-full shrink-0 sm:w-64">
        <Input icon={<Search className="size-4" />} aria-label={tx('library.search')} placeholder={tx('library.search')} value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      <div className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-muted/60 p-1" role="group">
        {quickFilters.map((filter) => {
          const active = status === filter.id
          return (
            <button
              key={filter.id || 'all'}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setMoreMenuOpen(false)
                setStatus(filter.id)
                setOffset(0)
              }}
              className={cn(
                'inline-flex h-7 items-center justify-center rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors',
                active
                  ? 'bg-background text-foreground shadow-xs'
                  : 'bg-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {filter.label}
            </button>
          )
        })}
        <Menu
          open={moreMenuOpen}
          onClose={() => setMoreMenuOpen(false)}
          portal
          autoFocus
          selectedId={secondaryActive ? status : undefined}
          items={SECONDARY_STATUSES.map((item) => ({ id: item, label: tx(STATUS_LABELS[item]) }))}
          onSelect={(next) => {
            setStatus(next)
            setOffset(0)
            setMoreMenuOpen(false)
          }}
          anchor={
            <button
              type="button"
              aria-label={tx('library.task.status')}
              aria-haspopup="menu"
              aria-expanded={moreMenuOpen}
              onClick={() => setMoreMenuOpen((current) => !current)}
              className={cn(
                'inline-flex h-7 w-[6.75rem] shrink-0 items-center justify-between gap-1 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors',
                secondaryActive
                  ? 'bg-background text-foreground shadow-xs'
                  : 'bg-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="min-w-0 flex-1 truncate text-left">
                {secondaryActive ? tx(STATUS_LABELS[status]) : tx('library.moreStatuses')}
              </span>
              <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
            </button>
          }
        />
      </div>
      <div className="ml-auto flex shrink-0 items-center">
        <Button variant="ghost" size="sm" onClick={refresh}><RotateCw />{tx("library.refresh")}</Button>
      </div>
    </div>
    {error && <InlineAlert>{error}</InlineAlert>}
    {!data && !error && <Surface as="div" role="status" className="border-dashed p-12 text-center text-sm text-muted-foreground">{tx("library.loading")}</Surface>}
    {data && !items.length && <Surface as="div" className="border-dashed p-12 text-center text-muted-foreground">{search.trim() ? tx('workflow.task.no.matching.text') : offset > 0 ? tx("library.no.tasks.on.this.page") : status ? tx("library.no.tasks.with.this.status") : tx("library.no.tasks.yet")}</Surface>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{items.map((task) => {
      const pausedStep = task.status === 'paused' ? task.steps.find((step) => step.status === 'awaiting_review') : undefined
      return <Link key={task.id} href={`/tasks/${task.id}`} className={cn(surfaceVariants({ interactive: true }), "group flex flex-col overflow-hidden")}>
        <TaskCover id={task.id} src={task.cover?.url ? assetUrl(task.cover.url) : undefined} processing={task.status === 'running'} size="lg" className="rounded-none" />
        <div className="flex flex-1 flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-3"><h2 title={taskDisplayName(task)} className="line-clamp-2 min-w-0 break-words font-medium">{taskDisplayName(task)}</h2><TaskState status={task.status} /></div>
          <TaskProgress task={task} />
          {pausedStep && <p className="text-xs font-medium text-status-warning-fg">{text(pausedStep.label, language)} · {tx('library.review.open')}</p>}
          {task.error && <p className="line-clamp-2 break-words text-xs text-status-danger-fg">{taskErrorSummary(task.error, tx)}</p>}
          <time dateTime={task.createdAt} className="mt-auto text-xs text-muted-foreground">{formatDateTime(task.createdAt)}</time>
        </div>
      </Link>
    })}</div>
    {(offset > 0 || data?.hasMore) && <div className="flex justify-end gap-2"><Button variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>{tx("library.previous")}</Button><Button variant="outline" disabled={!data?.hasMore} onClick={() => setOffset(offset + 20)}>{tx("library.next")}</Button></div>}
  </Page>
}

function Actions({ heading, task, refresh, prepareDelete, request, navigate }: PanelProps & { heading: (actions: ReactNode) => ReactNode; prepareDelete(value: boolean): void } & Bindings<'request' | 'navigate'>) {
  const tx = useText()
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmDelete, setConfirmDelete] = useState(false)
  async function act(action: TaskAction) {
    if (busy) return
    setBusy(true); setError('')
    try {
      await request(`/api/tasks/${task.id}${action === 'delete' ? `?expectedAttempt=${task.attempt}` : `/${action}`}`, { method: action === 'delete' ? 'DELETE' : 'POST', ...(action === 'delete' ? {} : { body: JSON.stringify({ expectedAttempt: task.attempt, ...(task.graphSnapshot ? { expectedTaskRevision: task.revision } : {}) }) }) })
      if (action === 'delete') navigate('/tasks'); else refresh()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  return <div className="space-y-4">{heading(<>{task.allowedActions.includes('cancel') && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('cancel')}><Square />{tx("library.cancel.task")}</Button>}{task.allowedActions.includes('retry') && <Button size="sm" disabled={busy} onClick={() => void act('retry')}><RotateCw />{tx("library.continue.task")}</Button>}{task.allowedActions.includes('delete') && <Button size="sm" variant={confirmDelete ? 'destructive' : 'ghost'} disabled={busy} onClick={() => { if (confirmDelete) void act('delete'); else { setConfirmDelete(true); prepareDelete(true) } }}><Trash2 />{confirmDelete ? tx("library.delete.task.and.files") : tx("library.delete.task")}</Button>}{confirmDelete && <Button size="sm" variant="ghost" onClick={() => { setConfirmDelete(false); prepareDelete(false) }}>{tx("library.keep.task")}</Button>}</>)}{task.mayStillRun && <InlineAlert tone="warning">{tx("library.the.remote.request.may.still.be.running")}</InlineAlert>}{error && <InlineAlert>{error}</InlineAlert>}</div>
}

export function TaskDetail({ params, request, navigate, useQuery, useSlot }: RouteProps & Bindings<'request' | 'navigate' | 'useQuery' | 'useSlot'>) {
  const tx = useText(), { language } = useI18n()
  const { data: task, error, refresh } = useQuery<TaskView>(`/api/tasks/${encodeURIComponent(params.id)}`, 1500, taskNeedsPolling)
  const panels = useSlot('task.detail.panels'), actions = useSlot('task.detail.actions')
  const [mediaReleased, setMediaReleased] = useState(false), [showLog, setShowLog] = useState(false)
  const [approveBusy, setApproveBusy] = useState(false), [approveError, setApproveError] = useState('')
  const loadError = error && <div className="space-y-2"><InlineAlert>{error}</InlineAlert><Button variant="outline" onClick={refresh}>{tx("library.reload.task")}</Button></div>
  if (!task) return <Page>{loadError || <p role="status">{tx("library.loading")}</p>}</Page>
  const video = task.outputs.find((output) => output.mimeType?.startsWith('video/'))
  const completed = task.steps.filter((step) => step.status === 'completed').length
  const reviewStep = ['queued', 'running', 'waiting', 'paused'].includes(task.status)
    ? task.steps.find((step) => step.status === 'awaiting_review')
    : undefined
  async function quickApprove(nodeId: string) {
    if (approveBusy) return
    setApproveBusy(true); setApproveError('')
    try {
      const detail = await request<TaskNodeDetail>(`/api/tasks/${encodeURIComponent(task!.id)}/nodes/${encodeURIComponent(nodeId)}`)
      await request(`/api/tasks/${encodeURIComponent(task!.id)}/nodes/${encodeURIComponent(nodeId)}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          actionId: crypto.randomUUID(),
          expectedAttempt: detail.attempt,
          expectedTaskRevision: detail.taskRevision,
          expectedOutputRevision: detail.outputRevision,
        }),
      })
      refresh()
    } catch (failure) {
      setApproveError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setApproveBusy(false)
    }
  }
  const stepList = <ol className="space-y-4">{task.steps.map((step) => <li key={step.id} className="flex gap-3">
    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent">{step.status === 'completed' ? <Check className="size-4 text-status-success-fg" /> : step.status === 'running' ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4 text-muted-foreground" />}</span>
    <div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2">{task.graphSnapshot ? <Link href={`/tasks/${task.id}/nodes/${step.id}`} className="text-sm font-medium text-link">{text(step.label, language)}</Link> : <span className="text-sm font-medium">{text(step.label, language)}</span>}<TaskState status={step.status} /></div>
      {step.progress != null && step.status === 'running' && <Progress label={`${text(step.label, language)} ${tx("library.progress")}`} value={step.progress} />}
      {step.message && <p className="mt-1 break-words text-xs text-muted-foreground">{taskProgressMessage(step.message, tx)}</p>}{step.error && <p className="mt-1 text-xs text-status-danger-fg">{taskErrorSummary(step.error, tx)}</p>}
    </div>
  </li>)}</ol>
  return <Page>
    <Actions request={request} navigate={navigate} task={task} refresh={refresh} prepareDelete={setMediaReleased} heading={(actions) => <PageHeader title={taskDisplayName(task)} badge={<TaskState status={task.status} />} actions={actions} leading={<Button size="icon-sm" variant="ghost" aria-label={tx("library.library")} title={tx("library.library")} onClick={() => navigate('/tasks')}><ArrowLeft /></Button>}>
      <p className="mt-1 text-xs text-muted-foreground">{taskDisplayName(task) !== (task.graphSnapshot?.title || task.workflowId) && <>{task.graphSnapshot ? workflowTemplateTitle(task.graphSnapshot, tx) : task.workflowId} · </>}<time dateTime={task.createdAt}>{formatDateTime(task.createdAt)}</time></p>
    </PageHeader>} />
    {loadError}{approveError && <InlineAlert>{approveError}</InlineAlert>}{task.error && <TaskErrorAlert error={task.error} navigate={navigate} />}
    {reviewStep && <Surface as="section" className="flex flex-wrap items-center justify-between gap-3 border-status-warning/35 bg-status-warning/10 p-4">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium">{tx('library.review.readyTitle', { step: text(reviewStep.label, language) })}</p>
        <p className="text-xs text-muted-foreground">{tx('library.review.readyHint')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => navigate(`/tasks/${task.id}/nodes/${reviewStep.id}`)}>{tx('library.review.open')}</Button>
        <Button size="sm" variant="outline" disabled={approveBusy} onClick={() => void quickApprove(reviewStep.id)}>{approveBusy ? <Loader2 className="animate-spin" /> : <Check />}{tx('library.review.approveDirect')}</Button>
      </div>
    </Surface>}
    {actions.map(({ id, component: Component }) => <Component key={id} task={task} refresh={refresh} />)}
    {video && !mediaReleased && <div className="overflow-hidden rounded-xl border border-border bg-black"><VideoPlayer src={assetUrl(video.url)} /></div>}
    {!!task.outputs.length && <section className="space-y-4"><h2 className="font-semibold">{tx("library.generated.files")}</h2><Surface as="ol" className="m-0 list-none divide-y divide-border overflow-hidden p-0">{task.outputs.map((output) => {
      const label = output.label || output.name || output.id
      const displayLabel = task.graphSnapshot ? workflowPortLabel(task.graphSnapshot, { id: output.id, label }, tx) : label
      const audio = output.mimeType?.startsWith('audio/'), textual = output.mimeType?.startsWith('text/') || output.mimeType === 'application/x-subrip'
      const Icon = output.mimeType?.startsWith('video/') ? Film : audio ? AudioLines : textual ? Captions : FileText
      const outputUrl = assetUrl(output.url)
      return <li key={output.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground"><Icon className="size-4" /></span>
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{displayLabel}</p>{output.size !== undefined && <p className="text-xs text-muted-foreground">{formatBytes(output.size)}</p>}</div>
        {!mediaReleased && audio && <AudioOutput src={outputUrl} className="order-last basis-full @2xl/page:order-none @2xl/page:basis-auto @2xl/page:w-80" />}
        {textual && <TextPreview path={`/api/tasks/${encodeURIComponent(task.id)}/files/${encodeURIComponent(output.id)}`} url={outputUrl} title={displayLabel} subtitle={output.mimeType === 'application/x-subrip' || /\.srt$/i.test(output.name ?? '')} useQuery={useQuery} />}
        <a href={outputUrl} download className={buttonVariants({ variant: 'ghost', size: 'icon' })} title={`${tx("library.download")} ${displayLabel}`} aria-label={`${tx("library.download")} ${displayLabel}`}><Download className="size-4" /></a>
      </li>
    })}</Surface></section>}
    {panels.map(({ id, component: Component }) => <Component key={id} task={task} refresh={refresh} />)}
    {task.graphSnapshot ? <Disclosure open={['running', 'waiting', 'paused', 'failed'].includes(task.status)} contained={true} title={`${tx("library.step.list")} · ${completed}/${task.steps.length}`}><div className="mt-4">{stepList}</div></Disclosure> : <Surface as="section" className="p-4"><h2 className="mb-4 font-semibold">{tx("library.steps")} · {completed}/{task.steps.length}</h2>{stepList}</Surface>}
    <Disclosure onOpenChange={setShowLog} contained={true} title={tx("library.task.log")}>{showLog && <TaskLog taskId={task.id} active={taskNeedsPolling(task)} request={request} />}</Disclosure>
  </Page>
}
function AudioOutput({ src, className }: { src: string; className?: string }) {
  const ref = useRef<HTMLAudioElement>(null)
  useReleaseMediaOnUnmount(ref, src)
  return <audio ref={ref} controls src={src} className={cn('h-10 w-full', className)} />
}
/** Subtitle files are served as downloads, so preview their text in place instead of opening the raw file. */
function TextPreview({ path, url, title, subtitle, useQuery }: { path: string; url: string; title: string; subtitle: boolean } & Bindings<'useQuery'>) {
  const tx = useText()
  const [open, setOpen] = useState(false)
  return <>
    <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>{tx("library.preview.text")}</Button>
    {open && <Modal open onClose={() => setOpen(false)} title={title} closeLabel={tx("library.close")} className="w-[min(40rem,100%)]"
      footer={<><a href={url} download className={cn(buttonVariants({ variant: 'outline' }), 'no-underline')}><Download />{tx("library.download")}</a><Button variant="outline" onClick={() => setOpen(false)}>{tx("library.close")}</Button></>}>
      <TextPreviewBody path={path} subtitle={subtitle} useQuery={useQuery} />
    </Modal>}
  </>
}
function TextPreviewBody({ path, subtitle, useQuery }: { path: string; subtitle: boolean } & Bindings<'useQuery'>) {
  const tx = useText()
  const { data, error, refresh } = useQuery<string>(path)
  if (error) return <div className="space-y-2"><InlineAlert>{error}</InlineAlert><Button size="sm" variant="outline" onClick={refresh}>{tx("library.reload.preview")}</Button></div>
  return <div className="max-h-[60dvh] min-h-24 overflow-auto rounded-lg bg-muted p-4 text-sm">{data == null ? <p role="status" className="text-muted-foreground">{tx("library.loading")}</p> : <SubtitleText content={data} subtitle={subtitle} />}</div>
}
function SubtitleText({ content, subtitle }: { content: string; subtitle: boolean }) {
  if (!subtitle) return <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{content}</pre>
  return <ol className="m-0 list-none space-y-3 p-0">{content.trim().split(/\r?\n\s*\r?\n/).map((block, index) => {
    const lines = block.split(/\r?\n/), timing = /^\d+$/.test(lines[0]) ? 1 : 0
    const timed = /^\d{2,}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2,}:\d{2}:\d{2}[,.]\d{3}(?:\s.*)?$/.test(lines[timing] ?? '') && lines.length > timing + 1
    return <li key={index} className="grid gap-0.5">{timed ? <><span className="font-mono text-xs text-muted-foreground tabular-nums">{lines[timing].replace('-->', '→')}</span><span className="break-words whitespace-pre-line">{lines.slice(timing + 1).join('\n')}</span></> : <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{block}</pre>}</li>
  })}</ol>
}
