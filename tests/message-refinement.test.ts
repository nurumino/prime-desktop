import { expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import MessageItem, { parseAutoRefinementText, parseRefinementMemories } from '../src/renderer/src/components/MessageItem'
import { normalizeBlocks } from '../src/renderer/src/lib/store'

it('turns an auto-refinement notice into a summary and memory list', () => {
  const parsed = parseAutoRefinementText('Refinement complete: Save EGFR project rules.\n\n[auto-refinement]\nSaved knowledge. - create memory [local:egfr-rules] Rule one. - create memory [local:egfr-tools] Tool two.')
  expect(parsed?.summary).toBe('Save EGFR project rules.')
  expect(parseRefinementMemories(parsed?.detail ?? '')).toEqual({
    intro: 'Saved knowledge.',
    memories: [
      { action: 'create', kind: 'memory', name: 'egfr-rules', scope: 'local', text: 'Rule one.' },
      { action: 'create', kind: 'memory', name: 'egfr-tools', scope: 'local', text: 'Tool two.' }
    ]
  })
  expect(parseAutoRefinementText('The marker [auto-refinement] is in a quoted document.')).toBeNull()
})

it('collapses self and manual refinements with updates and deletions', () => {
  for (const source of ['self', 'user']) {
    const text = `[${source}-refinement]\n\nUpdate EGFR continuation. - update memory [local:egfr-current] Failed folds recorded. - delete prompt [global:old-rule] Obsolete.`
    const parsed = parseAutoRefinementText(text)!
    expect(parsed.summary).toBe('Update EGFR continuation.')
    expect(parseRefinementMemories(parsed.detail).memories.map((entry) => entry.action)).toEqual(['update', 'delete'])
    const html = renderToStaticMarkup(createElement(MessageItem, { message: normalizeBlocks({ role: 'assistant', content: text }), toolExecs: {} }))
    expect(html).toContain('<details class="refinement-message-card">')
    expect(html).not.toContain(`<details open`)
    expect(html).not.toContain(`[${source}-refinement]`)
  }
  expect(parseAutoRefinementText('The marker [self-refinement] is quoted.')).toBeNull()
})

it('renders the visible structured outcome once with only applied edits', () => {
  const message = normalizeBlocks({ role: 'custom', customType: 'refinement_outcome', content: 'Refinement complete: Save project rules.', details: { edits: [
    { applied: true, action: 'update', kind: 'memory', id: 'rules', after: { title: 'Project rules', content: 'Use the current run.' } },
    { applied: false, action: 'create', kind: 'skill', id: 'rejected', after: { content: 'Rejected change' } }
  ] } })
  const html = renderToStaticMarkup(createElement(MessageItem, { message, toolExecs: {} }))
  expect(html.match(/<details class="refinement-message-card">/g)).toHaveLength(1)
  expect(html).toContain('Use the current run.')
  expect(html).not.toContain('Rejected change')
})

it('shows subagent failures and exits without internal headers', () => {
  const failed = normalizeBlocks({ role: 'custom', customType: 'rlm_child_failure', content: '[child-failed child:fold]\n\nConnection lost', details: { sessionName: 'Fold', error: 'Connection lost' } })
  expect(failed.role).toBe('system')
  expect(failed.content).toBe('Fold failed: Connection lost')
  const exited = normalizeBlocks({ role: 'custom', customType: 'rlm_child_terminal_notice', details: { sessionName: 'Fold', kind: 'cancelled', reason: 'Stopped by user' } })
  expect(exited.content).toBe('Fold was cancelled: Stopped by user')
})
