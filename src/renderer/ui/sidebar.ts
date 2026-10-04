/**
 * 侧栏(§用户需求):最近打开的文件夹历史 + 当前来源的页面列表。
 * 历史项点击重新打开来源;页面项点击跳转到对应页。
 *
 * 页面列表(§用户需求调整):只显示文件名,不做缩略图 ——
 * 缩略图浏览已由缩略图浏览视图(ui/browser.ts)承担,侧栏再放缩略图会
 * 污染界面且大目录下需要额外解码开销。
 */
import type { PageItem } from '../../shared/types'

export interface SidebarEvents {
  /** 点击历史文件夹/压缩包 */
  onOpenPath: (path: string) => void
  /** 删除历史项(从 recentFolders 移除并持久化) */
  onRemoveHistory: (path: string) => void
  /** 点击页面列表项 */
  onSelectPage: (index: number) => void
}

export class Sidebar {
  private readonly historyEl: HTMLElement
  private readonly pagesEl: HTMLElement
  private readonly historySectionEl: HTMLElement
  private readonly pagesSectionEl: HTMLElement
  private readonly dividerEl: HTMLElement
  private history: string[] = []
  private pages: PageItem[] = []
  private currentIndex = -1
  private currentPath = ''

  constructor(private readonly events: SidebarEvents) {
    this.historyEl = document.getElementById('sidebar-history') as HTMLElement
    this.pagesEl = document.getElementById('sidebar-pages') as HTMLElement
    this.historySectionEl = document.getElementById('sidebar-history-section') as HTMLElement
    this.pagesSectionEl = document.getElementById('sidebar-pages-section') as HTMLElement
    this.dividerEl = document.getElementById('sidebar-divider') as HTMLElement
    this.initDivider()
  }

  /** 可拖拽分隔条:调整历史/图片区块垂直占比,持久化到 localStorage */
  private initDivider(): void {
    const KEY = 'komascope.sidebar.historyRatio'
    let ratio = Math.min(0.85, Math.max(0.15, parseFloat(localStorage.getItem(KEY) ?? '0.4')))
    const applyRatio = (r: number): void => {
      this.historySectionEl.style.flex = `0 0 ${(r * 100).toFixed(1)}%`
      this.pagesSectionEl.style.flex = '1 1 auto'
    }
    applyRatio(ratio)

    this.dividerEl.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const sidebarEl = this.dividerEl.parentElement as HTMLElement
      const startY = e.clientY
      const startRatio = ratio
      const onMove = (ev: MouseEvent): void => {
        const rect = sidebarEl.getBoundingClientRect()
        if (rect.height <= 0) return
        ratio = Math.min(0.85, Math.max(0.15, startRatio + (ev.clientY - startY) / rect.height))
        applyRatio(ratio)
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        localStorage.setItem(KEY, String(ratio))
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })
  }

  /** 更新历史列表(打开来源后 / 启动时) */
  setHistory(folders: string[]): void {
    this.history = folders
    this.renderHistory()
  }

  /** 更新页面列表与当前页(controller.onPagesChanged) */
  setPages(pages: PageItem[], currentIndex: number, sourcePath: string): void {
    const sameList =
      this.pages.length === pages.length &&
      this.pages.every((p, i) => p.path === pages[i].path && p.archiveEntry === pages[i].archiveEntry)
    this.pages = pages
    this.currentPath = sourcePath
    // 列表未变(仅翻页):只更新高亮,避免重建 DOM
    if (sameList) {
      this.updateActive(currentIndex)
    } else {
      this.currentIndex = currentIndex
      this.renderPages()
    }
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
      // 行容器:左侧打开按钮 + 右侧删除按钮
      const row = document.createElement('div')
      row.className = 'sidebar-item-row'

      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'sidebar-item' + (path === this.currentPath ? ' sidebar-item-active' : '')
      item.title = path
      item.textContent = path.split(/[\\/]/).pop() || path
      item.addEventListener('click', () => this.events.onOpenPath(path))
      row.appendChild(item)

      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'sidebar-item-del'
      del.title = 'Remove'
      del.textContent = '✕'
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        this.events.onRemoveHistory(path)
      })
      row.appendChild(del)

      this.historyEl.appendChild(row)
    }
  }

  /** 重建页面列表(来源切换 / 页面列表变化时) */
  private renderPages(): void {
    this.pagesEl.innerHTML = ''
    for (let i = 0; i < this.pages.length; i++) {
      this.pagesEl.appendChild(this.buildPageItem(i))
    }
    // 重建后把当前页滚入视口(打开来源即定位到上次阅读位置时尤其有用,§4.3.1)
    const current = this.pagesEl.querySelector<HTMLElement>('.sidebar-page-item-active')
    if (current) this.scrollItemIntoView(current)
  }

  /** 单个页面条目:仅文件名(超长省略),当前页高亮 */
  private buildPageItem(index: number): HTMLElement {
    const page = this.pages[index]
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className =
      'sidebar-page-item' + (index === this.currentIndex ? ' sidebar-page-item-active' : '')
    btn.dataset.index = String(index)
    btn.title = page.name
    btn.textContent = page.name
    btn.addEventListener('click', () => this.events.onSelectPage(index))
    return btn
  }

  /**
   * 仅更新当前页高亮(不重建 DOM);
   * 当前页不在可视区内时滚入视口(§4.3.1:翻页后侧栏跟随,仅不可见时滚动以免打断手动浏览)。
   */
  private updateActive(index: number): void {
    this.currentIndex = index
    for (const el of this.pagesEl.querySelectorAll<HTMLElement>('.sidebar-page-item')) {
      const isCurrent = Number(el.dataset.index) === index
      el.classList.toggle('sidebar-page-item-active', isCurrent)
      if (isCurrent) this.scrollItemIntoView(el)
    }
  }

  /** 条目不在列表可视区内时滚入(用盒模型比较,避免依赖 offsetParent) */
  private scrollItemIntoView(el: HTMLElement): void {
    const item = el.getBoundingClientRect()
    const box = this.pagesEl.getBoundingClientRect()
    if (item.top < box.top || item.bottom > box.bottom) {
      el.scrollIntoView({ block: 'nearest' })
    }
  }
}
