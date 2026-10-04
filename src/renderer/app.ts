/**
 * 渲染进程入口:装配 UI、ViewerController、输入映射与配置恢复。
 * M3 范围:平移/锚点缩放/适配切换/缩放锁定/快捷键(§5)。
 */
import {
  BookOpen,
  CornerLeftUp,
  FolderOpen,
  House,
  LayoutGrid,
  Library,
  Lock,
  Maximize,
  Minus,
  MousePointerClick,
  PanelLeft,
  Rows3,
  Scan,
  Square,
  X,
  createIcons
} from 'lucide'
import type { BookmarkMap } from '../shared/types'
import type { Point } from '../shared/transform-model'
import { naturalCompare } from '../shared/natural-sort'
import { applyStaticText, isLocale, setLocale, t } from './i18n'
import { ImageRenderer } from './viewer/image-renderer'
import { InputController, wheelDeltaToFactor } from './viewer/input-controller'
import { ViewerController } from './viewer/viewer-controller'
import { Browser } from './ui/browser'
import { Toolbar } from './ui/toolbar'
import { StatusBar } from './ui/statusbar'
import { Sidebar } from './ui/sidebar'
import { LongView } from './ui/long-view'

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** zip/cbz 压缩包扩展名(§13 P0) */
const ARCHIVE_EXTENSIONS = ['.cbz', '.zip']

function isArchiveFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  return ARCHIVE_EXTENSIONS.includes(ext)
}

function main(): void {
  const statusbar = new StatusBar()
  const renderer = new ImageRenderer(document.getElementById('canvas') as HTMLCanvasElement)
  const controller = new ViewerController(renderer, statusbar, {
    onFolderChanged: (folderPath) => toolbar.setFolder(folderPath),
    onPagesChanged: (pages, currentIndex) => {
      sidebar.setPages(pages, currentIndex, controller.currentPage?.path ?? '')
      longView.setPages(pages, currentIndex)
      // 阅读内容增减时同步「缩略图浏览」按钮态(§5.2)
      syncBrowseButton()
    },
    // 拖入/打开新来源后立即刷新侧栏历史(无需重启,§侧栏)
    onRecentChanged: (recent) => sidebar.setHistory(recent),
    // 书签写入后刷新浏览视图进度徽标/"继续阅读"(§观看历史)
    onBookmarksChanged: (map) => {
      bookmarks = map
      browser.refreshBookmarks()
    },
    // 按书签续读:状态栏短暂提示当前进度(§观看历史)
    onResumed: ({ index, pageCount }) => statusbar.flashResume(index + 1, pageCount)
  })

  // --- 长图模式(§需求4):所有图片垂直拼接成单页无限下拉 ---
  const longView = new LongView({
    onSelectPage: (index) => {
      controller.gotoPage(index)
      setViewMode('page')
    }
  })
  const canvasEl = document.getElementById('canvas') as HTMLElement
  const placeholderEl = document.getElementById('placeholder') as HTMLElement
  const viewModeBtn = document.getElementById('btn-view-mode') as HTMLButtonElement
  let viewMode: 'page' | 'long' = 'page'
  /** 应用视图(§资源管理器模式):browse = 缩略图层级浏览,read = 画布/长图阅读 */
  let appView: 'browse' | 'read' = 'browse'
  /** 各文件夹独立的书签(§观看历史):启动从配置读取,阅读时由 controller 回调刷新 */
  let bookmarks: BookmarkMap = {}
  /** 书库根目录(空字符串表示未设置) */
  let libraryRoot = ''

  /** 阅读视图显隐(长图 ↔ 画布 ↔ 空状态占位) */
  const applyReadView = (): void => {
    const long = viewMode === 'long'
    longView.setVisible(long)
    // 长图模式:隐藏 placeholder(避免覆盖拦截点击);退出后:
    // 有图片 → renderer.setVisible(true) 恢复 canvas 并隐藏提示;
    // 无图片 → 显示 placeholder
    if (long) {
      canvasEl.hidden = true
      placeholderEl.hidden = true
      return
    }
    canvasEl.hidden = false
    if (controller.pageCount > 0) {
      renderer.setVisible(true)
    } else {
      placeholderEl.hidden = false
    }
    controller.applyFit()
  }

  const setViewMode = (mode: 'page' | 'long'): void => {
    viewMode = mode
    viewModeBtn.classList.toggle('toolbar-btn-active', mode === 'long')
    // 浏览视图下仅记录模式,显隐由 setAppView 统一接管
    if (appView === 'read') applyReadView()
  }

  viewModeBtn.addEventListener('click', () => {
    setViewMode(viewMode === 'page' ? 'long' : 'page')
  })

  /**
   * 切换应用视图:
   * - browse:显示缩略图浏览视图(资源管理器式层级),隐藏画布/长图/占位;
   * - read:隐藏浏览视图,恢复阅读视图(画布或长图)。
   */
  const setAppView = (view: 'browse' | 'read'): void => {
    appView = view
    syncBrowseButton()
    if (view === 'browse') {
      browser.setVisible(true)
      canvasEl.hidden = true
      longView.setVisible(false)
      placeholderEl.hidden = true
      return
    }
    browser.setVisible(false)
    applyReadView()
  }

  const sidebar = new Sidebar({
    onOpenPath: (path) => {
      void (async () => {
        try {
          const s = await window.komascope.statPath(path)
          if (s.isDirectory) {
            // 目录 → 缩略图浏览视图(§资源管理器模式)
            await browseFolder(path)
          } else if (isArchiveFile(path)) {
            await controller.openArchive(path)
            setAppView('read')
          }
        } catch {
          // 历史路径可能已被删除/移动,静默失败并提示
          console.error(t('error.openPath'), path)
        }
      })()
    },
    onRemoveHistory: (path) => {
      void (async () => {
        try {
          // 主进程原子删除(避免连续点击时 getConfig+setConfig 竞态)
          const recent = await window.komascope.removeRecentFolder(path)
          sidebar.setHistory(recent)
        } catch (err) {
          console.error(t('error.loadConfig'), err)
        }
      })()
    },
    onSelectPage: (index) => controller.gotoPage(index)
  })

  // --- 缩略图浏览视图(§资源管理器模式):层级浏览 → 点击缩略图进入阅读 ---
  const browser = new Browser(
    {
      onOpenFolderImages: (folderPath, images, index) => {
        void controller.openPages(folderPath, images, index).then(() => setAppView('read'))
      },
      onOpenArchive: (archivePath) => {
        void controller.openArchive(archivePath).then(() => setAppView('read'))
      },
      onResumeFolder: (folderPath) => void resumeFolder(folderPath),
      onPickLibrary: () => void pickLibrary()
    },
    {
      getBookmarks: () => bookmarks,
      getLibraryRoot: () => libraryRoot
    }
  )

  // --- 4K / HiDPI(§4.4) ---

  /** UI 缩放系数:以 150% 为 1.0(dpr/1.5),驱动 --ui-scale 变量 */
  const applyUiScale = (): void => {
    const uiScale = window.devicePixelRatio / 1.5
    document.documentElement.style.setProperty('--ui-scale', uiScale.toFixed(3))
    void window.komascope.setConfig({ uiScale })
  }

  /** DPR 变化(窗口拖到不同缩放显示器):重建画布 + 重算 UI 系数 */
  const watchDpr = (): void => {
    applyUiScale()
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    query.addEventListener('change', () => {
      applyUiScale()
      const rect = viewport.getBoundingClientRect()
      renderer.resize(rect.width, rect.height, window.devicePixelRatio)
      controller.onViewportResize()
    })
  }

  // 语言切换(中英文):应用文案 → 持久化 + 主进程菜单重建 → 刷新动态组件
  const applyLocale = (locale: 'zh' | 'en'): void => {
    setLocale(locale)
    applyStaticText(locale)
    toolbar.refresh()
    statusbar.refresh()
    sidebar.refresh()
    browser.refresh()
  }

  const toolbar = new Toolbar({
    onFolderPicked: (folderPath) => void browseFolder(folderPath),
    onLibraryPick: (folderPath) => void applyLibraryRoot(folderPath),
    onBrowseToggle: () => {
      // 无页面时不切换(避免进入空的阅读视图)
      if (controller.pageCount === 0) return
      setAppView(appView === 'browse' ? 'read' : 'browse')
    },
    onLibraryRoot: () => backToLibrary(),
    onFitScreen: async () => {
      // 一键"适应屏幕":铺满当前显示器工作区(FR-8)
      const info = await window.komascope.getWindowInfo()
      await window.komascope.setWindowBounds(info.workArea)
    }
  })

  /**
   * 在缩略图浏览视图中打开目录(§资源管理器模式):
   * 工具栏/菜单/拖入/历史点击的目录入口统一走这里。
   */
  const browseFolder = async (folderPath: string): Promise<void> => {
    setAppView('browse')
    toolbar.setFolder(folderPath)
    await browser.open(folderPath)
  }

  /**
   * 应用书库根目录(§观看历史):持久化后以该书架根目录打开浏览视图。
   * 只接收**已选路径**(不弹框):选择框由入口负责,避免重复弹框(§4.1 缺陷)。
   */
  const applyLibraryRoot = async (folderPath: string): Promise<void> => {
    libraryRoot = folderPath
    void window.komascope.setConfig({ libraryRoot: folderPath })
    await browseFolder(folderPath)
  }

  /**
   * 选择书库根目录(内部弹一次选择框):仅"没有已选路径"的入口使用 ——
   * 应用菜单「打开书库目录」(Ctrl+L) 与浏览视图的引导按钮。
   * 工具栏「书库目录」按钮走 onLibraryPick(已选路径)→ applyLibraryRoot。
   */
  const pickLibrary = async (): Promise<void> => {
    const folderPath = await window.komascope.pickFolder()
    if (folderPath === null) return
    await applyLibraryRoot(folderPath)
  }

  /**
   * 一键返回书库根目录(§4.2):阅读图片时也可直接跳到书库书架的缩略图浏览视图。
   * 未设置书库时进入选择流程;浏览视图内的「书库根目录」按钮与之等价。
   */
  const backToLibrary = (): void => {
    if (libraryRoot.length === 0) {
      void pickLibrary()
      return
    }
    // 结束当前阅读(§5.2):清空阅读状态后再回书架,避免「缩略图浏览」把用户带回旧图
    controller.closeSource()
    setAppView('browse')
    browser.goToLibraryRoot()
  }

  /** 缩略图浏览按钮态:仅在存在阅读内容时可切换与高亮(§5.2) */
  const syncBrowseButton = (): void => {
    toolbar.setBrowseState(appView === 'browse', controller.pageCount > 0)
  }

  /**
   * 从"继续阅读"进入某文件夹:列举该层图片后按书签(§观看历史)续读;
   * 该文件夹本身没有图片(仅子文件夹)时退回浏览视图,由用户继续进下一级。
   */
  const resumeFolder = async (folderPath: string): Promise<void> => {
    try {
      const listing = await window.komascope.listDirectory(folderPath)
      if (listing.images.length === 0) {
        await browseFolder(folderPath)
        return
      }
      await controller.openPages(folderPath, listing.images)
      setAppView('read')
    } catch (err) {
      console.error(t('error.browseFolder'), folderPath, err)
    }
  }

  // 侧栏显示/隐藏切换
  const sidebarEl = document.getElementById('sidebar') as HTMLElement
  const sidebarBtn = document.getElementById('btn-sidebar') as HTMLButtonElement
  sidebarBtn.addEventListener('click', () => {
    sidebarEl.hidden = !sidebarEl.hidden
    // 侧栏宽度变化触发 ResizeObserver 重算画布
    const rect = viewport.getBoundingClientRect()
    renderer.resize(rect.width, rect.height, window.devicePixelRatio)
    controller.onViewportResize()
  })

  // --- 沉浸模式 / 自动隐藏(OS 全屏 + 隐藏菜单栏 + UI 浮动隐藏) ---
  const toolbarEl = document.getElementById('toolbar') as HTMLElement
  const statusbarEl = document.getElementById('statusbar') as HTMLElement
  const immersiveBtn = document.getElementById('btn-immersive') as HTMLButtonElement
  const autoHideBtn = document.getElementById('btn-auto-hide') as HTMLButtonElement
  // 光标唤醒热区(顶部/底部/左侧边缘):须明显大于 0 但小于 UI 尺寸。
  // 原 8px 在 4K 屏上难以精准触发,增大到 32px(工具栏高 52px、状态栏高 32px,
  // CSS 像素,DPR 2 下物理 64px)使鼠标靠近边缘即可唤出,不再需要贴边。
  const EDGE_PX = 32
  const HIDE_DELAY_MS = 500
  let immersive = false
  /** 非沉浸模式下 UI 自动隐藏(§需求3):与沉浸共用浮动机制 */
  let autoHide = false
  let hideTimer: number | null = null
  /** 最近一次沉浸意图时间戳:抑制本应用触发的滞后 fullscreen:changed 事件 */
  let lastImmersiveIntentAt = 0

  /** 浮动隐藏是否生效(沉浸或 autoHide) */
  const floatingActive = (): boolean =>
    document.body.classList.contains('immersive') || document.body.classList.contains('auto-hide')

  const setUiVisible = (el: HTMLElement, visible: boolean): void => {
    el.classList.toggle('ui-visible', visible)
  }

  const hideAllUi = (): void => {
    setUiVisible(toolbarEl, false)
    setUiVisible(statusbarEl, false)
    setUiVisible(sidebarEl, false)
  }

  const scheduleHide = (): void => {
    // 浮动守卫:非浮动态不启动计时;退出后残留计时器到期时若已重新进入,
    // 由 mouseenter 重新取消,此处守卫避免空转与误隐藏
    if (!floatingActive()) return
    if (hideTimer !== null) clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => {
      hideTimer = null
      if (floatingActive()) hideAllUi()
    }, HIDE_DELAY_MS)
  }

  const cancelHide = (): void => {
    if (hideTimer !== null) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  /** 鼠标是否位于任一浮动 UI 元素内(沉浸模式隐藏判断)。
   *  用 Element 而非 HTMLElement:lucide 图标为 SVG,悬停图标时
   *  e.target 是 SVGElement,HTMLElement 判断会漏判导致误隐藏。 */
  const isOverUi = (e: MouseEvent): boolean =>
    e.target instanceof Element &&
    e.target.closest('.toolbar, .statusbar, .sidebar') !== null

  // 边缘检测:鼠标移近顶部/底部/左侧边缘时滑出对应 UI;
  // 离开边缘或 UI 后 scheduleHide 延时隐藏(移出 UI 后即使鼠标静止,
  // mouseleave 也会启动计时,修复"移出后不自动隐藏")
  window.addEventListener('mousemove', (e) => {
    if (!floatingActive()) return
    const nearTop = e.clientY <= EDGE_PX
    const nearBottom = e.clientY >= window.innerHeight - EDGE_PX
    const nearLeft = e.clientX <= EDGE_PX
    if (nearTop || nearBottom || nearLeft) {
      cancelHide()
      if (nearTop) setUiVisible(toolbarEl, true)
      if (nearBottom) setUiVisible(statusbarEl, true)
      if (nearLeft) setUiVisible(sidebarEl, true)
    } else if (!isOverUi(e)) {
      scheduleHide()
    }
  })

  // 鼠标进入 UI 保持显示;移出 UI 开始隐藏计时(即使鼠标随后静止)
  for (const el of [toolbarEl, statusbarEl, sidebarEl]) {
    el.addEventListener('mouseenter', cancelHide)
    el.addEventListener('mouseleave', scheduleHide)
  }

  // 鼠标离开窗口:立即隐藏全部 UI
  window.addEventListener('mouseleave', () => {
    if (floatingActive()) hideAllUi()
  })

  const setImmersive = async (enabled: boolean): Promise<void> => {
    lastImmersiveIntentAt = Date.now()
    immersive = enabled
    document.body.classList.toggle('immersive', enabled)
    if (!enabled) hideAllUi()
    // 主进程重建为无边框(沉浸)/有边框窗口(可查看系统菜单,§需求)
    await window.komascope.setImmersive(enabled)
  }

  immersiveBtn.addEventListener('click', () => {
    void setImmersive(!immersive)
  })

  // 无边框窗口自绘控制按钮(最小化/最大化/关闭,§需求)
  const winMinBtn = document.getElementById('btn-win-min') as HTMLButtonElement
  const winMaxBtn = document.getElementById('btn-win-max') as HTMLButtonElement
  const winCloseBtn = document.getElementById('btn-win-close') as HTMLButtonElement
  winMinBtn.addEventListener('click', () => void window.komascope.minimizeWindow())
  winMaxBtn.addEventListener('click', () => void window.komascope.maximizeToggleWindow())
  winCloseBtn.addEventListener('click', () => void window.komascope.closeWindow())

  // 非沉浸模式自动隐藏开关(§需求3):开启后侧栏/工具栏/状态栏浮动隐藏
  const setAutoHide = (enabled: boolean): void => {
    autoHide = enabled
    document.body.classList.toggle('auto-hide', enabled)
    void window.komascope.setConfig({ autoHide: enabled })
    if (enabled) hideAllUi()
  }

  autoHideBtn.addEventListener('click', () => {
    setAutoHide(!autoHide)
  })

  // 系统方式进入/退出全屏(Win+Shift+Enter 等)→ 同步沉浸 UI。
  // 本应用 setImmersive 触发的 fullscreen:changed 事件可能滞后到达
  // (连点 F 时 enter 事件晚于第二次退出意图),500ms 内忽略避免覆盖。
  window.komascope.onFullScreenChanged((isFullScreen) => {
    if (Date.now() - lastImmersiveIntentAt < 500) return
    if (isFullScreen) {
      if (!immersive) void setImmersive(true)
    } else if (immersive) {
      void setImmersive(false)
    }
  })

  // 视口中心(+/− 缩放锚点,§5)
  const viewportCenter = (): Point => {
    const v = renderer.viewportSize
    return { x: v.width / 2, y: v.height / 2 }
  }

  // 输入映射(§5 交互表)
  new InputController({
    onPathsDropped: (paths) => {
      void (async () => {
        try {
          const first = await window.komascope.statPath(paths[0])
          if (first.isDirectory) {
            // 拖入目录 → 缩略图浏览视图(§资源管理器模式)
            await browseFolder(paths[0])
          } else if (paths.length === 1 && isArchiveFile(paths[0])) {
            // 拖入单个 cbz/zip:作为压缩包打开(§13 P0)
            await controller.openArchive(paths[0])
            setAppView('read')
          } else {
            paths.sort((a, b) => naturalCompare(fileName(a), fileName(b)))
            await controller.openFiles(paths)
            setAppView('read')
          }
        } catch {
          // 拖入路径可能已被删除/移动,避免未捕获 rejection
          console.error(t('error.openDroppedPath'), paths[0])
        }
      })()
    },
    onPanMove: (dx, dy) => controller.translateBy(dx, dy),
    onWheelZoom: (x, y, deltaY) => controller.zoomAt({ x, y }, wheelDeltaToFactor(deltaY)),
    onWheelPage: (deltaY) => {
      // 侧栏内滚轮:向上=上一页,向下=下一页(与图片列表滚动方向一致)
      if (deltaY < 0) controller.prevPage()
      else controller.nextPage()
    },
    onLongViewZoom: (factor) => longView.zoomBy(factor),
    onDoubleClick: () => controller.toggleFitScreenCustom(),
    onKeyDown: (e) => {
      // 浏览视图(§资源管理器模式):方向键/Enter/Backspace 交给浏览视图处理,
      // 阅读快捷键(缩放/翻页/适配)不生效
      if (appView === 'browse') {
        if (browser.handleKey(e)) e.preventDefault()
        return
      }
      switch (e.key) {
        case 'ArrowLeft':
          controller.prevPage()
          break
        case 'ArrowRight':
          controller.nextPage()
          break
        case '+':
        case '=':
          e.preventDefault()
          controller.zoomAt(viewportCenter(), 1.25)
          break
        case '-':
        case '_':
          e.preventDefault()
          controller.zoomAt(viewportCenter(), 0.8)
          break
        case '0':
          controller.setFitMode('fitScreen')
          break
        case '1':
          controller.setFitMode('actual')
          break
        case 'w':
        case 'W':
          controller.setFitMode('fitWidth')
          break
        case 'h':
        case 'H':
          controller.setFitMode('fitHeight')
          break
        case 'l':
        case 'L':
          controller.setLocked(!controller.isLocked)
          break
        case 'r':
        case 'R':
          controller.resetView()
          break
        case 'f':
        case 'F':
          e.preventDefault()
          void window.komascope.toggleFullscreen()
          break
        case 'Escape':
          // 沉浸模式:退出无边框沉浸并恢复 UI;全屏:退出 OS 全屏;
          // 两者都不是:从阅读视图返回缩略图浏览(§资源管理器模式)
          if (immersive) {
            void setImmersive(false)
          } else {
            void (async () => {
              const info = await window.komascope.getWindowInfo()
              if (info.isFullScreen) {
                await window.komascope.toggleFullscreen()
                return
              }
              if (appView === 'read') setAppView('browse')
            })()
          }
          break
      }
    }
  })

  // 视口尺寸变化(窗口 resize / 全屏):重设画布物理尺寸并重算适配(§4.4)
  const viewport = document.getElementById('viewport') as HTMLElement
  const observer = new ResizeObserver((entries) => {
    const rect = entries[0].contentRect
    renderer.resize(rect.width, rect.height, window.devicePixelRatio)
    controller.onViewportResize()
  })
  observer.observe(viewport)

  // DPR 变化监听(拖动到不同缩放显示器,§4.4 / §12)
  watchDpr()

  // lucide 图标:替换 [data-lucide] 元素为 SVG(在文案应用之前执行)。
  // 注意:index.html 中出现的每个 data-lucide 名称都必须在此注册,
  // 否则该图标不渲染(lucide 仅告警)。动态创建的元素由 browser.ts 用 createElement 直接构建。
  createIcons({
    icons: {
      BookOpen,
      CornerLeftUp,
      FolderOpen,
      House,
      LayoutGrid,
      Library,
      Lock,
      Maximize,
      Minus,
      MousePointerClick,
      PanelLeft,
      Rows3,
      Scan,
      Square,
      X
    }
  })

  // 应用菜单动作(主进程 File/View 菜单,§5 快捷键等价)
  window.komascope.onMenuAction((action) => {
    switch (action) {
      case 'open-folder':
        void window.komascope.pickFolder().then((folderPath) => {
          if (folderPath !== null) void browseFolder(folderPath)
        })
        break
      case 'open-archive':
        void window.komascope.openArchiveDialog().then((result) => {
          if (result) {
            toolbar.setFolder(result.folderPath)
            void controller.openArchive(result.folderPath).then(() => setAppView('read'))
          }
        })
        break
      case 'open-library':
        void pickLibrary()
        break
      case 'toggle-browse':
        // 菜单/快捷键等价于工具栏"缩略图浏览"按钮
        if (controller.pageCount > 0) setAppView(appView === 'browse' ? 'read' : 'browse')
        break
      case 'prev-page':
        controller.prevPage()
        break
      case 'next-page':
        controller.nextPage()
        break
      case 'zoom-in':
        controller.zoomAt(viewportCenter(), 1.25)
        break
      case 'zoom-out':
        controller.zoomAt(viewportCenter(), 0.8)
        break
      case 'fit-width':
        controller.setFitMode('fitWidth')
        break
      case 'fit-height':
        controller.setFitMode('fitHeight')
        break
      case 'fit-screen':
        controller.setFitMode('fitScreen')
        break
      case 'actual-size':
        controller.setFitMode('actual')
        break
      case 'reset-view':
        controller.resetView()
        break
      case 'toggle-layout':
        controller.toggleLayoutMode()
        break
      case 'rotate-cw':
        controller.rotateCw()
        break
      case 'flip-h':
        controller.flipHorizontal()
        break
      case 'flip-v':
        controller.flipVertical()
        break
      case 'toggle-fullscreen':
        // View 菜单"沉浸模式":切换非全屏无边框沉浸(§需求)
        void setImmersive(!immersive)
        break
    }
  })

  // 菜单 Language 切换 → 渲染进程同步语言
  window.komascope.onLocaleChanged((locale) => {
    applyLocale(locale)
  })

  // 恢复上次会话:语言 + 历史 + 适配模式/缩放锁定(FR-9)。
  // 注意:不恢复 lastFolder 显示——文件夹名仅当用户点击历史或打开
  // 新文件夹后才显示,关闭软件后自动清除(§用户需求)。
  void window.komascope
    .getConfig()
    .then((config) => {
      if (isLocale(config.locale)) applyLocale(config.locale)
      else applyLocale('zh')
      sidebar.setHistory(config.recentFolders)
      controller.restoreConfig(config)
      // 书签 + 书库根目录(§观看历史):启动即进入书库(自动列出下一级文件夹)
      bookmarks = config.bookmarks
      libraryRoot = config.libraryRoot
      if (config.autoHide) setAutoHide(true)
      if (libraryRoot.length > 0) void browseFolder(libraryRoot)
      else {
        setAppView('browse')
        browser.showWelcome()
      }
      // 按持久化语言重建应用菜单
      void window.komascope.setMenuLocale(isLocale(config.locale) ? config.locale : 'zh')
    })
    .catch((err) => console.error(t('error.loadConfig'), err))

  // 启动同步无边框(沉浸)状态:退出沉浸重建窗口后,新渲染进程据此恢复 UI
  void window.komascope
    .getWindowInfo()
    .then((info) => {
      if (info.frameless && !immersive) {
        immersive = true
        document.body.classList.add('immersive')
      }
    })
    .catch(() => {
      // 窗口信息读取失败时保持默认(非沉浸)
    })
}

main()
