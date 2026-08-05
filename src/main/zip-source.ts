/**
 * zip/cbz 压缩包源(§13 P0 / §4.2 SourceProvider 扩展):
 * 用 fflate 流式读取压缩包条目,不解压全部文件到内存。
 * 扫描只列图片条目(自然排序),读取按需解压单条目。
 *
 * 安全(security review):对不可信输入设置资源上限——
 * 单条目解压 ≤ 256MB(防 zip 炸弹)、条目数 ≤ 1 万、条目名 ≤ 1024、
 * 归档文件 ≤ 512MB;超限抛错中止。
 *
 * fflate 0.8 流式 API:new Unzip(stream => ...) 在发现每个文件时调用回调;
 * 仅当回调里给 stream.ondata 赋值并调用 stream.start() 才解压该文件数据。
 */
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Unzip, UnzipInflate } from 'fflate'
import { IMAGE_EXTENSIONS } from './file-service'
import { naturalCompare } from '../shared/natural-sort'
import type { PageItem } from '../shared/types'

/** 压缩包读取资源上限(security review HIGH/MEDIUM) */
export interface ZipLimits {
  /** 单条目解压后字节上限(防 zip 炸弹) */
  maxEntrySize: number
  /** 归档内图片条目数上限 */
  maxEntries: number
  /** 条目名长度上限 */
  maxNameLength: number
  /** 归档文件字节上限 */
  maxArchiveSize: number
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntrySize: 256 * 1024 * 1024,
  maxEntries: 10000,
  maxNameLength: 1024,
  maxArchiveSize: 512 * 1024 * 1024
}

function isImageEntry(name: string): boolean {
  return IMAGE_EXTENSIONS.includes(extname(name).toLowerCase())
}

/** 读取整个压缩包字节(漫画包通常几十 MB,单次读入可接受;超限拒绝) */
async function readArchiveBytes(archivePath: string, limits: ZipLimits): Promise<Uint8Array> {
  const s = await stat(archivePath)
  if (s.size > limits.maxArchiveSize) {
    throw new Error(`压缩包过大(超过 ${limits.maxArchiveSize} 字节): ${archivePath}`)
  }
  const buf = await readFile(archivePath)
  // 拷贝为独立 ArrayBuffer(fflate 0.8 类型要求 Uint8Array<ArrayBuffer>,且避免共享 Buffer 池)
  return new Uint8Array(buf)
}

/**
 * 扫描压缩包,返回按条目名自然排序的图片列表。
 * 尺寸不在此解析(压缩流无法随机读头部),解码后由 ImageBitmap 兜底。
 */
export async function scanArchive(
  archivePath: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS
): Promise<PageItem[]> {
  const data = await readArchiveBytes(archivePath, limits)
  const entries: { name: string; size: number }[] = []
  let entryCount = 0
  const unzip = new Unzip((stream) => {
    // 所有条目计数(防恶意包塞大量条目消耗解析 CPU;超长名条目也计数)
    entryCount++
    if (entryCount > limits.maxEntries) {
      throw new Error(`压缩包条目过多(超过 ${limits.maxEntries})`)
    }
    if (stream.name.length > limits.maxNameLength) return
    // 只记录图片条目,不调 start() 即不解压数据
    if (isImageEntry(stream.name)) {
      entries.push({ name: stream.name, size: stream.originalSize ?? 0 })
    }
  })
  unzip.push(data, true)
  entries.sort((a, b) => naturalCompare(a.name, b.name))
  return entries.map((e) => ({
    path: archivePath,
    name: e.name.split('/').pop() ?? e.name,
    width: 0,
    height: 0,
    size: e.size,
    archiveEntry: e.name
  }))
}

/** 按条目名解压单个文件,返回原始字节;超限(zip 炸弹)抛错中止 */
export async function readArchiveEntry(
  archivePath: string,
  entryName: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS
): Promise<Uint8Array> {
  const data = await readArchiveBytes(archivePath, limits)
  let result: Uint8Array | null = null
  let overflow = false
  const unzip = new Unzip((stream) => {
    if (stream.name === entryName) {
      const chunks: Uint8Array[] = []
      let total = 0
      stream.ondata = (err, chunk, final) => {
        if (err) return
        total += chunk.length
        if (total > limits.maxEntrySize) {
          // 停止累积,避免内存被恶意高压缩比条目耗尽
          overflow = true
          return
        }
        if (overflow) return
        chunks.push(chunk)
        if (final) {
          const merged = new Uint8Array(total)
          let offset = 0
          for (const c of chunks) {
            merged.set(c, offset)
            offset += c.length
          }
          result = merged
        }
      }
      stream.start()
    }
  })
  // fflate 0.8:必须注册解码器,否则 start() 报 "ctr is not a constructor"
  unzip.register(UnzipInflate)
  unzip.push(data, true)
  if (overflow) throw new Error(`压缩包条目过大(超过 ${limits.maxEntrySize} 字节): ${entryName}`)
  if (!result) throw new Error(`压缩包条目不存在: ${entryName}`)
  return result
}
