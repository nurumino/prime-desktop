import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { rm, rmdir } from 'fs/promises'
import { randomUUID } from 'crypto'
import { dirname, join, resolve, sep } from 'path'
import type { GitChange, GitStatus } from '@shared/types'

const exec = promisify(execFile)

interface GitOptions {
  env?: Record<string, string>
  timeout?: number
}

async function git(args: string[], cwd: string, options: GitOptions = {}): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    timeout: options.timeout ?? 20000,
    maxBuffer: 20 * 1024 * 1024,
    env: options.env ? { ...process.env, ...options.env } : undefined
  })
  return stdout
}

function errorText(error: unknown): string {
  const value = error as { stderr?: string; stdout?: string; message?: string }
  return String(value.stderr || value.stdout || value.message || error).trim()
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--is-inside-work-tree'], dir)
    return true
  } catch {
    return false
  }
}

export async function statusShort(dir: string): Promise<{ path: string; status: string }[]> {
  try {
    const out = await git(['status', '--porcelain=v1', '--untracked-files=all'], dir)
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }))
  } catch {
    return []
  }
}

export async function gitStatus(dir: string): Promise<GitStatus> {
  if (!(await isGitRepo(dir))) {
    return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, changes: [] }
  }
  const [statusOutput, branch, upstream] = await Promise.all([
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], dir),
    git(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir).then((value) => value.trim()).catch(() =>
      git(['rev-parse', '--short', 'HEAD'], dir).then((value) => value.trim()).catch(() => 'HEAD')),
    git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], dir)
      .then((value) => value.trim())
      .catch(() => null)
  ])
  let ahead = 0
  let behind = 0
  if (upstream) {
    const counts = await git(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], dir).catch(() => '')
    const [left, right] = counts.trim().split(/\s+/).map(Number)
    ahead = Number.isFinite(left) ? left : 0
    behind = Number.isFinite(right) ? right : 0
  }

  const records = statusOutput.split('\0')
  const changes: GitChange[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record) continue
    const indexStatus = record[0] ?? ' '
    const worktreeStatus = record[1] ?? ' '
    const path = record.slice(3)
    const renamed = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C'
    const originalPath = renamed ? records[++index] : undefined
    changes.push({
      path,
      originalPath: originalPath || undefined,
      indexStatus,
      worktreeStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?',
      unstaged: worktreeStatus !== ' ' || indexStatus === '?'
    })
  }
  return { isRepo: true, branch: branch || 'HEAD', upstream, ahead, behind, changes }
}

export async function gitFileDiff(dir: string, path: string, staged: boolean): Promise<string> {
  try {
    const diff = await git(staged
      ? ['diff', '--cached', '--no-ext-diff', '--', path]
      : ['diff', '--no-ext-diff', '--', path], dir)
    if (diff || staged) return diff
    const tracked = await git(['ls-files', '--error-unmatch', '--', path], dir).then(() => true).catch(() => false)
    if (tracked) return diff
    try {
      return await git(['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', path], dir)
    } catch (error) {
      return String((error as { stdout?: string }).stdout ?? '')
    }
  } catch (error) {
    throw new Error(errorText(error))
  }
}

export async function stageFiles(dir: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  try {
    await git(['add', '--', ...paths], dir)
  } catch (error) {
    throw new Error(errorText(error))
  }
}

export async function unstageFiles(dir: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const hasHead = await git(['rev-parse', '--verify', 'HEAD'], dir).then(() => true).catch(() => false)
  if (!hasHead) {
    try {
      await git(['rm', '--cached', '-q', '--', ...paths], dir)
    } catch (error) {
      throw new Error(errorText(error))
    }
    return
  }
  try {
    await git(['restore', '--staged', '--', ...paths], dir)
  } catch (error) {
    throw new Error(errorText(error))
  }
}

export async function stageAll(dir: string): Promise<void> {
  try {
    await git(['add', '-A'], dir)
  } catch (error) {
    throw new Error(errorText(error))
  }
}

export async function unstageAll(dir: string): Promise<void> {
  const hasHead = await git(['rev-parse', '--verify', 'HEAD'], dir).then(() => true).catch(() => false)
  if (!hasHead) {
    try {
      await git(['rm', '--cached', '-r', '-q', '--', '.'], dir)
    } catch (error) {
      throw new Error(errorText(error))
    }
    return
  }
  try {
    await git(['reset', '-q', 'HEAD', '--', '.'], dir)
  } catch (error) {
    throw new Error(errorText(error))
  }
}

export async function commitStaged(dir: string, message: string): Promise<{ sha: string; summary: string }> {
  const trimmed = message.trim()
  if (!trimmed) throw new Error('Enter a commit message.')
  try {
    const summary = (await git(['commit', '-m', trimmed], dir)).trim()
    const sha = (await git(['rev-parse', '--short', 'HEAD'], dir)).trim()
    return { sha, summary }
  } catch (error) {
    throw new Error(errorText(error))
  }
}

export async function changedFiles(dir: string): Promise<string[]> {
  const st = await statusShort(dir)
  return st.map((s) => s.path)
}

export async function diffForFile(dir: string, path: string): Promise<string> {
  try {
    const out = await git(['diff', '--', path], dir)
    if (out.trim()) return out
  } catch {
    /* ignore */
  }
  try {
    const out = await git(['diff', '--cached', '--', path], dir)
    return out
  } catch {
    return ''
  }
}

export async function diffAll(dir: string): Promise<string> {
  try {
    const out = await git(['diff'], dir)
    if (out.trim()) return out
  } catch {
    /* ignore */
  }
  try {
    const out = await git(['diff', '--cached'], dir)
    return out
  } catch {
    return ''
  }
}

export async function isDirty(dir: string): Promise<boolean> {
  const st = await statusShort(dir)
  return st.length > 0
}

export async function gitLog(dir: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['log', '--oneline', '-1', ref], { cwd: dir })
    return stdout.trim()
  } catch {
    return null
  }
}

export async function fileExistsInDir(dir: string, rel: string): Promise<boolean> {
  return existsSync(join(dir, rel))
}

// ---------- Checkpoints ----------
// Snapshots of the project's working tree stored as dangling commits under
// refs/prime-desktop/. They never touch the user's branch, index, or hooks.

export const CHECKPOINT_REF_PREFIX = 'refs/prime-desktop/checkpoints/'
const CHECKPOINT_ID = /^[0-9a-f]{7,40}$/
// commit-tree refuses to run without an identity; only used as a fallback.
const FALLBACK_IDENTITY = {
  GIT_AUTHOR_NAME: 'Prime Desktop',
  GIT_AUTHOR_EMAIL: 'prime-desktop@localhost',
  GIT_COMMITTER_NAME: 'Prime Desktop',
  GIT_COMMITTER_EMAIL: 'prime-desktop@localhost'
}

export function isCheckpointId(value: unknown): value is string {
  return typeof value === 'string' && CHECKPOINT_ID.test(value)
}

export function checkpointRef(sha: string): string {
  return `${CHECKPOINT_REF_PREFIX}${sha}`
}

function splitNul(output: string): string[] {
  return output.split('\0').filter(Boolean)
}

async function revParse(dir: string, rev: string): Promise<string | null> {
  const value = await git(['rev-parse', '--verify', '--quiet', rev], dir).then((out) => out.trim()).catch(() => '')
  return value || null
}

async function withTempIndex<T>(dir: string, run: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const name = `prime-desktop-checkpoint-${process.pid}-${randomUUID()}.index`
  const indexFile = resolve(dir, (await git(['rev-parse', '--git-path', name], dir)).trim())
  try {
    return await run({ GIT_INDEX_FILE: indexFile })
  } finally {
    await rm(indexFile, { force: true }).catch(() => {})
  }
}

// Paths are relative to dir and limited to it, so a project opened in a
// subfolder of a larger repository only snapshots and restores that subfolder.
export async function createCheckpointSnapshot(
  dir: string,
  message: string,
  previous?: string | null
): Promise<{ sha: string; tree: string } | null> {
  if (!(await isGitRepo(dir))) return null
  const head = await revParse(dir, 'HEAD^{commit}')
  const tree = await withTempIndex(dir, async (env) => {
    if (head) await git(['read-tree', head], dir, { env })
    await git(['add', '-A', '--', '.'], dir, { env, timeout: 120_000 })
    return (await git(['write-tree'], dir, { env })).trim()
  })
  if (previous && isCheckpointId(previous) && (await revParse(dir, `${previous}^{tree}`)) === tree) return null
  const args = ['commit-tree', '--no-gpg-sign', tree, ...(head ? ['-p', head] : []), '-m', message]
  const sha = (await git(args, dir).catch(() => git(args, dir, { env: FALLBACK_IDENTITY }))).trim()
  await git(['update-ref', checkpointRef(sha), sha], dir)
  return { sha, tree }
}

export async function checkpointExists(dir: string, sha: string): Promise<boolean> {
  return isCheckpointId(sha) && Boolean(await revParse(dir, `${checkpointRef(sha)}^{commit}`))
}

export async function deleteCheckpointRef(dir: string, sha: string): Promise<void> {
  if (!isCheckpointId(sha)) return
  await git(['update-ref', '-d', checkpointRef(sha)], dir).catch(() => {})
}

// Restores file contents without moving HEAD or touching the real index.
// Non-ignored files that did not exist in the snapshot are removed; ignored
// files are left alone.
export async function restoreCheckpointSnapshot(dir: string, sha: string): Promise<void> {
  if (!isCheckpointId(sha)) throw new Error('Invalid checkpoint id')
  const commit = await revParse(dir, `${checkpointRef(sha)}^{commit}`)
  if (!commit) throw new Error('Checkpoint not found in this repository')
  try {
    const snapshot = new Set(splitNul(await git(['ls-tree', '-r', '-z', '--name-only', commit], dir)))
    const current = splitNul(await git(['ls-files', '-z', '-c', '-o', '--exclude-standard'], dir))
    const root = resolve(dir)
    for (const path of new Set(current)) {
      if (snapshot.has(path)) continue
      const file = resolve(root, path)
      // Nested repositories show up as "dir/"; never remove those.
      if (path.endsWith('/') || !file.startsWith(`${root}${sep}`)) continue
      try {
        await rm(file, { force: true })
      } catch {
        continue
      }
      for (let parent = dirname(file); parent.startsWith(`${root}${sep}`); parent = dirname(parent)) {
        try {
          await rmdir(parent)
        } catch {
          break
        }
      }
    }
    await withTempIndex(dir, async (env) => {
      await git(['read-tree', commit], dir, { env })
      await git(['checkout-index', '-a', '-f'], dir, { env, timeout: 120_000 })
    })
  } catch (error) {
    throw new Error(errorText(error))
  }
}
