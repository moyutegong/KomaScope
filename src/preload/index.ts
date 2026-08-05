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

const api: KomaScopeApi = {
  openFolderDialog: () => ipcRenderer.invoke('folder:open'),
  openArchiveDialog: () => ipcRenderer.invoke('archive:open'),
  scanFolder: (folderPath) => ipcRenderer.invoke('folder:scan', folderPath),
  scanArchive: (archivePath) => ipcRenderer.invoke('archive:scan', archivePath),
  readArchiveEntry: (archivePath, entryName) =>
    ipcRenderer.invoke('archive:read', archivePath, entryName),
  readMeta: (path) => ipcRenderer.invoke('file:readMeta', path),
  statPath: (path) => ipcRenderer.invoke('fs:stat', path),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  fileUrl: (path) => toFileUrl(path),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  removeRecentFolder: (path) => ipcRenderer.invoke('config:removeRecentFolder', path),
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
  onFullScreenChanged: (handler) => {
    ipcRenderer.on('fullscreen:changed', (_event, isFullScreen: unknown) => {
      if (typeof isFullScreen === 'boolean') handler(isFullScreen)
    })
  }
}

contextBridge.exposeInMainWorld('komascope', api)
