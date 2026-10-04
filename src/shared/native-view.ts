/**
 * 原生图源视口计算(§性能/§格式):超高清图(超过 GPU 纹理上限约 8192)
 * 与 Chromium 不可解码格式(TIFF/SVG/HEIC/JXL/JP2)由主进程 sharp
 * 按视口区域流式渲染,渲染进程只接收"当前可见区域 + 匹配屏幕的分辨率"。
 *
 * 收益:内存与图片原始尺寸解耦——1 亿像素图与 1000 万像素图占用相同,
 * 彻底突破 8192 纹理上限与整页解码上限(§12)。
 * 纯函数,可单测。
 */
import { screenToImage } from './transform-model'
import type { Size, ViewTransform } from './transform-model'

/** 单次请求目标宽上限(与主进程 image-source.MAX_TARGET_WIDTH 一致) */
export const NATIVE_MAX_WIDTH = 8192

/** 视口外扩比例:外扩后小范围平移无需重新请求(减少 IPC 与解码次数) */
export const DEFAULT_PADDING_RATIO = 0.25

/** 清晰度阈值:位图宽 / 该区域目标物理宽 低于此值时重新请求更高分辨率 */
export const SHARPNESS_THRESHOLD = 0.85

/** 预览分辨率上限(首次加载先出低清预览,再升级到全分辨率) */
export const PREVIEW_WIDTH = 1024

export interface ViewRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface NativeViewSpec {
  /** 图片像素区域(已 clamp 到图片范围内) */
  region: ViewRegion
  /** 目标输出宽(物理像素,clamp 到 NATIVE_MAX_WIDTH) */
  targetWidth: number
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * 计算当前视口对应的图片区域与目标分辨率。
 * paddingRatio 为 0 时得到"核心可见区域"(覆盖率判定用)。
 * 图片尺寸未知(0)或变换非法时返回 null。
 */
export function computeNativeView(
  viewport: Size,
  imageSize: Size,
  t: ViewTransform,
  dpr: number,
  paddingRatio: number = DEFAULT_PADDING_RATIO
): NativeViewSpec | null {
  if (!(t.scale > 0)) return null
  if (imageSize.width <= 0 || imageSize.height <= 0) return null
  if (viewport.width <= 0 || viewport.height <= 0) return null
  const tl = screenToImage(t, { x: 0, y: 0 })
  const br = screenToImage(t, { x: viewport.width, y: viewport.height })
  const vw = br.x - tl.x
  const vh = br.y - tl.y
  if (!(vw > 0) || !(vh > 0)) return null
  const padX = vw * paddingRatio
  const padY = vh * paddingRatio
  const x = clamp(Math.floor(tl.x - padX), 0, imageSize.width)
  const y = clamp(Math.floor(tl.y - padY), 0, imageSize.height)
  const right = clamp(Math.ceil(br.x + padX), 0, imageSize.width)
  const bottom = clamp(Math.ceil(br.y + padY), 0, imageSize.height)
  const width = right - x
  const height = bottom - y
  if (width < 1 || height < 1) return null
  const targetWidth = clamp(Math.round(width * t.scale * dpr), 1, NATIVE_MAX_WIDTH)
  return { region: { x, y, width, height }, targetWidth }
}

/**
 * 是否需要重新请求:
 * ① 覆盖率——当前区域未包含核心可见区域(平移超出预留边距);
 * ② 清晰度——位图宽不足以覆盖该区域的目标物理宽(放大后分辨率不足)。
 * 任一不满足即重新请求。
 */
export function nativeNeedsRefetch(
  current: { region: ViewRegion; bitmapWidth: number } | null,
  viewport: Size,
  imageSize: Size,
  t: ViewTransform,
  dpr: number
): boolean {
  if (!current) return true
  const core = computeNativeView(viewport, imageSize, t, dpr, 0)
  if (!core) return false
  const c = core.region
  const r = current.region
  const covered =
    r.x <= c.x && r.y <= c.y && r.x + r.width >= c.x + c.width && r.y + r.height >= c.y + c.height
  if (!covered) return true
  const desired = clamp(Math.round(r.width * t.scale * dpr), 1, NATIVE_MAX_WIDTH)
  return current.bitmapWidth < desired * SHARPNESS_THRESHOLD
}
