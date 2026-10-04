/**
 * 全端共享类型:IPC 协议、页面模型、配置模型。
 * 此文件不得依赖 DOM 或 Node API,可被主进程 / preload / 渲染进程共同引用。
 */

/** 适配模式(FR-6) */
export type FitMode = 'fitWidth' | 'fitHeight' | 'fitScreen' | 'actual' | 'custom'

/** 滚轮动作(FR-3 可选翻页 / FR-5 缩放) */
export type WheelAction = 'zoom' | 'page'

/** 单张图片的页面元数据(FR-1 / 4.2 folder:scan;§13 P0 压缩包源) */
export interface PageItem {
  /** 绝对路径(压缩包源为归档文件路径) */
  path: string
  /** 文件名(含扩展名) */
  name: string
  /** 图片原始宽度(px,可能为 0 表示未知) */
  width: number
  /** 图片原始高度(px,可能为 0 表示未知) */
  height: number
  /** 文件字节数 */
  size: number
  /** 压缩包内条目名(非空表示来自 zip/cbz 源,§4.2 SourceProvider) */
  archiveEntry?: string
}

/** 目录条目(浏览视图:子文件夹 / 压缩包) */
export interface DirectoryEntry {
  path: string
  name: string
}

/**
 * folder:list 返回值(浏览视图,§资源管理器模式):
 * 仅当前层内容,不递归;图片不预先解析尺寸(为 0),保证大目录秒开。
 */
export interface DirectoryListing {
  folderPath: string
  /** 子文件夹(自然排序) */
  dirs: DirectoryEntry[]
  /** 压缩包 cbz/zip(自然排序,点击直接进入阅读) */
  archives: DirectoryEntry[]
  /** 当前层图片(自然排序;width/height 为 0 表示待阅读时按需解析) */
  images: PageItem[]
}

/**
 * 文件夹书签(§观看历史):每个文件夹各自独立记录上次浏览到的图片。
 * 存于配置书的 bookmarks 表,key 为文件夹绝对路径。
 */
export interface FolderBookmark {
  /** 文件夹绝对路径(与 key 一致,便于排序/遍历) */
  folderPath: string
  /** 上次浏览的图片绝对路径(图片被移动/删除时回退第 0 张) */
  lastImagePath: string
  /** 上次浏览图片在该文件夹图片列表中的下标 */
  lastIndex: number
  /** 记录时的图片总数(书架进度显示用,避免重新扫描目录) */
  pageCount: number
  /** 更新时间戳(ms,书架"最近阅读"倒序) */
  updatedAt: number
}

/** 书签写入载荷(updatedAt 由主进程生成) */
export type BookmarkInput = Omit<FolderBookmark, 'updatedAt'>

/** 书签表:key 为文件夹绝对路径 */
export type BookmarkMap = Record<string, FolderBookmark>

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
  /** 阅读进度(§13 P1 书签):上次打开的文件夹/压缩包中的页码 */
  lastPage: number
  /** 阅读布局(§13 P1 双页跨页):single 单页 / spread 左右并排 */
  layoutMode: 'single' | 'spread'
  /** 最近打开的文件夹/压缩包历史(侧栏,上限 10,最新在前) */
  recentFolders: string[]
  /** 书库根目录(§观看历史:选择一个大目录,自动列出其下一级文件夹作为书架) */
  libraryRoot: string
  /** 各文件夹独立的阅读书签(§观看历史,key 为文件夹绝对路径) */
  bookmarks: BookmarkMap
  /** 非沉浸模式下侧栏/工具栏/状态栏自动隐藏(浮动唤出,§需求3) */
  autoHide: boolean
}

/** window:getInfo 返回值(4.2) */
export interface WindowInfo {
  bounds: { x: number; y: number; width: number; height: number }
  workArea: { x: number; y: number; width: number; height: number }
  dpr: number
  screenId: string
  isFullScreen: boolean
  /** 无边框窗口(沉浸模式,§需求):true 时隐藏标题栏与系统菜单 */
  frameless: boolean
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
  /** 选择文件夹(仅返回路径,浏览视图用:不扫描内容,大目录秒开) */
  pickFolder: () => Promise<string | null>
  /** 列举目录当前层内容(浏览视图:子文件夹 / 压缩包 / 图片,不递归) */
  listDirectory: (folderPath: string) => Promise<DirectoryListing>
  /** 打开 zip/cbz 压缩包选择对话框(§13 P0) */
  openArchiveDialog: () => Promise<ScanResult | null>
  /** 扫描 zip/cbz 压缩包,返回图片条目列表(§13 P0) */
  scanArchive: (archivePath: string) => Promise<ScanResult>
  /** 按条目名读取压缩包内单张图片字节(§13 P0) */
  readArchiveEntry: (archivePath: string, entryName: string) => Promise<Uint8Array>
  readMeta: (path: string, archiveEntry?: string) => Promise<{ width: number; height: number }>
  /** 路径类型判定(拖拽导入:目录 / 文件,FR-2) */
  statPath: (path: string) => Promise<PathStat>
  /** 从拖拽的 File 对象取真实路径(Electron 30+ 移除 File.path,需经 webUtils) */
  getPathForFile: (file: File) => string
  /**
   * 构造 `komascope-file://` 自定义协议 URL(主进程注册,经 net.fetch 流式读取),
   * 渲染进程 `fetch(url)` 后 `createImageBitmap(res.body)` 增量解码(4.2 / NFR-2)。
   */
  fileUrl: (path: string) => string
  /**
   * 构造 `komascope-thumb://` 原生图源 URL(主进程 sharp 流式缩放,§性能/§格式):
   * - 缩略图:`imageSourceUrl(path, { width: 192 })`
   * - 超高清分层:`imageSourceUrl(path, { region: { x, y, width, height } })`
   * 压缩包源传 `archiveEntry`。渲染进程直接用作 <img src>。
   */
  imageSourceUrl: (
    path: string,
    opts?: {
      width?: number
      archiveEntry?: string
      region?: { x: number; y: number; width: number; height: number }
    }
  ) => string
  getConfig: () => Promise<AppConfig>
  setConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>
  /** 原子移除最近文件夹历史(主进程内过滤,避免连续删除竞态),返回删除后列表 */
  removeRecentFolder: (path: string) => Promise<string[]>
  /** 原子追加最近文件夹历史(主进程内去重置顶,避免连续打开竞态),返回更新后列表 */
  addRecentFolder: (path: string) => Promise<string[]>
  /**
   * 写入一个文件夹书签(§观看历史):主进程内原子读改写,避免并发覆盖。
   * 返回更新后的完整书签表(浏览视图据此刷新进度徽标/继续阅读)。
   * 读取书签走 getConfig()(AppConfig.bookmarks),无需单独通道。
   */
  setBookmark: (bookmark: BookmarkInput) => Promise<BookmarkMap>
  /** 通知主进程重建应用菜单(语言切换后调用) */
  setMenuLocale: (locale: 'zh' | 'en') => Promise<void>
  /** 监听主进程菜单动作(open-folder / prev-page / zoom-in 等) */
  onMenuAction: (handler: (action: string) => void) => void
  /** 监听主进程语言切换(菜单 Language 项触发) */
  onLocaleChanged: (handler: (locale: 'zh' | 'en') => void) => void
  getWindowInfo: () => Promise<WindowInfo>
  setWindowBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>
  toggleFullscreen: () => Promise<boolean>
  /** 沉浸模式:非全屏无边框窗口(隐藏标题栏/系统菜单);false 重建为有边框窗口 */
  setImmersive: (enabled: boolean) => Promise<boolean>
  /** 监听全屏状态变化(系统方式进入/退出全屏时同步沉浸 UI) */
  onFullScreenChanged: (handler: (isFullScreen: boolean) => void) => void
  /** 无边框窗口自绘控制按钮(§需求) */
  minimizeWindow: () => Promise<void>
  maximizeToggleWindow: () => Promise<void>
  closeWindow: () => Promise<void>
}

/** 渲染进程全局(window.komascope) */
declare global {
  interface Window {
    komascope: KomaScopeApi
  }
}

export {}
