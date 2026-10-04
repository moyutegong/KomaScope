/**
 * ViewerController 渲染调度与配置持久化行为(§性能):
 * - rAF 合并:高频交互事件(滚轮/拖拽)只产生一次整帧重绘
 * - setConfig 防抖:交互期间合并 IPC 写入,页面卸载时冲刷
 * 通过 mock 全局 window / requestAnimationFrame 在 node 环境验证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ViewerController } from '../src/renderer/viewer/viewer-controller'
import type { ViewerCallbacks } from '../src/renderer/viewer/viewer-controller'
import type { ImageRenderer } from '../src/renderer/viewer/image-renderer'
import type { StatusBar } from '../src/renderer/ui/statusbar'
import type { PageItem } from '../src/shared/types'

/** 构造 count 张假页面(path 为 `{folder}\N.jpg`) */
function makePages(folder: string, count: number): PageItem[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `${folder}\\${i + 1}.jpg`,
    name: `${i + 1}.jpg`,
    width: 800,
    height: 1200,
    size: 0
  }))
}

/** 原始 fetch(测试替换后恢复,避免影响其他用例) */
const originalFetch = globalThis.fetch

/** 注入可手动触发的 requestAnimationFrame,收集待执行帧回调 */
function installRaf(): { frames: FrameRequestCallback[]; tick: () => void } {
  const frames: FrameRequestCallback[] = []
  ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
    cb: FrameRequestCallback
  ): number => {
    frames.push(cb)
    return frames.length
  }
  return {
    frames,
    tick: () => {
      const pending = frames.splice(0)
      for (const cb of pending) cb(0)
    }
  }
}

/** 注入 window(pagehide 监听 + komascope.setConfig/setBookmark 记录) */
function installWindow(
  overrides: Record<string, unknown> = {}
): {
  pagehideHandlers: Array<() => void>
  setConfig: ReturnType<typeof vi.fn>
  setBookmark: ReturnType<typeof vi.fn>
} {
  const pagehideHandlers: Array<() => void> = []
  const setConfig = vi.fn().mockResolvedValue({})
  const setBookmark = vi.fn().mockResolvedValue({})
  ;(globalThis as { window?: unknown }).window = {
    addEventListener: (type: string, handler: () => void) => {
      if (type === 'pagehide') pagehideHandlers.push(handler)
    },
    komascope: { setConfig, setBookmark, ...overrides }
  }
  return { pagehideHandlers, setConfig, setBookmark }
}

function makeRenderer(): {
  render: ReturnType<typeof vi.fn>
  renderSpread: ReturnType<typeof vi.fn>
  renderTiled: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
  setVisible: ReturnType<typeof vi.fn>
  viewportSize: { width: number; height: number }
  devicePixelRatio: number
} {
  return {
    render: vi.fn(),
    renderSpread: vi.fn(),
    renderTiled: vi.fn(),
    clear: vi.fn(),
    setVisible: vi.fn(),
    viewportSize: { width: 1920, height: 1080 },
    devicePixelRatio: 2
  }
}

function makeStatusbar(): { setZoom: ReturnType<typeof vi.fn> } & Record<string, unknown> {
  return {
    setZoom: vi.fn(),
    setPage: vi.fn(),
    setImageSize: vi.fn(),
    setLocked: vi.fn(),
    setBusy: vi.fn(),
    flashResume: vi.fn(),
    refresh: vi.fn()
  }
}

/** 构造已装载假位图的控制器(跳过 loadPage,直接验证交互渲染路径) */
function makeController(
  renderer: ReturnType<typeof makeRenderer>,
  statusbar: ReturnType<typeof makeStatusbar>,
  callbacks: ViewerCallbacks = {}
): ViewerController {
  const controller = new ViewerController(
    renderer as unknown as ImageRenderer,
    statusbar as unknown as StatusBar,
    callbacks
  )
  ;(controller as unknown as { bitmap: unknown }).bitmap = {}
  ;(controller as unknown as { imageSize: unknown }).imageSize = { width: 100, height: 100 }
  return controller
}

describe('rAF 渲染合并', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    delete (globalThis as { window?: unknown }).window
  })

  it('连续 10 次缩放事件只调度一次重绘、只绘制一帧', () => {
    const raf = installRaf()
    installWindow()
    const renderer = makeRenderer()
    const controller = makeController(renderer, makeStatusbar())

    for (let i = 0; i < 10; i++) controller.zoomAt({ x: 0, y: 0 }, 1.05)
    expect(raf.frames.length).toBe(1)
    raf.tick()
    expect(renderer.render).toHaveBeenCalledTimes(1)
    // 状态为最终值(10 次连乘),而非中间值
    expect((controller as unknown as { transform: { scale: number } }).transform.scale).toBeCloseTo(
      Math.pow(1.05, 10),
      6
    )
  })

  it('渲染帧执行后,后续交互可再次调度重绘', () => {
    const raf = installRaf()
    installWindow()
    const renderer = makeRenderer()
    const controller = makeController(renderer, makeStatusbar())

    controller.zoomAt({ x: 0, y: 0 }, 1.1)
    raf.tick()
    expect(renderer.render).toHaveBeenCalledTimes(1)

    controller.translateBy(10, 20)
    expect(raf.frames.length).toBe(1)
    raf.tick()
    expect(renderer.render).toHaveBeenCalledTimes(2)
  })

  it('平移与缩放混合时同样合并到一帧', () => {
    const raf = installRaf()
    installWindow()
    const renderer = makeRenderer()
    const controller = makeController(renderer, makeStatusbar())

    controller.translateBy(5, 5)
    controller.zoomAt({ x: 0, y: 0 }, 1.2)
    controller.translateBy(-3, 7)
    expect(raf.frames.length).toBe(1)
    raf.tick()
    expect(renderer.render).toHaveBeenCalledTimes(1)
  })
})

describe('setConfig 防抖持久化', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    delete (globalThis as { window?: unknown }).window
  })

  it('防抖窗口内多次缩放只写一次配置(最终倍率)', () => {
    const raf = installRaf()
    const { setConfig } = installWindow()
    const controller = makeController(makeRenderer(), makeStatusbar())

    for (let i = 0; i < 3; i++) controller.zoomAt({ x: 0, y: 0 }, 1.2)
    raf.tick()
    expect(setConfig).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(setConfig).toHaveBeenCalledTimes(1)
    expect(setConfig.mock.calls[0][0].scale).toBeCloseTo(Math.pow(1.2, 3), 6)
    expect(setConfig.mock.calls[0][0].fitMode).toBe('custom')
  })

  it('页面卸载时冲刷防抖中的配置,最后一次缩放不丢失', () => {
    installRaf()
    const { pagehideHandlers, setConfig } = installWindow()
    const controller = makeController(makeRenderer(), makeStatusbar())

    controller.zoomAt({ x: 0, y: 0 }, 1.25)
    expect(setConfig).not.toHaveBeenCalled()
    for (const handler of pagehideHandlers) handler()
    expect(setConfig).toHaveBeenCalledTimes(1)
    expect(setConfig.mock.calls[0][0].scale).toBeCloseTo(1.25, 6)
    // 冲刷后计时器不再触发第二次写入
    vi.advanceTimersByTime(200)
    expect(setConfig).toHaveBeenCalledTimes(1)
  })
})

describe('书签读写(§观看历史:每个文件夹各自独立)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    delete (globalThis as { window?: unknown }).window
    delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap
    globalThis.fetch = originalFetch
  })

  /** 直接注入来源与页面列表(跳过解码路径,只验证书签调度) */
  function seed(controller: ViewerController, sourcePath: string, folder: string, count: number): PageItem[] {
    const pages = makePages(folder, count)
    const state = controller as unknown as { sourcePath: string; pages: PageItem[] }
    state.sourcePath = sourcePath
    state.pages = pages
    return pages
  }

  function scheduleBookmark(controller: ViewerController, index: number): void {
    ;(controller as unknown as { scheduleBookmark: (i: number) => void }).scheduleBookmark(index)
  }

  it('节流:500ms 内连续翻页只写一次,记录最后一次位置', () => {
    installRaf()
    const { setBookmark } = installWindow()
    const controller = makeController(makeRenderer(), makeStatusbar())
    seed(controller, 'F:\\lib\\ch1', 'F:\\lib\\ch1', 5)

    scheduleBookmark(controller, 0)
    scheduleBookmark(controller, 2)
    scheduleBookmark(controller, 4)
    expect(setBookmark).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(setBookmark).toHaveBeenCalledTimes(1)
    expect(setBookmark.mock.calls[0][0]).toEqual({
      folderPath: 'F:\\lib\\ch1',
      lastImagePath: 'F:\\lib\\ch1\\5.jpg',
      lastIndex: 4,
      pageCount: 5
    })
  })

  it('无来源(如拖入不同文件夹的图片)时不写书签', () => {
    installRaf()
    const { setBookmark } = installWindow()
    const controller = makeController(makeRenderer(), makeStatusbar())
    seed(controller, '', 'F:\\lib\\ch1', 3)

    scheduleBookmark(controller, 1)
    vi.advanceTimersByTime(500)
    expect(setBookmark).not.toHaveBeenCalled()
  })

  it('页面卸载时冲刷待写入书签', () => {
    installRaf()
    const { pagehideHandlers, setBookmark } = installWindow()
    const controller = makeController(makeRenderer(), makeStatusbar())
    seed(controller, 'F:\\lib\\ch1', 'F:\\lib\\ch1', 3)

    scheduleBookmark(controller, 1)
    expect(setBookmark).not.toHaveBeenCalled()
    for (const handler of pagehideHandlers) handler()
    expect(setBookmark).toHaveBeenCalledTimes(1)
    expect(setBookmark.mock.calls[0][0].lastIndex).toBe(1)
    // 冲刷后计时器不再触发第二次写入
    vi.advanceTimersByTime(500)
    expect(setBookmark).toHaveBeenCalledTimes(1)
  })

  it('写入成功后回调浏览视图刷新进度', async () => {
    installRaf()
    const map = { 'F:\\lib\\ch1': { folderPath: 'F:\\lib\\ch1', lastImagePath: 'x', lastIndex: 1, pageCount: 3, updatedAt: 9 } }
    const setBookmark = vi.fn().mockResolvedValue(map)
    installWindow({ setBookmark })
    const received: unknown[] = []
    const controller = makeController(makeRenderer(), makeStatusbar(), {
      onBookmarksChanged: (bookmarks) => received.push(bookmarks)
    })
    seed(controller, 'F:\\lib\\ch1', 'F:\\lib\\ch1', 3)

    scheduleBookmark(controller, 1)
    vi.advanceTimersByTime(500)
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0]).toBe(map)
    expect(setBookmark).toHaveBeenCalledTimes(1)
    expect(setBookmark.mock.calls[0][0]).toMatchObject({ folderPath: 'F:\\lib\\ch1', lastIndex: 1 })
  })

  it('按书签路径匹配续读(图片被删除时退化为下标)', async () => {
    installRaf()
    const pages = makePages('F:\\lib\\ch1', 4)
    installWindow({
      getConfig: vi.fn().mockResolvedValue({
        bookmarks: {
          'F:\\lib\\ch1': {
            folderPath: 'F:\\lib\\ch1',
            lastImagePath: 'F:\\lib\\ch1\\3.jpg',
            lastIndex: 3,
            pageCount: 9,
            updatedAt: 5
          }
        },
        lastFolder: 'F:\\lib\\ch1',
        lastPage: 3
      })
    })
    const controller = makeController(makeRenderer(), makeStatusbar())
    const find = (controller as unknown as {
      findResumeIndex: (p: string, pages: PageItem[]) => Promise<{ index: number; resumed: boolean }>
    }).findResumeIndex.bind(controller)

    // 路径存在:按路径定位(下标与记录值不一致也以路径为准)
    expect(await find('F:\\lib\\ch1', pages)).toEqual({ index: 2, resumed: true })
    // 路径已不存在:退化为下标(越界则回到第 0 页)
    expect(await find('F:\\lib\\ch1', makePages('F:\\lib\\ch1', 3))).toEqual({ index: 2, resumed: true })
    expect(await find('F:\\lib\\ch1', [pages[0], pages[1]])).toEqual({ index: 0, resumed: false })
  })

  it('无书签时回退旧版 lastFolder/lastPage;来源不同则从第 0 页开始', async () => {
    installRaf()
    installWindow({
      getConfig: vi.fn().mockResolvedValue({
        bookmarks: {},
        lastFolder: 'F:\\lib\\ch2',
        lastPage: 3
      })
    })
    const controller = makeController(makeRenderer(), makeStatusbar())
    const find = (controller as unknown as {
      findResumeIndex: (p: string, pages: PageItem[]) => Promise<{ index: number; resumed: boolean }>
    }).findResumeIndex.bind(controller)
    const pages = makePages('F:\\lib\\ch2', 5)

    expect(await find('F:\\lib\\ch2', pages)).toEqual({ index: 3, resumed: true })
    expect(await find('F:\\lib\\ch1', pages)).toEqual({ index: 0, resumed: false })
  })

  it('打开来源时按书签续读并回调 onResumed', async () => {
    installRaf()
    const pages = makePages('F:\\lib\\ch1', 4)
    ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = vi.fn().mockResolvedValue({
      width: 800,
      height: 1200,
      close: vi.fn()
    })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])]))
    }) as unknown as typeof fetch
    installWindow({
      scanArchive: vi.fn().mockResolvedValue({ folderPath: 'F:\\lib\\ch1.cbz', pages }),
      getConfig: vi.fn().mockResolvedValue({
        bookmarks: {
          'F:\\lib\\ch1.cbz': {
            folderPath: 'F:\\lib\\ch1.cbz',
            lastImagePath: 'F:\\lib\\ch1\\3.jpg',
            lastIndex: 2,
            pageCount: 4,
            updatedAt: 7
          }
        },
        lastFolder: '',
        lastPage: 0
      }),
      fileUrl: (path: string) => `komascope-file:///${path}`,
      addRecentFolder: vi.fn().mockResolvedValue([])
    })
    const renderer = makeRenderer()
    const resumed: Array<{ index: number; pageCount: number }> = []
    // 该用例走真实加载路径,不能用 makeController 注入的假 bitmap(无 close())
    const controller = new ViewerController(
      renderer as unknown as ImageRenderer,
      makeStatusbar() as unknown as StatusBar,
      { onResumed: (info) => resumed.push(info) }
    )

    await controller.openArchive('F:\\lib\\ch1.cbz')
    expect(resumed).toEqual([{ index: 2, pageCount: 4 }])
    expect(controller.currentPage?.path).toBe('F:\\lib\\ch1\\3.jpg')
    // 从书签页开始读取并上屏
    await vi.waitFor(() => expect(renderer.setVisible).toHaveBeenCalledWith(true))
  })
})

describe('打开来源时的路径同步(§4.3.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    delete (globalThis as { window?: unknown }).window
    delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap
    globalThis.fetch = originalFetch
  })

  /** 拖入图片走真实加载路径,需要解码与网络桩 */
  function installLoadStubs(): void {
    ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = vi.fn().mockResolvedValue({
      width: 10,
      height: 10,
      close: vi.fn()
    })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])]))
    }) as unknown as typeof fetch
  }

  function makePlainController(callbacks: ViewerCallbacks): ViewerController {
    return new ViewerController(
      makeRenderer() as unknown as ImageRenderer,
      makeStatusbar() as unknown as StatusBar,
      callbacks
    )
  }

  it('同属一个文件夹时回调该文件夹路径(工具栏不再残留上一来源)', async () => {
    installRaf()
    installLoadStubs()
    installWindow({
      readMeta: vi.fn().mockResolvedValue({ width: 10, height: 10 }),
      fileUrl: (path: string) => path
    })
    const folders: string[] = []
    const controller = makePlainController({ onFolderChanged: (folderPath) => folders.push(folderPath) })

    await controller.openFiles(['F:\\lib\\ch1\\1.jpg', 'F:\\lib\\ch1\\2.jpg'])
    expect(folders).toEqual(['F:\\lib\\ch1'])
  })

  it('跨文件夹拖入时不归属任何来源(不回调)', async () => {
    installRaf()
    installLoadStubs()
    installWindow({
      readMeta: vi.fn().mockResolvedValue({ width: 10, height: 10 }),
      fileUrl: (path: string) => path
    })
    const folders: string[] = []
    const controller = makePlainController({ onFolderChanged: (folderPath) => folders.push(folderPath) })

    await controller.openFiles(['F:\\lib\\a\\1.jpg', 'F:\\lib\\b\\2.jpg'])
    expect(folders).toEqual([])
  })
})

describe('预解码(§性能 / §12 超大图风险应对)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    delete (globalThis as { window?: unknown }).window
    delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap
    globalThis.fetch = originalFetch
  })

  /** 替换解码与网络桩,返回 createImageBitmap 间谍 */
  function installDecodeSpy(): ReturnType<typeof vi.fn> {
    const spy = vi.fn().mockResolvedValue({ width: 10, height: 10, close: vi.fn() })
    ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = spy
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])]))
    }) as unknown as typeof fetch
    return spy
  }

  function makeBareController(): ViewerController {
    return new ViewerController(
      makeRenderer() as unknown as ImageRenderer,
      makeStatusbar() as unknown as StatusBar
    )
  }

  it('尺寸未知的超大图:先补读元数据再判定,不做整页预解码(避免 OOM)', async () => {
    installRaf()
    const createBitmap = installDecodeSpy()
    const readMeta = vi.fn().mockResolvedValue({ width: 20000, height: 20000 })
    installWindow({ readMeta, fileUrl: (path: string) => path })
    const controller = makeBareController()
    // 浏览视图列举结果:尺寸待解析(0),非 JPEG 且在补读前无法判定大小
    ;(controller as unknown as { pages: PageItem[] }).pages = [
      { path: 'F:\\lib\\huge.png', name: 'huge.png', width: 0, height: 0, size: 0 }
    ]

    ;(controller as unknown as { predecode: (i: number) => void }).predecode(0)
    await (controller as unknown as { decodeQueue: Promise<void> }).decodeQueue

    expect(readMeta).toHaveBeenCalledWith('F:\\lib\\huge.png', undefined)
    expect(createBitmap).not.toHaveBeenCalled()
  })

  it('尺寸未知但补读后为常规尺寸:正常预解码入缓存', async () => {
    installRaf()
    const createBitmap = installDecodeSpy()
    const readMeta = vi.fn().mockResolvedValue({ width: 800, height: 1200 })
    installWindow({ readMeta, fileUrl: (path: string) => path })
    const controller = makeBareController()
    ;(controller as unknown as { pages: PageItem[] }).pages = [
      { path: 'F:\\lib\\page1.png', name: 'page1.png', width: 0, height: 0, size: 0 }
    ]

    ;(controller as unknown as { predecode: (i: number) => void }).predecode(0)
    await (controller as unknown as { decodeQueue: Promise<void> }).decodeQueue

    expect(readMeta).toHaveBeenCalledTimes(1)
    expect(createBitmap).toHaveBeenCalledTimes(1)
  })
})

describe('瓦片解码跨页隔离(§5.1 串图修复)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    delete (globalThis as { window?: unknown }).window
    delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap
    globalThis.fetch = originalFetch
  })

  /** 可控的 createImageBitmap:挂起直到测试手动 resolve,并记录解码源 */
  function installControlledBitmap(): {
    calls: Array<{ src: unknown; resolve: (bitmap: unknown) => void }>
    spy: ReturnType<typeof vi.fn>
  } {
    const calls: Array<{ src: unknown; resolve: (bitmap: unknown) => void }> = []
    const spy = vi.fn(
      (src: unknown) =>
        new Promise((resolve) => {
          calls.push({ src, resolve })
        })
    )
    ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = spy
    return { calls, spy }
  }

  interface TileState {
    pages: PageItem[]
    currentIndex: number
    pageBlob: Blob | null
    tiled: boolean
    tiledFromFull: boolean
    imageSize: { width: number; height: number }
    loadSeq: number
    decodeTile: (x: number, y: number) => Promise<ImageBitmap | null>
    tileCache: { get: (key: string, x: number, y: number) => unknown }
  }

  function makeTileController(): TileState {
    installWindow()
    const controller = new ViewerController(
      makeRenderer() as unknown as ImageRenderer,
      makeStatusbar() as unknown as StatusBar
    )
    const state = controller as unknown as TileState
    state.pages = [
      { path: 'F:\\lib\\A.jpg', name: 'A.jpg', width: 12000, height: 12000, size: 1 }
    ]
    state.currentIndex = 0
    state.tiled = true
    state.tiledFromFull = false
    state.imageSize = { width: 12000, height: 12000 }
    state.loadSeq = 1
    return state
  }

  function fakeBitmap(): { width: number; height: number; close: ReturnType<typeof vi.fn> } {
    return { width: 1024, height: 1024, close: vi.fn() }
  }

  it('上一张图的在途瓦片不会交给新图(跨页不复用)', async () => {
    const { calls, spy } = installControlledBitmap()
    const state = makeTileController()
    const blobA = new Blob([new Uint8Array([1])])
    const blobB = new Blob([new Uint8Array([2])])

    // 图 A:瓦片 (0,0) 解码挂在途
    state.pageBlob = blobA
    const aPending = state.decodeTile(0, 0)
    expect(spy).toHaveBeenCalledTimes(1)

    // 切到图 B:同坐标必须发起自己的解码,不得复用 A 的在途 Promise
    state.pages = [
      { path: 'F:\\lib\\B.jpg', name: 'B.jpg', width: 12000, height: 12000, size: 2 }
    ]
    state.pageBlob = blobB
    state.loadSeq = 2
    const bPending = state.decodeTile(0, 0)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[1][0]).toBe(blobB)

    // A 迟到完成:结果被丢弃(关闭位图)且不写入任何缓存条目
    const bitmapA = fakeBitmap()
    calls[0].resolve(bitmapA)
    expect(await aPending).toBeNull()
    expect(bitmapA.close).toHaveBeenCalledTimes(1)

    // B 完成:返回 B 的位图,缓存写入 B 的页条目
    const bitmapB = fakeBitmap()
    calls[1].resolve(bitmapB)
    expect(await bPending).toBe(bitmapB)
    expect(state.tileCache.get('F:\\lib\\B.jpg', 0, 0)).toBe(bitmapB)
    expect(state.tileCache.get('F:\\lib\\A.jpg', 0, 0)).toBeUndefined()
  })

  it('同一页同坐标的并发请求仍共享一次解码(去重语义保留)', async () => {
    const { calls, spy } = installControlledBitmap()
    const state = makeTileController()
    state.pageBlob = new Blob([new Uint8Array([1])])

    const first = state.decodeTile(3, 4)
    const second = state.decodeTile(3, 4)
    expect(spy).toHaveBeenCalledTimes(1)

    const bitmap = fakeBitmap()
    calls[0].resolve(bitmap)
    expect(await first).toBe(bitmap)
    expect(await second).toBe(bitmap)
  })

  it('无位图可绘制时清空画布(不留上一张的像素)', () => {
    installRaf()
    installWindow()
    const renderer = makeRenderer()
    const controller = new ViewerController(
      renderer as unknown as ImageRenderer,
      makeStatusbar() as unknown as StatusBar
    )
    const state = controller as unknown as {
      native: boolean
      nativeBitmap: unknown
      nativeRegion: unknown
      paint: () => void
    }
    // 原生图源切换到新图、区域位图尚未到位:此时不应保留旧像素
    state.native = true
    state.nativeBitmap = null
    state.nativeRegion = null

    state.paint()
    expect(renderer.clear).toHaveBeenCalledTimes(1)
  })
})

describe('结束阅读(§5.2 closeSource)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    delete (globalThis as { window?: unknown }).window
    delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap
    globalThis.fetch = originalFetch
  })

  it('清空页面列表与状态栏,并回抛空列表给侧栏', () => {
    installRaf()
    installWindow()
    const renderer = makeRenderer()
    const statusbar = makeStatusbar()
    const pagesSeen: PageItem[][] = []
    const controller = new ViewerController(
      renderer as unknown as ImageRenderer,
      statusbar as unknown as StatusBar,
      { onPagesChanged: (pages) => pagesSeen.push(pages) }
    )
    const state = controller as unknown as { pages: PageItem[]; currentIndex: number; bitmap: unknown }
    state.pages = [{ path: 'F:\\lib\\1.jpg', name: '1.jpg', width: 100, height: 100, size: 0 }]
    state.currentIndex = 0
    const bitmap = { close: vi.fn() }
    state.bitmap = bitmap

    controller.closeSource()

    expect(controller.pageCount).toBe(0)
    expect(controller.currentPage).toBeNull()
    expect(bitmap.close).toHaveBeenCalledTimes(1)
    expect(statusbar.setPage).toHaveBeenCalledWith(0, 0)
    expect(renderer.clear).toHaveBeenCalled()
    expect(pagesSeen.at(-1)).toEqual([])
  })

  it('结束前冲刷待写入书签(用户靠它回到上次位置)', async () => {
    installRaf()
    const setBookmark = vi.fn().mockResolvedValue({})
    installWindow({ setBookmark })
    const controller = new ViewerController(
      makeRenderer() as unknown as ImageRenderer,
      makeStatusbar() as unknown as StatusBar
    )
    const state = controller as unknown as {
      sourcePath: string
      pages: PageItem[]
      scheduleBookmark: (index: number) => void
    }
    state.sourcePath = 'F:\\lib\\ch1'
    state.pages = [{ path: 'F:\\lib\\ch1\\3.jpg', name: '3.jpg', width: 10, height: 10, size: 0 }]
    state.scheduleBookmark(0)

    controller.closeSource()

    await vi.waitFor(() => expect(setBookmark).toHaveBeenCalledTimes(1))
    expect(setBookmark.mock.calls[0][0]).toMatchObject({
      folderPath: 'F:\\lib\\ch1',
      lastImagePath: 'F:\\lib\\ch1\\3.jpg',
      lastIndex: 0,
      pageCount: 1
    })
  })

  it('结束后翻页不会重新加载旧内容(pages 已空)', () => {
    installRaf()
    installWindow()
    const controller = new ViewerController(
      makeRenderer() as unknown as ImageRenderer,
      makeStatusbar() as unknown as StatusBar
    )
    const state = controller as unknown as { pages: PageItem[]; currentIndex: number }
    state.pages = [{ path: 'F:\\lib\\1.jpg', name: '1.jpg', width: 100, height: 100, size: 0 }]
    state.currentIndex = 0

    controller.closeSource()
    controller.nextPage()

    expect(controller.pageCount).toBe(0)
    expect(controller.currentPage).toBeNull()
  })
})
