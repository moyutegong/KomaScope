import { describe, expect, it } from 'vitest'
import { centerInWorkArea, clampBoundsToDisplay, intersects } from '../src/shared/geometry'

const workArea = { x: 100, y: 50, width: 1920, height: 1080 }

describe('clampBoundsToDisplay', () => {
  it('完全在区域内时保持不变', () => {
    const b = { x: 200, y: 100, width: 800, height: 600 }
    expect(clampBoundsToDisplay(b, workArea)).toEqual(b)
  })

  it('超出右/下边缘时钳制到区域内', () => {
    const b = { x: 1800, y: 1000, width: 800, height: 600 }
    const r = clampBoundsToDisplay(b, workArea)
    expect(r.x + r.width).toBe(workArea.x + workArea.width)
    expect(r.y + r.height).toBe(workArea.y + workArea.height)
  })

  it('负坐标(显示器被移除)时拉回区域左上角', () => {
    const r = clampBoundsToDisplay({ x: -500, y: -300, width: 800, height: 600 }, workArea)
    expect(r.x).toBe(workArea.x)
    expect(r.y).toBe(workArea.y)
  })

  it('尺寸超过工作区时收缩', () => {
    const r = clampBoundsToDisplay({ x: 0, y: 0, width: 4000, height: 3000 }, workArea)
    expect(r.width).toBe(1920)
    expect(r.height).toBe(1080)
  })
})

describe('centerInWorkArea', () => {
  it('居中放置', () => {
    const r = centerInWorkArea(960, 540, workArea)
    expect(r.x).toBe(100 + (1920 - 960) / 2)
    expect(r.y).toBe(50 + (1080 - 540) / 2)
  })

  it('超过工作区时收缩', () => {
    const r = centerInWorkArea(4000, 3000, workArea)
    expect(r).toEqual({ x: 100, y: 50, width: 1920, height: 1080 })
  })
})

describe('intersects', () => {
  it('相交/不相交判断', () => {
    expect(intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(true)
    expect(intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 10, height: 10 })).toBe(false)
  })
})
