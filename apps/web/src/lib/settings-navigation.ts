import { createContext, useContext } from 'react'
import type { SettingsTab } from '@/components/settings/SettingsModal'

export type SettingsFocusSection = 'youtube-cookies' | 'proxy' | 'volcengine'

export type OpenSettingsFn = (tab?: SettingsTab, focusSection?: SettingsFocusSection) => void

export const SettingsActionContext = createContext<OpenSettingsFn | null>(null)

export function useOpenSettings(): OpenSettingsFn | null {
  return useContext(SettingsActionContext)
}
