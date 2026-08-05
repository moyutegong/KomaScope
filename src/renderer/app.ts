/**
 * 渲染进程入口:装配 UI、ViewerController、输入映射与配置恢复。
 * M3 范围:平移/锚点缩放/适配切换/缩放锁定/快捷键(§5)。
 */
import { BookOpen, FolderOpen, Lock, Maximize, MousePointerClick, PanelLeft, Rows3, Scan, createIcons } from 'lucide'
import type { ScanResult } from '../shared/types'
import type { Point } from '../shared/transform-model'
import { naturalCompare } from '../shared/natural-sort'
import { applyStaticText, isLocale, setLocale, t } from './i18n'
import { ImageRenderer } from './viewer/image-renderer'
import { InputController, wheelDeltaToFactor } from './viewer/input-controller'
import { ViewerController } from './viewer/viewer-controller'
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
    }
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

  const setViewMode = (mode: 'page' | 'long'): void => {
    viewMode = mode
    const long = mode === 'long'
    longView.setVisible(long)
    // 长图模式:隐藏 placeholder(避免覆盖拦截点击);退出后:
    // 有图片 → renderer.setVisible(true) 恢复 canvas 并隐藏提示;
    // 无图片 → 显示 placeholder
    if (long) {
      canvasEl.hidden = true
      placeholderEl.hidden = true
    } else {
      canvasEl.hidden = false
      if (controller.pageCount > 0) {
        renderer.setVisible(true)
      } else {
        placeholderEl.hidden = false
      }
      controller.applyFit()
    }
    viewModeBtn.classList.toggle('toolbar-btn-active', long)
  }

  viewModeBtn.addEventListener('click', () => {
    setViewMode(viewMode === 'page' ? 'long' : 'page')
  })

  const sidebar = new Sidebar({
    onOpenPath: (path) => {
      void (async () => {
        try {
          const s = await window.komascope.statPath(path)
          if (s.isDirectory) {
            await controller.openFolder(path)
          } else if (isArchiveFile(path)) {
            await controller.openArchive(path)
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
  }

  const toolbar = new Toolbar({
    onFolderOpened: (result: ScanResult) => {
      toolbar.setFolder(result.folderPath)
      void controller.openFolder(result.folderPath)
    },
    onFitScreen: async () => {
      // 一键"适应屏幕":铺满当前显示器工作区(FR-8)
      const info = await window.komascope.getWindowInfo()
      await window.komascope.setWindowBounds(info.workArea)
    }
  })

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
  const EDGE_PX = 8
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
    await window.komascope.setImmersive(enabled)
  }

  immersiveBtn.addEventListener('click', () => {
    void setImmersive(!immersive)
  })

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

  const exitFullscreenIfNeeded = async (): Promise<void> => {
    const info = await window.komascope.getWindowInfo()
    if (info.isFullScreen) await window.komascope.toggleFullscreen()
  }

  // 输入映射(§5 交互表)
  new InputController({
    onPathsDropped: (paths) => {
      void (async () => {
        try {
          const first = await window.komascope.statPath(paths[0])
          if (first.isDirectory) {
            await controller.openFolder(paths[0])
          } else if (paths.length === 1 && isArchiveFile(paths[0])) {
            // 拖入单个 cbz/zip:作为压缩包打开(§13 P0)
            await controller.openArchive(paths[0])
          } else {
            paths.sort((a, b) => naturalCompare(fileName(a), fileName(b)))
            await controller.openFiles(paths)
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
          void setImmersive(!immersive)
          break
        case 'Escape':
          // 沉浸模式:退出全屏并恢复 UI;普通全屏:仅退出全屏
          if (immersive) void setImmersive(false)
          else void exitFullscreenIfNeeded()
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

  // lucide 图标:替换 [data-lucide] 元素为 SVG(在文案应用之前执行)
  createIcons({ icons: { BookOpen, FolderOpen, Lock, Maximize, MousePointerClick, PanelLeft, Rows3, Scan } })

  // 应用菜单动作(主进程 File/View 菜单,§5 快捷键等价)
  window.komascope.onMenuAction((action) => {
    switch (action) {
      case 'open-folder':
        void window.komascope.openFolderDialog().then((result) => {
          if (result) {
            toolbar.setFolder(result.folderPath)
            void controller.openFolder(result.folderPath)
          }
        })
        break
      case 'open-archive':
        void window.komascope.openArchiveDialog().then((result) => {
          if (result) {
            toolbar.setFolder(result.folderPath)
            void controller.openArchive(result.folderPath)
          }
        })
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
      if (config.autoHide) setAutoHide(true)
      // 按持久化语言重建应用菜单
      void window.komascope.setMenuLocale(isLocale(config.locale) ? config.locale : 'zh')
    })
    .catch((err) => console.error(t('error.loadConfig'), err))
}

main()
