/**
 * 统一图片源(主进程 sharp 流式缩放)单元测试(§性能/§格式)。
 * 真实 sharp + 临时图片:验证参数校验、文件夹/压缩包缩放、ETag。
 * 不依赖 Electron(protocol 注册在 ipc.ts 集成层验证)。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MAX_TARGET_WIDTH,
  parseImageSourceParams,
  renderImageSource
} from '../src/main/image-source'
import { writeFile } from 'node:fs/promises'

let dir: string
let pngPath: string
let archivePath: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'komascope-img-src-'))
  // 2000×1500 红图(足够大以验证 resize 生效)
  pngPath = join(dir, 'page-1.png')
  await sharp({ create: { width: 2000, height: 1500, channels: 3, background: { r: 200, g: 0, b: 0 } } })
    .png()
    .toFile(pngPath)
  // 压缩包源:同一 PNG 打包为 cbz
  const pngBytes = await sharp(pngPath).png().toBuffer()
  archivePath = join(dir, 'book.cbz')
  await writeFile(archivePath, zipSync({ 'p1.png': pngBytes, 'p2.png': pngBytes }))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeUrl(pathname: string, query = ''): URL {
  return new URL(`komascope-thumb://${pathname}${query}`)
}

describe('parseImageSourceParams', () => {
  it('Windows 路径去前导斜杠,无 w/entry 时仅路径', () => {
    const p = parseImageSourceParams(makeUrl('/F:/comic/001.jpg'))
    expect(p).toEqual({ path: 'F:/comic/001.jpg', width: undefined, archiveEntry: undefined })
  })

  it('w 合法时解析为整数', () => {
    const p = parseImageSourceParams(makeUrl('/F:/a.png', '?w=192'))
    expect(p?.width).toBe(192)
  })

  it('w 非整数/越界返回 null', () => {
    expect(parseImageSourceParams(makeUrl('/F:/a.png', '?w=abc'))).toBeNull()
    expect(parseImageSourceParams(makeUrl('/F:/a.png', '?w=0'))).toBeNull()
    expect(parseImageSourceParams(makeUrl('/F:/a.png', `?w=${MAX_TARGET_WIDTH + 1}`))).toBeNull()
  })

  it('entry 非空时识别为压缩包源', () => {
    const p = parseImageSourceParams(makeUrl('/F:/book.cbz', '?entry=p1.png&w=256'))
    expect(p?.path).toBe('F:/book.cbz')
    expect(p?.archiveEntry).toBe('p1.png')
    expect(p?.width).toBe(256)
  })
})

describe('renderImageSource(真实 sharp)', () => {
  it('文件夹源缩放到指定宽,输出渐进 JPEG', async () => {
    const { body, etag } = await renderImageSource({ path: pngPath, width: 256 })
    const meta = await sharp(body).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(256)
    // 等比缩放:1500×(256/2000)=192
    expect(meta.height).toBe(192)
    expect(etag).toMatch(/^W\/".*"$/)
  })

  it('不指定宽时输出原图(等比无放大)', async () => {
    const { body } = await renderImageSource({ path: pngPath })
    const meta = await sharp(body).metadata()
    expect(meta.width).toBe(2000)
    expect(meta.height).toBe(1500)
  })

  it('w 大于原图宽时 withoutEnlargement 保持原尺寸', async () => {
    const { body } = await renderImageSource({ path: pngPath, width: 4096 })
    const meta = await sharp(body).metadata()
    expect(meta.width).toBe(2000)
  })

  it('压缩包源:解压条目后同样缩放', async () => {
    const { body } = await renderImageSource({ path: archivePath, archiveEntry: 'p1.png', width: 512 })
    const meta = await sharp(body).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(512)
    expect(meta.height).toBe(384)
  })

  it('不存在的路径抛错(协议层转 404)', async () => {
    await expect(renderImageSource({ path: join(dir, 'nope.png'), width: 128 })).rejects.toThrow()
  })
})

describe('parseImageSourceParams 区域参数(§超高清)', () => {
  it('全缺省 → region 为 undefined(整图)', () => {
    const p = parseImageSourceParams(makeUrl('/F:/a.png', '?w=100'))
    expect(p?.region).toBeUndefined()
  })

  it('x/y/rw/rh 齐备时解析为区域', () => {
    const p = parseImageSourceParams(makeUrl('/F:/a.png', '?x=10&y=20&rw=300&rh=400&w=256'))
    expect(p?.region).toEqual({ x: 10, y: 20, width: 300, height: 400 })
    expect(p?.width).toBe(256)
  })

  it('部分缺失或非法返回 null', () => {
    expect(parseImageSourceParams(makeUrl('/F:/a.png', '?x=10&y=20&rw=300'))).toBeNull()
    expect(parseImageSourceParams(makeUrl('/F:/a.png', '?x=-1&y=0&rw=10&rh=10'))).toBeNull()
    expect(parseImageSourceParams(makeUrl('/F:/a.png', '?x=0&y=0&rw=0&rh=10'))).toBeNull()
  })
})

describe('renderImageSource 区域裁剪(真实 sharp)', () => {
  it('超 2.68 亿像素的图不被 sharp 拒绝(limitInputPixels 解除)', async () => {
    // 20000×15000 = 3 亿像素 > sharp 默认 limitInputPixels(约 2.68 亿)
    const bigPath = join(dir, 'huge.tif')
    await sharp({
      create: { width: 20000, height: 15000, channels: 3, background: { r: 10, g: 20, b: 30 } },
      limitInputPixels: false
    })
      .tiff()
      .toFile(bigPath)
    // 区域请求:只解码视口区域,输出宽 1920
    const { body } = await renderImageSource({
      path: bigPath,
      region: { x: 9000, y: 6750, width: 3000, height: 2000 },
      width: 1920
    })
    const meta = await sharp(body).metadata()
    expect(meta.width).toBe(1920)
    expect(meta.height).toBe(1280)
  }, 60000)

  it('extract 区域后缩放,输出尺寸与区域等比一致', async () => {
    // 2000×1500 红图,取中间 1000×750 区域缩到宽 200 → 200×150
    const { body } = await renderImageSource({
      path: pngPath,
      region: { x: 500, y: 375, width: 1000, height: 750 },
      width: 200
    })
    const meta = await sharp(body).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(200)
    expect(meta.height).toBe(150)
  })

  it('区域不同 → ETag 不同(缓存按区域区分)', async () => {
    const a = await renderImageSource({ path: pngPath, region: { x: 0, y: 0, width: 100, height: 100 } })
    const b = await renderImageSource({ path: pngPath, region: { x: 100, y: 0, width: 100, height: 100 } })
    expect(a.etag).not.toBe(b.etag)
  })

  it('压缩包源同样支持区域裁剪', async () => {
    const { body } = await renderImageSource({
      path: archivePath,
      archiveEntry: 'p1.png',
      region: { x: 0, y: 0, width: 500, height: 500 },
      width: 250
    })
    const meta = await sharp(body).metadata()
    expect(meta.width).toBe(250)
    expect(meta.height).toBe(250)
  })
})
