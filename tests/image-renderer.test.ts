/**
 * ImageRenderer 瓦片渲染行为(§性能):
 * - 渐进显示:单块解码完成且变换未变时立即增量绘制(不等整批)
 * - 变换竞态:解码期间变换变化则跳过增量绘制,由 onTilesReady 兜底重绘
 * - 失效清理:isStale(翻页/退出瓦片模式)时丢弃并清理解码结果
 * 通过假 canvas / 假 2d context 在 node 环境验证绘制调用。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageRenderer } from '../src/renderer/viewer/image-renderer'
import type { TileProvider } from '../src/renderer/viewer/image-renderer'
import type { Size, ViewTransform } from '../src/shared/transform-model'

/** 可手动 resolve 的延迟 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

interface CtxMock {
  drawImage: ReturnType<typeof vi.fn>
  setTransform: ReturnType<typeof vi.fn>
  clearRect: ReturnType<typeof vi.fn>
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: string
  save: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  translate: ReturnType<typeof vi.fn>
  rotate: ReturnType<typeof vi.fn>
  scale: ReturnType<typeof vi.fn>
}

function makeRenderer(): { renderer: ImageRenderer; ctx: CtxMock } {
  const ctx: CtxMock = {
    drawImage: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn()
  }
  const canvas = { getContext: () => ctx, width: 0, height: 0, hidden: false }
  ;(globalThis as { document?: unknown }).document = { getElementById: () => ({}) }
  const renderer = new ImageRenderer(canvas as unknown as HTMLCanvasElement)
  renderer.resize(1920, 1080, 1)
  return { renderer, ctx }
}

const imageSize: Size = { width: 4096, height: 4096 }
const transform: ViewTransform = { scale: 1, tx: 0, ty: 0 }
/** 假位图:含 close mock,isStale 清理路径会调用它 */
const tileBitmap = { width: 2048, height: 2048, close: vi.fn() } as unknown as ImageBitmap

interface MockProvider {
  getTile: ReturnType<typeof vi.fn>
  decodeTile: ReturnType<typeof vi.fn>
  removeTile: ReturnType<typeof vi.fn>
  onTilesReady: ReturnType<typeof vi.fn>
}

function makeProvider(
  overrides: {
    decodeTile?: () => Promise<ImageBitmap | null>
  } = {}
): MockProvider {
  const decodeTile = overrides.decodeTile
    ? vi.fn(overrides.decodeTile)
    : vi.fn(() => Promise.resolve(tileBitmap))
  return {
    getTile: vi.fn(() => undefined),
    decodeTile,
    removeTile: vi.fn(),
    onTilesReady: vi.fn()
  }
}

/** 等待微任务链收敛(mapWithConcurrency 的 worker 链) */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('ImageRenderer.renderTiled 渐进显示', () => {
  beforeEach(() => {
    ;(tileBitmap.close as ReturnType<typeof vi.fn>).mockClear()
  })

  it('缺失瓦片解码完成且变换未变:单块立即增量绘制', async () => {
    const { renderer, ctx } = makeRenderer()
    const provider = makeProvider()
    renderer.renderTiled(transform, imageSize, provider as unknown as TileProvider, () => false)
    // 全缺失:首帧无任何绘制
    expect(ctx.drawImage).not.toHaveBeenCalled()
    await flushMicrotasks()
    // 单块解码完成 → 增量绘制一次(目标位置 = 图片原点经变换)
    expect(ctx.drawImage).toHaveBeenCalledTimes(1)
    const args = ctx.drawImage.mock.calls[0]
    expect(args[0]).toBe(tileBitmap)
    expect(args[1]).toBe(0) // 源原点
    // 目标原点 = 变换原点 - padX(相邻瓦片 1px 扩展,防接缝黑线)
    expect(args[5]).toBe(-1)
  })

  it('解码期间变换变化:跳过增量绘制,批次完成时回调 onTilesReady', async () => {
    const { renderer, ctx } = makeRenderer()
    const first = deferred<ImageBitmap | null>()
    const second = deferred<ImageBitmap | null>()
    const provider = makeProvider({
      decodeTile: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    })
    // 第一帧:批次 A 在途
    renderer.renderTiled(transform, imageSize, provider as unknown as TileProvider, () => false)
    // 变换变化后的第二帧:批次 B 在途(同一瓦片,lastTiledTransform 已更新)
    const shifted: ViewTransform = { scale: 1.5, tx: 100, ty: 50 }
    renderer.renderTiled(shifted, imageSize, provider as unknown as TileProvider, () => false)
    expect(ctx.drawImage).not.toHaveBeenCalled()

    // 批次 A 完成:快照(旧变换)≠ lastTiledTransform → 跳过增量
    first.resolve(tileBitmap)
    await flushMicrotasks()
    expect(ctx.drawImage).not.toHaveBeenCalled()
    expect(provider.onTilesReady).toHaveBeenCalledTimes(1)

    // 批次 B 完成:快照 = 当前变换 → 增量绘制
    second.resolve(tileBitmap)
    await flushMicrotasks()
    expect(ctx.drawImage).toHaveBeenCalledTimes(1)
    expect(provider.onTilesReady).toHaveBeenCalledTimes(1)
  })

  it('isStale(翻页/退出瓦片模式):不绘制,清理解码结果并 close 位图', async () => {
    const { renderer, ctx } = makeRenderer()
    let stale = false
    const provider = makeProvider()
    renderer.renderTiled(transform, imageSize, provider as unknown as TileProvider, () => stale)
    stale = true // 批次在途时翻页
    await flushMicrotasks()
    expect(ctx.drawImage).not.toHaveBeenCalled()
    // 解码结果从缓存移除、位图 close 交还(无 unhandled rejection)
    expect(provider.removeTile).toHaveBeenCalledWith(0, 0, tileBitmap)
    expect(tileBitmap.close).toHaveBeenCalledTimes(1)
    expect(provider.onTilesReady).not.toHaveBeenCalled()
  })
})
