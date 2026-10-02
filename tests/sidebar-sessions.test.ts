import { expect, it } from 'vitest'
import type { AgentInfo } from '../src/shared/types'
import { sessionsWithLiveChat } from '../src/renderer/src/components/Sidebar'

it('shows a new live chat before its first reply is saved, without duplicate or blank rows', () => {
  const agent = { sessionId: 'new', sessionName: null, path: '/project' } as AgentInfo
  const saved = [{ sessionId: 'old', sessionFile: '/sessions/old.jsonl', name: 'Old chat', messageCount: 2, workingDirectory: '/project', mtime: 1 }]
  expect(sessionsWithLiveChat(saved, agent, [])).toBe(saved)
  const rows = sessionsWithLiveChat(saved, agent, [{ role: 'user', content: [{ type: 'text', text: 'Design\na protein' }], timestamp: 20 }])
  expect(rows.map((row) => row.sessionId)).toEqual(['new', 'old'])
  expect(rows[0]).toMatchObject({ name: 'Design a protein', sessionFile: '', mtime: 20, messageCount: 1 })
  const persisted = [{ ...rows[0], sessionFile: '/sessions/new.jsonl' }, ...saved]
  expect(sessionsWithLiveChat(persisted, agent, [{ role: 'user', content: 'Follow-up' }])).toBe(persisted)
  expect(sessionsWithLiveChat(saved, { ...agent, sessionId: null }, [{ role: 'user', content: 'Old message' }])).toBe(saved)
})
