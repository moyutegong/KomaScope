/**
 * Canvas 绘制器(§4.1 ImageRenderer / §4.4 HiDPI):
 * 物理分辨率 = CSS 尺寸 × devicePixelRatio;按 ViewTransform 绘制 ImageBitmap。
 * 超大图(§4.4 超过 GPU 纹理上限约 8192px)启用瓦片渲染:
 * 仅绘制视口可见瓦片,缺失瓦片异步解码后重绘。
 */
import { imageToScreen } from '../../shared/transform-model'
import type { Size, ViewTransform } from '../../shared/transform-model'
import { tileOrigin, visibleTileRange } from '../../shared/tile-grid'

/** 瓦片提供者:由 ViewerController 实现(数据源 + TileCache) */
export interface TileProvider {
  getTile(tileX: number, tileY: number): ImageBitmap | undefined
  decodeTile(tileX: number, tileY: number): Promise<ImageBitmap | null>
}

export class ImageRenderer {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly placeholder: HTMLElement
  private dpr = 1
  private viewportW = 0
  private viewportH = 0

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.placeholder = document.getElementById('placeholder') as HTMLElement
  }

  /** 切换 canvas / 占位提示的显示(打开图片后隐藏 placeholder) */
  setVisible(visible: boolean): void {
    this.canvas.hidden = !visible
    this.placeholder.hidden = visible
  }

  get viewportSize(): Size {
    return { width: this.viewportW, height: this.viewportH }
  }

  get devicePixelRatio(): number {
    return this.dpr
  }

  /** 同步容器尺寸与 DPR,必要时重建物理缓冲(§4.4 高分屏模糊) */
  resize(viewportW: number, viewportH: number, dpr: number): void {
    this.viewportW = viewportW
    this.viewportH = viewportH
    const w = Math.max(1, Math.round(viewportW * dpr))
    const h = Math.max(1, Math.round(viewportH * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h || this.dpr !== dpr) {
      this.canvas.width = w
      this.canvas.height = h
      this.dpr = dpr
    }
  }

  /** 按变换绘制整页位图(等比锁定由单一 scale 保证,FR-7 语义 ①) */
  render(t: ViewTransform, bitmap: ImageBitmap): void {
    const { ctx, canvas, dpr } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, t.tx, t.ty, bitmap.width * t.scale, bitmap.height * t.scale)
  }

  /**
   * 瓦片渲染(§4.4):绘制视口可见瓦片;缺失瓦片异步解码后整帧重绘。
   * isStale:翻页/取消后返回 true 时丢弃异步结果。
   */
  renderTiled(t: ViewTransform, imageSize: Size, provider: TileProvider, isStale: () => boolean): void {
    const { ctx, canvas, dpr } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    const range = visibleTileRange(this.viewportSize, imageSize, t)
    if (range.x0 > range.x1 || range.y0 > range.y1) return
    const missing: { x: number; y: number }[] = []
    for (let ty = range.y0; ty <= range.y1; ty++) {
      for (let tx = range.x0; tx <= range.x1; tx++) {
        const bitmap = provider.getTile(tx, ty)
        if (bitmap) {
          this.drawTile(t, imageSize, tx, ty, bitmap)
        } else {
          missing.push({ x: tx, y: ty })
        }
      }
    }
    if (missing.length > 0 && !isStale()) {
      void this.decodeMissingTiles(t, imageSize, provider, missing, isStale)
    }
  }

  clear(): void {
    const { ctx, canvas } = this
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  /** 绘制单个瓦片到屏幕(按瓦片在图片中的原点与变换换算) */
  private drawTile(t: ViewTransform, imageSize: Size, tileX: number, tileY: number, bitmap: ImageBitmap): void {
    const origin = tileOrigin(tileX, tileY)
    const screen = imageToScreen(t, origin)
    const tileW = Math.min(2048, imageSize.width - origin.x)
    const tileH = Math.min(2048, imageSize.height - origin.y)
    this.ctx.drawImage(bitmap, screen.x, screen.y, tileW * t.scale, tileH * t.scale)
  }

  private async decodeMissingTiles(
    t: ViewTransform,
    imageSize: Size,
    provider: TileProvider,
    missing: { x: number; y: number }[],
    isStale: () => boolean
  ): Promise<void> {
    const results = await Promise.all(
      missing.map(async (m) => ({ x: m.x, y: m.y, bmp: await provider.decodeTile(m.x, m.y) }))
    )
    if (isStale()) {
      for (const r of results) r.bmp?.close()
      return
    }
    // 缺失瓦片已入缓存,整帧重绘(简单可靠)
    this.renderTiled(t, imageSize, provider, isStale)
  }
}
