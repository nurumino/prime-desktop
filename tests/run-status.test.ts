import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { updateAgentActivity } from '../src/renderer/src/lib/agentThread'
import { RunStatus } from '../src/renderer/src/views/ChatView'
import Composer from '../src/renderer/src/components/Composer'
import HarnessTray from '../src/renderer/src/components/HarnessTray'

it('keeps session controls together above the message card', () => {
  const markup = renderToStaticMarkup(createElement(Composer, {
    busy: true, commands: [], showContext: false,
    onSend() {}, onSlash() {}, onAbort() {}, onBash() {},
    header: createElement(HarnessTray, {
      agentId: 'test', busy: true, contextPercent: 94,
      status: createElement(RunStatus, {
        active: true, activity: null, toolNames: [], compacting: false, startedAt: null
      })
    })
  }))
  const card = markup.indexOf('class="composer-card')
  expect(card).toBeGreaterThan(0)
  const header = markup.slice(0, card)
  expect(header).toContain('class="harness-controls"')
  expect(header).toContain('waiting for status')
  expect(header).toContain('Context window 94% used')
  expect(markup.slice(card)).not.toContain('class="run-status"')
})

it('tracks work events without counting queued messages as progress', () => {
  const waiting = updateAgentActivity(null, 'turn_start', {}, 1000)
  expect(waiting).toEqual({ phase: 'waiting', updatedAt: 1000 })
  const reasoning = updateAgentActivity(waiting, 'message_update', {
    assistantMessageEvent: { type: 'thinking_delta' }
  }, 2000)
  expect(reasoning?.phase).toBe('reasoning')
  expect(updateAgentActivity(reasoning, 'session_action_update', { actions: { queuedCount: 12 } }, 3000)).toBe(reasoning)
  const tools = updateAgentActivity(reasoning, 'message_update', {
    assistantMessageEvent: { type: 'toolcall_delta' }
  }, 4000)
  expect(tools?.phase).toBe('tools')
  const toolUpdate = updateAgentActivity(tools, 'tool_execution_update', {}, 5000)
  expect(toolUpdate?.updatedAt).toBe(5000)
  const next = updateAgentActivity(toolUpdate, 'tool_execution_end', {}, 6000)
  expect(next?.phase).toBe('waiting')
  expect(updateAgentActivity(next, 'agent_end', {}, 7000)).toBeNull()
  expect(updateAgentActivity(next, 'session_started', {}, 7000)).toBeNull()
})

it('keeps quiet runs visible and distinguishes tools, retries, and compaction', () => {
  const now = 100_000
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  try {
    const props = {
      active: true, activity: { phase: 'waiting' as const, updatedAt: now - 60_000 },
      toolNames: [], compacting: false, startedAt: now - 90_000
    }
    const render = (overrides = {}) => renderToStaticMarkup(createElement(RunStatus, { ...props, ...overrides }))
    expect(render()).toContain('Waiting for model')
    expect(render()).toContain('No update for 1m 0s')
    expect(render({ activity: null })).toContain('waiting for status')
    expect(render({ toolNames: ['bash', 'ipython', 'read'] })).toContain('Running bash, ipython +1')
    expect(render({ compacting: true, toolNames: ['bash'] })).toContain('Compacting context')
    expect(render({ retry: { attempt: 2, maxAttempts: 3 } })).toContain('Retrying model request · 2 of 3')
    expect(render({ activity: { phase: 'writing', updatedAt: now } })).toContain('Receiving response')
    expect(render({ activity: { phase: 'writing', updatedAt: now } })).not.toContain('No update')
    expect(render({ active: false })).toBe('')
  } finally {
    clock.mockRestore()
  }
})
