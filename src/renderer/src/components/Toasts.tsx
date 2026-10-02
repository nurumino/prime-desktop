interface Toast {
  id: string
  kind: 'info' | 'success' | 'warning' | 'error'
  text: string
}

export default function Toasts({ toasts }: { toasts: Toast[] }): JSX.Element {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
