import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { LANGUAGE_OPTIONS, languagePacks, sharedMessages, translateMessage, type Text, type UiLanguage } from '@/locales'

export { LANGUAGE_OPTIONS }
export type { Text, UiLanguage }

export interface LanguageSource {
  getSnapshot: () => { active: UiLanguage; revision: number }
  subscribe: (listener: () => void) => () => void
  text: Text
  setLanguage: (language: UiLanguage) => void
}

type I18nContextValue = {
  language: UiLanguage
  setLanguage: (language: UiLanguage) => void
  text: Text
  t: ReturnType<typeof sharedMessages>
}

const STORAGE_KEY = 'youdub-ui-language'
const NOOP_SUBSCRIBE = () => () => {}
const FALLBACK_LANG_SNAPSHOT: { active: UiLanguage; revision: number } = { active: 'zh', revision: 0 }
const getFallbackLangSnapshot = () => FALLBACK_LANG_SNAPSHOT
const I18nContext = createContext<I18nContextValue | null>(null)

function readInitialLanguage(): UiLanguage {
  if (typeof window === 'undefined') return 'zh'
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved && languagePacks.some((pack) => pack.id === saved)) return saved
  } catch { /* ignore */ }
  return 'zh'
}

export function LanguageProvider({ children, source, onChangeLanguage }: {
  children: ReactNode
  source?: LanguageSource
  onChangeLanguage?: (language: UiLanguage) => void
}) {
  const [localLanguage, setLocalLanguage] = useState<UiLanguage>(() => source ? 'zh' : readInitialLanguage())

  const externalSnapshot = useSyncExternalStore(
    source?.subscribe ?? NOOP_SUBSCRIBE,
    source?.getSnapshot ?? getFallbackLangSnapshot,
    source?.getSnapshot ?? getFallbackLangSnapshot,
  )

  const language = source ? externalSnapshot.active : localLanguage

  const setLanguage = useCallback((next: UiLanguage) => {
    if (source) {
      source.setLanguage(next)
      return
    }
    setLocalLanguage(next)
    try { window.localStorage.setItem(STORAGE_KEY, next) } catch { /* ignore */ }
    onChangeLanguage?.(next)
  }, [source, onChangeLanguage])

  const text = useCallback<Text>((key, params) => {
    if (source) return source.text(key, params)
    return translateMessage(language, key, params)
  }, [source, language])

  const value = useMemo<I18nContextValue>(() => ({
    language,
    setLanguage,
    text,
    t: sharedMessages(text),
  }), [language, setLanguage, text])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    const fallbackText: Text = (key, params) => translateMessage('zh', key, params)
    return {
      language: 'zh',
      setLanguage: () => {},
      text: fallbackText,
      t: sharedMessages(fallbackText),
    }
  }
  return ctx
}

export function useText(): Text {
  return useI18n().text
}
