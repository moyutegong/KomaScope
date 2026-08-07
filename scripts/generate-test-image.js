/**
 * 生成超大测试图(默认 8736×11648 渐变 PNG,约 2.4×4K 尺寸)。
 * 用途:验证 4K+ 图片的瓦片渲染管线(性能与瓦片拼接黑线)。
 * 用法:node scripts/generate-test-image.js [宽] [高] [输出路径]
 * 渐变图案便于肉眼观察瓦片拼接处是否有黑线/缝隙。
 * 纯 node + fflate(zlibSync),不依赖浏览器 API。
 */
const { zlibSync } = require('fflate')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const W = Number(process.argv[2] ?? 8736)
const H = Number(process.argv[3] ?? 11648)
const out = process.argv[4] ?? path.join(os.tmpdir(), `komascope-test-${W}x${H}.png`)

// --- PNG 容器工具 ---
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

console.log(`生成 ${W}×${H} 渐变 PNG → ${out}`)
const t0 = Date.now()

// RGB 渐变:水平红、垂直绿,便于观察拼接边界
const pixels = new Uint8Array(W * H * 3)
for (let y = 0; y < H; y++) {
  const row = y * W * 3
  const g = (y * 255) / H
  for (let x = 0; x < W; x++) {
    const p = row + x * 3
    pixels[p] = (x * 255) / W
    pixels[p + 1] = g
    pixels[p + 2] = 128
  }
}
console.log(`像素数据 ${(pixels.byteLength / 1048576).toFixed(0)} MB,${((Date.now() - t0) / 1000).toFixed(1)}s`)

// scanline:每行前置 filter 0
const raw = Buffer.alloc(W * H * 3 + H)
for (let y = 0; y < H; y++) {
  const dst = y * (W * 3 + 1)
  raw[dst] = 0
  raw.set(pixels.subarray(y * W * 3, (y + 1) * W * 3), dst + 1)
}
const idat = zlibSync(raw, { level: 6 })
console.log(`压缩 ${(idat.byteLength / 1048576).toFixed(1)} MB,${((Date.now() - t0) / 1000).toFixed(1)}s`)

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // color type: RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
])
fs.writeFileSync(out, png)
console.log(`完成:${(png.byteLength / 1048576).toFixed(1)} MB,总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
