import { Surface, surfaceVariants } from '@/components/ui/surface'
import { type Bindings } from '../sdk'
import { type ReactNode } from 'react'
import { ArrowRight, ChevronRight } from '@/lib/icons'
import { Link, type TaskPage } from '../sdk'
import { useI18n, useText } from '@/lib/i18n'
import { formatDateTime } from '@/lib/format'
import { assetUrl } from '@/lib/asset-url'
import { cn } from '@/lib/utils'
import { BrandMark } from '@/components/brand/brand-mark'
import { TaskCover } from '@/components/task-cover'
import { PageContainer } from '@/components/page-layout'
import { InlineAlert } from '@/components/inline-alert'
import { Button } from '@/components/ui/button'
import { ACTIVE_STATUSES, TaskProgress, TaskState, taskDisplayName } from './task-status'
import { StudioDraftStore } from '@/runtime/studio-draft'
import { GraphStudio } from './workflows'

function TaskSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const tx = useText()
  return <section aria-labelledby={id}><div className="mb-4 flex items-center justify-between gap-4"><h2 id={id} className="text-base font-semibold tracking-tight">{title}</h2><Link href="/tasks" className="inline-flex items-center gap-1 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground">{tx("studio.view.all")}<ChevronRight className="size-4" /></Link></div>{children}</section>
}
export function Studio({ draftStore, request, navigate, useQuery, useSlot, useWorkflowDocuments, useWorkflowResources }: { draftStore: StudioDraftStore } & Bindings<'request' | 'navigate' | 'useQuery' | 'useSlot' | 'useWorkflowDocuments' | 'useWorkflowResources'>) {
  const tx = useText()
  const { data: tasks, error: taskError, refresh: refreshTasks } = useQuery<TaskPage>('/api/tasks?limit=12&offset=0', 3000)
  const { language, t } = useI18n()
  const active = tasks?.items.filter((task) => ACTIVE_STATUSES.has(task.status)) ?? []
  const awaitingReview = active.flatMap((task) => task.steps.filter((step) => step.status === 'awaiting_review').map((step) => ({ task, step })))
  const processing = active.filter((task) => task.status !== 'paused')
  const recent = tasks?.items.filter((task) => !ACTIVE_STATUSES.has(task.status)).slice(0, 6) ?? []
  return <main>
    <section className="relative isolate flex min-h-[calc(100dvh-var(--dsh-frame-top-clearance,3.5rem))] flex-col justify-center overflow-hidden border-b border-border lg:min-h-[calc(100dvh-var(--dsh-frame-top-clearance,0px))]">
      <div aria-hidden="true" className="aurora -z-10" />
      <div aria-hidden="true" className="bg-dot-grid absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]" />
      <PageContainer className="pt-[var(--page-top)] pb-12">
        <header className="flex animate-rise flex-col items-center text-center [--hero-title-size:clamp(28px,4vw,48px)]">
          {/* The 300-unit mark body matches the title size; the 412-unit viewBox includes optical clearance. */}
          <BrandMark animated className="h-[calc(var(--hero-title-size)*412/300)]" />
          <h1 className="mt-6 text-[length:var(--hero-title-size)] leading-[1.2] font-bold tracking-tight text-balance">{t.studio.heroTitleLead}{language === 'en' ? ' ' : ''}<span className="text-brand-gradient">{t.studio.heroTitleAccent}</span></h1>
        </header>
        <div className="mt-8 animate-rise [animation-delay:120ms] [@media(max-height:820px)]:mt-6">
          <GraphStudio draftStore={draftStore} useWorkflowResources={useWorkflowResources} request={request} navigate={navigate} useQuery={useQuery} useSlot={useSlot} useWorkflowDocuments={useWorkflowDocuments} />
        </div>
        <div className="mt-4 flex justify-center"><a href="https://liuzhao1225.github.io/YouDub-webui/#demo" target="_blank" rel="noopener noreferrer" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">{tx("studio.view.built.in.examples")}</a></div>
        {!!active.length && <div className="mt-6 flex flex-wrap justify-center gap-3">
          {!!awaitingReview.length && <Link href={awaitingReview.length === 1 ? `/tasks/${awaitingReview[0].task.id}/nodes/${awaitingReview[0].step.id}` : '/tasks'} className="inline-flex items-center gap-2 rounded-full border border-status-warning/25 bg-status-warning/10 px-3.5 py-1.5 text-[13px] font-medium text-status-warning-fg">{tx("studio.value.nodes.need.your.review", { value1: awaitingReview.length })}<ArrowRight className="size-3.5" /></Link>}
          {!!processing.length && <Link href="/tasks" className="inline-flex items-center gap-2 rounded-full border border-status-running/25 bg-status-running/10 px-3.5 py-1.5 text-[13px] font-medium text-status-running-fg">{tx("studio.value.tasks.in.progress", { value1: processing.length })}<ArrowRight className="size-3.5" /></Link>}
        </div>}
      </PageContainer>
    </section>
    <PageContainer className="space-y-8 py-8">
      {taskError && <div className="space-y-2"><InlineAlert>{taskError}</InlineAlert><Button variant="outline" onClick={refreshTasks}>{tx("studio.reload.tasks")}</Button></div>}
      {active.length > 0 && <TaskSection id="studio-active" title={tx("studio.in.progress")}><div className="grid gap-3 lg:grid-cols-2">{active.map((task) => <Link key={task.id} href={`/tasks/${task.id}`} className={cn(surfaceVariants({ interactive: true }), "group flex items-center gap-4 p-3 pr-4")}><TaskCover id={task.id} src={task.cover?.url ? assetUrl(task.cover.url) : undefined} processing={task.status === 'running'} size="sm" className="w-24 sm:w-28" /><div className="min-w-0 flex-1 space-y-2"><div className="flex items-start justify-between gap-3"><p title={taskDisplayName(task)} className="line-clamp-2 min-w-0 text-sm font-medium break-words">{taskDisplayName(task)}</p><TaskState status={task.status} /></div><TaskProgress task={task} /></div></Link>)}</div></TaskSection>}
      <TaskSection id="studio-recent" title={tx("studio.recent.tasks")}>
        {!tasks && !taskError ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">{[0, 1, 2].map((item) => <Surface as="div" key={item} className="overflow-hidden"><div className="aspect-video animate-pulse bg-accent" /><div className="space-y-2.5 p-4"><div className="h-4 w-4/5 animate-pulse rounded-md bg-accent" /><div className="h-3 w-2/5 animate-pulse rounded-md bg-accent" /></div></Surface>)}</div>
          : tasks && recent.length === 0 ? <Surface as="div" className="flex flex-col items-center border-dashed bg-muted px-6 py-14 text-center"><BrandMark className="h-8 opacity-60 grayscale" /><p className="mt-4 text-sm font-medium">{tx("studio.no.finished.tasks.yet")}</p></Surface>
          : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{recent.map((task) => <Link key={task.id} href={`/tasks/${task.id}`} className={cn(surfaceVariants({ interactive: true }), "group flex flex-col overflow-hidden")}><TaskCover id={task.id} src={task.cover?.url ? assetUrl(task.cover.url) : undefined} processing={task.status === 'running'} size="md" className="rounded-none ring-0" /><div className="flex flex-1 flex-col gap-3 p-4"><p title={taskDisplayName(task)} className="line-clamp-2 text-sm leading-snug font-medium break-words">{taskDisplayName(task)}</p><div className="mt-auto flex items-center justify-between gap-3"><TaskState status={task.status} /><time className="text-xs text-muted-foreground" dateTime={task.createdAt}>{formatDateTime(task.createdAt)}</time></div></div></Link>)}</div>}
      </TaskSection>
    </PageContainer>
  </main>
}
