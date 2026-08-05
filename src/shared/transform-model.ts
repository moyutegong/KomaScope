/**
 * 变换模型(§4.3 核心):单一缩放系数 scale + 平移 (tx, ty)。
 * 纯函数、无副作用、无 DOM 依赖,可单测。
 *
 * 坐标系:视口坐标系(窗口内容区 CSS 像素,原点左上);
 * 变换公式:screen = scale * image + translate。
 *
 * 等比锁定:模型只存在一个 scale,宽高永远同比例变化(FR-7 语义 ①)。
 * 缩放锁定:由上层状态机在 locked=true 时拒绝调用缩放函数(FR-7 语义 ②)。
 */

import type { FitMode } from './types'

/** 缩放范围(§4.3):4K 屏下覆盖 100px 缩略图到 8000px 长条图 */
export const MIN_SCALE = 0.05
export const MAX_SCALE = 8.0

export interface ViewTransform {
  scale: number
  tx: number
  ty: number
}

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** 非 custom 的适配模式(fitScale 对 custom 无定义) */
export type FitScaleMode = Exclude<FitMode, 'custom'>

/** 将 scale 钳制到 [MIN_SCALE, MAX_SCALE] */
export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** 恒等变换(scale=1, 原点对齐) */
export function identityTransform(): ViewTransform {
  return { scale: 1, tx: 0, ty: 0 }
}

/**
 * 适配模式计算(§4.3):
 * - fitWidth   : scale = viewportW / imgW
 * - fitHeight  : scale = viewportH / imgH
 * - fitScreen  : scale = min(fitWidth, fitHeight)
 * - actual     : scale = 1 / dpr(物理像素 1:1,CSS 像素坐标系下需除以 dpr)
 */
export function fitScale(mode: FitScaleMode, viewport: Size, image: Size, dpr = 1): number {
  switch (mode) {
    case 'fitWidth':
      return viewport.width / image.width
    case 'fitHeight':
      return viewport.height / image.height
    case 'fitScreen':
      return Math.min(viewport.width / image.width, viewport.height / image.height)
    case 'actual':
      return 1 / dpr
  }
}

/**
 * 锚点缩放(§4.3 公式):以锚点 p 为不动点。
 * scale' = clamp(scale * factor);tx' = p.x - (p.x - tx) * (scale'/scale)
 * 缩放后锚点对应的图片坐标保持不变(不动点性质)。
 */
export function zoomAt(t: ViewTransform, anchor: Point, factor: number): ViewTransform {
  if (t.scale <= 0 || factor <= 0) return t
  return zoomToScale(t, t.scale * factor, anchor)
}

/** 缩放到指定倍率(自动钳制),仍以锚点为不动点 */
export function zoomToScale(t: ViewTransform, targetScale: number, anchor: Point): ViewTransform {
  if (t.scale <= 0) return t
  const nextScale = clampScale(targetScale)
  const ratio = nextScale / t.scale
  return {
    scale: nextScale,
    tx: anchor.x - (anchor.x - t.tx) * ratio,
    ty: anchor.y - (anchor.y - t.ty) * ratio
  }
}

/** 以视口中心为锚点缩放(快捷键 + / - 使用,§5) */
export function zoomByCenter(t: ViewTransform, viewport: Size, factor: number): ViewTransform {
  return zoomAt(t, { x: viewport.width / 2, y: viewport.height / 2 }, factor)
}

/** 平移(dx, dy 为视口像素增量) */
export function translate(t: ViewTransform, dx: number, dy: number): ViewTransform {
  return { scale: t.scale, tx: t.tx + dx, ty: t.ty + dy }
}

/** 按给定 scale 居中图片(适配模式应用后调用) */
export function centerTransform(scale: number, viewport: Size, image: Size): ViewTransform {
  return {
    scale,
    tx: (viewport.width - image.width * scale) / 2,
    ty: (viewport.height - image.height * scale) / 2
  }
}

/** 应用适配模式并居中(翻页 / 窗口 resize 后调用) */
export function applyFit(
  mode: FitScaleMode,
  viewport: Size,
  image: Size,
  dpr = 1
): ViewTransform {
  return centerTransform(fitScale(mode, viewport, image, dpr), viewport, image)
}

/** 图片坐标 → 视口坐标 */
export function imageToScreen(t: ViewTransform, p: Point): Point {
  return { x: t.scale * p.x + t.tx, y: t.scale * p.y + t.ty }
}

/** 视口坐标 → 图片坐标(命中检测、光标锚点反算) */
export function screenToImage(t: ViewTransform, p: Point): Point {
  return { x: (p.x - t.tx) / t.scale, y: (p.y - t.ty) / t.scale }
}
