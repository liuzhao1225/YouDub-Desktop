import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'

export interface ThemeSource {
  getSnapshot: () => { preference: ThemePreference | string }
  subscribe: (listener: () => void) => () => void
  setTheme: (preference: ThemePreference) => void
}

type ThemeContextValue = {
  theme: ThemePreference
  resolvedTheme: 'light' | 'dark'
  setTheme: (preference: ThemePreference) => void
}

const STORAGE_KEY = 'youdub-theme'
const NOOP_SUBSCRIBE = () => () => {}
const FALLBACK_SNAPSHOT = { preference: 'system' }
const getFallbackSnapshot = () => FALLBACK_SNAPSHOT
const ThemeContext = createContext<ThemeContextValue | null>(null)

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function applyThemeAttributes(isDark: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', isDark)
  document.body.toggleAttribute('data-ds-dark-theme', isDark)
}

function readStoredTheme(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch { /* ignore */ }
  return 'system'
}

export function ThemeProvider({ children, source, onChangeTheme }: {
  children: ReactNode
  source?: ThemeSource
  onChangeTheme?: (preference: ThemePreference) => void
}) {
  const [localTheme, setLocalTheme] = useState<ThemePreference>(() => source ? 'system' : readStoredTheme())
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark())

  const externalSnapshot = useSyncExternalStore(
    source?.subscribe ?? NOOP_SUBSCRIBE,
    source?.getSnapshot ?? getFallbackSnapshot,
    source?.getSnapshot ?? getFallbackSnapshot,
  )

  const theme = (source ? externalSnapshot.preference : localTheme) as ThemePreference
  const resolvedTheme: 'light' | 'dark' = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : systemDark ? 'dark' : 'light'

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    applyThemeAttributes(resolvedTheme === 'dark')
  }, [resolvedTheme])

  const setTheme = (next: ThemePreference) => {
    if (source) {
      source.setTheme(next)
      return
    }
    setLocalTheme(next)
    try { window.localStorage.setItem(STORAGE_KEY, next) } catch { /* ignore */ }
    onChangeTheme?.(next)
  }

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    return {
      theme: 'system',
      resolvedTheme: systemPrefersDark() ? 'dark' : 'light',
      setTheme: () => {},
    }
  }
  return ctx
}
