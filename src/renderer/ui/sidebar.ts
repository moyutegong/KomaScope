/**
 * 侧栏(§用户需求):最近打开的文件夹历史 + 当前来源的图片列表。
 * 点击历史项重新打开来源;点击图片项跳转到对应页。
 */
import type { PageItem } from '../../shared/types'

export interface SidebarEvents {
  /** 点击历史文件夹/压缩包 */
  onOpenPath: (path: string) => void
  /** 点击页面列表项 */
  onSelectPage: (index: number) => void
}

export class Sidebar {
  private readonly historyEl: HTMLElement
  private readonly pagesEl: HTMLElement
  private history: string[] = []
  private pages: PageItem[] = []
  private currentIndex = -1
  private currentPath = ''

  constructor(private readonly events: SidebarEvents) {
    this.historyEl = document.getElementById('sidebar-history') as HTMLElement
    this.pagesEl = document.getElementById('sidebar-pages') as HTMLElement
  }

  /** 更新历史列表(打开来源后 / 启动时) */
  setHistory(folders: string[]): void {
    this.history = folders
    this.renderHistory()
  }

  /** 更新页面列表与当前页(controller.onPagesChanged) */
  setPages(pages: PageItem[], currentIndex: number, sourcePath: string): void {
    this.pages = pages
    this.currentIndex = currentIndex
    this.currentPath = sourcePath
    this.renderPages()
  }

  /** 语言切换后刷新 */
  refresh(): void {
    this.renderHistory()
    this.renderPages()
  }

  private renderHistory(): void {
    if (this.history.length === 0) {
      this.historyEl.innerHTML = ''
      return
    }
    this.historyEl.innerHTML = ''
    for (const path of this.history) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'sidebar-item' + (path === this.currentPath ? ' sidebar-item-active' : '')
      item.title = path
      item.textContent = path.split(/[\\/]/).pop() || path
      item.addEventListener('click', () => this.events.onOpenPath(path))
      this.historyEl.appendChild(item)
    }
  }

  private renderPages(): void {
    this.pagesEl.innerHTML = ''
    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i]
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'sidebar-item' + (i === this.currentIndex ? ' sidebar-item-active' : '')
      item.title = page.name
      item.textContent = `${i + 1}. ${page.name}`
      item.addEventListener('click', () => this.events.onSelectPage(i))
      this.pagesEl.appendChild(item)
    }
  }
}
