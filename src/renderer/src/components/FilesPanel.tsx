import { useEffect, useMemo, useRef, useState } from 'react'
import type { Artifact } from '@shared/types'
import type { GLViewer } from '3dmol'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import katex from 'katex'
import type { WorkBook } from 'xlsx'
import 'katex/dist/katex.min.css'

interface Props {
  agentId: string | null
  sessionId?: string | null
  artifacts: Artifact[]
  onToast?: (text: string, kind?: 'info' | 'success' | 'warning' | 'error') => void
  previewPath?: string | null
  onPreviewPathChange?: (path: string | null) => void
}

type ReadResult = {
  path: string
  size: number
  mime: string
  content?: string
  dataUrl?: string
}

function extension(path: string): string {
  return path.toLowerCase().split('.').pop() ?? ''
}

function kindFromPath(path: string): Artifact['kind'] {
  const ext = extension(path)
  if (['pdb', 'pdbqt', 'cif', 'mmcif', 'sdf', 'mol', 'mol2', 'xyz'].includes(ext)) return 'structure'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image'
  if (['csv', 'tsv', 'json', 'jsonl', 'xlsx', 'xls'].includes(ext)) return 'table'
  if (['md', 'txt', 'log', 'html', 'xml', 'yaml', 'yml', 'toml', 'pdf', 'docx', 'pptx'].includes(ext)) return 'document'
  if (['fasta', 'fa', 'fastq', 'fq', 'bed', 'gff', 'gtf', 'vcf'].includes(ext)) return 'text'
  return 'unknown'
}

function shortName(path: string): string {
  return path.split('/').pop() || path
}

function kindLabel(kind: Artifact['kind']): string {
  switch (kind) {
    case 'structure': return 'Structure'
    case 'image': return 'Image'
    case 'table': return 'Data'
    case 'document': return 'Document'
    case 'text': return 'Text'
    default: return 'File'
  }
}

export function matchesArtifactSearch(artifact: Artifact, term: string): boolean {
  if (!term) return true
  return [artifact.path, kindLabel(artifact.kind), artifact.status, artifact.source]
    .some((value) => value?.toLowerCase().includes(term))
}

function diffCount(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

function currentThemeBackground(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff'
}

function ToolbarMenu<T extends string>({ label, value, options, onChange }: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}): JSX.Element {
  const menuRef = useRef<HTMLDetailsElement>(null)
  const selected = options.find((option) => option.value === value)?.label ?? value
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) menuRef.current?.removeAttribute('open')
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [])
  return (
    <div className="structure-control">
      <span>{label}</span>
      <details className="structure-menu" ref={menuRef}>
        <summary><span>{selected}</span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" /></svg></summary>
        <div className="structure-menu-popover">
          {options.map((option) => (
            <button
              type="button"
              className={option.value === value ? 'selected' : ''}
              key={option.value}
              onClick={() => {
                onChange(option.value)
                menuRef.current?.removeAttribute('open')
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      </details>
    </div>
  )
}

// ponytail: one visible structure at a time. 3Dmol has no destroy API for its
// global listeners; reuse one empty viewer instead of retaining one per tab.
let structureViewer: { host: HTMLDivElement; viewer: GLViewer } | null = null

function PdbViewer({ content, format, fullscreen, onToast }: { content: string; format: string; fullscreen: boolean; onToast?: Props['onToast'] }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<GLViewer | null>(null)
  const [ready, setReady] = useState(false)
  const [representation, setRepresentation] = useState<'cartoon' | 'stick' | 'sphere'>('cartoon')
  const [color, setColor] = useState<'chain' | 'element' | 'spectrum'>('chain')
  const [backgroundMode, setBackgroundMode] = useState<'theme' | 'light' | 'dark'>('theme')
  const [themeBackground, setThemeBackground] = useState(currentThemeBackground)
  const resolvedBackground = backgroundMode === 'theme'
    ? themeBackground
    : backgroundMode === 'light' ? '#ffffff' : '#10131a'

  useEffect(() => {
    const syncTheme = () => setThemeBackground(currentThemeBackground())
    window.addEventListener('prime-theme-change', syncTheme)
    return () => window.removeEventListener('prime-theme-change', syncTheme)
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    setReady(false)
    void import('3dmol').then(($3Dmol) => {
      if (disposed) return
      if (!structureViewer) {
        const container = document.createElement('div')
        container.style.cssText = 'position:absolute;inset:0'
        host.appendChild(container)
        structureViewer = { host: container, viewer: $3Dmol.createViewer(container) }
      }
      host.appendChild(structureViewer.host)
      const viewer = structureViewer.viewer
      viewerRef.current = viewer
      viewer.resize()
      viewer.addModel(content, format)
      viewer.zoomTo()
      setReady(true)
    }).catch((reason) => {
      if (!disposed) onToast?.(`Could not preview structure: ${String(reason)}`, 'error')
    })
    return () => {
      disposed = true
      viewerRef.current?.stopAnimate()
      viewerRef.current?.clear()
      // Release the large drawing buffer while this viewer is detached.
      viewerRef.current?.setWidth(1)
      viewerRef.current?.setHeight(1)
      viewerRef.current = null
      host.replaceChildren()
    }
  }, [content, format, onToast])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.setBackgroundColor(resolvedBackground, 1)
    viewer.render()
  }, [resolvedBackground, ready])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const scheme = color === 'chain' ? 'chain' : color === 'element' ? 'Jmol' : 'spectrum'
    const style = representation === 'cartoon'
      ? { cartoon: { colorscheme: scheme } }
      : representation === 'stick'
        ? { stick: { colorscheme: scheme, radius: 0.16 } }
        : { sphere: { colorscheme: scheme, scale: 0.28 } }
    viewer.setStyle({}, style)
    viewer.render()
  }, [representation, color, ready])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const timer = window.setTimeout(() => {
      viewer.resize()
      viewer.zoomTo()
      viewer.render()
    }, 50)
    return () => window.clearTimeout(timer)
  }, [fullscreen, ready])

  const screenshot = () => {
    const uri = viewerRef.current?.pngURI?.()
    if (!uri) return
    const link = document.createElement('a')
    link.href = uri
    link.download = 'structure-preview.png'
    link.click()
  }

  return (
    <div className="structure-preview">
      <div className="structure-canvas" ref={hostRef} />
      <div className="structure-controls">
        <ToolbarMenu
          label="View"
          value={representation}
          options={[
            { value: 'cartoon', label: 'Cartoon' },
            { value: 'stick', label: 'Sticks' },
            { value: 'sphere', label: 'Spheres' }
          ]}
          onChange={setRepresentation}
        />
        <ToolbarMenu
          label="Color"
          value={color}
          options={[
            { value: 'chain', label: 'By chain' },
            { value: 'element', label: 'By element' },
            { value: 'spectrum', label: 'Spectrum' }
          ]}
          onChange={setColor}
        />
        <ToolbarMenu
          label="Background"
          value={backgroundMode}
          options={[
            { value: 'theme', label: 'Theme' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' }
          ]}
          onChange={setBackgroundMode}
        />
        <button type="button" className="artifact-tool-btn" onClick={() => viewerRef.current?.zoomTo()}>Fit</button>
        <button type="button" className="artifact-tool-btn" onClick={screenshot}>Export PNG</button>
      </div>
    </div>
  )
}

function DataPreview({ content }: { content: string }): JSX.Element {
  const rows = useMemo(() => content.trim().split(/\r?\n/, 300).map((line) => line.split(/\t|,/)), [content])
  if (rows.length === 0) return <div className="artifact-empty">No rows to display.</div>
  const headers = rows[0]
  return (
    <div className="artifact-table-wrap">
      <table className="artifact-table">
        <thead><tr>{headers.map((value, index) => <th key={index}>{value || `Column ${index + 1}`}</th>)}</tr></thead>
        <tbody>
          {rows.slice(1).map((row, rowIndex) => (
            <tr key={rowIndex}>{headers.map((_, columnIndex) => <td key={columnIndex}>{row[columnIndex] ?? ''}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function decodeDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('Invalid file data')
  const binary = window.atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function useGestureZoom(
  ref: React.RefObject<HTMLElement | null>,
  initial: number,
  min: number,
  max: number
): [number, (value: number) => void] {
  const [scale, setScale] = useState(initial)

  const setBounded = (value: number) => {
    setScale(Math.min(max, Math.max(min, value)))
  }

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const pointers = new Map<number, { x: number; y: number }>()
    let previousDistance = 0

    const distance = () => {
      const values = [...pointers.values()]
      if (values.length < 2) return 0
      return Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y)
    }
    const onWheel = (event: WheelEvent) => {
      // macOS trackpad pinch gestures arrive in Chromium as ctrl+wheel.
      if (!event.ctrlKey) return
      event.preventDefault()
      setScale((current) => Math.min(max, Math.max(min, current * Math.exp(-event.deltaY * 0.01))))
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size === 2) previousDistance = distance()
    }
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || !pointers.has(event.pointerId)) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size !== 2) return
      const nextDistance = distance()
      if (!previousDistance || !nextDistance) return
      event.preventDefault()
      setScale((current) => Math.min(max, Math.max(min, current * (nextDistance / previousDistance))))
      previousDistance = nextDistance
    }
    const onPointerEnd = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return
      pointers.delete(event.pointerId)
      if (pointers.size < 2) previousDistance = 0
    }

    element.addEventListener('wheel', onWheel, { passive: false })
    element.addEventListener('pointerdown', onPointerDown)
    element.addEventListener('pointermove', onPointerMove, { passive: false })
    element.addEventListener('pointerup', onPointerEnd)
    element.addEventListener('pointercancel', onPointerEnd)
    return () => {
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('pointerup', onPointerEnd)
      element.removeEventListener('pointercancel', onPointerEnd)
    }
  }, [max, min, ref])

  return [scale, setBounded]
}

function neutralizeDocumentLinks(root: HTMLElement): void {
  for (const anchor of Array.from(root.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href') ?? ''
    if (href.startsWith('#')) continue
    anchor.removeAttribute('href')
    if (/^https?:\/\//i.test(href)) {
      anchor.setAttribute('data-external-href', href)
      anchor.setAttribute('title', href)
      anchor.setAttribute('role', 'link')
    }
  }
}

function DocxPreview({ dataUrl, onToast }: { dataUrl: string; onToast?: Props['onToast'] }): JSX.Element {
  const gestureRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [zoom] = useGestureZoom(gestureRef, 1, 0.75, 2)
  const [error, setError] = useState('')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let current = true
    host.replaceChildren()
    setError('')
    void import('docx-preview')
      .then(({ renderAsync }) => current ? renderAsync(decodeDataUrl(dataUrl), host, host, {
        className: 'prime-docx',
        breakPages: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        renderComments: false,
        useBase64URL: true
      }) : undefined)
      .then(() => {
        if (!current) host.replaceChildren()
        else neutralizeDocumentLinks(host)
      })
      .catch((reason) => {
        if (!current) return
        const message = reason instanceof Error ? reason.message : String(reason)
        setError(message)
        onToast?.(`Could not preview Word document: ${message}`, 'error')
      })
    // docx-preview copies hyperlink targets from the document verbatim, and
    // the preview lives in the app's own DOM. Never let a document link
    // navigate this window or run script: web links open in the browser.
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a')
      if (!anchor || !host.contains(anchor)) return
      event.preventDefault()
      const target = anchor.getAttribute('data-external-href')
      if (target && /^https?:\/\//i.test(target)) void window.prime.openExternal(target)
    }
    host.addEventListener('click', onClick, true)
    return () => {
      current = false
      host.removeEventListener('click', onClick, true)
      host.replaceChildren()
    }
  }, [dataUrl, onToast])

  return (
    <div className="office-preview docx-preview">
      {error && <span className="sr-only" role="status">{error}</span>}
      <div className="docx-pages gesture-zoom-surface" ref={gestureRef}>
        <div className="docx-zoom-stage" ref={hostRef} style={{ zoom }} />
        <span className="office-zoom-readout">{Math.round(zoom * 100)}%</span>
      </div>
    </div>
  )
}

function PowerPointPreview({ dataUrl, fullscreen, onToast }: { dataUrl: string; fullscreen: boolean; onToast?: Props['onToast'] }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<import('pptx-browser').default | null>(null)
  const [slideCount, setSlideCount] = useState(0)
  const [currentSlide, setCurrentSlide] = useState(0)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [zoom, setZoom] = useGestureZoom(hostRef, 1, 0.75, 2)

  useEffect(() => {
    let current = true
    setReady(false)
    setError('')
    setCurrentSlide(0)
    void import('pptx-browser')
      .then(async ({ default: PptxRenderer }) => {
        if (!current) return
        const renderer = new PptxRenderer()
        try {
          await renderer.load(decodeDataUrl(dataUrl))
        } catch (reason) {
          renderer.destroy()
          throw reason
        }
        if (!current) {
          renderer.destroy()
          return
        }
        rendererRef.current = renderer
        setSlideCount(renderer.slideCount)
        setReady(true)
      })
      .catch((reason) => {
        if (!current) return
        const message = reason instanceof Error ? reason.message : String(reason)
        setError(message)
        onToast?.(`Could not preview PowerPoint: ${message}`, 'error')
      })
    return () => {
      current = false
      rendererRef.current?.destroy()
      rendererRef.current = null
    }
  }, [dataUrl, onToast])

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    const renderer = rendererRef.current
    if (!host || !canvas || !renderer || !ready) return
    let disposed = false
    let timer = 0
    const render = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (disposed) return
        const width = Math.max(320, Math.min(2400, (host.clientWidth - 32) * zoom))
        void renderer.renderSlide(currentSlide, canvas, width).catch((reason: unknown) => {
          if (disposed) return
          const message = reason instanceof Error ? reason.message : String(reason)
          setError(message)
          onToast?.(`Could not render slide: ${message}`, 'error')
        })
      }, 50)
    }
    render()
    const observer = new ResizeObserver(render)
    observer.observe(host)
    return () => {
      disposed = true
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [currentSlide, fullscreen, onToast, ready, zoom])

  return (
    <div className="office-preview pptx-preview">
      <div className="pptx-canvas-wrap gesture-zoom-surface" ref={hostRef}>
        {!ready && !error && <div className="artifact-loading"><span className="sp-stream-dot" /> Loading slides…</div>}
        {error && <span className="sr-only" role="status">{error}</span>}
        <canvas ref={canvasRef} aria-label={`Slide ${currentSlide + 1}`} style={{ maxWidth: zoom <= 1 ? '100%' : 'none' }} />
      </div>
      <div className="office-controls">
        <span>{slideCount > 0 ? `${slideCount} slide${slideCount === 1 ? '' : 's'}` : 'Loading…'}</span>
        <div className="pdf-control-spacer" />
        <button type="button" disabled={zoom <= 0.75} onClick={() => setZoom(zoom - 0.15)} aria-label="Zoom out">−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" disabled={zoom >= 2} onClick={() => setZoom(zoom + 0.15)} aria-label="Zoom in">+</button>
        <button type="button" disabled={currentSlide <= 0} onClick={() => setCurrentSlide((value) => Math.max(0, value - 1))} aria-label="Previous slide">‹</button>
        <span>{slideCount > 0 ? `${currentSlide + 1} / ${slideCount}` : '—'}</span>
        <button type="button" disabled={slideCount === 0 || currentSlide >= slideCount - 1} onClick={() => setCurrentSlide((value) => Math.min(slideCount - 1, value + 1))} aria-label="Next slide">›</button>
      </div>
    </div>
  )
}

function ExcelPreview({ dataUrl, onToast }: { dataUrl: string; onToast?: Props['onToast'] }): JSX.Element {
  const gridRef = useRef<HTMLDivElement>(null)
  const workbookRef = useRef<WorkBook | null>(null)
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [activeSheet, setActiveSheet] = useState('')
  const [rows, setRows] = useState<unknown[][]>([])
  const [error, setError] = useState('')
  const [zoom, setZoom] = useGestureZoom(gridRef, 1, 0.75, 2)

  useEffect(() => {
    let current = true
    setError('')
    setRows([])
    setSheetNames([])
    void import('xlsx')
      .then((xlsx) => {
        if (!current) return
        const workbook = xlsx.read(decodeDataUrl(dataUrl), { type: 'array', cellDates: true, sheetRows: 500 })
        workbookRef.current = workbook
        setSheetNames(workbook.SheetNames)
        setActiveSheet(workbook.SheetNames[0] ?? '')
      })
      .catch((reason) => {
        if (!current) return
        const message = reason instanceof Error ? reason.message : String(reason)
        setError(message)
        onToast?.(`Could not preview Excel file: ${message}`, 'error')
      })
    return () => {
      current = false
      workbookRef.current = null
    }
  }, [dataUrl, onToast])

  useEffect(() => {
    const workbook = workbookRef.current
    if (!workbook || !activeSheet) return
    let current = true
    void import('xlsx').then((xlsx) => {
      if (!current) return
      const sheet = workbook.Sheets[activeSheet]
      if (!sheet['!ref']) { setRows([]); return }
      const range = xlsx.utils.decode_range(sheet['!ref'])
      range.e.r = Math.min(range.e.r, range.s.r + 499)
      range.e.c = Math.min(range.e.c, range.s.c + 79)
      const values = xlsx.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: false,
        defval: '',
        blankrows: false,
        range
      })
      setRows(values)
    })
    return () => { current = false }
  }, [activeSheet])

  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0)
  return (
    <div className="office-preview excel-preview">
      <div className="office-sheet-tabs" role="tablist" aria-label="Workbook sheets">
        {sheetNames.map((sheet) => (
          <button type="button" role="tab" aria-selected={sheet === activeSheet} className={sheet === activeSheet ? 'active' : ''} key={sheet} onClick={() => setActiveSheet(sheet)}>
            {sheet}
          </button>
        ))}
      </div>
      {error && <span className="sr-only" role="status">{error}</span>}
      {!error && activeSheet && rows.length === 0 && <div className="artifact-empty">This sheet is empty.</div>}
      {!error && rows.length > 0 && (
        <div className="excel-grid-wrap gesture-zoom-surface" ref={gridRef}>
          <table className="excel-grid" style={{ zoom }}>
            <thead>
              <tr>
                <th className="excel-corner" />
                {Array.from({ length: columnCount }, (_, column) => <th key={column}>{excelColumnName(column)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <th>{rowIndex + 1}</th>
                  {Array.from({ length: columnCount }, (_, column) => <td key={column} title={String(row[column] ?? '')}>{String(row[column] ?? '')}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="office-controls">
        <span>{activeSheet || 'Loading workbook…'}</span>
        <div className="pdf-control-spacer" />
        <button type="button" disabled={zoom <= 0.75} onClick={() => setZoom(zoom - 0.15)} aria-label="Zoom out">−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" disabled={zoom >= 2} onClick={() => setZoom(zoom + 0.15)} aria-label="Zoom in">+</button>
        {rows.length >= 500 && <span>Showing first 500 rows</span>}
        {columnCount >= 80 && <span>First 80 columns</span>}
      </div>
    </div>
  )
}

function excelColumnName(index: number): string {
  let value = index + 1
  let name = ''
  while (value > 0) {
    value--
    name = String.fromCharCode(65 + (value % 26)) + name
    value = Math.floor(value / 26)
  }
  return name
}

function PdfPage({ pdf, pageNumber, scale, rootRef, pixelRatio, onToast }: { pdf: PDFDocumentProxy; pageNumber: number; scale: number; rootRef: React.RefObject<HTMLDivElement | null>; pixelRatio: number; onToast?: Props['onToast'] }): JSX.Element {
  const slotRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(pageNumber === 1)
  const [pageSize, setPageSize] = useState({ width: 612, height: 792 })

  useEffect(() => {
    const slot = slotRef.current
    const root = rootRef.current
    if (!slot || !root) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root, rootMargin: '600px 0px' })
    observer.observe(slot)
    return () => observer.disconnect()
  }, [rootRef])

  useEffect(() => {
    if (!visible) return
    const slot = slotRef.current
    if (!slot) return
    let cancelled = false
    let renderTask: RenderTask | null = null
    let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null
    let canvas: HTMLCanvasElement | null = null
    void pdf.getPage(pageNumber).then((nextPage) => {
      page = nextPage
      if (cancelled) { page.cleanup(); return }
      const viewport = page.getViewport({ scale })
      const original = page.getViewport({ scale: 1 })
      setPageSize({ width: original.width, height: original.height })
      canvas = document.createElement('canvas')
      canvas.className = 'pdf-page-canvas'
      // Bound unusually large page bitmaps to 32 MB, including at high zoom.
      const ratio = Math.min(pixelRatio, Math.sqrt(8_000_000 / (viewport.width * viewport.height)))
      canvas.width = Math.floor(viewport.width * ratio)
      canvas.height = Math.floor(viewport.height * ratio)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      slot.replaceChildren(canvas)
      const context = canvas.getContext('2d')
      if (!context) return
      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0]
      })
      return renderTask.promise
    }).catch((reason) => {
      if (cancelled || (reason instanceof Error && reason.name === 'RenderingCancelledException')) return
      onToast?.(`Could not render PDF page: ${reason instanceof Error ? reason.message : String(reason)}`, 'error')
    })
    return () => {
      cancelled = true
      renderTask?.cancel()
      page?.cleanup()
      if (canvas) { canvas.width = 0; canvas.height = 0 }
      slot.replaceChildren()
    }
  }, [onToast, pageNumber, pdf, pixelRatio, scale, visible])

  return <div ref={slotRef} className="pdf-page-slot" style={{ width: pageSize.width * scale, height: pageSize.height * scale, flexShrink: 0 }} aria-label={`PDF page ${pageNumber}`} />
}

function PdfPreview({ dataUrl, onToast }: { dataUrl: string; onToast?: Props['onToast'] }): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const pageCount = pdf?.numPages ?? 0
  const [scale, setScale] = useGestureZoom(wrapRef, 1.15, 0.65, 2)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    setPdf(null)
    setError('')
    let task: ReturnType<typeof import('pdfjs-dist')['getDocument']> | null = null
    void Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.mjs?url')]).then(([pdfjs, worker]) => {
      if (disposed) return null
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      task = pdfjs.getDocument({ data: decodeDataUrl(dataUrl) })
      return task.promise
    }).then((pdf) => {
      if (!pdf) return
      if (!disposed) setPdf(pdf)
    }).catch((reason) => {
      if (!disposed) {
        const message = reason instanceof Error ? reason.message : String(reason)
        setError(message)
        onToast?.(message, 'error')
      }
    })
    return () => {
      disposed = true
      void task?.destroy()
    }
  }, [dataUrl, onToast])

  if (error) return <span className="sr-only" role="status">{error}</span>
  return (
    <div className="pdf-preview">
      <div className="pdf-canvas-wrap gesture-zoom-surface" ref={wrapRef}>
        {pdf && Array.from({ length: pageCount }, (_, index) => (
          <PdfPage key={index + 1} pdf={pdf} pageNumber={index + 1} scale={scale} rootRef={wrapRef} pixelRatio={Math.min(window.devicePixelRatio || 1, 2)} onToast={onToast} />
        ))}
      </div>
      <div className="pdf-controls">
        <span>{pageCount > 0 ? `${pageCount} pages` : 'Loading…'}</span>
        <div className="pdf-control-spacer" />
        <button type="button" disabled={scale <= .65} onClick={() => setScale(Math.max(.65, scale - .15))} aria-label="Zoom out">−</button>
        <span>{Math.round(scale * 100)}%</span>
        <button type="button" disabled={scale >= 2} onClick={() => setScale(Math.min(2, scale + .15))} aria-label="Zoom in">+</button>
      </div>
    </div>
  )
}

function ArtifactPreview({ artifact, data, fullscreen, onToast }: { artifact: Artifact; data: ReadResult; fullscreen: boolean; onToast?: (text: string, kind?: 'info' | 'success' | 'warning' | 'error') => void }): JSX.Element {
  const ext = extension(artifact.path)
  if (artifact.kind === 'structure' && data.content) {
    return <PdbViewer content={data.content} format={ext === 'mmcif' ? 'cif' : ext} fullscreen={fullscreen} onToast={onToast} />
  }
  if (artifact.kind === 'image' && data.dataUrl) {
    return <div className="artifact-image-wrap"><img src={data.dataUrl} alt={shortName(artifact.path)} /></div>
  }
  if (ext === 'pdf' && data.dataUrl) {
    return <PdfPreview dataUrl={data.dataUrl} onToast={onToast} />
  }
  if (ext === 'docx' && data.dataUrl) return <DocxPreview dataUrl={data.dataUrl} onToast={onToast} />
  if (ext === 'pptx' && data.dataUrl) return <PowerPointPreview dataUrl={data.dataUrl} fullscreen={fullscreen} onToast={onToast} />
  if (['xlsx', 'xls'].includes(ext) && data.dataUrl) return <ExcelPreview dataUrl={data.dataUrl} onToast={onToast} />
  if (artifact.kind === 'table' && data.content) {
    return <DataPreview content={data.content} />
  }
  if ((artifact.kind === 'document' || artifact.kind === 'text') && data.content) {
    return <MarkdownPreview content={data.content} />
  }
  return <pre className="artifact-code">{data.content ?? 'This file cannot be previewed here.'}</pre>
}

const MARKDOWN_FENCE_RE = /```(\w*)\r?\n([\s\S]*?)```/g

type MarkdownTable = { headers: string[]; rows: string[][] }

function markdownTableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = markdownTableCells(line)
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

export function parseMarkdownTable(lines: string[], start: number): { table: MarkdownTable; end: number } | null {
  const header = lines[start]?.trim() ?? ''
  const separator = lines[start + 1]?.trim() ?? ''
  if (!header.includes('|') || !isMarkdownTableSeparator(separator)) return null
  const headers = markdownTableCells(header)
  const separatorCells = markdownTableCells(separator)
  if (headers.length !== separatorCells.length) return null

  const rows: string[][] = []
  let end = start + 2
  while (end < lines.length && lines[end].includes('|') && lines[end].trim()) {
    const row = markdownTableCells(lines[end])
    rows.push([...row, ...Array(Math.max(0, headers.length - row.length)).fill('')].slice(0, headers.length))
    end++
  }
  return { table: { headers, rows }, end }
}

function MarkdownPreview({ content }: { content: string }): JSX.Element {
  const nodes = useMemo(() => {
    const out: JSX.Element[] = []
    let key = 0
    const pushText = (chunk: string) => {
      for (const block of chunk.split(/\n{2,}/)) {
        const para = block.trim()
        if (!para) continue
        const lines = para.split(/\r?\n/)
        const tableStart = lines.findIndex((_line, index) => parseMarkdownTable(lines, index) !== null)
        if (tableStart >= 0) {
          const before = lines.slice(0, tableStart).join('\n').trim()
          if (before) pushText(before)
          const parsed = parseMarkdownTable(lines, tableStart)
          if (parsed) {
            out.push(
              <div key={key++} className="artifact-md-table-wrap">
                <table className="artifact-md-table">
                  <thead><tr>{parsed.table.headers.map((header, index) => <th key={index}>{renderMarkdownInline(header)}</th>)}</tr></thead>
                  <tbody>{parsed.table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{renderMarkdownInline(cell)}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )
            const after = lines.slice(parsed.end).join('\n').trim()
            if (after) pushText(after)
          }
          continue
        }
        if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(para)) {
          out.push(<hr key={key++} className="artifact-md-rule" />)
          continue
        }
        const heading = para.match(/^(#{1,4})\s+(.+)/)
        if (heading) {
          const level = heading[1].length
          out.push(<div key={key++} className={`artifact-md-h${level}`}>{renderMarkdownInline(heading[2])}</div>)
          continue
        }
        if (para.startsWith('- ') || para.startsWith('* ')) {
          out.push(
            <ul key={key++} className="artifact-md-ul">
              {para.split('\n').filter(Boolean).map((line, li) => (
                <li key={li}>{renderMarkdownInline(line.replace(/^[-*]\s+/, ''))}</li>
              ))}
            </ul>
          )
          continue
        }
        if (/^\d+[.)]\s/.test(para)) {
          out.push(
            <ol key={key++} className="artifact-md-ol">
              {para.split('\n').filter(Boolean).map((line, li) => (
                <li key={li}>{renderMarkdownInline(line.replace(/^\d+[.)]\s+/, ''))}</li>
              ))}
            </ol>
          )
          continue
        }
        if (lines.every((line) => /^>\s?/.test(line))) {
          out.push(<blockquote key={key++} className="artifact-md-quote">{lines.map((line, index) => <span key={index}>{index > 0 && <br />}{renderMarkdownInline(line.replace(/^>\s?/, ''))}</span>)}</blockquote>)
          continue
        }
        out.push(<p key={key++} className="artifact-md-p">{renderMarkdownInline(para)}</p>)
      }
    }
    let last = 0
    let m: RegExpExecArray | null
    while ((m = MARKDOWN_FENCE_RE.exec(content)) !== null) {
      if (m.index > last) pushText(content.slice(last, m.index))
      out.push(
        <div key={key++} className="artifact-codeblock">
          <div className="artifact-codeblock-head">{m[1] || 'code'}</div>
          <pre className="artifact-codeblock-pre">{m[2]}</pre>
        </div>
      )
      last = m.index + m[0].length
    }
    if (last < content.length) pushText(content.slice(last))
    return out
  }, [content])

  return <div className="artifact-markdown">{nodes}</div>
}

function renderMarkdownInline(text: string): (JSX.Element | string)[] {
  const re = /(\$\$[^$]+\$\$|\$[^$]+\$|`[^`]+`|\*\*[^*]+\*\*)/g
  const nodes: (JSX.Element | string)[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('$$')) {
      nodes.push(<span key={key++} dangerouslySetInnerHTML={{ __html: katex.renderToString(tok.slice(2, -2), { displayMode: false, throwOnError: false }) }} />)
    } else if (tok.startsWith('$')) {
      nodes.push(<span key={key++} dangerouslySetInnerHTML={{ __html: katex.renderToString(tok.slice(1, -1), { displayMode: false, throwOnError: false }) }} />)
    } else if (tok.startsWith('`')) {
      nodes.push(<code key={key++} className="md-inline-code">{tok.slice(1, -1)}</code>)
    } else {
      nodes.push(<strong key={key++}>{tok.slice(2, -2)}</strong>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function ArtifactRow({ artifact, onOpen, onRemove }: { artifact: Artifact; onOpen: () => void; onRemove: () => void }): JSX.Element {
  const stats = diffCount(artifact.diff)
  return (
    <div className="artifact-row-wrap">
      <button className="artifact-row" type="button" onClick={onOpen}>
        <span className="artifact-row-copy">
          <strong>{shortName(artifact.path)}</strong>
          <small>{artifact.source === 'uploaded' ? 'Uploaded' : artifact.status} · {kindLabel(artifact.kind)} · {artifact.path}</small>
        </span>
        <span className="artifact-row-meta">
          {stats.added > 0 && <b className="diff-added">+{stats.added}</b>}
          {stats.removed > 0 && <b className="diff-removed">-{stats.removed}</b>}
          <span>›</span>
        </span>
      </button>
      <button type="button" className="artifact-row-remove" title={`Remove ${shortName(artifact.path)} from Files`} aria-label={`Remove ${shortName(artifact.path)} from Files`} onClick={onRemove}>×</button>
    </div>
  )
}

export default function FilesPanel({ agentId, sessionId = null, artifacts, onToast, previewPath = null, onPreviewPathChange }: Props): JSX.Element {
  const uploadedStorageKey = 'prime.files.uploaded.v1'
  const runStorageKey = 'prime.files.runs.v1'
  const dismissedStorageKey = 'prime.files.dismissed.v1'
  const [activePath, setActivePath] = useState<string | null>(null)
  const [openPaths, setOpenPaths] = useState<string[]>([])
  const [linkedArtifacts, setLinkedArtifacts] = useState<Artifact[]>([])
  useEffect(() => setLinkedArtifacts([]), [agentId, sessionId])
  const [data, setData] = useState<ReadResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const [search, setSearch] = useState('')
  const [dismissedPaths, setDismissedPaths] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(dismissedStorageKey)
      const paths = raw ? JSON.parse(raw) : []
      return new Set(Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : [])
    } catch {
      return new Set()
    }
  })
  const [uploadedArtifacts, setUploadedArtifacts] = useState<Artifact[]>(() => {
    try {
      const raw = window.localStorage.getItem(uploadedStorageKey)
      const paths = raw ? JSON.parse(raw) : []
      if (!Array.isArray(paths)) return []
      return paths.filter((path): path is string => typeof path === 'string').map((path) => ({
        path,
        status: 'added' as const,
        kind: kindFromPath(path),
        diff: '',
        source: 'uploaded' as const
      }))
    } catch {
      return []
    }
  })
  const [storedRunArtifacts, setStoredRunArtifacts] = useState<Artifact[]>(() => {
    if (!agentId) return []
    try {
      const raw = window.localStorage.getItem(runStorageKey)
      const saved = raw ? JSON.parse(raw) : {}
      const items = saved && typeof saved === 'object' ? saved[`${agentId}::${sessionId ?? ''}`] : []
      return Array.isArray(items) ? items : []
    } catch {
      return []
    }
  })
  const runArtifacts = useMemo(() => {
    const byPath = new Map<string, Artifact>()
    for (const item of storedRunArtifacts) byPath.set(item.path, item)
    for (const item of artifacts) byPath.set(item.path, item)
    for (const item of linkedArtifacts) if (!byPath.has(item.path)) byPath.set(item.path, item)
    return [...byPath.values()]
  }, [artifacts, storedRunArtifacts, linkedArtifacts])
  const visibleRunArtifacts = useMemo(() => runArtifacts.filter((artifact) => !dismissedPaths.has(artifact.path)), [dismissedPaths, runArtifacts])
  const visibleUploadedArtifacts = useMemo(() => uploadedArtifacts.filter((artifact) => !dismissedPaths.has(artifact.path)), [dismissedPaths, uploadedArtifacts])
  const allArtifacts = useMemo(() => [...visibleRunArtifacts, ...visibleUploadedArtifacts], [visibleRunArtifacts, visibleUploadedArtifacts])
  const searchTerm = search.trim().toLowerCase()
  const filteredRunArtifacts = useMemo(() => visibleRunArtifacts.filter((artifact) => matchesArtifactSearch(artifact, searchTerm)), [searchTerm, visibleRunArtifacts])
  const filteredUploadedArtifacts = useMemo(() => visibleUploadedArtifacts.filter((artifact) => matchesArtifactSearch(artifact, searchTerm)), [searchTerm, visibleUploadedArtifacts])
  const filteredArtifactCount = filteredRunArtifacts.length + filteredUploadedArtifacts.length
  const selected = useMemo(
    () => (activePath ? allArtifacts.find((item) => item.path === activePath) ?? null : null),
    [activePath, allArtifacts]
  )
  const selectedPath = selected?.path
  const selectedSource = selected?.source
  const selectedDiff = selected?.diff
  const selectedMessageId = selected?.messageId

  useEffect(() => {
    if (!agentId) {
      setStoredRunArtifacts([])
      return
    }
    setStoredRunArtifacts(() => {
      let savedForAgent: Artifact[] = []
      try {
        const raw = window.localStorage.getItem(runStorageKey)
        const saved = raw ? JSON.parse(raw) : {}
        const items = saved && typeof saved === 'object' ? saved[`${agentId}::${sessionId ?? ''}`] : []
        if (Array.isArray(items)) savedForAgent = items
      } catch {
        // Ignore an unavailable or malformed lightweight index.
      }
      const byPath = new Map<string, Artifact>()
      for (const item of savedForAgent) byPath.set(item.path, item)
      for (const item of artifacts) byPath.set(item.path, { ...item, diff: item.diff.slice(0, 12_000) })
      const next = [...byPath.values()].slice(-64)
      try {
        const raw = window.localStorage.getItem(runStorageKey)
        const saved = raw ? JSON.parse(raw) : {}
        const map = saved && typeof saved === 'object' ? saved : {}
        map[`${agentId}::${sessionId ?? ''}`] = next
        window.localStorage.setItem(runStorageKey, JSON.stringify(map))
      } catch {
        // A full or unavailable local storage should not affect previewing.
      }
      return next
    })
  }, [agentId, sessionId, artifacts])

  useEffect(() => {
    setOpenPaths((current) => current.filter((path) => allArtifacts.some((item) => item.path === path)))
    if (activePath && !allArtifacts.some((item) => item.path === activePath)) setActivePath(null)
  }, [activePath, allArtifacts])

  useEffect(() => {
    if (!previewPath) return
    const artifact = allArtifacts.find((item) => item.path === previewPath)
    if (!artifact) {
      setDismissedPaths((current) => {
        const next = new Set(current)
        next.delete(previewPath)
        return next
      })
      setLinkedArtifacts((current) => current.some((item) => item.path === previewPath) ? current : [
        ...current, { path: previewPath, status: 'added', kind: kindFromPath(previewPath), diff: '' }
      ])
      return
    }
    setOpenPaths((current) => current.includes(previewPath) ? current : [...current, previewPath])
    setActivePath(previewPath)
    setFullscreen(false)
    onPreviewPathChange?.(null)
  }, [previewPath, allArtifacts, onPreviewPathChange])

  useEffect(() => {
    if (!selectedPath || (!agentId && selectedSource !== 'uploaded')) {
      setData(null)
      setLoading(false)
      setError('')
      return
    }
    let current = true
    setData(null)
    setLoading(true)
    setError('')
    const read = selectedSource === 'uploaded'
      ? window.prime.artifactReadFile(selectedPath)
      : window.prime.artifactRead(agentId ?? '', selectedPath)
    void read
      .then((result) => {
        if (current) setData(result as ReadResult)
      })
      .catch((reason) => {
        if (current) {
          const message = reason instanceof Error ? reason.message : String(reason)
          setError(message)
          onToast?.(message, 'error')
        }
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => { current = false }
  }, [agentId, selectedPath, selectedSource, selectedDiff, selectedMessageId, onToast])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openPreview = (artifact: Artifact) => {
    setOpenPaths((current) => current.includes(artifact.path) ? current : [...current, artifact.path])
    setActivePath(artifact.path)
    setFullscreen(false)
  }

  const uploadFile = async () => {
    const path = await window.prime.artifactChoose()
    if (!path) return
    const artifact: Artifact = { path, status: 'added', kind: kindFromPath(path), diff: '', source: 'uploaded' }
    setUploadedArtifacts((current) => [artifact, ...current.filter((item) => item.path !== path)])
    window.localStorage.setItem(uploadedStorageKey, JSON.stringify(
      [path, ...uploadedArtifacts.map((item) => item.path).filter((item) => item !== path)].slice(0, 24)
    ))
    openPreview(artifact)
  }

  const closeTab = (path: string) => {
    setOpenPaths((current) => {
      const index = current.indexOf(path)
      const next = current.filter((item) => item !== path)
      if (activePath === path) {
        setActivePath(next[index] ?? next[index - 1] ?? null)
        setFullscreen(false)
      }
      return next
    })
  }

  const removeArtifact = (artifact: Artifact) => {
    closeTab(artifact.path)
    if (artifact.source === 'uploaded') {
      setUploadedArtifacts((current) => {
        const next = current.filter((item) => item.path !== artifact.path)
        window.localStorage.setItem(uploadedStorageKey, JSON.stringify(next.map((item) => item.path)))
        return next
      })
      return
    }
    setStoredRunArtifacts((current) => current.filter((item) => item.path !== artifact.path))
    setDismissedPaths((current) => {
      const next = new Set(current)
      next.add(artifact.path)
      window.localStorage.setItem(dismissedStorageKey, JSON.stringify([...next].slice(-128)))
      return next
    })
  }

  const content = (
    <div className="files-panel">
      {!selected ? (
        <>
          <div className="files-panel-head">
            <div>
              <strong>{allArtifacts.length > 0 ? 'Files & previews' : 'Preview a file'}</strong>
              <button type="button" className="artifact-upload-btn" onClick={() => void uploadFile()}>＋ Upload</button>
            </div>
            {allArtifacts.length > 0 && (
              <div className="artifact-search">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 5 5" /></svg>
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search files"
                  aria-label="Search files"
                />
                {search && <button type="button" onClick={() => setSearch('')} aria-label="Clear file search">×</button>}
              </div>
            )}
          </div>
          {allArtifacts.length > 0 && filteredArtifactCount > 0 ? (
            <div className="artifact-list">
              {filteredRunArtifacts.length > 0 && (
                <div className="artifact-group">
                  <div className="artifact-group-head">Session files</div>
                  {filteredRunArtifacts.map((artifact) => (
                    <ArtifactRow key={artifact.path} artifact={artifact} onOpen={() => openPreview(artifact)} onRemove={() => removeArtifact(artifact)} />
                  ))}
                </div>
              )}
              {filteredUploadedArtifacts.length > 0 && (
                <div className="artifact-group">
                  <div className="artifact-group-head">Uploaded</div>
                  {filteredUploadedArtifacts.map((artifact) => (
                    <ArtifactRow key={artifact.path} artifact={artifact} onOpen={() => openPreview(artifact)} onRemove={() => removeArtifact(artifact)} />
                  ))}
                </div>
              )}
            </div>
          ) : allArtifacts.length > 0 ? (
            <div className="files-panel-empty files-panel-no-results">
              <strong>No matching files</strong>
              <span>Try a different name, path, or file type.</span>
              <button type="button" className="artifact-upload-primary" onClick={() => setSearch('')}>Clear search</button>
            </div>
          ) : (
            <div className="files-panel-empty">
              <div className="files-empty-orb">✦</div>
              <strong>No files from the latest run</strong>
              <span>Upload a structure, image, PDF, Word, PowerPoint, Excel, or text file to preview it here.</span>
              <button type="button" className="artifact-upload-primary" onClick={() => void uploadFile()}>Choose a file</button>
            </div>
          )}
        </>
      ) : (
        <div className="artifact-detail">
          <div className="artifact-detail-head">
            <button type="button" className="artifact-back" title="Back to files" aria-label="Back to files" onClick={() => { setActivePath(null); setFullscreen(false) }}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <div className="artifact-tabs" role="tablist" aria-label="Open files">
              {openPaths.map((path) => {
                if (!allArtifacts.some((artifact) => artifact.path === path)) return null
                return (
                  <div className={`artifact-tab ${path === activePath ? 'active' : ''}`} key={path}>
                    <button type="button" role="tab" aria-selected={path === activePath} onClick={() => setActivePath(path)}>
                      <span>{shortName(path)}</span>
                    </button>
                    <button type="button" className="artifact-tab-close" title={`Close ${shortName(path)}`} aria-label={`Close ${shortName(path)}`} onClick={() => closeTab(path)}>×</button>
                  </div>
                )
              })}
              <button type="button" className="artifact-tab-add" title="Open another file" aria-label="Open another file" onClick={() => void uploadFile()}>+</button>
            </div>
            <div className="artifact-detail-actions">
              <button type="button" className="artifact-icon-btn" title="Open in full screen" onClick={() => setFullscreen(true)}>⛶</button>
              <button
                type="button"
                className="artifact-icon-btn"
                title="Reveal in Finder"
                onClick={() => void (selected.source === 'uploaded'
                  ? window.prime.revealInFinder(selected.path)
                  : window.prime.artifactReveal(agentId ?? '', selected.path))}
              >↗</button>
            </div>
          </div>
          <div className="artifact-preview">
            {loading && <div className="artifact-loading"><span className="sp-stream-dot" /> Loading preview…</div>}
            {error && <span className="sr-only" role="status">{error}</span>}
            {!loading && !error && data && <ArtifactPreview artifact={selected} data={data} fullscreen={false} onToast={onToast} />}
          </div>
          {selected.diff && (
            <details className="artifact-diff">
              <summary>Review changes</summary>
              <pre>{selected.diff}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  )

  return fullscreen && selected ? (
    <div className="artifact-fullscreen">
      <div className="artifact-fullscreen-bar">
        <button type="button" className="artifact-back" title="Back to panel" aria-label="Back to panel" onClick={() => setFullscreen(false)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <strong>{shortName(selected.path)}</strong>
        <button type="button" className="artifact-icon-btn" title="Close full screen" onClick={() => setFullscreen(false)}>×</button>
      </div>
      <div className="artifact-fullscreen-body">
        {data && <ArtifactPreview artifact={selected} data={data} fullscreen onToast={onToast} />}
      </div>
    </div>
  ) : content
}
