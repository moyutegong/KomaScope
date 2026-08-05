/**
 * 瓦片网格(§4.4 超大图片瓦片渲染 / §8 可见瓦片枚举):
 * 由视口矩形与变换反算可见瓦片范围。纯函数、可单测。
 */
import type { Size, ViewTransform } from './transform-model'
import { screenToImage } from './transform-model'

/** 瓦片边长(§4.4:离屏 canvas 按 2048×2048 切片) */
export const TILE_SIZE = 2048

/** 瓦片坐标闭区间 [x0..x1] × [y0..y1] */
export interface TileRange {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface GridSize {
  columns: number
  rows: number
}

/** 图片在瓦片网格上的总尺寸(向上取整) */
export function tileGridSize(imageSize: Size): GridSize {
  return {
    columns: Math.max(1, Math.ceil(imageSize.width / TILE_SIZE)),
    rows: Math.max(1, Math.ceil(imageSize.height / TILE_SIZE))
  }
}

/**
 * 视口内可见的瓦片范围(闭区间,已钳制到图片网格内)。
 * 边界瓦片可能只有部分像素可见,由调用方绘制时按实际交点裁剪。
 */
export function visibleTileRange(viewport: Size, imageSize: Size, t: ViewTransform): TileRange {
  const corners = [
    screenToImage(t, { x: 0, y: 0 }),
    screenToImage(t, { x: viewport.width, y: 0 }),
    screenToImage(t, { x: 0, y: viewport.height }),
    screenToImage(t, { x: viewport.width, y: viewport.height })
  ]
  const minX = Math.min(...corners.map((c) => c.x))
  const maxX = Math.max(...corners.map((c) => c.x))
  const minY = Math.min(...corners.map((c) => c.y))
  const maxY = Math.max(...corners.map((c) => c.y))

  const grid = tileGridSize(imageSize)
  const x0 = Math.max(0, Math.floor(minX / TILE_SIZE))
  const x1 = Math.min(grid.columns - 1, Math.max(0, Math.floor(maxX / TILE_SIZE)))
  const y0 = Math.max(0, Math.floor(minY / TILE_SIZE))
  const y1 = Math.min(grid.rows - 1, Math.max(0, Math.floor(maxY / TILE_SIZE)))
  return { x0, y0, x1, y1 }
}

/** 瓦片在图片中的像素原点(左上角,边界瓦片尺寸可能 < TILE_SIZE) */
export function tileOrigin(tileX: number, tileY: number): { x: number; y: number } {
  return { x: tileX * TILE_SIZE, y: tileY * TILE_SIZE }
}
