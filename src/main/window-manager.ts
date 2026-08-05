/**
 * 窗口管理(FR-8 / §4.4):窗口创建、默认尺寸、几何记忆、多显示器定位、全屏。
 * 默认非全屏无边框(沉浸模式,§需求):frame:false 隐藏标题栏与系统菜单;
 * 退出沉浸时重建为有边框窗口以便查看系统菜单。F11 为 OS 全屏。
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

/**
 * 创建主窗口。
 * @param frameless 无边框(沉浸,默认 true):隐藏标题栏与系统菜单;
 *                  false 时为有边框窗口(可查看系统菜单,§需求)
 */
export function createMainWindow(frameless = true): BrowserWindow {
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
    frame: !frameless,
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

  // 无边框(沉浸)时隐藏菜单栏;有边框时显示,以便访问系统菜单(§需求)
  win.setMenuBarVisibility(!frameless)

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

  // 全屏状态被系统方式改变(如 Win+Shift+Enter 等)时通知渲染进程同步 UI(沉浸模式)
  win.on('leave-full-screen', () => {
    if (!win.isDestroyed()) win.webContents.send('fullscreen:changed', false)
  })
  win.on('enter-full-screen', () => {
    if (!win.isDestroyed()) win.webContents.send('fullscreen:changed', true)
  })

  // 开发模式加载 dev server,生产加载打包产物
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

/**
 * 切换无边框模式(沉浸 ↔ 普通,§需求):frame 无法运行时切换,
 * 销毁旧窗口并按需重建为有边框/无边框窗口,保留几何与全屏状态。
 * @param frameless true=无边框(沉浸);false=有边框(可查看系统菜单)
 */
export function rebuildMainWindow(frameless: boolean): BrowserWindow {
  const old = BrowserWindow.getAllWindows()[0]
  const bounds = old && !old.isDestroyed() ? old.getBounds() : configStore.get().windowBounds
  const wasFullScreen = old?.isFullScreen() ?? false
  old?.destroy()
  const win = createMainWindow(frameless)
  if (!wasFullScreen) win.setBounds(bounds)
  return win
}
