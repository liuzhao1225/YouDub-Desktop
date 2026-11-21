import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import { createApiRequest, EventStreamClient } from '@/lib/api'
import { getDesktopBridge } from '@/lib/desktop-bridge'
import { installWindowDragRecall } from '@/lib/window-drag-recall'
import { LanguageProvider, useI18n, useText } from '@/lib/i18n'
import { Moon, Sun, SunMoon } from '@/lib/icons'
import { ThemeProvider, useTheme, type ThemePreference } from '@/lib/theme'
import type { UiLanguage } from '@/locales'
import type { Request as ApiRequest } from '@/plugin/runtime/types'
import {
  createFeatures,
  FeatureProvider,
  NavigationContext,
  useFeatures,
  type SlotRegistry,
} from '@/runtime/features'
import { matchRoute } from '@/plugin/domain-helpers'
import type { NodeEditorProps, PanelProps, SlotMap } from '@/plugin/sdk'
import { Studio } from '@/plugin/builtin/studio'
import { Library, TaskDetail } from '@/plugin/builtin/library'
import { WorkflowLibrary, WorkflowRoute } from '@/plugin/builtin/workflows'
import {
  TaskNodePage,
  TaskWorkflowPanel,
  TranscriptNodeDetails,
  TranslationNodeDetails,
} from '@/plugin/builtin/workflow-task'
import { SynthesizeNodeEditor } from '@/plugin/builtin/workflow-settings'
import { SetupGate } from '@/components/setup-gate'
import { SettingsResources } from '@/components/settings-resources'
import { SettingsModal, type SettingsTab } from '@/components/settings/SettingsModal'
import { SettingsActionContext, type SettingsFocusSection } from '@/lib/settings-navigation'
import { AppShell } from '@/components/shell/AppShell'
import { Page } from '@/components/page-layout'
import { Button } from '@/components/ui/button'

interface RouterLocation {
  pathname: string
  search: string
}

interface RemoteSettings {
  ui_language?: string
  theme?: string
}

const VALID_THEMES = new Set<ThemePreference>(['system', 'light', 'dark'])
const VALID_LANGUAGES = new Set<UiLanguage>(['zh', 'en', 'ja'])
const THEME_ORDER: readonly ThemePreference[] = ['system', 'light', 'dark']

function normalizePathname(raw: string): string {
  if (!raw || raw === '/') return '/'
  return raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw
}

function parseHref(href: string): RouterLocation {
  if (typeof window === 'undefined') {
    const [pathPart, searchPart = ''] = href.split('?')
    return {
      pathname: normalizePathname(pathPart || '/'),
      search: searchPart ? `?${searchPart}` : '',
    }
  }
  const url = new URL(href, window.location.origin)
  return {
    pathname: normalizePathname(url.pathname),
    search: url.search,
  }
}

function readInitialRouterState(): {
  location: RouterLocation
  initialModal: { open: boolean; tab: SettingsTab; focusSection?: SettingsFocusSection }
} {
  if (typeof window === 'undefined') {
    return {
      location: { pathname: '/', search: '' },
      initialModal: { open: false, tab: 'general' },
    }
  }
  const pathname = normalizePathname(window.location.pathname)
  if (pathname === '/settings') {
    window.history.replaceState(null, '', '/')
    return {
      location: { pathname: '/', search: '' },
      initialModal: { open: true, tab: 'general' },
    }
  }
  if (pathname === '/settings/models') {
    window.history.replaceState(null, '', '/')
    return {
      location: { pathname: '/', search: '' },
      initialModal: { open: true, tab: 'llm' },
    }
  }
  return {
    location: { pathname, search: window.location.search },
    initialModal: { open: false, tab: 'general' },
  }
}

function BoundTaskWorkflowPanel(props: PanelProps) {
  const { request, navigate, useQuery } = useFeatures()
  return <TaskWorkflowPanel {...props} request={request} navigate={navigate} useQuery={useQuery} />
}

function BoundSynthesizeNodeEditor(props: NodeEditorProps) {
  const { useSlot } = useFeatures()
  return <SynthesizeNodeEditor {...props} useSlot={useSlot} />
}

export const builtinSlots: SlotRegistry = {
  list<K extends keyof SlotMap>(slot: K): SlotMap[K][] {
    if (slot === 'task.detail.panels') {
      return [{ id: 'youdub.task.workflow', component: BoundTaskWorkflowPanel }] as SlotMap[K][]
    }
    if (slot === 'workflow.node.editors') {
      return [{ id: 'youdub.synthesize', component: BoundSynthesizeNodeEditor }] as SlotMap[K][]
    }
    if (slot === 'workflow.node.details') {
      return [
        { id: 'youdub.transcript', component: TranscriptNodeDetails },
        { id: 'youdub.translation', component: TranslationNodeDetails },
      ] as SlotMap[K][]
    }
    return []
  },
}

function SetupThemeControl() {
  const tx = useText()
  const { theme, resolvedTheme, setTheme } = useTheme()
  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]
  const label = tx('client.theme.control', { current: tx(`client.theme.${theme}`) })
  const Icon = theme === 'system' ? SunMoon : resolvedTheme === 'dark' ? Moon : Sun
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={() => setTheme(nextTheme)}
    >
      <Icon className="size-4" />
      <span>{tx(`client.theme.${theme}`)}</span>
    </Button>
  )
}

function Workbench({
  request,
  events,
  syncingSettingsRef,
  modalOpenRef,
  openSettingsHandlerRef,
  pendingOpenSettingsRef,
}: {
  request: ApiRequest
  events: EventStreamClient
  syncingSettingsRef: MutableRefObject<boolean>
  modalOpenRef: MutableRefObject<boolean>
  openSettingsHandlerRef: MutableRefObject<(() => void) | null>
  pendingOpenSettingsRef: MutableRefObject<boolean>
}) {
  const tx = useText()
  const { language, setLanguage } = useI18n()
  const { theme, setTheme } = useTheme()

  const languageRef = useRef(language)
  const themeRef = useRef(theme)

  useEffect(() => {
    languageRef.current = language
  }, [language])

  useEffect(() => {
    themeRef.current = theme
  }, [theme])

  const [controller] = useState(() => {
    const initial = readInitialRouterState()
    let currentLocation: RouterLocation = initial.location
    let currentModal = initial.initialModal
    const locationListeners = new Set<() => void>()
    const modalListeners = new Set<() => void>()
    const blockers = new Set<(path: string) => Promise<boolean>>()

    const notifyLocation = () => locationListeners.forEach((fn) => fn())
    const notifyModal = () => modalListeners.forEach((fn) => fn())

    const runBlockers = async (targetHref: string): Promise<boolean> => {
      for (const blocker of [...blockers]) {
        if (!(await blocker(targetHref))) return false
      }
      return true
    }

    const blockNavigation = (handler: (path: string) => Promise<boolean>) => {
      blockers.add(handler)
      return () => {
        blockers.delete(handler)
      }
    }

    const navigate = (href: string) => {
      const next = parseHref(href)
      if (next.pathname === '/settings') {
        currentModal = { open: true, tab: 'general' }
        notifyModal()
        return
      }
      if (next.pathname === '/settings/models') {
        currentModal = { open: true, tab: 'llm' }
        notifyModal()
        return
      }
      const targetHref = `${next.pathname}${next.search}`
      const currentHref = `${currentLocation.pathname}${currentLocation.search}`
      if (targetHref === currentHref) return

      void runBlockers(targetHref).then((allowed) => {
        if (!allowed) return
        if (typeof window !== 'undefined') {
          window.history.pushState(null, '', targetHref)
        }
        currentLocation = next
        notifyLocation()
      })
    }

    const handlePopState = () => {
      if (typeof window === 'undefined') return
      const next = parseHref(`${window.location.pathname}${window.location.search}`)
      const currentHref = `${currentLocation.pathname}${currentLocation.search}`
      if (next.pathname === '/settings' || next.pathname === '/settings/models') {
        const tab: SettingsTab = next.pathname === '/settings/models' ? 'llm' : 'general'
        window.history.replaceState(null, '', currentHref)
        currentModal = { open: true, tab }
        notifyModal()
        return
      }
      const targetHref = `${next.pathname}${next.search}`
      if (targetHref === currentHref) return
      void runBlockers(targetHref).then((allowed) => {
        if (!allowed) {
          window.history.pushState(null, '', currentHref)
          return
        }
        currentLocation = next
        notifyLocation()
      })
    }

    return {
      getLocation: () => currentLocation,
      subscribeLocation: (listener: () => void) => {
        locationListeners.add(listener)
        return () => {
          locationListeners.delete(listener)
        }
      },
      getModal: () => currentModal,
      subscribeModal: (listener: () => void) => {
        modalListeners.add(listener)
        return () => {
          modalListeners.delete(listener)
        }
      },
      openSettings: (tab: SettingsTab = 'general', focusSection?: SettingsFocusSection) => {
        currentModal = { open: true, tab, focusSection }
        notifyModal()
      },
      closeSettings: () => {
        currentModal = { open: false, tab: currentModal.tab }
        notifyModal()
      },
      handlePopState,
      features: createFeatures(navigate, blockNavigation, request, builtinSlots, events),
    }
  })

  const location = useSyncExternalStore(controller.subscribeLocation, controller.getLocation, controller.getLocation)
  const settingsModal = useSyncExternalStore(controller.subscribeModal, controller.getModal, controller.getModal)
  const features = controller.features

  useEffect(() => {
    modalOpenRef.current = settingsModal.open
  }, [modalOpenRef, settingsModal.open])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.addEventListener('popstate', controller.handlePopState)
    return () => window.removeEventListener('popstate', controller.handlePopState)
  }, [controller])

  useEffect(() => {
    const open = () => controller.openSettings('general')
    openSettingsHandlerRef.current = open
    if (pendingOpenSettingsRef.current) {
      pendingOpenSettingsRef.current = false
      open()
    }
    return () => {
      if (openSettingsHandlerRef.current === open) {
        openSettingsHandlerRef.current = null
      }
    }
  }, [controller, openSettingsHandlerRef, pendingOpenSettingsRef])

  useEffect(() => {
    events.start()
    return () => events.stop()
  }, [events])

  useEffect(() => {
    let cancelled = false
    const syncRemoteSettings = () => {
      void request<RemoteSettings>('/api/settings')
        .then((remote) => {
          if (cancelled) return
          syncingSettingsRef.current = true
          try {
            if (remote.ui_language && VALID_LANGUAGES.has(remote.ui_language) && remote.ui_language !== languageRef.current) {
              setLanguage(remote.ui_language)
            }
            if (remote.theme && VALID_THEMES.has(remote.theme as ThemePreference) && remote.theme !== themeRef.current) {
              setTheme(remote.theme as ThemePreference)
            }
          } finally {
            syncingSettingsRef.current = false
          }
        })
        .catch(() => undefined)
    }

    syncRemoteSettings()
    const unsubscribe = events.on('settings.updated', syncRemoteSettings)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [events, request, setLanguage, setTheme, syncingSettingsRef])

  const openGeneralSettings = useCallback(() => {
    controller.openSettings('general')
  }, [controller])

  const closeSettingsModal = useCallback(() => {
    controller.closeSettings()
  }, [controller])

  const routeContent = useMemo<ReactNode>(() => {
    const { pathname, search } = location
    if (pathname === '/') {
      return (
        <Studio
          draftStore={features.draftStore}
          request={features.request}
          navigate={features.navigate}
          useQuery={features.useQuery}
          useSlot={features.useSlot}
          useWorkflowDocuments={features.useWorkflowDocuments}
          useWorkflowResources={features.useWorkflowResources}
        />
      )
    }
    if (pathname === '/tasks') {
      return <Library useQuery={features.useQuery} navigate={features.navigate} />
    }
    const taskDetailParams = matchRoute(pathname, '/tasks/:id')
    if (taskDetailParams) {
      return (
        <TaskDetail
          params={taskDetailParams}
          request={features.request}
          navigate={features.navigate}
          useQuery={features.useQuery}
          useSlot={features.useSlot}
        />
      )
    }
    const taskNodeParams = matchRoute(pathname, '/tasks/:id/nodes/:nodeId')
    if (taskNodeParams) {
      return (
        <TaskNodePage
          submissionStore={features.submissionStore}
          params={taskNodeParams}
          request={features.request}
          navigate={features.navigate}
          blockNavigation={features.blockNavigation}
          useQuery={features.useQuery}
          useSlot={features.useSlot}
        />
      )
    }
    if (pathname === '/workflows') {
      return (
        <WorkflowLibrary
          request={features.request}
          navigate={features.navigate}
          useWorkflowDocuments={features.useWorkflowDocuments}
        />
      )
    }
    const workflowNodeParams = matchRoute(pathname, '/workflows/:id/nodes/:nodeId')
    if (workflowNodeParams) {
      return (
        <WorkflowRoute
          key={`${workflowNodeParams.id}:${workflowNodeParams.nodeId}`}
          params={{ ...workflowNodeParams, __search: search }}
          request={features.request}
          navigate={features.navigate}
          blockNavigation={features.blockNavigation}
          useQuery={features.useQuery}
          useSlot={features.useSlot}
          useWorkflowResources={features.useWorkflowResources}
        />
      )
    }
    const workflowParams = matchRoute(pathname, '/workflows/:id')
    if (workflowParams) {
      return (
        <WorkflowRoute
          key={`${workflowParams.id}:`}
          params={{ ...workflowParams, __search: search }}
          request={features.request}
          navigate={features.navigate}
          blockNavigation={features.blockNavigation}
          useQuery={features.useQuery}
          useSlot={features.useSlot}
          useWorkflowResources={features.useWorkflowResources}
        />
      )
    }
    if (pathname === '/resources' || pathname === '/settings/resources') {
      return (
        <Page>
          <SettingsResources
            request={features.request}
            title={tx('client.resources')}
            events={events}
            onOpenSettings={controller.openSettings}
            onNavigate={features.navigate}
          />
        </Page>
      )
    }
    return (
      <Page>
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <p className="text-sm text-muted-foreground">{tx('client.pageNotFound')}</p>
          <Button variant="outline" onClick={() => features.navigate('/')}>
            {tx('client.backToWorkbench')}
          </Button>
        </div>
      </Page>
    )
  }, [controller, events, features, location, tx])

  return (
    <NavigationContext.Provider value={features.navigate}>
      <SettingsActionContext.Provider value={controller.openSettings}>
        <FeatureProvider value={features}>
          <AppShell
            pathname={location.pathname}
            onNavigate={features.navigate}
            onOpenSettings={openGeneralSettings}
          >
            {routeContent}
          </AppShell>
          <SettingsModal
            open={settingsModal.open}
            onClose={closeSettingsModal}
            initialTab={settingsModal.tab}
            focusSection={settingsModal.focusSection}
            request={features.request}
          />
        </FeatureProvider>
      </SettingsActionContext.Provider>
    </NavigationContext.Provider>
  )
}

export function App() {
  const [request] = useState(() => createApiRequest())
  const [events] = useState(() => new EventStreamClient())
  const syncingSettingsRef = useRef(false)
  const modalOpenRef = useRef(false)
  const openSettingsHandlerRef = useRef<(() => void) | null>(null)
  const pendingOpenSettingsRef = useRef(false)

  useEffect(() => installWindowDragRecall({ document }), [])

  useEffect(() => {
    return getDesktopBridge()?.onOpenSettings?.(() => {
      if (openSettingsHandlerRef.current) {
        openSettingsHandlerRef.current()
      } else {
        pendingOpenSettingsRef.current = true
      }
    })
  }, [])

  const handleThemeChange = useCallback((next: ThemePreference) => {
    if (syncingSettingsRef.current || modalOpenRef.current) return
    void request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ theme: next }),
    }).catch(() => undefined)
  }, [request])

  const handleLanguageChange = useCallback((next: UiLanguage) => {
    if (syncingSettingsRef.current || modalOpenRef.current) return
    void request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ ui_language: next }),
    }).catch(() => undefined)
  }, [request])

  const pickDirectory = getDesktopBridge()?.pickDirectory

  return (
    <ThemeProvider onChangeTheme={handleThemeChange}>
      <LanguageProvider onChangeLanguage={handleLanguageChange}>
        <SetupGate
          request={request}
          screenProps={{
            wordmarkSrc: '/youdub-logo.svg',
            themeControl: <SetupThemeControl />,
            pickDirectory,
          }}
        >
          <Workbench
            request={request}
            events={events}
            syncingSettingsRef={syncingSettingsRef}
            modalOpenRef={modalOpenRef}
            openSettingsHandlerRef={openSettingsHandlerRef}
            pendingOpenSettingsRef={pendingOpenSettingsRef}
          />
        </SetupGate>
      </LanguageProvider>
    </ThemeProvider>
  )
}

export default App
