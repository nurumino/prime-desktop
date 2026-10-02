import { useCallback, useEffect, useState } from 'react'
import type { Checkpoint, FileDiff } from '@shared/types'
import ConfirmButton from '../components/ConfirmButton'

interface Props {
  activeAgentId: string | null
}

export default function ApprovalView({ activeAgentId }: Props): JSX.Element {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [diffs, setDiffs] = useState<FileDiff[]>([])
  const [selected, setSelected] = useState<FileDiff | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState('')

  const load = useCallback(() => {
    if (!activeAgentId) return
    void window.prime.gitList(activeAgentId).then(setCheckpoints)
    void window.prime.gitDiffFiles(activeAgentId).then((d) => {
      setDiffs(d)
      setSelected((s) => s ?? d[0] ?? null)
    })
  }, [activeAgentId])

  useEffect(() => {
    setCheckpoints([])
    setDiffs([])
    setSelected(null)
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load])

  if (!activeAgentId) {
    return (
      <div className="view">
        <header className="view-header">
          <h2>Review</h2>
          <p className="view-sub">Open a project folder to inspect agent changes.</p>
        </header>
      </div>
    )
  }

  return (
    <div className="view review-page">
      <header className="view-header">
        <div className="view-heading">
          <span className="view-chip chip-review" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="2.4" />
              <circle cx="6" cy="18" r="2.4" />
              <circle cx="18" cy="7" r="2.4" />
              <path d="M6 8.5v7M15.8 8.2C14 11 10 10.5 8.3 16" />
            </svg>
          </span>
          <div>
            <h2>Review</h2>
            <p className="view-sub">
              Before each prompt, the project is snapshotted to a private git ref. Your branch history and staging area are never touched.
            </p>
          </div>
        </div>
      </header>

      <div className="approval-layout">
        <div className="approval-col">
          <section className="panel">
            <div className="panel-head">Checkpoints</div>
            {restoreError && <div className="sp-chat-error">{restoreError}</div>}
            {checkpoints.length === 0 && <div className="cmd-empty">No checkpoints yet. One is saved before each prompt in a git project.</div>}
            {checkpoints.map((c) => (
              <div key={c.id} className="checkpoint-row">
                <div className="checkpoint-main">
                  <code>{c.id}</code>
                  <span className="checkpoint-label">{c.label}</span>
                  <span className="checkpoint-time">{new Date(c.createdAt).toLocaleString()}</span>
                </div>
                <div className="checkpoint-files">{c.dirtyFiles.length} changed {c.dirtyFiles.length === 1 ? 'file' : 'files'}</div>
                <ConfirmButton
                  className="btn danger small"
                  disabled={restoring !== null}
                  confirmLabel="Overwrite files?"
                  title="Restore the project files to this checkpoint"
                  onConfirm={async () => {
                    setRestoring(c.id)
                    setRestoreError('')
                    try {
                      await window.prime.gitRestore(activeAgentId, c.id)
                    } catch (error) {
                      setRestoreError(error instanceof Error ? error.message : String(error))
                    } finally {
                      setRestoring(null)
                      load()
                    }
                  }}
                >
                  {restoring === c.id ? 'Restoring…' : 'Restore'}
                </ConfirmButton>
              </div>
            ))}
          </section>

          <section className="panel">
            <div className="panel-head">Changed files</div>
            {diffs.length === 0 && <div className="cmd-empty">Working tree is clean.</div>}
            {diffs.map((d) => (
              <button
                key={d.path}
                className={`file-row ${selected?.path === d.path ? 'active' : ''}`}
                onClick={() => setSelected(d)}
              >
                <span className={`file-status ${d.status}`}>{d.status[0].toUpperCase()}</span>
                <span className="file-path">{d.path}</span>
              </button>
            ))}
          </section>
        </div>

        <div className="approval-main">
          <section className="panel grow">
            <div className="panel-head">{selected ? `${selected.status} · ${selected.path}` : 'Diff'}</div>
            {selected ? (
              selected.diff ? (
                <pre className="diff-pre">{selected.diff}</pre>
              ) : (
                <div className="cmd-empty">
                  No staged/unstaged diff for this file (may be newly added, untracked, or outside git).
                </div>
              )
            ) : (
              <div className="cmd-empty">Select a file to inspect its diff.</div>
            )}
          </section>
        </div>
      </div>

    </div>
  )
}
