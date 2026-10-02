import { useEffect, useState, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void
  className?: string
  disabled?: boolean
  title?: string
}

// Destructive actions arm on the first click and run on the second, so a
// stray click can't discard work. The armed state times out on its own.
export default function ConfirmButton({ children, confirmLabel, onConfirm, className = 'btn ghost small', disabled, title }: Props): JSX.Element {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 3500)
    return () => window.clearTimeout(timer)
  }, [armed])

  return (
    <button
      type="button"
      className={`${className} ${armed ? 'confirm-armed' : ''}`}
      disabled={disabled}
      title={title}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        onConfirm()
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  )
}
