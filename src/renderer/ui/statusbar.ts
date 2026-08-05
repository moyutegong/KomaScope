/**
 * 状态栏(FR-11,§5 示例):
 * `第 12 / 240 页 · 3428×4820 · 缩放 87% · 🔒 锁定`
 */
export class StatusBar {
  private readonly pageEl: HTMLElement
  private readonly sizeEl: HTMLElement
  private readonly zoomEl: HTMLElement
  private readonly lockEl: HTMLElement

  constructor() {
    this.pageEl = document.getElementById('status-page') as HTMLElement
    this.sizeEl = document.getElementById('status-size') as HTMLElement
    this.zoomEl = document.getElementById('status-zoom') as HTMLElement
    this.lockEl = document.getElementById('status-lock') as HTMLElement
  }

  setPage(current: number, total: number): void {
    this.pageEl.textContent = total > 0 ? `第 ${current + 1} / ${total} 页` : '— / —'
  }

  setImageSize(width: number, height: number): void {
    this.sizeEl.textContent =
      width > 0 && height > 0 ? `${width}×${height}` : '—'
  }

  setZoom(scale: number): void {
    this.zoomEl.textContent = `缩放 ${Math.round(scale * 100)}%`
  }

  setLocked(locked: boolean): void {
    this.lockEl.hidden = !locked
  }
}
