/**
 * 统一图片源(§性能/§格式):主进程 sharp(libvips)流式缩放服务。
 * 自定义协议 komascope-thumb:///path/to/img.jpg?w=192&archive=/x.cbz&entry=1.jpg
 * - 文件夹源:sharp(path) 直接流式读取
 * - 压缩包源:readArchiveEntry 解压条目字节 → sharp(Buffer)
 * 请求校验:路径/条目名非空、w 为 1~8192 整数;超限或解码失败返回 4xx。
 * 输出:mozjpeg 渐进 JPEG(q80),HTTP 缓存(mtime/大小+目标宽 ETag)。
 */
import sharp from 'sharp'
import { stat } from 'node:fs/promises'
import { readArchiveEntry } from './zip-source'
import { isThumbCacheEnabled, readThumb, thumbCacheKey, writeThumb } from './thumb-cache'

/** 协议名(渲染进程与主进程共享) */
export const IMAGE_SOURCE_PROTOCOL = 'komascope-thumb'

/** 目标宽上限(8192,与瓦片阈值一致;超出无意义) */
export const MAX_TARGET_WIDTH = 8192

export interface ImageSourceParams {
  /** 图片绝对路径(文件夹源)或压缩包路径(压缩包源) */
  path: string
  /** 目标宽度(px);未指定时按原图缩放 */
  width?: number
  /** 压缩包内条目名(非空表示压缩包源) */
  archiveEntry?: string
  /** 源区域(图片像素,超高清分层渲染用):不指定时整图 */
  region?: { x: number; y: number; width: number; height: number }
}

/** 区域参数上限(防恶意超大声明) */
export const MAX_REGION_COORD = 1_000_000

/** 解析并校验 query 参数;非法返回 null */
export function parseImageSourceParams(url: URL): ImageSourceParams | null {
  let filePath = decodeURIComponent(url.pathname)
  // Windows 绝对路径:pathname 形如 /F:/a/b.jpg,去掉前导 '/'
  if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1)
  if (!filePath) return null
  const wRaw = url.searchParams.get('w')
  let width: number | undefined
  if (wRaw !== null) {
    width = Number.parseInt(wRaw, 10)
    if (!Number.isFinite(width) || width < 1 || width > MAX_TARGET_WIDTH) return null
  }
  const entry = url.searchParams.get('entry')
  // 区域参数:x/y/w/h 需同时给出且为正(区域裁剪,超高清按视口取块)
  const region = parseRegion(url)
  if (region === null) return null
  return {
    path: filePath,
    width,
    archiveEntry: entry && entry.length > 0 ? entry : undefined,
    region: region ?? undefined
  }
}

/**
 * 解析区域参数(x/y/w/h):全缺省返回 undefined(整图);部分缺失或非法返回 null。
 * 用于超高清分层渲染——只解码视口对应区域,内存与耗时与区域大小成正比。
 */
function parseRegion(
  url: URL
): { x: number; y: number; width: number; height: number } | null | undefined {
  const rx = url.searchParams.get('x')
  const ry = url.searchParams.get('y')
  const rw = url.searchParams.get('rw')
  const rh = url.searchParams.get('rh')
  if (rx === null && ry === null && rw === null && rh === null) return undefined
  if (rx === null || ry === null || rw === null || rh === null) return null
  const x = Number.parseInt(rx, 10)
  const y = Number.parseInt(ry, 10)
  const width = Number.parseInt(rw, 10)
  const height = Number.parseInt(rh, 10)
  const ok = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= MAX_REGION_COORD
  if (!ok(x) || !ok(y) || !ok(width) || !ok(height)) return null
  if (width < 1 || height < 1) return null
  return { x, y, width, height }
}

/**
 * 流式生成缩放 JPEG(§性能):libvips 仅驻留小块区域,
 * resize 在解码管线内完成,1 亿像素图缩放至 256 宽内存仅数 MB。
 * 渐进式输出使浏览器可边下边渲染(缩略图快速显示)。
 *
 * 缩略图请求(指定目标宽、无区域裁剪)先查磁盘缓存(§性能),
 * 未命中才渲染并异步写缓存;区域裁剪/整图请求不缓存。
 */
export async function renderImageSource(
  params: ImageSourceParams
): Promise<{ body: Buffer; etag: string }> {
  const cacheable = isThumbnailRequest(params)
  if (cacheable) {
    const cached = await readThumbFor(params)
    if (cached) return { body: cached, etag: imageSourceEtag(params, cached) }
  }
  const body = await renderImageSourceBody(params)
  if (cacheable) void writeThumbFor(params, body)
  return { body, etag: imageSourceEtag(params, body) }
}

/** 是否可缓存:指定目标宽且无区域裁剪(缩略图场景;区域裁剪按视口取块不缓存) */
function isThumbnailRequest(params: ImageSourceParams): boolean {
  return params.width !== undefined && params.width > 0 && params.region === undefined
}

/** ETag:路径+条目+目标宽+区域+输出长度,内容变化即失效(目录扫描重载自然刷新) */
function imageSourceEtag(params: ImageSourceParams, body: Buffer): string {
  const r = params.region
  const regionTag = r ? `${r.x},${r.y},${r.width},${r.height}` : ''
  return `W/"${Buffer.byteLength(params.path)}-${(params.archiveEntry ?? '').length}-${params.width ?? 0}-${regionTag}-${body.length}"`
}

/** 缓存键:源文件 mtime/字节数参与指纹,源文件被替换后自动失效 */
async function thumbKeyFor(params: ImageSourceParams): Promise<string> {
  const info = await stat(params.path)
  return thumbCacheKey({
    path: params.path,
    archiveEntry: params.archiveEntry,
    width: params.width ?? 0,
    mtimeMs: info.mtimeMs,
    size: info.size
  })
}

/** 读缩略图缓存(未启用/未命中/异常一律返回 null,回退实时渲染) */
async function readThumbFor(params: ImageSourceParams): Promise<Buffer | null> {
  if (!isThumbCacheEnabled()) return null
  try {
    return await readThumb(await thumbKeyFor(params))
  } catch {
    return null
  }
}

/** 写缩略图缓存(异步、失败静默:不影响本次响应) */
async function writeThumbFor(params: ImageSourceParams, body: Buffer): Promise<void> {
  try {
    await writeThumb(await thumbKeyFor(params), body)
  } catch {
    // 源文件不可 stat 等异常:本次不缓存
  }
}

/** 缩放输出主体(无 ETag;大图分层与元数据读取共用) */
async function renderImageSourceBody(params: ImageSourceParams): Promise<Buffer> {
  const input = params.archiveEntry
    ? Buffer.from(await readArchiveEntry(params.path, params.archiveEntry))
    : params.path
  // limitInputPixels: false —— 超高清图(>2.68 亿像素)默认会被 sharp 拒绝,
  // 本应用的核心场景恰是超大图,故解除该限制;区域裁剪时实际解码内存与区域成正比。
  let pipeline = sharp(input, { failOn: 'none', limitInputPixels: false })
  // 区域裁剪(超高清分层):只处理视口对应区域,内存/耗时与区域成正比。
  // 必须先 extract 再 resize,保证缩放倍率按区域自身计算。
  if (params.region) {
    pipeline = pipeline.extract({
      left: params.region.x,
      top: params.region.y,
      width: params.region.width,
      height: params.region.height
    })
  }
  if (params.width) {
    pipeline = pipeline.resize({ width: params.width, fit: 'inside', withoutEnlargement: true })
  }
  return pipeline.jpeg({ mozjpeg: true, quality: 80, progressive: true }).toBuffer()
}

/**
 * 读取图片元数据(§格式兜底):sharp 覆盖 jpeg/png/webp/avif/gif/tiff/svg,
 * 头部解析失败(AVIF 等)的格式由此获得真实宽高。
 * 压缩包源解压条目后读取;失败返回 0(由渲染进程 ImageBitmap 尺寸兜底)。
 */
export async function readImageSourceMeta(
  params: Pick<ImageSourceParams, 'path' | 'archiveEntry'>
): Promise<{ width: number; height: number }> {
  try {
    const input = params.archiveEntry
      ? Buffer.from(await readArchiveEntry(params.path, params.archiveEntry))
      : params.path
    const meta = await sharp(input, { failOn: 'none', limitInputPixels: false }).metadata()
    return { width: meta.width ?? 0, height: meta.height ?? 0 }
  } catch {
    return { width: 0, height: 0 }
  }
}
