import { describe, expect, it, vi } from 'vitest'
import { AgentManager, lastPromptAt } from '../src/main/agentManager'

describe('AgentManager session changes', () => {
  it('holds a prompt until a new session is active', async () => {
    let finishNewSession!: () => void
    const newSessionPending = new Promise<void>((resolve) => { finishNewSession = resolve })
    const calls: string[] = []
    const client = {
      running: true,
      send: vi.fn(async (command: { type: string }) => {
        calls.push(command.type)
        if (command.type === 'new_session') await newSessionPending
        if (command.type === 'get_state') return { sessionId: 'new-session', isStreaming: false }
        return {}
      })
    }
    const manager = new AgentManager({} as never)
    const agent = {
      id: 'agent-test',
      tabId: 'test',
      path: '/tmp',
      client,
      info: {
        id: 'agent-test', name: 'test', path: '/tmp', status: 'idle', model: null,
        thinkingLevel: null, messageCount: 0, cost: 0, tokensIn: 0, tokensOut: 0,
        contextPercent: null, contextTokens: null, contextWindow: null, isStreaming: false,
        sessionName: null, sessionId: 'old-session', retry: null
      },
      messages: [], dialogs: new Map(), checkpoints: [], starts: 1,
      queued: { steer: [], followUps: [] }, skills: [], availableModels: [], commands: [],
      stats: null, lastEvent: '', pendingRuntimeReload: false, pendingModelSwitch: null,
      connecting: null, sessionChange: Promise.resolve()
    }
    ;(manager as unknown as { agents: Map<string, typeof agent> }).agents.set(agent.id, agent)

    const newChat = manager.runCommand(agent.id, { type: 'new_session' }, {} as never)
    const prompt = manager.runCommand(agent.id, { type: 'prompt', message: 'hello' }, {} as never)
    await vi.waitFor(() => expect(calls).toEqual(['new_session']))
    expect(calls).toEqual(['new_session'])

    finishNewSession()
    await Promise.all([newChat, prompt])
    expect(calls).toEqual(['new_session', 'get_state', 'prompt'])
    expect(agent.info.sessionId).toBe('new-session')
  })

  it('only checkpoints prompts that start a new run', async () => {
    const client = { running: true, send: vi.fn(async () => ({})) }
    const manager = new AgentManager({} as never)
    const agent = {
      id: 'agent-cp',
      tabId: 'cp',
      path: '/tmp',
      client,
      info: {
        id: 'agent-cp', name: 'cp', path: '/tmp', status: 'idle', model: null,
        thinkingLevel: null, messageCount: 0, cost: 0, tokensIn: 0, tokensOut: 0,
        contextPercent: null, contextTokens: null, contextWindow: null, isStreaming: false,
        sessionName: null, sessionId: 's', retry: null
      },
      messages: [], dialogs: new Map(), checkpoints: [], starts: 1,
      queued: { steer: [], followUps: [] }, skills: [], availableModels: [], commands: [],
      stats: null, lastEvent: '', pendingRuntimeReload: false, pendingModelSwitch: null,
      connecting: null, sessionChange: Promise.resolve()
    }
    ;(manager as unknown as { agents: Map<string, typeof agent> }).agents.set(agent.id, agent)
    const checkpoint = vi.spyOn(manager, 'createCheckpoint').mockResolvedValue(null)
    const settings = { checkpoints: true } as never

    await manager.runCommand(agent.id, { type: 'prompt', message: 'start' }, settings)
    expect(checkpoint).toHaveBeenCalledTimes(1)

    await manager.runCommand(agent.id, { type: 'prompt', message: 'nudge', streamingBehavior: 'steer' }, settings)
    expect(checkpoint).toHaveBeenCalledTimes(1)

    agent.info.isStreaming = true
    agent.info.status = 'working'
    await manager.runCommand(agent.id, { type: 'prompt', message: 'later', streamingBehavior: 'followUp' }, settings)
    expect(checkpoint).toHaveBeenCalledTimes(1)
  })
})

it('orders chats by the last prompt sent, not by later bookkeeping records', () => {
  const records = [
    { type: 'session', timestamp: '2026-09-30T10:00:00.000Z' },
    { type: 'message', timestamp: '2026-09-30T10:01:00.000Z', message: { role: 'user', timestamp: 1000 } },
    { type: 'message', timestamp: '2026-09-30T10:02:00.000Z', message: { role: 'assistant', timestamp: 2000 } },
    { type: 'message', timestamp: '2026-09-30T10:03:00.000Z', message: { role: 'user', timestamp: 3000 } },
    // Opening the chat later appends these; they must not count as activity.
    { type: 'model_change', timestamp: '2026-10-02T09:00:00.000Z' },
    { type: 'session_state', timestamp: '2026-10-02T09:00:00.000Z' }
  ]
  expect(lastPromptAt(records)).toBe(3000)
  expect(lastPromptAt([{ type: 'message', timestamp: '2026-09-30T10:01:00.000Z', message: { role: 'user' } }])).toBe(Date.parse('2026-09-30T10:01:00.000Z'))
  expect(lastPromptAt([{ type: 'session' }])).toBeNull()
})
