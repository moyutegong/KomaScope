/**
 * IPC 路由与自定义文件协议(4.2 / NFR-5)。
 * 所有通道均做参数类型校验,渲染进程无 Node 权限。
 */
import { BrowserWindow, dialog, ipcMain, net, protocol, screen } from 'electron'
import { stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { listDirectory, readImageMeta } from './file-service'
import { readArchiveEntry, scanArchive } from './zip-source'
import { createSingleFlight } from '../shared/single-flight'
import {
  IMAGE_SOURCE_PROTOCOL,
  parseImageSourceParams,
  readImageSourceMeta,
  renderImageSource
} from './image-source'
import { configStore } from './config-store'
import { buildAppMenu } from './menu'
import { rebuildMainWindow } from './window-manager'
import type { AppConfig, BookmarkInput, BookmarkMap, DirectoryListing, PathStat, WindowInfo } from '../shared/types'

/** 自定义协议名:渲染进程经 fetch 流式读取本地图片(4.2) */
export const FILE_PROTOCOL = 'komascope-file'

/**
 * 目录选择对话框的重入保护(§4.1 缺陷修复):同一时刻只允许一个选择框在开。
 * 重复触发(双击 / 事件重复绑定 / 菜单与按钮混用)时第二次直接返回 null,不再叠加弹框。
 */
const pickFolderOnce = createSingleFlight<string | null>()

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isBounds(v: unknown): v is { x: number; y: number; width: number; height: number } {
  if (typeof v !== 'object' || v === null) return false
  const b = v as Record<string, unknown>
  return [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n))
}

/** 非负整数校验(书签下标/数量:拒绝 NaN/负数/小数,防止脏数据落盘) */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

/** 校验 config:setBookmark 载荷,非法抛错(IPC 边界,§NFR-5) */
function parseBookmarkInput(v: unknown): BookmarkInput {
  if (typeof v !== 'object' || v === null) throw new Error('config:setBookmark 需要对象')
  const b = v as Record<string, unknown>
  if (!isNonEmptyString(b.folderPath)) throw new Error('config:setBookmark 需要 folderPath')
  if (!isNonEmptyString(b.lastImagePath)) throw new Error('config:setBookmark 需要 lastImagePath')
  if (!isCount(b.lastIndex) || !isCount(b.pageCount)) {
    throw new Error('config:setBookmark 需要非负整数下标')
  }
  return {
    folderPath: b.folderPath,
    lastImagePath: b.lastImagePath,
    lastIndex: Math.floor(b.lastIndex),
    pageCount: Math.floor(b.pageCount)
  }
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
    isFullScreen: win.isFullScreen(),
    frameless: !win.isMenuBarVisible()
  }
}

/**
 * 注册自定义文件协议:komascope-file:///C:/path/to/img.jpg
 * → net.fetch(file://C:/path/to/img.jpg) 流式返回,主进程不参与像素处理。
 */

/**
 * 声明协议特权(必须在 app ready 之前调用,§4.2):
 * - secure:视为安全来源
 * - supportFetchAPI:渲染进程可用 fetch() 访问该协议
 * - corsEnabled:允许渲染进程跨源 fetch(否则渲染进程 fetch 报 Failed to fetch)
 * - stream:响应体可流式读取(createImageBitmap 增量解码)
 * - 注意:不能启用 standard —— standard scheme 会把 Windows 盘符
 *   (komascope-file:///F:/path 中的 F:)解析为 host,导致路径损坏
 */
export function registerFileSchemePrivilege(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FILE_PROTOCOL,
      privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    },
    {
      scheme: IMAGE_SOURCE_PROTOCOL,
      privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

export function registerFileProtocol(): void {
  protocol.handle(FILE_PROTOCOL, async (request) => {
    const url = new URL(request.url)
    let filePath = decodeURIComponent(url.pathname)
    // Windows 绝对路径:pathname 形如 /F:/a/b.jpg,去掉前导 '/'
    if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1)
    const res = await net.fetch(pathToFileURL(filePath).toString())
    // CORS:允许渲染进程(file:// 或 dev server 来源)跨源读取
    const headers = new Headers(res.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  })

  // 统一图片源协议(sharp 流式缩放):缩略图与大图分层服务(§性能)
  protocol.handle(IMAGE_SOURCE_PROTOCOL, async (request) => {
    const url = new URL(request.url)
    const params = parseImageSourceParams(url)
    if (!params) {
      return new Response('Bad Request', { status: 400 })
    }
    // ETag 协商缓存:同一图片同一宽度重复请求返回 304
    const etagHint = request.headers.get('if-none-match')
    try {
      const { body, etag } = await renderImageSource(params)
      if (etagHint === etag) {
        return new Response(null, { status: 304 })
      }
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=3600',
          ETag: etag,
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return new Response(message, { status: 404 })
    }
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
  ipcMain.handle('config:removeRecentFolder', (_event, path: unknown): string[] => {
    if (!isNonEmptyString(path)) throw new Error('config:removeRecentFolder 需要非空路径')
    return configStore.removeRecentFolder(path)
  })
  ipcMain.handle('config:addRecentFolder', (_event, path: unknown): string[] => {
    if (!isNonEmptyString(path)) throw new Error('config:addRecentFolder 需要非空路径')
    return configStore.addRecentFolder(path)
  })
  ipcMain.handle('config:setBookmark', (_event, bookmark: unknown): BookmarkMap =>
    configStore.setBookmark(parseBookmarkInput(bookmark))
  )

  // --- 菜单(语言切换后重建应用菜单) ---
  ipcMain.handle('menu:set-locale', (event, locale: unknown) => {
    if (locale !== 'zh' && locale !== 'en') throw new Error('menu:set-locale 参数非法')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('menu:set-locale 找不到窗口')
    buildAppMenu(locale, win)
  })

  // --- 文件夹(浏览视图:选择目录 + 列举当前层,§资源管理器模式) ---
  ipcMain.handle('folder:pick', async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return pickFolderOnce(async () => {
      const result = await dialog.showOpenDialog(win ?? undefined!, {
        title: '选择文件夹',
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    })
  })

  ipcMain.handle('folder:list', async (_event, folderPath: unknown): Promise<DirectoryListing> => {
    if (!isNonEmptyString(folderPath)) throw new Error('folder:list 需要非空路径')
    return listDirectory(folderPath)
  })

  // --- 压缩包源(zip/cbz,§13 P0) ---
  ipcMain.handle('archive:open', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '打开漫画压缩包',
      properties: ['openFile'],
      filters: [{ name: 'Comic archives', extensions: ['cbz', 'zip'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const archivePath = result.filePaths[0]
    const pages = await scanArchive(archivePath)
    return { folderPath: archivePath, pages }
  })

  ipcMain.handle('archive:scan', async (_event, archivePath: unknown) => {
    if (!isNonEmptyString(archivePath)) throw new Error('archive:scan 需要非空路径')
    const pages = await scanArchive(archivePath)
    return { folderPath: archivePath, pages }
  })

  ipcMain.handle('archive:read', async (_event, archivePath: unknown, entryName: unknown) => {
    if (!isNonEmptyString(archivePath) || !isNonEmptyString(entryName)) {
      throw new Error('archive:read 参数非法')
    }
    return readArchiveEntry(archivePath, entryName)
  })

  // --- 图片元数据(头部解析,不解码全图;§格式:头部失败回退 sharp) ---
  ipcMain.handle('file:readMeta', async (_event, path: unknown, archiveEntry: unknown) => {
    if (!isNonEmptyString(path)) throw new Error('file:readMeta 需要非空路径')
    // 压缩包源:sharp 解压条目后读元数据(头部解析无法随机读压缩流)
    if (isNonEmptyString(archiveEntry)) {
      return readImageSourceMeta({ path, archiveEntry })
    }
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

  // --- 沉浸模式(§需求):非全屏无边框窗口,隐藏标题栏/系统菜单 ---
  // frame 无法运行时切换,退出沉浸(有边框,可查看系统菜单)时重建窗口
  ipcMain.handle('window:setImmersive', (event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('window:setImmersive 需要布尔参数')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('window:setImmersive 找不到窗口')
    const win2 = rebuildMainWindow(enabled)
    buildAppMenu(configStore.get().locale as 'zh' | 'en', win2)
    return enabled
  })

  // --- 窗口控制(无边框窗口自绘按钮用,§需求) ---
  ipcMain.handle('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('window:minimize 找不到窗口')
    win.minimize()
  })
  ipcMain.handle('window:maximizeToggle', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('window:maximizeToggle 找不到窗口')
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('window:close 找不到窗口')
    win.close()
  })
}
