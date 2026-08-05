import { describe, expect, it } from 'vitest'
import {
  MAX_SCALE,
  MIN_SCALE,
  applyFit,
  centerTransform,
  clampScale,
  fitScale,
  identityTransform,
  imageToScreen,
  screenToImage,
  translate,
  zoomAt,
  zoomByCenter,
  zoomToScale
} from '../src/shared/transform-model'

const viewport = { width: 1920, height: 1080 }
const image = { width: 3428, height: 4820 }

describe('clampScale', () => {
  it('钳制到 [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(0.001)).toBe(MIN_SCALE)
    expect(clampScale(100)).toBe(MAX_SCALE)
    expect(clampScale(1.5)).toBe(1.5)
  })
})

describe('fitScale', () => {
  it('fitWidth = viewportW / imgW', () => {
    expect(fitScale('fitWidth', viewport, image)).toBeCloseTo(1920 / 3428)
  })

  it('fitHeight = viewportH / imgH', () => {
    expect(fitScale('fitHeight', viewport, image)).toBeCloseTo(1080 / 4820)
  })

  it('fitScreen = min(fitWidth, fitHeight)', () => {
    const fw = 1920 / 3428
    const fh = 1080 / 4820
    expect(fitScale('fitScreen', viewport, image)).toBeCloseTo(Math.min(fw, fh))
  })

  it('actual = 1 / dpr(CSS 像素坐标系下物理 1:1)', () => {
    expect(fitScale('actual', viewport, image, 1.5)).toBeCloseTo(1 / 1.5)
    expect(fitScale('actual', viewport, image, 1)).toBe(1)
  })
})

describe('applyFit / centerTransform', () => {
  it('居中:tx = (vw - iw*scale)/2, ty = (vh - ih*scale)/2', () => {
    const t = applyFit('fitScreen', viewport, image)
    const s = fitScale('fitScreen', viewport, image)
    expect(t.scale).toBeCloseTo(s)
    expect(t.tx).toBeCloseTo((viewport.width - image.width * s) / 2)
    expect(t.ty).toBeCloseTo((viewport.height - image.height * s) / 2)
  })

  it('centerTransform 与 applyFit 一致', () => {
    const s = 0.5
    expect(centerTransform(s, viewport, image)).toEqual({
      scale: s,
      tx: (viewport.width - image.width * s) / 2,
      ty: (viewport.height - image.height * s) / 2
    })
  })
})

describe('zoomAt 锚点缩放(§4.3 公式)', () => {
  const base = applyFit('fitScreen', viewport, image)

  it('scale 按 factor 放大并钳制', () => {
    const t = zoomAt(base, { x: 100, y: 100 }, 2)
    expect(t.scale).toBeCloseTo(clampScale(base.scale * 2))
  })

  it('不动点性质:缩放前后锚点的图片坐标不变', () => {
    const anchor = { x: 777, y: 333 }
    const before = screenToImage(base, anchor)
    for (const factor of [0.1, 0.5, 1.7, 5]) {
      const after = screenToImage(zoomAt(base, anchor, factor), anchor)
      expect(after.x).toBeCloseTo(before.x, 6)
      expect(after.y).toBeCloseTo(before.y, 6)
    }
  })

  it('超出上限时 scale 被钳制到 MAX_SCALE', () => {
    const t = zoomAt(base, { x: 0, y: 0 }, 1e9)
    expect(t.scale).toBe(MAX_SCALE)
  })

  it('超出下限时 scale 被钳制到 MIN_SCALE', () => {
    const t = zoomAt(base, { x: 0, y: 0 }, 1e-9)
    expect(t.scale).toBe(MIN_SCALE)
  })

  it('zoomToScale 直接设置目标倍率', () => {
    const t = zoomToScale(base, 1.25, { x: 500, y: 500 })
    expect(t.scale).toBe(1.25)
  })

  it('非法 factor / scale 直接返回原变换', () => {
    expect(zoomAt(base, { x: 0, y: 0 }, 0)).toBe(base)
    expect(zoomAt({ scale: 0, tx: 0, ty: 0 }, { x: 0, y: 0 }, 2)).toEqual({
      scale: 0,
      tx: 0,
      ty: 0
    })
  })
})

describe('zoomByCenter 快捷键缩放', () => {
  it('锚点为视口中心', () => {
    const base = applyFit('fitScreen', viewport, image)
    const t = zoomByCenter(base, viewport, 1.5)
    const center = { x: viewport.width / 2, y: viewport.height / 2 }
    const before = screenToImage(base, center)
    const after = screenToImage(t, center)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })
})

describe('translate / 坐标互逆', () => {
  it('translate 只改变平移分量', () => {
    const t = translate(identityTransform(), 10, -20)
    expect(t).toEqual({ scale: 1, tx: 10, ty: -20 })
  })

  it('imageToScreen 与 screenToImage 互逆', () => {
    const t = { scale: 1.7, tx: 123, ty: -45 }
    const p = { x: 3428, y: 4820 }
    const round = screenToImage(t, imageToScreen(t, p))
    expect(round.x).toBeCloseTo(p.x, 6)
    expect(round.y).toBeCloseTo(p.y, 6)
  })
})
