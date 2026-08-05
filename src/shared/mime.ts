/**
 * MIME 工具(§精简):扩展名 → MIME 类型。
 * 压缩包条目字节构造 Blob 时需要具体类型,img/createImageBitmap 才能解码。
 */
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

/** 按文件名推断 MIME;未知扩展名回退 application/octet-stream */
export function mimeFromName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}
