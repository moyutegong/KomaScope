import { describe, expect, it } from 'vitest'
import { TileCache } from '../src/shared/tile-cache'

describe('TileCache(按页 LRU)', () => {
  it('get/set/has 基础读写', () => {
    const c = new TileCache<string>(8)
    c.set('p1', 0, 0, 'a')
    c.set('p1', 1, 0, 'b')
    expect(c.get('p1', 0, 0)).toBe('a')
    expect(c.get('p1', 1, 0)).toBe('b')
    expect(c.get('p1', 2, 0)).toBeUndefined()
    expect(c.hasPage('p1')).toBe(true)
  })

  it('整页缓存 API', () => {
    const c = new TileCache<string>(8)
    c.setPage('p1', 'full')
    expect(c.getPage('p1')).toBe('full')
    expect(c.has('p1', 0, 0)).toBe(true)
  })

  it('超过 maxPages 时淘汰最久未用页', () => {
    const c = new TileCache<string>(2)
    c.setPage('p1', 'a')
    c.setPage('p2', 'b')
    c.setPage('p3', 'c') // 淘汰 p1
    expect(c.hasPage('p1')).toBe(false)
    expect(c.hasPage('p2')).toBe(true)
    expect(c.hasPage('p3')).toBe(true)
  })

  it('get 提升 LRU 优先级', () => {
    const c = new TileCache<string>(2)
    c.setPage('p1', 'a')
    c.setPage('p2', 'b')
    c.getPage('p1') // 提升 p1
    c.setPage('p3', 'c') // 淘汰 p2
    expect(c.hasPage('p1')).toBe(true)
    expect(c.hasPage('p2')).toBe(false)
    expect(c.hasPage('p3')).toBe(true)
  })

  it('removePage 释放整页', () => {
    const c = new TileCache<string>(8)
    c.set('p1', 0, 0, 'a')
    c.set('p1', 1, 1, 'b')
    c.removePage('p1')
    expect(c.pageCount).toBe(0)
    expect(c.get('p1', 0, 0)).toBeUndefined()
  })

  it('clear 清空全部', () => {
    const c = new TileCache<string>(8)
    c.setPage('p1', 'a')
    c.clear()
    expect(c.pageCount).toBe(0)
  })

  it('maxPages 至少为 1', () => {
    const c = new TileCache<string>(0)
    expect(c.pageCount).toBe(0)
    c.setPage('p1', 'a')
    c.setPage('p2', 'b')
    expect(c.pageCount).toBe(1)
  })
})
