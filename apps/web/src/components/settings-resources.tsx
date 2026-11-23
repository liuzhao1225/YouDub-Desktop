import { PageHeader } from '@/components/page-layout'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowRight,
  Check,
  Download,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
} from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/inline-alert'
import { NativeSelect } from '@/components/ui/native-select'
import { SectionCard } from '@/components/section-card'
import { SetupDiagnostics } from '@/components/setup-diagnostics'
import { ResourceRow } from '@/components/resource-row'
import { Tag } from '@/components/ui/tag'
import { Progress } from '@/components/ui/progress'
import type { EventStreamClient } from '@/lib/api'
import { sizeLabel } from '@/lib/format'
import { useText } from '@/lib/i18n'
import type { MessageKey } from '@/locales'
import { useObservableSource } from '@/plugin/view-hooks'
import { ResourcesController } from '@/plugin/runtime/workflow-resources'
import type { Request } from '@/plugin/runtime/types'
import type { SettingsTab } from '@/components/settings/SettingsModal'
import {
  mergeResourceEntries,
  resourceSetupState,
  type ResourceAction,
  type ResourceEntry,
  type WhisperVariant,
  type YtDlpInfo,
} from '@/runtime/setup-contracts'

function toResourceEntryFromWhisper(entry: ResourceEntry, variant: WhisperVariant): ResourceEntry {
  const status =
    variant.status === 'downloading'
      ? 'preparing'
      : variant.status === 'paused'
        ? 'paused'
        : variant.status === 'failed'
          ? 'failed'
          : variant.status === 'ready'
            ? 'ready'
            : 'pending'
  const actions: ResourceAction[] =
    variant.status === 'downloading'
      ? ['pause']
      : variant.status === 'paused'
        ? ['resume']
        : variant.status === 'failed'
          ? ['retry']
          : variant.status === 'ready'
            ? []
            : ['prepare']
  const displayTotal = variant.diskBytes && variant.diskBytes > 0 ? variant.diskBytes : variant.total
  return {
    ...entry,
    downloadId: variant.downloadId,
    variant: variant.id,
    status,
    phase: variant.status === 'downloading' || variant.status === 'paused' ? 'downloading' : undefined,
    actions,
    error: variant.error ?? undefined,
    source: variant.source ?? entry.source,
    progress:
      displayTotal > 0 || variant.received > 0
        ? { received: variant.received, total: displayTotal, speed: variant.speed }
        : undefined,
  }
}

const WHISPER_DESC_KEYS: Record<string, MessageKey> = {
  'large-v3-turbo': 'settings.resources.whisper.desc.large-v3-turbo',
  'large-v3': 'settings.resources.whisper.desc.large-v3',
  medium: 'settings.resources.whisper.desc.medium',
  small: 'settings.resources.whisper.desc.small',
  tiny: 'settings.resources.whisper.desc.tiny',
}

type TranslateFn = ReturnType<typeof useText>

const ENV_DISPLAY_NAMES: Record<string, MessageKey> = {
  acceleration: 'resource.inference',
  dependencies: 'resource.pythonDeps',
  'youdub.download': 'resource.videoDownload',
}

function formatEnvironmentSubtitle(
  entry: ResourceEntry,
  ytDlp: YtDlpInfo | undefined,
  tx: TranslateFn,
): string | undefined {
  if (entry.id === 'youdub.download') {
    if (entry.status === 'preparing') return entry.activity || entry.detail
    if (entry.status === 'failed') return undefined
    const version = ytDlp?.version || entry.variant
    if (!version) return tx('settings.resources.ytdlp.notInstalled')
    if (ytDlp?.updateAvailable && ytDlp.latestVersion) {
      return `yt-dlp ${version} → ${ytDlp.latestVersion}`
    }
    if (ytDlp?.checked && ytDlp.latestVersion) {
      return `yt-dlp ${version} · ${tx('settings.resources.ytdlp.latest')}`
    }
    return `yt-dlp ${version}`
  }
  const raw = entry.detail
  if (!raw) return undefined
  if (raw === 'Compute venv has not been created yet.') return tx('settings.resources.detail.venvMissing')
  if (raw === 'FFmpeg binary not found.') return tx('settings.resources.detail.ffmpegMissing')
  if (raw.startsWith('Missing packages: ')) {
    return tx('settings.resources.detail.missingPackages', { packages: raw.slice('Missing packages: '.length) })
  }
  if (raw.startsWith('Backend: ')) {
    return tx('settings.resources.detail.backend', { backend: raw.slice('Backend: '.length).toUpperCase() })
  }
  return raw
}

function sumMissingBytes(entries: ResourceEntry[]): number {
  return entries.reduce((sum, entry) => {
    if (entry.status === 'ready') return sum
    const total = entry.progress?.total ?? 0
    const received = entry.progress?.received ?? 0
    return sum + Math.max(0, total - received)
  }, 0)
}

interface ActiveTransfer {
  downloadId: string
  label: string
  status: 'downloading' | 'paused'
  received: number
  total: number
  speed: number
}

function findActiveTransfer(modelEntries: ResourceEntry[], variants: WhisperVariant[]): ActiveTransfer | null {
  const activeVariant = variants.find((v) => v.status === 'downloading') ?? variants.find((v) => v.status === 'paused')
  if (activeVariant) {
    return {
      downloadId: activeVariant.downloadId,
      label: `Whisper · ${activeVariant.id}`,
      status: activeVariant.status === 'downloading' ? 'downloading' : 'paused',
      received: activeVariant.received,
      total: activeVariant.total,
      speed: activeVariant.speed ?? 0,
    }
  }
  const activeEntry = modelEntries.find((e) => e.status === 'preparing') ?? modelEntries.find((e) => e.status === 'paused')
  if (activeEntry) {
    return {
      downloadId: activeEntry.downloadId ?? activeEntry.id,
      label: [activeEntry.name, activeEntry.variant].filter(Boolean).join(' · '),
      status: activeEntry.status === 'preparing' ? 'downloading' : 'paused',
      received: activeEntry.progress?.received ?? 0,
      total: activeEntry.progress?.total ?? 0,
      speed: activeEntry.progress?.speed ?? 0,
    }
  }
  return null
}

function DeleteConfirmControl({
  targetId,
  label,
  confirming,
  disabled,
  onRequestConfirm,
  onConfirmDelete,
  onCancel,
  tx,
}: {
  targetId: string
  label: string
  confirming: boolean
  disabled: boolean
  onRequestConfirm: (id: string) => void
  onConfirmDelete: (id: string) => void
  onCancel: () => void
  tx: TranslateFn
}) {
  if (confirming) {
    return (
      <div className="flex items-center gap-1.5">
        <Button
          variant="destructive"
          size="sm"
          disabled={disabled}
          aria-label={`${tx('settings.resources.confirmRemove')} ${label}`}
          onClick={() => onConfirmDelete(targetId)}
        >
          {tx('settings.resources.confirmRemove')}
        </Button>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onCancel}>
          {tx('settings.resources.cancel')}
        </Button>
      </div>
    )
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      aria-label={`${tx('settings.resources.deleteModel')} ${label}`}
      onClick={() => onRequestConfirm(targetId)}
    >
      <Trash2 />
      {tx('settings.resources.remove')}
    </Button>
  )
}

function WorkflowPresetCard({
  title,
  description,
  ready,
  missingBytes,
  extra,
  action,
  tx,
}: {
  title: string
  description: string
  ready: boolean
  missingBytes: number
  extra?: ReactNode
  action: ReactNode
  tx: TranslateFn
}) {
  return (
    <div className="flex flex-col justify-between gap-3 rounded-lg border border-border bg-elevated/40 p-4">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <Tag tone={ready ? 'success' : 'neutral'}>
            {ready ? tx('settings.resources.preset.ready') : tx('resource.status.pending')}
          </Tag>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        {!ready && missingBytes > 0 && (
          <p className="text-xs tabular-nums text-muted-foreground">
            {tx('settings.resources.preset.missingSize', { size: sizeLabel(missingBytes) })}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div className="min-w-0">{extra}</div>
        <div className="ml-auto flex items-center gap-2">{action}</div>
      </div>
    </div>
  )
}

export interface SettingsResourcesProps {
  request: Request
  title: string
  events?: EventStreamClient
  onOpenSettings?: (tab?: SettingsTab) => void
  onNavigate?: (path: string) => void
}

export function SettingsResources({ request, title, events, onOpenSettings, onNavigate }: SettingsResourcesProps) {
  const tx = useText()
  const controller = useMemo(() => new ResourcesController(request), [request])
  const { inventory, inspection, checking, error } = useObservableSource(controller)
  const [ytDlpBusy, setYtDlpBusy] = useState(false)
  const [ytDlpError, setYtDlpError] = useState('')
  const [ytDlpNotice, setYtDlpNotice] = useState('')
  const [ytDlpCheck, setYtDlpCheck] = useState<YtDlpInfo | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [selectedWhisperId, setSelectedWhisperId] = useState<string | null>(null)

  const triggerYtDlpCheck = async (force: boolean) => {
    try {
      const path = force ? '/api/resources/yt-dlp/check?force=true' : '/api/resources/yt-dlp/check'
      const res = await request<YtDlpInfo>(path)
      if (res && typeof res.installed === 'boolean') {
        setYtDlpCheck(res)
      }
    } catch {
      // Silent background check; offline environments degrade cleanly without error banners.
    }
  }

  useEffect(() => {
    let cancelled = false
    void request<YtDlpInfo>('/api/resources/yt-dlp/check')
      .then((res) => {
        if (!cancelled && res && typeof res.installed === 'boolean') {
          setYtDlpCheck(res)
        }
      })
      .catch(() => {
        // Silent background check; offline environments degrade cleanly without error banners.
      })
    return () => {
      cancelled = true
    }
  }, [request])

  useEffect(() => {
    if (!events) return
    const unsubResources = events.on('resources.updated', () => controller.invalidate())
    const unsubSettings = events.on('settings.updated', () => controller.invalidate())
    const unsubProviders = events.on('providers.updated', () => controller.invalidate())
    return () => {
      unsubResources()
      unsubSettings()
      unsubProviders()
    }
  }, [events, controller])

  const state = inventory && resourceSetupState(inventory, inspection)
  const entries = mergeResourceEntries(inspection?.entries ?? [], inventory?.resources?.entries)
  const preparing = inventory?.resources?.status === 'preparing'
  const act = (action: ResourceAction, entry: ResourceEntry) =>
    action === 'prepare'
      ? controller.prepareResource(entry.downloadId ?? entry.id)
      : controller.action(action, entry.downloadId ?? entry.id)

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      {onOpenSettings && (
        <Button variant="outline" size="sm" onClick={() => onOpenSettings('general')}>
          <SlidersHorizontal />
          {tx('settings.resources.openStorageSettings')}
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={checking}
        onClick={() => {
          controller.check()
          void triggerYtDlpCheck(true)
        }}
      >
        <RefreshCw className={checking ? 'animate-spin' : undefined} />
        {tx('settings.resources.check.again')}
      </Button>
    </div>
  )

  async function handleUpdateYtDlp() {
    setYtDlpBusy(true)
    setYtDlpError('')
    setYtDlpNotice('')
    try {
      const result = await request<{ ok?: boolean; version?: string | null; updated?: boolean }>(
        '/api/resources/yt-dlp/update',
        { method: 'POST' },
      )
      if (result?.updated === false && result?.version) {
        setYtDlpNotice(tx('settings.resources.ytdlp.alreadyLatest', { version: result.version }))
      } else if (result?.version) {
        setYtDlpNotice(tx('settings.resources.ytdlp.updated', { version: result.version }))
      } else {
        setYtDlpNotice(tx('settings.resources.ytdlp.updatedGeneric'))
      }
      if (result?.version) {
        setYtDlpCheck({
          version: result.version,
          installed: true,
          latestVersion: result.version,
          updateAvailable: false,
          checked: true,
        })
      }
      controller.check()
    } catch (failure) {
      setYtDlpError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setYtDlpBusy(false)
    }
  }

  function handleDeleteModel(downloadId: string) {
    setConfirmDeleteId(null)
    controller.action('delete', downloadId)
  }

  const environmentEntries = entries.filter((entry) => entry.group === 'environment')
  const modelEntries = entries.filter((entry) => entry.group === 'model')
  const whisperVariants = inventory?.whisperVariants ?? []
  const installedWhisperVariants = whisperVariants.filter((variant) => variant.installed || variant.status === 'ready')
  const hasDownloadEntry = environmentEntries.some((entry) => entry.id === 'youdub.download')
  const showEnvironment = Boolean(inspection) && (environmentEntries.length > 0 || Boolean(inventory?.ytDlp))

  const coreEnvIds = ['python', 'ffmpeg', 'dependencies', 'acceleration']
  const coreEnvEntries = environmentEntries.filter((entry) => coreEnvIds.includes(entry.id))
  const coreEnvMissingIds = coreEnvEntries.filter((entry) => entry.status !== 'ready').map((entry) => entry.id)
  const coreEnvReady = coreEnvMissingIds.length === 0

  const whisperEntry = modelEntries.find((entry) => entry.id === 'whisper')
  const activeDownloadingVariant = whisperVariants.find(
    (variant) => variant.status === 'downloading' || variant.status === 'paused',
  )
  const currentWhisperVariant =
    (selectedWhisperId ? whisperVariants.find((variant) => variant.id === selectedWhisperId) : undefined) ??
    activeDownloadingVariant ??
    whisperVariants.find((variant) => variant.recommended) ??
    whisperVariants[0]
  const effectiveModelEntries = modelEntries.map((entry) =>
    entry.id === 'whisper' && currentWhisperVariant ? toResourceEntryFromWhisper(entry, currentWhisperVariant) : entry,
  )

  const anyWhisperReady = whisperEntry?.status === 'ready' || installedWhisperVariants.length > 0
  const subtitleReady = coreEnvReady && anyWhisperReady
  const targetWhisperId =
    currentWhisperVariant?.downloadId ?? whisperEntry?.downloadId ?? whisperEntry?.id
  const subtitleMissingTargets = [
    ...coreEnvMissingIds,
    ...(!anyWhisperReady && targetWhisperId ? [targetWhisperId] : []),
  ]
  const targetWhisperMissingBytes = anyWhisperReady
    ? 0
    : currentWhisperVariant
      ? Math.max(0, currentWhisperVariant.total - currentWhisperVariant.received)
      : whisperEntry
        ? sumMissingBytes([whisperEntry])
        : 0
  const subtitleMissingBytes = targetWhisperMissingBytes

  const otherModelEntries = effectiveModelEntries.filter((entry) => entry.id !== 'whisper')
  const missingOtherModels = otherModelEntries.filter((entry) => entry.status !== 'ready')
  const dubbingReady = subtitleReady && missingOtherModels.length === 0
  const allMissingTargets = [
    ...new Set([
      ...subtitleMissingTargets,
      ...missingOtherModels.map((entry) => entry.downloadId ?? entry.id),
    ]),
  ]
  const dubbingMissingBytes = targetWhisperMissingBytes + sumMissingBytes(missingOtherModels)

  const activeTransfer = findActiveTransfer(effectiveModelEntries, whisperVariants)
  const activeEnvEntry = !activeTransfer && preparing ? environmentEntries.find((e) => e.status === 'preparing') : undefined
  const activeEnvName = activeEnvEntry
    ? (ENV_DISPLAY_NAMES[activeEnvEntry.id] ? tx(ENV_DISPLAY_NAMES[activeEnvEntry.id]) : activeEnvEntry.name)
    : ''
  const storage = inspection?.storage ?? inventory?.storage
  const llmReady = inspection?.llmReady ?? inventory?.llmReady
  const envReadyCount = environmentEntries.filter((entry) => entry.status === 'ready').length
  const modelReadyCount = effectiveModelEntries.filter((entry) =>
    entry.id === 'whisper' ? anyWhisperReady : entry.status === 'ready',
  ).length

  const ytDlpInfo: YtDlpInfo | undefined = useMemo(() => {
    const base = inventory?.ytDlp ?? inspection?.ytDlp
    if (!base && !ytDlpCheck) return undefined
    const version = ytDlpCheck?.version ?? base?.version ?? null
    const installed = ytDlpCheck?.installed ?? base?.installed ?? Boolean(version)
    return {
      version,
      installed,
      latestVersion: ytDlpCheck?.latestVersion ?? base?.latestVersion,
      updateAvailable: ytDlpCheck?.updateAvailable ?? base?.updateAvailable,
      checked: ytDlpCheck?.checked ?? base?.checked,
    }
  }, [inventory?.ytDlp, inspection?.ytDlp, ytDlpCheck])

  const ytDlpHasUpdate = Boolean(ytDlpInfo?.installed && ytDlpInfo.updateAvailable)

  const ytDlpUpdateButton = ytDlpInfo?.installed && !ytDlpHasUpdate && !ytDlpBusy ? (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground hover:text-foreground"
      disabled={ytDlpBusy || (checking && !inspection) || preparing}
      onClick={() => void handleUpdateYtDlp()}
    >
      <RefreshCw />
      {tx('settings.resources.ytdlp.update')}
    </Button>
  ) : null

  const ytDlpStatusSlot = ytDlpBusy ? (
    <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
      {tx('settings.resources.ytdlp.updating')}
    </span>
  ) : ytDlpHasUpdate ? (
    <button
      type="button"
      disabled={ytDlpBusy || preparing}
      aria-label={tx('settings.resources.ytdlp.update')}
      title={
        ytDlpInfo?.latestVersion
          ? tx('settings.resources.ytdlp.updateTo', { version: ytDlpInfo.latestVersion })
          : tx('settings.resources.ytdlp.update')
      }
      onClick={() => void handleUpdateYtDlp()}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-status-warning/35 bg-status-warning/10 px-2.5 py-0.5 text-xs font-medium text-status-warning-fg transition-colors hover:bg-status-warning/20 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <RefreshCw className="size-3" />
      {tx('settings.resources.ytdlp.updateAvailable')}
    </button>
  ) : undefined

  return (
    <div className="space-y-8">
      <PageHeader title={title} actions={headerActions} />
      {error && <InlineAlert>{error}</InlineAlert>}
      {!inspection && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          {checking && <Loader2 className="size-4 animate-spin" />}
          {tx(checking ? 'settings.resources.checking.resources' : 'settings.resources.environment.not.checked')}
        </p>
      )}

      {inspection && (
        <SectionCard title={tx('settings.resources.overview.title')}>
          {(activeTransfer || preparing) && (
            <div className="space-y-2 border-b border-border bg-status-running/5 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
                  {activeTransfer?.status === 'paused' ? (
                    <Pause className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-status-running-fg" />
                  )}
                  <span className="truncate">
                    {activeTransfer
                      ? tx(
                          activeTransfer.status === 'paused'
                            ? 'settings.resources.transfer.paused'
                            : 'settings.resources.transfer.active',
                          { name: activeTransfer.label },
                        )
                      : activeEnvEntry
                        ? tx('settings.resources.transfer.active', { name: activeEnvName })
                        : tx('settings.resources.transfer.preparingGeneric')}
                  </span>
                </div>
                {!activeTransfer && activeEnvEntry && (activeEnvEntry.source || activeEnvEntry.activity) && (
                  <span className="ml-auto max-w-full truncate text-xs text-muted-foreground">
                    {[activeEnvEntry.source, activeEnvEntry.activity].filter(Boolean).join(' · ')}
                  </span>
                )}
                {activeTransfer && (
                  <div className="ml-auto flex items-center gap-3">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {sizeLabel(activeTransfer.received)}
                      {activeTransfer.total > 0 ? ` / ${sizeLabel(activeTransfer.total)}` : ''}
                      {activeTransfer.status === 'downloading' && activeTransfer.speed > 0
                        ? ` · ${sizeLabel(activeTransfer.speed)}/s`
                        : ''}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        controller.action(
                          activeTransfer.status === 'downloading' ? 'pause' : 'resume',
                          activeTransfer.downloadId,
                        )
                      }
                    >
                      {activeTransfer.status === 'downloading' ? <Pause /> : <Play />}
                      {tx(activeTransfer.status === 'downloading' ? 'resource.action.pause' : 'resource.action.resume')}
                    </Button>
                  </div>
                )}
              </div>
              {activeTransfer ? (
                <Progress
                  value={activeTransfer.total > 0 ? activeTransfer.received / activeTransfer.total : undefined}
                  label={activeTransfer.label}
                  paused={activeTransfer.status === 'paused'}
                />
              ) : (
                <Progress label={tx('settings.resources.transfer.preparingGeneric')} />
              )}
            </div>
          )}

          <div className="grid gap-3 p-4 md:grid-cols-2">
            <WorkflowPresetCard
              title={tx('settings.resources.preset.subtitles')}
              description={tx('settings.resources.preset.subtitlesDesc')}
              ready={subtitleReady}
              missingBytes={subtitleMissingBytes}
              tx={tx}
              extra={
                llmReady === true ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-status-success-fg">
                    <Check className="size-3.5" />
                    {tx('settings.resources.llm.ready')}
                  </span>
                ) : llmReady === false && onOpenSettings ? (
                  <button
                    type="button"
                    onClick={() => onOpenSettings('llm')}
                    className="inline-flex items-center gap-1 text-xs font-medium text-link hover:underline"
                  >
                    {tx('settings.resources.llm.missing')}
                    <ArrowRight className="size-3" />
                  </button>
                ) : null
              }
              action={
                subtitleMissingTargets.length > 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={checking || preparing}
                    onClick={() => controller.prepareResources(subtitleMissingTargets)}
                  >
                    <Download />
                    {tx('settings.resources.preset.prepareSubtitles')}
                  </Button>
                ) : onNavigate ? (
                  <Button variant="ghost" size="sm" onClick={() => onNavigate('/')}>
                    {tx('settings.resources.preset.goWorkbench')}
                    <ArrowRight />
                  </Button>
                ) : null
              }
            />

            <WorkflowPresetCard
              title={tx('settings.resources.preset.dubbing')}
              description={tx('settings.resources.preset.dubbingDesc')}
              ready={dubbingReady}
              missingBytes={dubbingMissingBytes}
              tx={tx}
              action={
                allMissingTargets.length > 0 ? (
                  <Button
                    size="sm"
                    disabled={checking || preparing}
                    onClick={() => controller.prepareResources(allMissingTargets)}
                  >
                    <Download />
                    {tx('settings.resources.preset.prepareAll')}
                  </Button>
                ) : onNavigate ? (
                  <Button variant="ghost" size="sm" onClick={() => onNavigate('/')}>
                    {tx('settings.resources.preset.goWorkbench')}
                    <ArrowRight />
                  </Button>
                ) : null
              }
            />
          </div>

          {storage?.dataDir && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/25 px-4 py-2.5 text-xs text-muted-foreground">
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
                <span className="inline-flex min-w-0 items-center gap-1.5" title={storage.modelsDir ?? storage.dataDir}>
                  <FolderOpen className="size-3.5 shrink-0" />
                  <span className="shrink-0">{tx('settings.resources.storage.dir')}:</span>
                  <span className="max-w-[18rem] truncate font-mono text-foreground sm:max-w-[26rem]">
                    {storage.modelsDir ?? storage.dataDir}
                  </span>
                </span>
                <span className="tabular-nums">
                  {tx('settings.resources.storage.used', { size: sizeLabel(storage.diskBytes) })}
                </span>
                {storage.proxyConfigured ? (
                  <Tag tone="success">{tx('settings.resources.proxy.configured')}</Tag>
                ) : onOpenSettings ? (
                  <button
                    type="button"
                    onClick={() => onOpenSettings('general')}
                    className="inline-flex items-center gap-1 text-xs text-link hover:underline"
                  >
                    {tx('settings.resources.proxy.direct')}
                  </button>
                ) : (
                  <Tag tone="neutral">{tx('settings.resources.proxy.direct')}</Tag>
                )}
              </div>
              {typeof window !== 'undefined' && window.youdubDesktop?.openPath && storage.modelsDir && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void window.youdubDesktop?.openPath(storage.modelsDir!)}
                >
                  <FolderOpen />
                  {tx('settings.resources.storage.openDir')}
                </Button>
              )}
            </div>
          )}
        </SectionCard>
      )}

      {showEnvironment && (
        <SectionCard
          title={tx('settings.resources.runtime.environment')}
          action={
            <Tag tone={envReadyCount === environmentEntries.length && environmentEntries.length > 0 ? 'success' : 'neutral'}>
              {envReadyCount} / {environmentEntries.length}
            </Tag>
          }
        >
          <div className="divide-y divide-border px-4">
            {environmentEntries.map((entry) => {
              const isPauseOrResume = ['pause', 'resume'].some((action) => entry.actions.includes(action as ResourceAction))
              const isDownloadTool = entry.id === 'youdub.download'
              return (
                <ResourceRow
                  key={entry.id}
                  compact
                  hideVariant={isDownloadTool}
                  entry={entry}
                  subtitle={formatEnvironmentSubtitle(entry, ytDlpInfo, tx)}
                  busy={isPauseOrResume ? false : (checking && !inspection) || preparing}
                  extraAction={isDownloadTool ? ytDlpUpdateButton : undefined}
                  statusSlot={isDownloadTool ? ytDlpStatusSlot : undefined}
                  onAction={act}
                />
              )
            })}
            {ytDlpInfo && !hasDownloadEntry && (
              <div className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{tx('resource.videoDownload')}</p>
                  <p className="text-xs text-muted-foreground">
                    {ytDlpInfo.version
                      ? `yt-dlp ${ytDlpInfo.version}${ytDlpHasUpdate && ytDlpInfo.latestVersion ? ` → ${ytDlpInfo.latestVersion}` : ytDlpInfo.checked && ytDlpInfo.latestVersion ? ` · ${tx('settings.resources.ytdlp.latest')}` : ''}`
                      : tx('settings.resources.ytdlp.notInstalled')}
                  </p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  {ytDlpUpdateButton}
                  {ytDlpStatusSlot}
                </div>
              </div>
            )}
            {ytDlpNotice && (
              <p role="status" className="flex items-center gap-1.5 py-3 text-xs text-status-success-fg">
                <Check className="size-3.5 shrink-0" />
                {ytDlpNotice}
              </p>
            )}
            {ytDlpError && (
              <div className="py-3">
                <InlineAlert>{ytDlpError}</InlineAlert>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {inspection && effectiveModelEntries.length > 0 && (
        <SectionCard
          title={tx('settings.resources.local.models')}
          action={
            <Tag tone={modelReadyCount === effectiveModelEntries.length ? 'success' : 'neutral'}>
              {modelReadyCount} / {effectiveModelEntries.length}
            </Tag>
          }
        >
          <div className="divide-y divide-border px-4">
            {effectiveModelEntries.map((entry) => {
              const isWhisper = entry.id === 'whisper' && Boolean(currentWhisperVariant)
              const targetId = entry.downloadId ?? entry.id
              const altVariant =
                isWhisper && entry.status !== 'ready'
                  ? installedWhisperVariants.find((variant) => variant.id !== currentWhisperVariant?.id)
                  : undefined
              const whisperDescKey =
                isWhisper && currentWhisperVariant ? WHISPER_DESC_KEYS[currentWhisperVariant.id] : undefined
              const isPauseOrResume = ['pause', 'resume'].some((action) => entry.actions.includes(action as ResourceAction))
              return (
                <ResourceRow
                  key={entry.id}
                  compact
                  entry={entry}
                  subtitle={whisperDescKey ? tx(whisperDescKey) : undefined}
                  busy={isPauseOrResume ? false : (checking && !inspection) || preparing}
                  variantControl={
                    isWhisper && currentWhisperVariant && whisperVariants.length > 0 ? (
                      <NativeSelect
                        size="sm"
                        aria-label={tx('settings.resources.whisper.selectVariant')}
                        className="w-52 shrink-0"
                        disabled={checking && !inspection}
                        value={currentWhisperVariant.id}
                        onChange={(event) => {
                          setConfirmDeleteId(null)
                          setSelectedWhisperId(event.target.value)
                        }}
                      >
                        {whisperVariants.map((variant) => (
                          <option key={variant.id} value={variant.id}>
                            {variant.id}
                            {variant.recommended ? ` (${tx('settings.resources.recommended')})` : ''}
                            {variant.installed || variant.status === 'ready' ? ` · ${tx('resource.status.ready')}` : ''}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : undefined
                  }
                  badge={
                    altVariant ? (
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmDeleteId(null)
                          setSelectedWhisperId(altVariant.id)
                        }}
                        className="inline-flex cursor-pointer border-0 bg-transparent p-0"
                      >
                        <Tag tone="info">
                          {tx('settings.resources.whisper.installedVariant', { variant: altVariant.id })}
                        </Tag>
                      </button>
                    ) : undefined
                  }
                  extraAction={
                    entry.status === 'ready' ? (
                      <DeleteConfirmControl
                        targetId={targetId}
                        label={[entry.name, entry.variant].filter(Boolean).join(' ')}
                        confirming={confirmDeleteId === targetId}
                        disabled={checking || preparing}
                        onRequestConfirm={setConfirmDeleteId}
                        onConfirmDelete={handleDeleteModel}
                        onCancel={() => setConfirmDeleteId(null)}
                        tx={tx}
                      />
                    ) : undefined
                  }
                  onAction={act}
                />
              )
            })}
          </div>
        </SectionCard>
      )}
      <SetupDiagnostics state={state} requestError={error} />
    </div>
  )
}
