import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { AgentManager } from '../src/main/agentManager'

type FakeAgent = ReturnType<typeof fakeAgent>

function fakeAgent(id: string, tabId: string, sessionId: string, busy = false) {
  const calls: string[] = []
  return {
    id,
    tabId,
    path: '/tmp',
    calls,
    client: {
      running: true,
      release: vi.fn(async () => {}),
      send: vi.fn(async (command: { type: string }) => {
        calls.push(command.type)
        if (command.type === 'get_state') return { sessionId: `${id}-fresh`, isStreaming: false }
        if (command.type === 'get_messages') return { messages: [] }
        return {}
      })
    },
    info: {
      id, tabId, name: tabId, path: '/tmp', status: busy ? 'working' : 'idle', model: null,
      thinkingLevel: null, messageCount: 1, cost: 0, tokensIn: 0, tokensOut: 0,
      contextPercent: null, contextTokens: null, contextWindow: null, isStreaming: busy,
      sessionName: null, sessionId, retry: null
    },
    messages: [], dialogs: new Map(), checkpoints: [], starts: 1,
    queued: { steer: [], followUps: [] }, skills: [], availableModels: [], commands: [],
    stats: null, lastEvent: '', pendingRuntimeReload: false, pendingModelSwitch: null,
    connecting: null, sessionChange: Promise.resolve()
  }
}

function managerWith(...agents: FakeAgent[]) {
  const manager = new AgentManager({} as never)
  const map = (manager as unknown as { agents: Map<string, FakeAgent> }).agents
  for (const agent of agents) map.set(agent.id, agent)
  const events: { type: string; agentId: string }[] = []
  manager.on('renderer', ({ payload }: { payload: { type: string; agentId: string } }) => events.push(payload))
  return { manager, map, events }
}

function sessionFile(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'prime-sessions-'))
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'session', id, cwd: '/tmp' })}\n`)
  return file
}

describe('parallel chats in one project', () => {
  it('starts a new chat in its own slot when the current chat is busy', async () => {
    const busy = fakeAgent('agent-p', 'p', 'running', true)
    const { manager, map, events } = managerWith(busy)
    const slot = fakeAgent('agent-p--slot1', 'p', 'blank')
    slot.info.messageCount = 0
    const openSlot = vi.spyOn(manager as never, 'openSlot').mockImplementation(async () => {
      map.set(slot.id, slot)
      return slot as never
    })

    const result = await manager.runCommand(busy.id, { type: 'new_session' }, {} as never)

    expect(openSlot).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ agentId: slot.id })
    expect(busy.calls).not.toContain('new_session')
    expect(events.some((event) => event.type === 'chat_focus' && event.agentId === slot.id)).toBe(true)
  })

  it('replaces the session in place when the current chat is idle', async () => {
    const idle = fakeAgent('agent-p', 'p', 'old')
    const { manager } = managerWith(idle)
    const openSlot = vi.spyOn(manager as never, 'openSlot')

    const result = await manager.runCommand(idle.id, { type: 'new_session' }, {} as never)

    expect(openSlot).not.toHaveBeenCalled()
    expect(result).toEqual({ agentId: idle.id })
    expect(idle.calls).toContain('new_session')
  })

  it('focuses a chat that is already live instead of reloading it', async () => {
    const primary = fakeAgent('agent-p', 'p', 'a', true)
    const other = fakeAgent('agent-p--slot1', 'p', 'b', true)
    const { manager, events } = managerWith(primary, other)

    const target = await manager.openSession(primary.id, sessionFile('b'), {} as never)

    expect(target).toBe(other.id)
    expect(other.calls).not.toContain('switch_session')
    expect(primary.calls).not.toContain('switch_session')
    expect(events.at(-1)).toMatchObject({ type: 'chat_focus', agentId: other.id })
  })

  it('opens a saved chat in a new slot rather than interrupting a running one', async () => {
    const busy = fakeAgent('agent-p', 'p', 'a', true)
    const { manager, map } = managerWith(busy)
    const slot = fakeAgent('agent-p--slot1', 'p', 'fresh')
    vi.spyOn(manager as never, 'openSlot').mockImplementation(async () => {
      map.set(slot.id, slot)
      return slot as never
    })

    const target = await manager.openSession(busy.id, sessionFile('saved'), {} as never)

    expect(target).toBe(slot.id)
    expect(slot.calls).toContain('switch_session')
    expect(busy.calls).not.toContain('switch_session')
  })

  it('releases idle extra slots but never the project chat or running chats', async () => {
    const primary = fakeAgent('agent-p', 'p', 'a')
    const idleExtra = fakeAgent('agent-p--idle', 'p', 'b')
    const runningExtra = fakeAgent('agent-p--busy', 'p', 'c', true)
    const otherProject = fakeAgent('agent-q--idle', 'q', 'd')
    const { manager, map } = managerWith(primary, idleExtra, runningExtra, otherProject)

    await manager.openSession(primary.id, sessionFile('a'), {} as never)

    expect(map.has(primary.id)).toBe(true)
    expect(map.has(runningExtra.id)).toBe(true)
    expect(map.has(otherProject.id)).toBe(true)
    expect(map.has(idleExtra.id)).toBe(false)
    expect(idleExtra.client.release).toHaveBeenCalledTimes(1)
  })
})
