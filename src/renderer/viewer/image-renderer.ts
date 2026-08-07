/**
 * Canvas 绘制器(§4.1 ImageRenderer / §4.4 HiDPI):
 * 物理分辨率 = CSS 尺寸 × devicePixelRatio;按 ViewTransform 绘制 ImageBitmap。
 * 超大图(§4.4 超过 GPU 纹理上限约 8192px)启用瓦片渲染:
 * 仅绘制视口可见瓦片,缺失瓦片异步解码后重绘。
 */
import { imageToScreen } from '../../shared/transform-model'
import type { Size, ViewTransform } from '../../shared/transform-model'
import { TILE_SIZE, tileOrigin, visibleTileRange } from '../../shared/tile-grid'
import { mapWithConcurrency } from '../../shared/concurrency'

/** 瓦片解码并发上限:过高会瞬间吃满 CPU/内存,过低首屏变慢(§12) */
const TILE_DECODE_CONCURRENCY = 4

/** 瓦片提供者:由 ViewerController 实现(数据源 + TileCache) */
export interface TileProvider {
  /** 返回已解码瓦片;null 表示已知解码失败(跳过,不再请求);undefined 表示未解码 */
  getTile(tileX: number, tileY: number): ImageBitmap | undefined | null
  decodeTile(tileX: number, tileY: number): Promise<ImageBitmap | null>
  /** 移除缓存瓦片(解码结果被丢弃时同步清理;带位图身份校验,
   * 避免误删并发写入的新缓存) */
  removeTile?(tileX: number, tileY: number, bitmap: ImageBitmap): void
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

  /**
   * 按变换绘制整页位图(等比锁定由单一 scale 保证,FR-7 语义 ①)。
   * opts.rotation(90° 步进)与 flipH/flipV(镜像)围绕图片中心应用(§13 P2)。
   */
  render(
    t: ViewTransform,
    bitmap: ImageBitmap,
    opts: { rotation?: number; flipH?: boolean; flipV?: boolean } = {}
  ): void {
    const { ctx, canvas, dpr } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    const rotation = opts.rotation ?? 0
    if (rotation === 0 && !opts.flipH && !opts.flipV) {
      ctx.drawImage(bitmap, t.tx, t.ty, bitmap.width * t.scale, bitmap.height * t.scale)
      return
    }
    // 围绕图片中心旋转/镜像
    ctx.save()
    const cx = t.tx + (bitmap.width * t.scale) / 2
    const cy = t.ty + (bitmap.height * t.scale) / 2
    ctx.translate(cx, cy)
    ctx.rotate((rotation * Math.PI) / 180)
    ctx.scale(opts.flipH ? -1 : 1, opts.flipV ? -1 : 1)
    ctx.translate(-cx, -cy)
    ctx.drawImage(bitmap, t.tx, t.ty, bitmap.width * t.scale, bitmap.height * t.scale)
    ctx.restore()
  }

  /**
   * 双页跨页绘制(§13 P1):左右两页并排,顶部对齐,同一 scale 等比缩放。
   * left 为当前左页;right 为 null 时(末页单页)只绘制左页。
   */
  renderSpread(t: ViewTransform, left: ImageBitmap, right: ImageBitmap | null, gap: number): void {
    const { ctx, canvas, dpr } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(left, t.tx, t.ty, left.width * t.scale, left.height * t.scale)
    if (right) {
      const rightX = t.tx + (left.width + gap) * t.scale
      ctx.drawImage(right, rightX, t.ty, right.width * t.scale, right.height * t.scale)
    }
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
    // 缩小(<0.75)用 bilinear:bicubic(high)缩小开销大且视觉差异小,
    // 瓦片模式下每帧绘制十余块缩小瓦片,是超大图卡顿的重要来源
    ctx.imageSmoothingQuality = t.scale >= 0.75 ? 'high' : 'medium'

    const range = visibleTileRange(this.viewportSize, imageSize, t)
    if (range.x0 > range.x1 || range.y0 > range.y1) return
    const missing: { x: number; y: number }[] = []
    for (let ty = range.y0; ty <= range.y1; ty++) {
      for (let tx = range.x0; tx <= range.x1; tx++) {
        const bitmap = provider.getTile(tx, ty)
        if (bitmap) {
          this.drawTile(t, imageSize, tx, ty, bitmap)
        } else if (bitmap === null) {
          // 已知解码失败:跳过,避免每次重绘都重新请求导致 CPU 自旋
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

  /** 绘制单个瓦片到屏幕(按瓦片在图片中的原点与变换换算)。
   * 目标矩形向相邻瓦片方向扩展 1 CSS px:瓦片边界浮点坐标取整后
   * 会出现 1px 缝隙,深色背景下表现为"黑线分割";扩展后相邻瓦片
   * 重叠,缝隙由边缘像素插值覆盖,视觉无缝。图片边界瓦片不扩展,
   * 避免把边缘像素画到图片外形成色带。 */
  private drawTile(t: ViewTransform, imageSize: Size, tileX: number, tileY: number, bitmap: ImageBitmap): void {
    const origin = tileOrigin(tileX, tileY)
    const screen = imageToScreen(t, origin)
    const tileW = Math.min(TILE_SIZE, imageSize.width - origin.x)
    const tileH = Math.min(TILE_SIZE, imageSize.height - origin.y)
    const padX = origin.x + tileW < imageSize.width ? 1 : 0
    const padY = origin.y + tileH < imageSize.height ? 1 : 0
    this.ctx.drawImage(
      bitmap,
      0,
      0,
      tileW,
      tileH,
      screen.x - padX,
      screen.y - padY,
      tileW * t.scale + padX * 2,
      tileH * t.scale + padY * 2
    )
  }

  private async decodeMissingTiles(
    t: ViewTransform,
    imageSize: Size,
    provider: TileProvider,
    missing: { x: number; y: number }[],
    isStale: () => boolean
  ): Promise<void> {
    let results: { x: number; y: number; bmp: ImageBitmap | null }[]
    try {
      results = await mapWithConcurrency(missing, TILE_DECODE_CONCURRENCY, async (m) => ({
        x: m.x,
        y: m.y,
        bmp: await provider.decodeTile(m.x, m.y)
      }))
    } catch {
      // 单瓦片解码失败不中断整批(错误隔离,§12);缺失瓦片下次交互再解码
      return
    }
    if (isStale()) {
      for (const r of results) {
        if (r.bmp) {
          // 先从缓存移除再 close:避免 closed 位图残留,翻回旧页时
          // getTile 命中 closed bitmap 导致 drawImage 抛错。
          // removeTile 带位图身份校验:旧批次完成时若同 key 已有
          // 新缓存(翻回旧页后重新解码),不误删。
          provider.removeTile?.(r.x, r.y, r.bmp)
          r.bmp.close()
        }
      }
      return
    }
    // 缺失瓦片已入缓存,整帧重绘(简单可靠)
    this.renderTiled(t, imageSize, provider, isStale)
  }
}
