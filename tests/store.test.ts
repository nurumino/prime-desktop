import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mergeMessage, patchToolExecs } from '../src/renderer/src/lib/store'
import MessageItem from '../src/renderer/src/components/MessageItem'

describe('renderer event state reducers', () => {
  it('keeps consecutive tool calls and results through stream snapshots', () => {
    const first = { role: 'assistant', timestamp: 100, content: [{ type: 'toolCall', id: 'call-1', name: 'bash' }] }
    let messages = mergeMessage([], first)
    messages = mergeMessage(messages, { role: 'toolResult', timestamp: 101, toolCallId: 'call-1', content: 'first result' })
    const second = { ...first, content: [{ type: 'toolCall', id: 'call-2', name: 'read' }] }
    messages = mergeMessage(messages, second)
    messages = mergeMessage(messages, second)
    messages = mergeMessage(messages, { role: 'assistant', timestamp: 102, content: [{ type: 'toolCall', id: 'call-3', name: 'bash' }] })
    messages = mergeMessage(messages, first)
    const calls = messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block.type === 'toolCall') : [])
    expect(calls.map((call) => call.id)).toEqual(['call-1', 'call-2', 'call-3'])
    expect(calls[0].result).toBe('first result')
  })
  it('merges tool results into the matching tool call', () => {
    const messages = mergeMessage([], {
      id: 'assistant-1',
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tool-1', name: 'bash', status: 'running' }]
    })
    const next = mergeMessage(messages, {
      id: 'result-1',
      role: 'toolResult',
      toolCallId: 'tool-1',
      content: 'done'
    })
    expect(next[0].content).toEqual([
      { type: 'toolCall', id: 'tool-1', name: 'bash', status: 'done', result: 'done', isError: false }
    ])
  })

  it('does not regress a completed tool execution on late updates', () => {
    const started = patchToolExecs({}, 'start', { toolCallId: 'tool-1', toolName: 'bash', args: {} })
    const ended = patchToolExecs(started, 'end', { toolCallId: 'tool-1', toolName: 'bash', result: { content: 'done' } })
    const late = patchToolExecs(ended, 'update', { toolCallId: 'tool-1', partialResult: { content: 'stale' } })
    expect(late['tool-1'].status).toBe('done')
    expect(late['tool-1'].output).toBe('done')
  })

  it('shows every tool without reasoning during a run and keeps output collapsed', () => {
    const messages = mergeMessage([], {
      role: 'assistant', timestamp: 200,
      content: [
        { type: 'thinking', thinking: 'hidden reasoning' },
        { type: 'toolCall', id: 'one', name: 'bash', arguments: { command: 'first-command' }, result: 'hidden output' },
        { type: 'toolCall', id: 'two', name: 'read', arguments: { path: 'second.txt' } },
        { type: 'toolCall', id: 'three', name: 'write', arguments: { path: 'third.txt' } }
      ]
    })
    const html = renderToStaticMarkup(createElement(MessageItem, {
      message: { ...messages[0], streaming: true }, toolExecs: {}, showReasoning: false, turnComplete: false
    }))
    expect(html).toContain('3 tool calls')
    for (const label of ['first-command', 'second.txt', 'third.txt']) expect(html).toContain(label)
    expect(html).not.toContain('hidden reasoning')
    expect(html).not.toContain('hidden output')
    expect(html).toContain('aria-expanded="true"')
  })
  it('streams a tool\'s reasoning and response, open while running and collapsible sections', () => {
    const started = patchToolExecs({}, 'start', { toolCallId: 'gen-1', toolName: 'moremi_generate', args: { task: 'protein' } })
    const streaming = patchToolExecs(started, 'update', {
      toolCallId: 'gen-1',
      partialResult: { content: [{ type: 'text', text: '' }], details: { reasoning: 'considering helices' } }
    })
    expect(streaming['gen-1'].reasoning).toBe('considering helices')
    const message = mergeMessage([], {
      role: 'assistant', timestamp: 1,
      content: [{ type: 'toolCall', id: 'gen-1', name: 'moremi_generate', arguments: { task: 'protein' } }]
    })
    const html = renderToStaticMarkup(createElement(MessageItem, {
      message: { ...message[0], streaming: true }, toolExecs: streaming, turnComplete: false
    }))
    expect(html).toContain('Reasoning')
    expect(html).toContain('considering helices')
    expect(html).toContain('thinking…')

    const ended = patchToolExecs(streaming, 'end', { toolCallId: 'gen-1', result: { content: [{ type: 'text', text: '>seq\nMKV' }] } })
    expect(ended['gen-1'].reasoning).toBe('considering helices')
    const finished = mergeMessage(message, { id: 'tr', role: 'toolResult', toolCallId: 'gen-1', content: [{ type: 'text', text: '>seq\nMKV' }], details: { reasoning: 'considering helices' } })
    const done = renderToStaticMarkup(createElement(MessageItem, { message: finished[0], toolExecs: {}, turnComplete: true }))
    // Finished tools collapse until the user opens them.
    expect(done).not.toContain('considering helices')
  })
})
