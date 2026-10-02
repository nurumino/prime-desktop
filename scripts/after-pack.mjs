import { chmod, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const resources = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
  const prebuilds = join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds')
  let entries
  try {
    entries = await readdir(prebuilds, { withFileTypes: true })
  } catch {
    return
  }
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('darwin-'))
    .map((entry) => chmod(join(prebuilds, entry.name, 'spawn-helper'), 0o755)))
}
