// Prime Agent's reasoning levels. Every picker sends these exact values; the
// labels are display-only.
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const

export type ThinkingLevel = typeof THINKING_LEVELS[number]

const LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high'
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
}

export function thinkingLabel(value: string | null | undefined): string {
  return isThinkingLevel(value) ? LABELS[value] : value || 'Medium'
}
