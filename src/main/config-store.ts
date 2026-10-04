/**
 * 配置持久化(§4.5 / FR-9):config.json 存于 app.getPath('userData')。
 * 自写 JSON 读写(文档 §3.1 允许),500ms 防抖落盘,无第三方依赖。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppConfig, BookmarkInput, BookmarkMap, FolderBookmark } from '../shared/types'

/** 写盘防抖间隔(ms,§4.5) */
export const SAVE_DEBOUNCE_MS = 500

/** 书签表上限(超出按更新时间保留最新,防止配置文件无限膨胀) */
export const MAX_BOOKMARKS = 500

export const DEFAULT_CONFIG: AppConfig = {
  windowBounds: { x: 0, y: 0, width: 1280, height: 720 },
  screenId: '',
  lastFolder: '',
  fitMode: 'fitScreen',
  scale: 1.0,
  scaleLocked: false,
  uiScale: 1.0,
  theme: 'dark',
  wheelAction: 'zoom',
  locale: 'zh',
  lastPage: 0,
  layoutMode: 'single',
  recentFolders: [],
  libraryRoot: '',
  bookmarks: {},
  autoHide: true
}

/** 用默认值补齐缺失字段,并剔除未知字段(向前兼容) */
export function normalizeConfig(raw: unknown): AppConfig {
  const src = (raw ?? {}) as Record<string, unknown>
  return {
    windowBounds: sanitizeBounds(src.windowBounds),
    screenId: typeof src.screenId === 'string' ? src.screenId : DEFAULT_CONFIG.screenId,
    lastFolder: typeof src.lastFolder === 'string' ? src.lastFolder : DEFAULT_CONFIG.lastFolder,
    fitMode: isFitMode(src.fitMode) ? src.fitMode : DEFAULT_CONFIG.fitMode,
    scale: typeof src.scale === 'number' && Number.isFinite(src.scale) ? src.scale : DEFAULT_CONFIG.scale,
    scaleLocked: typeof src.scaleLocked === 'boolean' ? src.scaleLocked : DEFAULT_CONFIG.scaleLocked,
    uiScale: typeof src.uiScale === 'number' && Number.isFinite(src.uiScale) ? src.uiScale : DEFAULT_CONFIG.uiScale,
    theme: src.theme === 'light' ? 'light' : 'dark',
    wheelAction: src.wheelAction === 'page' ? 'page' : 'zoom',
    locale: src.locale === 'en' ? 'en' : 'zh',
    lastPage: typeof src.lastPage === 'number' && Number.isFinite(src.lastPage) && src.lastPage >= 0
      ? Math.floor(src.lastPage)
      : DEFAULT_CONFIG.lastPage,
    layoutMode: src.layoutMode === 'spread' ? 'spread' : 'single',
    recentFolders: sanitizeRecentFolders(src.recentFolders),
    libraryRoot: typeof src.libraryRoot === 'string' ? src.libraryRoot : DEFAULT_CONFIG.libraryRoot,
    bookmarks: sanitizeBookmarks(src.bookmarks),
    // autoHide 默认开启(§需求):字段缺失(undefined)视为 true,仅显式 false 关闭
    autoHide: src.autoHide !== false
  }
}

/** 最近文件夹历史:字符串数组、去空、上限 10(§侧栏) */
function sanitizeRecentFolders(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const list: string[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item.length > 0 && !list.includes(item)) {
      list.push(item)
      if (list.length >= 10) break
    }
  }
  return list
}

/** 非负整数校验(书签下标/数量/时间戳) */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

/** 书签表清洗:逐项校验,非法项丢弃(向前兼容旧配置) */
function sanitizeBookmarks(raw: unknown): BookmarkMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const map: BookmarkMap = {}
  for (const value of Object.values(raw as Record<string, unknown>)) {
    const bookmark = sanitizeBookmark(value)
    if (bookmark) map[bookmark.folderPath] = bookmark
  }
  return pruneBookmarks(map)
}

function sanitizeBookmark(raw: unknown): FolderBookmark | null {
  if (typeof raw !== 'object' || raw === null) return null
  const b = raw as Record<string, unknown>
  if (typeof b.folderPath !== 'string' || b.folderPath.length === 0) return null
  if (typeof b.lastImagePath !== 'string' || b.lastImagePath.length === 0) return null
  if (!isCount(b.lastIndex) || !isCount(b.pageCount) || !isCount(b.updatedAt)) return null
  return {
    folderPath: b.folderPath,
    lastImagePath: b.lastImagePath,
    lastIndex: Math.floor(b.lastIndex),
    pageCount: Math.floor(b.pageCount),
    updatedAt: Math.floor(b.updatedAt)
  }
}

/** 超过上限时按更新时间保留最新的 MAX_BOOKMARKS 项 */
function pruneBookmarks(map: BookmarkMap): BookmarkMap {
  const entries = Object.entries(map)
  if (entries.length <= MAX_BOOKMARKS) return map
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  const kept: BookmarkMap = {}
  for (const [key, value] of entries.slice(0, MAX_BOOKMARKS)) kept[key] = value
  return kept
}

function sanitizeBounds(raw: unknown): AppConfig['windowBounds'] {
  const r = (raw ?? {}) as Record<string, unknown>
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return {
    x: num(r.x, DEFAULT_CONFIG.windowBounds.x),
    y: num(r.y, DEFAULT_CONFIG.windowBounds.y),
    width: num(r.width, DEFAULT_CONFIG.windowBounds.width),
    height: num(r.height, DEFAULT_CONFIG.windowBounds.height)
  }
}

function isFitMode(v: unknown): v is AppConfig['fitMode'] {
  return v === 'fitWidth' || v === 'fitHeight' || v === 'fitScreen' || v === 'actual' || v === 'custom'
}

export class ConfigStore {
  private config: AppConfig
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private readonly filePath: string

  constructor(filePath = join(app.getPath('userData'), 'config.json')) {
    this.filePath = filePath
    this.config = this.load()
  }

  get(): AppConfig {
    return this.config
  }

  /** 合并补丁并防抖落盘,返回新配置 */
  set(patch: Partial<AppConfig>): AppConfig {
    this.config = normalizeConfig({ ...this.config, ...patch })
    this.scheduleSave()
    return this.config
  }

  /**
   * 原子追加最近文件夹历史(§侧栏):去重置顶,上限 10。
   * 主进程内同步读-改-写,避免渲染进程并发 getConfig+setConfig 竞态
   * (连续打开来源时后写覆盖先写导致丢历史项)。返回更新后的列表。
   */
  addRecentFolder(path: string): string[] {
    const recent = this.config.recentFolders.filter((p) => p !== path)
    recent.unshift(path)
    this.config.recentFolders = recent.slice(0, 10)
    this.scheduleSave()
    return this.config.recentFolders
  }

  /**
   * 原子移除最近文件夹历史(§侧栏删除)。
   * 主进程内同步读-过滤-写,避免渲染进程并发 getConfig+setConfig 竞态
   * (连续删除时后写覆盖先写导致被删项恢复)。返回删除后的列表。
   */
  removeRecentFolder(path: string): string[] {
    this.config.recentFolders = this.config.recentFolders.filter((p) => p !== path)
    this.scheduleSave()
    return this.config.recentFolders
  }

  /**
   * 原子写入一个文件夹书签(§观看历史):主进程内同步读-改-写,
   * 避免渲染进程并发 getConfig+setConfig 时后写覆盖先写(连续翻页丢书签)。
   * updatedAt 由主进程生成,保证"最近阅读"排序单调。返回更新后的书签表。
   */
  setBookmark(input: BookmarkInput): BookmarkMap {
    const next: BookmarkMap = {
      ...this.config.bookmarks,
      [input.folderPath]: { ...input, updatedAt: Date.now() }
    }
    this.config.bookmarks = pruneBookmarks(next)
    this.scheduleSave()
    return this.config.bookmarks
  }

  /** 立即落盘(窗口关闭、退出前调用) */
  flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.save()
  }

  private load(): AppConfig {
    try {
      if (!existsSync(this.filePath)) return { ...DEFAULT_CONFIG }
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as unknown
      return normalizeConfig(raw)
    } catch {
      // 文件损坏时回退默认值,不阻断启动
      return { ...DEFAULT_CONFIG }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, SAVE_DEBOUNCE_MS)
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf-8')
    } catch (err) {
      console.error('[config] save failed:', err)
    }
  }
}

/** 全局单例 */
export const configStore = new ConfigStore()
