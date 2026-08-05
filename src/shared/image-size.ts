/**
 * 图片头部尺寸解析(4.2 file:readMeta / FR-11 状态栏):只读文件头部字节,
 * 不解码全图即可获得宽高。纯函数、无依赖,可单测。
 *
 * 支持:PNG / JPEG / GIF / BMP / WebP(VP8/VP8L/VP8X)。
 * AVIF(ISO-BMFF box 结构)较复杂,解码后由 ImageBitmap 尺寸兜底,后续补全。
 */

export interface ImageSize {
  width: number
  height: number
}

function readU16BE(b: Uint8Array, offset: number): number {
  return (b[offset] << 8) | b[offset + 1]
}

function readU32BE(b: Uint8Array, offset: number): number {
  return ((b[offset] << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]) >>> 0
}

function readU16LE(b: Uint8Array, offset: number): number {
  return b[offset] | (b[offset + 1] << 8)
}

function readI32LE(b: Uint8Array, offset: number): number {
  return (b[offset] | (b[offset + 1] << 8) | (b[offset + 2] << 16) | (b[offset + 3] << 24)) | 0
}

function readU32LE(b: Uint8Array, offset: number): number {
  return (b[offset] | (b[offset + 1] << 8) | (b[offset + 2] << 16) | (b[offset + 3] << 24)) >>> 0
}

function sig(b: Uint8Array, offset: number, str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    if (b[offset + i] !== str.charCodeAt(i)) return false
  }
  return true
}

/** JPEG:扫描段直到 SOFn 标记(C0-CF,排除 C4/C8/CC) */
function parseJpeg(b: Uint8Array): ImageSize | null {
  let offset = 2
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = b[offset + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: readU16BE(b, offset + 5), width: readU16BE(b, offset + 7) }
    }
    if (marker === 0xff || marker === 0xd8 || marker === 0xd9) {
      offset++
      continue
    }
    const len = readU16BE(b, offset + 2)
    offset += 2 + len
  }
  return null
}

/** WebP:VP8(有损)/ VP8L(无损)/ VP8X(扩展)三种容器 */
function parseWebP(b: Uint8Array): ImageSize | null {
  if (sig(b, 12, 'VP8 ')) {
    if (b.length < 30) return null
    // 数据:frame tag(3)@20 + start code(3)@23 + width(2, LE 14bit)@26 + height(2)@28
    return { width: b[26] | ((b[27] & 0x3f) << 8), height: b[28] | ((b[29] & 0x3f) << 8) }
  }
  if (sig(b, 12, 'VP8L')) {
    if (b.length < 25) return null
    // 无损头:29 位比特,低 14 位为 width-1,次 14 位为 height-1
    const bits = readU32LE(b, 21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (sig(b, 12, 'VP8X')) {
    // 24 位小端 width-1 @24 / height-1 @27
    const width = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1
    const height = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1
    return { width, height }
  }
  return null
}

/**
 * 从文件头字节解析图片尺寸;无法识别时返回 null(调用方回退为 0)。
 * 各分支按自身所需最小长度检查。
 */
export function parseImageSize(bytes: Uint8Array): ImageSize | null {
  // PNG:签名 + IHDR(width@16, height@20, 大端)
  if (bytes.length >= 24 && sig(bytes, 0, '\x89PNG\r\n\x1a\n') && sig(bytes, 12, 'IHDR')) {
    return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) }
  }
  // GIF:GIF87a / GIF89a(width@6, height@8, 小端)
  if (bytes.length >= 10 && sig(bytes, 0, 'GIF8') && (bytes[4] === 55 || bytes[4] === 57)) {
    return { width: readU16LE(bytes, 6), height: readU16LE(bytes, 8) }
  }
  // BMP:'BM'(width@18, height@22, 有符号小端,高度取绝对值)
  if (bytes.length >= 26 && sig(bytes, 0, 'BM')) {
    return { width: readI32LE(bytes, 18), height: Math.abs(readI32LE(bytes, 22)) }
  }
  // JPEG:SOI 0xFFD8
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return parseJpeg(bytes)
  }
  // WebP:'RIFF'....'WEBP'(VP8L 头部仅需 25 字节,外层放宽,分支内检查)
  if (bytes.length >= 21 && sig(bytes, 0, 'RIFF') && sig(bytes, 8, 'WEBP')) {
    return parseWebP(bytes)
  }
  return null
}
