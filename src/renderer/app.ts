/**
 * 渲染进程入口:装配 UI、ViewerController、输入映射与配置恢复。
 * M3 范围:平移/锚点缩放/适配切换/缩放锁定/快捷键(§5)。
 */
import { BookOpen, FolderOpen, Languages, Lock, Maximize, createIcons } from 'lucide'
import type { ScanResult } from '../shared/types'
import type { Point } from '../shared/transform-model'
import { naturalCompare } from '../shared/natural-sort'
import { applyStaticText, getLocale, isLocale, setLocale, t } from './i18n'
import { ImageRenderer } from './viewer/image-renderer'
import { InputController, wheelDeltaToFactor } from './viewer/input-controller'
import { ViewerController } from './viewer/viewer-controller'
import { Toolbar } from './ui/toolbar'
import { StatusBar } from './ui/statusbar'

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function main(): void {
  const statusbar = new StatusBar()
  const renderer = new ImageRenderer(document.getElementById('canvas') as HTMLCanvasElement)
  const controller = new ViewerController(renderer, statusbar, {
    onFolderChanged: (folderPath) => toolbar.setFolder(folderPath)
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

  // 语言切换(中英文):应用文案 → 持久化 → 刷新动态组件
  const applyLocale = (locale: 'zh' | 'en'): void => {
    setLocale(locale)
    applyStaticText(locale)
    toolbar.refresh()
    statusbar.refresh()
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
    },
    onToggleLang: () => {
      const next = getLocale() === 'zh' ? 'en' : 'zh'
      applyLocale(next)
      void window.komascope.setConfig({ locale: next })
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
        const first = await window.komascope.statPath(paths[0])
        if (first.isDirectory) {
          await controller.openFolder(paths[0])
        } else {
          paths.sort((a, b) => naturalCompare(fileName(a), fileName(b)))
          await controller.openFiles(paths)
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
        case 'F11':
          e.preventDefault()
          void window.komascope.toggleFullscreen()
          break
        case 'Escape':
          void exitFullscreenIfNeeded()
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
  createIcons({ icons: { BookOpen, FolderOpen, Languages, Lock, Maximize } })

  // 恢复上次会话:语言 + 文件夹显示 + 适配模式/缩放锁定(FR-9)
  void window.komascope
    .getConfig()
    .then((config) => {
      if (isLocale(config.locale)) applyLocale(config.locale)
      else applyLocale('zh')
      if (config.lastFolder) toolbar.setFolder(config.lastFolder)
      controller.restoreConfig(config)
    })
    .catch((err) => console.error(t('error.loadConfig'), err))
}

main()
