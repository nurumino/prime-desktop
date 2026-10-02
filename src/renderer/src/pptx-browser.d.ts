declare module 'pptx-browser' {
  export default class PptxRenderer {
    slideCount: number
    load(source: File | Blob | ArrayBuffer | Uint8Array, onProgress?: (progress: number, message: string) => void): Promise<void>
    renderSlide(index: number, canvas: HTMLCanvasElement, width?: number): Promise<void>
    destroy(): void
  }
}
