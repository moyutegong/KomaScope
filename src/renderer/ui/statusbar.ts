/**
 * 状态栏(FR-11,§5 示例):
 * `第 12 / 240 页 · 3428×4820 · 缩放 87% · 🔒 锁定`
 */
import { t } from '../i18n'

export class StatusBar {
  private readonly pageEl: HTMLElement
  private readonly sizeEl: HTMLElement
  private readonly zoomEl: HTMLElement
  private readonly lockEl: HTMLElement
  private page = { current: 0, total: 0 }
  private size = { width: 0, height: 0 }
  private zoom = 0

  constructor() {
    this.pageEl = document.getElementById('status-page') as HTMLElement
    this.sizeEl = document.getElementById('status-size') as HTMLElement
    this.zoomEl = document.getElementById('status-zoom') as HTMLElement
    this.lockEl = document.getElementById('status-lock') as HTMLElement
  }

  setPage(current: number, total: number): void {
    this.page = { current, total }
    this.renderPage()
  }

  setImageSize(width: number, height: number): void {
    this.size = { width, height }
    this.renderSize()
  }

  setZoom(scale: number): void {
    this.zoom = scale
    this.renderZoom()
  }

  setLocked(locked: boolean): void {
    this.lockEl.hidden = !locked
  }

  /** 语言切换后刷新文案 */
  refresh(): void {
    this.renderPage()
    this.renderSize()
    this.renderZoom()
  }

  private renderPage(): void {
    this.pageEl.textContent =
      this.page.total > 0
        ? t('status.page', { current: this.page.current + 1, total: this.page.total })
        : t('status.page.empty')
  }

  private renderSize(): void {
    this.sizeEl.textContent =
      this.size.width > 0 && this.size.height > 0
        ? `${this.size.width}×${this.size.height}`
        : t('status.size.empty')
  }

  private renderZoom(): void {
    this.zoomEl.textContent =
      this.zoom > 0 ? t('status.zoom', { percent: Math.round(this.zoom * 100) }) : t('status.zoom.empty')
  }
}
