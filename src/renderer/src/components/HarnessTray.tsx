import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ActionQueue, SideQuestionTurn } from '@shared/types'
import type { ModelOption } from '@shared/models'
import MessageItem from './MessageItem'
import WorkingMark from './WorkingMark'
import ConfirmButton from './ConfirmButton'
import Composer from './Composer'
import type { RenderMessage } from '../lib/store'

interface Props {
  agentId: string
  busy: boolean
  models?: ModelOption[]
  currentModel?: string
  onSelectModel?: (model: string) => void
  commands?: { name: string; description?: string }[]
  effortLevel?: string
  onSelectEffort?: (effort: string) => void
  rlmMaxDepth?: number
  onDepthChange?: (depth: number) => void
  onSlash?: (text: string) => void
  onBash?: (command: string) => void
  showReasoning?: boolean
  onToast?: (text: string, kind?: 'info' | 'success' | 'warning' | 'error') => void
  contextPercent?: number | null
  status?: ReactNode
}

interface SideRun {
  id: string
  question: string
  answer: string
  status: 'running' | 'complete' | 'cancelled' | 'error'
  errorMessage?: string
}

const EMPTY_QUEUE: ActionQueue = { steering: [], followUp: [] }

export default function HarnessTray({
  agentId,
  busy,
  models = [],
  currentModel,
  onSelectModel,
  commands = [],
  effortLevel,
  onSelectEffort,
  rlmMaxDepth,
  onDepthChange,
  onSlash,
  onBash,
  showReasoning = true,
  onToast,
  contextPercent = null,
  status
}: Props): JSX.Element {
  const [queue, setQueue] = useState<ActionQueue>(EMPTY_QUEUE)
  const [queueCollapsed, setQueueCollapsed] = useState(false)
  const [sideHost, setSideHost] = useState<HTMLElement | null>(null)
  const [turns, setTurns] = useState<SideQuestionTurn[]>([])
  const [sideRun, setSideRun] = useState<SideRun | null>(null)

  const loadQueue = useCallback(() => {
    void window.prime.agentHarness(agentId, 'queue')
      .then((result) => setQueue(result as ActionQueue))
      .catch(() => {})
  }, [agentId])

  useEffect(() => {
    const attach = () => setSideHost(document.getElementById('side-thread-panel-slot'))
    attach()
    const observer = new MutationObserver(attach)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  // Reset per-agent state only when the agent changes. This used to share an
  // effect with the busy-dependent poll, which wiped the side chat whenever
  // the main agent started or finished a run.
  useEffect(() => {
    setQueue(EMPTY_QUEUE)
    setTurns([])
    setSideRun(null)
  }, [agentId])

  useEffect(() => {
    loadQueue()
    const timer = window.setInterval(loadQueue, busy ? 1200 : 4000)
    return () => window.clearInterval(timer)
  }, [busy, loadQueue])

  useEffect(() => {
    const off = window.prime.onEvent((raw) => {
      const message = raw as { agentId?: string; type?: string; payload?: Record<string, unknown> }
      if (message.agentId !== agentId) return
      if (message.type === 'session_action_update') {
        const actions = message.payload?.actions as { steering?: string[]; followUps?: string[] } | undefined
        setQueue((current) => ({
          ...current,
          steering: actions?.steering ?? [],
          followUp: actions?.followUps ?? []
        }))
      }
      if (message.type === 'side_question_event') {
        const event = (message.payload?.event ?? message.payload) as Record<string, unknown>
        setSideRun({
          id: String(event.id ?? ''),
          question: String(event.question ?? ''),
          answer: String(event.answer ?? ''),
          status: String(event.status ?? 'running') as SideRun['status'],
          errorMessage: typeof event.errorMessage === 'string' ? event.errorMessage : undefined
        })
      }
    })
    return off
  }, [agentId])

  useEffect(() => {
    if (sideRun?.status !== 'complete') return
    setTurns((current) => {
      const next = { question: sideRun.question, answer: sideRun.answer }
      const prior = current[current.length - 1]
      return prior?.question === next.question && prior.answer === next.answer ? current : [...current, next]
    })
  }, [sideRun])

  const mutate = async (
    targetLane: 'steering' | 'followUp',
    index: number,
    expectedText: string,
    mutation: Record<string, unknown>
  ) => {
    try {
      const result = await window.prime.agentHarness(agentId, 'queue_mutate', {
        lane: targetLane,
        index,
        expectedText,
        mutation
      }) as ActionQueue & { status?: string }
      setQueue(result)
      if (result.status && result.status !== 'applied') {
        onToast?.(result.status === 'unsupported' ? 'Queue editing requires Prime Agent 0.7.2.' : 'Queue changed elsewhere; refreshed.', 'warning')
      }
    } catch (error) {
      onToast?.(error instanceof Error ? error.message : String(error), 'error')
      loadQueue()
    }
  }

  const queueAction = (action: 'queue_send_now' | 'queue_clear' | 'queue_abort_clear') => {
    void window.prime.agentHarness(agentId, action)
      .then((value) => setQueue(value as ActionQueue))
      .catch((error: Error) => onToast?.(error.message, 'error'))
  }

  const startSide = (questionText: string) => {
    const question = questionText.trim()
    if (!question || sideRun?.status === 'running') return
    const id = `desktop-side-${Date.now()}`
    setSideRun({ id, question, answer: '', status: 'running' })
    void window.prime.agentHarness(agentId, 'side_question_start', { id, question, previousTurns: turns })
      .catch((error: Error) => setSideRun({ id, question, answer: '', status: 'error', errorMessage: error.message }))
  }

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const question = (event as CustomEvent<{ question?: string }>).detail?.question
      if (question) startSide(question)
    }
    window.addEventListener('prime:open-side-chat', handleOpen)
    return () => window.removeEventListener('prime:open-side-chat', handleOpen)
  })

  const count = queue.steering.length + queue.followUp.length
  const showContext = contextPercent != null && contextPercent >= 1
  const contextTone = contextPercent == null ? 'ok' : contextPercent >= 90 ? 'high' : contextPercent >= 70 ? 'warn' : 'ok'
  const sideMessages: RenderMessage[] = turns.flatMap((turn, index) => [
    { id: `side-user-${index}`, role: 'user', content: turn.question },
    { id: `side-assistant-${index}`, role: 'assistant', content: turn.answer }
  ])
  if (sideRun && sideRun.status !== 'complete') {
    sideMessages.push({ id: `side-user-${sideRun.id}`, role: 'user', content: sideRun.question })
    if (sideRun.answer) {
      sideMessages.push({
        id: `side-assistant-${sideRun.id}`,
        role: 'assistant',
        content: sideRun.answer,
        streaming: sideRun.status === 'running'
      })
    }
  }
  return (
    <>
      <div className="harness-tray">
        {count > 0 && (
          <section className="queue-stack" aria-label="Queued messages">
            <header className="queue-stack-head">
              <button type="button" className="disclosure-head" aria-expanded={!queueCollapsed} onClick={() => setQueueCollapsed((value) => !value)}>
                <span className="disclosure-label">Queued</span>
                <span className="disclosure-count">{count} {count === 1 ? 'message' : 'messages'} · {busy ? 'sent at the next turn boundary' : 'sent when the agent is free'}</span>
              </button>
              <div className="queue-stack-actions">
                {queue.sendQueuedSupported && busy && queue.steering.length > 0 && (
                  <button type="button" className="btn ghost small" onClick={() => queueAction('queue_send_now')}>Interrupt & send</button>
                )}
                <ConfirmButton className="btn ghost small" confirmLabel="Clear all?" onConfirm={() => queueAction('queue_clear')}>Clear</ConfirmButton>
                {busy && (
                  <ConfirmButton className="btn ghost small danger" confirmLabel="Stop agent and clear?" onConfirm={() => queueAction('queue_abort_clear')}>Stop & clear</ConfirmButton>
                )}
              </div>
            </header>
            {!queueCollapsed && (
              <ol className="queue-list">
                {queue.steering.map((text, index) => (
                  <QueueItem key={`s-${index}-${text}`} lane="steering" index={index} text={text} total={queue.steering.length} editable={queue.mutationSupported === true} onMutate={mutate} />
                ))}
                {queue.followUp.map((text, index) => (
                  <QueueItem key={`f-${index}-${text}`} lane="followUp" index={index} text={text} total={queue.followUp.length} editable={queue.mutationSupported === true} onMutate={mutate} />
                ))}
              </ol>
            )}
          </section>
        )}

        {(status || showContext) && (
          <div className="harness-controls" aria-label="Session controls">
            {status}
            <div className="harness-pills">
              {showContext && (
                <div
                  className={`context-pill ${contextTone}`}
                  title={`Context window ${Math.round(contextPercent ?? 0)}% used`}
                >
                  <span className="context-pill-meter" aria-hidden="true">
                    <i style={{ width: `${Math.min(100, Math.round(contextPercent ?? 0))}%` }} />
                  </span>
                  <span>{Math.round(contextPercent ?? 0)}%</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {sideHost && createPortal(
        <section className="side-thread-chat">
          <div className="side-thread-turns sp-chat-feed">
            {sideMessages.map((message) => <MessageItem key={message.id} message={message} toolExecs={{}} showReasoning={showReasoning} turnComplete={sideRun?.status !== 'running'} />)}
            {sideRun?.status === 'running' && !sideRun.answer && (
              <div className="assistant-pending" role="status">
                <WorkingMark />
              </div>
            )}
            {sideRun && (sideRun.status === 'error' || sideRun.status === 'cancelled') && (
              <div className="sp-chat-error">{sideRun.errorMessage || sideRun.status}</div>
            )}
            {!sideRun && turns.length === 0 && <div className="sp-empty">Ask a quick question without changing the main conversation.</div>}
          </div>
          <Composer
            busy={sideRun?.status === 'running'}
            commands={commands}
            onSend={(text, images) => {
              if (images.length > 0) {
                onToast?.('Side questions do not support image attachments yet.', 'warning')
              }
              if (text.trim()) startSide(text)
            }}
            onSlash={onSlash ?? startSide}
            onAbort={() => {
              if (sideRun?.status === 'running') {
                void window.prime.agentHarness(agentId, 'side_question_abort', { id: sideRun.id })
              }
            }}
            onBash={onBash ?? ((command) => startSide(`!${command}`))}
            models={models}
            currentModel={currentModel}
            onSelectModel={onSelectModel}
            effortLevel={effortLevel}
            onSelectEffort={onSelectEffort}
            rlmMaxDepth={rlmMaxDepth}
            onDepthChange={onDepthChange}
            showContext={false}
          />
        </section>,
        sideHost
      )}
    </>
  )
}

function QueueItem({
  lane,
  index,
  text,
  total,
  editable,
  onMutate
}: {
  lane: 'steering' | 'followUp'
  index: number
  text: string
  total: number
  editable: boolean
  onMutate: (lane: 'steering' | 'followUp', index: number, expectedText: string, mutation: Record<string, unknown>) => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const other = lane === 'steering' ? 'followUp' : 'steering'

  const save = () => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== text) onMutate(lane, index, text, { type: 'replace', text: next, lane })
    else setDraft(text)
  }

  return (
    <li className={`queue-item ${lane}`}>
      <span className="queue-lane-tag" title={lane === 'steering' ? 'Delivered at the next turn boundary' : 'Sent after the current run finishes'}>
        {lane === 'steering' ? 'Steer' : 'Follow-up'}
      </span>
      {editing ? (
        <textarea
          className="queue-item-edit"
          autoFocus
          rows={Math.min(5, Math.max(1, Math.ceil(draft.length / 70)))}
          value={draft}
          aria-label="Edit queued message"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              save()
            } else if (event.key === 'Escape') {
              setDraft(text)
              setEditing(false)
            }
          }}
        />
      ) : (
        <span className="queue-item-text" title={text}>{text}</span>
      )}
      {editable && !editing && (
        <span className="queue-item-actions">
          <button type="button" title="Edit" aria-label="Edit queued message" onClick={() => { setDraft(text); setEditing(true) }}>
            <QueueIcon d="M4 20h4L19 9l-4-4L4 16v4z" />
          </button>
          <button type="button" title="Move up" aria-label="Move up" disabled={index === 0} onClick={() => onMutate(lane, index, text, { type: 'move', direction: -1 })}>
            <QueueIcon d="M12 19V5M6 11l6-6 6 6" />
          </button>
          <button type="button" title="Move down" aria-label="Move down" disabled={index === total - 1} onClick={() => onMutate(lane, index, text, { type: 'move', direction: 1 })}>
            <QueueIcon d="M12 5v14M6 13l6 6 6-6" />
          </button>
          <button
            type="button"
            title={other === 'steering' ? 'Steer instead (deliver at next turn boundary)' : 'Make a follow-up (send after this run)'}
            aria-label={other === 'steering' ? 'Change to steer' : 'Change to follow-up'}
            onClick={() => onMutate(lane, index, text, { type: 'replace', text, lane: other })}
          >
            <QueueIcon d="M7 7h11l-3-3M17 17H6l3 3" />
          </button>
          <button type="button" title="Remove" aria-label="Remove queued message" onClick={() => onMutate(lane, index, text, { type: 'delete' })}>
            <QueueIcon d="M6 6l12 12M18 6L6 18" />
          </button>
        </span>
      )}
    </li>
  )
}

function QueueIcon({ d }: { d: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}
