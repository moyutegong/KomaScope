import { describe, expect, it } from 'vitest'
import {
  TILE_SIZE,
  sortTilesByViewportDistance,
  tileGridSize,
  tileOrigin,
  visibleTileRange
} from '../src/shared/tile-grid'
import type { ViewTransform } from '../src/shared/transform-model'

const viewport = { width: 1920, height: 1080 }

/** 视口左上角对准图片 (sx, sy),scale 下可见范围 */
function transformAt(sx: number, sy: number, scale: number): ViewTransform {
  return { scale, tx: -sx * scale, ty: -sy * scale }
}

describe('tileGridSize', () => {
  it('按 2048 向上取整', () => {
    expect(tileGridSize({ width: 2048, height: 2048 })).toEqual({ columns: 1, rows: 1 })
    expect(tileGridSize({ width: 2049, height: 4096 })).toEqual({ columns: 2, rows: 2 })
    expect(tileGridSize({ width: 8000, height: 12000 })).toEqual({ columns: 4, rows: 6 })
  })

  it('8736×11648 超大图(4K 两倍以上)网格 5×6', () => {
    expect(tileGridSize({ width: 8736, height: 11648 })).toEqual({ columns: 5, rows: 6 })
  })
})

describe('visibleTileRange', () => {
  it('1:1 视口正中:只覆盖中心瓦片', () => {
    const image = { width: 8192, height: 8192 }
    // 视口 1920×1080 落在图片 (3072, 3072) 起:[3072,4992]×[3072,4152]
    const r = visibleTileRange(viewport, image, transformAt(3072, 3072, 1))
    expect(r.x0).toBe(1)
    expect(r.x1).toBe(2)
    expect(r.y0).toBe(1)
    expect(r.y1).toBe(2)
  })

  it('缩小(fitScreen)时覆盖全部瓦片', () => {
    const image = { width: 8000, height: 12000 }
    const r = visibleTileRange(viewport, image, transformAt(0, 0, 0.1))
    expect(r.x0).toBe(0)
    expect(r.x1).toBe(3)
    expect(r.y0).toBe(0)
    expect(r.y1).toBe(5)
  })

  it('视口越出图片边界时钳制到网格内', () => {
    const image = { width: 4096, height: 4096 }
    // 视口中心在图片中心,scale=1,覆盖 1~2 瓦片
    const r = visibleTileRange(viewport, image, transformAt(2048 - 960, 2048 - 540, 1))
    expect(r.x0).toBe(0)
    expect(r.x1).toBe(1)
    expect(r.y0).toBe(0)
    expect(r.y1).toBe(1)
  })

  it('完全在图片外时返回空范围(x0 > x1)', () => {
    const image = { width: 2048, height: 2048 }
    const r = visibleTileRange(viewport, image, transformAt(10000, 10000, 1))
    expect(r.x0).toBeGreaterThan(r.x1)
    expect(r.y0).toBeGreaterThan(r.y1)
  })
})

describe('tileOrigin', () => {
  it('瓦片原点 = 坐标 × TILE_SIZE', () => {
    expect(tileOrigin(0, 0)).toEqual({ x: 0, y: 0 })
    expect(tileOrigin(2, 3)).toEqual({ x: 2 * TILE_SIZE, y: 3 * TILE_SIZE })
  })
})

describe('sortTilesByViewportDistance', () => {
  it('视口中心对准图片中心时,中心瓦片优先', () => {
    // 视口中心在图片 (4096, 4096),scale=1 → 中心瓦片 (1,1) 最优先
    const t = transformAt(4096 - 960, 4096 - 540, 1)
    const tiles = [
      { x: 0, y: 0 },
      { x: 3, y: 3 },
      { x: 1, y: 1 },
      { x: 2, y: 2 }
    ]
    const sorted = sortTilesByViewportDistance(tiles, viewport, t)
    expect(sorted[0]).toEqual({ x: 1, y: 1 })
    // 其余按到中心距离升序(角点最远)
    expect(sorted[3]).toEqual({ x: 3, y: 3 })
  })

  it('scale<1(fitScreen)时视口中心对应瓦片仍最优先', () => {
    // 8000×12000 图,scale=0.1 铺满视口:视口中心 (960,540) 对应图片 (9600,5400)
    // → 该点所在瓦片 (4,2) 应排最前
    const t = transformAt(0, 0, 0.1)
    const tiles = [
      { x: 3, y: 5 },
      { x: 0, y: 0 },
      { x: 4, y: 2 }
    ]
    const sorted = sortTilesByViewportDistance(tiles, viewport, t)
    expect(sorted[0]).toEqual({ x: 4, y: 2 })
  })

  it('单元素与空列表原样返回(不改变输入)', () => {
    const t = transformAt(0, 0, 1)
    const single = [{ x: 1, y: 1 }]
    expect(sortTilesByViewportDistance(single, viewport, t)).toEqual(single)
    expect(sortTilesByViewportDistance([], viewport, t)).toEqual([])
    const input = [
      { x: 2, y: 0 },
      { x: 0, y: 0 }
    ]
    sortTilesByViewportDistance(input, viewport, t)
    expect(input[0]).toEqual({ x: 2, y: 0 })
  })
})
