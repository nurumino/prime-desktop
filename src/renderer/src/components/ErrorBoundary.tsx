import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  label?: string
}

interface State {
  error: Error | null
}

// A render error in one view should not blank the whole window. Remount the
// boundary (it is keyed by view or agent) or press Try again to recover.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('View crashed', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="view error-boundary" role="alert">
        <h2>{this.props.label ?? 'This view'} could not be displayed</h2>
        <p className="view-sub">{error.message || 'An unexpected error occurred.'}</p>
        <div className="row-gap">
          <button type="button" className="btn primary small" onClick={() => this.setState({ error: null })}>Try again</button>
          <button type="button" className="btn ghost small" onClick={() => window.location.reload()}>Reload window</button>
        </div>
      </div>
    )
  }
}
