/**
 * 原生图源视口计算单元测试(§性能/§格式):区域裁剪、目标分辨率、
 * 覆盖率与清晰度重取判定。纯函数,无 DOM / Electron 依赖。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PADDING_RATIO,
  NATIVE_MAX_WIDTH,
  PREVIEW_WIDTH,
  SHARPNESS_THRESHOLD,
  computeNativeView,
  nativeNeedsRefetch
} from '../src/shared/native-view'
import type { Size, ViewTransform } from '../src/shared/transform-model'

const viewport: Size = { width: 1920, height: 1080 }

describe('computeNativeView', () => {
  it('fitScreen 下区域覆盖整图,目标宽按物理像素计算', () => {
    // 12000×9000 图,fitScreen 到 1920×1080 → scale = 0.12
    const imageSize: Size = { width: 12000, height: 9000 }
    const t: ViewTransform = { scale: 0.12, tx: 0, ty: 0 }
    const spec = computeNativeView(viewport, imageSize, t, 1, 0)
    expect(spec).not.toBeNull()
    expect(spec?.region).toEqual({ x: 0, y: 0, width: 12000, height: 9000 })
    // 目标宽 = 12000 × 0.12 × 1 = 1440
    expect(spec?.targetWidth).toBe(1440)
  })

  it('paddingRatio 外扩区域,小范围平移无需重取', () => {
    const imageSize: Size = { width: 20000, height: 20000 }
    // scale=1,视口对准 (10000,10000) 附近
    const t: ViewTransform = { scale: 1, tx: -10000 + 960, ty: -10000 + 540 }
    const core = computeNativeView(viewport, imageSize, t, 1, 0)
    const padded = computeNativeView(viewport, imageSize, t, 1, DEFAULT_PADDING_RATIO)
    expect(core?.region).toEqual({ x: 10000 - 960, y: 10000 - 540, width: 1920, height: 1080 })
    // 外扩 25%:每边 480 / 270
    expect(padded?.region).toEqual({
      x: 10000 - 960 - 480,
      y: 10000 - 540 - 270,
      width: 1920 + 960,
      height: 1080 + 540
    })
  })

  it('区域 clamp 到图片范围内(视口超出图片边界)', () => {
    const imageSize: Size = { width: 1000, height: 1000 }
    // 视口中心在图片右下角外
    const t: ViewTransform = { scale: 1, tx: -900, ty: -900 }
    const spec = computeNativeView(viewport, imageSize, t, 1, 0)
    expect(spec).not.toBeNull()
    const r = spec!.region
    expect(r.x).toBe(900)
    expect(r.y).toBe(900)
    expect(r.x + r.width).toBeLessThanOrEqual(1000)
    expect(r.y + r.height).toBeLessThanOrEqual(1000)
  })

  it('目标宽 clamp 到 NATIVE_MAX_WIDTH(高 dpr 超宽视口)', () => {
    const imageSize: Size = { width: 40000, height: 40000 }
    // 1920 CSS 宽 × dpr 5 = 9600 > 8192,应 clamp
    const t: ViewTransform = { scale: 1, tx: 0, ty: 0 }
    const spec = computeNativeView(viewport, imageSize, t, 5, 0)
    expect(spec?.targetWidth).toBe(NATIVE_MAX_WIDTH)
  })

  it('dpr 计入目标分辨率(高分屏输出物理像素)', () => {
    const imageSize: Size = { width: 8000, height: 6000 }
    const t: ViewTransform = { scale: 0.24, tx: 0, ty: 0 }
    const at1 = computeNativeView(viewport, imageSize, t, 1, 0)
    const at2 = computeNativeView(viewport, imageSize, t, 2, 0)
    expect(at2?.targetWidth).toBe((at1?.targetWidth ?? 0) * 2)
  })

  it('非法输入返回 null(scale 0 / 尺寸 0 / 视口 0)', () => {
    const imageSize: Size = { width: 100, height: 100 }
    expect(computeNativeView(viewport, imageSize, { scale: 0, tx: 0, ty: 0 }, 1, 0)).toBeNull()
    expect(computeNativeView(viewport, { width: 0, height: 0 }, { scale: 1, tx: 0, ty: 0 }, 1, 0)).toBeNull()
    expect(
      computeNativeView({ width: 0, height: 0 }, imageSize, { scale: 1, tx: 0, ty: 0 }, 1, 0)
    ).toBeNull()
  })
})

describe('nativeNeedsRefetch', () => {
  const imageSize: Size = { width: 20000, height: 20000 }
  const t: ViewTransform = { scale: 1, tx: -10000 + 960, ty: -10000 + 540 }
  const core = computeNativeView(viewport, imageSize, t, 1, 0)!

  it('无当前位图时必然重取', () => {
    expect(nativeNeedsRefetch(null, viewport, imageSize, t, 1)).toBe(true)
  })

  it('区域覆盖核心可见区且分辨率足够时不重取', () => {
    const padded = computeNativeView(viewport, imageSize, t, 1, DEFAULT_PADDING_RATIO)!
    const current = { region: padded.region, bitmapWidth: padded.targetWidth }
    expect(nativeNeedsRefetch(current, viewport, imageSize, t, 1)).toBe(false)
  })

  it('平移超出预留边距(未覆盖核心区)时重取', () => {
    const padded = computeNativeView(viewport, imageSize, t, 1, DEFAULT_PADDING_RATIO)!
    // 向右平移 600px(超过 25% 预留 480)
    const moved: ViewTransform = { ...t, tx: t.tx - 600 }
    const current = { region: padded.region, bitmapWidth: padded.targetWidth }
    expect(nativeNeedsRefetch(current, viewport, imageSize, moved, 1)).toBe(true)
  })

  it('放大后分辨率不足(低于清晰度阈值)时重取', () => {
    const padded = computeNativeView(viewport, imageSize, t, 1, DEFAULT_PADDING_RATIO)!
    const zoomed: ViewTransform = { ...t, scale: 2 }
    const current = { region: padded.region, bitmapWidth: padded.targetWidth }
    // 区域未变但需 2× 分辨率 → 重取
    expect(nativeNeedsRefetch(current, viewport, imageSize, zoomed, 1)).toBe(true)
  })

  it('分辨率略低于目标但在阈值内时不重取(避免抖动)', () => {
    const padded = computeNativeView(viewport, imageSize, t, 1, DEFAULT_PADDING_RATIO)!
    const desired = padded.region.width * t.scale * 1
    const current = {
      region: padded.region,
      bitmapWidth: Math.ceil(desired * (SHARPNESS_THRESHOLD + 0.05))
    }
    expect(nativeNeedsRefetch(current, viewport, imageSize, t, 1)).toBe(false)
  })

  it('核心区不可计算时保守不重取', () => {
    const current = { region: core.region, bitmapWidth: core.targetWidth }
    expect(nativeNeedsRefetch(current, viewport, imageSize, { scale: 0, tx: 0, ty: 0 }, 1)).toBe(false)
  })
})

describe('常量', () => {
  it('预览宽度低于原生上限,阈值在 (0,1) 内', () => {
    expect(PREVIEW_WIDTH).toBeLessThan(NATIVE_MAX_WIDTH)
    expect(SHARPNESS_THRESHOLD).toBeGreaterThan(0)
    expect(SHARPNESS_THRESHOLD).toBeLessThan(1)
  })
})
