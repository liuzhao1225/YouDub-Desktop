import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  IconNewChatOutlineRegular,
  IconPanelLeftOutlineRegular,
} from '@/components/ui/primitives/icons/index.tsx'
import { WindowHeaderProvider } from '@/components/page-layout'
import { getDesktopBridge } from '@/lib/desktop-bridge'
import { useText } from '@/lib/i18n'
import { formatDesktopUpdateText, useDesktopUpdates } from '@/lib/use-desktop-updates'
import { cn } from '@/lib/utils'
import frameCss from './AppFrame.module.css'
import leadingCss from './HeaderLeadingControls.module.css'
import conversationCss from './ConversationRoot.module.css'
import { Sidebar } from './Sidebar'

const SIDEBAR_STORAGE_KEY = 'youdub-sidebar-collapsed'
const SIDEBAR_WIDTH_STORAGE_KEY = 'youdub-sidebar-width'
const SIDEBAR_MIN = 220
const SIDEBAR_DEFAULT = 240
const SIDEBAR_MAX = 380
const SIDEBAR_COLLAPSED = 56
const SIDEBAR_AUTO_COLLAPSE = 1024

function readStoredCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function clampSidebarWidth(px: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)))
}

function readStoredWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT
  try {
    const raw = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    return Number.isFinite(raw) && raw > 0 ? clampSidebarWidth(raw) : SIDEBAR_DEFAULT
  } catch {
    return SIDEBAR_DEFAULT
  }
}

export interface AppShellProps {
  pathname: string
  onNavigate: (path: string) => void
  onOpenSettings: () => void
  children: ReactNode
}

export function AppShell({ pathname, onNavigate, onOpenSettings, children }: AppShellProps) {
  const tx = useText()
  const desktop = getDesktopBridge()
  const isDarwin = desktop?.platform === 'darwin'
  const [viewportWidth, setViewportWidth] = useState<number>(() => {
    if (typeof window === 'undefined' || window.innerWidth <= 0) return 1280
    return window.innerWidth
  })
  const [collapsed, setCollapsed] = useState<boolean>(() => readStoredCollapsed())
  const [customWidth, setCustomWidth] = useState<number>(() => readStoredWidth())
  const [narrowExpanded, setNarrowExpanded] = useState(false)
  const [animating, setAnimating] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [railIn, setRailIn] = useState(false)
  const { state: updateState, quitAndInstall } = useDesktopUpdates()
  const [headerHost, setHeaderHost] = useState<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const prevViewportRef = useRef<number | null>(null)
  const animationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dragStateRef = useRef<{
    pointerId: number
    startX: number
    baseWidth: number
    currentWidth: number
  } | null>(null)

  useEffect(() => {
    if (!isDarwin || typeof document === 'undefined') return
    const previous = document.documentElement.dataset.platform
    document.documentElement.dataset.platform = 'darwin'
    return () => {
      if (previous === undefined) delete document.documentElement.dataset.platform
      else document.documentElement.dataset.platform = previous
    }
  }, [isDarwin])

  useEffect(() => () => clearTimeout(animationTimer.current), [])

  useEffect(() => {
    const initial = typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1280
    if (prevViewportRef.current === null) prevViewportRef.current = initial

    const applyWidth = (nextWidth: number) => {
      if (nextWidth <= 0) return
      const prev = prevViewportRef.current
      prevViewportRef.current = nextWidth
      if (prev !== null && (prev < SIDEBAR_AUTO_COLLAPSE) !== (nextWidth < SIDEBAR_AUTO_COLLAPSE)) {
        setNarrowExpanded(false)
      }
      setViewportWidth(nextWidth)
    }

    const frame = frameRef.current
    let raf: number | null = null
    let disposed = false
    let observer: ResizeObserver | undefined

    if (frame && typeof ResizeObserver !== 'undefined') {
      const measureFrame = () => {
        const w = frame.getBoundingClientRect().width
        if (w > 0) applyWidth(w)
      }
      measureFrame()
      observer = new ResizeObserver(() => {
        if (disposed) return
        raf ??= requestAnimationFrame(() => {
          raf = null
          measureFrame()
        })
      })
      observer.observe(frame)
    }

    const onWindowResize = () => {
      if (frame) {
        const w = frame.getBoundingClientRect().width
        if (w > 0) {
          applyWidth(w)
          return
        }
      }
      if (typeof window !== 'undefined' && window.innerWidth > 0) applyWidth(window.innerWidth)
    }

    window.addEventListener('resize', onWindowResize)
    return () => {
      disposed = true
      observer?.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
      window.removeEventListener('resize', onWindowResize)
    }
  }, [])

  const narrow = viewportWidth < SIDEBAR_AUTO_COLLAPSE
  const effectiveCollapsed = narrow ? !narrowExpanded : collapsed
  const expandedWidth = Math.min(
    clampSidebarWidth(customWidth),
    Math.max(200, Math.floor(viewportWidth * 0.65)),
  )
  const sidebarWidthPx = effectiveCollapsed ? (isDarwin ? 0 : SIDEBAR_COLLAPSED) : expandedWidth

  function triggerCollapseAnimation(collapsingToRail: boolean) {
    setAnimating(true)
    setRailIn(collapsingToRail)
    clearTimeout(animationTimer.current)
    animationTimer.current = setTimeout(() => setAnimating(false), 300)
  }

  function toggleCollapse() {
    triggerCollapseAnimation(!effectiveCollapsed)
    if (narrow) {
      setNarrowExpanded((current) => !current)
      return
    }
    const next = !collapsed
    setCollapsed(next)
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next))
    } catch { /* ignore storage errors */ }
  }

  function handleNavigate(path: string) {
    if (narrow && viewportWidth < 640 && narrowExpanded) {
      triggerCollapseAnimation(true)
      setNarrowExpanded(false)
    }
    onNavigate(path)
  }

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, currentWidth: number) => {
    if (event.button !== 0 || dragStateRef.current !== null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      baseWidth: currentWidth,
      currentWidth,
    }
    setDragging(true)
  }, [])

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const active = dragStateRef.current
    if (!active || active.pointerId !== event.pointerId) return
    const next = clampSidebarWidth(active.baseWidth + (event.clientX - active.startX))
    active.currentWidth = next
    setCustomWidth(next)
  }, [])

  const finishResizeDrag = useCallback((event?: ReactPointerEvent<HTMLDivElement>) => {
    const active = dragStateRef.current
    if (!active) return
    if (event && active.pointerId !== event.pointerId) return
    dragStateRef.current = null
    if (event && event.currentTarget.hasPointerCapture(active.pointerId)) {
      event.currentTarget.releasePointerCapture(active.pointerId)
    }
    setDragging(false)
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(active.currentWidth))
    } catch { /* ignore storage errors */ }
  }, [])

  const isDesktop = Boolean(desktop)
  const hasWindowHeader =
    isDesktop &&
    pathname !== '/' &&
    (pathname === '/tasks' ||
      pathname.startsWith('/tasks/') ||
      pathname === '/workflows' ||
      pathname.startsWith('/workflows/') ||
      pathname === '/resources' ||
      pathname.startsWith('/settings/resources'))

  const isWorkflowCanvas =
    pathname.startsWith('/workflows/') &&
    !pathname.includes('/nodes/')

  const content = (
    <div
      className={cn(
        'min-h-0 flex-1',
        isWorkflowCanvas ? 'flex flex-col overflow-hidden' : 'overflow-y-auto [scrollbar-gutter:stable]',
      )}
    >
      {children}
    </div>
  )

  return (
    <div
      className="h-dvh w-full overflow-hidden"
      data-platform={isDarwin ? 'darwin' : undefined}
    >
      <div
        ref={frameRef}
        className={frameCss.frame}
        data-sidebar-collapsed={effectiveCollapsed ? 'true' : undefined}
        data-animating={animating ? 'true' : undefined}
        data-dragging={dragging ? 'true' : undefined}
        style={{ gridTemplateColumns: `${sidebarWidthPx}px minmax(0, 1fr)` }}
      >
        <div className={frameCss.sidebarCol}>
          {!(isDarwin && effectiveCollapsed) && (
            <Sidebar
              pathname={pathname}
              collapsed={effectiveCollapsed}
              width={expandedWidth}
              isDarwin={isDarwin}
              railIn={railIn}
              updateState={updateState}
              onQuitAndInstall={() => void quitAndInstall()}
              onToggleCollapse={toggleCollapse}
              onOpenSettings={onOpenSettings}
              onNavigate={handleNavigate}
            />
          )}
        </div>

        {isDarwin && effectiveCollapsed && (
          <div className={frameCss.leadingSeat}>
            <div className={leadingCss.controls}>
              <button
                type="button"
                className={cn(leadingCss.iconButton, 'relative')}
                aria-label={tx('nav.expandSidebar')}
                title={
                  updateState?.status === 'downloaded'
                    ? `${tx('nav.expandSidebar')} · ${formatDesktopUpdateText(updateState, tx)}`
                    : tx('nav.expandSidebar')
                }
                onClick={toggleCollapse}
              >
                <IconPanelLeftOutlineRegular size={16} />
                {updateState?.status === 'downloaded' && (
                  <span
                    aria-hidden="true"
                    data-testid="collapsed-update-badge"
                    className="absolute right-0.5 top-0.5 size-2 rounded-full bg-status-success-fg ring-2 ring-background"
                  />
                )}
              </button>
              <button
                type="button"
                className={leadingCss.iconButton}
                aria-label={tx('nav.newTask')}
                title={tx('nav.newTask')}
                onClick={() => handleNavigate('/')}
              >
                <IconNewChatOutlineRegular size={16} />
              </button>
            </div>
          </div>
        )}

        <div className={cn(frameCss.centerCol, conversationCss.root)}>
          {hasWindowHeader ? (
            <WindowHeaderProvider value={headerHost}>
              <header className={conversationCss.header} data-window-drag={isDarwin ? '' : undefined}>
                <div ref={setHeaderHost} className={conversationCss.titleRow} />
              </header>
              {content}
            </WindowHeaderProvider>
          ) : (
            <>
              {isDarwin && <div className={frameCss.darwinTopBar} data-window-drag aria-hidden="true" />}
              {content}
            </>
          )}
        </div>

        {!effectiveCollapsed && (
          <div
            className={frameCss.handle}
            style={{ left: sidebarWidthPx }}
            data-dragging={dragging ? 'true' : undefined}
            onPointerDown={(event) => handleResizePointerDown(event, sidebarWidthPx)}
            onPointerMove={handleResizePointerMove}
            onPointerUp={finishResizeDrag}
            onPointerCancel={finishResizeDrag}
            onLostPointerCapture={finishResizeDrag}
          />
        )}
      </div>
    </div>
  )
}
