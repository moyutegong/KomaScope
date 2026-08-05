import { describe, expect, it } from 'vitest'
import { parseImageSize } from '../src/shared/image-size'

function bytes(...parts: number[][]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

function u16be(v: number): number[] {
  return [(v >> 8) & 0xff, v & 0xff]
}
function u32be(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
}
function u16le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff]
}
function u32le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]
}

/** 1x1 透明 PNG 头:签名 + IHDR 长度/类型 + 宽高 */
function pngHeader(width: number, height: number): Uint8Array {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    u32be(13),
    [0x49, 0x48, 0x44, 0x52],
    u32be(width),
    u32be(height),
    [8, 6, 0, 0, 0]
  )
}

function jpegHeader(width: number, height: number): Uint8Array {
  // SOI + APP0 + SOF0
  return bytes(
    [0xff, 0xd8],
    [0xff, 0xe0], u16be(16), [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00],
    [0xff, 0xc0], u16be(17), [0x08],
    u16be(height),
    u16be(width),
    [0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]
  )
}

function gifHeader(width: number, height: number): Uint8Array {
  return bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], u16le(width), u16le(height), [0x80, 0x00, 0x00])
}

function bmpHeader(width: number, height: number): Uint8Array {
  // 'BM' + filesize(4) + reserved(4) + dataOffset(4) + dibHeaderSize(4) = 18 字节后是 width@18
  const pad = new Array(16).fill(0)
  return bytes([0x42, 0x4d], ...pad.map((x) => [x]), u32le(width >>> 0), u32le(height >>> 0))
}

describe('parseImageSize', () => {
  it('PNG 大端宽高', () => {
    expect(parseImageSize(pngHeader(258, 772))).toEqual({ width: 258, height: 772 })
  })

  it('JPEG 扫描 SOF 段(跳过 APP0)', () => {
    expect(parseImageSize(jpegHeader(3428, 4820))).toEqual({ width: 3428, height: 4820 })
  })

  it('GIF 小端宽高', () => {
    expect(parseImageSize(gifHeader(0x0102, 0x0304))).toEqual({ width: 258, height: 772 })
  })

  it('BMP 高度取绝对值', () => {
    expect(parseImageSize(bmpHeader(100, -200))).toEqual({ width: 100, height: 200 })
  })

  it('WebP VP8(有损)14 位宽高', () => {
    const w = 640
    const h = 480
    // 数据@20:frame tag(3) + start code(3)@23 + width(2, LE)@26 + height(2, LE)@28
    const hdr = bytes(
      [0x52, 0x49, 0x46, 0x46], u32le(0), [0x57, 0x45, 0x42, 0x50],
      [0x56, 0x50, 0x38, 0x20], u32le(10),
      [0xb0, 0x00, 0x00],
      [0x9d, 0x01, 0x2a],
      u16le(w),
      u16le(h)
    )
    expect(parseImageSize(hdr)).toEqual({ width: w, height: h })
  })

  it('WebP VP8L(无损)比特位宽高', () => {
    const w = 1001
    const h = 777
    const bits = (w - 1) | ((h - 1) << 14)
    const hdr = bytes(
      [0x52, 0x49, 0x46, 0x46], u32le(0), [0x57, 0x45, 0x42, 0x50],
      [0x56, 0x50, 0x38, 0x4c], u32le(1), [0x2f], u32le(bits),
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    )
    expect(parseImageSize(hdr)).toEqual({ width: w, height: h })
  })

  it('WebP VP8X(扩展)24 位宽高', () => {
    const w = 4097
    const h = 2049
    const hdr = bytes(
      [0x52, 0x49, 0x46, 0x46], u32le(0), [0x57, 0x45, 0x42, 0x50],
      [0x56, 0x50, 0x38, 0x58], u32le(10),
      [0x00, 0x00, 0x00, 0x00],
      [(w - 1) & 0xff, ((w - 1) >> 8) & 0xff, ((w - 1) >> 16) & 0xff],
      [(h - 1) & 0xff, ((h - 1) >> 8) & 0xff, ((h - 1) >> 16) & 0xff]
    )
    expect(parseImageSize(hdr)).toEqual({ width: w, height: h })
  })

  it('未知格式 / 数据过短返回 null', () => {
    expect(parseImageSize(new Uint8Array(10))).toBeNull()
    expect(parseImageSize(bytes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]))).toBeNull()
  })
})
