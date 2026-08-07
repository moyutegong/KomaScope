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
import { mimeFromName } from '../../shared/mime'
import { t } from '../i18n'
import type { ImageRenderer } from './image-renderer'
import type { StatusBar } from '../ui/statusbar'

/** 变换配置 IPC 持久化防抖(§性能):缩放交互高频触发(滚轮可达
 * 100+ 事件/秒),合并为低频 IPC 写入;主进程侧另有 500ms 落盘防抖 */
const PERSIST_DEBOUNCE_MS = 150

/** GPU 纹理上限阈值(§4.4:约 8192px),超过启用瓦片渲染 */
const TILED_THRESHOLD = 8192

/**
 * 非 JPEG 整页解码像素上限(§12 风险应对):超过则拒绝整页解码,
 * 防止恶意超大尺寸头声明(如 60000×60000)导致 GB 级内存 OOM。
 * 8736×11648(≈1.02 亿像素)在限内;JPEG 局部解码路径不受限。
 */
const MAX_FULL_DECODE_PIXELS = 150_000_000

/** 尺寸是否超出整页解码像素上限(§12;0/未知尺寸不触发) */
function exceedsFullDecodeLimit(width: number, height: number): boolean {
  return width > 0 && height > 0 && width * height > MAX_FULL_DECODE_PIXELS
}

/** 双页跨页左右页间距(图片像素,§13 P1) */
const SPREAD_GAP = 16

export interface ViewerCallbacks {
  onFolderChanged?: (folderPath: string) => void
  /** 页面列表/当前页变化(侧栏同步,§侧栏) */
  onPagesChanged?: (pages: PageItem[], currentIndex: number) => void
  /** 最近打开历史变化(侧栏历史同步:拖入/打开新来源后刷新,§侧栏) */
  onRecentChanged?: (recent: string[]) => void
}

export class ViewerController {
  private pages: PageItem[] = []
  private currentIndex = -1
  private bitmap: ImageBitmap | null = null
  /** 瓦片模式下的整页字节(不整页解码,按需切瓦片) */
  private pageBlob: Blob | null = null
  /** 瓦片源策略(§4.4):JPEG 用 Blob 局部解码(Chromium 支持 DCT 部分解码);
   * PNG/WebP 等 createImageBitmap(blob, rect) 每次都会整图解码再裁剪,
   * 超大图每块瓦片全解码一次是性能灾难 → 整页解码一次后从全图裁剪 */
  private fullBitmap: ImageBitmap | null = null
  private fullBitmapPromise: Promise<ImageBitmap | null> | null = null
  /** 代际计数:releaseFullBitmap 时自增,在途解码完成后校验,
   * 同页重载(spread→single 等)时丢弃旧代际结果,避免双全图解码并发 */
  private fullBitmapGen = 0
  private tiledFromFull = false
  private tiled = false
  /** 已知解码失败的瓦片坐标(避免失败后每次重绘都重新解码 → CPU 自旋) */
  private failedTiles = new Set<string>()
  /** 在途瓦片解码 Promise(同坐标去重,避免重复解码覆盖位图不 close) */
  private inFlightTiles = new Map<string, Promise<ImageBitmap | null>>()
  private transform: ViewTransform = identityTransform()
  private imageSize: Size = { width: 0, height: 0 }
  private fitMode: FitMode = 'fitScreen'
  /** 缩放锁定(FR-7 语义 ②):true 时拒绝缩放写入,仅平移 */
  private locked = false
  /** 双击切换:fitScreen ↔ 上一次自定义缩放(§5) */
  private lastCustomScale: number | null = null
  /** 阅读布局(§13 P1 双页跨页):single 单页 / spread 左右并排 */
  private layoutMode: 'single' | 'spread' = 'single'
  /** 双页模式下右页位图 */
  private rightBitmap: ImageBitmap | null = null
  /** 旋转角度(§13 P2):0 | 90 | 180 | 270 */
  private rotation = 0
  /** 镜像(§13 P2) */
  private flipH = false
  private flipV = false
  /** 递增序号:翻页请求竞态时丢弃过期解码结果 */
  private loadSeq = 0
  /** 瓦片缓存(NFR-4:LRU 8 页) */
  private readonly tileCache = new TileCache<ImageBitmap>(8)
  private decodeQueue: Promise<void> = Promise.resolve()
  /** rAF 渲染合并:交互事件(滚轮/拖拽)频率远超屏幕刷新率,
   * 变换立即写入状态,实际重绘合并到下一帧,避免每事件整帧重绘 */
  private renderQueued = false
  /** 变换配置持久化防抖计时器(§性能) */
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly renderer: ImageRenderer,
    private readonly statusbar: StatusBar,
    private readonly callbacks: ViewerCallbacks = {}
  ) {
    // 页面卸载(关窗/退出)前冲刷防抖中的配置,避免最后一次缩放丢失
    window.addEventListener('pagehide', () => this.flushPendingConfig())
  }

  get pageCount(): number {
    return this.pages.length
  }

  get currentPage(): PageItem | null {
    return this.currentIndex >= 0 ? (this.pages[this.currentIndex] ?? null) : null
  }

  /** 侧栏页面列表(§侧栏) */
  get pageList(): PageItem[] {
    return [...this.pages]
  }

  /** 跳到指定页(侧栏点击,§侧栏) */
  gotoPage(index: number): void {
    void this.loadPage(index)
  }

  get isLocked(): boolean {
    return this.locked
  }

  /** 恢复上次会话配置(FR-9):适配模式 / 缩放锁定 / 阅读布局 */
  restoreConfig(config: AppConfig): void {
    this.fitMode = config.fitMode
    if (config.fitMode === 'custom' && config.scale > 0) {
      this.lastCustomScale = config.scale
      // 同步当前倍率:loadPage 的 applyFit('custom') 保留 transform.scale,
      // 不同步则首次打开来源时恢复的缩放被 identity(=1) 覆盖
      this.transform.scale = config.scale
    }
    this.setLocked(config.scaleLocked, false)
    this.layoutMode = config.layoutMode
  }

  /** 旋转/镜像后的显示尺寸(90/270° 交换宽高,§13 P2) */
  private get displaySize(): Size {
    return this.rotation % 180 === 90
      ? { width: this.imageSize.height, height: this.imageSize.width }
      : this.imageSize
  }

  /** 顺时针旋转 90°(§13 P2;瓦片模式不适用,因瓦片按原始方向解码) */
  rotateCw(): void {
    if (this.tiled) return
    this.rotation = (this.rotation + 90) % 360
    this.applyTransformChange()
  }

  /** 水平镜像(§13 P2;瓦片模式不适用) */
  flipHorizontal(): void {
    if (this.tiled) return
    this.flipH = !this.flipH
    this.applyTransformChange()
  }

  /** 垂直镜像(§13 P2;瓦片模式不适用) */
  flipVertical(): void {
    if (this.tiled) return
    this.flipV = !this.flipV
    this.applyTransformChange()
  }

  /** 旋转/镜像变更:双页布局先切回单页,再重算适配并重绘 */
  private applyTransformChange(): void {
    if (this.layoutMode === 'spread') {
      this.layoutMode = 'single'
      void window.komascope.setConfig({ layoutMode: this.layoutMode })
    }
    if (this.bitmap || this.tiled) this.applyFit()
  }

  /** 切换阅读布局(§13 P1 双页跨页) */
  toggleLayoutMode(): void {
    this.layoutMode = this.layoutMode === 'single' ? 'spread' : 'single'
    void window.komascope.setConfig({ layoutMode: this.layoutMode })
    // 重新加载当前页以应用布局
    if (this.bitmap || this.tiled) void this.loadPage(this.currentIndex)
  }

  get isSpread(): boolean {
    return this.layoutMode === 'spread'
  }

  /** 打开文件夹(FR-1):扫描 → 定位到上次阅读页(§13 P1)或第 0 页 */
  async openFolder(folderPath: string): Promise<void> {
    const result = await window.komascope.scanFolder(folderPath)
    const initial = await this.restorePageIndex(folderPath, result.pages.length)
    this.setPages(result.pages, initial)
    this.callbacks.onFolderChanged?.(folderPath)
    await this.pushRecentFolder(folderPath)
    void window.komascope.setConfig({ lastFolder: folderPath })
  }

  /** 打开 zip/cbz 压缩包(§13 P0):扫描条目 → 定位到上次阅读页或第 0 页 */
  async openArchive(archivePath: string): Promise<void> {
    const result = await window.komascope.scanArchive(archivePath)
    const initial = await this.restorePageIndex(archivePath, result.pages.length)
    this.setPages(result.pages, initial)
    this.callbacks.onFolderChanged?.(archivePath)
    await this.pushRecentFolder(archivePath)
    void window.komascope.setConfig({ lastFolder: archivePath })
  }

  /** 记录最近打开来源(侧栏历史,§侧栏):主进程原子去重置顶、上限 10;成功后回调刷新侧栏 */
  private async pushRecentFolder(path: string): Promise<void> {
    try {
      const recent = await window.komascope.addRecentFolder(path)
      this.callbacks.onRecentChanged?.(recent)
    } catch {
      // 历史记录失败不影响打开
    }
  }

  /** 书签恢复(§13 P1):同一来源且 lastPage 有效时从上次页码继续 */
  private async restorePageIndex(sourcePath: string, pageCount: number): Promise<number> {
    if (pageCount <= 0) return 0
    try {
      const config = await window.komascope.getConfig()
      if (config.lastFolder === sourcePath && config.lastPage > 0 && config.lastPage < pageCount) {
        return config.lastPage
      }
    } catch {
      // 配置读取失败时从第 0 页开始
    }
    return 0
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
    // 双页跨页:一次跳过两页(左页 → 原右页的下一页)
    const step = this.layoutMode === 'spread' ? 2 : 1
    void this.loadPage(this.currentIndex + step)
  }

  prevPage(): void {
    const step = this.layoutMode === 'spread' ? 2 : 1
    void this.loadPage(this.currentIndex - step)
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
    }
    this.transform = zoomAt(this.transform, anchor, factor)
    // 始终记录最近一次自定义倍率(双击回到 custom 与翻页继承缩放均以它为准)
    this.lastCustomScale = this.transform.scale
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
      this.transform = centerTransform(this.transform.scale, this.renderer.viewportSize, this.displaySize)
    } else {
      this.transform = applyFit(
        mode,
        this.renderer.viewportSize,
        this.displaySize,
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

  /** 变换变更后统一收尾:状态栏同步 + 持久化(防抖)+ 重绘 */
  private afterTransformChange(): void {
    this.statusbar.setZoom(this.transform.scale)
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void window.komascope.setConfig({ fitMode: this.fitMode, scale: this.transform.scale })
    }, PERSIST_DEBOUNCE_MS)
    this.render()
  }

  /** 冲刷防抖中的配置(页面卸载时调用,保证最后状态不丢) */
  private flushPendingConfig(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
      void window.komascope
        .setConfig({ fitMode: this.fitMode, scale: this.transform.scale })
        .catch(() => {
          // 卸载瞬间 IPC 可能失败,静默(配置下次会话再写)
        })
    }
  }

  private setPages(pages: PageItem[], initialIndex = 0): void {
    this.pages = pages
    this.currentIndex = -1
    this.statusbar.setPage(0, pages.length)
    this.callbacks.onPagesChanged?.(this.pages, 0)
    if (pages.length > 0) {
      void this.loadPage(Math.min(initialIndex, pages.length - 1))
    } else {
      this.showEmpty()
    }
  }

  /**
   * 缓存 key:zip/cbz 来源所有页 path 相同,必须追加 archiveEntry 区分
   * (否则预解码只执行一次、瓦片模式串图,§13 P0 review should-fix)。
   * 用 JSON.stringify 而非 '#' 拼接,避免磁盘路径含 '#' 时与 zip 条目碰撞。
   */
  private pageCacheKey(page: PageItem): string {
    return page.archiveEntry ? JSON.stringify([page.path, page.archiveEntry]) : page.path
  }

  private get currentPagePath(): string | null {
    if (this.currentIndex < 0) return null
    const page = this.pages[this.currentIndex]
    return page ? this.pageCacheKey(page) : null
  }

  private async loadPage(index: number): Promise<void> {
    if (index < 0 || index >= this.pages.length) return
    const seq = ++this.loadSeq
    this.currentIndex = index
    const page = this.pages[index]
    this.statusbar.setPage(index, this.pages.length)
    this.statusbar.setImageSize(page.width, page.height)
    this.callbacks.onPagesChanged?.(this.pages, index)
    // 书签(§13 P1):记录当前页码(防抖落盘由 ConfigStore 处理)
    void window.komascope.setConfig({ lastPage: index })
    try {
      const blob = await this.getPageBlob(page)
      if (seq !== this.loadSeq) return

      // 像素上限(spread 布局,元数据已知):双页整页解码超限会 OOM,
      // 必须在解码前拒绝;单页布局超限由 enterTiledMode 按格式判断
      // (JPEG 局部解码不受限)
      if (this.layoutMode === 'spread' && exceedsFullDecodeLimit(page.width, page.height)) {
        this.rejectOversized(page, null)
        return
      }

      // 双页跨页:同时解码右页(§13 P1);右页失败则退化为单页。
      // 右页元数据已知超限 → 解码前拒绝;元数据未知 → 解码后兜底检查
      let right: ImageBitmap | null = null
      if (this.layoutMode === 'spread' && index + 1 < this.pages.length) {
        const rightPage = this.pages[index + 1]
        if (exceedsFullDecodeLimit(rightPage.width, rightPage.height)) {
          this.rejectOversized(page, null)
          return
        }
        try {
          const blobR = await this.getPageBlob(rightPage)
          right = await createImageBitmap(blobR)
          if (seq !== this.loadSeq) {
            right.close()
            return
          }
        } catch {
          right = null
        }
      }

      // 瓦片模式:仅单页布局且超阈值 → 不整页解码,按需切瓦片
      if (
        this.layoutMode !== 'spread' &&
        (page.width > TILED_THRESHOLD || page.height > TILED_THRESHOLD)
      ) {
        right?.close()
        this.enterTiledMode(blob, { width: page.width, height: page.height })
        return
      }
      const bitmap = await createImageBitmap(blob)
      if (seq !== this.loadSeq) {
        bitmap.close()
        right?.close()
        return
      }
      // 兜底(元数据未知,如 AVIF):左/右页实际尺寸超限 → 拒绝
      if (
        exceedsFullDecodeLimit(bitmap.width, bitmap.height) ||
        (right !== null && exceedsFullDecodeLimit(right.width, right.height))
      ) {
        bitmap.close()
        this.rejectOversized(page, right)
        return
      }
      // 元数据未知但实际超 GPU 阈值 → 降级为瓦片模式(单页布局;
      // spread 无瓦片路径,超限已在上方拒绝,否则保持整页解码)
      if (
        this.layoutMode !== 'spread' &&
        (bitmap.width > TILED_THRESHOLD || bitmap.height > TILED_THRESHOLD)
      ) {
        bitmap.close()
        right?.close()
        this.enterTiledMode(blob, { width: bitmap.width, height: bitmap.height })
        return
      }
      this.tiled = false
      this.pageBlob = null
      this.releaseFullBitmap()
      this.bitmap?.close()
      this.rightBitmap?.close()
      this.bitmap = bitmap
      this.rightBitmap = right
      if (this.layoutMode === 'spread' && right) {
        // 合并尺寸:左宽 + 间距 + 右宽,高度取较大者(状态栏仍显示左页尺寸)
        this.imageSize = {
          width: bitmap.width + SPREAD_GAP + right.width,
          height: Math.max(bitmap.height, right.height)
        }
        this.statusbar.setImageSize(bitmap.width, bitmap.height)
      } else {
        this.imageSize = { width: bitmap.width, height: bitmap.height }
        this.statusbar.setImageSize(bitmap.width, bitmap.height)
      }
      this.renderer.setVisible(true)
      if (this.fitMode === 'custom' && this.lastCustomScale !== null) {
        // 翻页继承缩放(FR-6):custom 分支保留当前倍率,仅重新居中。
        // 不能走 setFitMode('custom')——它会用 lastCustomScale 覆盖当前倍率。
        this.applyFit('custom')
      } else {
        this.applyFit()
      }
      // 预解码相邻页(NFR-2;双页布局跳过已加载的右页)
      const nextIndex = this.layoutMode === 'spread' ? index + 2 : index + 1
      this.predecode(nextIndex)
      if (this.pages[nextIndex] === undefined && index > 0) this.predecode(index - 1)
    } catch (err) {
      console.error(t('error.loadPage'), page.path, err)
      this.showEmpty()
    }
  }

  /**
   * 统一获取页面字节(Blob):
   * - 压缩包源(archiveEntry):IPC 读取单条目字节 → Blob(§13 P0)
   * - 磁盘源:自定义协议 komascope-file → fetch → 流式读取(4.2)
   */
  private async getPageBlob(page: PageItem): Promise<Blob> {
    if (page.archiveEntry) {
      const bytes = await window.komascope.readArchiveEntry(page.path, page.archiveEntry)
      return new Blob([new Uint8Array(bytes)], { type: mimeFromName(page.name) })
    }
    const res = await fetch(window.komascope.fileUrl(page.path))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.blob()
  }

  /** 拒绝超像素上限的图片(§12):与成功路径一致的完整状态清理 */
  private rejectOversized(page: PageItem, right: ImageBitmap | null): void {
    console.error(t('error.loadPage'), page.path, '图片过大,超出整页解码上限')
    right?.close()
    this.tiled = false
    this.pageBlob = null
    this.releaseFullBitmap()
    this.bitmap?.close()
    this.bitmap = null
    this.rightBitmap?.close()
    this.rightBitmap = null
    this.imageSize = { width: 0, height: 0 }
    this.statusbar.setImageSize(0, 0)
    this.showEmpty()
  }

  /** 进入瓦片模式(§4.4):保留 blob,按需解码可见瓦片 */
  private enterTiledMode(blob: Blob, imageSize: Size): void {
    const page = this.pages[this.currentIndex]
    this.tiledFromFull = page ? mimeFromName(page.name) !== 'image/jpeg' : true
    // 非 JPEG 需整页解码一次:超过像素上限直接拒绝,防止恶意尺寸 OOM
    if (this.tiledFromFull && exceedsFullDecodeLimit(imageSize.width, imageSize.height)) {
      this.rejectOversized(page, null)
      return
    }
    this.tiled = true
    this.pageBlob = blob
    this.releaseFullBitmap()
    this.bitmap?.close()
    this.bitmap = null
    this.rightBitmap?.close()
    this.rightBitmap = null
    this.imageSize = imageSize
    this.statusbar.setImageSize(imageSize.width, imageSize.height)
    this.renderer.setVisible(true)
    this.applyFit()
  }

  /** 整页解码一次(非 JPEG 瓦片源);并发请求共享同一 Promise */
  private async ensureFullBitmap(): Promise<ImageBitmap | null> {
    if (this.fullBitmap) return this.fullBitmap
    if (!this.fullBitmapPromise) {
      const blob = this.pageBlob
      const gen = this.fullBitmapGen
      if (!blob) return null
      this.fullBitmapPromise = (async () => {
        try {
          const bmp = await createImageBitmap(blob)
          // 解码期间翻页/换源(pageBlob 更换或代际变化)或已 release:
          // 丢弃,避免旧页位图挂到新上下文(串页/泄漏/双解码并发)
          if (this.pageBlob !== blob || this.fullBitmapGen !== gen) {
            bmp.close()
            return null
          }
          this.fullBitmap = bmp
          return bmp
        } catch {
          // 解码失败:重置在途标记,允许后续重试
          // (否则 promise 永久缓存 null,瓦片模式白屏直到翻页)
          this.fullBitmapPromise = null
          return null
        }
      })()
    }
    return this.fullBitmapPromise
  }

  /** 释放整页位图与在途解码(翻页/换源时调用,避免数百 MB 常驻) */
  private releaseFullBitmap(): void {
    this.fullBitmap?.close()
    this.fullBitmap = null
    this.fullBitmapPromise = null
    this.fullBitmapGen++
    this.failedTiles.clear()
  }

  /**
   * 预解码相邻页整页并存入 LRU(NFR-2 ≤200ms;NFR-4 上限 8 页)。
   * 串行执行,避免瞬间并发解码过多(§12 解码并发上限)。
   * 超大图(瓦片模式)跳过:整页解码数百 MB,翻页时按需解码瓦片。
   */
  private predecode(index: number): void {
    if (index < 0 || index >= this.pages.length) return
    const page = this.pages[index]
    if (page.width > TILED_THRESHOLD || page.height > TILED_THRESHOLD) return
    const key = this.pageCacheKey(page)
    if (this.tileCache.hasPage(key)) return
    this.decodeQueue = this.decodeQueue.then(async () => {
      try {
        const blob = await this.getPageBlob(page)
        const bitmap = await createImageBitmap(blob)
        this.tileCache.setPage(key, bitmap)
      } catch {
        // 预解码失败静默(下次翻页时再解码)
      }
    })
    void this.decodeQueue
  }

  /** 瓦片解码(经 LRU 缓存);同坐标在途解码共享同一 Promise,
   * 避免连续交互对同一瓦片重复解码(后批次覆盖前批次位图且不 close) */
  private async decodeTile(tileX: number, tileY: number): Promise<ImageBitmap | null> {
    const key = `${tileX}:${tileY}`
    const inFlight = this.inFlightTiles.get(key)
    if (inFlight) return inFlight
    const p = this.decodeTileInner(tileX, tileY).finally(() => {
      this.inFlightTiles.delete(key)
    })
    this.inFlightTiles.set(key, p)
    return p
  }

  private async decodeTileInner(tileX: number, tileY: number): Promise<ImageBitmap | null> {
    const page = this.pages[this.currentIndex]
    if (!page || !this.pageBlob) return null
    const seq = this.loadSeq
    const origin = tileOrigin(tileX, tileY)
    const tileW = Math.min(TILE_SIZE, this.imageSize.width - origin.x)
    const tileH = Math.min(TILE_SIZE, this.imageSize.height - origin.y)
    if (tileW <= 0 || tileH <= 0) return null
    try {
      let bitmap: ImageBitmap
      if (this.tiledFromFull) {
        // 从整页位图裁剪:毫秒级内存拷贝,避免每瓦片整图解码
        const full = await this.ensureFullBitmap()
        if (!full) {
          // 整页解码必败(full 为 null):记入黑名单避免每次交互重试
          if (this.loadSeq === seq) this.failedTiles.add(`${tileX}:${tileY}`)
          return null
        }
        // 解码期间翻页会 close fullBitmap,裁剪抛 InvalidStateError → catch 静默
        bitmap = await createImageBitmap(full, origin.x, origin.y, tileW, tileH)
      } else {
        // JPEG:Chromium 支持源矩形部分解码,按瓦片解码内存最优
        bitmap = await createImageBitmap(this.pageBlob, origin.x, origin.y, tileW, tileH)
      }
      this.failedTiles.delete(`${tileX}:${tileY}`)
      this.tileCache.set(this.pageCacheKey(page), tileX, tileY, bitmap)
      return bitmap
    } catch {
      // 解码失败或翻页竞态:仅当仍在本页时记入黑名单,
      // 迟到失败(翻页后 resolve)不得污染新页同坐标瓦片
      if (this.loadSeq === seq) this.failedTiles.add(`${tileX}:${tileY}`)
      return null
    }
  }

  /**
   * 请求重绘(§性能):合并到下一动画帧执行,交互事件高频到达时
   * 只保留最后一次状态,每帧最多一次整帧绘制。
   */
  private render(): void {
    if (this.renderQueued) return
    this.renderQueued = true
    requestAnimationFrame(() => {
      this.renderQueued = false
      this.paint()
    })
  }

  /** 实际绘制(一帧一次;瓦片模式缺块时内部会发起异步解码并请求后续重绘) */
  private paint(): void {
    const pagePath = this.currentPagePath
    if (this.tiled && this.pageBlob && pagePath) {
      this.renderer.renderTiled(this.transform, this.imageSize, {
        getTile: (tx, ty) => {
          const key = `${tx}:${ty}`
          if (this.failedTiles.has(key)) return null
          return this.tileCache.get(pagePath, tx, ty)
        },
        decodeTile: (tx, ty) => this.decodeTile(tx, ty),
        removeTile: (tx, ty, bmp) => {
          this.tileCache.deleteIf(pagePath, tx, ty, bmp)
        },
        // 瓦片解码批次完成:请求一次重绘(瓦片已入缓存,下一帧统一上屏;
        // 若期间无新交互,本次调度确保最后一批瓦片也能显示)
        onTilesReady: () => this.render()
        // isStale 还需覆盖"同页退出瓦片模式"(如 spread↔single 布局切换:
        // pagePath 不变但整页渲染已接管画布,在途批次必须作废清理)
      }, () => this.currentPagePath !== pagePath || !this.tiled)
    } else if (this.layoutMode === 'spread' && this.bitmap && this.rightBitmap) {
      this.renderer.renderSpread(this.transform, this.bitmap, this.rightBitmap, SPREAD_GAP)
    } else if (this.bitmap) {
      this.renderer.render(this.transform, this.bitmap, {
        rotation: this.rotation,
        flipH: this.flipH,
        flipV: this.flipV
      })
    }
  }

  private showEmpty(): void {
    this.releaseFullBitmap()
    this.pageBlob = null
    this.renderer.clear()
    this.renderer.setVisible(false)
  }
}
