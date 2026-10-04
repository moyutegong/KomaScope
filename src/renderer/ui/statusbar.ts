/**
 * 状态栏(FR-11,§5 示例):
 * `第 12 / 240 页 · 3428×4820 · 缩放 87% · 🔒 锁定`
 */
import { t } from '../i18n'

/** 书签续读提示显示时长(ms,§观看历史) */
const RESUME_HINT_MS = 4000

export class StatusBar {
  private readonly pageEl: HTMLElement
  private readonly sizeEl: HTMLElement
  private readonly zoomEl: HTMLElement
  private readonly lockEl: HTMLElement
  private readonly busyEl: HTMLElement
  private readonly resumeEl: HTMLElement
  private page = { current: 0, total: 0 }
  private size = { width: 0, height: 0 }
  private zoom = 0
  /** 最近一次续读提示内容(语言切换后重绘用) */
  private resume: { current: number; total: number } | null = null
  private resumeTimer: number | null = null

  constructor() {
    this.pageEl = document.getElementById('status-page') as HTMLElement
    this.sizeEl = document.getElementById('status-size') as HTMLElement
    this.zoomEl = document.getElementById('status-zoom') as HTMLElement
    this.lockEl = document.getElementById('status-lock') as HTMLElement
    this.busyEl = document.getElementById('status-busy') as HTMLElement
    this.resumeEl = document.getElementById('status-resume') as HTMLElement
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

  /** 慢图解码提示(§性能):大图解码 >800ms 时显示,完成/失败后清除 */
  setBusy(busy: boolean): void {
    this.busyEl.hidden = !busy
  }

  /**
   * 书签续读提示(§观看历史):进入有书签的来源时短暂显示
   * "已从上次位置继续 (current/total)",数秒后自动消失。
   */
  flashResume(current: number, total: number): void {
    this.resume = { current, total }
    this.renderResume()
    this.resumeEl.hidden = false
    if (this.resumeTimer !== null) clearTimeout(this.resumeTimer)
    this.resumeTimer = window.setTimeout(() => {
      this.resumeTimer = null
      this.resumeEl.hidden = true
    }, RESUME_HINT_MS)
  }

  /** 语言切换后刷新文案 */
  refresh(): void {
    this.renderPage()
    this.renderSize()
    this.renderZoom()
    this.renderResume()
    this.busyEl.textContent = t('status.busy')
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

  private renderResume(): void {
    if (this.resume === null) return
    this.resumeEl.textContent = t('status.resume', {
      current: this.resume.current,
      total: this.resume.total
    })
  }
}
