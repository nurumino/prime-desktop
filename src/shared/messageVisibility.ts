const IPYTHON_RESTORE_TAG = /<ipython_state_restored(?:\s|>)/i
const HARNESS_DIGEST_TAG = /(?:^|\[)harness-digest\]|<harness_state>/i

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((block) => {
      const record = block as Record<string, unknown>
      if (typeof record.text === 'string') return record.text
      if (typeof record.content === 'string') return record.content
      return ''
    })
    .join('\n')
}

export function isInternalStateRestoreMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const record = message as Record<string, unknown>
  if (record.role === 'user' || record.role === 'toolResult') return false
  if (record.display === false && (record.role === 'custom' || typeof record.customType === 'string')) return true
  if (record.customType === 'ipython_state' || record.customType === 'refinement_notice') return true
  if (record.customType === 'ipython_state_restored') return true
  if (record.customType === 'harness_digest') return true
  return IPYTHON_RESTORE_TAG.test(contentText(record.content)) || HARNESS_DIGEST_TAG.test(contentText(record.content))
}

export function stripInternalRunNotices(text: string): string {
  if (!text.includes('[python-state]') && !text.includes('[bash-done pid:')) return text
  return text
    .replace(/^\[python-state\]\s*\nYour Python kernel persisted through compaction;[\s\S]*?(?=\n\s*\n|\n\[[^\]]+\]|$)/gm, '')
    .replace(/^\[bash-done pid:\d+ exit:-?\d+\][\t ]*\n(?:[\t ]*\n)?Command:[\s\S]*?(?=\n\s*\n|\n\[[^\]]+\]|$)/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
