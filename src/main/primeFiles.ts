import { existsSync, readFileSync } from 'fs'
import { readFile, writeFile, mkdir, rename, chmod } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { pathToFileURL } from 'url'
import { packageRoot } from './daemonTransport'
import type { AuthProvider } from '@shared/types'

export const PRIME_AGENT_DIR = process.env.PRIME_AGENT_CODING_AGENT_DIR || join(homedir(), '.prime', 'agent')
export const AUTH_PATH = join(PRIME_AGENT_DIR, 'auth.json')
export const PRIME_SETTINGS_PATH = join(PRIME_AGENT_DIR, 'settings.json')
export const MODELS_PATH = join(PRIME_AGENT_DIR, 'models.json')
export const LOGS_DIR = join(PRIME_AGENT_DIR, 'logs')

const PROVIDERS: { id: string; name: string }[] = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'openai-codex', name: 'OpenAI Codex' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'google', name: 'Google Gemini' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'prime-inference', name: 'Prime Inference' },
  { id: 'xai', name: 'xAI' },
  { id: 'groq', name: 'Groq' },
  { id: 'mistral', name: 'Mistral' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'fireworks', name: 'Fireworks' },
  { id: 'cerebras', name: 'Cerebras' },
  { id: 'moonshotai', name: 'Moonshot AI' },
  { id: 'minimax', name: 'MiniMax' },
  { id: 'zai', name: 'ZAI' }
]

type AuthFile = Record<string, { type?: string; key?: string }>

async function writeJsonAtomic(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(PRIME_AGENT_DIR, { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), mode ? { mode } : undefined)
  if (mode) await chmod(temp, mode)
  await rename(temp, path)
}

async function readAuth(): Promise<AuthFile> {
  try {
    return JSON.parse(await readFile(AUTH_PATH, 'utf8')) as AuthFile
  } catch {
    return {}
  }
}

export async function listAuthProviders(): Promise<AuthProvider[]> {
  const data = await readAuth()
  const ids = new Set([...PROVIDERS.map((p) => p.id), ...Object.keys(data)])
  return [...ids].map((id) => ({
    id,
    name: PROVIDERS.find((p) => p.id === id)?.name ?? id,
    configured: Boolean(data[id])
  }))
}

export async function setAuthKey(provider: string, key: string): Promise<void> {
  await mkdir(PRIME_AGENT_DIR, { recursive: true })
  const data = await readAuth()
  data[provider] = { type: 'api_key', key: key.trim() }
  await writeJsonAtomic(AUTH_PATH, data, 0o600)
}

export async function removeAuth(provider: string): Promise<void> {
  const data = await readAuth()
  delete data[provider]
  await writeJsonAtomic(AUTH_PATH, data, 0o600)
}

export async function openPrimeAgentLogin(binary: string): Promise<void> {
  const command = `'${binary.replace(/'/g, "'\\''")}'`
  await promisify(execFile)('osascript', [
    '-e',
    `tell application "Terminal" to do script ${JSON.stringify(command)}`,
    '-e', 'tell application "Terminal" to activate'
  ])
}

export async function getMcpCatalog(binary: string): Promise<unknown[]> {
  const catalog = await import(pathToFileURL(join(packageRoot(binary), 'dist/core/mcp/service-catalog.js')).href)
  return catalog.defaultServiceCatalogProvider()().map((entry: {
    serviceId: string; label: string; description?: string; authStrategy: string
  }) => ({ id: entry.serviceId, name: entry.label, description: entry.description ?? '', auth: entry.authStrategy }))
}

export async function readPrimeSettings(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(PRIME_SETTINGS_PATH, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

// For read-modify-write paths: a missing file is empty, but an unreadable or
// corrupt one must stop the write instead of being replaced with {}.
export async function readPrimeSettingsStrict(path = PRIME_SETTINGS_PATH): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`Could not read Prime Agent settings (${path}): ${(error as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Prime Agent settings (${path}) are not valid JSON. Fix or remove the file and try again.`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Prime Agent settings (${path}) must be a JSON object.`)
  }
  return parsed as Record<string, unknown>
}

export const MODEL_ROLES = ['subagentDefaultModel', 'auxiliaryModel', 'providerBackupModel'] as const

export async function getModelRoles(): Promise<Record<string, string>> {
  const settings = await readPrimeSettings()
  return Object.fromEntries(MODEL_ROLES.map(key => [key, typeof settings[key] === 'string' ? settings[key] : '']))
}

export async function setModelRole(key: string, value: string): Promise<Record<string, string>> {
  if (!MODEL_ROLES.includes(key as typeof MODEL_ROLES[number])) throw new Error('Unknown model role.')
  if (value && (!/^[a-zA-Z0-9._-]+\/\S+$/.test(value) || value.length > 512)) {
    throw new Error('Select a model with a provider and model ID.')
  }
  const settings = await readPrimeSettingsStrict()
  if (value) settings[key] = value
  else delete settings[key]
  await writeJsonAtomic(PRIME_SETTINGS_PATH, settings)
  return getModelRoles()
}

export async function writePrimeRlmMaxDepth(maxDepth: number): Promise<void> {
  const data = await readPrimeSettingsStrict()
  data.rlmMaxDepth = maxDepth
  await writeJsonAtomic(PRIME_SETTINGS_PATH, data)
}

export async function setAgentTracesEnabled(enabled: boolean): Promise<void> {
  const data = await readPrimeSettingsStrict()
  const current = data.agentTraces && typeof data.agentTraces === 'object'
    ? data.agentTraces as Record<string, unknown>
    : {}
  data.agentTraces = { ...current, enabled }
  await writeJsonAtomic(PRIME_SETTINGS_PATH, data)
}

function mcpServersOf(data: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const servers = data.mcpServers
  return servers && typeof servers === 'object' && !Array.isArray(servers)
    ? servers as Record<string, Record<string, unknown>>
    : {}
}

export async function getMcpServers(): Promise<Record<string, Record<string, unknown>>> {
  const servers = mcpServersOf(await readPrimeSettings())
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, {
    type: server.type,
    url: server.url,
    oauth: server.oauth,
    enabled: server.enabled,
    bearerTokenEnvVar: server.bearerTokenEnvVar
  }]))
}

export async function setMcpServer(
  name: string,
  config: { url: string; oauth: boolean; enabled: boolean; bearerTokenEnvVar?: string } | null
): Promise<Record<string, Record<string, unknown>>> {
  const key = name.trim()
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw new Error('MCP server name may use letters, numbers, dots, dashes, and underscores.')
  const data = await readPrimeSettingsStrict()
  const servers = mcpServersOf(data)
  if (config) {
    const url = new URL(config.url)
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('MCP server URL must use HTTPS.')
    servers[key] = {
      ...(servers[key] ?? {}),
      type: 'http',
      url: url.toString(),
      oauth: config.oauth,
      enabled: config.enabled,
      ...(config.bearerTokenEnvVar ? { bearerTokenEnvVar: config.bearerTokenEnvVar } : {})
    }
  } else {
    delete servers[key]
  }
  data.mcpServers = servers
  await writeJsonAtomic(PRIME_SETTINGS_PATH, data)
  return getMcpServers()
}

export async function getAgentTracesEnabled(): Promise<boolean> {
  const data = await readPrimeSettings()
  const traces = data.agentTraces as Record<string, unknown> | undefined
  return traces?.enabled === true
}

export async function readPrimeRlmMaxDepth(fallback = 1): Promise<number> {
  const data = await readPrimeSettings()
  const value = data.rlmMaxDepth
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

// ---------- Custom model providers (models.json) ----------

export interface CustomModelSummary {
  id: string
  name: string
}

export interface CustomProviderSummary {
  provider: string
  baseUrl: string
  api: string
  hasKey: boolean
  models: CustomModelSummary[]
}

interface ModelsFile {
  providers?: Record<string, Record<string, unknown>>
}

async function readModelsFile(): Promise<ModelsFile> {
  try {
    const parsed = JSON.parse(await readFile(MODELS_PATH, 'utf8')) as Partial<ModelsFile>
    return {
      providers: parsed.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)
        ? parsed.providers
        : {}
    }
  } catch {
    return { providers: {} }
  }
}

// Prime Agent only lists models whose provider has a credential, so a server
// that needs no key still gets a placeholder; OpenAI-compatible servers
// ignore the resulting `Bearer none` header.
const KEYLESS_API_KEY = 'none'

function summarizeProvider(providerId: string, config: Record<string, unknown>): CustomProviderSummary {
  const rawModels = Array.isArray(config.models) ? config.models : []
  return {
    provider: providerId,
    baseUrl: String(config.baseUrl ?? ''),
    api: String(config.api ?? 'openai-completions'),
    hasKey: Boolean(config.apiKey) && config.apiKey !== KEYLESS_API_KEY,
    models: rawModels.map((model) => {
      const rec = model && typeof model === 'object' ? model as Record<string, unknown> : {}
      const id = String(rec.id ?? '')
      return { id, name: String(rec.name ?? id) }
    }).filter((model) => model.id)
  }
}

export async function getCustomProviders(): Promise<CustomProviderSummary[]> {
  const file = await readModelsFile()
  return Object.entries(file.providers ?? {}).map(([id, config]) => summarizeProvider(id, config))
}

export async function refreshOpenRouterModels(): Promise<void> {
  const key = (await readAuth()).openrouter?.key?.trim()
  if (!key) throw new Error('Add an OpenRouter API key before refreshing models.')
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Accept: 'application/json', Authorization: `Bearer ${key}` }
  })
  if (!response.ok) throw new Error(`OpenRouter model refresh failed (${response.status}).`)
  const payload = await response.json() as { data?: unknown }
  if (!Array.isArray(payload.data)) throw new Error('OpenRouter returned an invalid model catalog.')
  const file = await readModelsFile()
  const providers = file.providers ?? {}
  const existing = providers.openrouter ?? {}
  const prior = new Map(
    (Array.isArray(existing.models) ? existing.models : [])
      .filter((model): model is Record<string, unknown> => Boolean(model && typeof model === 'object'))
      .map((model) => [String(model.id ?? ''), model])
  )
  const models = payload.data
    .filter((model): model is Record<string, unknown> => Boolean(model && typeof model === 'object'))
    .map((model) => {
      const id = String(model.id ?? '').trim()
      const name = String(model.name ?? id).trim()
      return id ? { ...(prior.get(id) ?? {}), id, name } : null
    })
    .filter(Boolean) as Record<string, unknown>[]
  if (!models.length) throw new Error('OpenRouter returned no models.')
  providers.openrouter = { ...existing, models }
  file.providers = providers
  await writeJsonAtomic(MODELS_PATH, file, 0o600)
}

const CUSTOM_MODEL_APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'])

export async function setCustomProvider(config: {
  provider: string
  baseUrl: string
  api?: string
  apiKey?: string
  models: { id: string; name?: string }[]
} | null): Promise<CustomProviderSummary[]> {
  const file = await readModelsFile()
  const providers = file.providers ?? {}
  if (!config) throw new Error('Provider config is required')
  const key = config.provider.trim()
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw new Error('Provider name may use letters, numbers, dots, dashes, and underscores.')
  const known = Boolean(providers[key]) || PROVIDERS.some((provider) => provider.id === key)
  const existing = providers[key] ?? {}
  // A provider merged over a built-in (e.g. openrouter model additions) or an
  // already-configured one may omit baseUrl and keep riding on that endpoint;
  // a brand-new custom provider has nowhere to send requests without one.
  let baseUrl: string | undefined
  const urlRaw = config.baseUrl.trim()
  if (urlRaw) {
    let url: URL
    try {
      url = new URL(urlRaw)
    } catch {
      throw new Error('Base URL must be a valid URL.')
    }
    // Plain HTTP is allowed for self-hosted and relayed endpoints; the
    // settings form warns that keys travel unencrypted over it.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('Base URL must start with http:// or https://.')
    }
    baseUrl = url.toString()
  } else if (!known) {
    throw new Error('Base URL is required.')
  }
  const api = config.api?.trim() || String(existing.api ?? '') || 'openai-completions'
  if (!CUSTOM_MODEL_APIS.has(api)) throw new Error(`Unsupported API type: ${api}`)
  const models = config.models
    .map((model) => ({ id: model.id.trim(), name: model.name?.trim() || undefined }))
    .filter((model) => model.id)
  if (models.length === 0) throw new Error('At least one model ID is required.')

  // Merge instead of replace so hand-edited fields (compat, cost, …) survive.
  providers[key] = {
    ...existing,
    ...(baseUrl ? { baseUrl } : existing.baseUrl ? { baseUrl: existing.baseUrl } : {}),
    api,
    ...(config.apiKey?.trim()
      ? { apiKey: config.apiKey.trim() }
      : existing.apiKey
        ? { apiKey: existing.apiKey }
        : (await readAuth())[key] ? {} : { apiKey: KEYLESS_API_KEY }),
    models: models.map((model) => {
      const prior = (Array.isArray(existing.models) ? existing.models as Record<string, unknown>[] : [])
        .find((m) => String(m?.id ?? '') === model.id)
      return { ...(prior ?? {}), id: model.id, ...(model.name ? { name: model.name } : {}) }
    })
  }
  file.providers = providers
  await writeJsonAtomic(MODELS_PATH, file, 0o600)
  return getCustomProviders()
}

export async function removeCustomProvider(providerId: string): Promise<CustomProviderSummary[]> {
  const file = await readModelsFile()
  const providers = file.providers ?? {}
  delete providers[providerId.trim()]
  file.providers = providers
  await writeJsonAtomic(MODELS_PATH, file, 0o600)
  return getCustomProviders()
}

export function changelogText(): string {
  const candidates = [
    '/opt/homebrew/lib/node_modules/prime-agent/CHANGELOG.md',
    join(homedir(), '.local/lib/node_modules/prime-agent/CHANGELOG.md')
  ]
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return readFileSync(path, 'utf8').slice(0, 12000)
      } catch {
        /* try next */
      }
    }
  }
  return 'Changelog not found. Installed Prime Agent package did not include CHANGELOG.md.'
}
