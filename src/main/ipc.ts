import { BrowserWindow, dialog, ipcMain as electronIpcMain, Notification, shell, app, nativeTheme, type IpcMainInvokeEvent } from 'electron'
import { readFile, stat } from 'fs/promises'
import { AgentManager } from './agentManager'
import { BinaryManager } from './binary'
import { listExternalSessions } from './daemonTransport'
import { getCustomProviders, refreshOpenRouterModels, removeCustomProvider, setCustomProvider } from './primeFiles'
import { addPreviewFile, getState, setSessionPinned, setSettings, setTabs } from './store'
import { IPC, type AgentCommand, type ProjectTab, type AutonomousConfig } from '@shared/types'
import { basename, extname, join, resolve as resolvePath } from 'path'
import { randomUUID } from 'crypto'
import { TerminalManager } from './terminalManager'
import { resolveThemeMode } from '@shared/themes'
import {
  changelogText,
  listAuthProviders,
  LOGS_DIR,
  openPrimeAgentLogin,
  readPrimeRlmMaxDepth,
  removeAuth,
  setAuthKey,
  writePrimeRlmMaxDepth
} from './primeFiles'
import {
  assertTrustedRenderer,
  requireExistingDirectory,
  requireExistingFile,
  requireNonEmptyString,
  requireSafeExternalUrl,
  requireString,
  isWithin,
  validateAgentCommand
} from './ipcSecurity'

async function readPreviewFile(file: string): Promise<{ path: string; size: number; mime: string; content?: string; dataUrl?: string }> {
  const info = await stat(file)
  const extension = extname(file).toLowerCase()
  const binaryPreviewMime: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel'
  }
  const maxSize = binaryPreviewMime[extension] ? 32 * 1024 * 1024 : 8 * 1024 * 1024
  if (info.size > maxSize) throw new Error('Artifact is too large to preview')
  const imageMime: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
  }
  if (imageMime[extension]) {
    const data = (await readFile(file)).toString('base64')
    return { path: file, size: info.size, mime: imageMime[extension], dataUrl: `data:${imageMime[extension]};base64,${data}` }
  }
  if (binaryPreviewMime[extension]) {
    const data = (await readFile(file)).toString('base64')
    const mime = binaryPreviewMime[extension]
    return { path: file, size: info.size, mime, dataUrl: `data:${mime};base64,${data}` }
  }
  return { path: file, size: info.size, mime: 'text/plain', content: await readFile(file, 'utf8') }
}

// Files outside the agent-scoped artifact APIs: only open projects or files
// the user explicitly picked in the native dialog.
async function requirePreviewableFile(rawPath: unknown): Promise<string> {
  const file = requireExistingFile(rawPath, 'path')
  const state = await getState()
  if (state.tabs.some((tab) => isWithin(tab.path, file))) return file
  if (state.previewFiles.includes(file)) return file
  throw new Error('File is not in an open project or a file you opened')
}

export function registerIpc(win: () => BrowserWindow | null, manager: AgentManager, binary: BinaryManager): void {
  const terminals = new TerminalManager()
  const ipcMain = {
    handle<Args extends unknown[], Result>(
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>
    ): void {
      electronIpcMain.handle(channel, (event, ...args) => {
        assertTrustedRenderer(event, win)
        return listener(event, ...args as Args)
      })
    }
  }
  const send = (channel: string, payload: unknown) => {
    const w = win()
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
  }

  manager.on('renderer', ({ channel, payload }: { channel: string; payload: unknown }) => {
    send(channel, payload)
  })
  manager.on('native-notify', ({ title, body }: { title: string; body: string }) => {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  })
  binary.on('change', (state) => send('events', { type: 'binary_state', payload: state }))
  terminals.on('data', (payload) => send(IPC.terminalData, payload))
  terminals.on('exit', (payload) => send(IPC.terminalExit, payload))
  app.once('before-quit', () => terminals.shutdownAll())

  ipcMain.handle(IPC.binaryGet, () => binary.stateSnapshot)
  ipcMain.handle(IPC.binaryInstall, async () => {
    await binary.install()
    return binary.stateSnapshot
  })

  ipcMain.handle(IPC.chooseFolder, async () => {
    const w = win()
    const res = w
      ? await dialog.showOpenDialog(w, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.chooseFile, async () => {
    const w = win()
    const res = w
      ? await dialog.showOpenDialog(w, { properties: ['openFile'], filters: [{ name: 'Sessions', extensions: ['jsonl', 'html'] }] })
      : await dialog.showOpenDialog({ properties: ['openFile'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.chooseSave, async (_e, defaultName?: string) => {
    const w = win()
    const res = w
      ? await dialog.showSaveDialog(w, { defaultPath: defaultName ?? 'session.html' })
      : await dialog.showSaveDialog({ defaultPath: defaultName ?? 'session.html' })
    return res.canceled ? null : res.filePath
  })

  ipcMain.handle(IPC.tabsList, async () => {
    const s = await getState()
    return { tabs: s.tabs, activeTabId: s.activeTabId }
  })

  ipcMain.handle(IPC.tabAdd, async (_e, rawPath: string) => {
    const path = requireExistingDirectory(rawPath, 'project path')
    const s = await getState()
    const tab: ProjectTab = { id: randomUUID(), path, name: basename(path) }
    const tabs = [...s.tabs.filter((t) => t.path !== path), tab]
    await setTabs(tabs, tab.id)
    const settings = s.settings
    await manager.openTab(tab, settings)
    return { tab, tabs, activeTabId: tab.id }
  })

  ipcMain.handle(IPC.tabRemove, async (_e, tabId: string) => {
    const s = await getState()
    const tabs = s.tabs.filter((t) => t.id !== tabId)
    const activeTabId = s.activeTabId === tabId ? (tabs[0]?.id ?? null) : s.activeTabId
    manager.closeTab(tabId)
    terminals.close(`agent-${tabId}`)
    await setTabs(tabs, activeTabId)
    return { tabs, activeTabId }
  })

  ipcMain.handle(IPC.tabSelect, async (_e, tabId: string) => {
    const s = await getState()
    if (!s.tabs.some((tab) => tab.id === tabId)) throw new Error('Unknown tab')
    await setTabs(s.tabs, tabId)
    return { activeTabId: tabId }
  })

  ipcMain.handle(IPC.agentCreate, async (_e, tabId: string) => {
    const s = await getState()
    const tab = s.tabs.find((t) => t.id === tabId)
    if (!tab) throw new Error('Unknown tab')
    return manager.openTab(tab, s.settings)
  })

  ipcMain.handle(IPC.agentState, async () => manager.allAgentInfos())

  ipcMain.handle(IPC.agentCommand, async (_e, agentId: string, cmd: AgentCommand) => {
    const s = await getState()
    cmd = validateAgentCommand(cmd)
    if (cmd.type === 'set_model' && (cmd as { modelId?: string }).modelId) {
      const id = (cmd as { modelId: string }).modelId
      const provider = (cmd as { provider?: string }).provider
      void setSettings({ model: provider ? `${provider}/${id}` : id })
    }
    return manager.runCommand(agentId, cmd, s.settings)
  })

  ipcMain.handle(IPC.agentMessages, (_e, agentId: string) => manager.getMessages(agentId))
  ipcMain.handle(IPC.agentStats, (_e, agentId: string) => manager.getStats(agentId))
  ipcMain.handle(IPC.agentSessions, (_e, agentId?: string) => manager.getSessions(agentId))
  ipcMain.handle(IPC.agentResume, async (_e, agentId: string, sessionPath: string) => {
    const sessions = await manager.getSessions(agentId)
    const target = requireExistingFile(sessionPath, 'session path')
    if (!sessions.some((session) => resolvePath(session.sessionFile) === target)) {
      throw new Error('Session does not belong to this project')
    }
    // Opening a chat never interrupts a running one: the manager focuses the
    // chat if it's already live, or opens it in an idle or new slot.
    return manager.openSession(agentId, target, (await getState()).settings)
  })
  ipcMain.handle(IPC.agentSessionDelete, async (_e, agentId: string, sessionPath: string) => {
    const sessions = await manager.getSessions(agentId)
    const target = requireExistingFile(sessionPath, 'session path')
    if (!sessions.some((session) => resolvePath(session.sessionFile) === target)) {
      throw new Error('Session does not belong to this project')
    }
    const remaining = await manager.deleteSession(agentId, target)
    await setSessionPinned(target, false)
    return remaining
  })
  ipcMain.handle(IPC.sessionPinsGet, async () => (await getState()).pinnedSessionFiles)
  ipcMain.handle(IPC.sessionPinSet, (_e, sessionPath: unknown, pinned: unknown) =>
    setSessionPinned(requireString(sessionPath, 'session path', 4_096), pinned === true))
  ipcMain.handle(IPC.agentCommands, (_e, agentId: string) => manager.getCommands(agentId))
  ipcMain.handle(
    IPC.agentHarness,
    (_e, agentId: string, action: string, input?: Record<string, unknown>) =>
      manager.harnessAction(agentId, action, input)
  )

  const terminalPath = (agentId: string): string => {
    const path = manager.getProjectPath(agentId)
    if (!path) throw new Error('Project is not available')
    return path
  }
  ipcMain.handle(IPC.terminalStart, (_e, agentId: string, cols?: number, rows?: number) =>
    terminals.start(agentId, terminalPath(agentId), cols, rows))
  ipcMain.handle(IPC.terminalWrite, (_e, agentId: string, data: string) => terminals.write(agentId, data))
  ipcMain.handle(IPC.terminalResize, (_e, agentId: string, cols: number, rows: number) =>
    terminals.resize(agentId, cols, rows))
  ipcMain.handle(IPC.terminalRestart, (_e, agentId: string, cols?: number, rows?: number) =>
    terminals.restart(agentId, terminalPath(agentId), cols, rows))
  ipcMain.handle(IPC.terminalClear, (_e, agentId: string) => terminals.clear(agentId))
  ipcMain.handle(IPC.terminalClose, (_e, agentId: string) => terminals.close(agentId))

  ipcMain.handle(IPC.fleetList, () => manager.allAgentInfos())
  ipcMain.handle(IPC.fleetTree, (_e, agentId: string) => manager.getSubagentTree(agentId))
  ipcMain.handle(IPC.fleetMessages, (_e, agentId: string, activeSessionId: string) =>
    manager.getSubagentMessages(agentId, activeSessionId))
  ipcMain.handle(IPC.fleetObserve, (_e, agentId: string, sessionId: string) => manager.observeFleet(agentId, sessionId))
  ipcMain.handle(IPC.fleetUnobserve, (_e, sessionId: string) => manager.unobserve(sessionId))
  ipcMain.handle(IPC.fleetSend, (_e, agentId: string, target: string, message: string, mode?: string) =>
    manager.sendMessage(agentId, target, message, mode)
  )
  ipcMain.handle(IPC.fleetSchedules, () => manager.listSchedules())
  ipcMain.handle(IPC.fleetScheduleAdd, (_e, agentId: string, schedule: string, prompt: string) =>
    manager.addSchedule(agentId, schedule, prompt)
  )
  ipcMain.handle(IPC.fleetScheduleCancel, (_e, agentId: string, jobId: string) => manager.cancelSchedule(agentId, jobId))
  ipcMain.handle(IPC.fleetHeartbeat, (_e, agentId: string) => manager.getHeartbeat(agentId))
  ipcMain.handle(IPC.fleetHeartbeatAction, (_e, agentId: string, action: string) => manager.heartbeatAction(agentId, action))

  ipcMain.handle(IPC.externalList, () => listExternalSessions(binary.getBinary()))
  ipcMain.handle(IPC.externalMessage, (_e, target: unknown, message: unknown) =>
    manager.messageExternal(String(target ?? ''), String(message ?? ''))
  )

  ipcMain.handle(IPC.modelsCustomGet, () => getCustomProviders())
  ipcMain.handle(IPC.modelsCustomSet, (_e, config: unknown) => {
    const raw = (config ?? {}) as Record<string, unknown>
    const models = Array.isArray(raw.models) ? raw.models as { id?: unknown; name?: unknown }[] : []
    return setCustomProvider({
      provider: String(raw.provider ?? ''),
      baseUrl: String(raw.baseUrl ?? ''),
      api: typeof raw.api === 'string' ? raw.api : undefined,
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
      models: models.map((model) => ({ id: String(model?.id ?? ''), name: typeof model?.name === 'string' ? model.name : undefined }))
    }).then(async (providers) => {
      await manager.reloadAgents()
      return providers
    })
  })
  ipcMain.handle(IPC.modelsCustomRemove, (_e, providerId: unknown) =>
    removeCustomProvider(String(providerId ?? '')).then(async (providers) => {
      await manager.reloadAgents()
      return providers
    })
  )
  ipcMain.handle(IPC.modelsOpenRouterRefresh, async (_e, agentId: string) => {
    const settings = (await getState()).settings
    await refreshOpenRouterModels()
    return manager.runCommand(agentId, { type: 'get_available_models' }, settings)
  })

  ipcMain.handle(IPC.gitList, (_e, agentId: string) => manager.listCheckpoints(agentId))
  ipcMain.handle(IPC.gitRestore, (_e, agentId: string, sha: string) => manager.restoreCheckpoint(agentId, sha))
  ipcMain.handle(IPC.gitDiffFiles, (_e, agentId: string) => manager.diffFiles(agentId))
  ipcMain.handle(IPC.gitStatus, (_e, agentId: string) => manager.gitStatus(agentId))
  ipcMain.handle(IPC.gitFileDiff, (_e, agentId: string, path: string, staged: boolean) =>
    manager.gitFileDiff(agentId, path, staged))
  ipcMain.handle(IPC.artifactChoose, async () => {
    const w = win()
    const res = w
      ? await dialog.showOpenDialog(w, { properties: ['openFile'] })
      : await dialog.showOpenDialog({ properties: ['openFile'] })
    const picked = res.canceled ? undefined : res.filePaths[0]
    if (!picked) return null
    await addPreviewFile(picked)
    return resolvePath(picked)
  })
  ipcMain.handle(IPC.artifactReadFile, async (_e, rawPath: unknown) =>
    readPreviewFile(await requirePreviewableFile(rawPath)))
  ipcMain.handle(IPC.artifactRead, async (_e, agentId: string, rawPath: string) => {
    const projectPath = manager.getProjectPath(agentId)
    if (!projectPath) throw new Error('Project is not available')
    const requested = requireNonEmptyString(rawPath, 'artifact path', 4_096)
    const filePath = resolvePath(projectPath, requested)
    if (!isWithin(projectPath, filePath)) throw new Error('Artifact path is outside the project')
    const file = requireExistingFile(filePath, 'artifact path')
    return readPreviewFile(file)
  })
  ipcMain.handle(IPC.artifactReveal, (_e, agentId: string, rawPath: string) => {
    const projectPath = manager.getProjectPath(agentId)
    if (!projectPath) throw new Error('Project is not available')
    const requested = requireNonEmptyString(rawPath, 'artifact path', 4_096)
    const filePath = resolvePath(projectPath, requested)
    if (!isWithin(projectPath, filePath)) throw new Error('Artifact path is outside the project')
    shell.showItemInFolder(requireExistingFile(filePath, 'artifact path'))
    return true
  })
  ipcMain.handle(IPC.gitStage, (_e, agentId: string, paths: string[]) => manager.gitStage(agentId, paths))
  ipcMain.handle(IPC.gitUnstage, (_e, agentId: string, paths: string[]) => manager.gitUnstage(agentId, paths))
  ipcMain.handle(IPC.gitStageAll, (_e, agentId: string) => manager.gitStageAll(agentId))
  ipcMain.handle(IPC.gitUnstageAll, (_e, agentId: string) => manager.gitUnstageAll(agentId))
  ipcMain.handle(IPC.gitCommit, (_e, agentId: string, message: string) => manager.gitCommit(agentId, message))

  ipcMain.handle(IPC.dashboardSpend, () => manager.spend())
  ipcMain.handle(IPC.dashboardModels, async () => {
    const out: string[] = []
    for (const a of manager.allAgentInfos()) {
      if (a.model) out.push(a.model)
    }
    return out
  })

  ipcMain.handle(IPC.autonomyGet, async () => {
    const s = await getState()
    const agentId = s.activeTabId ? `agent-${s.activeTabId}` : null
    return manager.getAutonomy(agentId)
  })
  ipcMain.handle(IPC.autonomySet, async (_e, patch: unknown) => {
    const s = await getState()
    const agentId = s.activeTabId ? `agent-${s.activeTabId}` : null
    return manager.setAutonomy(agentId, patch as Partial<AutonomousConfig>)
  })

  ipcMain.handle(IPC.skillsList, (_e, agentId: string) => manager.listSkills(agentId))
  ipcMain.handle(IPC.skillsInstall, (_e, source: string) => manager.installSkillPackage(source))

  ipcMain.handle(IPC.dialogRespond, (_e, dialogId: string, value: unknown, cancelled: boolean) =>
    manager.respondDialog(dialogId, value, cancelled)
  )

  ipcMain.handle(IPC.settingsGet, async () => (await getState()).settings)
  ipcMain.handle(IPC.settingsSet, async (_e, patch: unknown) => {
    const s = await getState()
    const settings = await setSettings(patch as Parameters<typeof setSettings>[0])
    const variant = resolveThemeMode(settings.themeMode, nativeTheme.shouldUseDarkColors)
    const windowTheme = variant === 'dark' ? settings.darkTheme : settings.lightTheme
    const window = win()
    if (window) {
      window.setBackgroundColor(windowTheme.opaqueWindows ? windowTheme.surface : '#00000000')
      if (process.platform === 'darwin') {
        window.setVibrancy(windowTheme.opaqueWindows ? null : (variant === 'light' ? 'under-window' : 'sidebar'))
      }
    }
    const p = patch as Record<string, unknown>
    for (const a of manager.allAgentInfos()) {
      const agentId = a.id
      if (p.autoCompaction !== undefined) {
        void manager.runCommand(agentId, { type: 'set_auto_compaction', enabled: Boolean(p.autoCompaction) }, s.settings).catch(() => {})
      }
      if (p.autoRetry !== undefined) {
        void manager.runCommand(agentId, { type: 'set_auto_retry', enabled: Boolean(p.autoRetry) }, s.settings).catch(() => {})
      }
      if (p.thinkingLevel !== undefined) {
        void manager.runCommand(agentId, { type: 'set_thinking_level', level: String(p.thinkingLevel) }, s.settings).catch(() => {})
      }
      if (p.rlmMaxDepth !== undefined) {
        void manager.setRlmMaxDepth(agentId, Number(p.rlmMaxDepth), true).catch(() => {})
      }
    }
    return settings
  })

  ipcMain.handle(IPC.revealInFinder, async (_e, path: unknown) => shell.showItemInFolder(await requirePreviewableFile(path)))
  ipcMain.handle(IPC.openExternal, (_e, url: string) => shell.openExternal(requireSafeExternalUrl(url)))
  ipcMain.handle(IPC.quit, () => app.quit())

  ipcMain.handle(IPC.authList, () => listAuthProviders())
  ipcMain.handle(IPC.authSet, (_e, provider: string, key: string) =>
    setAuthKey(requireNonEmptyString(provider, 'provider', 128), requireNonEmptyString(key, 'API key', 4_096))
  )
  ipcMain.handle(IPC.authRemove, (_e, provider: string) => removeAuth(requireNonEmptyString(provider, 'provider', 128)))
  ipcMain.handle(IPC.authOpenTui, () => {
    return openPrimeAgentLogin(binary.getBinary())
  })
  ipcMain.handle(IPC.rlmGet, async (_e, agentId: string) => {
    const s = await getState()
    const fallback = s.settings.rlmMaxDepth ?? (await readPrimeRlmMaxDepth(1))
    return manager.getRlmMaxDepth(agentId, fallback)
  })
  ipcMain.handle(IPC.rlmSet, async (_e, agentId: string, maxDepth: number, global?: boolean) => {
    const result = await manager.setRlmMaxDepth(agentId, maxDepth, global !== false)
    await setSettings({ rlmMaxDepth: result.maxDepth })
    await writePrimeRlmMaxDepth(result.maxDepth)
    return result
  })
  ipcMain.handle(IPC.exportHtml, async (_e, agentId: string, outputPath?: string) => manager.exportHtml(agentId, outputPath))
  ipcMain.handle(IPC.shareSession, (_e, agentId: string) => manager.shareSession(agentId))
  ipcMain.handle(IPC.changelog, () => changelogText())
  ipcMain.handle(IPC.logsReveal, () => {
    shell.showItemInFolder(join(LOGS_DIR, 'agent.jsonl'))
    return LOGS_DIR
  })
  ipcMain.handle(IPC.windowFullscreen, (_e, mode?: string) => {
    const w = win()
    if (!w) return false
    if (mode === 'on') w.setFullScreen(true)
    else if (mode === 'off') w.setFullScreen(false)
    else w.setFullScreen(!w.isFullScreen())
    return w.isFullScreen()
  })

  ipcMain.handle('state:initial', async () => {
    const s = await getState()
    const primeDepth = await readPrimeRlmMaxDepth(s.settings.rlmMaxDepth ?? 1)
    if (s.settings.rlmMaxDepth !== primeDepth) {
      s.settings = await setSettings({ rlmMaxDepth: primeDepth })
    }
    await binary.check()
    return { ...s, binary: binary.stateSnapshot }
  })
}
