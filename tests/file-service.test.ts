/**
 * file-service 集成测试:真实临时目录 + 构造 PNG 文件,验证扫描/排序/元数据链路。
 * (vitest node 环境;file-service 无 electron 依赖)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanFolder } from '../src/main/file-service'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'komascope-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 最小 PNG 头(签名 + IHDR),尺寸与真实宽高一致即可被头部解析 */
function pngBytes(width: number, height: number): Buffer {
  const head = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  Buffer.from([0, 0, 0, 13]).copy(head, 8)
  Buffer.from('IHDR', 'ascii').copy(head, 12)
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return head
}

describe('scanFolder(真实文件系统)', () => {
  it('扫描图片、自然排序、读取头部尺寸', async () => {
    writeFileSync(join(dir, 'page10.png'), pngBytes(50, 60))
    writeFileSync(join(dir, 'page1.png'), pngBytes(258, 772))
    writeFileSync(join(dir, 'page2.png'), pngBytes(100, 200))
    writeFileSync(join(dir, 'notes.txt'), Buffer.from('not an image'))
    writeFileSync(join(dir, 'cover.JPG'), Buffer.from([0xff, 0xd8, 0xff, 0xe0])) // 扩展名大小写 + 无效 JPEG

    const pages = await scanFolder(dir)
    expect(pages.map((p) => p.name)).toEqual(['cover.JPG', 'page1.png', 'page2.png', 'page10.png'])
    const page1 = pages.find((p) => p.name === 'page1.png')!
    expect(page1.width).toBe(258)
    expect(page1.height).toBe(772)
    expect(page1.size).toBe(24)
  })

  it('空目录返回空列表', async () => {
    expect(await scanFolder(dir)).toEqual([])
  })
})
