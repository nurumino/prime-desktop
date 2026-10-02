import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { initialState, type AppState, type FleetEntry } from './lib/store'
import TabBar from './components/TabBar'
import Sidebar from './components/Sidebar'
import SidePanel, { type SidePanelTab } from './components/SidePanel'
import ChatView from './views/ChatView'
import FleetView from './views/FleetView'
import ApprovalView from './views/ApprovalView'
import DashboardView from './views/DashboardView'
import SkillsView from './views/SkillsView'
import SettingsView from './views/SettingsView'
import DiagnosticsView from './views/DiagnosticsView'
import Toasts from './components/Toasts'
import DialogHost from './components/DialogHost'
import WelcomeScreen from './components/WelcomeScreen'
import CommandPalette from './components/CommandPalette'
import type { PaletteItem } from '@shared/palette'
import type { Artifact, FileDiff, PrimeEvent, SubagentNode, Toast } from '@shared/types'
import ErrorBoundary from './components/ErrorBoundary'
import { applyAppTheme } from './lib/theme'

type NavigationLocation = { view: AppState['view']; tabId: string | null }

function artifactKind(path: string): Artifact['kind'] {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  if (['pdb', 'pdbqt', 'cif', 'mmcif', 'sdf', 'mol', 'mol2', 'xyz'].includes(ext)) return 'structure'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image'
  if (['csv', 'tsv', 'json', 'jsonl', 'xlsx', 'xls'].includes(ext)) return 'table'
  if (['md', 'txt', 'log', 'html', 'xml', 'yaml', 'yml', 'toml', 'pdf', 'docx', 'pptx'].includes(ext)) return 'document'
  if (['fasta', 'fa', 'fastq', 'fq', 'bed', 'gff', 'gtf', 'vcf'].includes(ext)) return 'text'
  return 'unknown'
}

function messageIdOf(message: Record<string, unknown> | undefined): string | undefined {
  if (!message) return undefined
  const id = message.id as string | undefined
  if (id) return id
  if (message.timestamp == null) return undefined
  return `m-${String(message.timestamp)}-${String(message.role ?? '')}`
}

function errorMessage(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string' && content.trim()) return content.trim()
  if (Array.isArray(content)) {
    const text = content.map((block) => {
      if (!block || typeof block !== 'object') return ''
      return String((block as Record<string, unknown>).text ?? (block as Record<string, unknown>).content ?? '')
    }).join(' ').trim()
    if (text) return text
  }
  return 'The agent could not complete that request.'
}

function cleanToastText(text: string): string {
  const cleaned = text
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
  if (/agent not connected/i.test(cleaned)) return 'Agent not connected'
  return cleaned || 'Something went wrong.'
}

export default function App(): JSX.Element {
  const [state, setState] = useState<AppState>(initialState)
  const stateRef = useRef(state)
  stateRef.current = state

  const [sidePanelOpen, setSidePanelOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarHoverOpen, setSidebarHoverOpen] = useState(false)
  const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>('subagents')
  const [filesPreviewPath, setFilesPreviewPath] = useState<string | null>(null)
  const [selectedFleetEntry, setSelectedFleetEntry] = useState<FleetEntry | null>(null)
  const [subagentTree, setSubagentTree] = useState<SubagentNode[]>([])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const artifactBaselineRef = useRef<Record<string, Record<string, string>>>({})
  const backHistoryRef = useRef<NavigationLocation[]>([])
  const forwardHistoryRef = useRef<NavigationLocation[]>([])
  const recentToastRef = useRef<{ text: string; at: number } | null>(null)
  const [, setNavigationRevision] = useState(0)

  const mutate = useCallback((fn: (s: AppState) => AppState) => {
    setState((prev) => fn(prev))
  }, [])

  const showToast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const cleanText = cleanToastText(text)
    const now = Date.now()
    if (recentToastRef.current?.text === cleanText && now - recentToastRef.current.at < 2500) return
    recentToastRef.current = { text: cleanText, at: now }
    const t = { id: `t-${now}-${Math.random().toString(36).slice(2, 6)}`, kind, text: cleanText }
    mutate((s) => ({ ...s, toasts: [...s.toasts.slice(-4), t] }))
    window.setTimeout(() => {
      mutate((s) => ({ ...s, toasts: s.toasts.filter((x) => x.id !== t.id) }))
    }, 4000)
  }, [mutate])

  const currentLocation = useCallback((): NavigationLocation => ({
    view: stateRef.current.view,
    tabId: stateRef.current.activeTabId
  }), [])

  const applyLocation = useCallback((location: NavigationLocation) => {
    // Keep the ref current immediately: callers such as the sidebar select a
    // tab and then a view in the same tick, before React re-renders.
    stateRef.current = { ...stateRef.current, view: location.view, activeTabId: location.tabId }
    mutate((s) => ({ ...s, view: location.view, activeTabId: location.tabId }))
    if (location.tabId) void window.prime.tabSelect(location.tabId)
  }, [mutate])

  const navigate = useCallback((view: AppState['view'], tabId = stateRef.current.activeTabId) => {
    const current = currentLocation()
    if (current.view === view && current.tabId === tabId) return
    backHistoryRef.current.push(current)
    if (backHistoryRef.current.length > 50) backHistoryRef.current.shift()
    forwardHistoryRef.current = []
    applyLocation({ view, tabId })
    setNavigationRevision((revision) => revision + 1)
  }, [applyLocation, currentLocation])

  const goBack = useCallback(() => {
    const location = backHistoryRef.current.pop()
    if (!location) return
    forwardHistoryRef.current.push(currentLocation())
    applyLocation(location)
    setNavigationRevision((revision) => revision + 1)
  }, [applyLocation, currentLocation])

  const goForward = useCallback(() => {
    const location = forwardHistoryRef.current.pop()
    if (!location) return
    backHistoryRef.current.push(currentLocation())
    applyLocation(location)
    setNavigationRevision((revision) => revision + 1)
  }, [applyLocation, currentLocation])

  useEffect(() => {
    const openSideChat = () => {
      setSidePanelTab('sidechat')
      setSidePanelOpen(true)
    }
    window.addEventListener('prime:open-side-chat', openSideChat)
    return () => window.removeEventListener('prime:open-side-chat', openSideChat)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => applyAppTheme(state.settings, media.matches)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [state.settings])

  const refreshArtifacts = useCallback((agentId: string, messageId?: string) => {
    void window.prime.gitDiffFiles(agentId).then((rawDiffs) => {
      const diffs = rawDiffs as FileDiff[]
      const baseline = artifactBaselineRef.current[agentId] ?? {}
      const changed = diffs.filter((diff) => baseline[diff.path] !== diff.diff)
      const sessionKey = `${agentId}::${stateRef.current.agents[agentId]?.sessionId ?? ''}`
      const next = changed.map((diff) => ({
        path: diff.path,
        status: diff.status,
        kind: artifactKind(diff.path),
        diff: diff.diff,
        messageId
      }))
      mutate((s) => {
        const merged = new Map<string, Artifact>()
        for (const existing of s.artifacts[sessionKey] ?? []) merged.set(`${existing.messageId ?? ''}::${existing.path}`, existing)
        for (const artifact of next) merged.set(`${messageId ?? ''}::${artifact.path}`, artifact)
        return { ...s, artifacts: { ...s.artifacts, [sessionKey]: [...merged.values()] } }
      })
      delete artifactBaselineRef.current[agentId]
    }).catch(() => {})
  }, [mutate])

  useEffect(() => {
    const cleanups: (() => void)[] = []

    void window.prime.initial().then((init) => {
      const data = init as {
        tabs: { id: string; path: string; name: string }[]
        activeTabId: string | null
        settings: AppState['settings']
        binary: AppState['binary']
      }
      mutate((s) => ({
        ...s,
        ready: true,
        tabs: data.tabs,
        activeTabId: data.activeTabId,
        settings: data.settings,
        binary: data.binary
      }))
      for (const tab of data.tabs) {
        void refreshAgent(`agent-${tab.id}`)
      }
      const hydrated: Record<string, Artifact[]> = {}
      try {
        const raw = window.localStorage.getItem('prime.files.runs.v1')
        const saved = raw ? JSON.parse(raw) : {}
        if (saved && typeof saved === 'object') {
          for (const key of Object.keys(saved)) {
            const items = saved[key]
            if (Array.isArray(items)) hydrated[key] = items.filter((i) => i && typeof i === 'object' && typeof i.path === 'string')
          }
        }
      } catch {
        // Ignore malformed persisted run artifacts.
      }
      mutate((s) => ({
        ...s,
        artifacts: { ...s.artifacts, ...hydrated }
      }))
    })

    async function refreshAgent(agentId: string) {
      const infos = await window.prime.agentState().catch(() => [])
      const infoList = infos as { id: string; [k: string]: unknown }[]
      const my = infoList.find((i) => i.id === agentId)
      if (my) {
        mutate((s) => ({ ...s, agents: { ...s.agents, [agentId]: my as never } }))
      }
    }

    cleanups.push(
      window.prime.onEvent((raw) => {
        const e = raw as PrimeEvent & { payload: Record<string, unknown> }
        handleEvent(e)
      }),
      window.prime.onToast((raw) => {
        const t = raw as Toast
        mutate((s) => ({ ...s, toasts: [...s.toasts.slice(-4), t] }))
        setTimeout(() => {
          mutate((s) => ({ ...s, toasts: s.toasts.filter((x) => x.id !== t.id) }))
        }, 5000)
      }),
      window.prime.onMenuOpenFolder(() => {
        void openFolder()
      })
    )

    return () => cleanups.forEach((c) => c())
  }, [])

  async function handleEvent(e: PrimeEvent & { payload: Record<string, unknown> }) {
    const { agentId, type, payload } = e

    switch (type) {
      case 'binary_state': {
        mutate((s) => ({ ...s, binary: payload as never }))
        return
      }
      case 'agent_info': {
        const info = payload as never
        mutate((s) => ({ ...s, agents: { ...s.agents, [agentId]: info } }))
        return
      }
      case 'chat_focus': {
        const tabId = String(payload.tabId ?? '')
        if (tabId) mutate((s) => ({ ...s, activeChatByTab: { ...s.activeChatByTab, [tabId]: agentId } }))
        return
      }
      case 'agent_closed': {
        const tabId = String(payload.tabId ?? '')
        mutate((s) => {
          const agents = { ...s.agents }
          delete agents[agentId]
          const activeChatByTab = { ...s.activeChatByTab }
          if (activeChatByTab[tabId] === agentId) delete activeChatByTab[tabId]
          return { ...s, agents, activeChatByTab }
        })
        return
      }
      case 'turn_start': {
        void window.prime.gitDiffFiles(agentId).then((rawDiffs) => {
          const diffs = rawDiffs as FileDiff[]
          artifactBaselineRef.current[agentId] = Object.fromEntries(
            diffs.map((diff) => [diff.path, diff.diff])
          )
        }).catch(() => {
          artifactBaselineRef.current[agentId] = {}
        })
        return
      }
      case 'turn_end': {
        const msg = payload.message as Record<string, unknown> | undefined
        if (msg?.isError) showToast(errorMessage(msg), 'error')
        refreshArtifacts(agentId, messageIdOf(msg))
        return
      }
      case 'extension_ui_request': {
        const method = payload.method as string
        if (['confirm', 'select', 'input', 'editor'].includes(method)) {
          const dialog = {
            id: payload.id as string,
            agentId,
            method: method as 'confirm' | 'select' | 'input' | 'editor',
            title: (payload.title as string) ?? method,
            message: payload.message as string | undefined,
            options: payload.options as string[] | undefined,
            prefill: payload.prefill as string | undefined
          }
          mutate((s) => ({
            ...s,
            dialogs: { ...s.dialogs, [agentId]: [...(s.dialogs[agentId] ?? []), dialog] }
          }))
        }
        return
      }
      case 'session_action_update': {
        return
      }
      case 'fleet_event': {
        const entry: FleetEntry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          at: Date.now(),
          agentId,
          label: (payload.type as string) ?? 'event',
          text: summarizeEvent(payload),
          payload,
          ownerAgentId: agentId,
          ownerSessionId: stateRef.current.agents[agentId]?.sessionId ?? null
        }
        mutate((s) => ({ ...s, fleet: [...s.fleet.slice(-199), entry] }))
        return
      }
      default:
        return
    }
  }

  async function openFolder() {
    const path = await window.prime.chooseFolder()
    if (!path) return
    const res = await window.prime.tabAdd(path)
    const tabs = res.tabs
    mutate((s) => ({
      ...s,
      tabs,
      activeTabId: res.activeTabId,
      agents: s.agents,
      activeAgentId: `agent-${res.activeTabId}`
    }))
  }

  const activeAgentId = useMemo(() => {
    if (state.activeTabId) {
      const chosen = state.activeChatByTab[state.activeTabId]
      return chosen && state.agents[chosen] ? chosen : `agent-${state.activeTabId}`
    }
    const first = Object.keys(state.agents)[0]
    return first ?? null
  }, [state.activeTabId, state.activeChatByTab, state.agents])

  const activeInfo = activeAgentId ? state.agents[activeAgentId] : null
  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? null

  const startNewChat = useCallback(() => {
    navigate('chat')
    if (activeAgentId) {
      void window.prime.agentCommand(activeAgentId, { type: 'new_session' } as never)
        .catch((err) => showToast(err instanceof Error ? err.message : String(err), 'error'))
    }
  }, [activeAgentId, navigate, showToast])

  const runPaletteItem = useCallback((item: PaletteItem) => {
    if (item.action === 'new-chat') {
      startNewChat()
      return
    }
    if (item.action === 'quit') {
      void window.prime.quit()
      return
    }
    if (item.action === 'set-model' && activeAgentId && item.provider && item.modelId) {
      void window.prime.agentCommand(activeAgentId, { type: 'set_model', provider: item.provider, modelId: item.modelId } as never)
        .then(() => showToast(item.label.replace(/^Switch to /, 'Model set to '), 'success'))
        .catch((err) => showToast(err instanceof Error ? err.message : String(err), 'error'))
      return
    }
    if (item.action === 'resume-session' && activeAgentId && item.sessionFile) {
      void window.prime.agentResume(activeAgentId, item.sessionFile)
        .then(() => navigate('chat'))
        .catch((err) => showToast(err instanceof Error ? err.message : String(err), 'error'))
      return
    }
    if (item.slash !== undefined) {
      const view = stateRef.current.view
      if (view !== 'chat' && view !== 'autonomy') {
        showToast('Open a project chat to run this command', 'info')
        return
      }
      window.dispatchEvent(new CustomEvent('prime:palette-slash', { detail: item.slash }))
      return
    }
  }, [activeAgentId, navigate, showToast, startNewChat])
  const activeFleet = useMemo(() => {
    if (!activeAgentId) return []
    return state.fleet.filter((entry) => (
      entry.ownerAgentId === activeAgentId
      && (!entry.ownerSessionId || entry.ownerSessionId === activeInfo?.sessionId)
    ))
  }, [state.fleet, activeAgentId, activeInfo?.sessionId])

  useEffect(() => {
    if (!activeAgentId) {
      setSubagentTree([])
      return
    }
    let disposed = false
    let latestLoad = 0
    const load = () => {
      const requestId = ++latestLoad
      void window.prime.fleetTree(activeAgentId)
        .then((tree: SubagentNode[]) => {
          if (!disposed && requestId === latestLoad) setSubagentTree(tree)
        })
        .catch(() => {})
    }
    setSelectedFleetEntry(null)
    setSubagentTree([])
    load()
    const timer = window.setInterval(load, 2500)
    const off = window.prime.onEvent((raw) => {
      const event = raw as { agentId?: string; type?: string }
      if (event.agentId !== activeAgentId) return
      if (
        event.type === 'tool_execution_start'
        || event.type === 'tool_execution_end'
        || event.type === 'custom_message'
        || event.type === 'turn_end'
        || event.type === 'session_replaced'
        || event.type === 'session_resynced'
      ) load()
    })
    return () => {
      disposed = true
      latestLoad += 1
      window.clearInterval(timer)
      off()
    }
  }, [activeAgentId, activeInfo?.sessionId])

  if (!state.ready) {
    return <div className="boot">Prime<span className="boot-dot" /></div>
  }

  const noTabs = state.tabs.length === 0

  return (
    <div className="app">
      <Sidebar
        state={state}
        activeAgentId={activeAgentId}
        collapsed={sidebarCollapsed}
        hoverOpen={sidebarCollapsed && sidebarHoverOpen}
        onHoverLeave={() => setSidebarHoverOpen(false)}
        onToggle={() => {
          setSidebarHoverOpen(false)
          setSidebarCollapsed((v) => !v)
        }}
        onView={(v) => navigate(v)}
        canGoBack={backHistoryRef.current.length > 0}
        canGoForward={forwardHistoryRef.current.length > 0}
        onBack={goBack}
        onForward={goForward}
        onNewChat={startNewChat}
        onSelectTab={(id) => {
          navigate('chat', id)
        }}
        onCloseTab={(id) => {
          void window.prime.tabRemove(id).then((res) => {
            mutate((s) => ({ ...s, tabs: res.tabs, activeTabId: res.activeTabId }))
          })
        }}
        onOpenFolder={() => void openFolder()}
        onFocusChat={(tabId, agentId) => {
          mutate((s) => ({ ...s, activeChatByTab: { ...s.activeChatByTab, [tabId]: agentId } }))
        }}
      />
      {sidebarCollapsed && !sidebarHoverOpen && (
        <div className="sidebar-hover-trigger" aria-hidden="true" onMouseEnter={() => setSidebarHoverOpen(true)} />
      )}
      <div className="app-main">
        <TabBar
          inspectorOpen={sidePanelOpen}
          onToggleInspector={() => setSidePanelOpen((open) => !open)}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => {
            setSidebarHoverOpen(false)
            setSidebarCollapsed((value) => !value)
          }}
          onNewChat={startNewChat}
          onOpenProject={() => void openFolder()}
          canGoBack={backHistoryRef.current.length > 0}
          canGoForward={forwardHistoryRef.current.length > 0}
          onBack={goBack}
          onForward={goForward}
          projectName={activeTab?.name}
        />
        <div className="app-body">
          {noTabs ? (
            <WelcomeScreen onOpen={() => void openFolder()} binary={state.binary} onInstall={() => void window.prime.binaryInstall()} />
          ) : (
            <>
              <main className="main-pane">
                {(state.view === 'chat' || state.view === 'autonomy') && activeAgentId && (
                  <ErrorBoundary key={`chat-${activeAgentId}`} label="This chat">
                  <ChatView
                    key={activeAgentId}
                    agentId={activeAgentId}
                    info={activeInfo}
                    tab={activeTab}
                    artifacts={state.artifacts[`${activeAgentId}::${activeInfo?.sessionId ?? ''}`] ?? []}
                    onOpenArtifacts={(path) => {
                      setSidePanelTab('files')
                      setSidePanelOpen(true)
                      setFilesPreviewPath(path ?? null)
                    }}
                    projects={state.tabs}
                    rlmMaxDepth={state.settings.rlmMaxDepth ?? 1}
                    onDepthChange={(depth) => {
                      mutate((s) => ({ ...s, settings: { ...s.settings, rlmMaxDepth: depth } }))
                      void window.prime.rlmSet(activeAgentId, depth, true)
                    }}
                    onNavigate={(view) => navigate(view)}
                    onOpenGit={() => {
                      setSidePanelTab('git')
                      setSidePanelOpen(true)
                    }}
                    subagents={subagentTree}
                    showSubagentCard={!sidePanelOpen}
                    onOpenSubagents={() => {
                      setSelectedFleetEntry(null)
                      setSidePanelTab('subagents')
                      setSidePanelOpen(true)
                    }}
                    onSelectProject={(projectId) => {
                      navigate('chat', projectId)
                    }}
                    onNewProject={() => void openFolder()}
                    showReasoning={state.settings.showReasoning !== false}
                    onToast={showToast}
                    onOpenSubagent={(entry) => {
                      const stored = findFleetEntry(activeFleet, entry)
                      const node = findSubagentNode(subagentTree, entry)
                      const merged = stored ? {
                        ...stored,
                        ...entry,
                        parentText: entry.parentText || stored.parentText,
                        childText: entry.childText || stored.childText
                      } : entry
                      setSelectedFleetEntry({
                        ...merged,
                        payload: {
                          ...(merged.payload ?? {}),
                          ...(node ? { activeSessionId: node.activeSessionId, sessionId: node.sessionId, name: node.name, task: node.task } : {})
                        }
                      })
                      setSidePanelTab('subagents')
                      setSidePanelOpen(true)
                    }}
                    onSubagentActivity={(entry) => {
                      const scopedEntry: FleetEntry = {
                        ...entry,
                        ownerAgentId: activeAgentId,
                        ownerSessionId: activeInfo?.sessionId ?? null
                      }
                      mutate((s) => {
                        const scopedFleet = s.fleet.filter((item) => (
                          item.ownerAgentId === activeAgentId && item.ownerSessionId === scopedEntry.ownerSessionId
                        ))
                        const matched = findFleetEntry(scopedFleet, scopedEntry)
                        const index = matched ? s.fleet.indexOf(matched) : -1
                        if (index < 0) return { ...s, fleet: [...s.fleet.slice(-199), scopedEntry] }
                        const updated = {
                          ...s.fleet[index],
                          ...scopedEntry,
                          parentText: scopedEntry.parentText || s.fleet[index].parentText,
                          childText: scopedEntry.childText || s.fleet[index].childText,
                          payload: { ...(s.fleet[index].payload ?? {}), ...(scopedEntry.payload ?? {}) }
                        }
                        // ChatView reports every subagent block on each streamed
                        // update; returning the same state skips an app-wide render.
                        if (sameFleetEntry(s.fleet[index], updated)) return s
                        const fleet = [...s.fleet]
                        fleet[index] = updated
                        return { ...s, fleet }
                      })
                      setSelectedFleetEntry((current) => {
                        if (!current || !entriesReferToSameAgent(current, entry)) return current
                        const updated = {
                          ...current,
                          ...entry,
                          parentText: entry.parentText || current.parentText,
                          childText: entry.childText || current.childText,
                          payload: { ...(entry.payload ?? {}), ...(current.payload ?? {}) }
                        }
                        return sameFleetEntry(current, updated) ? current : updated
                      })
                    }}
                  />
                  </ErrorBoundary>
                )}
                {state.view !== 'chat' && state.view !== 'autonomy' && (
                  <ErrorBoundary key={state.view} label="This page">
                    {state.view === 'fleet' && <FleetView state={state} />}
                    {state.view === 'approval' && <ApprovalView activeAgentId={activeAgentId} />}
                    {state.view === 'dashboard' && <DashboardView />}
                    {state.view === 'skills' && <SkillsView activeAgentId={activeAgentId} />}
                    {state.view === 'diagnostics' && <DiagnosticsView activeAgentId={activeAgentId} />}
                    {state.view === 'settings' && (
                      <SettingsView
                        settings={state.settings}
                        activeAgentId={activeAgentId}
                        onChange={(patch) => {
                          mutate((s) => ({ ...s, settings: { ...s.settings, ...patch } }))
                          void window.prime.settingsSet(patch)
                        }}
                      />
                    )}
                  </ErrorBoundary>
                )}
              </main>
              <SidePanel
                open={sidePanelOpen}
                onToggle={() => setSidePanelOpen((v) => !v)}
                fleet={activeFleet}
                tree={subagentTree}
                agentId={activeAgentId}
                sessionId={activeInfo?.sessionId ?? null}
                artifacts={state.artifacts[`${activeAgentId}::${activeInfo?.sessionId ?? ''}`] ?? []}
                onToast={showToast}
                activeTab={sidePanelTab}
                onTabChange={setSidePanelTab}
                filesPreviewPath={filesPreviewPath}
                onFilesPreviewPathChange={setFilesPreviewPath}
                selectedEntry={selectedFleetEntry}
                onSelectEntry={setSelectedFleetEntry}
                showReasoning={state.settings.showReasoning !== false}
              />
            </>
          )}
        </div>
      </div>
      <Toasts toasts={state.toasts} />
      <CommandPalette
        open={paletteOpen}
        agentId={activeAgentId}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(view) => { if (view) navigate(view) }}
        onRun={runPaletteItem}
      />
      <DialogHost dialogs={Object.values(state.dialogs).flat()} onRespond={(id, value, cancelled) => {
        void window.prime.dialogRespond(id, value, cancelled)
        mutate((s) => {
          const dialogs = { ...s.dialogs }
          for (const k of Object.keys(dialogs)) {
            dialogs[k] = dialogs[k].filter((d) => d.id !== id)
          }
          return { ...s, dialogs }
        })
      }} />
    </div>
  )
}

function findSubagentNode(tree: SubagentNode[], entry: FleetEntry): SubagentNode | null {
  const ids = entryIds(entry)
  const exact = findSubagentNodeByIds(tree, ids)
  if (exact || !isLegacyEntry(entry)) return exact
  const named = flattenSubagentNodes(tree).filter((node) => node.name === entry.label)
  return named.length === 1 ? named[0] : null
}

function findSubagentNodeByIds(tree: SubagentNode[], ids: Set<string>): SubagentNode | null {
  for (const node of tree) {
    if (ids.has(node.id) || ids.has(node.sessionId) || (node.activeSessionId ? ids.has(node.activeSessionId) : false)) return node
    const child = findSubagentNodeByIds(node.children, ids)
    if (child) return child
  }
  return null
}

function flattenSubagentNodes(tree: SubagentNode[]): SubagentNode[] {
  return tree.flatMap((node) => [node, ...flattenSubagentNodes(node.children)])
}

function entryIds(entry: FleetEntry): Set<string> {
  return new Set(
    [entry.agentId, entry.payload?.activeSessionId, entry.payload?.sessionId]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  )
}

function isLegacyEntry(entry: FleetEntry): boolean {
  return !entry.agentId || entry.agentId === 'subagent' || entry.agentId === entry.label
}

function entriesReferToSameAgent(left: FleetEntry, right: FleetEntry): boolean {
  const rightIds = entryIds(right)
  if ([...entryIds(left)].some((id) => rightIds.has(id))) return true
  return isLegacyEntry(left) && isLegacyEntry(right) && left.label === right.label
}

function findFleetEntry(fleet: FleetEntry[], entry: FleetEntry): FleetEntry | undefined {
  const exact = fleet.find((candidate) => entriesReferToSameAgent(candidate, entry) && (!isLegacyEntry(candidate) || !isLegacyEntry(entry)))
  if (exact || !isLegacyEntry(entry)) return exact
  const named = fleet.filter((candidate) => isLegacyEntry(candidate) && candidate.label === entry.label)
  return named.length === 1 ? named[0] : undefined
}

function sameFleetEntry(left: FleetEntry, right: FleetEntry): boolean {
  return left.label === right.label
    && left.text === right.text
    && left.parentText === right.parentText
    && left.childText === right.childText
    && left.status === right.status
    && left.depth === right.depth
    && JSON.stringify(left.payload ?? {}) === JSON.stringify(right.payload ?? {})
}

function summarizeEvent(payload: Record<string, unknown>): string {
  const message = payload.message ?? payload.text ?? payload.summary ?? payload.result ?? payload.status
  if (typeof message === 'string') return message
  const name = payload.name ?? payload.agentName ?? payload.taskName ?? payload.sessionName
  return typeof name === 'string' ? name : String(payload.type ?? 'Subagent activity')
}
