import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'prime-agent-dir-'))
const settingsPath = join(dir, 'settings.json')
const modelsPath = join(dir, 'models.json')
const savedDir = process.env.PRIME_AGENT_CODING_AGENT_DIR
let prime: typeof import('../src/main/primeFiles')

beforeAll(async () => {
  // PRIME_AGENT_DIR is resolved at import time.
  process.env.PRIME_AGENT_CODING_AGENT_DIR = dir
  prime = await import('../src/main/primeFiles')
})

afterAll(() => {
  if (savedDir === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR
  else process.env.PRIME_AGENT_CODING_AGENT_DIR = savedDir
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(settingsPath, { force: true })
  rmSync(modelsPath, { force: true })
})

describe('Prime Agent settings writers', () => {
  it('refuses to overwrite an unparseable settings.json', async () => {
    const corrupt = '{ "defaultModel": "x", '
    writeFileSync(settingsPath, corrupt)
    await expect(prime.writePrimeRlmMaxDepth(2)).rejects.toThrow(/not valid JSON/)
    await expect(prime.setAgentTracesEnabled(true)).rejects.toThrow(/not valid JSON/)
    await expect(prime.setMcpServer('docs', { url: 'https://example.com/mcp', oauth: false, enabled: true })).rejects.toThrow(/not valid JSON/)
    await expect(prime.setModelRole('auxiliaryModel', 'openai/gpt-5')).rejects.toThrow(/not valid JSON/)
    expect(readFileSync(settingsPath, 'utf8')).toBe(corrupt)
  })

  it('refuses to overwrite a settings.json that is not an object', async () => {
    writeFileSync(settingsPath, '[1, 2]')
    await expect(prime.writePrimeRlmMaxDepth(2)).rejects.toThrow(/JSON object/)
    expect(readFileSync(settingsPath, 'utf8')).toBe('[1, 2]')
  })

  it('creates settings.json when missing and preserves other keys', async () => {
    await prime.writePrimeRlmMaxDepth(3)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ rlmMaxDepth: 3 })
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'm', agentTraces: { dir: 'x' } }))
    await prime.setAgentTracesEnabled(true)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ defaultModel: 'm', agentTraces: { dir: 'x', enabled: true } })
  })

  it('keeps lenient reads for display paths', async () => {
    writeFileSync(settingsPath, 'nope')
    expect(await prime.readPrimeSettings()).toEqual({})
    expect(await prime.readPrimeRlmMaxDepth(4)).toBe(4)
  })
})

describe('setCustomProvider base URL', () => {
  const models = [{ id: 'model-a' }]

  it('requires a base URL for a brand-new provider', async () => {
    await expect(prime.setCustomProvider({ provider: 'my-llm', baseUrl: '', models })).rejects.toThrow('Base URL is required.')
    expect(existsSync(modelsPath)).toBe(false)
  })

  it('gives keyless providers a placeholder key so Prime Agent lists their models', async () => {
    const saved = await prime.setCustomProvider({ provider: 'keyless', baseUrl: 'http://box.local:5001/v1', models })
    expect(saved.find((provider) => provider.provider === 'keyless')?.hasKey).toBe(false)
    const file = JSON.parse(readFileSync(modelsPath, 'utf8'))
    expect(file.providers.keyless.apiKey).toBe('none')
    await prime.setCustomProvider({ provider: 'keyless', baseUrl: '', apiKey: 'real-key', models })
    expect(JSON.parse(readFileSync(modelsPath, 'utf8')).providers.keyless.apiKey).toBe('real-key')
  })

  it('accepts http and https base URLs and rejects other schemes', async () => {
    const saved = await prime.setCustomProvider({ provider: 'relay', baseUrl: 'http://10.0.0.5:8000/v1', models })
    expect(saved.find((provider) => provider.provider === 'relay')?.baseUrl).toBe('http://10.0.0.5:8000/v1')
    await expect(prime.setCustomProvider({ provider: 'bad', baseUrl: 'file:///etc/passwd', models })).rejects.toThrow(/http:\/\/ or https:\/\//)
  })

  it('allows omitting the base URL for built-in or already configured providers', async () => {
    const builtIn = await prime.setCustomProvider({ provider: 'openrouter', baseUrl: '', models })
    expect(builtIn.find((provider) => provider.provider === 'openrouter')?.baseUrl).toBe('')

    await prime.setCustomProvider({ provider: 'my-llm', baseUrl: 'https://llm.example.com/v1', models })
    const updated = await prime.setCustomProvider({ provider: 'my-llm', baseUrl: '', models: [{ id: 'model-b' }] })
    const mine = updated.find((provider) => provider.provider === 'my-llm')
    expect(mine?.baseUrl).toBe('https://llm.example.com/v1')
    expect(mine?.models.map((model) => model.id)).toEqual(['model-b'])
  })
})
