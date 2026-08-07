/**
 * 瓦片与解码缓存(NFR-4 / §8 LRU):按页淘汰的 LRU 缓存。
 * 泛型实现便于单测(测试注入 string 假位图)。
 *
 * 语义:maxPages 页上限(默认 8 页,文档 NFR-4);同一页内的条目共享页级
 * 最近使用顺序;页被淘汰时整页释放。超出 GPU 纹理上限的大图以瓦片
 * (TILE_SIZE×TILE_SIZE)为单位缓存,翻页时释放不可见页。
 */

export class TileCache<T> {
  /** 页 → (瓦片坐标 key → 值) */
  private pages = new Map<string, Map<string, T>>()
  private readonly maxPages: number

  constructor(maxPages = 8) {
    this.maxPages = Math.max(1, maxPages)
  }

  /** 最近使用页提升:删除后重插,使 Map 迭代序 = LRU 序 */
  private touch(pagePath: string): void {
    const page = this.pages.get(pagePath)
    if (page) {
      this.pages.delete(pagePath)
      this.pages.set(pagePath, page)
    }
  }

  private tileKey(x: number, y: number): string {
    return `${x}:${y}`
  }

  get(pagePath: string, tileX: number, tileY: number): T | undefined {
    const page = this.pages.get(pagePath)
    if (!page) return undefined
    const value = page.get(this.tileKey(tileX, tileY))
    if (value !== undefined) this.touch(pagePath)
    return value
  }

  /** 整页缓存(非瓦片模式:单块,坐标 0:0) */
  getPage(pagePath: string): T | undefined {
    return this.get(pagePath, 0, 0)
  }

  set(pagePath: string, tileX: number, tileY: number, value: T): void {
    let page = this.pages.get(pagePath)
    if (!page) {
      page = new Map()
      this.pages.set(pagePath, page)
    }
    page.set(this.tileKey(tileX, tileY), value)
    this.touch(pagePath)
    this.evict()
  }

  /** 整页缓存(非瓦片模式) */
  setPage(pagePath: string, value: T): void {
    this.set(pagePath, 0, 0, value)
  }

  has(pagePath: string, tileX: number, tileY: number): boolean {
    return this.pages.get(pagePath)?.has(this.tileKey(tileX, tileY)) ?? false
  }

  hasPage(pagePath: string): boolean {
    return this.pages.has(pagePath)
  }

  /** 释放整页(翻页时释放不可见页,NFR-4) */
  removePage(pagePath: string): void {
    this.pages.delete(pagePath)
  }

  /** 删除单个瓦片(解码结果被丢弃时同步清理,避免 closed 位图残留) */
  delete(pagePath: string, tileX: number, tileY: number): void {
    this.pages.get(pagePath)?.delete(this.tileKey(tileX, tileY))
  }

  /** 仅当缓存中仍是同一位图时删除(身份校验):丢弃过期解码结果时
   * 避免误删并发写入的新缓存;命中返回 true */
  deleteIf(pagePath: string, tileX: number, tileY: number, value: T): boolean {
    const page = this.pages.get(pagePath)
    if (!page) return false
    const key = this.tileKey(tileX, tileY)
    if (page.get(key) !== value) return false
    page.delete(key)
    return true
  }

  clear(): void {
    this.pages.clear()
  }

  get pageCount(): number {
    return this.pages.size
  }

  /** 淘汰最久未用页,直到 ≤ maxPages */
  private evict(): void {
    while (this.pages.size > this.maxPages) {
      const oldest = this.pages.keys().next().value
      if (oldest === undefined) break
      this.pages.delete(oldest)
    }
  }
}
