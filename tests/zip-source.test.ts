/**
 * zip/cbz 压缩包源单测(§13 P0):用 fflate zipSync 构造测试包,
 * 验证 scanArchive 过滤/排序/条目名、readArchiveEntry 解压还原。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readArchiveEntry, scanArchive } from '../src/main/zip-source'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'komascope-zip-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeArchive(files: Record<string, Uint8Array>): string {
  const path = join(dir, 'test.cbz')
  writeFileSync(path, zipSync(files, { level: 6 }))
  return path
}

/** 最小 PNG 头,可被 parseImageSize 识别(此处仅用于验证条目名/字节还原) */
function pngBytes(width: number, height: number): Uint8Array {
  const head = new Uint8Array(24)
  head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  head.set([0, 0, 0, 13], 8)
  head.set(strToU8('IHDR'), 12)
  const dv = new DataView(head.buffer)
  dv.setUint32(16, width)
  dv.setUint32(20, height)
  return head
}

describe('scanArchive', () => {
  it('过滤非图片条目并按条目名自然排序,size 为解压后大小', async () => {
    const archive = makeArchive({
      'page10.png': pngBytes(50, 60),
      'page2.png': pngBytes(100, 200),
      'page1.png': pngBytes(258, 772),
      'notes.txt': strToU8('not an image'),
      'cover.jpg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    })
    const pages = await scanArchive(archive)
    expect(pages.map((p) => p.name)).toEqual(['cover.jpg', 'page1.png', 'page2.png', 'page10.png'])
    expect(pages.every((p) => p.path === archive)).toBe(true)
    expect(pages.find((p) => p.name === 'page1.png')?.size).toBe(24)
    expect(pages.find((p) => p.name === 'notes.txt')).toBeUndefined()
  })

  it('嵌套目录条目取 basename 为页面名,archiveEntry 保留完整路径', async () => {
    const archive = makeArchive({
      'vol1/001.png': pngBytes(10, 10),
      'vol1/002.png': pngBytes(10, 10)
    })
    const pages = await scanArchive(archive)
    expect(pages.map((p) => p.name)).toEqual(['001.png', '002.png'])
    expect(pages[0].archiveEntry).toBe('vol1/001.png')
  })

  it('空包返回空列表', async () => {
    expect(await scanArchive(makeArchive({}))).toEqual([])
  })
})

describe('readArchiveEntry', () => {
  it('按条目名解压并还原原始字节', async () => {
    const content = strToU8('hello cbz content')
    const archive = makeArchive({ 'a.png': content, 'b.png': strToU8('other') })
    const bytes = await readArchiveEntry(archive, 'a.png')
    expect(Buffer.from(bytes).toString()).toBe('hello cbz content')
  })

  it('条目不存在时抛出错误', async () => {
    const archive = makeArchive({ 'a.png': strToU8('x') })
    await expect(readArchiveEntry(archive, 'missing.png')).rejects.toThrow()
  })
})
