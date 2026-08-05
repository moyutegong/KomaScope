/**
 * 全端共享类型:IPC 协议、页面模型、配置模型。
 * 此文件不得依赖 DOM 或 Node API,可被主进程 / preload / 渲染进程共同引用。
 */

/** 适配模式(FR-6) */
export type FitMode = 'fitWidth' | 'fitHeight' | 'fitScreen' | 'actual' | 'custom'

/** 滚轮动作(FR-3 可选翻页 / FR-5 缩放) */
export type WheelAction = 'zoom' | 'page'

/** 单张图片的页面元数据(FR-1 / 4.2 folder:scan) */
export interface PageItem {
  /** 绝对路径 */
  path: string
  /** 文件名(含扩展名) */
  name: string
  /** 图片原始宽度(px,可能为 0 表示未知) */
  width: number
  /** 图片原始高度(px,可能为 0 表示未知) */
  height: number
  /** 文件字节数 */
  size: number
}

/** 应用配置(§4.5) */
export interface AppConfig {
  windowBounds: { x: number; y: number; width: number; height: number }
  /** 上次所在显示器 id,多显示器记忆 */
  screenId: string
  /** 上次打开的文件夹 */
  lastFolder: string
  /** 适配模式 */
  fitMode: FitMode
  /** custom 模式下的缩放倍率 */
  scale: number
  /** 缩放锁定状态(FR-7 语义 ②) */
  scaleLocked: boolean
  /** UI 缩放系数 */
  uiScale: number
  theme: 'dark' | 'light'
  wheelAction: WheelAction
  /** 界面语言(中英文切换) */
  locale: 'zh' | 'en'
}

/** window:getInfo 返回值(4.2) */
export interface WindowInfo {
  bounds: { x: number; y: number; width: number; height: number }
  workArea: { x: number; y: number; width: number; height: number }
  dpr: number
  screenId: string
  isFullScreen: boolean
}

/** folder:scan 返回值 */
export interface ScanResult {
  folderPath: string
  pages: PageItem[]
}

/** fs:stat 返回值(拖拽导入路径判定用) */
export interface PathStat {
  isDirectory: boolean
  isFile: boolean
  size: number
}

/**
 * preload 通过 contextBridge 暴露到 window.komascope 的 API(白名单)。
 * 渲染进程只能调用这里列出的方法(NFR-5)。
 */
export interface KomaScopeApi {
  openFolderDialog: () => Promise<ScanResult | null>
  scanFolder: (folderPath: string) => Promise<ScanResult>
  readMeta: (path: string) => Promise<{ width: number; height: number }>
  /** 路径类型判定(拖拽导入:目录 / 文件,FR-2) */
  statPath: (path: string) => Promise<PathStat>
  /** 从拖拽的 File 对象取真实路径(Electron 30+ 移除 File.path,需经 webUtils) */
  getPathForFile: (file: File) => string
  /**
   * 构造 `komascope-file://` 自定义协议 URL(主进程注册,经 net.fetch 流式读取),
   * 渲染进程 `fetch(url)` 后 `createImageBitmap(res.body)` 增量解码(4.2 / NFR-2)。
   */
  fileUrl: (path: string) => string
  getConfig: () => Promise<AppConfig>
  setConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>
  /** 通知主进程重建应用菜单(语言切换后调用) */
  setMenuLocale: (locale: 'zh' | 'en') => Promise<void>
  /** 监听主进程菜单动作(open-folder / prev-page / zoom-in 等) */
  onMenuAction: (handler: (action: string) => void) => void
  /** 监听主进程语言切换(菜单 Language 项触发) */
  onLocaleChanged: (handler: (locale: 'zh' | 'en') => void) => void
  getWindowInfo: () => Promise<WindowInfo>
  setWindowBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>
  toggleFullscreen: () => Promise<boolean>
}

/** 渲染进程全局(window.komascope) */
declare global {
  interface Window {
    komascope: KomaScopeApi
  }
}

export {}
