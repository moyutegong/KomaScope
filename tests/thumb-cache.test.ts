/**
 * 缩略图磁盘缓存单测(§性能):缓存键稳定性与失效、读写往返、禁用态、条目淘汰。
 * 纯 Node,不依赖 Electron(缓存目录由调用方注入)。
 */
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_CACHE_ENTRIES,
  pruneThumbCache,
  readThumb,
  setThumbCacheDir,
  thumbCacheKey,
  writeThumb
} from '../src/main/thumb-cache'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'komascope-thumb-'))
})

afterEach(async () => {
  setThumbCacheDir('')
  await rm(dir, { recursive: true, force: true })
})

const base = { path: 'F:\\lib\\a.jpg', width: 320, mtimeMs: 1000, size: 500 }

describe('thumbCacheKey', () => {
  it('同源同宽键稳定', () => {
    expect(thumbCacheKey({ ...base })).toBe(thumbCacheKey({ ...base }))
  })

  it('路径/目标宽/mtime/字节数任一变化即换键(源文件被替换后自动失效)', () => {
    expect(thumbCacheKey(base)).not.toBe(thumbCacheKey({ ...base, path: 'F:\\lib\\b.jpg' }))
    expect(thumbCacheKey(base)).not.toBe(thumbCacheKey({ ...base, width: 192 }))
    expect(thumbCacheKey(base)).not.toBe(thumbCacheKey({ ...base, mtimeMs: 2000 }))
    expect(thumbCacheKey(base)).not.toBe(thumbCacheKey({ ...base, size: 501 }))
  })

  it('压缩包条目名参与键(同一归档的不同条目不串图)', () => {
    expect(thumbCacheKey({ ...base, archiveEntry: '1.jpg' })).not.toBe(
      thumbCacheKey({ ...base, archiveEntry: '2.jpg' })
    )
  })

  it('mtime 亚毫秒差异不换键(取整避免抖动)', () => {
    expect(thumbCacheKey({ ...base, mtimeMs: 1000.4 })).toBe(
      thumbCacheKey({ ...base, mtimeMs: 1000.9 })
    )
  })

  it('文件名形如 sha1.jpg(可作为缓存目录中的文件名)', () => {
    expect(thumbCacheKey(base)).toMatch(/^[0-9a-f]{40}\.jpg$/)
  })
})

describe('读写与禁用态', () => {
  it('写入后可读回原始字节', async () => {
    setThumbCacheDir(dir)
    const body = Buffer.from([1, 2, 3, 4])
    await writeThumb('abc.jpg', body)
    expect((await readThumb('abc.jpg'))?.equals(body)).toBe(true)
  })

  it('未写入的键返回 null', async () => {
    setThumbCacheDir(dir)
    expect(await readThumb('none.jpg')).toBeNull()
  })

  it('未注入目录(缓存禁用)时读返回 null、写不落盘', async () => {
    setThumbCacheDir('')
    await writeThumb('abc.jpg', Buffer.from([9]))
    expect(await readThumb('abc.jpg')).toBeNull()
    expect(await readdir(dir)).toEqual([])
  })

  it('写入不遗留临时文件(临时文件 + rename 保证原子)', async () => {
    setThumbCacheDir(dir)
    await writeThumb('abc.jpg', Buffer.from([1]))
    const names = await readdir(dir)
    expect(names).toEqual(['abc.jpg'])
  })
})

describe('pruneThumbCache(条目淘汰)', () => {
  it('超过上限时按 mtime 删除最旧条目', async () => {
    setThumbCacheDir(dir)
    const keys = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']
    for (let i = 0; i < keys.length; i++) {
      const file = join(dir, keys[i])
      await writeFile(file, Buffer.from([i]))
      const t = 1000 + i * 10
      await utimes(file, t, t)
    }
    expect(await pruneThumbCache(dir, 3)).toBe(2)
    expect((await readdir(dir)).sort()).toEqual(['c.jpg', 'd.jpg', 'e.jpg'])
  })

  it('未超过上限时不删除', async () => {
    setThumbCacheDir(dir)
    await writeFile(join(dir, 'a.jpg'), Buffer.from([1]))
    expect(await pruneThumbCache(dir, 5)).toBe(0)
    expect(await readdir(dir)).toEqual(['a.jpg'])
  })

  it('上限足够大,正常书库不会被频繁淘汰', () => {
    expect(MAX_CACHE_ENTRIES).toBeGreaterThanOrEqual(1000)
  })
})
