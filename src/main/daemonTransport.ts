import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import { existsSync, realpathSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'
import { agentCommand, isNamedPipe } from './platform'
import type { AppSettings, ExternalAgentInfo, SubagentNode } from '@shared/types'

export interface DaemonConnection {
  subscribe(listener: (event: Record<string, unknown>) => void): () => void
  getState(): Promise<Record<string, unknown>>
  getInitialSnapshot(): Promise<Record<string, unknown>>
  getMessages(): Promise<unknown[]>
  getCommands(): Promise<unknown[]>
  getResourceSnapshot(): Promise<Record<string, unknown>>
  getModelCatalog(): Promise<Record<string, unknown>>
  getAvailableModels(): Promise<unknown[]>
  getSessionStats(): Promise<Record<string, unknown>>
  getSessionContext(): Promise<Record<string, unknown>>
  getSessionTree(): Promise<{ tree: DaemonTreeNode[]; leafId: string | null }>
  getUserMessagesForForking(): Promise<unknown[]>
  getQueue(): Promise<{ steering: string[]; followUp: string[] }>
  mutateQueuedMessage?(
    lane: 'steering' | 'followUp',
    index: number,
    expectedText: string,
    mutation: { type: 'delete' } | { type: 'move'; direction: -1 | 1 } | { type: 'replace'; text: string; lane: 'steering' | 'followUp' }
  ): Promise<'applied' | 'rejected' | 'invalid' | 'unsupported'>
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>
  abortAndClearQueue(): Promise<{ steering: string[]; followUp: string[] }>
  getLastAssistantText(): Promise<string | undefined>
  getSystemPrompt(): Promise<string>
  respondToExtensionUiRequest(id: string, response: Record<string, unknown>): Promise<void>
  prompt(message: string, options?: Record<string, unknown>): Promise<void>
  startSideQuestion(id: string, question: string, previousTurns?: { question: string; answer: string }[]): Promise<void>
  abortSideQuestion(id: string): Promise<boolean>
  steer(message: string, images?: unknown[]): Promise<void>
  followUp(message: string, images?: unknown[]): Promise<void>
  abort(): Promise<void>
  abortAndSendQueued?(): Promise<void>
  cancelRlmChild(childId: string): Promise<boolean>
  executeBash(command: string, options?: Record<string, unknown>): Promise<void>
  setModel(provider: string, modelId: string): Promise<unknown>
  setScopedModels(models: { provider: string; modelId: string }[]): Promise<void>
  setThinkingLevel(level: string): Promise<void>
  setServiceTier(tier: 'default' | 'priority'): Promise<void>
  setTransport(transport: 'sse' | 'websocket' | 'websocket-cached' | 'auto'): Promise<void>
  setAutoCompactionEnabled(enabled: boolean): Promise<void>
  setAutoRetryEnabled(enabled: boolean): Promise<void>
  compact(instructions?: string): Promise<unknown>
  refine(options?: Record<string, unknown>): Promise<unknown>
  reload(): Promise<void>
  newSession(options?: Record<string, unknown>): Promise<unknown>
  switchSession(path: string, options?: Record<string, unknown>): Promise<unknown>
  fork(entryId: string, options?: Record<string, unknown>): Promise<unknown>
  navigateTree(targetId: string, options?: Record<string, unknown>): Promise<unknown>
  importFromJsonl(path: string, cwd?: string): Promise<unknown>
  exportToHtml(path?: string): Promise<string>
  exportToJsonl(path?: string): Promise<string>
  setSessionEntryLabel(entryId: string, label?: string): Promise<void>
  setSessionName(name: string): Promise<void>
  getRlmMaxDepthStatus(): Promise<{ maxDepth: number; source: string }>
  setRlmMaxDepth(maxDepth: number, options?: { global?: boolean }): Promise<{ maxDepth: number; source: string }>
  listCronJobs(options?: Record<string, unknown>): Promise<unknown[]>
  listHeartbeats(): Promise<unknown[]>
  manageHeartbeat(activeSessionId: string, jobId: string, action: 'pause' | 'resume' | 'stop'): Promise<unknown>
  addCronJob(schedule: string, prompt: string): Promise<unknown>
  cancelCronJob(id: string): Promise<unknown>
  getHeartbeat(): Promise<unknown>
  setHeartbeat(schedule: string, prompt: string, deliveryMode?: string): Promise<unknown>
  updateHeartbeat(action: string): Promise<unknown>
  sendAgentMessage(target: string, message: string): Promise<unknown>
  startSideQuestion(id: string, question: string): Promise<void>
  dispose(): Promise<void>
}

export interface DaemonTreeNode {
  entry: {
    id: string
    parentId: string | null
    type: string
    message?: unknown
    timestamp?: string
    customType?: string
    data?: unknown
    [key: string]: unknown
  }
  label?: string
  children: DaemonTreeNode[]
}

interface DaemonClientLike {
  readonly hello?: { supervisorPid?: number }
  connect(timeoutMs?: number): Promise<void>
  waitForHello(timeoutMs?: number): Promise<{ supervisorPid?: number }>
  request(command: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  close(): void
  supportsServerCapability?(capability: string): boolean
}

interface DaemonModules {
  DaemonClient: new (socketPath: string) => DaemonClientLike
  DaemonAgentConnection: {
    attach(
      client: DaemonClientLike,
      activeSessionId: string,
      options?: Record<string, unknown>
    ): Promise<DaemonConnection>
  }
}

interface Options {
  binary: string
  socketPath: string
  cwd: string
  settings: AppSettings
}

let modulesPromise: Promise<DaemonModules> | null = null

export function packageRoot(binary: string): string {
  const resolved = realpathSync(binary)
  const marker = join('dist', 'bundle', 'cli.js')
  if (resolved.endsWith(marker)) return dirname(dirname(dirname(resolved)))
  throw new Error('Resident transport requires the npm installation of prime-agent.')
}

async function loadModules(binary: string): Promise<DaemonModules> {
  if (!modulesPromise) {
    modulesPromise = (async () => {
      const root = packageRoot(binary)
      const [daemon, connection] = await Promise.all([
        import(pathToFileURL(join(root, 'dist', 'modes', 'daemon', 'daemon-client.js')).href),
        import(pathToFileURL(join(root, 'dist', 'modes', 'agent-connection', 'daemon-agent-connection.js')).href)
      ])
      return {
        DaemonClient: daemon.DaemonClient,
        DaemonAgentConnection: connection.DaemonAgentConnection
      } as DaemonModules
    })()
  }
  return modulesPromise
}

// Terminal-launched `prime-agent` sessions live on the CLI's own daemon socket,
// separate from the desktop's. Discovery reads that daemon read-only.
export function defaultCliDaemonSocket(): string {
  if (process.platform === 'win32') return '\\\\.\\pipe\\prime-agent-daemon'
  const suffix = typeof process.getuid === 'function' ? String(process.getuid()) : 'user'
  return join(tmpdir(), `prime-agent-${suffix}`, 'daemon.sock')
}

export async function listExternalSessions(binary: string): Promise<ExternalAgentInfo[]> {
  const socketPath = defaultCliDaemonSocket()
  // Named pipes can't be checked with existsSync; the connect timeout covers a missing daemon.
  if (!isNamedPipe(socketPath) && !existsSync(socketPath)) return []
  let client: DaemonClientLike
  try {
    const { DaemonClient } = await loadModules(binary)
    client = new DaemonClient(socketPath)
    await client.connect(1_200)
  } catch {
    return []
  }
  try {
    const response = await client.request({ type: 'list', includeClientOwned: true }, 8_000)
    if (response.success !== true) return []
    const sessions = (((response.data as Record<string, unknown> | undefined)?.sessions ?? []) as Record<string, unknown>[])
      .filter((session) => String(session.runtimeKind ?? 'root') !== 'subagent')
      .filter((session) => String(session.lifecycle ?? '') !== 'archived')
    const out: ExternalAgentInfo[] = []
    for (const session of sessions) {
      const sessionId = String(session.sessionId ?? session.id ?? '')
      const activeSessionId = session.activeSessionId ? String(session.activeSessionId) : sessionId
      if (!sessionId || !activeSessionId) continue
      const rawStatus = String(session.status ?? session.activity ?? '').toLowerCase()
      const status: ExternalAgentInfo['status'] =
        rawStatus === 'error' || rawStatus === 'failed'
          ? 'error'
          : ['working', 'queued', 'starting'].includes(rawStatus) || session.isStreaming === true
            ? 'working'
            : 'idle'
      const timestamp = Date.parse(String(session.lastActivityAt ?? session.modified ?? session.created ?? ''))
      const firstMessage = String(session.firstMessage ?? '')
      out.push({
        activeSessionId,
        sessionId,
        name: String(session.sessionName ?? '') || (firstMessage === '(no messages)' ? '' : firstMessage.slice(0, 60)) || sessionId.slice(0, 8),
        task: firstMessage === '(no messages)' ? '' : firstMessage.slice(0, 200),
        cwd: String(session.cwd ?? session.workingDirectory ?? ''),
        status,
        isStreaming: session.isStreaming === true || status === 'working',
        lastActivityAt: Number.isFinite(timestamp) ? timestamp : 0
      })
    }
    out.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    return out
  } catch {
    return []
  } finally {
    client.close()
  }
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ASAR
  return env
}

function errorCode(error: unknown): string {
  return (error && typeof error === 'object' && 'code' in error) ? String((error as { code?: unknown }).code) : ''
}

async function connectWithStartup(
  Client: DaemonModules['DaemonClient'],
  binary: string,
  socketPath: string,
  skipExisting = false
): Promise<DaemonClientLike> {
  const first = new Client(socketPath)
  if (!skipExisting) {
    try {
      await first.connect(1_500)
      return first
    } catch (error) {
      first.close()
      // A socket file with no listener means a daemon died without cleanup.
      // Remove the stale file or the fresh supervisor cannot bind it.
      if (errorCode(error) === 'ECONNREFUSED' && existsSync(socketPath)) {
        try {
          unlinkSync(socketPath)
        } catch {
          /* another process may have already removed it */
        }
      }
    }
  } else {
    first.close()
  }

  const { cmd, args } = agentCommand(binary)
  const daemon = spawn(cmd, [...args, '--mode', 'daemon', '--daemon-socket', socketPath], {
    detached: true,
    env: childEnv(),
    stdio: 'ignore',
    windowsHide: true
  })
  daemon.unref()
  let lastError: unknown
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const client = new Client(socketPath)
    try {
      await client.connect(500)
      return client
    } catch (error) {
      lastError = error
      client.close()
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Prime Agent daemon did not start.')
}

async function daemonPid(
  Client: DaemonModules['DaemonClient'],
  socketPath: string
): Promise<{ reachable: boolean; pid: number | null }> {
  const probe = new Client(socketPath)
  let reachable = false
  try {
    await probe.connect(500)
    reachable = true
    const hello = await probe.waitForHello(500)
    const pid = Number(hello.supervisorPid)
    return { reachable, pid: Number.isInteger(pid) && pid > 0 ? pid : null }
  } catch {
    return { reachable, pid: null }
  } finally {
    probe.close()
  }
}

async function waitForDaemonExit(
  Client: DaemonModules['DaemonClient'],
  socketPath: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const probe = await daemonPid(Client, socketPath)
    if (!probe.reachable) {
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath)
        } catch {
          /* the daemon may have removed it */
        }
      }
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

async function stopStaleDaemon(
  Client: DaemonModules['DaemonClient'],
  client: DaemonClientLike,
  socketPath: string
): Promise<void> {
  const stalePid = Number(client.hello?.supervisorPid)
  await client.request({ type: 'shutdown', force: true }, 5_000).catch(() => {})
  client.close()
  if (await waitForDaemonExit(Client, socketPath, 3_000)) return

  const current = await daemonPid(Client, socketPath)
  if (!Number.isInteger(stalePid) || stalePid <= 0 || current.pid !== stalePid) {
    throw new Error(`Could not safely stop the stale Prime Agent daemon at ${socketPath}`)
  }
  process.kill(stalePid, 'SIGTERM')
  if (await waitForDaemonExit(Client, socketPath, 2_000)) return
  process.kill(stalePid, 'SIGKILL')
  if (!await waitForDaemonExit(Client, socketPath, 2_000)) {
    throw new Error(`Timed out stopping the stale Prime Agent daemon at ${socketPath}`)
  }
}

function responseData(response: Record<string, unknown>, command: string): Record<string, unknown> {
  if (response.success !== true) throw new Error(String(response.error ?? `${command} failed`))
  return (response.data as Record<string, unknown> | undefined) ?? {}
}

export class DaemonTransport extends EventEmitter {
  private client: DaemonClientLike | null = null
  private connection: DaemonConnection | null = null
  private subagentReader: { selector: string; connection: DaemonConnection } | null = null
  private unsubscribe: (() => void) | null = null
  private exitHandlers = new Set<() => void>()
  private started = false
  private disposed = false
  private rootActiveSessionId: string | null = null

  constructor(private readonly options: Options) {
    super()
  }

  get running(): boolean {
    return this.started && !this.disposed && this.connection !== null
  }

  supports(capability: string): boolean {
    return this.client?.supportsServerCapability?.(capability) === true
  }

  onExit(fn: () => void): void {
    this.exitHandlers.add(fn)
  }

  async start(): Promise<void> {
    if (this.started) return
    const { DaemonClient, DaemonAgentConnection } = await loadModules(this.options.binary)
    let client = await connectWithStartup(DaemonClient, this.options.binary, this.options.socketPath)
    this.client = client
    try {
      const model = this.options.settings.model
      const slash = model?.indexOf('/') ?? -1
      const config: Record<string, unknown> = {
        cwd: this.options.cwd,
        thinking: this.options.settings.thinkingLevel,
        autonomous: {
          enabled: this.options.settings.autonomous.enabled,
          maxContinuations: this.options.settings.autonomous.maxContinuations,
          maxTurns: this.options.settings.autonomous.maxTurns,
          maxTokens: this.options.settings.autonomous.maxTokens,
          timeoutMs: this.options.settings.autonomous.maxSeconds * 1000,
          gates: {
            commands: this.options.settings.autonomous.gates,
            maxRetries: this.options.settings.autonomous.gateRetries
          }
        }
      }
      if (model) {
        if (slash > 0) {
          config.provider = model.slice(0, slash)
          config.model = model.slice(slash + 1)
        } else {
          config.model = model
        }
      }
      let created: Record<string, unknown>
      try {
        created = responseData(
          await client.request({ type: 'create', lifecycle: 'resident', config }, 120_000),
          'create'
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A daemon can outlive the Node installation that launched it, or its
        // supervisor can lose ownership of the on-disk registry (update, crash
        // of a prior generation). Both mean this supervisor is unrecoverable:
        // ask it to exit, then start a fresh one with the current runtime.
        if (!/worker pid|spawn .*node|ENOENT|registry entry|generation/i.test(message)) throw error
        await stopStaleDaemon(DaemonClient, client, this.options.socketPath)
        client = await connectWithStartup(DaemonClient, this.options.binary, this.options.socketPath, true)
        this.client = client
        created = responseData(
          await client.request({ type: 'create', lifecycle: 'resident', config }, 120_000),
          'create'
        )
      }
      const activeSessionId = String(created.activeSessionId ?? '')
      if (!activeSessionId) throw new Error('Prime Agent daemon did not return an active session.')
      this.rootActiveSessionId = activeSessionId
      const connection = await DaemonAgentConnection.attach(client, activeSessionId, {
        closeClientOnDispose: true,
        supportsExtensionUi: true,
        sendClientEnv: true
      })
      this.connection = connection
      this.unsubscribe = connection.subscribe((event) => {
        // DaemonAgentConnection wraps transcript events so it can also emit
        // connection-level lifecycle events. Desktop's message pipeline
        // consumes the transcript event shape directly.
        if (event.type === 'session_event' && event.event && typeof event.event === 'object') {
          this.emit('event', event.event)
          return
        }
        if (event.type === 'extension_ui_request' && event.request && typeof event.request === 'object') {
          const request = event.request as Record<string, unknown>
          const payload = request.payload && typeof request.payload === 'object'
            ? request.payload as Record<string, unknown>
            : {}
          this.emit('event', { type: 'extension_ui_request', ...payload, id: request.id, method: request.method })
          return
        }
        this.emit('event', event)
      })

      // A resident daemon can outlive the desktop window and keep the model
      // from the previous client. Apply the desktop preference after attach,
      // before the renderer can send the first prompt.
      const configuredModel = this.options.settings.model
      if (configuredModel) {
        const slash = configuredModel.indexOf('/')
        let provider = slash > 0 ? configuredModel.slice(0, slash) : ''
        const modelId = slash > 0 ? configuredModel.slice(slash + 1) : configuredModel
        if (!provider && modelId) {
          const models = await connection.getAvailableModels() as Record<string, unknown>[]
          provider = String(models.find((model) => model.id === modelId)?.provider ?? '')
        }
        if (provider && modelId) await connection.setModel(provider, modelId)
      }
      this.started = true
      await connection.setRlmMaxDepth(this.options.settings.rlmMaxDepth, { global: false })
      await connection.setTransport(this.options.settings.transport).catch(() => {})
    } catch (error) {
      client.close()
      this.client = null
      throw error
    }
  }

  async withConnection<T>(task: (connection: DaemonConnection) => Promise<T>): Promise<T> {
    if (!this.connection || !this.running) throw new Error('Agent is not connected')
    return task(this.connection)
  }

  async getSubagentTree(): Promise<SubagentNode[]> {
    if (!this.client || !this.connection || !this.running) return []
    const [state, response, snapshot] = await Promise.all([
      this.connection.getState(),
      this.client.request({ type: 'list', includeClientOwned: true }, 30_000),
      this.connection.getInitialSnapshot().catch(() => ({} as Record<string, unknown>))
    ])
    if (response.success !== true) throw new Error(String(response.error ?? 'Could not list subagents'))
    const sessions = ((response.data as Record<string, unknown> | undefined)?.sessions ?? []) as Record<string, unknown>[]
    const rootSessionId = String(state.sessionId ?? '')
    if (!rootSessionId) return []
    const childDetails = new Map<string, Record<string, unknown>>()
    for (const child of ((snapshot.children as Record<string, unknown>[] | undefined) ?? [])) {
      childDetails.set(String(child.id ?? ''), child)
      if (child.activeSessionId) childDetails.set(String(child.activeSessionId), child)
    }

    const childrenByParent = new Map<string, Record<string, unknown>[]>()
    for (const session of sessions) {
      if (String(session.runtimeKind ?? '') !== 'subagent') continue
      const parentSessionId = String(session.parentSessionId ?? '')
      if (!parentSessionId) continue
      const siblings = childrenByParent.get(parentSessionId) ?? []
      siblings.push(session)
      childrenByParent.set(parentSessionId, siblings)
    }

    const build = (parentSessionId: string, seen = new Set<string>()): SubagentNode[] => {
      return (childrenByParent.get(parentSessionId) ?? [])
        .map((session) => {
          const sessionId = String(session.sessionId ?? session.id ?? '')
          if (!sessionId || seen.has(sessionId)) return null
          const nextSeen = new Set(seen).add(sessionId)
          const rawStatus = String(session.status ?? session.activity ?? '').toLowerCase()
          const lifecycle = String(session.lifecycle ?? '').toLowerCase()
          const workerState = String(session.workerState ?? '').toLowerCase()
          const status: SubagentNode['status'] = workerState === 'failed' || rawStatus === 'error' || rawStatus === 'failed'
                ? 'error'
            : ['working', 'queued', 'starting'].includes(rawStatus) || session.isStreaming === true
              ? 'working'
              : lifecycle === 'archived' || rawStatus === 'archived'
                ? 'archived'
                : 'idle'
          const timestamp = Date.parse(String(session.lastActivityAt ?? session.modified ?? session.created ?? ''))
          const firstMessage = String(session.firstMessage ?? '')
          const detail = childDetails.get(String(session.rlmChildId ?? ''))
            ?? childDetails.get(String(session.activeSessionId ?? ''))
          return {
            id: String(session.rlmChildId ?? session.activeSessionId ?? session.id ?? sessionId),
            sessionId,
            activeSessionId: session.activeSessionId ? String(session.activeSessionId) : null,
            parentSessionId,
            name: String(session.sessionName ?? session.rlmChildId ?? 'Subagent'),
            depth: Number(session.rlmDepth ?? 1),
            status,
            task: firstMessage === '(no messages)' ? '' : firstMessage,
            lastActivityAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
            model: typeof detail?.model === 'string' ? detail.model : undefined,
            durationMs: typeof detail?.durationMs === 'number' ? detail.durationMs : undefined,
            answerPreview: typeof detail?.answerPreview === 'string' ? detail.answerPreview : undefined,
            toolUseCount: typeof detail?.toolUseCount === 'number' ? detail.toolUseCount : undefined,
            tokenCount: typeof detail?.tokenCount === 'number' ? detail.tokenCount : undefined,
            recap: typeof detail?.recap === 'string' ? detail.recap : undefined,
            activity: detail?.activity as SubagentNode['activity'],
            error: typeof detail?.error === 'string' ? detail.error : undefined,
            children: build(sessionId, nextSeen)
          } satisfies SubagentNode
        })
        .filter((node): node is Exclude<typeof node, null> => node !== null)
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt)
    }

    return build(rootSessionId)
  }

  async getSubagentMessages(selector: string): Promise<unknown[]> {
    if (!this.client || !this.running || !selector) return []
    if (this.subagentReader?.selector === selector) {
      return this.subagentReader.connection.getMessages()
    }
    await this.releaseSubagentReader()
    const { DaemonAgentConnection } = await loadModules(this.options.binary)
    const connection = await DaemonAgentConnection.attach(this.client, selector, {
      closeClientOnDispose: false,
      supportsExtensionUi: false
    })
    this.subagentReader = { selector, connection }
    return connection.getMessages()
  }

  async deleteSavedSession(sessionPath: string): Promise<void> {
    if (!this.client || !this.running) throw new Error('Agent not connected')
    const result = responseData(
      await this.client.request({ type: 'delete_saved_session', sessionPath }, 30_000),
      'delete_saved_session'
    )
    if (result.ok === false) throw new Error(String(result.error ?? 'Could not delete session'))
  }

  async send<T = unknown>(cmd: Record<string, unknown>): Promise<T> {
    const c = this.connection
    if (!c || !this.running) throw new Error('Agent is not connected')
    const type = String(cmd.type ?? '')
    let result: unknown
    switch (type) {
      case 'get_state':
        result = await c.getState()
        break
      case 'get_messages':
        result = { messages: await c.getMessages() }
        break
      case 'get_commands':
        result = { commands: await c.getCommands() }
        break
      case 'get_available_models':
        result = { models: await c.getAvailableModels() }
        break
      case 'get_session_stats':
        result = await c.getSessionStats()
        break
      case 'prompt':
        result = await c.prompt(String(cmd.message ?? ''), {
          images: cmd.images,
          // The daemon uses this option to resume input after Stop.
          streamingBehavior: cmd.streamingBehavior ?? 'followUp'
        })
        break
      case 'steer':
        result = await c.steer(String(cmd.message ?? ''), cmd.images as unknown[] | undefined)
        break
      case 'follow_up':
        result = await c.followUp(String(cmd.message ?? ''), cmd.images as unknown[] | undefined)
        break
      case 'abort':
        result = await c.abort()
        break
      case 'compact':
        result = await c.compact(cmd.customInstructions as string | undefined)
        break
      case 'refine':
        result = await c.refine({
          instructions: cmd.instructions,
          rollbackId: cmd.rollbackId,
          global: cmd.global
        })
        break
      case 'new_session':
        result = await c.newSession()
        break
      case 'switch_session':
        result = await c.switchSession(String(cmd.sessionPath ?? ''))
        break
      case 'fork': {
        const tree = await c.getSessionTree()
        const entryId = String(cmd.entryId ?? tree.leafId ?? '')
        if (!entryId) throw new Error('No message is available to fork.')
        result = await c.fork(entryId)
        break
      }
      case 'clone': {
        const tree = await c.getSessionTree()
        if (!tree.leafId) throw new Error('No message is available to clone.')
        result = await c.fork(tree.leafId)
        break
      }
      case 'set_model': {
        const modelId = String(cmd.modelId ?? '')
        let provider = String(cmd.provider ?? '')
        if (!provider) {
          const models = await c.getAvailableModels() as Record<string, unknown>[]
          provider = String(models.find((model) => model.id === modelId)?.provider ?? '')
        }
        if (!provider || !modelId) throw new Error('A provider and model are required.')
        result = await c.setModel(provider, modelId)
        break
      }
      case 'set_thinking_level':
        result = await c.setThinkingLevel(String(cmd.level ?? 'medium'))
        break
      case 'set_auto_compaction':
        result = await c.setAutoCompactionEnabled(Boolean(cmd.enabled))
        break
      case 'set_auto_retry':
        result = await c.setAutoRetryEnabled(Boolean(cmd.enabled))
        break
      case 'set_session_name':
        result = await c.setSessionName(String(cmd.name ?? ''))
        break
      case 'bash':
        result = await c.executeBash(String(cmd.command ?? ''))
        break
      case 'reload':
        result = await c.reload()
        break
      case 'export_html':
        result = { path: await c.exportToHtml(cmd.outputPath as string | undefined) }
        break
      case 'get_fork_messages':
        result = { messages: await c.getUserMessagesForForking() }
        break
      case 'get_last_assistant_text':
        result = { text: await c.getLastAssistantText() }
        break
      case 'set_rlm_max_depth':
        result = await c.setRlmMaxDepth(Number(cmd.maxDepth), { global: Boolean(cmd.global) })
        break
      case 'get_rlm_max_depth_status':
        result = await c.getRlmMaxDepthStatus()
        break
      case 'list_schedules':
        result = { jobs: await c.listCronJobs({ includeInactive: true }) }
        break
      case 'add_schedule':
        result = await c.addCronJob(String(cmd.schedule ?? ''), String(cmd.prompt ?? ''))
        break
      case 'cancel_schedule':
        result = await c.cancelCronJob(String(cmd.jobId ?? ''))
        break
      case 'get_heartbeat':
        result = { heartbeat: await c.getHeartbeat() }
        break
      case 'set_heartbeat':
        result = await c.setHeartbeat(
          String(cmd.schedule ?? ''),
          String(cmd.prompt ?? ''),
          cmd.deliveryMode as string | undefined
        )
        break
      case 'update_heartbeat':
        result = await c.updateHeartbeat(String(cmd.action ?? ''))
        break
      case 'send_message':
        result = await c.sendAgentMessage(String(cmd.targetActiveSessionId ?? ''), String(cmd.message ?? ''))
        break
      case 'extension_ui_response': {
        const response = { ...cmd }
        delete response.type
        delete response.id
        result = await c.respondToExtensionUiRequest(String(cmd.id ?? ''), response)
        break
      }
      default:
        throw new Error(`Unsupported daemon transport command: ${type}`)
    }
    return result as T
  }

  fire(cmd: Record<string, unknown>): void {
    void this.send(cmd).catch((error) => this.emit('process_error', error instanceof Error ? error.message : String(error)))
  }

  stop(): Promise<void> {
    return this.dispose()
  }

  kill(): void {
    void this.dispose()
  }

  // Disconnecting leaves a resident worker running in the daemon. A chat slot
  // the desktop opened and no longer needs is stopped outright so idle
  // workers don't pile up.
  async release(): Promise<void> {
    const client = this.client
    const activeSessionId = this.rootActiveSessionId
    if (client && activeSessionId && !this.disposed) {
      await client.request({ type: 'kill', activeSessionId }, 10_000).catch(() => {})
    }
    await this.dispose()
  }

  private async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    try {
      await this.releaseSubagentReader()
      await this.connection?.dispose()
    } finally {
      this.connection = null
      this.client?.close()
      this.client = null
      for (const fn of this.exitHandlers) fn()
    }
  }

  private async releaseSubagentReader(): Promise<void> {
    const reader = this.subagentReader
    this.subagentReader = null
    await reader?.connection.dispose().catch(() => {})
  }
}
