import { useContext, useState, type MouseEvent } from 'react'
import { BrandGithub, HardDrive, ListVideo, MessageReport, Moon, RefreshCw, Sparkles, Sun, SunMoon, Workflow } from '@/lib/icons'
import {
  IconNewChatOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconSettingsOutlineMedium,
} from '@/components/ui/primitives/icons/index.tsx'
import { Menu } from '@/components/ui/primitives/Menu'
import { Tooltip } from '@/components/ui/primitives/Tooltip'
import { BrandMark } from '@/components/brand/brand-mark'
import { useText } from '@/lib/i18n'
import { useTheme, type ThemePreference } from '@/lib/theme'
import { NavigationContext } from '@/runtime/features'
import { cn } from '@/lib/utils'
import css from './SidebarRoot.module.css'

export interface DesktopUpdateState {
  status: string
  version?: string
  error?: string
}

export interface SidebarProps {
  pathname: string
  collapsed: boolean
  width?: number
  isDarwin?: boolean
  railIn?: boolean
  updateState?: DesktopUpdateState | null
  onToggleCollapse: () => void
  onOpenSettings: () => void
  onNavigate?: (path: string) => void
}

const FEEDBACK_URL = 'https://github.com/liuzhao1225/YouDub-webui/issues'
const GITHUB_URL = 'https://github.com/liuzhao1225/YouDub-webui'

function ThemeIcon({ theme }: { theme: ThemePreference }) {
  if (theme === 'light') return <Sun className="size-4" />
  if (theme === 'dark') return <Moon className="size-4" />
  return <SunMoon className="size-4" />
}

export function Sidebar({
  pathname,
  collapsed,
  width,
  isDarwin = false,
  railIn = false,
  updateState,
  onToggleCollapse,
  onOpenSettings,
  onNavigate,
}: SidebarProps) {
  const tx = useText()
  const { theme, setTheme } = useTheme()
  const contextNavigate = useContext(NavigationContext)
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)

  function go(path: string) {
    if (onNavigate) onNavigate(path)
    else contextNavigate(path)
  }

  function handleLinkClick(event: MouseEvent<HTMLAnchorElement>, path: string) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    go(path)
  }

  const navItems = [
    {
      path: '/',
      label: tx('client.workbench'),
      icon: Sparkles,
      active: pathname === '/',
    },
    {
      path: '/tasks',
      label: tx('client.library'),
      icon: ListVideo,
      active: pathname === '/tasks' || pathname.startsWith('/tasks/'),
    },
    {
      path: '/workflows',
      label: tx('client.workflows'),
      icon: Workflow,
      active: pathname === '/workflows' || pathname.startsWith('/workflows/'),
    },
    {
      path: '/resources',
      label: tx('client.resources'),
      icon: HardDrive,
      active: pathname === '/resources' || pathname.startsWith('/settings/resources'),
    },
  ]

  const toggleLabel = collapsed ? tx('nav.expandSidebar') : tx('nav.collapseSidebar')
  const showUpdatePill = updateState && (updateState.status === 'available' || updateState.status === 'downloading' || updateState.status === 'downloaded')
  const updateReady = updateState?.status === 'downloaded'
  const updateLabel = updateReady
    ? updateState?.version
      ? tx('app.updates.readyToInstallVersion', { version: updateState.version })
      : tx('app.updates.readyToInstall')
    : updateState?.version
      ? tx('app.updates.availableVersion', { version: updateState.version })
      : tx('app.updates.available')
  const themeControlLabel = tx('client.theme.control', { current: tx(`client.theme.${theme}`) })
  const tooltipSide = collapsed ? 'right' : 'top'

  return (
    <aside
      className={cn(
        css.root,
        collapsed && css.collapsed,
        !collapsed && css.wide,
        collapsed && railIn && css.railIn,
      )}
      style={!collapsed && width ? { width: `${width}px` } : undefined}
    >
      {isDarwin && !collapsed && (
        <div className={css.topStrip} data-window-drag>
          <Tooltip label={toggleLabel} side="right" delayMs={500} portal>
            <button
              type="button"
              className={cn(css.iconButton, css.toggle)}
              aria-label={toggleLabel}
              onClick={onToggleCollapse}
            >
              <IconPanelLeftOutlineRegular size={16} />
            </button>
          </Tooltip>
        </div>
      )}

      <div className={css.logoRow} data-window-drag={isDarwin ? '' : undefined}>
        {collapsed ? (
          <Tooltip label={toggleLabel} side="right" delayMs={500} portal>
            <button
              type="button"
              className={cn(css.iconButton, css.toggle)}
              aria-label={toggleLabel}
              onClick={onToggleCollapse}
            >
              <span className={css.railMark}>
                <BrandMark animated className="h-6 w-auto" />
              </span>
              <span className={css.panelIcon}>
                <IconPanelLeftOutlineRegular size={16} />
              </span>
            </button>
          </Tooltip>
        ) : (
          <>
            {isDarwin ? (
              <span className={css.brand}>
                <BrandMark animated wordmark wordmarkSrc="/youdub-logo.svg" className="h-8 w-auto" />
              </span>
            ) : (
              <button
                type="button"
                className={css.brand}
                onClick={() => go('/')}
                aria-label="YouDub"
              >
                <BrandMark animated wordmark wordmarkSrc="/youdub-logo.svg" className="h-8 w-auto" />
              </button>
            )}
            {!isDarwin && (
              <Tooltip label={toggleLabel} side="right" delayMs={500} portal>
                <button
                  type="button"
                  className={cn(css.iconButton, css.toggle)}
                  aria-label={toggleLabel}
                  onClick={onToggleCollapse}
                >
                  <IconPanelLeftOutlineRegular size={16} />
                </button>
              </Tooltip>
            )}
          </>
        )}
      </div>

      <Tooltip label={tx('nav.newTask')} side="right" delayMs={500} portal disabled={!collapsed}>
        <button
          type="button"
          className={css.newSession}
          aria-label={tx('nav.newTask')}
          onClick={() => go('/')}
        >
          <span className={css.newSessionContent}>
            <IconNewChatOutlineRegular size={16} />
            {!collapsed && (
              <span className={css.newSessionLabelMask}>
                <span className={css.newSessionLabel}>{tx('nav.newTask')}</span>
              </span>
            )}
          </span>
        </button>
      </Tooltip>

      <nav aria-label={tx('nav.primary')} className={css.panelList}>
        {navItems.map((item) => {
          const Icon = item.icon
          return (
            <Tooltip key={item.path} label={item.label} side="right" delayMs={500} portal disabled={!collapsed}>
              <a
                href={item.path}
                aria-label={item.label}
                aria-current={item.active ? 'page' : undefined}
                onClick={(event) => handleLinkClick(event, item.path)}
                className={cn(css.panelRow, item.active && css.panelActive, 'no-underline')}
              >
                <span className={css.panelGlyph}>
                  <Icon className="size-4" />
                </span>
                {!collapsed && <span className={css.panelTitle}>{item.label}</span>}
              </a>
            </Tooltip>
          )
        })}
      </nav>

      <div className={css.regionArea} />

      <div className={css.footArea}>
        {showUpdatePill && (
          <div className={cn(css.footerActions, 'mb-1')}>
            <button
              type="button"
              onClick={() => {
                if (updateReady) void window.youdubDesktop?.quitAndInstall()
                else void window.youdubDesktop?.checkForUpdates()
              }}
              aria-label={updateLabel}
              title={updateLabel}
              className={cn(
                css.panelRow,
                !collapsed && 'w-full',
                updateReady
                  ? 'bg-status-success/15 text-status-success-fg hover:bg-status-success/20'
                  : 'bg-status-running/15 text-status-running-fg hover:bg-status-running/20',
              )}
            >
              <span className={css.panelGlyph}>
                <RefreshCw className="size-4" />
              </span>
              {!collapsed && <span className={css.panelTitle}>{updateLabel}</span>}
            </button>
          </div>
        )}

        <div className={collapsed ? 'flex flex-col items-center gap-1' : 'flex items-center gap-1 pt-2'}>
          <Tooltip label={tx('client.settings')} side={tooltipSide} portal>
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label={tx('client.settings')}
              className={css.iconButton}
            >
              <IconSettingsOutlineMedium size={16} />
            </button>
          </Tooltip>

          <Menu
            open={themeMenuOpen}
            onClose={() => setThemeMenuOpen(false)}
            portal
            autoFocus
            side={collapsed ? 'bottom' : 'top'}
            align="start"
            selectedId={theme}
            items={[
              { id: 'light', label: tx('client.theme.light'), icon: <Sun className="size-4" /> },
              { id: 'dark', label: tx('client.theme.dark'), icon: <Moon className="size-4" /> },
              { id: 'system', label: tx('client.theme.system'), icon: <SunMoon className="size-4" /> },
            ]}
            onSelect={(id) => {
              setTheme(id as ThemePreference)
              setThemeMenuOpen(false)
            }}
            anchor={
              <Tooltip label={themeControlLabel} side={tooltipSide} portal disabled={themeMenuOpen}>
                <button
                  type="button"
                  onClick={() => setThemeMenuOpen((current) => !current)}
                  aria-label={themeControlLabel}
                  aria-haspopup="menu"
                  aria-expanded={themeMenuOpen}
                  className={css.iconButton}
                >
                  <ThemeIcon theme={theme} />
                </button>
              </Tooltip>
            }
          />

          <Tooltip label={tx('client.feedback')} side={tooltipSide} portal>
            <a
              href={FEEDBACK_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={tx('client.feedback')}
              className={cn(css.iconButton, 'no-underline')}
            >
              <MessageReport className="size-4" />
            </a>
          </Tooltip>

          <Tooltip label="GitHub" side={tooltipSide} portal>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub"
              className={cn(css.iconButton, 'no-underline')}
            >
              <BrandGithub className="size-4" />
            </a>
          </Tooltip>
        </div>
      </div>
    </aside>
  )
}
