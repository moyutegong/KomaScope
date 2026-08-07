/**
 * ViewerController 渲染调度与配置持久化行为(§性能):
 * - rAF 合并:高频交互事件(滚轮/拖拽)只产生一次整帧重绘
 * - setConfig 防抖:交互期间合并 IPC 写入,页面卸载时冲刷
 * 通过 mock 全局 window / requestAnimationFrame 在 node 环境验证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ViewerController } from '../src/renderer/viewer/viewer-controller'
import type { ImageRenderer } from '../src/renderer/viewer/image-renderer'
import type { StatusBar } from '../src/renderer/ui/statusbar'

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

/** 注入 window(pagehide 监听 + komascope.setConfig 记录) */
function installWindow(): {
  pagehideHandlers: Array<() => void>
  setConfig: ReturnType<typeof vi.fn>
} {
  const pagehideHandlers: Array<() => void> = []
  const setConfig = vi.fn().mockResolvedValue({})
  ;(globalThis as { window?: unknown }).window = {
    addEventListener: (type: string, handler: () => void) => {
      if (type === 'pagehide') pagehideHandlers.push(handler)
    },
    komascope: { setConfig }
  }
  return { pagehideHandlers, setConfig }
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
  return { setZoom: vi.fn(), setPage: vi.fn(), setImageSize: vi.fn(), setLocked: vi.fn(), refresh: vi.fn() }
}

/** 构造已装载假位图的控制器(跳过 loadPage,直接验证交互渲染路径) */
function makeController(
  renderer: ReturnType<typeof makeRenderer>,
  statusbar: ReturnType<typeof makeStatusbar>
): ViewerController {
  const controller = new ViewerController(
    renderer as unknown as ImageRenderer,
    statusbar as unknown as StatusBar
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
