import { describe, expect, it } from 'vitest'
import { isInternalStateRestoreMessage, stripInternalRunNotices } from '../src/shared/messageVisibility'

describe('message visibility', () => {
  it('honors hidden custom notices across loaded and live messages', () => {
    for (const customType of ['refinement_notice', 'ipython_state', 'extension-context']) {
      expect(isInternalStateRestoreMessage({ role: 'custom', customType, display: false, content: 'Internal context' })).toBe(true)
    }
    expect(isInternalStateRestoreMessage({ role: 'custom', customType: 'refinement_outcome', display: true, content: 'Refinement complete: Saved' })).toBe(false)
    expect(isInternalStateRestoreMessage({ role: 'user', content: 'Explain <harness_state> and [self-refinement].' })).toBe(false)
    expect(isInternalStateRestoreMessage({ role: 'toolResult', content: '<harness_state>example</harness_state>' })).toBe(false)
  })
  it('hides Prime Agent harness digests', () => {
    expect(isInternalStateRestoreMessage({ customType: 'harness_digest', content: 'private context' })).toBe(true)
    expect(isInternalStateRestoreMessage({ role: 'custom', content: '[harness-digest]\n<harness_state>private</harness_state>' })).toBe(true)
    expect(isInternalStateRestoreMessage({ role: 'assistant', content: 'Hi there' })).toBe(false)
  })
})

describe('internal run notices', () => {
  it('removes kernel and background shell notices from displayed assistant text', () => {
    const text = 'I will write the document.\n\n[python-state]\nYour Python kernel persisted through compaction; its remaining variables are still available. These names are still defined: x, y.\n\n[bash-done pid:76492 exit:0]\nCommand: "cd /tmp && curl example.org"\n\nThe document is ready.'
    expect(stripInternalRunNotices(text)).toBe('I will write the document.\n\nThe document is ready.')
    expect(stripInternalRunNotices('The run failed.')).toBe('The run failed.')
  })
})
