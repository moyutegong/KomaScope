/**
 * 阅读器状态机(§4.1 ViewerController):页面列表、当前页、变换、锁定、解码加载。
 * M4 范围:瓦片/整页双模式(§4.4 超大图)、相邻页预解码 + LRU(NFR-2/NFR-4)。
 * M3 范围:平移、锚点缩放、适配模式切换、缩放锁定(FR-7)、配置恢复。
 */
import type { AppConfig, FitMode, PageItem } from '../../shared/types'
import {
  applyFit,
  centerTransform,
  identityTransform,
  translate,
  zoomAt,
  zoomToScale
} from '../../shared/transform-model'
import type { Point, Size, ViewTransform } from '../../shared/transform-model'
import { TileCache } from '../../shared/tile-cache'
import { TILE_SIZE, tileOrigin } from '../../shared/tile-grid'
import { t } from '../i18n'
import type { ImageRenderer } from './image-renderer'
import type { StatusBar } from '../ui/statusbar'

/** GPU 纹理上限阈值(§4.4:约 8192px),超过启用瓦片渲染 */
const TILED_THRESHOLD = 8192

export interface ViewerCallbacks {
  onFolderChanged?: (folderPath: string) => void
}

export class ViewerController {
  private pages: PageItem[] = []
  private currentIndex = -1
  private bitmap: ImageBitmap | null = null
  /** 瓦片模式下的整页字节(不整页解码,按需切瓦片) */
  private pageBlob: Blob | null = null
  private tiled = false
  private transform: ViewTransform = identityTransform()
  private imageSize: Size = { width: 0, height: 0 }
  private fitMode: FitMode = 'fitScreen'
  /** 缩放锁定(FR-7 语义 ②):true 时拒绝缩放写入,仅平移 */
  private locked = false
  /** 双击切换:fitScreen ↔ 上一次自定义缩放(§5) */
  private lastCustomScale: number | null = null
  /** 递增序号:翻页请求竞态时丢弃过期解码结果 */
  private loadSeq = 0
  /** 瓦片缓存(NFR-4:LRU 8 页) */
  private readonly tileCache = new TileCache<ImageBitmap>(8)
  private decodeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly renderer: ImageRenderer,
    private readonly statusbar: StatusBar,
    private readonly callbacks: ViewerCallbacks = {}
  ) {}

  get pageCount(): number {
    return this.pages.length
  }

  get isLocked(): boolean {
    return this.locked
  }

  /** 恢复上次会话配置(FR-9):适配模式 / 缩放锁定 */
  restoreConfig(config: AppConfig): void {
    this.fitMode = config.fitMode
    if (config.fitMode === 'custom' && config.scale > 0) {
      this.lastCustomScale = config.scale
    }
    this.setLocked(config.scaleLocked, false)
  }

  /** 打开文件夹(FR-1):扫描 → 定位到第 0 页 */
  async openFolder(folderPath: string): Promise<void> {
    const result = await window.komascope.scanFolder(folderPath)
    this.setPages(result.pages)
    this.callbacks.onFolderChanged?.(folderPath)
    void window.komascope.setConfig({ lastFolder: folderPath })
  }

  /** 打开单张图片(拖拽/后续扩展) */
  openFile(path: string): Promise<void> {
    return this.openFiles([path])
  }

  /** 打开一组图片文件(拖拽多个文件,按调用方传入顺序;FR-2) */
  async openFiles(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    const pages = await Promise.all(
      paths.map(async (path): Promise<PageItem> => {
        const meta = await window.komascope.readMeta(path)
        const name = path.split(/[\\/]/).pop() ?? path
        return { path, name, width: meta.width, height: meta.height, size: 0 }
      })
    )
    this.setPages(pages)
  }

  nextPage(): void {
    void this.loadPage(this.currentIndex + 1)
  }

  prevPage(): void {
    void this.loadPage(this.currentIndex - 1)
  }

  // --- 变换交互(FR-4/5/7) ---

  /** 缩放锁定切换(L / 状态栏图标同步,FR-7 ②) */
  setLocked(locked: boolean, persist = true): void {
    this.locked = locked
    this.statusbar.setLocked(locked)
    if (persist) void window.komascope.setConfig({ scaleLocked: locked })
  }

  /** 锚点缩放(滚轮/+/−):锁定状态下拒绝写入(FR-7 ②) */
  zoomAt(anchor: Point, factor: number): void {
    if (this.locked || (!this.bitmap && !this.tiled) || factor <= 0) return
    if (this.fitMode !== 'custom') {
      this.fitMode = 'custom'
      this.lastCustomScale = this.transform.scale
    }
    this.transform = zoomAt(this.transform, anchor, factor)
    this.afterTransformChange()
  }

  /** 平移(拖拽):锁定不影响平移 */
  translateBy(dx: number, dy: number): void {
    if (!this.bitmap && !this.tiled) return
    this.transform = translate(this.transform, dx, dy)
    this.render()
  }

  /** 切换适配模式(0/1/W/H 快捷键):custom 恢复上次自定义缩放 */
  setFitMode(mode: FitMode): void {
    if (mode === 'custom') {
      const scale = this.lastCustomScale ?? 1
      if (this.bitmap || this.tiled) {
        const center: Point = {
          x: this.renderer.viewportSize.width / 2,
          y: this.renderer.viewportSize.height / 2
        }
        this.transform = zoomToScale(this.transform, scale, center)
      }
    }
    this.applyFit(mode)
  }

  /** 双击:fitScreen ↔ 上一次自定义缩放(§5) */
  toggleFitScreenCustom(): void {
    this.setFitMode(this.fitMode === 'fitScreen' ? 'custom' : 'fitScreen')
  }

  /** 重置视图:居中 + fitScreen(R 快捷键) */
  resetView(): void {
    this.applyFit('fitScreen')
  }

  /** 应用适配模式并重绘(翻页后 / 窗口 resize 时自动调用) */
  applyFit(mode: FitMode = this.fitMode): void {
    this.fitMode = mode
    if ((!this.bitmap && !this.tiled) || this.imageSize.width <= 0 || this.imageSize.height <= 0) return
    if (mode === 'custom') {
      // custom:保留当前倍率,仅重新居中(翻页后保留缩放,FR-6)
      this.transform = centerTransform(this.transform.scale, this.renderer.viewportSize, this.imageSize)
    } else {
      this.transform = applyFit(
        mode,
        this.renderer.viewportSize,
        this.imageSize,
        this.renderer.devicePixelRatio
      )
    }
    this.statusbar.setZoom(this.transform.scale)
    this.render()
  }

  /** 视口尺寸变化(窗口 resize / 全屏切换):按适配模式重算 */
  onViewportResize(): void {
    if (this.bitmap || this.tiled) this.applyFit()
  }

  /** 变换变更后统一收尾:状态栏同步 + 持久化 + 重绘 */
  private afterTransformChange(): void {
    this.statusbar.setZoom(this.transform.scale)
    void window.komascope.setConfig({ fitMode: this.fitMode, scale: this.transform.scale })
    this.render()
  }

  private setPages(pages: PageItem[]): void {
    this.pages = pages
    this.currentIndex = -1
    this.statusbar.setPage(0, pages.length)
    if (pages.length > 0) {
      void this.loadPage(0)
    } else {
      this.showEmpty()
    }
  }

  private get currentPagePath(): string | null {
    return this.currentIndex >= 0 ? (this.pages[this.currentIndex]?.path ?? null) : null
  }

  private async loadPage(index: number): Promise<void> {
    if (index < 0 || index >= this.pages.length) return
    const seq = ++this.loadSeq
    this.currentIndex = index
    const page = this.pages[index]
    this.statusbar.setPage(index, this.pages.length)
    this.statusbar.setImageSize(page.width, page.height)
    try {
      // 流式读取:自定义协议 komascope-file → fetch → 增量解码(4.2)
      const res = await fetch(window.komascope.fileUrl(page.path))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      if (seq !== this.loadSeq) return

      // 瓦片模式:元数据已知且超阈值 → 不整页解码,按需切瓦片
      if (page.width > TILED_THRESHOLD || page.height > TILED_THRESHOLD) {
        this.enterTiledMode(blob, { width: page.width, height: page.height })
        return
      }
      const bitmap = await createImageBitmap(blob)
      if (seq !== this.loadSeq) {
        bitmap.close()
        return
      }
      // 元数据未知(如 AVIF)但实际超阈值 → 降级为瓦片模式
      if (bitmap.width > TILED_THRESHOLD || bitmap.height > TILED_THRESHOLD) {
        bitmap.close()
        this.enterTiledMode(blob, { width: bitmap.width, height: bitmap.height })
        return
      }
      this.tiled = false
      this.pageBlob = null
      this.bitmap?.close()
      this.bitmap = bitmap
      this.imageSize = { width: bitmap.width, height: bitmap.height }
      this.statusbar.setImageSize(bitmap.width, bitmap.height)
      this.renderer.setVisible(true)
      if (this.fitMode === 'custom' && this.lastCustomScale !== null) {
        this.setFitMode('custom')
      } else {
        this.applyFit()
      }
      // 预解码相邻页(NFR-2:当前页 + 后一页,向前翻时加前一页)
      this.predecode(index + 1)
      if (this.pages[index + 1] === undefined && index > 0) this.predecode(index - 1)
    } catch (err) {
      console.error(t('error.loadPage'), page.path, err)
      this.showEmpty()
    }
  }

  /** 进入瓦片模式(§4.4):保留 blob,按需解码可见瓦片 */
  private enterTiledMode(blob: Blob, imageSize: Size): void {
    this.tiled = true
    this.pageBlob = blob
    this.bitmap?.close()
    this.bitmap = null
    this.imageSize = imageSize
    this.statusbar.setImageSize(imageSize.width, imageSize.height)
    this.renderer.setVisible(true)
    this.applyFit()
  }

  /**
   * 预解码相邻页整页并存入 LRU(NFR-2 ≤200ms;NFR-4 上限 8 页)。
   * 串行执行,避免瞬间并发解码过多(§12 解码并发上限)。
   */
  private predecode(index: number): void {
    if (index < 0 || index >= this.pages.length) return
    const page = this.pages[index]
    if (this.tileCache.hasPage(page.path)) return
    this.decodeQueue = this.decodeQueue.then(async () => {
      try {
        const res = await fetch(window.komascope.fileUrl(page.path))
        if (!res.ok) return
        const blob = await res.blob()
        const bitmap = await createImageBitmap(blob)
        this.tileCache.setPage(page.path, bitmap)
      } catch {
        // 预解码失败静默(下次翻页时再解码)
      }
    })
    void this.decodeQueue
  }

  /** 瓦片解码(经 LRU 缓存) */
  private async decodeTile(tileX: number, tileY: number): Promise<ImageBitmap | null> {
    const page = this.pages[this.currentIndex]
    if (!page || !this.pageBlob) return null
    const origin = tileOrigin(tileX, tileY)
    const tileW = Math.min(TILE_SIZE, this.imageSize.width - origin.x)
    const tileH = Math.min(TILE_SIZE, this.imageSize.height - origin.y)
    if (tileW <= 0 || tileH <= 0) return null
    const bitmap = await createImageBitmap(this.pageBlob, origin.x, origin.y, tileW, tileH)
    this.tileCache.set(page.path, tileX, tileY, bitmap)
    return bitmap
  }

  private render(): void {
    const pagePath = this.currentPagePath
    if (this.tiled && this.pageBlob && pagePath) {
      this.renderer.renderTiled(this.transform, this.imageSize, {
        getTile: (tx, ty) => this.tileCache.get(pagePath, tx, ty),
        decodeTile: (tx, ty) => this.decodeTile(tx, ty)
      }, () => this.currentPagePath !== pagePath)
    } else if (this.bitmap) {
      this.renderer.render(this.transform, this.bitmap)
    }
  }

  private showEmpty(): void {
    this.renderer.clear()
    this.renderer.setVisible(false)
  }
}
