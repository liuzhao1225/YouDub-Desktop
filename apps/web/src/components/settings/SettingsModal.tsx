import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, Eye, EyeOff, FolderOpen, Loader2, Plus, RefreshCw, Sparkles, Trash2, Upload, X } from '@/lib/icons'
import { Modal } from '@/components/ui/primitives/Modal'
import { SegmentedControl } from '@/components/ui/primitives/SegmentedControl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Surface } from '@/components/ui/surface'
import { Switch } from '@/components/ui/switch'
import { Tag } from '@/components/ui/tag'
import { Textarea } from '@/components/ui/textarea'
import { InlineAlert } from '@/components/inline-alert'
import { LANGUAGE_OPTIONS, useI18n, useText } from '@/lib/i18n'
import { useTheme, type ThemePreference } from '@/lib/theme'
import { cn } from '@/lib/utils'
import type { Request as ApiRequest } from '@/plugin/runtime/types'
import type { SettingsFocusSection } from '@/lib/settings-navigation'

export type SettingsTab = 'general' | 'llm'
type ProtocolKind = 'openai' | 'anthropic' | 'gemini'

export interface LLMPreset {
  id: string
  name: string
  protocol: ProtocolKind
  base_url: string
  default_model: string
  models: string[]
  requires_api_key: boolean
}

export interface LLMProviderView {
  id: string
  name: string
  protocol: ProtocolKind
  preset: string
  base_url: string
  default_model: string
  models: string[]
  enabled: boolean
  requiresApiKey: boolean
  hasApiKey: boolean
  apiKeyHint: string
  available: boolean
  unavailableReason: string | null
}

interface SettingsView {
  ui_language: string
  theme: ThemePreference
  data_dir: string | null
  default_data_dir: string
  proxy_url: string
  has_youtube_cookies?: boolean
  llm_providers?: LLMProviderView[]
}

interface ProviderDraft {
  id: string
  name: string
  protocol: ProtocolKind
  preset: string
  base_url: string
  default_model: string
  models: string[]
  enabled: boolean
  requiresApiKey: boolean
  hasApiKey: boolean
  apiKeyHint: string
  apiKey: string
  clearApiKey: boolean
  isNew: boolean
}

interface ProbeResponse {
  ok: boolean
  latencyMs?: number
  model?: string
  message?: string
}

const EXTRA_PRESETS: LLMPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    base_url: 'https://api.openai.com/v1',
    default_model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    requires_api_key: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    base_url: 'https://api.deepseek.com/v1',
    default_model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    requires_api_key: true,
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    protocol: 'openai',
    base_url: 'https://api.siliconflow.cn/v1',
    default_model: 'deepseek-ai/DeepSeek-V3',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    requires_api_key: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    base_url: 'https://openrouter.ai/api/v1',
    default_model: 'openai/gpt-4o-mini',
    models: ['openai/gpt-4o-mini', 'deepseek/deepseek-chat-v3-0324'],
    requires_api_key: true,
  },
  {
    id: 'dashscope',
    name: 'DashScope',
    protocol: 'openai',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    default_model: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    requires_api_key: true,
  },
  {
    id: 'zhipu',
    name: 'Zhipu',
    protocol: 'openai',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    default_model: 'glm-4-plus',
    models: ['glm-4-plus', 'glm-4-air'],
    requires_api_key: true,
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    protocol: 'openai',
    base_url: 'https://api.moonshot.cn/v1',
    default_model: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
    requires_api_key: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    base_url: 'https://api.anthropic.com',
    default_model: 'claude-sonnet-4-20250514',
    models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-latest'],
    requires_api_key: true,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    protocol: 'gemini',
    base_url: 'https://generativelanguage.googleapis.com',
    default_model: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    requires_api_key: true,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    protocol: 'openai',
    base_url: 'http://127.0.0.1:11434/v1',
    default_model: 'qwen2.5:14b',
    models: [],
    requires_api_key: false,
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    protocol: 'openai',
    base_url: 'http://127.0.0.1:1234/v1',
    default_model: '',
    models: [],
    requires_api_key: false,
  },
  {
    id: 'custom',
    name: 'Custom',
    protocol: 'openai',
    base_url: '',
    default_model: '',
    models: [],
    requires_api_key: true,
  },
]

function mergePresets(serverPresets: LLMPreset[]): LLMPreset[] {
  const map = new Map<string, LLMPreset>()
  for (const preset of serverPresets) map.set(preset.id, preset)
  for (const extra of EXTRA_PRESETS) {
    if (!map.has(extra.id)) map.set(extra.id, extra)
  }
  const preferredOrder = EXTRA_PRESETS.map((p) => p.id)
  return [...map.values()].sort((a, b) => {
    const ia = preferredOrder.indexOf(a.id)
    const ib = preferredOrder.indexOf(b.id)
    if (ia === -1 && ib === -1) return a.name.localeCompare(b.name)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
}

function toDraft(provider: LLMProviderView): ProviderDraft {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    preset: provider.preset,
    base_url: provider.base_url,
    default_model: provider.default_model,
    models: [...provider.models],
    enabled: provider.enabled,
    requiresApiKey: provider.requiresApiKey,
    hasApiKey: provider.hasApiKey,
    apiKeyHint: provider.apiKeyHint,
    apiKey: '',
    clearApiKey: false,
    isNew: false,
  }
}

function draftFromPreset(preset: LLMPreset, existing: LLMProviderView[]): ProviderDraft {
  const taken = new Set(existing.map((item) => item.id))
  let id = preset.id || 'custom'
  if (taken.has(id)) {
    let idx = 2
    while (taken.has(`${id}-${idx}`)) idx += 1
    id = `${id}-${idx}`
  }
  return {
    id,
    name: preset.name,
    protocol: preset.protocol,
    preset: preset.id,
    base_url: preset.base_url,
    default_model: preset.default_model,
    models: [...preset.models],
    enabled: true,
    requiresApiKey: preset.requires_api_key,
    hasApiKey: false,
    apiKeyHint: '',
    apiKey: '',
    clearApiKey: false,
    isNew: true,
  }
}

function isDraftDirty(draft: ProviderDraft | null, providers: LLMProviderView[]): boolean {
  if (!draft) return false
  if (draft.isNew) return true
  const base = providers.find((item) => item.id === draft.id)
  if (!base) return true
  return (
    draft.name !== base.name ||
    draft.protocol !== base.protocol ||
    draft.base_url !== base.base_url ||
    draft.default_model !== base.default_model ||
    draft.enabled !== base.enabled ||
    Boolean(draft.apiKey.trim()) ||
    draft.clearApiKey ||
    draft.models.join('\n') !== base.models.join('\n')
  )
}

export interface SettingsModalProps {
  open: boolean
  onClose: () => void
  initialTab?: SettingsTab
  focusSection?: SettingsFocusSection
  request: ApiRequest
}

export function SettingsModal({ open, onClose, initialTab = 'general', focusSection, request }: SettingsModalProps) {
  if (!open) return null
  return (
    <SettingsModalContent
      key={`${initialTab}:${focusSection ?? ''}`}
      onClose={onClose}
      initialTab={initialTab}
      focusSection={focusSection}
      request={request}
    />
  )
}

function SettingsModalContent({
  onClose,
  initialTab,
  focusSection,
  request,
}: {
  onClose: () => void
  initialTab: SettingsTab
  focusSection?: SettingsFocusSection
  request: ApiRequest
}) {
  const tx = useText()
  const { language, setLanguage } = useI18n()
  const { theme, setTheme } = useTheme()
  const tabsId = useId()
  const fieldIdPrefix = useId()
  const [tab, setTab] = useState<SettingsTab>(initialTab)

  // General state
  const [loadingGeneral, setLoadingGeneral] = useState(true)
  const [generalError, setGeneralError] = useState('')
  const [generalSaved, setGeneralSaved] = useState(false)
  const [savingField, setSavingField] = useState<string>('')
  const [dataDir, setDataDir] = useState('')
  const [savedDataDir, setSavedDataDir] = useState('')
  const [defaultDataDir, setDefaultDataDir] = useState('')
  const [proxyUrl, setProxyUrl] = useState('')
  const [savedProxyUrl, setSavedProxyUrl] = useState('')
  const [hasYoutubeCookies, setHasYoutubeCookies] = useState(false)
  const [youtubeCookiesDraft, setYoutubeCookiesDraft] = useState('')
  const [highlightedSection, setHighlightedSection] = useState<SettingsFocusSection | undefined>(focusSection)
  const cookieFileRef = useRef<HTMLInputElement>(null)
  const proxySectionRef = useRef<HTMLDivElement>(null)
  const proxyInputRef = useRef<HTMLInputElement>(null)
  const youtubeCookiesSectionRef = useRef<HTMLDivElement>(null)
  const youtubeCookiesInputRef = useRef<HTMLTextAreaElement>(null)
  const youtubeCookiesId = useId()

  // LLM state
  const [loadingLlm, setLoadingLlm] = useState(true)
  const [llmError, setLlmError] = useState('')
  const [providers, setProviders] = useState<LLMProviderView[]>([])
  const [serverPresets, setServerPresets] = useState<LLMPreset[]>([])
  const [selectedPreset, setSelectedPreset] = useState('openai')
  const [draft, setDraft] = useState<ProviderDraft | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [discoverNote, setDiscoverNote] = useState('')
  const [testing, setTesting] = useState(false)
  const [testNote, setTestNote] = useState('')
  const [savingProvider, setSavingProvider] = useState(false)
  const [deletingProvider, setDeletingProvider] = useState(false)
  const [providerSavedNote, setProviderSavedNote] = useState('')

  const presets = useMemo(() => mergePresets(serverPresets), [serverPresets])

  useEffect(() => {
    const controller = new AbortController()

    void request<SettingsView>('/api/settings', { signal: controller.signal })
      .then((settings) => {
        if (controller.signal.aborted) return
        const resolvedDir = settings.data_dir ?? settings.default_data_dir ?? ''
        setDataDir(resolvedDir)
        setSavedDataDir(settings.data_dir ?? '')
        setDefaultDataDir(settings.default_data_dir ?? '')
        setProxyUrl(settings.proxy_url ?? '')
        setSavedProxyUrl(settings.proxy_url ?? '')
        setHasYoutubeCookies(Boolean(settings.has_youtube_cookies))
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setGeneralError(failure instanceof Error ? failure.message : String(failure))
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingGeneral(false)
      })

    void Promise.all([
      request<{ items: LLMProviderView[] }>('/api/llm/providers', { signal: controller.signal }),
      request<{ items: LLMPreset[] }>('/api/llm/presets', { signal: controller.signal }).catch(() => ({ items: [] as LLMPreset[] })),
    ])
      .then(([provRes, presetRes]) => {
        if (controller.signal.aborted) return
        const items = provRes.items ?? []
        setProviders(items)
        setServerPresets(presetRes.items ?? [])
        setDraft((current) => {
          if (current && !current.isNew) {
            const match = items.find((item) => item.id === current.id)
            if (match) return toDraft(match)
          }
          return items[0] ? toDraft(items[0]) : null
        })
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setLlmError(failure instanceof Error ? failure.message : String(failure))
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingLlm(false)
      })

    return () => controller.abort()
  }, [request])

  useEffect(() => {
    if (loadingGeneral || tab !== 'general' || !focusSection) return
    const section =
      focusSection === 'youtube-cookies' ? youtubeCookiesSectionRef.current : proxySectionRef.current
    const input =
      focusSection === 'youtube-cookies' ? youtubeCookiesInputRef.current : proxyInputRef.current
    section?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    input?.focus()
    const timer = window.setTimeout(() => {
      setHighlightedSection(undefined)
    }, 2200)
    return () => window.clearTimeout(timer)
  }, [focusSection, loadingGeneral, tab])

  async function patchGeneral(patch: Record<string, unknown>, field: string) {
    setSavingField(field)
    setGeneralError('')
    setGeneralSaved(false)
    try {
      const updated = await request<SettingsView>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      if (patch.data_dir !== undefined) {
        const nextDir = updated.data_dir ?? String(patch.data_dir)
        setDataDir(nextDir)
        setSavedDataDir(updated.data_dir ?? '')
      }
      if (patch.proxy_url !== undefined) {
        setProxyUrl(updated.proxy_url ?? '')
        setSavedProxyUrl(updated.proxy_url ?? '')
      }
      if (patch.youtube_cookies !== undefined || patch.clear_youtube_cookies) {
        setHasYoutubeCookies(Boolean(updated.has_youtube_cookies))
        setYoutubeCookiesDraft('')
      }
      setGeneralSaved(true)
    } catch (failure) {
      setGeneralError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSavingField('')
    }
  }

  async function handleLanguageChange(next: string) {
    setLanguage(next)
    await patchGeneral({ ui_language: next }, 'language')
  }

  async function handleThemeChange(next: ThemePreference) {
    setTheme(next)
    await patchGeneral({ theme: next }, 'theme')
  }

  async function handlePickDirectory() {
    const pick = window.youdubDesktop?.pickDirectory
    if (!pick) return
    try {
      const selected = await pick()
      if (selected) setDataDir(selected)
    } catch (failure) {
      setGeneralError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  function handleAddFromPreset(presetId = selectedPreset) {
    const preset = presets.find((item) => item.id === presetId) ?? presets[0]
    if (!preset) return
    setLlmError('')
    setDiscoverNote('')
    setTestNote('')
    setProviderSavedNote('')
    setShowApiKey(false)
    setDraft(draftFromPreset(preset, providers))
  }

  function buildProbePayload(current: ProviderDraft) {
    return {
      name: current.name.trim() || current.id,
      protocol: current.protocol,
      preset: current.preset,
      base_url: current.base_url.trim(),
      default_model: current.default_model.trim(),
      ...(current.apiKey.trim() ? { api_key: current.apiKey.trim() } : {}),
    }
  }

  async function handleDiscoverModels() {
    if (!draft) return
    setDiscovering(true)
    setLlmError('')
    setDiscoverNote('')
    try {
      const result = await request<{ items: string[] }>(
        `/api/llm/providers/${encodeURIComponent(draft.id)}/models`,
        {
          method: 'POST',
          body: JSON.stringify(buildProbePayload(draft)),
        },
      )
      const items = result.items ?? []
      setDraft((current) =>
        current && current.id === draft.id
          ? {
              ...current,
              models: items,
              default_model: current.default_model.trim() || items[0] || '',
            }
          : current,
      )
      setDiscoverNote(
        items.length > 0
          ? tx('settings.llm.discoveredCount', { count: items.length })
          : tx('settings.llm.noModelsFound'),
      )
    } catch (failure) {
      setLlmError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setDiscovering(false)
    }
  }

  async function handleTestConnection() {
    if (!draft) return
    setTesting(true)
    setLlmError('')
    setTestNote('')
    try {
      const result = await request<ProbeResponse>(
        `/api/llm/providers/${encodeURIComponent(draft.id)}/test`,
        {
          method: 'POST',
          body: JSON.stringify(buildProbePayload(draft)),
        },
      )
      if (result.ok) {
        setTestNote(
          tx('settings.llm.testOk', {
            model: result.model || draft.default_model || '—',
            latencyMs: result.latencyMs ?? 0,
          }),
        )
      } else {
        setLlmError(result.message || 'Connection failed')
      }
    } catch (failure) {
      setLlmError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setTesting(false)
    }
  }

  async function handleSaveProvider() {
    if (!draft) return
    setSavingProvider(true)
    setLlmError('')
    setProviderSavedNote('')
    try {
      const models = draft.default_model.trim()
        ? Array.from(new Set([...draft.models, draft.default_model.trim()]))
        : draft.models
      const saved = await request<LLMProviderView>(
        `/api/llm/providers/${encodeURIComponent(draft.id)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            name: draft.name.trim() || draft.id,
            protocol: draft.protocol,
            preset: draft.preset,
            base_url: draft.base_url.trim(),
            default_model: draft.default_model.trim(),
            models,
            enabled: draft.enabled,
            ...(draft.apiKey.trim() ? { api_key: draft.apiKey.trim() } : {}),
            ...(draft.clearApiKey ? { clear_api_key: true } : {}),
          }),
        },
      )
      setProviders((current) => {
        const exists = current.some((item) => item.id === saved.id)
        return exists
          ? current.map((item) => (item.id === saved.id ? saved : item))
          : [...current, saved]
      })
      setDraft(toDraft(saved))
      setProviderSavedNote(tx('settings.saved'))
    } catch (failure) {
      setLlmError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSavingProvider(false)
    }
  }

  async function handleDeleteProvider() {
    if (!draft) return
    setLlmError('')
    setProviderSavedNote('')
    if (draft.isNew) {
      setDraft(providers[0] ? toDraft(providers[0]) : null)
      return
    }
    setDeletingProvider(true)
    try {
      await request(`/api/llm/providers/${encodeURIComponent(draft.id)}`, {
        method: 'DELETE',
      })
      const remaining = providers.filter((item) => item.id !== draft.id)
      setProviders(remaining)
      setDraft(remaining[0] ? toDraft(remaining[0]) : null)
    } catch (failure) {
      setLlmError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setDeletingProvider(false)
    }
  }

  const hasPickDirectory = typeof window !== 'undefined' && typeof window.youdubDesktop?.pickDirectory === 'function'
  const providerBusy = discovering || testing || savingProvider || deletingProvider
  const dirty = isDraftDirty(draft, providers)
  const saveActionRef = useRef({ tab, canSave: Boolean(draft && !providerBusy && draft.name.trim()), save: handleSaveProvider })
  useEffect(() => {
    saveActionRef.current = { tab, canSave: Boolean(draft && !providerBusy && draft.name.trim()), save: handleSaveProvider }
  })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        const current = saveActionRef.current
        if (current.tab === 'llm' && current.canSave) {
          event.preventDefault()
          void current.save()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <Modal
      open
      onClose={onClose}
      title={tx('client.settings')}
      closeLabel={tx('settings.close.settings')}
      className="w-[min(52rem,100%)] max-h-[min(86dvh,45rem)]"
      contentClassName="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
    >
      <div className="space-y-5">
        <SegmentedControl
          id={tabsId}
          value={tab}
          onChange={setTab}
          label={tx('settings.tabs')}
          options={[
            { value: 'general', label: tx('settings.general') },
            { value: 'llm', label: tx('settings.models') },
          ]}
        />

        <div
          role="tabpanel"
          id={`${tabsId}-${tab}-panel`}
          aria-labelledby={`${tabsId}-${tab}`}
          className="space-y-5"
        >
          {tab === 'general' ? (
            <div className="space-y-4">
              {generalError && <InlineAlert>{generalError}</InlineAlert>}
              {generalSaved && (
                <p role="status" className="flex items-center gap-1.5 text-xs text-status-success-fg">
                  <Check className="size-3.5" />
                  {tx('settings.saved')}
                </p>
              )}
              {loadingGeneral && (
                <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {tx('library.loading')}
                </p>
              )}

              <Surface className="divide-y divide-border px-4">
                <div className="flex flex-wrap items-center justify-between gap-4 py-4">
                  <div className="min-w-0">
                    <Label htmlFor={`${fieldIdPrefix}-language`} className="text-sm font-medium">
                      {tx('settings.general.language')}
                    </Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">{tx('settings.general.languageHint')}</p>
                  </div>
                  <NativeSelect
                    id={`${fieldIdPrefix}-language`}
                    aria-label={tx('settings.general.language')}
                    className="w-36 shrink-0"
                    value={language}
                    disabled={savingField === 'language'}
                    onChange={(event) => void handleLanguageChange(event.target.value)}
                  >
                    {LANGUAGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4 py-4">
                  <div className="min-w-0">
                    <span className="text-sm font-medium">{tx('settings.theme')}</span>
                    <p className="mt-0.5 text-xs text-muted-foreground">{tx('settings.general.themeHint')}</p>
                  </div>
                  <div className="shrink-0 whitespace-nowrap">
                    <SegmentedControl
                      id={`${fieldIdPrefix}-theme`}
                      label={tx('settings.theme')}
                      value={theme}
                      disabled={savingField === 'theme'}
                      onChange={(next) => void handleThemeChange(next)}
                      options={[
                        { value: 'system', label: tx('theme.system') },
                        { value: 'light', label: tx('theme.light') },
                        { value: 'dark', label: tx('theme.dark') },
                      ]}
                    />
                  </div>
                </div>

                <div className="space-y-2 py-4">
                  <Label htmlFor={`${fieldIdPrefix}-data-dir`} className="text-sm font-medium">
                    {tx('settings.general.dataDir')}
                  </Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id={`${fieldIdPrefix}-data-dir`}
                      aria-label={tx('settings.general.dataDir')}
                      className="min-w-0 flex-1"
                      placeholder={defaultDataDir}
                      value={dataDir}
                      disabled={savingField === 'data_dir'}
                      onChange={(event) => {
                        setGeneralSaved(false)
                        setDataDir(event.target.value)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && dataDir.trim() && dataDir.trim() !== savedDataDir) {
                          event.preventDefault()
                          void patchGeneral({ data_dir: dataDir.trim() }, 'data_dir')
                        }
                      }}
                    />
                    {hasPickDirectory && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={savingField === 'data_dir'}
                        onClick={() => void handlePickDirectory()}
                      >
                        <FolderOpen />
                        {tx('setup.browse')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      disabled={savingField === 'data_dir' || !dataDir.trim() || dataDir.trim() === savedDataDir}
                      onClick={() => void patchGeneral({ data_dir: dataDir.trim() }, 'data_dir')}
                    >
                      {savingField === 'data_dir' && <Loader2 className="animate-spin" />}
                      {tx('settings.save')}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{tx('settings.general.dataDirHint')}</p>
                </div>

                <div
                  ref={proxySectionRef}
                  className={cn(
                    'space-y-2 py-4 transition-all',
                    highlightedSection === 'proxy' && 'rounded-lg bg-primary/5 p-3 -mx-3 ring-2 ring-primary/35',
                  )}
                >
                  <Label htmlFor={`${fieldIdPrefix}-proxy`} className="text-sm font-medium">
                    {tx('settings.general.proxyUrl')}
                  </Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      ref={proxyInputRef}
                      id={`${fieldIdPrefix}-proxy`}
                      aria-label={tx('settings.general.proxyUrl')}
                      className="min-w-0 flex-1"
                      placeholder="http://127.0.0.1:7897"
                      value={proxyUrl}
                      disabled={savingField === 'proxy_url'}
                      onChange={(event) => {
                        setGeneralSaved(false)
                        setProxyUrl(event.target.value)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && proxyUrl.trim() !== savedProxyUrl) {
                          event.preventDefault()
                          void patchGeneral({ proxy_url: proxyUrl.trim() }, 'proxy_url')
                        }
                      }}
                    />
                    {proxyUrl && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={savingField === 'proxy_url'}
                        aria-label={tx('workflow.run.clear.link')}
                        onClick={() => {
                          setGeneralSaved(false)
                          setProxyUrl('')
                        }}
                      >
                        <X />
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      disabled={savingField === 'proxy_url' || proxyUrl.trim() === savedProxyUrl}
                      onClick={() => void patchGeneral({ proxy_url: proxyUrl.trim() }, 'proxy_url')}
                    >
                      {savingField === 'proxy_url' && <Loader2 className="animate-spin" />}
                      {tx('settings.save')}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{tx('settings.general.proxyHint')}</p>
                </div>

                <div
                  ref={youtubeCookiesSectionRef}
                  className={cn(
                    'space-y-2 border-t border-border/60 pt-4 transition-all',
                    highlightedSection === 'youtube-cookies' &&
                      'rounded-lg bg-primary/5 p-3 -mx-3 ring-2 ring-primary/35',
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor={youtubeCookiesId}>{tx('settings.general.youtubeCookies')}</Label>
                    <Tag tone={hasYoutubeCookies ? 'success' : 'neutral'}>
                      {hasYoutubeCookies
                        ? tx('settings.general.youtubeCookiesConfigured')
                        : tx('settings.general.youtubeCookiesUnset')}
                    </Tag>
                  </div>
                  <Textarea
                    ref={youtubeCookiesInputRef}
                    id={youtubeCookiesId}
                    rows={3}
                    value={youtubeCookiesDraft}
                    onChange={(event) => setYoutubeCookiesDraft(event.target.value)}
                    placeholder={tx('settings.general.youtubeCookiesPlaceholder')}
                    className="font-mono text-xs"
                  />
                  <input
                    ref={cookieFileRef}
                    type="file"
                    accept=".txt,text/plain"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      event.target.value = ''
                      if (!file) return
                      void file.text().then((content) => setYoutubeCookiesDraft(content))
                    }}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => cookieFileRef.current?.click()}
                      >
                        <Upload />
                        {tx('settings.general.youtubeCookiesImport')}
                      </Button>
                      {hasYoutubeCookies && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={savingField === 'youtube_cookies'}
                          onClick={() =>
                            void patchGeneral({ clear_youtube_cookies: true }, 'youtube_cookies')
                          }
                        >
                          <Trash2 />
                          {tx('settings.general.youtubeCookiesClear')}
                        </Button>
                      )}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      disabled={savingField === 'youtube_cookies' || !youtubeCookiesDraft.trim()}
                      onClick={() =>
                        void patchGeneral(
                          { youtube_cookies: youtubeCookiesDraft },
                          'youtube_cookies',
                        )
                      }
                    >
                      {savingField === 'youtube_cookies' && <Loader2 className="animate-spin" />}
                      {tx('settings.save')}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {tx('settings.general.youtubeCookiesHint')}
                  </p>
                </div>
              </Surface>
            </div>
          ) : (
            <div className="space-y-4">
              {llmError && <InlineAlert>{llmError}</InlineAlert>}

              {loadingLlm && (
                <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {tx('library.loading')}
                </p>
              )}

              <div className="grid items-start gap-4 md:grid-cols-[14.5rem_minmax(0,1fr)]">
                <div className="space-y-3">
                  {providers.length === 0 && !draft && !loadingLlm && (
                    <Surface className="p-4 text-xs text-muted-foreground">
                      {tx('settings.llm.empty')}
                    </Surface>
                  )}

                  {(providers.length > 0 || draft?.isNew) && (
                    <Surface className="divide-y divide-border overflow-hidden">
                      {providers.map((provider) => {
                        const selected = draft?.id === provider.id && !draft.isNew
                        const statusText = !provider.enabled
                          ? tx('settings.llm.disabled')
                          : provider.available
                            ? tx('settings.llm.available')
                            : tx('settings.llm.unconfigured')
                        return (
                          <button
                            key={provider.id}
                            type="button"
                            onClick={() => {
                              setLlmError('')
                              setDiscoverNote('')
                              setTestNote('')
                              setProviderSavedNote('')
                              setShowApiKey(false)
                              setDraft(toDraft(provider))
                            }}
                            className={cn(
                              'flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent/50',
                              selected && 'bg-accent',
                            )}
                          >
                            <span
                              aria-hidden="true"
                              className={cn(
                                'mt-1.5 size-2 shrink-0 rounded-full',
                                !provider.enabled
                                  ? 'bg-muted-foreground/40'
                                  : provider.available
                                    ? 'bg-status-success-fg'
                                    : 'bg-status-warning-fg',
                              )}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-foreground">
                                {provider.name}
                              </span>
                              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                                {provider.default_model || provider.protocol.toUpperCase()} · {statusText}
                              </span>
                            </span>
                          </button>
                        )
                      })}
                      {draft?.isNew && (
                        <div className="flex items-start gap-2.5 bg-accent px-3 py-2.5 text-left">
                          <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-link" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-foreground">{draft.name}</span>
                            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                              {tx('workflows.draft')}
                            </span>
                          </span>
                        </div>
                      )}
                    </Surface>
                  )}

                  <Surface className="space-y-2 p-3">
                    <span className="block text-xs font-medium text-muted-foreground">{tx('settings.llm.preset')}</span>
                    <NativeSelect
                      aria-label={tx('settings.llm.preset')}
                      className="w-full"
                      value={selectedPreset}
                      disabled={providerBusy}
                      onChange={(event) => {
                        const nextPreset = event.target.value
                        setSelectedPreset(nextPreset)
                        if (draft?.isNew) handleAddFromPreset(nextPreset)
                      }}
                    >
                      {presets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
                        </option>
                      ))}
                    </NativeSelect>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="w-full"
                      disabled={providerBusy}
                      onClick={() => handleAddFromPreset()}
                    >
                      <Plus />
                      {tx('settings.llm.addProvider')}
                    </Button>
                  </Surface>
                </div>

                {draft && (
                  <Surface
                    as="form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (!providerBusy && draft.name.trim()) void handleSaveProvider()
                    }}
                    className="space-y-4 p-4 sm:p-5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-semibold">{draft.name || draft.id}</span>
                        <Tag tone="neutral">{draft.protocol.toUpperCase()}</Tag>
                        {dirty && <Tag tone="warning">{tx('workflows.unsaved')}</Tag>}
                      </div>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{tx('settings.llm.enabled')}</span>
                        <Switch
                          aria-label={tx('settings.llm.enabled')}
                          checked={draft.enabled}
                          disabled={providerBusy}
                          onCheckedChange={(checked) =>
                            setDraft((current) => (current ? { ...current, enabled: checked } : current))
                          }
                        />
                      </label>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldIdPrefix}-provider-name`} className="text-xs font-medium text-muted-foreground">
                          {tx('settings.llm.name')}
                        </Label>
                        <Input
                          id={`${fieldIdPrefix}-provider-name`}
                          aria-label={tx('settings.llm.name')}
                          value={draft.name}
                          disabled={providerBusy}
                          onChange={(event) =>
                            setDraft((current) => (current ? { ...current, name: event.target.value } : current))
                          }
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldIdPrefix}-provider-protocol`} className="text-xs font-medium text-muted-foreground">
                          {tx('settings.llm.protocol')}
                        </Label>
                        <NativeSelect
                          id={`${fieldIdPrefix}-provider-protocol`}
                          aria-label={tx('settings.llm.protocol')}
                          className="w-full"
                          value={draft.protocol}
                          disabled={providerBusy}
                          onChange={(event) =>
                            setDraft((current) =>
                              current
                                ? { ...current, protocol: event.target.value as ProtocolKind }
                                : current,
                            )
                          }
                        >
                          <option value="openai">OpenAI</option>
                          <option value="anthropic">Anthropic</option>
                          <option value="gemini">Gemini</option>
                        </NativeSelect>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor={`${fieldIdPrefix}-provider-baseurl`} className="text-xs font-medium text-muted-foreground">
                        {tx('settings.llm.baseUrl')}
                      </Label>
                      <Input
                        id={`${fieldIdPrefix}-provider-baseurl`}
                        aria-label={tx('settings.llm.baseUrl')}
                        value={draft.base_url}
                        disabled={providerBusy}
                        placeholder="https://api.openai.com/v1"
                        onChange={(event) =>
                          setDraft((current) => (current ? { ...current, base_url: event.target.value } : current))
                        }
                      />
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Label htmlFor={`${fieldIdPrefix}-provider-apikey`} className="text-xs font-medium text-muted-foreground">
                            {tx('settings.llm.apiKey')}
                          </Label>
                          {draft.hasApiKey && !draft.clearApiKey && draft.apiKeyHint && (
                            <Tag tone="success">{draft.apiKeyHint}</Tag>
                          )}
                        </div>
                        {draft.hasApiKey && !draft.clearApiKey && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={providerBusy}
                            onClick={() =>
                              setDraft((current) =>
                                current ? { ...current, apiKey: '', clearApiKey: true } : current,
                              )
                            }
                          >
                            {tx('settings.llm.clearApiKey')}
                          </Button>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Input
                          id={`${fieldIdPrefix}-provider-apikey`}
                          aria-label={tx('settings.llm.apiKey')}
                          className="min-w-0 flex-1"
                          type={showApiKey ? 'text' : 'password'}
                          autoComplete="off"
                          value={draft.apiKey}
                          disabled={providerBusy}
                          placeholder={
                            draft.clearApiKey
                              ? tx('settings.llm.keyCleared')
                              : draft.hasApiKey && draft.apiKeyHint
                                ? draft.apiKeyHint
                                : tx('settings.llm.apiKeyPlaceholder')
                          }
                          onChange={(event) =>
                            setDraft((current) =>
                              current ? { ...current, apiKey: event.target.value, clearApiKey: false } : current,
                            )
                          }
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={providerBusy}
                          aria-label={showApiKey ? tx('settings.llm.hideKey') : tx('settings.llm.showKey')}
                          onClick={() => setShowApiKey((current) => !current)}
                        >
                          {showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldIdPrefix}-provider-model`} className="text-xs font-medium text-muted-foreground">
                          {tx('settings.llm.defaultModel')}
                        </Label>
                        <Input
                          id={`${fieldIdPrefix}-provider-model`}
                          aria-label={tx('settings.llm.defaultModel')}
                          value={draft.default_model}
                          disabled={providerBusy}
                          onChange={(event) =>
                            setDraft((current) =>
                              current ? { ...current, default_model: event.target.value } : current,
                            )
                          }
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldIdPrefix}-provider-models`} className="text-xs font-medium text-muted-foreground">
                          {tx('settings.llm.models')}
                        </Label>
                        <NativeSelect
                          id={`${fieldIdPrefix}-provider-models`}
                          aria-label={tx('settings.llm.models')}
                          className="w-full"
                          value={draft.models.includes(draft.default_model) ? draft.default_model : ''}
                          disabled={providerBusy || draft.models.length === 0}
                          onChange={(event) => {
                            if (!event.target.value) return
                            setDraft((current) =>
                              current ? { ...current, default_model: event.target.value } : current,
                            )
                          }}
                        >
                          <option value="">{tx('settings.llm.selectModel')}</option>
                          {draft.models.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                    </div>

                    {draft.models.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {draft.models.slice(0, 6).map((model) => {
                          const activeModel = draft.default_model === model
                          return (
                            <button
                              key={model}
                              type="button"
                              disabled={providerBusy}
                              onClick={() =>
                                setDraft((current) => (current ? { ...current, default_model: model } : current))
                              }
                              className={cn(
                                'max-w-full truncate rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                                activeModel
                                  ? 'border-link bg-link/10 text-link'
                                  : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground',
                              )}
                            >
                              {model}
                            </button>
                          )
                        })}
                      </div>
                    )}

                    {(discoverNote || testNote || providerSavedNote) && (
                      <div role="status" className="space-y-1 text-xs text-status-success-fg">
                        {discoverNote && <p>{discoverNote}</p>}
                        {testNote && <p>{testNote}</p>}
                        {providerSavedNote && <p>{providerSavedNote}</p>}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={providerBusy || !draft.base_url.trim()}
                        onClick={() => void handleDiscoverModels()}
                      >
                        {discovering ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                        {tx('settings.llm.discoverModels')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={providerBusy || !draft.base_url.trim() || !draft.default_model.trim()}
                        onClick={() => void handleTestConnection()}
                      >
                        {testing ? <Loader2 className="animate-spin" /> : <Sparkles />}
                        {tx('settings.llm.testConnection')}
                      </Button>
                      <div className="ml-auto flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={providerBusy}
                          onClick={() => void handleDeleteProvider()}
                        >
                          {deletingProvider ? <Loader2 className="animate-spin" /> : <Trash2 />}
                          {tx('settings.llm.deleteProvider')}
                        </Button>
                        <Button
                          type="submit"
                          size="sm"
                          disabled={providerBusy || !draft.name.trim()}
                        >
                          {savingProvider && <Loader2 className="animate-spin" />}
                          {tx('settings.save')}
                        </Button>
                      </div>
                    </div>
                  </Surface>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
