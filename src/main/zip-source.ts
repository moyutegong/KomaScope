/**
 * zip/cbz 压缩包源(§13 P0 / §4.2 SourceProvider 扩展):
 * 用 fflate 流式读取压缩包条目,不解压全部文件到内存。
 * 扫描只列图片条目(自然排序),读取按需解压单条目。
 *
 * fflate 0.8 流式 API:new Unzip(stream => ...) 在发现每个文件时调用回调;
 * 仅当回调里给 stream.ondata 赋值并调用 stream.start() 才解压该文件数据。
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { Unzip, UnzipInflate } from 'fflate'
import { IMAGE_EXTENSIONS } from './file-service'
import { naturalCompare } from '../shared/natural-sort'
import type { PageItem } from '../shared/types'

function isImageEntry(name: string): boolean {
  return IMAGE_EXTENSIONS.includes(extname(name).toLowerCase())
}

/** 读取整个压缩包字节(漫画包通常几十 MB,单次读入可接受) */
async function readArchiveBytes(archivePath: string): Promise<Uint8Array> {
  const buf = await readFile(archivePath)
  // 拷贝为独立 ArrayBuffer(fflate 0.8 类型要求 Uint8Array<ArrayBuffer>,且避免共享 Buffer 池)
  return new Uint8Array(buf)
}

/**
 * 扫描压缩包,返回按条目名自然排序的图片列表。
 * 尺寸不在此解析(压缩流无法随机读头部),解码后由 ImageBitmap 兜底。
 */
export async function scanArchive(archivePath: string): Promise<PageItem[]> {
  const data = await readArchiveBytes(archivePath)
  const entries: { name: string; size: number }[] = []
  const unzip = new Unzip((stream) => {
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

/** 按条目名解压单个文件,返回原始字节 */
export async function readArchiveEntry(
  archivePath: string,
  entryName: string
): Promise<Uint8Array> {
  const data = await readArchiveBytes(archivePath)
  let result: Uint8Array | null = null
  const unzip = new Unzip((stream) => {
    if (stream.name === entryName) {
      const chunks: Uint8Array[] = []
      stream.ondata = (err, chunk, final) => {
        if (err) return
        chunks.push(chunk)
        if (final) {
          const total = chunks.reduce((n, c) => n + c.length, 0)
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
  if (!result) throw new Error(`压缩包条目不存在: ${entryName}`)
  return result
}
