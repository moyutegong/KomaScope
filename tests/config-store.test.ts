/**
 * ConfigStore 单测:removeRecentFolder 原子删除(§侧栏删除历史)。
 * electron 经 vi.mock 提供 getPath(仅模块顶层单例构造时用到,返回值无关);
 * 测试实例均传入自定义 filePath,落盘到临时目录。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' }
}))

import { ConfigStore, MAX_BOOKMARKS, normalizeConfig } from '../src/main/config-store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'komascope-config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeStore(): ConfigStore {
  return new ConfigStore(join(dir, 'config.json'))
}

describe('ConfigStore.removeRecentFolder', () => {
  it('移除指定历史项并返回删除后列表', () => {
    const store = makeStore()
    store.set({ recentFolders: ['a', 'b', 'c'] })
    expect(store.removeRecentFolder('b')).toEqual(['a', 'c'])
    expect(store.get().recentFolders).toEqual(['a', 'c'])
  })

  it('连续删除各自生效(原子性,无 read-modify-write 竞态)', () => {
    const store = makeStore()
    store.set({ recentFolders: ['a', 'b', 'c', 'd'] })
    store.removeRecentFolder('a')
    store.removeRecentFolder('c')
    expect(store.get().recentFolders).toEqual(['b', 'd'])
  })

  it('删除不存在的项时列表不变', () => {
    const store = makeStore()
    store.set({ recentFolders: ['a', 'b'] })
    expect(store.removeRecentFolder('nope')).toEqual(['a', 'b'])
  })

  it('重复删除同一项只移除一次', () => {
    const store = makeStore()
    store.set({ recentFolders: ['a', 'a', 'b'] })
    expect(store.removeRecentFolder('a')).toEqual(['b'])
  })
})

describe('ConfigStore.addRecentFolder', () => {
  it('新路径置顶并返回更新后列表', () => {
    const store = makeStore()
    store.set({ recentFolders: ['a', 'b'] })
    expect(store.addRecentFolder('c')).toEqual(['c', 'a', 'b'])
    expect(store.get().recentFolders).toEqual(['c', 'a', 'b'])
  })

  it('重复添加同一路径时去重置顶,不产生重复项', () => {
    const store = makeStore()
    store.set({ recentFolders: ['a', 'b', 'c'] })
    expect(store.addRecentFolder('b')).toEqual(['b', 'a', 'c'])
    expect(store.addRecentFolder('b')).toEqual(['b', 'a', 'c'])
  })

  it('连续添加各自生效(原子性,无 read-modify-write 竞态)', () => {
    const store = makeStore()
    store.addRecentFolder('a')
    store.addRecentFolder('b')
    store.addRecentFolder('c')
    expect(store.get().recentFolders).toEqual(['c', 'b', 'a'])
  })

  it('超过上限 10 时丢弃最旧项', () => {
    const store = makeStore()
    store.set({ recentFolders: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] })
    expect(store.addRecentFolder('11')).toEqual([
      '11', '1', '2', '3', '4', '5', '6', '7', '8', '9'
    ])
  })
})

describe('ConfigStore.setBookmark(§观看历史:每个文件夹独立书签)', () => {
  it('写入后返回完整书签表,updatedAt 由主进程生成', () => {
    const store = makeStore()
    const map = store.setBookmark({
      folderPath: 'F:\\lib\\a',
      lastImagePath: 'F:\\lib\\a\\p12.jpg',
      lastIndex: 11,
      pageCount: 58
    })
    expect(map['F:\\lib\\a'].lastIndex).toBe(11)
    expect(map['F:\\lib\\a'].pageCount).toBe(58)
    expect(map['F:\\lib\\a'].updatedAt).toBeGreaterThan(0)
    expect(store.get().bookmarks['F:\\lib\\a'].lastImagePath).toBe('F:\\lib\\a\\p12.jpg')
  })

  it('多个文件夹各自独立,连续写入互不覆盖(原子性)', () => {
    const store = makeStore()
    store.setBookmark({ folderPath: 'a', lastImagePath: 'a/1.jpg', lastIndex: 0, pageCount: 10 })
    store.setBookmark({ folderPath: 'b', lastImagePath: 'b/3.jpg', lastIndex: 2, pageCount: 20 })
    store.setBookmark({ folderPath: 'a', lastImagePath: 'a/5.jpg', lastIndex: 4, pageCount: 10 })
    expect(Object.keys(store.get().bookmarks).sort()).toEqual(['a', 'b'])
    expect(store.get().bookmarks['a']).toMatchObject({ lastImagePath: 'a/5.jpg', lastIndex: 4 })
    expect(store.get().bookmarks['b'].lastIndex).toBe(2)
  })

  it('超过上限时按最近阅读保留最新项', () => {
    vi.useFakeTimers()
    try {
      const store = makeStore()
      for (let i = 0; i < MAX_BOOKMARKS + 5; i++) {
        vi.setSystemTime(1_000_000 + i * 1000)
        store.setBookmark({
          folderPath: `f${i}`,
          lastImagePath: `f${i}/1.jpg`,
          lastIndex: 0,
          pageCount: 1
        })
      }
      const keys = Object.keys(store.get().bookmarks)
      expect(keys.length).toBe(MAX_BOOKMARKS)
      // 最新的保留,最早的被淘汰
      expect(keys).toContain(`f${MAX_BOOKMARKS + 4}`)
      expect(keys).not.toContain('f0')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('normalizeConfig:书库根目录与书签清洗(§观看历史)', () => {
  it('非法书签项被丢弃,合法项保留;libraryRoot 保留字符串', () => {
    const config = normalizeConfig({
      libraryRoot: 'F:\\lib',
      bookmarks: {
        ok: { folderPath: 'ok', lastImagePath: 'ok/1.jpg', lastIndex: 3, pageCount: 9, updatedAt: 1000 },
        // 缺 folderPath / 下标为负 / 非对象:均应丢弃
        missingPath: { lastImagePath: 'x/1.jpg', lastIndex: 1, pageCount: 2, updatedAt: 1 },
        negative: { folderPath: 'neg', lastImagePath: 'neg/1.jpg', lastIndex: -1, pageCount: 2, updatedAt: 1 },
        notObject: 'nope'
      }
    })
    expect(Object.keys(config.bookmarks)).toEqual(['ok'])
    expect(config.libraryRoot).toBe('F:\\lib')
  })

  it('字段缺失时回退默认值(向前兼容旧配置)', () => {
    const config = normalizeConfig({})
    expect(config.libraryRoot).toBe('')
    expect(config.bookmarks).toEqual({})
  })

  it('小数下标向下取整,避免索引非整数', () => {
    const config = normalizeConfig({
      bookmarks: {
        a: { folderPath: 'a', lastImagePath: 'a/1.jpg', lastIndex: 2.9, pageCount: 5.5, updatedAt: 10 }
      }
    })
    expect(config.bookmarks['a'].lastIndex).toBe(2)
    expect(config.bookmarks['a'].pageCount).toBe(5)
  })

  it('bookmarks 为非对象(数组/字符串)时回退空表', () => {
    expect(normalizeConfig({ bookmarks: ['a'] }).bookmarks).toEqual({})
    expect(normalizeConfig({ bookmarks: 'x' }).bookmarks).toEqual({})
  })
})
