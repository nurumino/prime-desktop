import { useCallback, useEffect, useRef, useState } from 'react'
import { isInternalStateRestoreMessage } from '@shared/messageVisibility'
import { mergeMessage as merge, finishToolExecs, patchToolExecs, type RenderMessage, type ToolExecState } from './store'

export interface AgentThread {
  messages: RenderMessage[]
  toolExecs: Record<string, ToolExecState>
  awaitingResponse: boolean
  pendingStartedAt: number | null
  workStartedAt: Record<string, number>
  workedDurations: Record<string, number>
  compacting: boolean
  activity: AgentActivity | null
}

export interface AgentActivity {
  phase: 'waiting' | 'reasoning' | 'writing' | 'tools'
  updatedAt: number
}

export function updateAgentActivity(
  previous: AgentActivity | null,
  type: string,
  payload: Record<string, unknown>,
  now = Date.now()
): AgentActivity | null {
  if (['agent_end', 'session_started', 'session_replaced', 'session_resumed'].includes(type)) return null
  if (type === 'message_update') {
    const event = payload.assistantMessageEvent as { type?: string } | undefined
    if (event?.type?.startsWith('thinking_')) return { phase: 'reasoning', updatedAt: now }
    if (event?.type?.startsWith('text_')) return { phase: 'writing', updatedAt: now }
    if (event?.type?.startsWith('toolcall_')) return { phase: 'tools', updatedAt: now }
    return previous
  }
  if (type === 'message_start' || type === 'message_end') {
    const message = payload.message as { role?: string } | undefined
    if (message?.role !== 'assistant' && message?.role !== 'toolResult') return previous
  } else if (![
    'agent_start', 'turn_start', 'turn_end', 'tool_execution_start', 'tool_execution_update',
    'tool_execution_end', 'compaction_start', 'compaction_end', 'auto_retry_start', 'auto_retry_end'
  ].includes(type)) return previous
  return { phase: 'waiting', updatedAt: now }
}

function renderMessages(items: unknown[]): RenderMessage[] {
  return (items as Record<string, unknown>[])
    .filter((item) => !isInternalStateRestoreMessage(item) && !item.isError)
    .reduce((acc, item) => merge(acc, item), [] as RenderMessage[])
}

function eventMessageId(message: Record<string, unknown>): string {
  return String(message.id ?? `m-${String(message.timestamp ?? '')}-${String(message.role ?? '')}`)
}

function toolEventId(payload: Record<string, unknown>): string {
  const nested = payload.toolCall
  if (nested && typeof nested === 'object' && 'id' in nested) return String((nested as { id?: unknown }).id ?? '')
  return String(payload.toolCallId ?? payload.id ?? '')
}

function workDurationStorageKey(agentId: string): string {
  return `prime.work-durations.v1.${agentId}`
}

function loadWorkedDurations(agentId: string): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(workDurationStorageKey(agentId))
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => (
        typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0
      ))
    )
  } catch {
    return {}
  }
}

function saveWorkedDuration(agentId: string, messageId: string, durationMs: number): void {
  try {
    const durations = loadWorkedDurations(agentId)
    durations[messageId] = durationMs
    const recent = Object.fromEntries(Object.entries(durations).slice(-250))
    window.localStorage.setItem(workDurationStorageKey(agentId), JSON.stringify(recent))
  } catch {
    // Timing persistence must not interrupt chat rendering.
  }
}

function firstAssistantAfterLastUser(messages: RenderMessage[]): RenderMessage | undefined {
  const lastUserIndex = messages.reduce((last, message, index) => message.role === 'user' ? index : last, -1)
  return messages.slice(lastUserIndex + 1).find((message) => message.role === 'assistant')
}

// Single subscription point for one agent's transcript. Both App.tsx and
// ChatView used to reduce the same event stream independently; every streaming
// delta was processed and rendered twice.
export function useAgentThread(agentId: string, busy: boolean): AgentThread & ThreadControls {
  const [messages, setMessages] = useState<RenderMessage[]>([])
  const [toolExecs, setToolExecs] = useState<Record<string, ToolExecState>>({})
  const [awaitingResponse, setAwaitingResponse] = useState(false)
  const [pendingStartedAt, setPendingStartedAt] = useState<number | null>(null)
  const [workStartedAt, setWorkStartedAt] = useState<Record<string, number>>({})
  const [workedDurations, setWorkedDurations] = useState<Record<string, number>>({})
  const [compacting, setCompacting] = useState(false)
  const [activity, setActivity] = useState<AgentActivity | null>(null)
  const turnStartedAtRef = useRef<number | null>(null)
  const timedMessageIdRef = useRef<string | null>(null)
  const outcomeSeenAtRef = useRef(0)
  const pendingToolUpdatesRef = useRef<Record<string, Record<string, unknown>>>({})
  const toolUpdateTimerRef = useRef<number | null>(null)
  const compactionTimerRef = useRef<number | null>(null)
  const currentAgentRef = useRef(agentId)
  currentAgentRef.current = agentId
  const fetchSeqRef = useRef(0)

  // Transcript fetches can resolve out of order or after the agent changed.
  // Only the newest request for the current agent may replace messages.
  const fetchMessages = useCallback((apply: (items: Parameters<typeof renderMessages>[0]) => void) => {
    const seq = ++fetchSeqRef.current
    const requested = agentId
    void window.prime.agentMessages(agentId)
      .then((items) => {
        if (requested !== currentAgentRef.current || seq !== fetchSeqRef.current) return
        apply(items)
      })
      .catch(() => {})
  }, [agentId])

  const markSent = useCallback((isBusy: boolean) => {
    if (turnStartedAtRef.current == null) {
      const startedAt = Date.now()
      turnStartedAtRef.current = startedAt
      setPendingStartedAt(startedAt)
      setWorkStartedAt({})
      timedMessageIdRef.current = null
    }
    if (!isBusy) {
      setAwaitingResponse(true)
      setActivity({ phase: 'waiting', updatedAt: Date.now() })
    }
  }, [])

  const clearAwaiting = useCallback(() => setAwaitingResponse(false), [])

  const flushToolUpdates = useCallback(() => {
    const pending = pendingToolUpdatesRef.current
    pendingToolUpdatesRef.current = {}
    toolUpdateTimerRef.current = null
    const updates = Object.values(pending)
    if (updates.length === 0) return
    setToolExecs((prev) => updates.reduce<Record<string, ToolExecState>>((next, payload) => patchToolExecs(next, 'update', payload), prev))
    setActivity((prev) => updateAgentActivity(prev, 'tool_execution_update', {}))
  }, [])

  const pushSystemNote = useCallback((text: string) => {
    setMessages((prev) => [...prev, { id: `cmd-${Date.now()}`, role: 'system', content: text }])
  }, [])

  const reload = useCallback(() => {
    fetchMessages((msgs) => setMessages(renderMessages(msgs)))
  }, [fetchMessages])

  const finishTurn = useCallback(() => {
    const startedAt = turnStartedAtRef.current
    const timedMessageId = timedMessageIdRef.current
    setAwaitingResponse(false)
    setActivity(null)
    setPendingStartedAt(null)
    setWorkStartedAt({})
    setToolExecs((prev) => finishToolExecs(prev))
    setMessages((prev) => {
      const next = prev.map((m) => (m.streaming ? { ...m, streaming: false } : m))
      if (startedAt == null) return next

      const assistant = (timedMessageId
        ? next.find((item) => item.id === timedMessageId)
        : undefined) ?? firstAssistantAfterLastUser(next)
      if (!assistant) return next

      const durationMs = Math.max(0, Date.now() - startedAt)
      saveWorkedDuration(agentId, assistant.id, durationMs)
      setWorkedDurations((durations) => ({
        ...durations,
        [assistant.id]: durationMs
      }))
      return next
    })
    turnStartedAtRef.current = null
    timedMessageIdRef.current = null
  }, [agentId])

  useEffect(() => {
    setMessages([])
    setToolExecs({})
    setAwaitingResponse(false)
    setPendingStartedAt(null)
    setWorkStartedAt({})
    setWorkedDurations(loadWorkedDurations(agentId))
    setActivity(null)
    setCompacting(false)
    turnStartedAtRef.current = null
    timedMessageIdRef.current = null
    fetchMessages((msgs) => setMessages(renderMessages(msgs)))
  }, [agentId, fetchMessages])

  useEffect(() => {
    const attachWorkTimer = (message: Record<string, unknown>) => {
      if (message.role !== 'assistant' || turnStartedAtRef.current == null || timedMessageIdRef.current != null) return
      const id = eventMessageId(message)
      timedMessageIdRef.current = id
      setWorkStartedAt((current) => ({ ...current, [id]: turnStartedAtRef.current as number }))
    }

    const off = window.prime.onEvent((raw) => {
      const e = raw as { agentId?: string; type?: string; payload?: Record<string, unknown> }
      if (e.agentId !== agentId) return
      const p = e.payload ?? {}
      // Tool output is already batched below. Queue polls are not work updates.
      if (e.type !== 'tool_execution_update') {
        setActivity((prev) => updateAgentActivity(prev, e.type ?? '', p))
      }
      switch (e.type) {
        case 'turn_start': {
          if (turnStartedAtRef.current == null) {
            const startedAt = Date.now()
            turnStartedAtRef.current = startedAt
            setPendingStartedAt(startedAt)
            setWorkStartedAt({})
          }
          break
        }
        case 'message_update': {
          const msg = p.message as Record<string, unknown> | undefined
          if (!msg) return
          if (msg.isError || (p.assistantMessageEvent as Record<string, unknown> | undefined)?.type === 'error') {
            setAwaitingResponse(false)
            setPendingStartedAt(null)
            turnStartedAtRef.current = null
            timedMessageIdRef.current = null
            setMessages((prev) => prev.filter((message) => message.id !== msg.id))
            break
          }
          if (isInternalStateRestoreMessage(msg)) {
            setMessages((prev) => prev.filter((message) => message.id !== msg.id))
            break
          }
          const ev = p.assistantMessageEvent as Record<string, unknown> | undefined
          if (ev?.type === 'text_delta' || ev?.type === 'thinking_delta' || ev?.type === 'toolcall_delta') {
            setAwaitingResponse(false)
          }
          setMessages((prev) => {
            const next = merge(prev, msg)
            const idx = next.findIndex((m) => m.id === eventMessageId(msg))
            if (idx >= 0) {
              next[idx] = {
                ...next[idx],
                streaming: ev?.type === 'text_delta' || ev?.type === 'thinking_delta' || ev?.type === 'toolcall_delta'
              }
            }
            return next
          })
          attachWorkTimer(msg)
          break
        }
        case 'message_start':
        case 'message_end': {
          const msg = p.message as Record<string, unknown> | undefined
          if (e.type === 'message_end' && msg?.role === 'assistant') setAwaitingResponse(false)
          if (msg?.isError) {
            setMessages((prev) => prev.filter((message) => message.id !== msg.id))
          } else if (msg && isInternalStateRestoreMessage(msg)) {
            setMessages((prev) => prev.filter((message) => message.id !== msg.id))
          } else if (msg) {
            setMessages((prev) => merge(prev, msg))
          }
          if (msg) attachWorkTimer(msg)
          if (e.type === 'message_end' && msg?.role === 'toolResult') {
            setToolExecs((prev) => patchToolExecs(prev, 'end', msg))
          }
          break
        }
        case 'custom_message': {
          if (p.display === false) break
          if (isInternalStateRestoreMessage(p)) break
          if (p.customType === 'refinement_outcome') {
            setMessages((prev) => merge(prev, { ...p, role: 'assistant' }))
          } else if (p.customType === 'agent_message') {
            setAwaitingResponse(false)
            setMessages((prev) => merge(prev, { ...p, role: 'assistant' }))
            attachWorkTimer({ ...p, role: 'assistant' })
          } else if (p.customType === 'compaction_outcome') {
            setCompacting(false)
            outcomeSeenAtRef.current = Date.now()
            setMessages((prev) => merge(prev, {
              id: `sys-compaction_outcome-${String(p.timestamp ?? Date.now())}`,
              role: 'system',
              content: String(p.content ?? '')
            }))
          } else if (
            p.customType === 'rlm_child_failure' ||
            p.customType === 'rlm_child_terminal_notice' ||
            p.customType === 'mcp_connection_outcome' ||
            p.customType === 'session_slash_command' ||
            p.customType === 'session_slash_command_result'
          ) {
            setMessages((prev) => merge(prev, {
              ...p,
              id: `sys-${String(p.customType)}-${String(p.timestamp ?? Date.now())}`,
              role: 'system',
              content: String(p.content ?? '')
            }))
          }
          break
        }
        case 'session_resumed':
        case 'session_replaced': {
          fetchMessages((items) => setMessages(renderMessages(items)))
          break
        }
        case 'session_resynced': {
          // A compaction resync can return only the current context window.
          // Keep older rendered messages so a long-running task does not make
          // the user's prompt disappear from the chat.
          fetchMessages((items) => {
            const snapshot = renderMessages(items)
            setMessages((prev) => snapshot.reduce((next, message) => merge(next, message as unknown as Record<string, unknown>), prev))
          })
          break
        }
        case 'session_started': {
          setMessages([])
          setToolExecs({})
          setAwaitingResponse(false)
          setPendingStartedAt(null)
          setWorkStartedAt({})
          turnStartedAtRef.current = null
          timedMessageIdRef.current = null
          setCompacting(false)
          break
        }
        case 'compaction_start': {
          setCompacting(true)
          break
        }
        case 'compaction_end': {
          setCompacting(false)
          // Auto-compaction has no outcome message; add the summary card unless
          // an explicit compaction_outcome just landed.
          if (compactionTimerRef.current != null) window.clearTimeout(compactionTimerRef.current)
          compactionTimerRef.current = window.setTimeout(() => {
            compactionTimerRef.current = null
            if (Date.now() - outcomeSeenAtRef.current < 4000) return
            setMessages((prev) => prev.some((m) => m.id.startsWith('sys-compaction_outcome') && Date.now() - Number(m.id.split('-').pop()) < 8000)
              ? prev
              : [...prev, { id: `sys-compaction_outcome-auto-${Date.now()}`, role: 'system' as const, content: 'Context automatically compacted' }])
          }, 1200)
          break
        }
        case 'turn_end': {
          setAwaitingResponse(false)
          const msg = p.message as Record<string, unknown> | undefined
          const results = p.toolResults as Record<string, unknown>[] | undefined
          if (msg) attachWorkTimer(msg)
          setMessages((prev) => {
            let next = prev
            if (msg && !msg.isError && !isInternalStateRestoreMessage(msg)) next = merge(next, msg)
            if (results) {
              for (const r of results) {
                next = merge(next, {
                  id: `tr-${r.toolCallId}`,
                  role: 'toolResult',
                  toolCallId: r.toolCallId,
                  content: r.content,
                  details: r.details,
                  isError: r.isError
                })
              }
            }
            return next.map((m) => ({ ...m, streaming: false }))
          })
          setToolExecs((prev) => finishToolExecs(prev, results))
          break
        }
        case 'agent_end': {
          finishTurn()
          break
        }
        case 'tool_execution_start': {
          setToolExecs((prev) => patchToolExecs(prev, 'start', p))
          break
        }
        case 'tool_execution_update': {
          const id = toolEventId(p)
          if (id) {
            pendingToolUpdatesRef.current[id] = p
            if (toolUpdateTimerRef.current == null) {
              toolUpdateTimerRef.current = window.setTimeout(flushToolUpdates, 100)
            }
          }
          break
        }
        case 'tool_execution_end': {
          const id = toolEventId(p)
          if (id) delete pendingToolUpdatesRef.current[id]
          setToolExecs((prev) => patchToolExecs(prev, 'end', p))
          break
        }
      }
    })
    return () => {
      off()
      if (toolUpdateTimerRef.current != null) window.clearTimeout(toolUpdateTimerRef.current)
      if (compactionTimerRef.current != null) window.clearTimeout(compactionTimerRef.current)
      toolUpdateTimerRef.current = null
      compactionTimerRef.current = null
      pendingToolUpdatesRef.current = {}
    }
  }, [agentId, fetchMessages, finishTurn, flushToolUpdates])

  useEffect(() => {
    if (busy) {
      // The chat can mount while the daemon is already running a turn. There
      // is no local markSent event in that case, but the UI still needs a
      // visible working timer.
      if (turnStartedAtRef.current == null) {
        const startedAt = Date.now()
        turnStartedAtRef.current = startedAt
        setPendingStartedAt((current) => current ?? startedAt)
      }
      return
    }
    finishTurn()
  }, [busy, finishTurn])

  return { messages, toolExecs, awaitingResponse, pendingStartedAt, workStartedAt, workedDurations, compacting, activity, markSent, clearAwaiting, pushSystemNote, reload }
}

export interface ThreadControls {
  markSent: (isBusy: boolean) => void
  clearAwaiting: () => void
  pushSystemNote: (text: string) => void
  reload: () => void
}
