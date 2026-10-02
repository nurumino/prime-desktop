// Run: npm run test:previews
// A separate Electron window, synthetic files, no daemon or real user data.
import { app, BrowserWindow } from 'electron'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

async function check() {
  const output = await mkdtemp(join(tmpdir(), 'prime-preview-check-'))
  app.setPath('userData', join(output, 'profile'))
  let window
  try {
  await build({
    configFile: false,
    base: './',
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      outDir: output,
      emptyOutDir: false,
      rollupOptions: { input: resolve('tests/preview-memory.html') }
    },
    logLevel: 'error'
  })
  await app.whenReady()
  window = new BrowserWindow({
    width: 850, height: 730, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  })
  const timeout = setTimeout(() => { console.error('Preview check timed out'); app.exit(1) }, 60_000)
  await window.loadFile(join(output, 'tests/preview-memory.html'))
  const result = await window.webContents.executeJavaScript('window.previewChecks')
  clearTimeout(timeout)
  if (result.error) throw new Error(result.error)
  console.log(JSON.stringify(result, null, 2))
  } finally {
    window?.destroy()
    await rm(output, { recursive: true, force: true, maxRetries: 2 })
  }
}
// Do not await app.whenReady at module scope: Electron waits for ESM evaluation.
void check().then(() => app.exit(0), (error) => { console.error(error); app.exit(1) })
