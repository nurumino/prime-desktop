import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import FilesPanel from '../src/renderer/src/components/FilesPanel'
import '../src/renderer/src/styles.css'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function waitFor(predicate: () => unknown, message: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

// Valid, text-free PDF: each page has a coloured rectangle we can sample.
function pdfData(pageCount: number, width = 612, height = 792) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, i) => `${i + 4} 0 R`).join(' ')}] >>`]
  const stream = '0.2 0.4 0.8 rg 20 20 100 100 re f'
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  for (let i = 0; i < pageCount; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << >> /Contents 3 0 R >>`)
  }
  let data = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((body, i) => {
    offsets.push(data.length)
    data += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = data.length
  data += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  data += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  data += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return `data:application/pdf;base64,${btoa(data)}`
}

async function check() {
  const errors: string[] = []
  const workers = new Set<Worker>()
  const NativeWorker = window.Worker
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      workers.add(this)
    }
    terminate() { workers.delete(this); super.terminate() }
  }
  const files = {
    '/long.pdf': pdfData(100),
    '/other.pdf': pdfData(100, 700, 800),
    '/large-page.pdf': pdfData(1, 5000, 5000),
    '/book.xlsx': ''
  }
  let nextFile = '/long.pdf'
  let reads = 0
  window.prime = {
    artifactChoose: async () => nextFile,
    artifactReadFile: async (path: string) => {
      reads++
      return path.endsWith('.pdb')
        ? { path, mime: 'text/plain', size: 100, content: 'HETATM    1  C   LIG A   1       0.000   0.000   0.000  1.00 10.00           C\nEND\n' }
        : { path, mime: 'application/pdf', size: 100, dataUrl: files[path as keyof typeof files] }
    }
  } as typeof window.prime
  localStorage.clear()
  const root = createRoot(document.getElementById('root')!)
  let artifacts = []
  const onToast = (message: string, kind?: string) => { if (kind === 'error') errors.push(message) }
  const mount = () => root.render(<StrictMode><FilesPanel agentId={null} artifacts={artifacts} onToast={onToast} /></StrictMode>)
  const click = (label: string) => {
    const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"],[title="${label}"]`)
    assert(button, `Missing button: ${label}`)
    button.click()
  }
  const canvases = () => [...document.querySelectorAll<HTMLCanvasElement>('.pdf-page-canvas')]
  const bytes = () => canvases().reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0)
  const checkBound = () => {
    assert(canvases().length > 0 && canvases().length <= 6, `Unbounded PDF canvas count: ${canvases().length}`)
    assert(bytes() <= 6 * 32_000_000, 'PDF canvas budget exceeded')
  }
  const releaseCheck = async (old: HTMLCanvasElement[]) => {
    await waitFor(() => old.every((canvas) => canvas.width === 0 && canvas.height === 0), 'Offscreen canvases retain their drawing buffers')
  }

  mount()
  await waitFor(() => document.querySelector('.artifact-upload-primary'), 'Files panel did not mount')
  const startupResources = performance.getEntriesByType('resource').map((entry) => entry.name)
  assert(!startupResources.some((url) => /\/(3Dmol|pdf)[-.]/i.test(url)), 'Heavy viewers loaded before opening a file')
  document.querySelector<HTMLButtonElement>('.artifact-upload-primary')!.click()
  await waitFor(() => document.querySelectorAll('.pdf-page-slot').length === 100 && canvases().length > 0, 'Long PDF did not render')
  await waitFor(() => canvases()[0]?.getContext('2d')?.getImageData(5, 5, 1, 1).data[3] === 255, 'PDF canvas was not painted')
  checkBound()
  assert(workers.size === 1, 'PDF must use one worker, not a main-thread fallback')
  const firstBytes = bytes()
  const firstCount = canvases().length
  const replaced = canvases()
  const scroll = document.querySelector<HTMLDivElement>('.pdf-canvas-wrap')!
  scroll.scrollTop = scroll.scrollHeight / 2
  await releaseCheck(replaced)
  await waitFor(() => canvases().length > 0, 'Scrolled PDF pages did not render')
  checkBound()
  click('Zoom in')
  await waitFor(() => document.querySelector('.pdf-controls')?.textContent?.includes('130%'), 'Zoom failed')
  checkBound()
  click('Zoom out')
  const beforeRerender = reads
  // A streaming run may replace the artifact list without changing this file.
  artifacts = []
  mount()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert(reads === beforeRerender, 'Unrelated render reloaded the file')

  nextFile = '/other.pdf'
  click('Open another file')
  await waitFor(() => canvases().some((canvas) => canvas.style.width === '804px'), 'Same-length second PDF did not replace the first')
  checkBound()
  click('Open in full screen')
  await waitFor(() => document.querySelector('.artifact-fullscreen') && canvases().length > 0, 'Fullscreen PDF failed')
  click('Back to panel')
  await waitFor(() => !document.querySelector('.artifact-fullscreen') && canvases().length > 0, 'Returning from fullscreen failed')

  nextFile = '/large-page.pdf'
  click('Open another file')
  await waitFor(() => document.querySelectorAll('.pdf-page-slot').length === 1 && canvases().length === 1, 'Large page did not render')
  assert(bytes() <= 32_000_000, 'Large page exceeds the 32 MB cap')
  const closed = canvases()
  click('Close large-page.pdf')
  await releaseCheck(closed)

  // Reopen the structure repeatedly; a new viewer would add global listeners each time.
  nextFile = '/structure.pdb'
  let structureCanvas: HTMLCanvasElement | null = null
  for (let i = 0; i < 4; i++) {
    click('Open another file')
    await waitFor(() => document.querySelector('.structure-canvas canvas'), 'Structure viewer did not render')
    const canvas = document.querySelector<HTMLCanvasElement>('.structure-canvas canvas')!
    if (structureCanvas) assert(canvas === structureCanvas, 'Structure viewer was recreated')
    structureCanvas = canvas
    click('Close structure.pdb')
    await waitFor(() => !document.querySelector('.structure-canvas'), 'Structure did not close')
    assert(canvas.width <= 2 && canvas.height <= 2, 'Closed structure retains a full-size drawing buffer')
    await waitFor(() => canvases().length > 0, 'PDF did not resume after closing structure')
  }
  const xlsx = await import('xlsx')
  const workbook = xlsx.utils.book_new()
  const sheet = xlsx.utils.aoa_to_sheet(Array.from({ length: 1500 }, (_, row) => [row, 'value']))
  sheet['CW1'] = { t: 's', v: 'outside-column-limit' }
  sheet['!ref'] = 'A1:CW1500'
  xlsx.utils.book_append_sheet(workbook, sheet, 'Data')
  files['/book.xlsx'] = `data:application/octet-stream;base64,${xlsx.write(workbook, { type: 'base64', bookType: 'xlsx' })}`
  nextFile = '/book.xlsx'
  click('Open another file')
  await waitFor(() => document.querySelectorAll('.excel-grid tbody tr').length === 500, 'Workbook preview did not respect its row limit')
  assert(document.querySelectorAll('.excel-grid thead th').length === 81, 'Workbook exceeds its 80-column limit')
  click('Close book.xlsx')
  await waitFor(() => canvases().length > 0, 'PDF did not resume after closing workbook')
  const remaining = canvases()
  root.unmount()
  await releaseCheck(remaining)
  await waitFor(() => workers.size === 0, 'PDF worker remains alive after closing')
  assert(document.querySelectorAll('canvas').length === 0, 'Preview canvases remain after closing')
  assert(errors.length === 0, errors.join('\n'))
  return {
    checks: 'PDF scroll, zoom, replacement, fullscreen, bitmap cap, close; structure reuse; workbook bounds; no startup viewer loads',
    pdfPages: 100, initialCanvases: firstCount, initialCanvasBytes: firstBytes,
    estimatedAllPageCanvasBytes: firstBytes / firstCount * 100,
    structureReopens: 4, workersAfterClose: workers.size, errors
  }
}

Object.assign(window, { previewChecks: check().catch((error) => ({ error: error.stack ?? String(error) })) })
