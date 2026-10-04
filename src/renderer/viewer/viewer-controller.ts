/**
 * 阅读器状态机(§4.1 ViewerController):页面列表、当前页、变换、锁定、解码加载。
 * M4 范围:瓦片/整页双模式(§4.4 超大图)、相邻页预解码 + LRU(NFR-2/NFR-4)。
 * M3 范围:平移、锚点缩放、适配模式切换、缩放锁定(FR-7)、配置恢复。
 */
import type { AppConfig, BookmarkInput, BookmarkMap, FitMode, PageItem } from '../../shared/types'
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
import { mimeFromName, isNativelyDecodable } from '../../shared/mime'
import {
  PREVIEW_WIDTH,
  computeNativeView,
  nativeNeedsRefetch
} from '../../shared/native-view'
import type { NativeViewSpec } from '../../shared/native-view'
import { t } from '../i18n'
import type { ImageRenderer } from './image-renderer'
import type { StatusBar } from '../ui/statusbar'

/** 变换配置 IPC 持久化防抖(§性能):缩放交互高频触发(滚轮可达
 * 100+ 事件/秒),合并为低频 IPC 写入;主进程侧另有 500ms 落盘防抖 */
const PERSIST_DEBOUNCE_MS = 150

/** 书签写入节流(§观看历史):连续翻页 500ms 内只写一次 IPC,卸载时冲刷 */
const BOOKMARK_DEBOUNCE_MS = 500

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
  /** 书签变化(浏览视图刷新进度徽标/"继续阅读",§观看历史) */
  onBookmarksChanged?: (bookmarks: BookmarkMap) => void
  /** 按书签续读(进入有书签的来源时回调,状态栏提示用,§观看历史) */
  onResumed?: (info: { index: number; pageCount: number }) => void
}

/**
 * 取路径所在文件夹(去掉最后一段);仅用于拖入图片时的书签归属判定。
 * 渲染进程无 node:path,按分隔符切分即可。
 */
function parentFolder(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return index > 0 ? path.slice(0, index) : ''
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
  /** 原生图源模式(§性能/§格式):超高清图或 Chromium 不可解码格式,
   * 由主进程 sharp 按视口区域流式渲染,内存与图片尺寸解耦 */
  private native = false
  /** 当前已加载的区域位图与其对应区域 */
  private nativeBitmap: ImageBitmap | null = null
  private nativeRegion: { x: number; y: number; width: number; height: number } | null = null
  /** 当前位图是否为低清预览(预览阶段不参与重取判定,由自动升级接管) */
  private nativePreview = false
  /** 原生区域请求代际:翻页/换源时自增,响应到达时校验并丢弃过期请求 */
  private nativeSeq = 0
  /** 请求序号:每次请求自增,仅用于"在途去重"判定(与代际分离,
   * 避免 preview 升级请求被 preview 自身的 finally 误清在途标志) */
  private nativeReqSeq = 0
  /** 在途区域请求(去重:同一时刻只保留一个在途请求) */
  private nativeInFlight = false
  /** 区域重取防抖(缩放交互期间合并,避免每帧请求) */
  private nativeRefetchTimer: ReturnType<typeof setTimeout> | null = null
  /** 慢图解码提示计时器(>800ms 未完成时状态栏提示) */
  private slowDecodeTimer: ReturnType<typeof setTimeout> | null = null
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
  /** 当前来源(文件夹/压缩包绝对路径):书签归属,§观看历史 */
  private sourcePath = ''
  /** 书签写入节流计时器与待写入载荷(连续翻页只写最后一次) */
  private bookmarkTimer: ReturnType<typeof setTimeout> | null = null
  private pendingBookmark: BookmarkInput | null = null

  constructor(
    private readonly renderer: ImageRenderer,
    private readonly statusbar: StatusBar,
    private readonly callbacks: ViewerCallbacks = {}
  ) {
    // 页面卸载(关窗/退出)前冲刷防抖中的配置与书签,避免最后一次丢失
    window.addEventListener('pagehide', () => {
      this.flushPendingConfig()
      this.flushBookmarkNow()
    })
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
    if (this.bitmap || this.tiled || this.native) this.applyFit()
  }

  /** 切换阅读布局(§13 P1 双页跨页) */
  toggleLayoutMode(): void {
    this.layoutMode = this.layoutMode === 'single' ? 'spread' : 'single'
    void window.komascope.setConfig({ layoutMode: this.layoutMode })
    // 重新加载当前页以应用布局
    if (this.bitmap || this.tiled || this.native) void this.loadPage(this.currentIndex)
  }

  get isSpread(): boolean {
    return this.layoutMode === 'spread'
  }

  /**
   * 打开一组页面并进入阅读(浏览视图点击缩略图 / "继续阅读"):
   * 图片列表由调用方传入(浏览视图直接复用目录列举结果,不重复扫描目录);
   * initialIndex 缺省时按该书签(§观看历史)恢复上次浏览位置。
   */
  async openPages(folderPath: string, pages: PageItem[], initialIndex?: number): Promise<void> {
    if (pages.length === 0) return
    this.sourcePath = folderPath
    const resume = initialIndex === undefined
      ? await this.findResumeIndex(folderPath, pages)
      : { index: initialIndex, resumed: false }
    this.setPages(pages, resume.index)
    this.callbacks.onFolderChanged?.(folderPath)
    if (resume.resumed) this.callbacks.onResumed?.({ index: resume.index, pageCount: pages.length })
    await this.pushRecentFolder(folderPath)
    void window.komascope.setConfig({ lastFolder: folderPath })
  }

  /** 打开 zip/cbz 压缩包(§13 P0):扫描条目 → 按该书签续读或从第 0 页开始 */
  async openArchive(archivePath: string): Promise<void> {
    const result = await window.komascope.scanArchive(archivePath)
    this.sourcePath = archivePath
    const resume = await this.findResumeIndex(archivePath, result.pages)
    this.setPages(result.pages, resume.index)
    this.callbacks.onFolderChanged?.(archivePath)
    if (resume.resumed) {
      this.callbacks.onResumed?.({ index: resume.index, pageCount: result.pages.length })
    }
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

  /**
   * 定位上次浏览位置(§观看历史,每个文件夹各自独立):
   * ① 该书签存在时按图片路径匹配(图片被增删/改名后自动退化为下标);
   * ② 无书签时回退旧版全局 lastFolder/lastPage(向前兼容旧配置);
   * ③ 均无有效记录则从第 0 页开始。
   */
  private async findResumeIndex(
    sourcePath: string,
    pages: PageItem[]
  ): Promise<{ index: number; resumed: boolean }> {
    if (pages.length === 0) return { index: 0, resumed: false }
    try {
      const config = await window.komascope.getConfig()
      const bookmark = config.bookmarks[sourcePath]
      if (bookmark) {
        const byPath = pages.findIndex((page) => page.path === bookmark.lastImagePath)
        if (byPath >= 0) return { index: byPath, resumed: true }
        if (bookmark.lastIndex >= 0 && bookmark.lastIndex < pages.length) {
          return { index: bookmark.lastIndex, resumed: true }
        }
      }
      if (config.lastFolder === sourcePath && config.lastPage > 0 && config.lastPage < pages.length) {
        return { index: config.lastPage, resumed: true }
      }
    } catch {
      // 配置读取失败时从第 0 页开始
    }
    return { index: 0, resumed: false }
  }

  /**
   * 记录当前页为该来源的书签(§观看历史):
   * 连续翻页 500ms 内只写一次 IPC(节流),页面卸载时冲刷最后一次;
   * 主进程内原子读改写,保证多文件夹书签互不覆盖。
   */
  private scheduleBookmark(index: number): void {
    if (this.sourcePath === '') return
    const page = this.pages[index]
    if (!page) return
    this.pendingBookmark = {
      folderPath: this.sourcePath,
      lastImagePath: page.path,
      lastIndex: index,
      pageCount: this.pages.length
    }
    if (this.bookmarkTimer !== null) clearTimeout(this.bookmarkTimer)
    this.bookmarkTimer = setTimeout(() => {
      this.bookmarkTimer = null
      void this.flushBookmark()
    }, BOOKMARK_DEBOUNCE_MS)
  }

  /** 写入待落盘书签并通知浏览视图刷新进度(失败不影响阅读) */
  private async flushBookmark(): Promise<void> {
    const bookmark = this.pendingBookmark
    if (bookmark === null) return
    this.pendingBookmark = null
    try {
      const bookmarks = await window.komascope.setBookmark(bookmark)
      this.callbacks.onBookmarksChanged?.(bookmarks)
    } catch {
      // 书签写入失败静默(下次翻页再写)
    }
  }

  /** 立即冲刷节流中的书签(页面卸载时调用) */
  private flushBookmarkNow(): void {
    if (this.bookmarkTimer !== null) {
      clearTimeout(this.bookmarkTimer)
      this.bookmarkTimer = null
    }
    void this.flushBookmark()
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
    // 同属一个文件夹时按该文件夹记录书签(§观看历史);跨文件夹则不归属任何书签
    const folder = parentFolder(paths[0])
    this.sourcePath = folder !== '' && paths.every((p) => parentFolder(p) === folder) ? folder : ''
    this.setPages(pages)
    // 工具栏路径同步(§4.3.4:拖入图片后不再残留上一个来源路径)
    if (this.sourcePath !== '') this.callbacks.onFolderChanged?.(this.sourcePath)
  }

  /**
   * 结束当前来源(§5.2:「返回书库」等主动退出阅读):
   * 先冲刷待写入书签(结束后用户只能靠书签回到该位置),再清空页面列表与全部解码状态,
   * 使「缩略图浏览」不再把用户带回旧图、侧栏与状态栏同步复位。
   */
  closeSource(): void {
    this.flushBookmarkNow()
    // 递增世代:在途解码结果全部作废
    this.loadSeq++
    this.sourcePath = ''
    this.pages = []
    this.currentIndex = -1
    this.tiled = false
    this.imageSize = { width: 0, height: 0 }
    this.bitmap?.close()
    this.bitmap = null
    this.rightBitmap?.close()
    this.rightBitmap = null
    this.tileCache.clear()
    this.inFlightTiles.clear()
    this.failedTiles.clear()
    this.statusbar.setPage(0, 0)
    this.statusbar.setImageSize(0, 0)
    // 侧栏/长图消费空列表后自行清空
    this.callbacks.onPagesChanged?.([], -1)
    // 清理原生/整页位图、清空画布并隐藏画布
    this.showEmpty()
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
    if (this.locked || (!this.bitmap && !this.tiled && !this.native) || factor <= 0) return
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
    if (!this.bitmap && !this.tiled && !this.native) return
    this.transform = translate(this.transform, dx, dy)
    // 原生图源:平移超出预留边距时重取区域
    this.scheduleNativeRefetch()
    this.render()
  }

  /** 切换适配模式(0/1/W/H 快捷键):custom 恢复上次自定义缩放 */
  setFitMode(mode: FitMode): void {
    if (mode === 'custom') {
      const scale = this.lastCustomScale ?? 1
      if (this.bitmap || this.tiled || this.native) {
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
    if ((!this.bitmap && !this.tiled && !this.native) || this.imageSize.width <= 0 || this.imageSize.height <= 0) return
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
    // 原生图源:适配/窗口尺寸变化后按需重取区域(视口变化影响目标分辨率)
    this.scheduleNativeRefetch()
    this.render()
  }

  /** 视口尺寸变化(窗口 resize / 全屏切换):按适配模式重算 */
  onViewportResize(): void {
    if (this.bitmap || this.tiled || this.native) this.applyFit()
  }

  /** 变换变更后统一收尾:状态栏同步 + 持久化(防抖)+ 重绘 */
  private afterTransformChange(): void {
    this.statusbar.setZoom(this.transform.scale)
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void window.komascope.setConfig({ fitMode: this.fitMode, scale: this.transform.scale })
    }, PERSIST_DEBOUNCE_MS)
    // 原生图源:缩放后按需重取更高分辨率区域(防抖合并交互)
    this.scheduleNativeRefetch()
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

  /**
   * 确保页面元数据可用(§格式):压缩包源 scanArchive 不解析尺寸,
   * 首次打开该页时读一次并缓存到 pages(原生判定与状态栏都需要)。
   */
  private async ensurePageMeta(index: number): Promise<PageItem> {
    const page = this.pages[index]
    if (page.width > 0 && page.height > 0) return page
    try {
      const meta = await window.komascope.readMeta(page.path, page.archiveEntry)
      if (meta.width > 0 && meta.height > 0) {
        const updated = { ...page, width: meta.width, height: meta.height }
        this.pages[index] = updated
        return updated
      }
    } catch {
      // 读取失败保持原值(0 由后续解码兜底)
    }
    return page
  }

  private async loadPage(index: number): Promise<void> {
    if (index < 0 || index >= this.pages.length) return
    const seq = ++this.loadSeq
    this.currentIndex = index
    // 原生状态属于上一页:进入新页前清理(位图/计时器/代际)
    this.releaseNative()
    const page = await this.ensurePageMeta(index)
    if (seq !== this.loadSeq) return
    this.statusbar.setPage(index, this.pages.length)
    this.statusbar.setImageSize(page.width, page.height)
    this.callbacks.onPagesChanged?.(this.pages, index)
    // 书签(§13 P1 / §观看历史):记录当前页码(旧字段向前兼容)+ 该文件夹自己的书签
    void window.komascope.setConfig({ lastPage: index })
    this.scheduleBookmark(index)

    // 原生图源模式(§性能/§格式):以下两类交主进程 sharp 按视口区域流式渲染,
    // 内存与图片原始尺寸解耦,突破 8192 纹理上限与整页解码像素上限——
    // ① Chromium 不可解码格式(TIFF/SVG/HEIC/JXL/JP2);
    // ② 超大非 JPEG(瓦片模式需整页解码一次,会 OOM 或被像素上限拒绝)。
    // 该路径不读取整页字节(压缩包源省一次解压),故置于 blob 获取之前。
    // 双页布局不适用区域渲染 → 强制切回单页。
    if (this.needsNative(page)) {
      if (this.layoutMode === 'spread') {
        this.layoutMode = 'single'
        void window.komascope.setConfig({ layoutMode: this.layoutMode })
      }
      this.enterNativeMode(page, { width: page.width, height: page.height })
      return
    }

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

      // 瓦片模式:仅单页布局且超阈值(JPEG)→ 不整页解码,按需切瓦片
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
      this.native = false
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
      // 预解码相邻页(NFR-2;§性能增强:后 2 页,前 1 页;双页布局按 2 步)
      const step = this.layoutMode === 'spread' ? 2 : 1
      this.predecode(index + step)
      this.predecode(index + step * 2)
      if (index > 0) this.predecode(index - step)
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

  /** 尺寸是否需走原生图源:超大非 JPEG(瓦片模式需整页解码会 OOM) */
  private needsNative(page: PageItem): boolean {
    if (!isNativelyDecodable(page.name)) return true
    // JPEG 走瓦片(Chromium 部分解码);非 JPEG 超阈值 → 原生区域渲染
    const isJpeg = mimeFromName(page.name) === 'image/jpeg'
    if (isJpeg) return false
    return page.width > TILED_THRESHOLD || page.height > TILED_THRESHOLD
  }

  /** 进入原生图源模式(§性能/§格式):sharp 按视口区域流式渲染 */
  private enterNativeMode(page: PageItem, imageSize: Size): void {
    this.tiled = false
    this.native = true
    this.pageBlob = null
    this.releaseFullBitmap()
    this.bitmap?.close()
    this.bitmap = null
    this.rightBitmap?.close()
    this.rightBitmap = null
    this.imageSize = imageSize
    this.statusbar.setImageSize(imageSize.width, imageSize.height)
    this.renderer.setVisible(true)
    this.nativeRegion = null
    this.nativeBitmap?.close()
    this.nativeBitmap = null
    // 先出一张低清预览(整图缩略)再升级到视口分辨率:进入大图几乎即时可见
    void this.requestNativeRegion(page, true)
    this.applyFit()
  }

  /**
   * 请求视口区域位图(§性能/§格式):
   * - preview=true 请求整图低清预览(快速可见);否则请求当前视口区域全分辨率;
   * - 结果经代际校验,丢弃翻页/变换变化后的过期响应;
   * - 解码超过 800ms 时状态栏提示"解码中…"。
   */
  private async requestNativeRegion(page: PageItem, preview = false): Promise<void> {
    const seq = this.nativeSeq
    const req = ++this.nativeReqSeq
    // 元数据未知(width/height 为 0)时退回整图预览(不传 region)
    const knownSize = this.imageSize.width > 0 && this.imageSize.height > 0
    const spec: NativeViewSpec | null = preview
      ? knownSize
        ? {
            region: { x: 0, y: 0, width: this.imageSize.width, height: this.imageSize.height },
            targetWidth: PREVIEW_WIDTH
          }
        : { region: { x: 0, y: 0, width: 1, height: 1 }, targetWidth: PREVIEW_WIDTH }
      : computeNativeView(
          this.renderer.viewportSize,
          this.imageSize,
          this.transform,
          this.renderer.devicePixelRatio
        )
    if (!spec) return
    // 尺寸未知:整图请求(不传 region),由 sharp 自行决定
    const useRegion = preview ? knownSize : true
    this.nativeInFlight = true
    this.startSlowDecodeHint()
    try {
      const url = window.komascope.imageSourceUrl(page.path, {
        width: spec.targetWidth,
        archiveEntry: page.archiveEntry,
        region: useRegion ? spec.region : undefined
      })
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const bitmap = await createImageBitmap(blob)
      // 代际校验:翻页或退出原生模式时丢弃(关闭位图避免泄漏)
      if (seq !== this.nativeSeq || !this.native) {
        bitmap.close()
        return
      }
      this.nativeBitmap?.close()
      this.nativeBitmap = bitmap
      this.nativePreview = preview
      // 整图请求(尺寸未知)时,区域即为整张图的实际尺寸
      this.nativeRegion = useRegion
        ? spec.region
        : { x: 0, y: 0, width: bitmap.width, height: bitmap.height }
      this.render()
      // 预览完成后自动升级到视口分辨率
      if (preview) void this.requestNativeRegion(page)
    } catch (err) {
      console.error(t('error.loadPage'), page.path, err)
    } finally {
      // 仅最新一次请求清除在途标志:preview 的 finally 不得清掉
      // 它自己触发的升级请求(否则重取判定会在升级在途时误判为空闲)
      if (req === this.nativeReqSeq) {
        this.nativeInFlight = false
        this.clearSlowDecodeHint()
      }
    }
  }

  /** 慢图解码提示:>800ms 未完成时状态栏提示"解码中…" */
  private startSlowDecodeHint(): void {
    this.clearSlowDecodeHint()
    this.slowDecodeTimer = setTimeout(() => {
      this.slowDecodeTimer = null
      this.statusbar.setBusy(true)
    }, 800)
  }

  private clearSlowDecodeHint(): void {
    if (this.slowDecodeTimer !== null) {
      clearTimeout(this.slowDecodeTimer)
      this.slowDecodeTimer = null
    }
    this.statusbar.setBusy(false)
  }

  /** 变换变化后按需重取区域(防抖合并缩放交互;预览位图不参与清晰度判定) */
  private scheduleNativeRefetch(): void {
    if (!this.native) return
    if (this.nativeRefetchTimer !== null) clearTimeout(this.nativeRefetchTimer)
    this.nativeRefetchTimer = setTimeout(() => {
      this.nativeRefetchTimer = null
      if (!this.native) return
      const page = this.currentPage
      if (!page) return
      // 预览阶段不重取:低清位图必然"分辨率不足",由预览完成后的自动升级接管
      if (!this.nativeRegion || this.nativePreview) return
      const needs = nativeNeedsRefetch(
        { region: this.nativeRegion, bitmapWidth: this.nativeBitmap?.width ?? 0 },
        this.renderer.viewportSize,
        this.imageSize,
        this.transform,
        this.renderer.devicePixelRatio
      )
      if (needs && !this.nativeInFlight) void this.requestNativeRegion(page)
    }, 120)
  }

  /** 清理原生图源状态(翻页/换源时) */
  private releaseNative(): void {
    this.native = false
    this.nativeSeq++
    this.nativeReqSeq++
    this.nativeInFlight = false
    this.nativeRegion = null
    this.nativePreview = false
    this.nativeBitmap?.close()
    this.nativeBitmap = null
    if (this.nativeRefetchTimer !== null) {
      clearTimeout(this.nativeRefetchTimer)
      this.nativeRefetchTimer = null
    }
    this.clearSlowDecodeHint()
  }
  private enterTiledMode(blob: Blob, imageSize: Size): void {
    const page = this.pages[this.currentIndex]
    this.tiledFromFull = page ? mimeFromName(page.name) !== 'image/jpeg' : true
    // 非 JPEG 需整页解码一次:超过像素上限直接拒绝,防止恶意尺寸 OOM
    if (this.tiledFromFull && exceedsFullDecodeLimit(imageSize.width, imageSize.height)) {
      this.rejectOversized(page, null)
      return
    }
    this.tiled = true
    this.native = false
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
   * 超大图(瓦片模式)与原生图源页(不可解码格式/超大非 JPEG)跳过:
   * 前者整页解码数百 MB,后者 Chromium 无法解码,均在翻页时按需处理。
   */
  private predecode(index: number): void {
    if (index < 0 || index >= this.pages.length) return
    const page = this.pages[index]
    if (page.width > TILED_THRESHOLD || page.height > TILED_THRESHOLD) return
    if (this.needsNative(page)) return
    const key = this.pageCacheKey(page)
    if (this.tileCache.hasPage(key)) return
    this.decodeQueue = this.decodeQueue.then(async () => {
      try {
        // 浏览视图来源的页面尺寸未解析(为 0):先补读元数据再复判,
        // 避免超大图(非 JPEG 需整页解码)被预解码导致 OOM(§12 风险应对)
        const target = await this.ensurePageMeta(index)
        if (target.width > TILED_THRESHOLD || target.height > TILED_THRESHOLD) return
        if (this.needsNative(target)) return
        const blob = await this.getPageBlob(target)
        const bitmap = await createImageBitmap(blob)
        this.tileCache.setPage(this.pageCacheKey(target), bitmap)
      } catch {
        // 预解码失败静默(下次翻页时再解码)
      }
    })
    void this.decodeQueue
  }

  /**
   * 瓦片解码(经 LRU 缓存);同页同坐标在途解码共享同一 Promise,
   * 避免连续交互对同一瓦片重复解码(后批次覆盖前批次位图且不 close)。
   *
   * 在途 key **含页标识**(§5.1 串图修复):跨页(换图)绝不复用 ——
   * 否则新图会拿到上一张图的瓦片位图,按新图坐标系绘制即出现"上一张的解码块"。
   */
  private async decodeTile(tileX: number, tileY: number): Promise<ImageBitmap | null> {
    const page = this.pages[this.currentIndex]
    if (!page) return null
    const pageKey = this.pageCacheKey(page)
    const key = `${pageKey}|${tileX}:${tileY}`
    const inFlight = this.inFlightTiles.get(key)
    if (inFlight) return inFlight
    const p = this.decodeTileInner(pageKey, tileX, tileY).finally(() => {
      this.inFlightTiles.delete(key)
    })
    this.inFlightTiles.set(key, p)
    return p
  }

  /**
   * 瓦片解码主体:所有页面状态在 await **之前**捕获,
   * await 之后按世代校验,翻页/换源后丢弃结果(关闭位图),不写入新页缓存(§5.1)。
   */
  private async decodeTileInner(
    pageKey: string,
    tileX: number,
    tileY: number
  ): Promise<ImageBitmap | null> {
    const blob = this.pageBlob
    if (!blob) return null
    const seq = this.loadSeq
    const imageSize = this.imageSize
    const tiledFromFull = this.tiledFromFull
    const origin = tileOrigin(tileX, tileY)
    const tileW = Math.min(TILE_SIZE, imageSize.width - origin.x)
    const tileH = Math.min(TILE_SIZE, imageSize.height - origin.y)
    if (tileW <= 0 || tileH <= 0) return null
    try {
      let bitmap: ImageBitmap
      if (tiledFromFull) {
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
        bitmap = await createImageBitmap(blob, origin.x, origin.y, tileW, tileH)
      }
      // 世代/页校验:解码期间翻页或换源 → 丢弃并关闭位图,不得写入新页缓存(§5.1)
      if (this.loadSeq !== seq || this.pageBlob !== blob) {
        bitmap.close()
        return null
      }
      this.failedTiles.delete(`${tileX}:${tileY}`)
      this.tileCache.set(pageKey, tileX, tileY, bitmap)
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
    if (this.native && this.nativeBitmap && this.nativeRegion) {
      // 原生图源:绘制当前区域位图(按区域在图片中的位置映射到屏幕)
      this.renderer.renderRegion(this.transform, this.nativeBitmap, this.nativeRegion)
    } else if (this.tiled && this.pageBlob && pagePath) {
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
    } else {
      // 无任何可绘制内容(瓦片/原生区域解码在途或失败、空页):
      // 必须清空画布,否则保留上一张图的像素,表现为"上一张的解码块残留"(§5.1)
      this.renderer.clear()
    }
  }

  private showEmpty(): void {
    this.releaseNative()
    this.releaseFullBitmap()
    this.pageBlob = null
    this.renderer.clear()
    this.renderer.setVisible(false)
  }
}
