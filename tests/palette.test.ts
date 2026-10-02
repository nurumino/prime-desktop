import { describe, expect, it } from 'vitest'
import { BUILTIN_SLASH_COMMANDS } from '../src/shared/slash'
import { buildStaticPaletteItems, filterPaletteItems, fuzzyScore, type PaletteItem } from '../src/shared/palette'

function item(partial: Partial<PaletteItem> & { id: string; label: string }): PaletteItem {
  return { group: 'Commands', ...partial }
}

describe('fuzzyScore', () => {
  it('returns 0 for an empty query', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
  })

  it('returns -1 when the query cannot match', () => {
    expect(fuzzyScore('xyz', 'compact context')).toBe(-1)
  })

  it('ranks prefix matches above scattered matches', () => {
    const prefix = fuzzyScore('comp', 'compact context')
    const scattered = fuzzyScore('comp', 'copy my prompt')
    expect(prefix).toBeGreaterThan(scattered)
    expect(scattered).toBeGreaterThan(0)
  })

  it('matches across word boundaries', () => {
    expect(fuzzyScore('cc', 'Compact Context')).toBeGreaterThan(0)
  })
})

describe('filterPaletteItems', () => {
  const items: PaletteItem[] = [
    item({ id: 'a', label: 'Go to Settings' }),
    item({ id: 'b', label: 'Copy last reply', hint: '/copy' }),
    item({ id: 'c', label: 'Switch to Claude Sonnet', keywords: 'model anthropic' })
  ]

  it('preserves order and applies the limit for an empty query', () => {
    expect(filterPaletteItems(items, '', 2)).toEqual([items[0], items[1]])
  })

  it('filters out non-matching items', () => {
    const result = filterPaletteItems(items, 'copy')
    expect(result.map((i) => i.id)).toEqual(['b'])
  })

  it('matches against keywords and hints too', () => {
    expect(filterPaletteItems(items, 'anthropic').map((i) => i.id)).toEqual(['c'])
    expect(filterPaletteItems(items, '/copy').map((i) => i.id)).toEqual(['b'])
  })

  it('ranks the best match first', () => {
    const result = filterPaletteItems([...items].reverse(), 'settings')
    expect(result[0].id).toBe('a')
  })
})

describe('buildStaticPaletteItems', () => {
  const items = buildStaticPaletteItems(BUILTIN_SLASH_COMMANDS)

  it('has unique ids', () => {
    const ids = new Set(items.map((item) => item.id))
    expect(ids.size).toBe(items.length)
  })

  it('covers navigation and actions', () => {
    expect(items.some((item) => item.view === 'chat')).toBe(true)
    expect(items.some((item) => item.action === 'new-chat')).toBe(true)
    expect(items.some((item) => item.action === 'quit')).toBe(true)
  })

  it('does not duplicate covered slash commands in the fallback group', () => {
    const names = items
      .filter((item) => item.slash)
      .map((item) => item.slash?.slice(1).trim().split(' ')[0] ?? '')
    const counts = new Map<string, number>()
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
    // Handled by dedicated Navigate entries or non-slash actions:
    for (const name of ['settings', 'model', 'new', 'resume', 'mcp', 'heartbeats', 'quit']) {
      expect(counts.get(name) ?? 0).toBe(0)
    }
    // Curated Actions plus fallback must yield exactly one entry each:
    for (const name of ['copy', 'compact', 'fast']) {
      expect(counts.get(name) ?? 0).toBe(1)
    }
  })

  it('every item has a label and a known group', () => {
    const groups = new Set(['Navigate', 'Actions', 'Models', 'Sessions', 'Commands'])
    for (const item of items) {
      expect(item.label.trim().length).toBeGreaterThan(0)
      expect(groups.has(item.group)).toBe(true)
    }
  })
})
