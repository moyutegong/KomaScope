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

import { ConfigStore } from '../src/main/config-store'

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
