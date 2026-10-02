import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { agentCommand, cliFromNpmShim, desktopDaemonSocket, isNamedPipe, terminalShell, withExtraPath } from '../src/main/platform'
import { baseName } from '../src/shared/paths'

describe('platform helpers', () => {
  it('runs the JavaScript entry point through node only on Windows', () => {
    expect(agentCommand('C:\\rt\\cli.js', 'win32')).toEqual({ cmd: 'node', args: ['C:\\rt\\cli.js'] })
    expect(agentCommand('C:\\tools\\prime-agent.exe', 'win32')).toEqual({ cmd: 'C:\\tools\\prime-agent.exe', args: [] })
    expect(agentCommand('/rt/cli.js', 'darwin')).toEqual({ cmd: '/rt/cli.js', args: [] })
  })

  it('maps an npm .cmd shim to the cli.js installed beside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'pd-shim-'))
    const cli = join(root, 'node_modules', 'prime-agent', 'dist', 'bundle', 'cli.js')
    mkdirSync(join(cli, '..'), { recursive: true })
    writeFileSync(cli, '')
    expect(cliFromNpmShim(join(root, 'prime-agent.cmd'))).toBe(cli)
    expect(cliFromNpmShim(join(root, 'prime-agent'))).toBeNull()
    expect(cliFromNpmShim(join(root, 'missing', 'prime-agent.cmd'))).toBeNull()
  })

  it('uses a per-user named pipe for the desktop daemon on Windows', () => {
    const pipe = desktopDaemonSocket('win32')
    expect(pipe).toMatch(/^\\\\\.\\pipe\\prime-desktop-.+/)
    expect(isNamedPipe(pipe)).toBe(true)
    expect(desktopDaemonSocket('darwin')).toMatch(/PrimeDesktop[\\/]prime-agent\.sock$/)
    expect(isNamedPipe(desktopDaemonSocket('darwin'))).toBe(false)
  })

  it('starts PowerShell on Windows and a login shell elsewhere', () => {
    expect(terminalShell('win32', {})).toEqual({ shell: 'powershell.exe', args: ['-NoLogo'] })
    expect(terminalShell('darwin', { SHELL: '/bin/sh' })).toEqual({ shell: '/bin/sh', args: ['-l'] })
  })

  it('leaves PATH alone on Windows', () => {
    expect(withExtraPath('C:\\Windows;C:\\node', 'win32')).toBe('C:\\Windows;C:\\node')
    expect(withExtraPath('/usr/bin', 'darwin')).toContain('/opt/homebrew/bin')
  })

  it('takes display names from Windows and POSIX paths', () => {
    expect(baseName('C:\\Users\\amy\\project\\notes.md')).toBe('notes.md')
    expect(baseName('/Users/amy/project/')).toBe('project')
    expect(baseName('notes.md')).toBe('notes.md')
  })
})
