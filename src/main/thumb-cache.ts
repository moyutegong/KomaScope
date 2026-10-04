/**
 * 缩略图磁盘缓存(§性能):主进程 sharp 缩放结果按「源文件指纹 + 目标宽」缓存到
 * `userData/thumb-cache`,跨会话复用。
 *
 * 为什么需要:自定义协议(`komascope-thumb://`)的响应不进入 Chromium 的 HTTP 磁盘缓存,
 * 若不做磁盘缓存,每次重新打开书库都要为可见缩略图重新解码整批原图。
 *
 * 规则:
 * - 仅缓存缩略图请求(指定目标宽且无区域裁剪);区域裁剪按视口取块,命中率低故不缓存;
 * - 键含源文件 mtime 与字节数,源文件被替换后自动失效(旧条目由淘汰清理);
 * - 任何失败(权限/磁盘满/并发)一律静默:缓存不可用不影响功能,只是回退为实时渲染。
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 缓存条目上限(每张缩略图为一个 JPEG 文件),超出按 mtime 淘汰最旧 */
export const MAX_CACHE_ENTRIES = 2000

/** 淘汰节流(ms):避免每次写入都扫描整个缓存目录 */
const PRUNE_INTERVAL_MS = 60_000

let cacheDir = ''
let lastPruneAt = 0

/** 注入缓存目录(主进程启动时用 `userData` 路径调用);未注入时缓存整体禁用 */
export function setThumbCacheDir(dir: string): void {
  cacheDir = dir
  lastPruneAt = 0
}

export function isThumbCacheEnabled(): boolean {
  return cacheDir.length > 0
}

/** 缓存键输入:源文件指纹 + 目标宽 */
export interface ThumbCacheKeyParts {
  /** 图片绝对路径(压缩包源为归档文件路径) */
  path: string
  /** 压缩包内条目名(非压缩包源省略) */
  archiveEntry?: string
  /** 目标宽度(px) */
  width: number
  /** 源文件 mtime(ms) */
  mtimeMs: number
  /** 源文件字节数 */
  size: number
}

/** 缓存文件名:`sha1(路径|条目|宽|mtime|大小).jpg` */
export function thumbCacheKey(parts: ThumbCacheKeyParts): string {
  const raw = [
    parts.path,
    parts.archiveEntry ?? '',
    parts.width,
    Math.floor(parts.mtimeMs),
    parts.size
  ].join('|')
  return `${createHash('sha1').update(raw).digest('hex')}.jpg`
}

/** 读缓存;未命中或不可读返回 null */
export async function readThumb(key: string): Promise<Buffer | null> {
  if (!isThumbCacheEnabled()) return null
  try {
    return await readFile(join(cacheDir, key))
  } catch {
    return null
  }
}

/**
 * 写缓存:先写临时文件再 rename,避免并发请求读到半截文件。
 * 写入后按节流触发一次淘汰(不阻塞调用方)。
 */
export async function writeThumb(key: string, body: Buffer): Promise<void> {
  if (!isThumbCacheEnabled()) return
  try {
    await mkdir(cacheDir, { recursive: true })
    const target = join(cacheDir, key)
    const tmp = `${target}.${process.pid}.tmp`
    await writeFile(tmp, body)
    await rename(tmp, target)
  } catch {
    return
  }
  void pruneIfNeeded()
}

/** 淘汰入口(节流 + 失败静默) */
async function pruneIfNeeded(): Promise<void> {
  const now = Date.now()
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return
  lastPruneAt = now
  try {
    await pruneThumbCache(cacheDir, MAX_CACHE_ENTRIES)
  } catch {
    // 清理失败静默(下次触发时再试)
  }
}

/** 条目数超过 maxEntries 时按 mtime 删除最旧的,直到降至上限;返回删除条数 */
export async function pruneThumbCache(dir: string, maxEntries: number): Promise<number> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.jpg'))
  if (names.length <= maxEntries) return 0
  const stats = await Promise.all(
    names.map(async (name) => {
      try {
        return { name, mtimeMs: (await stat(join(dir, name))).mtimeMs }
      } catch {
        return null
      }
    })
  )
  const alive = stats.filter((entry): entry is { name: string; mtimeMs: number } => entry !== null)
  alive.sort((a, b) => a.mtimeMs - b.mtimeMs)
  let removed = 0
  for (const entry of alive.slice(0, alive.length - maxEntries)) {
    try {
      await rm(join(dir, entry.name))
      removed++
    } catch {
      // 单条删除失败忽略
    }
  }
  return removed
}
