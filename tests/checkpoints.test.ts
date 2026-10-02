import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  checkpointExists,
  checkpointRef,
  createCheckpointSnapshot,
  restoreCheckpointSnapshot
} from '../src/main/git'

// Keep the developer's global git config (signing, hooks, identity) out of it.
const savedEnv = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM }
const roots: string[] = []

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})

afterAll(() => {
  if (savedEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = savedEnv.global
  if (savedEnv.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = savedEnv.nosystem
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  })
}

function write(root: string, path: string, contents: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), contents)
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'prime-checkpoints-'))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  write(root, '.gitignore', 'ignored.log\n')
  write(root, 'tracked.txt', 'v1\n')
  write(root, 'sub/keep.txt', 'keep\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'initial')
  return root
}

function repoState(root: string) {
  return {
    head: git(root, 'rev-parse', 'HEAD'),
    branch: git(root, 'symbolic-ref', 'HEAD'),
    log: git(root, 'log', '--oneline', 'main'),
    index: git(root, 'ls-files', '-s'),
    cached: git(root, 'diff', '--cached', '--name-status')
  }
}

describe('git checkpoints', () => {
  it('snapshots without touching the branch or index and restores the working tree', async () => {
    const root = makeRepo()
    write(root, 'tracked.txt', 'v2\n')
    write(root, 'new.txt', 'new\n')
    write(root, 'ignored.log', 'ign1\n')
    write(root, 'staged.txt', 'staged\n')
    git(root, 'add', 'staged.txt')
    const before = repoState(root)
    const status = git(root, 'status', '--porcelain')

    const snapshot = await createCheckpointSnapshot(root, '[prime-desktop] before-prompt checkpoint')
    expect(snapshot).not.toBeNull()
    const sha = snapshot!.sha
    expect(repoState(root)).toEqual(before)
    expect(git(root, 'status', '--porcelain')).toBe(status)
    expect(git(root, 'rev-parse', checkpointRef(sha)).trim()).toBe(sha)
    expect(await checkpointExists(root, sha)).toBe(true)
    expect(git(root, 'show', `${sha}:tracked.txt`)).toBe('v2\n')
    expect(git(root, 'show', `${sha}:new.txt`)).toBe('new\n')
    expect(() => git(root, 'cat-file', '-e', `${sha}:ignored.log`)).toThrow()
    expect(git(root, 'rev-parse', `${sha}^`).trim()).toBe(before.head.trim())

    // Nothing changed since the last snapshot: no new checkpoint.
    expect(await createCheckpointSnapshot(root, 'again', sha)).toBeNull()

    write(root, 'tracked.txt', 'v3\n')
    write(root, 'another.txt', 'another\n')
    write(root, 'newdir/deep/file.txt', 'deep\n')
    write(root, 'ignored.log', 'ign2\n')
    unlinkSync(join(root, 'new.txt'))
    unlinkSync(join(root, 'sub/keep.txt'))

    await restoreCheckpointSnapshot(root, sha)

    expect(read(root, 'tracked.txt')).toBe('v2\n')
    expect(read(root, 'new.txt')).toBe('new\n')
    expect(read(root, 'sub/keep.txt')).toBe('keep\n')
    expect(read(root, 'staged.txt')).toBe('staged\n')
    expect(existsSync(join(root, 'another.txt'))).toBe(false)
    expect(existsSync(join(root, 'newdir'))).toBe(false)
    expect(read(root, 'ignored.log')).toBe('ign2\n')
    expect(repoState(root)).toEqual(before)
    expect(git(root, 'status', '--porcelain')).toBe(status)
  })

  it('refuses unknown or malformed checkpoint ids', async () => {
    const root = makeRepo()
    await expect(restoreCheckpointSnapshot(root, 'HEAD')).rejects.toThrow(/Invalid checkpoint/)
    await expect(restoreCheckpointSnapshot(root, '--all')).rejects.toThrow(/Invalid checkpoint/)
    const head = git(root, 'rev-parse', 'HEAD').trim()
    await expect(restoreCheckpointSnapshot(root, head)).rejects.toThrow(/not found/)
    expect(await checkpointExists(root, head)).toBe(false)
  })

  it('limits snapshot and restore to a project opened in a subfolder', async () => {
    const root = makeRepo()
    const project = join(root, 'sub')
    const snapshot = await createCheckpointSnapshot(project, 'sub checkpoint')
    expect(snapshot).not.toBeNull()
    write(root, 'outside.txt', 'outside\n')
    write(root, 'tracked.txt', 'changed outside\n')
    write(project, 'inside.txt', 'inside\n')
    write(project, 'keep.txt', 'changed\n')

    await restoreCheckpointSnapshot(project, snapshot!.sha)

    expect(existsSync(join(project, 'inside.txt'))).toBe(false)
    expect(read(project, 'keep.txt')).toBe('keep\n')
    expect(read(root, 'outside.txt')).toBe('outside\n')
    expect(read(root, 'tracked.txt')).toBe('changed outside\n')
  })

  it('works in a repository without commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prime-checkpoints-empty-'))
    roots.push(root)
    git(root, 'init', '-q', '-b', 'main')
    write(root, 'a.txt', 'a\n')
    const snapshot = await createCheckpointSnapshot(root, 'first')
    expect(snapshot).not.toBeNull()
    expect(() => git(root, 'rev-parse', '--verify', '--quiet', 'HEAD')).toThrow()
    write(root, 'a.txt', 'changed\n')
    write(root, 'b.txt', 'b\n')
    await restoreCheckpointSnapshot(root, snapshot!.sha)
    expect(read(root, 'a.txt')).toBe('a\n')
    expect(existsSync(join(root, 'b.txt'))).toBe(false)
  })
})
