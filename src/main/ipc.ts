/**
 * IPC 路由与自定义文件协议(4.2 / NFR-5)。
 * 所有通道均做参数类型校验,渲染进程无 Node 权限。
 */
import { BrowserWindow, dialog, ipcMain, net, protocol, screen } from 'electron'
import { stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { readImageMeta, scanFolder } from './file-service'
import { configStore } from './config-store'
import type { AppConfig, PathStat, WindowInfo } from '../shared/types'

/** 自定义协议名:渲染进程经 fetch 流式读取本地图片(4.2) */
export const FILE_PROTOCOL = 'komascope-file'

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isBounds(v: unknown): v is { x: number; y: number; width: number; height: number } {
  if (typeof v !== 'object' || v === null) return false
  const b = v as Record<string, unknown>
  return [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n))
}

function getWindowInfo(win: BrowserWindow): WindowInfo {
  const bounds = win.getBounds()
  const display = screen.getDisplayMatching(bounds)
  return {
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    workArea: {
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: display.workArea.height
    },
    dpr: display.scaleFactor,
    screenId: display.id.toString(),
    isFullScreen: win.isFullScreen()
  }
}

/**
 * 注册自定义文件协议:komascope-file:///C:/path/to/img.jpg
 * → net.fetch(file://C:/path/to/img.jpg) 流式返回,主进程不参与像素处理。
 */
export function registerFileProtocol(): void {
  protocol.handle(FILE_PROTOCOL, (request) => {
    const url = new URL(request.url)
    let filePath = decodeURIComponent(url.pathname)
    // Windows 绝对路径:pathname 形如 /F:/a/b.jpg,去掉前导 '/'
    if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1)
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

/** 注册全部 IPC 通道(4.2 清单) */
export function registerIpc(): void {
  // --- 配置 ---
  ipcMain.handle('config:get', () => configStore.get())
  ipcMain.handle('config:set', (_event, patch: unknown): AppConfig => {
    if (typeof patch !== 'object' || patch === null) throw new Error('config:set 需要对象补丁')
    return configStore.set(patch as Partial<AppConfig>)
  })

  // --- 文件夹 ---
  ipcMain.handle('folder:open', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '打开漫画文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const folderPath = result.filePaths[0]
    const pages = await scanFolder(folderPath)
    return { folderPath, pages }
  })

  ipcMain.handle('folder:scan', async (_event, folderPath: unknown) => {
    if (!isNonEmptyString(folderPath)) throw new Error('folder:scan 需要非空路径')
    const pages = await scanFolder(folderPath)
    return { folderPath, pages }
  })

  // --- 图片元数据(头部解析,不解码全图) ---
  ipcMain.handle('file:readMeta', async (_event, path: unknown) => {
    if (!isNonEmptyString(path)) throw new Error('file:readMeta 需要非空路径')
    return readImageMeta(path)
  })

  // --- 路径类型判定(拖拽导入,FR-2) ---
  ipcMain.handle('fs:stat', async (_event, path: unknown): Promise<PathStat> => {
    if (!isNonEmptyString(path)) throw new Error('fs:stat 需要非空路径')
    const s = await stat(path)
    return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size }
  })

  // --- 窗口 ---
  ipcMain.handle('window:getInfo', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('window:getInfo 找不到窗口')
    return getWindowInfo(win)
  })

  ipcMain.handle('window:setBounds', (event, bounds: unknown) => {
    if (!isBounds(bounds)) throw new Error('window:setBounds 参数非法')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('window:setBounds 找不到窗口')
    win.setBounds(bounds)
  })

  ipcMain.handle('window:toggleFullscreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('window:toggleFullscreen 找不到窗口')
    win.setFullScreen(!win.isFullScreen())
    return win.isFullScreen()
  })
}
