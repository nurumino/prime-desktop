import { pathToFileURL } from 'url'
import { describe, expect, it } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { assertTrustedRenderer, isAppUrl, isWithin, requireSafeExternalUrl } from '../src/main/ipcSecurity'

describe('IPC security helpers', () => {
  it('accepts HTTP(S) URLs and rejects dangerous protocols', () => {
    expect(requireSafeExternalUrl('https://example.com/path')).toBe('https://example.com/path')
    expect(() => requireSafeExternalUrl('javascript:alert(1)')).toThrow(/HTTP\(S\)/)
    expect(() => requireSafeExternalUrl('file:///etc/passwd')).toThrow(/HTTP\(S\)/)
  })

  it('checks path containment without prefix confusion', () => {
    expect(isWithin('/tmp/project', '/tmp/project/src')).toBe(true)
    expect(isWithin('/tmp/project', '/tmp/project-other')).toBe(false)
  })
})

describe('isAppUrl', () => {
  const index = '/Applications/Prime.app/Contents/Resources/app.asar/out/renderer/index.html'

  it('matches the dev server origin only', () => {
    const dev = 'http://localhost:5173'
    expect(isAppUrl('http://localhost:5173/', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5173/src/main.tsx?x=1#top', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isAppUrl('https://localhost:5173/', dev)).toBe(false)
    expect(isAppUrl('http://evil.test/', dev)).toBe(false)
    expect(isAppUrl(pathToFileURL(index).href, dev)).toBe(false)
  })

  it('matches the bundled index.html in production', () => {
    expect(isAppUrl(pathToFileURL(index).href, undefined, index)).toBe(true)
    expect(isAppUrl(`${pathToFileURL(index).href}#/settings`, undefined, index)).toBe(true)
    expect(isAppUrl('file:///etc/passwd', undefined, index)).toBe(false)
    expect(isAppUrl('https://example.com/', undefined, index)).toBe(false)
    expect(isAppUrl('http://localhost:5173/', undefined, index)).toBe(false)
  })

  it('rejects unparseable and opaque URLs', () => {
    expect(isAppUrl('not a url', 'http://localhost:5173')).toBe(false)
    expect(isAppUrl('about:blank', undefined, index)).toBe(false)
    expect(isAppUrl('data:text/html,hi', undefined, index)).toBe(false)
  })
})

describe('assertTrustedRenderer', () => {
  const dev = 'http://localhost:5173'
  const mainFrame = { url: 'http://localhost:5173/', parent: null }
  const webContents = { mainFrame }
  const window = { isDestroyed: () => false, webContents } as unknown as BrowserWindow
  const event = (sender: unknown, senderFrame: unknown) => ({ sender, senderFrame }) as unknown as IpcMainInvokeEvent

  it('accepts the main frame of the app window', () => {
    expect(() => assertTrustedRenderer(event(webContents, mainFrame), () => window, dev)).not.toThrow()
  })

  it('rejects other senders, subframes, missing frames, and foreign pages', () => {
    expect(() => assertTrustedRenderer(event({}, mainFrame), () => window, dev)).toThrow(/Untrusted/)
    expect(() => assertTrustedRenderer(event(webContents, mainFrame), () => null, dev)).toThrow(/Untrusted/)
    expect(() => assertTrustedRenderer(event(webContents, null), () => window, dev)).toThrow(/Untrusted/)
    const subframe = { url: 'http://localhost:5173/', parent: mainFrame }
    expect(() => assertTrustedRenderer(event(webContents, subframe), () => window, dev)).toThrow(/Untrusted/)
    const navigatedAway = { url: 'https://evil.test/', parent: null }
    const strayContents = { mainFrame: navigatedAway }
    const strayWindow = { isDestroyed: () => false, webContents: strayContents } as unknown as BrowserWindow
    expect(() => assertTrustedRenderer(event(strayContents, navigatedAway), () => strayWindow, dev)).toThrow(/Untrusted/)
  })
})
