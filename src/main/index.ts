import { app, BrowserWindow, Menu, Notification, nativeTheme, session, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { BinaryManager } from './binary'
import { AgentManager } from './agentManager'
import { registerIpc } from './ipc'
import { getState, setTabs } from './store'
import type { AppSettings } from '@shared/types'
import { resolveThemeMode } from '@shared/themes'
import { logError } from './logger'
import { isAppUrl, rendererIndexFile } from './ipcSecurity'

let mainWindow: BrowserWindow | null = null
let manager: AgentManager | null = null

const rendererIndex = rendererIndexFile()
const isOwnPage = (url: string): boolean => isAppUrl(url, process.env['ELECTRON_RENDERER_URL'], rendererIndex)

function openExternally(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') void shell.openExternal(parsed.toString())
  } catch {
    /* not a URL worth opening */
  }
}

// The window only ever shows the bundled renderer. Links and redirects go to
// the user's browser; popups, webviews, and foreign navigations are refused.
function lockDownWindow(window: BrowserWindow): void {
  const guard = (event: Electron.Event, url: string) => {
    if (isOwnPage(url)) return
    event.preventDefault()
    openExternally(url)
  }
  window.webContents.on('will-navigate', (event) => guard(event, event.url))
  window.webContents.on('will-redirect', (event) => guard(event, event.url))
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })
}

// Copy buttons need clipboard writes; nothing else (camera, mic, location,
// notifications via the web API, …) is used by the renderer.
function lockDownPermissions(): void {
  const allowed = (permission: string, origin: string) =>
    permission === 'clipboard-sanitized-write' && isOwnPage(origin)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(allowed(permission, details.requestingUrl ?? webContents.getURL()))
  })
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) =>
    allowed(permission, webContents?.getURL() || requestingOrigin))
}

// Multiple app instances share one daemon socket; concurrent supervisors race
// on its lock file and every window ends up with a dead agent. Second launches
// must focus the existing window instead of starting another universe.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = mainWindow
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
}

function createWindow(settings: AppSettings): void {
  const variant = resolveThemeMode(settings.themeMode, nativeTheme.shouldUseDarkColors)
  const windowTheme = variant === 'dark' ? settings.darkTheme : settings.lightTheme
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Prime',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: windowTheme.opaqueWindows ? windowTheme.surface : '#00000000',
    vibrancy: process.platform === 'darwin' && !windowTheme.opaqueWindows
      ? (variant === 'light' ? 'under-window' : 'sidebar')
      : undefined,
    visualEffectState: process.platform === 'darwin' && !windowTheme.opaqueWindows ? 'active' : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  lockDownWindow(mainWindow)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(rendererIndex)
  }
}

function updateWindowTheme(settings: AppSettings): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  const variant = resolveThemeMode(settings.themeMode, nativeTheme.shouldUseDarkColors)
  const windowTheme = variant === 'dark' ? settings.darkTheme : settings.lightTheme
  window.setBackgroundColor(windowTheme.opaqueWindows ? windowTheme.surface : '#00000000')
  if (process.platform === 'darwin') {
    window.setVibrancy(windowTheme.opaqueWindows ? null : (variant === 'light' ? 'under-window' : 'sidebar'))
  }
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:open-folder')
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  lockDownPermissions()
  buildMenu()

  const binary = new BinaryManager()
  manager = new AgentManager(binary)
  registerIpc(() => mainWindow, manager, binary)

  // Surface finished work while the user is elsewhere: a native notification
  // per completion plus a dock badge that counts unseen completions.
  const unseenCompletions = new Set<string>()
  const clearBadge = () => {
    unseenCompletions.clear()
    if (process.platform === 'darwin' && app.dock) app.dock.setBadge('')
  }
  manager.on('completion', async ({ agentId, name }: { agentId: string; name: string }) => {
    const focused = mainWindow?.isFocused() ?? true
    if (focused) return
    const { settings } = await getState()
    if (settings.notifications && Notification.isSupported()) {
      new Notification({ title: name, body: 'Agent finished working' }).show()
    }
    if (settings.dockBadge) {
      unseenCompletions.add(agentId)
      if (process.platform === 'darwin' && app.dock) app.dock.setBadge(String(unseenCompletions.size))
    }
  })
  app.on('browser-window-focus', clearBadge)

  const state = await getState()
  await binary.check()

  // A project folder can be renamed or removed outside the app. Do not leave
  // a dead tab looking usable: its daemon worker can never start with a
  // missing cwd and every command would otherwise become "Agent not connected".
  const validTabs = state.tabs.filter((tab) => existsSync(tab.path))
  if (validTabs.length !== state.tabs.length) {
    const activeTabId = validTabs.some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : (validTabs[0]?.id ?? null)
    state.tabs = validTabs
    state.activeTabId = activeTabId
    await setTabs(validTabs, activeTabId)
  }

  createWindow(state.settings)
  nativeTheme.on('updated', () => {
    void getState().then((latest) => updateWindowTheme(latest.settings))
  })

  for (const tab of state.tabs) {
    try {
      await manager.openTab(tab, state.settings)
    } catch (error) {
      logError(`Failed to restore project tab ${tab.path}`, error)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void getState().then((latest) => createWindow(latest.settings))
    }
  })
})

process.on('uncaughtException', (error) => logError('Uncaught main-process exception', error))
process.on('unhandledRejection', (reason) => logError('Unhandled main-process rejection', reason))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// before-quit is skipped when the app is quit via a signal or OS shutdown, so
// will-quit is the fallback; shutting down twice must not run twice.
let shutDown = false
const shutdownOnce = () => {
  if (shutDown) return
  shutDown = true
  manager?.shutdownAll()
}
app.on('before-quit', shutdownOnce)
app.on('will-quit', shutdownOnce)
