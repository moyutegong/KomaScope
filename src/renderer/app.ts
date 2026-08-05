/**
 * 渲染进程入口:装配 UI、ViewerController、输入映射与配置恢复。
 * M3 范围:平移/锚点缩放/适配切换/缩放锁定/快捷键(§5)。
 */
import { BookOpen, FolderOpen, Lock, Maximize, PanelLeft, Scan, createIcons } from 'lucide'
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
    }
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

  // --- 沉浸模式(OS 全屏 + 隐藏菜单栏 + UI 浮动隐藏) ---
  const toolbarEl = document.getElementById('toolbar') as HTMLElement
  const statusbarEl = document.getElementById('statusbar') as HTMLElement
  const immersiveBtn = document.getElementById('btn-immersive') as HTMLButtonElement
  const EDGE_PX = 8
  const HIDE_DELAY_MS = 500
  let immersive = false
  let hideTimer: number | null = null
  /** 最近一次沉浸意图时间戳:抑制本应用触发的滞后 fullscreen:changed 事件 */
  let lastImmersiveIntentAt = 0

  const setUiVisible = (el: HTMLElement, visible: boolean): void => {
    el.classList.toggle('ui-visible', visible)
  }

  const hideAllUi = (): void => {
    setUiVisible(toolbarEl, false)
    setUiVisible(statusbarEl, false)
    setUiVisible(sidebarEl, false)
  }

  const scheduleHide = (): void => {
    if (hideTimer !== null) clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => {
      hideTimer = null
      if (document.body.classList.contains('immersive')) hideAllUi()
    }, HIDE_DELAY_MS)
  }

  const cancelHide = (): void => {
    if (hideTimer !== null) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  /** 鼠标是否位于任一浮动 UI 元素内(沉浸模式隐藏判断) */
  const isOverUi = (e: MouseEvent): boolean =>
    e.target instanceof HTMLElement &&
    e.target.closest('.toolbar, .statusbar, .sidebar') !== null

  // 边缘检测:鼠标移近顶部/底部/左侧边缘时滑出对应 UI;
  // 离开边缘或 UI 后 scheduleHide 延时隐藏(移出 UI 后即使鼠标静止,
  // mouseleave 也会启动计时,修复"移出后不自动隐藏")
  window.addEventListener('mousemove', (e) => {
    if (!document.body.classList.contains('immersive')) return
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
    if (document.body.classList.contains('immersive')) hideAllUi()
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
  createIcons({ icons: { BookOpen, FolderOpen, Lock, Maximize, PanelLeft, Scan } })

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

  // 恢复上次会话:语言 + 历史 + 文件夹显示 + 适配模式/缩放锁定(FR-9)
  void window.komascope
    .getConfig()
    .then((config) => {
      if (isLocale(config.locale)) applyLocale(config.locale)
      else applyLocale('zh')
      sidebar.setHistory(config.recentFolders)
      if (config.lastFolder) toolbar.setFolder(config.lastFolder)
      controller.restoreConfig(config)
      // 按持久化语言重建应用菜单
      void window.komascope.setMenuLocale(isLocale(config.locale) ? config.locale : 'zh')
    })
    .catch((err) => console.error(t('error.loadConfig'), err))
}

main()
