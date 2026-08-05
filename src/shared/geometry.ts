/**
 * 窗口几何纯函数(FR-8 / §4.4):bounds 校正与多显示器适配。
 * 纯函数、无 Electron 依赖,可单测。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 将窗口 bounds 校正到显示器工作区内,保证窗口可见:
 * - 尺寸超过工作区时收缩到工作区;
 * - 位置钳制,使窗口完整落入工作区(窗口 ≤ 工作区的前提下)。
 */
export function clampBoundsToDisplay(bounds: Rect, workArea: Rect): Rect {
  const width = Math.min(Math.max(1, Math.round(bounds.width)), workArea.width)
  const height = Math.min(Math.max(1, Math.round(bounds.height)), workArea.height)
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width)
  const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height)
  return { x, y, width, height }
}

/** 居中放置指定尺寸的窗口到工作区(首次启动默认位置,§4.4) */
export function centerInWorkArea(width: number, height: number, workArea: Rect): Rect {
  const w = Math.min(Math.max(1, Math.round(width)), workArea.width)
  const h = Math.min(Math.max(1, Math.round(height)), workArea.height)
  return {
    x: workArea.x + Math.round((workArea.width - w) / 2),
    y: workArea.y + Math.round((workArea.height - h) / 2),
    width: w,
    height: h
  }
}
