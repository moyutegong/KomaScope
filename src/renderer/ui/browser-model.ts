/**
 * 浏览视图纯逻辑(§资源管理器模式,无 DOM 依赖,可单测):
 * - 目录列举 → 可索引的扁平条目列表(网格渲染与键盘导航共用同一顺序);
 * - 书签查询:某文件夹自身/其后代的书签(书架进度徽标、"继续阅读"列表);
 * - 键盘导航:方向键按网格列数移动选中项。
 */
import type { BookmarkMap, DirectoryListing, FolderBookmark } from '../../shared/types'

/** 网格中的一个条目(顺序 = 文件夹 → 压缩包 → 图片,与自然排序一致) */
export type BrowserEntry =
  | { kind: 'folder'; path: string; name: string }
  | { kind: 'archive'; path: string; name: string }
  | { kind: 'image'; path: string; name: string; index: number }

/** 目录列举 → 扁平条目列表(文件夹在前、图片在后的层级顺序) */
export function flattenListing(listing: DirectoryListing): BrowserEntry[] {
  const entries: BrowserEntry[] = []
  for (const dir of listing.dirs) {
    entries.push({ kind: 'folder', path: dir.path, name: dir.name })
  }
  for (const archive of listing.archives) {
    entries.push({ kind: 'archive', path: archive.path, name: archive.name })
  }
  for (let i = 0; i < listing.images.length; i++) {
    const image = listing.images[i]
    entries.push({ kind: 'image', path: image.path, name: image.name, index: i })
  }
  return entries
}

/** 路径末尾补分隔符并统一为 `\`(前缀比较用;两侧同源路径比较,不做大小写折叠) */
function normalizePath(path: string): string {
  const unified = path.replace(/\//g, '\\')
  return unified.endsWith('\\') ? unified : `${unified}\\`
}

/** target 是否为 parent 自身或其子孙路径("F:\a" 是 "F:\a\b\c" 的祖先) */
export function isSelfOrDescendant(parent: string, target: string): boolean {
  return normalizePath(target) === normalizePath(parent) || normalizePath(target).startsWith(normalizePath(parent))
}

/**
 * 某文件夹自身或其后代中最新的书签(书架进度徽标用):
 * 书库根目录与漫画文件夹之间常隔一层(根/系列/章节),只看自身会漏掉进度,
 * 故向下取最近阅读的那一条。
 */
export function latestBookmarkFor(map: BookmarkMap, folderPath: string): FolderBookmark | null {
  let latest: FolderBookmark | null = null
  for (const bookmark of Object.values(map)) {
    if (!isSelfOrDescendant(folderPath, bookmark.folderPath)) continue
    if (!latest || bookmark.updatedAt > latest.updatedAt) latest = bookmark
  }
  return latest
}

/**
 * 书库根目录下(含自身)最近阅读的书签,按 updatedAt 倒序,最多 limit 条。
 * 用于书架的"继续阅读"区块 —— 直接续读记录过进度的文件夹。
 */
export function recentBookmarks(map: BookmarkMap, rootPath: string, limit = 6): FolderBookmark[] {
  return Object.values(map)
    .filter((bookmark) => isSelfOrDescendant(rootPath, bookmark.folderPath))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(0, limit))
}

/** 书签进度文本(如 `12/58`);pageCount 未知时按 lastIndex + 1 显示 */
export function bookmarkProgress(bookmark: FolderBookmark): string {
  const current = bookmark.lastIndex + 1
  return bookmark.pageCount > 0 ? `${current}/${bookmark.pageCount}` : `${current}`
}

/** 路径最后一段(面包屑/书架条目显示名;根路径回退自身) */
export function folderName(path: string): string {
  const segments = path.split(/[\\/]/).filter((s) => s.length > 0)
  return segments.length > 0 ? segments[segments.length - 1] : path
}

/** 路径倒数第二段(父目录名);无父目录或父段为盘符时返回空串(§4.3.5 深层书签辨识用) */
export function parentName(path: string): string {
  const segments = path.split(/[\\/]/).filter((s) => s.length > 0)
  if (segments.length < 2) return ''
  const parent = segments[segments.length - 2]
  // `F:` 这类盘符不是有辨识度的父目录名,视为无父目录
  return /^[A-Za-z]:$/.test(parent) ? '' : parent
}

/** 数值夹取 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 方向键在网格中的选中项移动(纯函数)。
 * - 左右 ±1,上下 ±columns,PageUp/PageDown 翻三行,Home/End 首尾;
 * - 无选中(首次按方向键)时统一选中首项,避免跳过第一项;
 * - 越界夹取到 [0, length-1];length 为 0 返回 -1(无选中);
 * - 未识别的按键返回原值(调用方据此判断是否消费该事件)。
 */
export function moveSelection(
  current: number,
  key: string,
  columns: number,
  length: number
): number {
  if (length <= 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  if (current < 0) return isNavKey(key) ? 0 : current
  const delta = navigationDelta(key, Math.max(1, Math.floor(columns)))
  if (delta === null) return current
  return clamp(current + delta, 0, length - 1)
}

/** 方向键/翻页键相对当前项的行列增量;非导航键返回 null */
function navigationDelta(key: string, columns: number): number | null {
  switch (key) {
    case 'ArrowLeft':
      return -1
    case 'ArrowRight':
      return 1
    case 'ArrowUp':
      return -columns
    case 'ArrowDown':
      return columns
    case 'PageUp':
      return -columns * 3
    case 'PageDown':
      return columns * 3
    default:
      return null
  }
}

function isNavKey(key: string): boolean {
  return navigationDelta(key, 1) !== null
}
