/**
 * 文件服务(FR-1 / 4.2):目录扫描、扩展名过滤、自然排序、图片尺寸元数据。
 * 尺寸经头部解析(不解码全图,§4.2 file:readMeta)。
 */
import { open, readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { parseImageSize } from '../shared/image-size'
import { naturalCompare } from '../shared/natural-sort'
import { readImageSourceMeta } from './image-source'
import type { PageItem } from '../shared/types'

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
