import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, Loader2, RotateCw } from '@/lib/icons'
import { Button, buttonVariants } from '@/components/ui/button'
import { InlineAlert } from '@/components/inline-alert'
import { assetUrl } from '@/lib/asset-url'
import { writeClipboard } from '@/components/ui/harness-primitives'
import { useText } from '@/lib/i18n'
import { useEvents } from '@/runtime/features'
import type { EventStreamClient } from '@/lib/api'
import type { Request as ApiRequest } from '@/plugin/runtime/types'
import { cn } from '@/lib/utils'

interface LogState {
  taskId: string
  text: string
  truncated: boolean
  loadedFull: boolean
  error: string
}

export function TaskLog({
  taskId,
  active,
  request,
  events,
}: {
  taskId: string
  active: boolean
  request: ApiRequest
  events?: EventStreamClient
}) {
  const tx = useText()
  const contextEvents = useEvents()
  const activeEvents = events ?? contextEvents
  const [logState, setLogState] = useState<LogState | null>(null)
  const [loadingFull, setLoadingFull] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)
  const stickBottomRef = useRef(true)

  const current = logState?.taskId === taskId ? logState : null
  const loading = current === null
  const text = current?.text ?? ''
  const truncated = current?.truncated ?? false
  const loadedFull = current?.loadedFull ?? false
  const error = current?.error ?? ''

  const loadLog = useCallback(async (full: boolean) => {
    const query = full ? 'full=true' : 'lines=200'
    try {
      const content = await request<string>(`/api/tasks/${encodeURIComponent(taskId)}/log?${query}`)
      const normalized = content ?? ''
      const lineCount = normalized ? normalized.split('\n').length : 0
      setLogState({
        taskId,
        text: normalized,
        truncated: full ? false : lineCount >= 200,
        loadedFull: full,
        error: '',
      })
    } catch (failure) {
      setLogState({
        taskId,
        text: '',
        truncated: false,
        loadedFull: full,
        error: failure instanceof Error ? failure.message : String(failure),
      })
    }
  }, [request, taskId])

  useEffect(() => {
    let cancelled = false
    void request<string>(`/api/tasks/${encodeURIComponent(taskId)}/log?lines=200`)
      .then((content) => {
        if (cancelled) return
        const normalized = content ?? ''
        const lineCount = normalized ? normalized.split('\n').length : 0
        setLogState({
          taskId,
          text: normalized,
          truncated: lineCount >= 200,
          loadedFull: false,
          error: '',
        })
      })
      .catch((failure) => {
        if (cancelled) return
        setLogState({
          taskId,
          text: '',
          truncated: false,
          loadedFull: false,
          error: failure instanceof Error ? failure.message : String(failure),
        })
      })
    return () => {
      cancelled = true
    }
  }, [request, taskId])

  useEffect(() => {
    if (!active) return
    if (activeEvents) {
      return activeEvents.onTaskLog(taskId, (chunk) => {
        setLogState((prev) =>
          prev && prev.taskId === taskId
            ? { ...prev, text: prev.text + chunk }
            : { taskId, text: chunk, truncated: false, loadedFull: false, error: '' },
        )
      })
    }
    const timer = window.setInterval(() => {
      void loadLog(loadedFull)
    }, 2500)
    return () => window.clearInterval(timer)
  }, [active, activeEvents, taskId, loadLog, loadedFull])

  useEffect(() => {
    const el = preRef.current
    if (el && stickBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [text])

  const handleScroll = () => {
    const el = preRef.current
    if (!el) return
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  async function handleLoadFull() {
    setLoadingFull(true)
    try {
      await loadLog(true)
    } finally {
      setLoadingFull(false)
    }
  }

  async function handleCopyFull() {
    setCopying(true)
    try {
      const fullContent = loadedFull
        ? text
        : await request<string>(`/api/tasks/${encodeURIComponent(taskId)}/log?full=true`)
      const ok = await writeClipboard(fullContent ?? '')
      if (ok) {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1800)
      }
    } catch (failure) {
      setLogState((prev) => ({
        taskId,
        text: prev?.taskId === taskId ? prev.text : '',
        truncated: prev?.taskId === taskId ? prev.truncated : false,
        loadedFull: prev?.taskId === taskId ? prev.loadedFull : false,
        error: failure instanceof Error ? failure.message : String(failure),
      }))
    } finally {
      setCopying(false)
    }
  }

  if (error) {
    return (
      <div className="mt-4 space-y-2">
        <InlineAlert>{error}</InlineAlert>
        <Button size="sm" variant="outline" onClick={() => void loadLog(loadedFull)}>
          <RotateCw />{tx('library.reload.log')}
        </Button>
      </div>
    )
  }

  return (
    <div className="mt-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {truncated && !loadedFull ? tx('log.truncated') : null}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {truncated && !loadedFull && (
            <Button size="sm" variant="outline" disabled={loadingFull} onClick={() => void handleLoadFull()}>
              {loadingFull && <Loader2 className="animate-spin" />}
              {tx('log.loadFull')}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={copying || loading} onClick={() => void handleCopyFull()}>
            {copying ? <Loader2 className="animate-spin" /> : copied ? <Check /> : <Copy />}
            {copied ? tx('log.copied') : tx('log.copyFull')}
          </Button>
          <a
            href={assetUrl(`/api/tasks/${encodeURIComponent(taskId)}/log?download=true`)}
            download={`task-${taskId}.log`}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'no-underline')}
          >
            <Download />{tx('log.download')}
          </a>
        </div>
      </div>
      <pre
        ref={preRef}
        onScroll={handleScroll}
        className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-4 font-mono text-xs"
      >
        {loading ? tx('library.loading') : text || '—'}
      </pre>
    </div>
  )
}
