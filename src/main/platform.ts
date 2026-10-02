import { existsSync } from 'fs'
import { homedir, userInfo } from 'os'
import { delimiter, dirname, join } from 'path'

/** Platform differences in how Prime Desktop finds and starts Prime Agent. */

export const APP_SUPPORT_DIR = join(homedir(), 'Library', 'Application Support', 'PrimeDesktop')

/** The prime-agent entry point inside an npm-style install root. */
export function cliEntry(installRoot: string): string {
  return join(installRoot, 'node_modules', 'prime-agent', 'dist', 'bundle', 'cli.js')
}

/**
 * Windows cannot execute a .js file directly, and npm's .cmd shims need a
 * shell, so Prime Agent's JavaScript entry point runs through node there.
 */
export function agentCommand(binary: string, platform = process.platform): { cmd: string; args: string[] } {
  if (platform === 'win32' && /\.[cm]?js$/i.test(binary)) return { cmd: 'node', args: [binary] }
  return { cmd: binary, args: [] }
}

/**
 * `where prime-agent` finds npm's prime-agent.cmd shim on Windows. The desktop
 * needs the package's cli.js, which npm installs beside the shim.
 */
export function cliFromNpmShim(shimPath: string): string | null {
  if (!/\.cmd$/i.test(shimPath)) return null
  const cli = join(dirname(shimPath), 'node_modules', 'prime-agent', 'dist', 'bundle', 'cli.js')
  return existsSync(cli) ? cli : null
}

/** Windows daemons listen on named pipes; a filesystem path does not work there. */
export function desktopDaemonSocket(platform = process.platform): string {
  if (platform === 'win32') return `\\\\.\\pipe\\prime-desktop-${userInfo().username}`
  return join(APP_SUPPORT_DIR, 'prime-agent.sock')
}

export function isNamedPipe(socketPath: string): boolean {
  return socketPath.startsWith('\\\\.\\pipe\\') || socketPath.startsWith('\\\\?\\pipe\\')
}

export function terminalShell(platform = process.platform, env = process.env): { shell: string; args: string[] } {
  if (platform === 'win32') return { shell: 'powershell.exe', args: ['-NoLogo'] }
  const configured = env.SHELL
  if (configured && configured.startsWith('/') && existsSync(configured)) return { shell: configured, args: ['-l'] }
  for (const shell of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (existsSync(shell)) return { shell, args: ['-l'] }
  }
  return { shell: '/bin/sh', args: ['-l'] }
}

/** Common install folders macOS GUI apps miss because they don't inherit the login shell's PATH. */
export function withExtraPath(path: string | undefined, platform = process.platform): string {
  if (platform === 'win32') return path ?? ''
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')]
  return [...extra, path ?? '/usr/bin:/bin'].join(delimiter)
}
