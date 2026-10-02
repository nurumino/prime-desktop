import type { ViewId } from './types'

export type PaletteGroup = 'Navigate' | 'Actions' | 'Models' | 'Sessions' | 'Commands'

export type PaletteAction = 'new-chat' | 'quit' | 'set-model' | 'resume-session'

export interface PaletteItem {
  id: string
  group: PaletteGroup
  label: string
  hint?: string
  keywords?: string
  slash?: string
  view?: ViewId
  action?: PaletteAction
  provider?: string
  modelId?: string
  sessionFile?: string
}

const WORD_BOUNDARY = /[\s/_:-]/

export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  if (!t) return -1
  let score = 0
  let ti = 0
  let streak = 0
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    if (ch === ' ') continue
    const found = t.indexOf(ch, ti)
    if (found === -1) return -1
    streak = found === ti ? streak + 1 : 0
    score += 10
    if (found === 0 || WORD_BOUNDARY.test(t[found - 1] ?? '')) score += 6
    else if (text[found] >= 'A' && text[found] <= 'Z') score += 4
    score += Math.min(streak, 4) * 3
    score -= Math.min(found - ti, 8)
    ti = found + 1
  }
  if (t.startsWith(q)) score += 12
  else if (t.includes(q)) score += 6
  return score
}

export function filterPaletteItems(items: PaletteItem[], query: string, limit = 40): PaletteItem[] {
  const q = query.trim()
  if (!q) return items.slice(0, limit)
  const scored: { item: PaletteItem; score: number }[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const fields = [item.label, item.hint ?? '', item.keywords ?? '', item.group]
    let best = -1
    for (const field of fields) {
      const s = fuzzyScore(q, field)
      if (s > best) best = s
    }
    if (best >= 0) scored.push({ item, score: best - i * 0.001 })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((entry) => entry.item)
}

interface SlashDefLike {
  name: string
  description: string
}

function commandItem(def: SlashDefLike): PaletteItem {
  return {
    id: `cmd:${def.name}`,
    group: 'Commands',
    label: def.description,
    hint: `/${def.name}`,
    keywords: def.name,
    slash: `/${def.name}`
  }
}

export function buildStaticPaletteItems(builtinCommands: SlashDefLike[]): PaletteItem[] {
  const items: PaletteItem[] = [
    { id: 'nav:chat', group: 'Navigate', label: 'Go to Chat', view: 'chat', keywords: 'home projects sessions' },
    { id: 'nav:fleet', group: 'Navigate', label: 'Go to Automations', view: 'fleet', keywords: 'schedules heartbeats agents fleet' },
    { id: 'nav:approval', group: 'Navigate', label: 'Go to Approvals', view: 'approval', keywords: 'permissions review diffs' },
    { id: 'nav:dashboard', group: 'Navigate', label: 'Go to Dashboard', view: 'dashboard', keywords: 'spend usage cost tokens' },
    { id: 'nav:skills', group: 'Navigate', label: 'Go to Skills & MCP', view: 'skills', keywords: 'extensions packages connections mcp' },
    { id: 'nav:diagnostics', group: 'Navigate', label: 'Go to Diagnostics', view: 'diagnostics', keywords: 'logs debug doctor daemon status' },
    { id: 'nav:settings', group: 'Navigate', label: 'Go to Settings', view: 'settings', keywords: 'preferences theme model notifications' },

    { id: 'act:new-chat', group: 'Actions', label: 'New chat', action: 'new-chat', keywords: 'clear reset start over session' },
    { id: 'act:copy', group: 'Actions', label: 'Copy last reply', hint: '/copy', slash: '/copy', keywords: 'clipboard message' },
    { id: 'act:compact', group: 'Actions', label: 'Compact context', hint: '/compact', slash: '/compact', keywords: 'tokens summarize save' },
    { id: 'act:goal', group: 'Actions', label: 'Set thread goal', hint: '/goal', slash: '/goal', keywords: 'objective persistent budget' },
    { id: 'act:fork', group: 'Actions', label: 'Fork from a message', hint: '/fork', slash: '/fork', keywords: 'branch rewind history' },
    { id: 'act:tree', group: 'Actions', label: 'Jump to point in session tree', hint: '/tree', slash: '/tree', keywords: 'branch navigate rewind' },
    { id: 'act:export', group: 'Actions', label: 'Export session as HTML', hint: '/export', slash: '/export', keywords: 'save share file' },
    { id: 'act:share', group: 'Actions', label: 'Share session link', hint: '/share', slash: '/share', keywords: 'gist url copy' },
    { id: 'act:import', group: 'Actions', label: 'Import session JSONL', hint: '/import', slash: '/import', keywords: 'load resume file' },
    { id: 'act:name', group: 'Actions', label: 'Rename this chat', hint: '/name', slash: '/name', keywords: 'title label' },
    { id: 'act:btw', group: 'Actions', label: 'Ask a side question', hint: '/btw', slash: '/btw ', keywords: 'quick question side' },
    { id: 'act:effort', group: 'Actions', label: 'Reasoning effort', hint: '/effort', slash: '/effort', keywords: 'thinking level low high' },
    { id: 'act:depth', group: 'Actions', label: 'Recursive subagent depth', hint: '/rlm-max-depth', slash: '/rlm-max-depth', keywords: 'rlm nested depth' },
    { id: 'act:scoped-models', group: 'Actions', label: 'Scoped models for cycling', hint: '/scoped-models', slash: '/scoped-models', keywords: 'limit cycle available' },
    { id: 'act:heartbeat', group: 'Actions', label: 'Set or control heartbeat', hint: '/heartbeat', slash: '/heartbeat', keywords: 'schedule recurring interval' },
    { id: 'act:autonomous', group: 'Actions', label: 'Autonomous mode', hint: '/autonomous', slash: '/autonomous ', keywords: 'self continue unattended' },
    { id: 'act:refine', group: 'Actions', label: 'Refine harness state', hint: '/refine', slash: '/refine', keywords: 'learn memory improve' },
    { id: 'act:reload', group: 'Actions', label: 'Reload skills & prompts', hint: '/reload', slash: '/reload', keywords: 'refresh commands extensions' },
    { id: 'act:login', group: 'Actions', label: 'Add provider API key', hint: '/login', slash: '/login', keywords: 'auth credentials oauth sign in' },
    { id: 'act:update', group: 'Actions', label: 'Update Prime Agent', hint: '/update', slash: '/update', keywords: 'upgrade version latest' },
    { id: 'act:traces', group: 'Actions', label: 'Configure trace sharing', hint: '/traces', slash: '/traces', keywords: 'telemetry upload' },
    { id: 'act:fullscreen', group: 'Actions', label: 'Toggle fullscreen', hint: '/fullscreen', slash: '/fullscreen', keywords: 'window focus zoom' },
    { id: 'act:logs', group: 'Actions', label: 'Reveal log folder', hint: '/logs', slash: '/logs', keywords: 'debug files finder' },
    { id: 'act:hotkeys', group: 'Actions', label: 'Keyboard shortcuts', hint: '/hotkeys', slash: '/hotkeys', keywords: 'help keys bindings' },
    { id: 'act:changelog', group: 'Actions', label: "What's new", hint: '/changelog', slash: '/changelog', keywords: 'release notes version history' },
    { id: 'act:session', group: 'Actions', label: 'Session details', hint: '/session', slash: '/session', keywords: 'file id counts info' },
    { id: 'act:system-prompt', group: 'Actions', label: 'View system prompt', hint: '/system-prompt', slash: '/system-prompt', keywords: 'instructions context' },
    { id: 'act:quit', group: 'Actions', label: 'Quit Prime Desktop', action: 'quit', keywords: 'exit close app' }
  ]

  const covered = new Set(items.flatMap((item) => (item.slash ? [item.slash.slice(1).split(' ')[0]] : [])))
  covered.add('settings')
  covered.add('model')
  covered.add('new')
  covered.add('resume')
  covered.add('mcp')
  covered.add('heartbeats')
  covered.add('quit')
  for (const def of builtinCommands) {
    if (!covered.has(def.name)) items.push(commandItem(def))
  }
  return items
}
