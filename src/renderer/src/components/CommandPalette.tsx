import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSummary } from '@shared/types'
import { parseModelList, type ModelOption } from '@shared/models'
import { BUILTIN_SLASH_COMMANDS } from '@shared/slash'
import { buildStaticPaletteItems, filterPaletteItems, type PaletteGroup, type PaletteItem } from '@shared/palette'

interface Props {
  open: boolean
  agentId: string | null
  onClose: () => void
  onNavigate: (view: PaletteItem['view']) => void
  onRun: (item: PaletteItem) => void
}

export default function CommandPalette({ open, agentId, onClose, onNavigate, onRun }: Props): JSX.Element | null {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [dynamic, setDynamic] = useState<PaletteItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const staticItems = useMemo(() => buildStaticPaletteItems(BUILTIN_SLASH_COMMANDS), [])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setActive(0)
      setDynamic([])
      return
    }
    inputRef.current?.focus()
    if (!agentId) return
    let cancelled = false
    void Promise.all([
      window.prime.agentSessions(agentId).catch(() => [] as SessionSummary[]),
      window.prime.agentCommand(agentId, { type: 'get_available_models' }).then((res) => parseModelList(res)).catch(() => [] as ModelOption[])
    ]).then(([sessions, models]) => {
      if (cancelled) return
      const items: PaletteItem[] = []
      for (const s of sessions.slice(0, 12)) {
        items.push({
          id: `session:${s.sessionFile}`,
          group: 'Sessions',
          label: s.name ?? s.sessionId.slice(0, 8),
          hint: `${s.messageCount} msgs`,
          action: 'resume-session',
          sessionFile: s.sessionFile,
          keywords: 'resume reopen'
        })
      }
      for (const m of models.slice(0, 30)) {
        items.push({
          id: `model:${m.key}`,
          group: 'Models',
          label: `Switch to ${m.name || m.id}`,
          hint: m.provider,
          action: 'set-model',
          provider: m.provider,
          modelId: m.id,
          // Lets one query span provider and model, e.g. "sterling opus".
          keywords: `model change use ${m.provider} ${m.id}`
        })
      }
      setDynamic(items)
    })
    return () => {
      cancelled = true
    }
  }, [open, agentId])

  const filtered = useMemo(
    () => filterPaletteItems([...staticItems, ...dynamic], query),
    [staticItems, dynamic, query]
  )

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    const row = listRef.current?.querySelector('[data-active="true"]')
    row?.scrollIntoView({ block: 'nearest' })
  }, [active, filtered])

  if (!open) return null

  const run = (item: PaletteItem) => {
    onClose()
    if (item.view) {
      onNavigate(item.view)
      return
    }
    onRun(item)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((current) => (filtered.length === 0 ? 0 : (current + 1) % filtered.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((current) => (filtered.length === 0 ? 0 : (current - 1 + filtered.length) % filtered.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = filtered[active]
      if (item) run(item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  let lastGroup: PaletteGroup | null = null

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette-sheet" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search commands, models, sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
        />
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && <div className="palette-empty">No matches for “{query.trim()}”</div>}
          {filtered.map((item, index) => {
            const showHeader = item.group !== lastGroup
            lastGroup = item.group
            return (
              <div key={item.id}>
                {showHeader && <div className="palette-group">{item.group}</div>}
                <button
                  className={`palette-row ${index === active ? 'active' : ''}`}
                  data-active={index === active}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    run(item)
                  }}
                >
                  <span className="palette-row-label">{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                </button>
              </div>
            )
          })}
        </div>
        <div className="palette-foot">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
