/**
 * 窗口管理(FR-8 / §4.4):窗口创建、默认尺寸、几何记忆、多显示器定位、全屏。
 * 首次启动按主显示器工作区取 min(88%, 3360×1890);后续按记忆恢复。
 */
import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { centerInWorkArea, clampBoundsToDisplay } from '../shared/geometry'
import { configStore } from './config-store'

/** 首次启动默认尺寸上限(§4.4) */
export const MAX_DEFAULT_WIDTH = 3360
export const MAX_DEFAULT_HEIGHT = 1890
/** 首次启动默认占工作区比例(§4.4) */
const DEFAULT_WORKAREA_RATIO = 0.88
/** 几何记录防抖(ms) */
const GEOMETRY_DEBOUNCE_MS = 500

function defaultBounds(): { x: number; y: number; width: number; height: number } {
  const wa = screen.getPrimaryDisplay().workArea
  return centerInWorkArea(
    Math.min(Math.round(wa.width * DEFAULT_WORKAREA_RATIO), MAX_DEFAULT_WIDTH),
    Math.min(Math.round(wa.height * DEFAULT_WORKAREA_RATIO), MAX_DEFAULT_HEIGHT),
    wa
  )
}

/** 取上次所在显示器(多显示器记忆,§4.4);找不到时回退主显示器 */
export function restoreDisplayId(saved: string): string {
  const displays = screen.getAllDisplays()
  if (saved && displays.some((d) => d.id.toString() === saved)) return saved
  return screen.getPrimaryDisplay().id.toString()
}

export function createMainWindow(): BrowserWindow {
  const saved = configStore.get()
  let bounds =
    saved.screenId !== '' && saved.windowBounds.width > 0
      ? saved.windowBounds
      : defaultBounds()

  // 多显示器记忆:定位到上次所在显示器;若显示器布局变化导致越界,校正到其工作区内
  const displayId = restoreDisplayId(saved.screenId)
  const display =
    screen.getAllDisplays().find((d) => d.id.toString() === displayId) ??
    screen.getPrimaryDisplay()
  bounds = clampBoundsToDisplay(bounds, display.workArea)

  // 窗口标题栏图标(lucide image 图标;打包后经 extraResources 置于 resourcesPath)
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'window-icon.png')
    : join(__dirname, '../../resources/window-icon.png')

  const win = new BrowserWindow({
    ...bounds,
    icon: iconPath,
    show: false,
    backgroundColor: '#121212',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // 记忆窗口几何:resize/move 停止后防抖落盘(§4.5)
  let geometryTimer: ReturnType<typeof setTimeout> | null = null
  const rememberGeometry = (): void => {
    if (geometryTimer !== null) clearTimeout(geometryTimer)
    geometryTimer = setTimeout(() => {
      geometryTimer = null
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
      const [x, y] = win.getPosition()
      const [w, h] = win.getSize()
      const display = screen.getDisplayMatching(win.getBounds())
      configStore.set({
        windowBounds: { x, y, width: w, height: h },
        screenId: display.id.toString()
      })
    }, GEOMETRY_DEBOUNCE_MS)
  }
  win.on('resize', rememberGeometry)
  win.on('move', rememberGeometry)

  win.once('ready-to-show', () => win.show())

  // 开发模式加载 dev server,生产加载打包产物
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
