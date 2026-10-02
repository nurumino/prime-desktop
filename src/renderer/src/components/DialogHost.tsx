import { useEffect, useRef, useState } from 'react'
import type { UiDialog } from '@shared/types'

interface Props {
  dialogs: UiDialog[]
  onRespond: (id: string, value: unknown, cancelled: boolean) => void
}

export default function DialogHost({ dialogs, onRespond }: Props): JSX.Element {
  const dialog = dialogs[0]
  if (!dialog) return <></>
  // Keyed by id so each request starts from its own prefill instead of the
  // previous dialog's text.
  return <AgentDialog key={dialog.id} dialog={dialog} onRespond={onRespond} />
}

function AgentDialog({ dialog, onRespond }: { dialog: UiDialog; onRespond: Props['onRespond'] }): JSX.Element {
  const [inputValue, setInputValue] = useState(dialog.prefill ?? '')
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = `dialog-title-${dialog.id}`
  const cancel = () => onRespond(dialog.id, null, true)

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const previous = document.activeElement as HTMLElement | null
    if (!panel.contains(document.activeElement)) {
      panel.querySelector<HTMLElement>('textarea, button')?.focus()
    }
    // Keep keyboard focus inside the dialog while it is open.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button, textarea, input, select'))
        .filter((element) => !element.hasAttribute('disabled'))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [dialog.id])

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef}>
        <div className="dialog-title" id={titleId}>{dialog.title}</div>
        {dialog.message && <div className="dialog-message">{dialog.message}</div>}
        {dialog.method === 'select' && (
          <>
            <div className="dialog-options">
              {dialog.options?.map((opt) => (
                <button key={opt} className="dialog-option" onClick={() => onRespond(dialog.id, opt, false)}>
                  {opt}
                </button>
              ))}
            </div>
            <div className="dialog-actions">
              <button className="btn ghost" onClick={cancel}>Cancel</button>
            </div>
          </>
        )}
        {(dialog.method === 'input' || dialog.method === 'editor') && (
          <>
            <textarea
              autoFocus
              className="dialog-input"
              rows={dialog.method === 'editor' ? 8 : 2}
              aria-labelledby={titleId}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && dialog.method === 'input' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  onRespond(dialog.id, inputValue, false)
                }
              }}
            />
            <div className="dialog-actions">
              <button className="btn ghost" onClick={cancel}>Cancel</button>
              <button className="btn primary" onClick={() => onRespond(dialog.id, inputValue, false)}>OK</button>
            </div>
          </>
        )}
        {dialog.method === 'confirm' && (
          <div className="dialog-actions">
            <button className="btn ghost" onClick={cancel}>Cancel</button>
            <button className="btn primary" onClick={() => onRespond(dialog.id, true, false)}>Confirm</button>
          </div>
        )}
      </div>
    </div>
  )
}
