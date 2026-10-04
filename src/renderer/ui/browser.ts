/**
 * 缩略图浏览视图(§资源管理器模式):
 * - 层级浏览:子文件夹(点击进入下一级)→ 压缩包 → 当前层图片缩略图(点击进入阅读模式);
 * - 面包屑 + 返回上级 + 回到书库根目录;
 * - 缩略图经主进程 sharp 流式生成(komascope-thumb://),按可视区懒加载(IntersectionObserver);
 * - 位于书库根目录时显示"继续阅读"(按各文件夹书签的最近阅读倒序,§观看历史);
 * - 键盘导航:方向键移动选中、Enter 打开、Backspace 返回上级(阅读模式快捷键在浏览视图不生效)。
 * 纯逻辑(条目扁平化/书签查询/选中移动)在 browser-model.ts,本模块只负责 DOM 与交互。
 */
import { FileArchive, Folder, House, Library, createElement } from 'lucide'
import type { IconNode } from 'lucide'
import type { BookmarkMap, DirectoryListing, PageItem } from '../../shared/types'
import { t } from '../i18n'
import {
  bookmarkProgress,
  flattenListing,
  folderName,
  latestBookmarkFor,
  moveSelection,
  parentName,
  recentBookmarks
} from './browser-model'
import type { BrowserEntry } from './browser-model'

/** 缩略图目标宽(CSS 像素;主进程按此宽等比缩放,§性能) */
const THUMB_WIDTH = 320

/** 目录读取失败提示的自动消失时长(ms,§4.3.6) */
const NOTICE_TIMEOUT_MS = 8000

export interface BrowserEvents {
  /** 点击图片缩略图:以该文件夹的图片列表 + 起始下标进入阅读模式 */
  onOpenFolderImages: (folderPath: string, images: PageItem[], index: number) => void
  /** 点击压缩包条目:直接进入阅读模式(§13 P0) */
  onOpenArchive: (archivePath: string) => void
  /** 点击"继续阅读":按该书签所在文件夹继续阅读 */
  onResumeFolder: (folderPath: string) => void
  /** 未设置书库目录时的引导按钮:请求选择书库根目录 */
  onPickLibrary: () => void
}

export interface BrowserOptions {
  /** 书签表(书架进度徽标/继续阅读;app 持有的缓存,阅读时写入后回调刷新) */
  getBookmarks: () => BookmarkMap
  /** 书库根目录(空字符串表示未设置) */
  getLibraryRoot: () => string
}

export class Browser {
  private readonly rootEl: HTMLElement
  private readonly scrollEl: HTMLElement
  private readonly crumbsEl: HTMLElement
  private readonly gridEl: HTMLElement
  private readonly countEl: HTMLElement
  private readonly emptyEl: HTMLElement
  private readonly noticeEl: HTMLElement
  private readonly recentEl: HTMLElement
  private readonly recentListEl: HTMLElement
  private readonly upBtn: HTMLButtonElement
  private readonly rootBtn: HTMLButtonElement
  private readonly readBtn: HTMLButtonElement
  /** 缩略图懒加载观察器(仅可视区赋 src) */
  private observer: IntersectionObserver | null = null
  private listing: DirectoryListing | null = null
  private folderPath = ''
  /** 扁平条目顺序 = 网格顺序 = 键盘导航顺序 */
  private flat: BrowserEntry[] = []
  private selected = -1
  /** 列举请求代际:快速连点文件夹时丢弃过期响应 */
  private seq = 0
  /** 上级路径栈(返回上级) */
  private stack: string[] = []
  /** 每层滚动位置(从阅读模式返回 / 返回上级时恢复) */
  private readonly scrollPositions = new Map<string, number>()
  private scrollSaveQueued = false
  /** 未设置书库根目录时的引导态(无目录可列举) */
  private welcome = false
  /** 目录读取失败提示的自动消失计时器(§4.3.6) */
  private noticeTimer: number | null = null
  /** 书签在浏览视图不可见时变化的标记(§4.3.3 延迟渲染) */
  private dirty = false

  constructor(
    private readonly events: BrowserEvents,
    private readonly options: BrowserOptions
  ) {
    this.rootEl = document.getElementById('browser') as HTMLElement
    this.scrollEl = document.getElementById('browser-scroll') as HTMLElement
    this.crumbsEl = document.getElementById('browser-crumbs') as HTMLElement
    this.gridEl = document.getElementById('browser-grid') as HTMLElement
    this.countEl = document.getElementById('browser-count') as HTMLElement
    this.emptyEl = document.getElementById('browser-empty') as HTMLElement
    this.noticeEl = document.getElementById('browser-notice') as HTMLElement
    this.recentEl = document.getElementById('browser-recent') as HTMLElement
    this.recentListEl = document.getElementById('browser-recent-list') as HTMLElement
    this.upBtn = document.getElementById('btn-browser-up') as HTMLButtonElement
    this.rootBtn = document.getElementById('btn-browser-root') as HTMLButtonElement
    this.readBtn = document.getElementById('btn-browser-read') as HTMLButtonElement

    this.upBtn.addEventListener('click', () => this.goUp())
    this.rootBtn.addEventListener('click', () => this.goToLibraryRoot())
    this.readBtn.addEventListener('click', () => this.dispatchReadAll())

    // 懒加载:进入可视区(含 200px 预取边距)才给 <img> 赋 src,加载后停止观察
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
      { root: this.scrollEl, rootMargin: '200px' }
    )

    // 滚动位置记忆(从阅读模式返回时恢复):rAF 合并滚动事件
    this.scrollEl.addEventListener('scroll', () => {
      if (this.scrollSaveQueued) return
      this.scrollSaveQueued = true
      requestAnimationFrame(() => {
        this.scrollSaveQueued = false
        this.saveScroll()
      })
    })
  }

  /** 当前所在目录(空字符串表示尚未浏览任何目录) */
  get currentPath(): string {
    return this.folderPath
  }

  get canGoUp(): boolean {
    return this.stack.length > 0
  }

  /** 打开目录(列举当前层);pushStack=false 用于"返回上级"回退 */
  async open(folderPath: string, pushStack = true): Promise<void> {
    if (folderPath.length === 0) return
    if (pushStack && this.folderPath.length > 0 && this.folderPath !== folderPath) {
      this.stack.push(this.folderPath)
    }
    const seq = ++this.seq
    let listing: DirectoryListing
    try {
      listing = await window.komascope.listDirectory(folderPath)
    } catch (err) {
      // 目录被删除/无权限:保留当前视图并提示,不白屏(§兜底)
      console.error(t('error.browseFolder'), folderPath, err)
      this.showNotice(t('browser.error', { path: folderPath }))
      return
    }
    if (seq !== this.seq) return
    this.saveScroll()
    this.folderPath = folderPath
    this.listing = listing
    this.flat = flattenListing(listing)
    this.selected = this.flat.length > 0 ? 0 : -1
    this.welcome = false
    this.clearNotice()
    this.render()
    this.restoreScroll()
  }

  /** 未设置书库目录时的引导界面(选择大目录作为书架根) */
  showWelcome(): void {
    this.welcome = true
    this.folderPath = ''
    this.listing = null
    this.flat = []
    this.selected = -1
    this.stack = []
    this.render()
  }

  /** 返回上级目录 */
  goUp(): void {
    const target = this.stack.pop()
    if (target === undefined) return
    void this.open(target, false)
  }

  /** 回到书库根目录;未设置书库时改为引导选择 */
  goToLibraryRoot(): void {
    const root = this.options.getLibraryRoot()
    if (root.length === 0) {
      this.events.onPickLibrary()
      return
    }
    if (root === this.folderPath) return
    this.stack = []
    void this.open(root, false)
  }

  setVisible(visible: boolean): void {
    this.rootEl.hidden = !visible
    if (!visible) {
      this.saveScroll()
      return
    }
    if (this.welcome || this.folderPath.length === 0) {
      // 无内容可显示:进入引导态(已设置书库根目录时由 app 先行 open)
      if (this.folderPath.length === 0) this.showWelcome()
      return
    }
    // 阅读期间书签变过:此刻补一次渲染(§4.3.3),随后再恢复滚动位置
    if (this.dirty) this.render()
    this.restoreScroll()
  }

  /**
   * 书签变化后刷新进度徽标/「继续阅读」(不重新列举目录)。
   * 阅读模式下浏览视图不可见:只置脏,切回浏览视图时再渲染一次(§4.3.3),
   * 避免每次翻页都重建整屏网格 DOM(上千张图的目录尤其明显)。
   */
  refreshBookmarks(): void {
    if (!this.rootEl.hidden) {
      this.render()
      return
    }
    this.dirty = true
  }

  /** 语言切换后刷新文案 */
  refresh(): void {
    this.render()
  }

  /** 记录当前层滚动位置(进入阅读模式前调用,返回时恢复) */
  captureScroll(): void {
    this.saveScroll()
  }

  /**
   * 键盘导航(§快捷键):返回 true 表示已消费该事件。
   * 阅读模式的快捷键(缩放/翻页/适配)在浏览视图下不生效。
   */
  handleKey(e: KeyboardEvent): boolean {
    if (e.key === 'Enter') {
      if (this.flat.length === 0) return false
      if (this.selected < 0) this.selected = 0
      this.activate(this.selected)
      return true
    }
    if (e.key === 'Backspace') {
      if (!this.canGoUp) return false
      this.goUp()
      return true
    }
    const next = moveSelection(this.selected, e.key, this.gridColumns(), this.flat.length)
    if (next === this.selected) return false
    this.selected = next
    this.applySelection()
    return true
  }

  // --- 渲染 ---

  private render(): void {
    // 渲染即最新:清除"不可见期间的变更"标记(§4.3.3)
    this.dirty = false
    this.upBtn.disabled = this.stack.length === 0
    // 「阅读本文件夹」仅当前层有图片时出现(§4.3.2)
    this.readBtn.hidden = this.welcome || (this.listing?.images.length ?? 0) === 0
    this.renderCrumbs()
    this.renderRecent()
    this.renderGrid()
    this.renderCount()
  }

  /** 面包屑:书库根目录 → 逐级路径(盘符等 2 字符前缀不可列举,仅作标签) */
  private renderCrumbs(): void {
    this.crumbsEl.innerHTML = ''
    if (this.welcome) return
    if (this.options.getLibraryRoot().length > 0) {
      this.crumbsEl.appendChild(this.crumb(t('browser.library'), this.rootBtnIcon(), false, () => this.goToLibraryRoot()))
    }
    const segments = this.folderPath.split(/[\\/]+/).filter((s) => s.length > 0)
    let acc = ''
    for (let i = 0; i < segments.length; i++) {
      acc = i === 0 ? segments[i] : `${acc}\\${segments[i]}`
      const target = acc
      const isLast = i === segments.length - 1
      // 盘符(如 `F:`)不能直接列举,作为不可点击的路径标签
      const clickable = target.length > 2 && !isLast
      this.crumbsEl.appendChild(
        this.crumb(segments[i], null, isLast, clickable ? () => void this.open(target) : null)
      )
    }
  }

  /** 书库根目录图标(面包屑首项) */
  private rootBtnIcon(): IconNode {
    return House
  }

  private crumb(
    label: string,
    icon: IconNode | null,
    current: boolean,
    onClick: (() => void) | null
  ): HTMLElement {
    const el = document.createElement(onClick ? 'button' : 'span')
    el.className = 'browser-crumb' + (current ? ' browser-crumb-current' : '')
    el.title = label
    if (icon) el.appendChild(createElement(icon, { class: 'browser-crumb-icon', 'aria-hidden': 'true' }))
    const text = document.createElement('span')
    text.textContent = label
    el.appendChild(text)
    if (onClick) (el as HTMLButtonElement).addEventListener('click', onClick)
    return el
  }

  /** 书库根目录下的"继续阅读":按各文件夹书签的最近阅读倒序 */
  private renderRecent(): void {
    const root = this.options.getLibraryRoot()
    const list =
      root.length > 0 && !this.welcome && this.folderPath === root
        ? recentBookmarks(this.options.getBookmarks(), root)
        : []
    this.recentEl.hidden = list.length === 0
    this.recentListEl.innerHTML = ''
    for (const bookmark of list) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'browser-recent-item'
      item.title = bookmark.folderPath
      // 深层书签(…\系列\章节)只显示末段难以辨识,补一段父目录名(§4.3.5)
      const parent = parentName(bookmark.folderPath)
      if (parent.length > 0) {
        const parentEl = document.createElement('span')
        parentEl.className = 'browser-recent-parent'
        parentEl.textContent = parent
        item.appendChild(parentEl)
      }
      const name = document.createElement('span')
      name.className = 'browser-recent-name'
      name.textContent = folderName(bookmark.folderPath)
      const progress = document.createElement('span')
      progress.className = 'browser-recent-progress'
      progress.textContent = bookmarkProgress(bookmark)
      item.append(name, progress)
      item.addEventListener('click', () => this.events.onResumeFolder(bookmark.folderPath))
      this.recentListEl.appendChild(item)
    }
  }

  private renderGrid(): void {
    this.gridEl.innerHTML = ''
    this.observer?.disconnect()
    if (this.welcome) {
      this.emptyEl.hidden = false
      this.emptyEl.textContent = ''
      const hint = document.createElement('span')
      hint.textContent = t('browser.noLibrary')
      const pick = document.createElement('button')
      pick.type = 'button'
      pick.className = 'toolbar-btn browser-pick-btn'
      pick.appendChild(createElement(Library, { 'aria-hidden': 'true' }))
      const label = document.createElement('span')
      label.textContent = t('browser.pickLibrary')
      pick.appendChild(label)
      pick.addEventListener('click', () => this.events.onPickLibrary())
      this.emptyEl.append(hint, pick)
      return
    }
    if (this.listing === null || this.flat.length === 0) {
      this.emptyEl.hidden = false
      this.emptyEl.textContent = t('browser.empty')
      return
    }
    this.emptyEl.hidden = true
    for (let i = 0; i < this.flat.length; i++) {
      const entry = this.flat[i]
      this.gridEl.appendChild(
        entry.kind === 'image' ? this.buildImage(entry, i) : this.buildNode(entry, i)
      )
    }
    this.applySelection()
  }

  /** 子文件夹 / 压缩包条目(图标 + 名称 + 书签进度徽标) */
  private buildNode(entry: Extract<BrowserEntry, { kind: 'folder' | 'archive' }>, index: number): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `browser-item browser-node browser-${entry.kind}`
    btn.dataset.index = String(index)
    btn.title = entry.path
    btn.appendChild(
      createElement(entry.kind === 'folder' ? Folder : FileArchive, {
        class: 'browser-node-icon',
        'aria-hidden': 'true'
      })
    )
    const name = document.createElement('span')
    name.className = 'browser-node-name'
    name.textContent = entry.name
    btn.appendChild(name)
    if (entry.kind === 'folder') {
      const bookmark = latestBookmarkFor(this.options.getBookmarks(), entry.path)
      if (bookmark) {
        const progress = document.createElement('span')
        progress.className = 'browser-node-progress'
        progress.textContent = bookmarkProgress(bookmark)
        progress.title = bookmark.folderPath
        btn.appendChild(progress)
      }
    }
    btn.addEventListener('click', () => this.activate(index))
    return btn
  }

  /** 图片缩略图(懒加载 + 序号角标;解码失败回退文本行,仍可点击) */
  private buildImage(entry: Extract<BrowserEntry, { kind: 'image' }>, index: number): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'browser-item browser-image'
    btn.dataset.index = String(index)
    btn.title = entry.name

    const img = document.createElement('img')
    img.className = 'browser-thumb'
    img.loading = 'lazy'
    img.decoding = 'async'
    img.alt = entry.name
    img.dataset.src = window.komascope.imageSourceUrl(entry.path, { width: THUMB_WIDTH })
    img.addEventListener('error', () => {
      btn.classList.add('browser-thumb-fallback')
      img.remove()
      const label = document.createElement('span')
      label.className = 'browser-thumb-fallback-label'
      label.textContent = entry.name
      btn.appendChild(label)
    })
    btn.appendChild(img)
    this.observer?.observe(img)

    const badge = document.createElement('span')
    badge.className = 'browser-thumb-badge'
    badge.textContent = String(entry.index + 1)
    btn.appendChild(badge)

    btn.addEventListener('click', () => this.activate(index))
    return btn
  }

  private renderCount(): void {
    const listing = this.listing
    if (this.welcome || listing === null) {
      this.countEl.textContent = ''
      return
    }
    this.countEl.textContent = t('browser.count', {
      dirs: listing.dirs.length,
      archives: listing.archives.length,
      images: listing.images.length
    })
  }

  /** 激活条目:文件夹 → 进入下一级;压缩包 → 阅读;图片 → 阅读该文件夹图片 */
  private activate(index: number): void {
    const entry = this.flat[index]
    if (!entry) return
    this.selected = index
    this.applySelection()
    if (entry.kind === 'folder') {
      void this.open(entry.path)
      return
    }
    if (entry.kind === 'archive') {
      this.events.onOpenArchive(entry.path)
      return
    }
    this.events.onOpenFolderImages(this.folderPath, this.listing?.images ?? [], entry.index)
  }

  private applySelection(scrollIntoView = false): void {
    const items = this.gridEl.querySelectorAll<HTMLElement>('.browser-item')
    items.forEach((el) => {
      const isSelected = Number(el.dataset.index) === this.selected
      el.classList.toggle('browser-item-selected', isSelected)
      // 仅在键盘导航时把选中项滚入视口:render 后调用会覆盖该层滚动位置恢复
      if (isSelected && scrollIntoView) el.scrollIntoView({ block: 'nearest' })
    })
  }

  /** 网格列数(键盘上下移动按行步进) */
  private gridColumns(): number {
    const trackList = getComputedStyle(this.gridEl).gridTemplateColumns
    const columns = trackList.split(' ').filter((t) => t.length > 0).length
    return Math.max(1, columns)
  }

  private showNotice(message: string): void {
    this.noticeEl.textContent = message
    this.noticeEl.hidden = false
    // 自动消失(§4.3.6):避免错误条长期占据浏览视图顶部
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer)
    this.noticeTimer = window.setTimeout(() => {
      this.noticeTimer = null
      this.clearNotice()
    }, NOTICE_TIMEOUT_MS)
  }

  private clearNotice(): void {
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer)
      this.noticeTimer = null
    }
    this.noticeEl.textContent = ''
    this.noticeEl.hidden = true
  }

  /** 「阅读本文件夹」:从第 1 张开始阅读当前层全部图片(§4.3.2) */
  private dispatchReadAll(): void {
    const images = this.listing?.images ?? []
    if (images.length === 0) return
    this.events.onOpenFolderImages(this.folderPath, images, 0)
  }

  private saveScroll(): void {
    if (this.folderPath.length > 0) this.scrollPositions.set(this.folderPath, this.scrollEl.scrollTop)
  }

  /**
   * 恢复当前层滚动位置:先立即赋值,再于下一帧校正一次 ——
   * 网格重建时浏览器的滚动锚定可能改写 scrollTop,单次赋值不足以稳定落位。
   */
  private restoreScroll(): void {
    const target = (): number => this.scrollPositions.get(this.folderPath) ?? 0
    this.scrollEl.scrollTop = target()
    requestAnimationFrame(() => {
      if (this.folderPath.length === 0 || this.welcome) return
      const top = target()
      if (this.scrollEl.scrollTop !== top) this.scrollEl.scrollTop = top
    })
  }
}
