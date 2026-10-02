import { useEffect, useRef, useState } from 'react'
import type { AppSettings, AuthProvider, ModelCatalog, ThemeConfig, ThemeMode } from '@shared/types'
import { CODEX_DARK_THEME, PRIME_LIGHT_THEME, resolveThemeMode } from '@shared/themes'
import { depthLabel } from '../components/DepthSlider'
import ConfirmButton from '../components/ConfirmButton'
import { THINKING_LEVELS, thinkingLabel } from '@shared/thinking'

interface Props {
  settings: AppSettings
  activeAgentId: string | null
  onChange: (patch: Partial<AppSettings>) => void
}

interface RefinementResult {
  id: string
  summary: string
  scope?: 'local' | 'global'
  appliedEdits?: { applied: boolean }[]
}

const SECTIONS = [
  { id: 'providers', label: 'Providers' },
  { id: 'models', label: 'Models' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'refinement', label: 'Refinement' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'about', label: 'About' }
] as const

type SectionId = typeof SECTIONS[number]['id']

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`
}

export default function SettingsView({ settings, activeAgentId, onChange }: Props): JSX.Element {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [copyLabel, setCopyLabel] = useState('Copy theme')
  const [importError, setImportError] = useState('')
  const [providers, setProviders] = useState<AuthProvider[]>([])
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({})
  const [credentialStatus, setCredentialStatus] = useState('')
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [modelRoles, setModelRoles] = useState<Record<string, string>>({})
  const [savingRole, setSavingRole] = useState(false)
  const [refineInstructions, setRefineInstructions] = useState('')
  const [refinements, setRefinements] = useState<RefinementResult[]>([])
  const [refining, setRefining] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState('')
  const [activeSection, setActiveSection] = useState<SectionId>('providers')
  const importRef = useRef<HTMLInputElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystemDark(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  const loadProviders = () => {
    void window.prime.authList()
      .then((list) => setProviders(Array.isArray(list) ? list : []))
      .catch(() => setProviders([]))
  }

  useEffect(() => {
    loadProviders()
    void window.prime.agentHarness('', 'model_roles')
      .then(value => setModelRoles((value ?? {}) as Record<string, string>))
      .catch(() => {})
    if (!activeAgentId) {
      setCatalog(null)
      setRefinements([])
      return
    }
    void window.prime.agentHarness(activeAgentId, 'model_catalog').then((value) => {
      const raw = (value ?? {}) as { models?: Record<string, unknown>[]; configuredProviders?: string[] }
      setCatalog({
        models: (raw.models ?? []).map((model) => ({
          id: String(model.id ?? ''),
          name: typeof model.name === 'string' ? model.name : undefined,
          provider: String(model.provider ?? ''),
          reasoning: Boolean(model.reasoning)
        })),
        configuredProviders: raw.configuredProviders ?? [],
        transport: settings.transport
      })
    }).catch(() => setCatalog(null))
    loadRefinements()
  }, [activeAgentId])

  // Highlight the section currently at the top of the scroll area.
  useEffect(() => {
    const root = pageRef.current
    if (!root) return
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
      const id = visible?.target.id.replace(/^settings-/, '') as SectionId | undefined
      if (id) setActiveSection(id)
    }, { root, rootMargin: '0px 0px -65% 0px' })
    for (const section of SECTIONS) {
      const element = root.querySelector(`#settings-${section.id}`)
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [])

  const set = (patch: Partial<AppSettings>) => onChange(patch)
  const editingVariant = resolveThemeMode(settings.themeMode, systemDark)
  const themeKey = editingVariant === 'dark' ? 'darkTheme' : 'lightTheme'
  const theme = settings[themeKey]

  const updateTheme = (patch: Partial<ThemeConfig>) => {
    set({ [themeKey]: { ...theme, ...patch } })
  }

  const copyTheme = async () => {
    const payload = `codex-theme-v1:${JSON.stringify({
      codeThemeId: settings.codeThemeId,
      theme,
      variant: editingVariant
    })}`
    await navigator.clipboard.writeText(payload)
    setCopyLabel('Copied')
    window.setTimeout(() => setCopyLabel('Copy theme'), 1600)
  }

  const importTheme = async (file: File) => {
    try {
      const raw = (await file.text()).trim().replace(/^codex-theme-v1:/, '')
      const parsed = JSON.parse(raw) as { codeThemeId?: string; theme?: ThemeConfig; variant?: 'light' | 'dark' }
      if (!parsed.theme || !parsed.variant || !isThemeConfig(parsed.theme)) throw new Error('Invalid Codex theme')
      set({
        themeMode: parsed.variant,
        codeThemeId: parsed.codeThemeId ?? 'codex',
        [parsed.variant === 'dark' ? 'darkTheme' : 'lightTheme']: parsed.theme
      })
      setImportError('')
    } catch {
      setImportError('This file is not a valid codex-theme-v1 theme.')
    }
  }

  function loadRefinements(): void {
    if (!activeAgentId) return
    void window.prime.agentHarness(activeAgentId, 'refinement_history').then((value) => {
      setRefinements((value as { history?: RefinementResult[] } | null)?.history ?? [])
    }).catch(() => setRefinements([]))
  }

  async function runRefine(global: boolean, rollbackId?: string): Promise<void> {
    if (!activeAgentId) return
    setRefining(true)
    setSettingsMessage(rollbackId ? 'Rolling back refinement…' : 'Running refinement pass…')
    try {
      const result = await window.prime.agentHarness(activeAgentId, 'refine', {
        instructions: refineInstructions.trim() || undefined,
        rollbackId,
        global
      }) as RefinementResult
      setSettingsMessage(result.summary || (rollbackId ? 'Rollback complete.' : 'Refinement complete.'))
      setRefineInstructions('')
      loadRefinements()
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setRefining(false)
    }
  }

  const saveKey = async (provider: AuthProvider) => {
    setCredentialStatus('')
    try {
      await window.prime.authSet(provider.id, providerKeys[provider.id])
      setProviderKeys((value) => ({ ...value, [provider.id]: '' }))
      setCredentialStatus(`Saved the ${provider.name} key.`)
      loadProviders()
    } catch (error) {
      setCredentialStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const removeKey = async (provider: AuthProvider) => {
    setCredentialStatus('')
    try {
      await window.prime.authRemove(provider.id)
      setCredentialStatus(`Removed the ${provider.name} key.`)
      loadProviders()
    } catch (error) {
      setCredentialStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const providerCount = catalog ? new Set(catalog.models.map((model) => model.provider)).size : 0

  return (
    <div className="view settings-page" ref={pageRef}>
      <header className="view-header">
        <div>
          <h2>Settings</h2>
          <p className="view-sub">Preferences shared with Prime Agent on this Mac.</p>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              className={activeSection === section.id ? 'active' : ''}
              aria-current={activeSection === section.id ? 'true' : undefined}
              onClick={() => {
                setActiveSection(section.id)
                document.getElementById(`settings-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
            >
              {section.label}
            </button>
          ))}
        </nav>

        <div className="settings-sections">
          <section className="panel settings-section" id="settings-providers">
            <h3 className="panel-head">Providers</h3>
            <p className="setting-desc">API keys are written to Prime Agent’s credential file (owner-only permissions) and shared with the CLI.</p>
            <div className="provider-list">
              {providers.map((provider) => (
                <div className="provider-row" key={provider.id}>
                  <div className="provider-name">
                    <strong>{provider.name}</strong>
                    <span className={`provider-state ${provider.configured ? 'on' : ''}`}>{provider.configured ? 'Key saved' : 'No key'}</span>
                  </div>
                  <input
                    className="field"
                    type="password"
                    autoComplete="off"
                    aria-label={`${provider.name} API key`}
                    placeholder={provider.configured ? 'Replace key' : 'Paste API key'}
                    value={providerKeys[provider.id] ?? ''}
                    onChange={(event) => setProviderKeys((value) => ({ ...value, [provider.id]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && providerKeys[provider.id]?.trim()) void saveKey(provider)
                    }}
                  />
                  <button className="btn small" disabled={!providerKeys[provider.id]?.trim()} onClick={() => void saveKey(provider)}>
                    Save
                  </button>
                  {provider.configured ? (
                    <ConfirmButton className="btn ghost small" confirmLabel="Remove key?" onConfirm={() => void removeKey(provider)}>Remove</ConfirmButton>
                  ) : <span className="provider-row-spacer" aria-hidden="true" />}
                </div>
              ))}
              {providers.length === 0 && <div className="empty-state">Could not read Prime Agent’s credential file.</div>}
            </div>
            <div className="settings-footer-row">
              <button className="btn small" onClick={() => void window.prime.authOpenTui()}>Sign in with Prime Agent…</button>
              <span className="setting-desc">Opens Terminal for subscription logins such as OpenAI Codex.</span>
            </div>
            {credentialStatus && <div className="hint-text" role="status">{credentialStatus}</div>}
          </section>

          <section className="panel settings-section" id="settings-models">
            <h3 className="panel-head">Models</h3>
            <label className="setting-row">
              <div>
                <div className="setting-title">Thinking level</div>
                <div className="setting-desc">Default reasoning effort. Not every model supports every level.</div>
              </div>
              <select className="field" value={settings.thinkingLevel} onChange={(e) => set({ thinkingLevel: e.target.value })}>
                {THINKING_LEVELS.map((level) => (
                  <option key={level} value={level}>{thinkingLabel(level)}</option>
                ))}
              </select>
            </label>
            <label className="setting-row">
              <div>
                <div className="setting-title">Subagent depth</div>
                <div className="setting-desc">How many levels of nested subagents a chat may spawn. 0 keeps all work in the parent.</div>
              </div>
              <span className="setting-range">
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={settings.rlmMaxDepth ?? 1}
                  aria-label="Subagent depth"
                  onChange={(event) => set({ rlmMaxDepth: Number(event.target.value) })}
                />
                <output>{settings.rlmMaxDepth ?? 1} · {depthLabel(settings.rlmMaxDepth ?? 1)}</output>
              </span>
            </label>
            <label className="setting-row">
              <div>
                <div className="setting-title">Provider transport</div>
                <div className="setting-desc">How the active session streams from the provider. Auto lets Prime Agent choose.</div>
              </div>
              <select
                className="field"
                value={settings.transport}
                onChange={(event) => {
                  const transport = event.target.value as AppSettings['transport']
                  set({ transport })
                  if (activeAgentId) void window.prime.agentHarness(activeAgentId, 'set_transport', { transport }).catch(() => {})
                }}
              >
                <option value="auto">Auto</option>
                <option value="sse">SSE</option>
                <option value="websocket">WebSocket</option>
                <option value="websocket-cached">WebSocket (cached)</option>
              </select>
            </label>

            <h4 className="settings-subhead">
              Model roles
              {catalog && <span>{plural(catalog.models.length, 'model')} from {plural(providerCount, 'provider')}</span>}
            </h4>
            {([
              ['subagentDefaultModel', 'Subagent model', 'Same as the parent chat', 'Used by new subagents that don’t name a model.'],
              ['auxiliaryModel', 'Utility model', 'Prime Agent default', 'Used for short tasks such as titles and summaries.'],
              ['providerBackupModel', 'Backup model', 'None', 'Used if the main provider fails.']
            ] as const).map(([key, label, fallback, description]) => (
              <label className="setting-row" key={key}>
                <div>
                  <div className="setting-title">{label}</div>
                  <div className="setting-desc">{description}</div>
                </div>
                <select className="field" aria-label={label} value={modelRoles[key] ?? ''} disabled={savingRole}
                  onChange={async event => {
                    setSavingRole(true)
                    try {
                      const roles = await window.prime.agentHarness('', 'model_role_set', { key, value: event.target.value })
                      setModelRoles(roles as Record<string, string>)
                    } catch (error) {
                      setSettingsMessage(error instanceof Error ? error.message : String(error))
                    } finally {
                      setSavingRole(false)
                    }
                  }}>
                  <option value="">{fallback}</option>
                  {modelRoles[key] && !catalog?.models.some(model => `${model.provider}/${model.id}` === modelRoles[key]) && (
                    <option value={modelRoles[key]}>{modelRoles[key]}</option>
                  )}
                  {catalog?.models.map(model => (
                    <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name || model.id} · {model.provider}</option>
                  ))}
                </select>
              </label>
            ))}

            <CustomModelsPanel />
          </section>

          <section className="panel settings-section" id="settings-behavior">
            <h3 className="panel-head">Behavior</h3>
            <label className="setting-row">
              <div>
                <div className="setting-title">Native notifications</div>
                <div className="setting-desc">Notify when a background agent finishes or needs input.</div>
              </div>
              <input className="setting-toggle" type="checkbox" checked={settings.notifications} onChange={(e) => set({ notifications: e.target.checked })} />
            </label>
            <label className="setting-row">
              <div>
                <div className="setting-title">Checkpoint before prompts</div>
                <div className="setting-desc">Snapshot the project to a private git ref before each prompt so you can restore it from Review. Your branch history and staging area are never touched. Git projects only.</div>
              </div>
              <input className="setting-toggle" type="checkbox" checked={settings.checkpoints} onChange={(e) => set({ checkpoints: e.target.checked })} />
            </label>
            <label className="setting-row">
              <div>
                <div className="setting-title">Show reasoning</div>
                <div className="setting-desc">Show the model’s reasoning in chat, folded above each answer.</div>
              </div>
              <input className="setting-toggle" type="checkbox" checked={settings.showReasoning !== false} onChange={(e) => set({ showReasoning: e.target.checked })} />
            </label>
            <label className="setting-row">
              <div>
                <div className="setting-title">Auto-compaction</div>
                <div className="setting-desc">Summarize older messages when the context window fills up.</div>
              </div>
              <input className="setting-toggle" type="checkbox" checked={settings.autoCompaction} onChange={(e) => set({ autoCompaction: e.target.checked })} />
            </label>
            <label className="setting-row">
              <div>
                <div className="setting-title">Auto-retry</div>
                <div className="setting-desc">Retry on transient provider errors (overloaded, rate limited, 5xx).</div>
              </div>
              <input className="setting-toggle" type="checkbox" checked={settings.autoRetry} onChange={(e) => set({ autoRetry: e.target.checked })} />
            </label>
            <label className="setting-row">
              <div>
                <div className="setting-title">Autonomous continuation</div>
                <div className="setting-desc">Let Prime Agent keep going until its gates pass or a budget runs out. Also available in chat with <code>/autonomous on</code>.</div>
              </div>
              <input
                className="setting-toggle"
                type="checkbox"
                checked={settings.autonomous.enabled}
                onChange={(e) => {
                  const autonomous = { ...settings.autonomous, enabled: e.target.checked }
                  set({ autonomous })
                  void window.prime.autonomySet({ enabled: e.target.checked })
                }}
              />
            </label>
          </section>

          <section className="panel settings-section" id="settings-refinement">
            <h3 className="panel-head">Harness refinement</h3>
            <p className="setting-desc">Ask Prime Agent to review this session and update its memory, prompts, skills, and subagent definitions. Each pass can be rolled back.</p>
            <textarea
              className="field refinement-instructions"
              placeholder="Optional instructions for the refinement pass"
              aria-label="Refinement instructions"
              value={refineInstructions}
              onChange={(event) => setRefineInstructions(event.target.value)}
            />
            <div className="row-gap pad-top">
              <button className="btn primary small" disabled={!activeAgentId || refining} onClick={() => void runRefine(false)}>
                {refining ? 'Refining…' : 'Refine this project'}
              </button>
              <button className="btn small" disabled={!activeAgentId || refining} onClick={() => void runRefine(true)}>Refine globally</button>
            </div>
            {settingsMessage && <div className="hint-text pad-top" role="status">{settingsMessage}</div>}
            <div className="refinement-history">
              {refinements.map((item) => {
                const applied = item.appliedEdits?.filter((edit) => edit.applied).length ?? 0
                return (
                  <div className="refinement-row" key={item.id}>
                    <div>
                      <strong>{item.summary || item.id}</strong>
                      <span>{item.scope === 'global' ? 'Global' : 'This project'} · {plural(applied, 'change')}</span>
                    </div>
                    <ConfirmButton
                      className="btn ghost small"
                      disabled={refining}
                      confirmLabel="Undo these changes?"
                      onConfirm={() => void runRefine(item.scope === 'global', item.id)}
                    >
                      Roll back
                    </ConfirmButton>
                  </div>
                )
              })}
              {refinements.length === 0 && <div className="empty-state">No refinements in this session yet.</div>}
            </div>
          </section>

          <section className="panel settings-section" id="settings-appearance">
            <h3 className="panel-head">Appearance</h3>
            <div className="theme-mode-grid" role="radiogroup" aria-label="Theme">
              {(['system', 'light', 'dark'] as ThemeMode[]).map((mode) => (
                <button
                  key={mode}
                  className={`theme-mode-option ${settings.themeMode === mode ? 'selected' : ''}`}
                  type="button"
                  role="radio"
                  aria-checked={settings.themeMode === mode}
                  onClick={() => set({ themeMode: mode })}
                >
                  <ThemePreview mode={mode} />
                  <span>{mode[0].toUpperCase() + mode.slice(1)}</span>
                </button>
              ))}
            </div>

            <div className="theme-code-preview" aria-hidden="true">
              <div className="theme-code-gutter">1<br /><b>2</b><br /><b>3</b><br /><b>4</b><br />5</div>
              <pre><span>const</span> themePreview = {'{'}{'\n'}  surface: <em>"sidebar"</em>,{'\n'}  accent: <em>"{theme.accent}"</em>,{'\n'}  contrast: <strong>{theme.contrast}</strong>,{'\n'}{'}'};</pre>
              <div className="theme-code-result">
                <div />
                <div style={{ background: `${theme.semanticColors.diffAdded}22`, borderLeftColor: theme.semanticColors.diffAdded }} />
                <div style={{ background: `${theme.semanticColors.diffRemoved}22`, borderLeftColor: theme.semanticColors.diffRemoved }} />
              </div>
            </div>

            <div className="theme-editor">
              <div className="theme-editor-head">
                <span>{editingVariant === 'dark' ? 'Dark' : 'Light'} theme</span>
                <div className="theme-editor-actions">
                  <input
                    ref={importRef}
                    hidden
                    type="file"
                    accept=".json,.txt"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (file) void importTheme(file)
                      event.target.value = ''
                    }}
                  />
                  <button type="button" onClick={() => importRef.current?.click()}>Import</button>
                  <button type="button" onClick={() => void copyTheme()}>{copyLabel}</button>
                  <select
                    className="theme-preset"
                    aria-label="Theme preset"
                    value={editingVariant === 'dark' && theme.accent.toLowerCase() === '#339cff' ? 'codex-dark' : editingVariant === 'light' && theme.accent.toLowerCase() === '#c97b76' ? 'prime-light' : 'custom'}
                    onChange={(event) => {
                      if (event.target.value === 'codex-dark') set({ themeMode: 'dark', darkTheme: CODEX_DARK_THEME, codeThemeId: 'codex' })
                      if (event.target.value === 'prime-light') set({ themeMode: 'light', lightTheme: PRIME_LIGHT_THEME, codeThemeId: 'codex' })
                    }}
                  >
                    <option value="custom">Custom</option>
                    <option value="codex-dark">Codex Dark</option>
                    <option value="prime-light">Prime Light</option>
                  </select>
                </div>
              </div>
              {importError && <div className="theme-import-error">{importError}</div>}
              <ThemeColorRow label="Accent" value={theme.accent} onChange={(accent) => updateTheme({ accent })} />
              <ThemeColorRow label="Background" value={theme.surface} onChange={(surface) => updateTheme({ surface })} />
              <ThemeColorRow label="Foreground" value={theme.ink} onChange={(ink) => updateTheme({ ink })} />
              <ThemeColorRow label="Diff added" value={theme.semanticColors.diffAdded} onChange={(diffAdded) => updateTheme({ semanticColors: { ...theme.semanticColors, diffAdded } })} />
              <ThemeColorRow label="Diff removed" value={theme.semanticColors.diffRemoved} onChange={(diffRemoved) => updateTheme({ semanticColors: { ...theme.semanticColors, diffRemoved } })} />
              <ThemeColorRow label="Skill" value={theme.semanticColors.skill} onChange={(skill) => updateTheme({ semanticColors: { ...theme.semanticColors, skill } })} />
              <label className="theme-control-row">
                <span>UI font</span>
                <input
                  className="theme-text-input"
                  value={theme.fonts.ui ?? ''}
                  placeholder="System default"
                  onChange={(event) => updateTheme({ fonts: { ...theme.fonts, ui: event.target.value || null } })}
                />
              </label>
              <label className="theme-control-row">
                <span>Code font</span>
                <input
                  className="theme-text-input"
                  value={theme.fonts.code ?? ''}
                  placeholder="SF Mono"
                  onChange={(event) => updateTheme({ fonts: { ...theme.fonts, code: event.target.value || null } })}
                />
              </label>
              <label className="theme-control-row">
                <span>Translucent sidebar</span>
                <input className="setting-toggle" type="checkbox" checked={!theme.opaqueWindows} onChange={(event) => updateTheme({ opaqueWindows: !event.target.checked })} />
              </label>
              <label className="theme-control-row theme-contrast-row">
                <span>Contrast</span>
                <input type="range" min="0" max="100" value={theme.contrast} onChange={(event) => updateTheme({ contrast: Number(event.target.value) })} />
                <output>{theme.contrast}</output>
              </label>
            </div>
          </section>

          <section className="panel settings-section" id="settings-about">
            <h3 className="panel-head">About</h3>
            <p className="setting-desc">
              Prime Desktop 0.1.0 is a desktop client for Prime Agent, built on its resident daemon. Agents run with your macOS user
              permissions. They are not sandboxed and do not ask before running commands.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}

function ThemeColorRow({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value.toUpperCase())
  useEffect(() => setDraft(value.toUpperCase()), [value])

  return (
    <label className="theme-control-row">
      <span>{label}</span>
      <span className="theme-color-control">
        <input type="color" value={value} onChange={(event) => onChange(event.target.value)} />
        <input
          value={draft}
          maxLength={7}
          onBlur={() => setDraft(value.toUpperCase())}
          onChange={(event) => {
            const next = event.target.value
            setDraft(next)
            if (/^#[0-9a-f]{6}$/i.test(next)) onChange(next)
          }}
        />
      </span>
    </label>
  )
}

function ThemePreview({ mode }: { mode: ThemeMode }) {
  return (
    <span className={`theme-preview ${mode}`}>
      <i className="theme-preview-top" />
      <i className="theme-preview-window">
        <b />
        <b />
        <b />
      </i>
    </span>
  )
}

interface CustomProviderRow {
  provider: string
  baseUrl: string
  api: string
  hasKey: boolean
  models: { id: string; name: string }[]
}

const CUSTOM_APIS = [
  { value: 'openai-completions', label: 'OpenAI-compatible (vLLM, sglang, Ollama…)' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
  { value: 'openai-responses', label: 'OpenAI Responses' }
]

function CustomModelsPanel(): JSX.Element {
  const [providers, setProviders] = useState<CustomProviderRow[]>([])
  const [providerName, setProviderName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [api, setApi] = useState('openai-completions')
  const [modelIds, setModelIds] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [editingAllowsEmptyUrl, setEditingAllowsEmptyUrl] = useState(false)
  const [formOpen, setFormOpen] = useState(false)

  useEffect(() => {
    void window.prime.modelsCustomGet().then((list) => setProviders((list ?? []) as CustomProviderRow[])).catch(() => {})
  }, [])

  const startEdit = (provider: CustomProviderRow) => {
    setEditing(provider.provider)
    setProviderName(provider.provider)
    setBaseUrl(provider.baseUrl)
    setApi(provider.api || 'openai-completions')
    setModelIds(provider.models.map((model) => model.id).join(', '))
    setApiKey('')
    // Providers merged over a built-in (no own baseUrl) may keep it that way.
    setEditingAllowsEmptyUrl(!provider.baseUrl)
    setStatus(`Editing “${provider.provider}” — leave the key blank to keep the stored one.`)
  }

  const cancelEdit = () => {
    setEditing(null)
    setEditingAllowsEmptyUrl(false)
    setProviderName('')
    setBaseUrl('')
    setApi('openai-completions')
    setModelIds('')
    setApiKey('')
    setStatus('')
  }

  const save = async () => {
    if (!providerName.trim() || (!baseUrl.trim() && !editingAllowsEmptyUrl) || !modelIds.trim()) return
    setBusy(true)
    setStatus('')
    try {
      const models = modelIds.split(',').map((id) => ({ id })).filter((model) => model.id.trim())
      const next = await window.prime.modelsCustomSet({
        provider: providerName.trim(),
        baseUrl: baseUrl.trim(),
        api,
        apiKey: apiKey.trim() || undefined,
        models
      })
      setProviders((next ?? []) as CustomProviderRow[])
      const wasEditing = Boolean(editing)
      const savedName = providerName.trim()
      cancelEdit()
      setFormOpen(false)
      setStatus(wasEditing ? `Updated “${savedName}”. Models reload in the picker automatically.` : `Saved “${savedName}”. Models reload in the picker automatically.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (providerId: string) => {
    setBusy(true)
    try {
      const next = await window.prime.modelsCustomRemove(providerId)
      setProviders((next ?? []) as CustomProviderRow[])
      if (editing === providerId) cancelEdit()
      setStatus(`Removed ${providerId}.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="custom-models">
      <h4 className="settings-subhead">
        Custom models
        <span>Saved to <code>~/.prime/agent/models.json</code> and shared with the CLI.</span>
      </h4>
      {providers.map((provider) => (
        <div key={provider.provider} className="custom-provider-row">
          <div className="custom-provider-info">
            <strong>{provider.provider}</strong>
            <span>
              {provider.models.map((model) => model.name || model.id).join(', ')}
              {provider.baseUrl && <> · {provider.baseUrl.replace(/^https?:\/\//, '')}</>}
              {provider.hasKey ? '' : ' · no key'}
            </span>
          </div>
          <button className="btn ghost small" disabled={busy} onClick={() => { startEdit(provider); setFormOpen(true) }}>
            Edit
          </button>
          <ConfirmButton className="btn ghost small" disabled={busy} confirmLabel="Remove provider?" onConfirm={() => void remove(provider.provider)}>
            Remove
          </ConfirmButton>
        </div>
      ))}
      {!formOpen && !editing ? (
        <div className="settings-footer-row">
          <button className="btn small" onClick={() => setFormOpen(true)}>Add a custom endpoint…</button>
          <span className="setting-desc">Any OpenAI-compatible server, such as vLLM, sglang or Ollama.</span>
          {status && <span className="hint-text" role="status">{status}</span>}
        </div>
      ) : (
      <div className="custom-model-form">
        {editing && (
          <div className="setting-desc">Editing <strong>{editing}</strong>. The provider name can’t be changed; remove and re-add it to rename.</div>
        )}
        <div className="form-grid">
          <label className="form-field">
            <span>Provider name</span>
            <input className="field" placeholder="e.g. moremi" value={providerName} disabled={Boolean(editing)} onChange={(e) => setProviderName(e.target.value)} />
          </label>
          <label className="form-field">
            <span>API type</span>
            <select className="field" value={api} onChange={(e) => setApi(e.target.value)}>
              {CUSTOM_APIS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="form-field wide">
            <span>Base URL</span>
            <input
              className="field"
              placeholder={editingAllowsEmptyUrl ? 'Leave empty to use the built-in endpoint' : 'https://example.com/v1 or http://…'}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            {isPlainRemoteHttp(baseUrl) && (
              <em className="form-warning" role="note">
                Plain HTTP: prompts and the API key are sent unencrypted to this server.
              </em>
            )}
          </label>
          <label className="form-field wide">
            <span>API key <em>optional</em></span>
            <input
              className="field"
              type="password"
              placeholder={editing ? 'Leave blank to keep the stored key' : 'Leave blank if the server needs none'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
          <label className="form-field wide">
            <span>Model IDs</span>
            <input className="field" placeholder="As served by the endpoint, comma separated" value={modelIds} onChange={(e) => setModelIds(e.target.value)} />
          </label>
        </div>
        <div className="row-gap">
          <button
            className="btn primary small"
            disabled={busy || !providerName.trim() || (!baseUrl.trim() && !editingAllowsEmptyUrl) || !modelIds.trim()}
            onClick={() => void save()}
          >
            {editing ? 'Save changes' : 'Save provider'}
          </button>
          <button className="btn ghost small" disabled={busy} onClick={() => { cancelEdit(); setFormOpen(false) }}>
            Cancel
          </button>
          {status && <span className="setting-desc" role="status">{status}</span>}
        </div>
      </div>
      )}
    </div>
  )
}

function isThemeConfig(value: ThemeConfig): boolean {
  return Boolean(
    value &&
    /^#[0-9a-f]{6}$/i.test(value.accent) &&
    /^#[0-9a-f]{6}$/i.test(value.ink) &&
    /^#[0-9a-f]{6}$/i.test(value.surface) &&
    value.semanticColors &&
    /^#[0-9a-f]{6}$/i.test(value.semanticColors.diffAdded) &&
    /^#[0-9a-f]{6}$/i.test(value.semanticColors.diffRemoved) &&
    /^#[0-9a-f]{6}$/i.test(value.semanticColors.skill) &&
    value.fonts &&
    typeof value.contrast === 'number'
  )
}

function isPlainRemoteHttp(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}
