import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { existsSync, statSync } from 'fs'
import { isAbsolute, join, normalize, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import type { AgentCommand } from '@shared/types'

// main, preload, and renderer are emitted side by side under out/.
export function rendererIndexFile(): string {
  return join(__dirname, '../renderer/index.html')
}

// The app's own page: the dev server origin in development, otherwise the
// bundled file:// index.html (query/hash ignored). Everything else is foreign.
export function isAppUrl(url: string, devUrl: string | undefined, indexFile?: string): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if (devUrl) {
    try {
      const dev = new URL(devUrl)
      return (dev.protocol === 'http:' || dev.protocol === 'https:') && target.origin === dev.origin
    } catch {
      return false
    }
  }
  if (target.protocol !== 'file:') return false
  if (!indexFile) return true
  try {
    return normalize(fileURLToPath(target)) === normalize(resolve(indexFile))
  } catch {
    return false
  }
}

export function assertTrustedRenderer(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
  devUrl: string | undefined = process.env['ELECTRON_RENDERER_URL'],
  indexFile: string = rendererIndexFile()
): void {
  const window = getWindow()
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new Error('Untrusted IPC sender')
  }
  // Only the top-level app document may call privileged IPC; a subframe or a
  // page the window was somehow navigated to must not inherit that access.
  const frame = event.senderFrame
  if (!frame || (frame !== window.webContents.mainFrame && frame.parent !== null)) {
    throw new Error('Untrusted IPC sender')
  }
  if (!isAppUrl(frame.url, devUrl, indexFile)) throw new Error('Untrusted IPC sender')
}

export function requireString(value: unknown, name: string, maxLength = 200_000): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(`${name} must be a string of at most ${maxLength} characters`)
  }
  return value
}

export function requireNonEmptyString(value: unknown, name: string, maxLength = 200_000): string {
  const text = requireString(value, name, maxLength).trim()
  if (!text) throw new Error(`${name} is required`)
  return text
}

export function requireFiniteNumber(value: unknown, name: string, min?: number, max?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`)
  if (min !== undefined && value < min) throw new Error(`${name} must be at least ${min}`)
  if (max !== undefined && value > max) throw new Error(`${name} must be at most ${max}`)
  return value
}

export function requireExistingDirectory(value: unknown, name: string): string {
  const path = requireNonEmptyString(value, name, 4_096)
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`)
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${name} is not an existing directory`)
  return resolve(path)
}

export function requireExistingFile(value: unknown, name: string): string {
  const path = requireNonEmptyString(value, name, 4_096)
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`)
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${name} is not an existing file`)
  return resolve(path)
}

export function requireSafeExternalUrl(value: unknown): string {
  const raw = requireNonEmptyString(value, 'url', 8_192)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Invalid external URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only HTTP(S) external URLs are allowed')
  }
  return url.toString()
}

export function isWithin(root: string, candidate: string): boolean {
  const rootPath = normalize(resolve(root))
  const candidatePath = normalize(resolve(candidate))
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`)
}

export function validateAgentCommand(value: unknown): AgentCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid agent command')
  const command = value as Record<string, unknown>
  const type = command.type
  const allowed = new Set([
    'prompt', 'steer', 'follow_up', 'abort', 'compact', 'new_session', 'switch_session',
    'fork', 'clone', 'set_model', 'set_thinking_level', 'set_auto_compaction', 'set_auto_retry',
    'set_session_name', 'get_available_models', 'get_commands', 'bash', 'refine', 'export_html'
  ])
  if (typeof type !== 'string' || !allowed.has(type)) throw new Error('Unsupported agent command')
  if (['prompt', 'steer', 'follow_up', 'bash'].includes(type)) {
    requireNonEmptyString(command.message ?? command.command, 'command text', 200_000)
  }
  return command as AgentCommand
}
