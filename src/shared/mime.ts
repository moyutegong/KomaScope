/**
 * MIME 工具(§精简):扩展名 → MIME 类型 + 解码能力判定。
 * 压缩包条目字节构造 Blob 时需要具体类型,img/createImageBitmap 才能解码。
 * §格式扩展:TIFF/SVG/HEIC/JXL/JP2 由主进程 sharp 解码(Chromium 不支持),
 * 渲染侧据 isNativelyDecodable 决定走原生图源还是直接 createImageBitmap。
 */
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  // 需主进程 sharp 解码(Chromium 不支持或支持不完整)
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jxl': 'image/jxl',
  '.jp2': 'image/jp2'
}

/** 按文件名推断 MIME;未知扩展名回退 application/octet-stream */
export function mimeFromName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** 扩展名 → 小写(含点);无扩展名返回 '' */
function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i).toLowerCase()
}

/**
 * Chromium 原生可解码格式(createImageBitmap 直接可用):
 * JPEG / PNG / WebP / GIF / BMP / AVIF。
 * 其余(TIFF/SVG/HEIC/HEIF/JXL/JP2)必须经主进程 sharp 转码(§格式扩展)。
 */
const NATIVELY_DECODABLE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'])

export function isNativelyDecodable(name: string): boolean {
  return NATIVELY_DECODABLE.has(extOf(name))
}
