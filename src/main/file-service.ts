/**
 * 文件服务(FR-1 / 4.2):目录扫描、扩展名过滤、自然排序、图片尺寸元数据。
 * 尺寸经头部解析(不解码全图,§4.2 file:readMeta)。
 */
import { open, readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { parseImageSize } from '../shared/image-size'
import { isArchiveName } from '../shared/mime'
import { naturalCompare } from '../shared/natural-sort'
import { readImageSourceMeta } from './image-source'
import type { DirectoryEntry, DirectoryListing, PageItem } from '../shared/types'

/** 支持的图片扩展名(FR-1;§格式扩展:含需 sharp 转码的 TIFF/SVG/HEIC/JXL/JP2) */
export const IMAGE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.avif',
  '.tif',
  '.tiff',
  '.svg',
  '.heic',
  '.heif',
  '.jxl',
  '.jp2'
]
/** 头部读取上限:各格式头部均在 64KB 内(§4.2 不解码全图) */
const META_READ_SIZE = 64 * 1024

function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.includes(extname(name).toLowerCase())
}

/** 隐藏项判定(浏览视图不展示 . 开头的文件/文件夹,与资源管理器一致) */
function isHiddenName(name: string): boolean {
  return name.startsWith('.')
}

/**
 * 读取单张图片尺寸:先做头部解析(最快),失败时回退 sharp metadata
 * (§格式扩展:TIFF/SVG/HEIC/JXL/JP2 头部解析不支持,由 sharp 兜底)。
 * 全部失败返回 0,渲染进程解码后由 ImageBitmap 尺寸兜底。
 */
export async function readImageMeta(
  filePath: string
): Promise<{ width: number; height: number }> {
  const handle = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(META_READ_SIZE)
    const { bytesRead } = await handle.read(buf, 0, META_READ_SIZE, 0)
    const size = parseImageSize(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead))
    if (size) return size
  } finally {
    await handle.close()
  }
  // 头部解析无法识别:sharp metadata 兜底(不整页解码,仅读元数据)
  return readImageSourceMeta({ path: filePath })
}

/**
 * 扫描目录,返回按文件名自然排序的图片列表(§8 自然排序)。
 * 大目录异步执行,首屏仅加载元数据不加载像素(§12 风险应对)。
 */
export async function scanFolder(folderPath: string): Promise<PageItem[]> {
  const entries = await readdir(folderPath, { withFileTypes: true })
  const imageEntries = entries.filter((e) => e.isFile() && isImageFile(e.name))
  const items = await Promise.all(
    imageEntries.map(async (e): Promise<PageItem> => {
      const p = join(folderPath, e.name)
      const s = await stat(p)
      const meta = await readImageMeta(p)
      return { path: p, name: e.name, width: meta.width, height: meta.height, size: s.size }
    })
  )
  items.sort((a, b) => naturalCompare(a.name, b.name))
  return items
}

/**
 * 列举目录当前层内容(浏览视图,§资源管理器模式):子文件夹 / 压缩包 / 图片,各自自然排序。
 * 不读取图片元数据(PageItem 尺寸为 0,进入阅读时按需解析),
 * 也不递归子目录 —— 保证上百个子文件夹的书库根目录也能秒开。
 */
export async function listDirectory(folderPath: string): Promise<DirectoryListing> {
  const entries = await readdir(folderPath, { withFileTypes: true })
  const dirs: DirectoryEntry[] = []
  const archives: DirectoryEntry[] = []
  const images: PageItem[] = []
  for (const entry of entries) {
    if (isHiddenName(entry.name)) continue
    const path = join(folderPath, entry.name)
    if (entry.isDirectory()) {
      dirs.push({ path, name: entry.name })
    } else if (entry.isFile() && isArchiveName(entry.name)) {
      archives.push({ path, name: entry.name })
    } else if (entry.isFile() && isImageFile(entry.name)) {
      images.push({ path, name: entry.name, width: 0, height: 0, size: 0 })
    }
  }
  const byName = (a: { name: string }, b: { name: string }): number => naturalCompare(a.name, b.name)
  dirs.sort(byName)
  archives.sort(byName)
  images.sort(byName)
  return { folderPath, dirs, archives, images }
}
