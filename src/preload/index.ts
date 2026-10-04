/**
 * preload(§4.1):contextBridge 暴露白名单 API 到 window.komascope。
 * sandbox: true 下仅允许 electron 白名单模块,渲染进程无 Node 权限(NFR-5)。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { KomaScopeApi } from '../shared/types'

/** 构造 komascope-file:// URL(Windows 路径需编码,保留盘符) */
function toFileUrl(path: string): string {
  // komascope-file:///F:/a/b.jpg → pathname /F:/a/b.jpg
  return 'komascope-file://' + encodeURI('/' + path.replace(/\\/g, '/'))
}

/** 构造 komascope-thumb:// URL(sharp 原生图源:缩略图/超高清分层) */
function toImageSourceUrl(
  path: string,
  opts?: {
    width?: number
    archiveEntry?: string
    region?: { x: number; y: number; width: number; height: number }
  }
): string {
  const params = new URLSearchParams()
  if (opts?.width !== undefined) params.set('w', String(opts.width))
  if (opts?.archiveEntry) params.set('entry', opts.archiveEntry)
  if (opts?.region) {
    params.set('x', String(opts.region.x))
    params.set('y', String(opts.region.y))
    params.set('rw', String(opts.region.width))
    params.set('rh', String(opts.region.height))
  }
  const base = 'komascope-thumb://' + encodeURI('/' + path.replace(/\\/g, '/'))
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

const api: KomaScopeApi = {
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  listDirectory: (folderPath) => ipcRenderer.invoke('folder:list', folderPath),
  openArchiveDialog: () => ipcRenderer.invoke('archive:open'),
  scanArchive: (archivePath) => ipcRenderer.invoke('archive:scan', archivePath),
  readArchiveEntry: (archivePath, entryName) =>
    ipcRenderer.invoke('archive:read', archivePath, entryName),
  readMeta: (path, archiveEntry) => ipcRenderer.invoke('file:readMeta', path, archiveEntry),
  statPath: (path) => ipcRenderer.invoke('fs:stat', path),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  fileUrl: (path) => toFileUrl(path),
  imageSourceUrl: (path, opts) => toImageSourceUrl(path, opts),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  removeRecentFolder: (path) => ipcRenderer.invoke('config:removeRecentFolder', path),
  addRecentFolder: (path) => ipcRenderer.invoke('config:addRecentFolder', path),
  setBookmark: (bookmark) => ipcRenderer.invoke('config:setBookmark', bookmark),
  setMenuLocale: (locale) => ipcRenderer.invoke('menu:set-locale', locale),
  onMenuAction: (handler) => {
    ipcRenderer.on('menu:action', (_event, action: string) => handler(action))
  },
  onLocaleChanged: (handler) => {
    ipcRenderer.on('locale:changed', (_event, locale: 'zh' | 'en') => handler(locale))
  },
  getWindowInfo: () => ipcRenderer.invoke('window:getInfo'),
  setWindowBounds: (bounds) => ipcRenderer.invoke('window:setBounds', bounds),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen'),
  setImmersive: (enabled) => ipcRenderer.invoke('window:setImmersive', enabled),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeToggleWindow: () => ipcRenderer.invoke('window:maximizeToggle'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onFullScreenChanged: (handler) => {
    ipcRenderer.on('fullscreen:changed', (_event, isFullScreen: unknown) => {
      if (typeof isFullScreen === 'boolean') handler(isFullScreen)
    })
  }
}

contextBridge.exposeInMainWorld('komascope', api)
