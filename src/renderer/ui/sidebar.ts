/**
 * 侧栏(§用户需求):最近打开的文件夹历史 + 当前来源的缩略图网格。
 * 点击历史项重新打开来源;点击缩略图跳转到对应页(先看缩略图再选图)。
 *
 * 缩略图网格(§性能):
 * - 缩略图经主进程 sharp 流式生成(komascope-thumb://),大图不整页解码;
 * - IntersectionObserver 懒加载:仅可视区 <img> 赋 src,滚动时按需加载;
 * - 解码失败(未知格式/损坏)回退为文本行,保证列表始终可用。
 */
import type { PageItem } from '../../shared/types'

/** 缩略图目标宽(CSS 像素;实际由主进程按此宽等比缩放) */
const THUMB_WIDTH = 192

export interface SidebarEvents {
  /** 点击历史文件夹/压缩包 */
  onOpenPath: (path: string) => void
  /** 删除历史项(从 recentFolders 移除并持久化) */
  onRemoveHistory: (path: string) => void
  /** 点击缩略图/页面列表项 */
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
  /** 缩略图懒加载观察器(仅可视区赋 src) */
  private observer: IntersectionObserver | null = null

  constructor(private readonly events: SidebarEvents) {
    this.historyEl = document.getElementById('sidebar-history') as HTMLElement
    this.pagesEl = document.getElementById('sidebar-pages') as HTMLElement
    this.historySectionEl = document.getElementById('sidebar-history-section') as HTMLElement
    this.pagesSectionEl = document.getElementById('sidebar-pages-section') as HTMLElement
    this.dividerEl = document.getElementById('sidebar-divider') as HTMLElement
    this.initDivider()
    this.initObserver()
  }

  /**
   * 懒加载观察器:进入可视区(含 200px 预取边距)时才给 <img> 赋 src,
   * 避免几百页时一次性发起大量 sharp 请求;加载后停止观察该元素。
   */
  private initObserver(): void {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const img = entry.target as HTMLImageElement
          const src = img.dataset.src
          if (src && !img.src) {
            img.src = src
            img.removeAttribute('data-src')
          }
          this.observer?.unobserve(img)
        }
      },
      { root: this.pagesEl, rootMargin: '200px' }
    )
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
    // 列表未变(仅翻页):只更新高亮,避免重建 DOM 与重复加载缩略图
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

  /** 重建缩略图网格(来源切换 / 页面列表变化时) */
  private renderPages(): void {
    this.pagesEl.innerHTML = ''
    this.pagesEl.classList.add('sidebar-grid')
    // 复用同一观察器:先断开旧目标,再观察新建的缩略图(避免 observer 泄漏)
    this.observer?.disconnect()
    for (let i = 0; i < this.pages.length; i++) {
      this.pagesEl.appendChild(this.buildThumb(i))
    }
  }

  /**
   * 单个缩略图格子:外层 button(可点击跳页)+ <img> 懒加载 + 序号角标。
   * 解码失败时回退为文本行(仍可点击),避免整格空白。
   */
  private buildThumb(index: number): HTMLElement {
    const page = this.pages[index]
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'thumb' + (index === this.currentIndex ? ' thumb-active' : '')
    btn.dataset.index = String(index)
    btn.title = page.name

    const img = document.createElement('img')
    img.className = 'thumb-img'
    img.loading = 'lazy'
    img.decoding = 'async'
    img.alt = page.name
    // 懒加载:先挂 data-src,进入可视区由观察器赋 src
    img.dataset.src = window.komascope.imageSourceUrl(page.path, {
      width: THUMB_WIDTH,
      archiveEntry: page.archiveEntry
    })
    img.addEventListener('error', () => {
      // 解码失败回退文本行(保留点击能力)
      btn.classList.add('thumb-fallback')
      img.remove()
      const label = document.createElement('span')
      label.className = 'thumb-fallback-label'
      label.textContent = `${index + 1}`
      btn.appendChild(label)
    })
    btn.appendChild(img)

    const badge = document.createElement('span')
    badge.className = 'thumb-badge'
    badge.textContent = String(index + 1)
    btn.appendChild(badge)

    btn.addEventListener('click', () => this.events.onSelectPage(index))
    this.observer?.observe(img)
    return btn
  }

  /** 仅更新当前页高亮(不重建 DOM) */
  private updateActive(index: number): void {
    this.currentIndex = index
    for (const el of this.pagesEl.querySelectorAll<HTMLElement>('.thumb')) {
      el.classList.toggle('thumb-active', Number(el.dataset.index) === index)
    }
  }
}
