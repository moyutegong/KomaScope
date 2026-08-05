/**
 * 输入映射(§4.1 InputController):
 * 左键拖拽平移(FR-4)、滚轮锚点缩放(FR-5)、双击适配切换、键盘快捷键(§5)、拖拽导入(FR-2)。
 * 缩放锁定状态下滚轮缩放由 ViewerController 拒绝写入(FR-7 ②)。
 */
export interface InputControllerEvents {
  /** 拖入文件/文件夹的路径列表(顺序与拖拽一致) */
  onPathsDropped: (paths: string[]) => void
  /** 左键按下(视口坐标,开始平移;预留边缘翻页等扩展) */
  onPanStart?: (x: number, y: number) => void
  /** 平移增量(视口像素) */
  onPanMove: (dx: number, dy: number) => void
  onPanEnd?: () => void
  /** 滚轮:光标位置 + 滚动增量(锚点缩放用) */
  onWheelZoom: (x: number, y: number, deltaY: number) => void
  /** 滚轮翻页(光标在侧栏内时,向上=上一页,向下=下一页) */
  onWheelPage: (deltaY: number) => void
  /** 长图模式 Ctrl+滚轮缩放(与普通滚轮滚动区分,§需求) */
  onLongViewZoom: (factor: number) => void
  /** 双击(§5:fitScreen ↔ 上次自定义缩放) */
  onDoubleClick: () => void
  onKeyDown: (event: KeyboardEvent) => void
}

/** 滚轮 deltaY → 缩放因子:每 100 格约 ±26% */
const WHEEL_FACTOR = Math.pow(2, 1 / 300)

export class InputController {
  private panning = false
  private lastX = 0
  private lastY = 0

  constructor(private readonly events: InputControllerEvents) {
    window.addEventListener('dragover', (e) => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    })
    window.addEventListener('drop', (e) => {
      e.preventDefault()
      const files = Array.from(e.dataTransfer?.files ?? [])
      const paths = files
        .map((f) => window.komascope.getPathForFile(f))
        .filter((p) => p.length > 0)
      if (paths.length > 0) this.events.onPathsDropped(paths)
    })

    window.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      this.panning = true
      this.lastX = e.clientX
      this.lastY = e.clientY
      this.events.onPanStart?.(e.clientX, e.clientY)
    })
    window.addEventListener('mousemove', (e) => {
      if (!this.panning) return
      this.events.onPanMove(e.clientX - this.lastX, e.clientY - this.lastY)
      this.lastX = e.clientX
      this.lastY = e.clientY
    })
    window.addEventListener('mouseup', () => {
      if (!this.panning) return
      this.panning = false
      this.events.onPanEnd?.()
    })

    window.addEventListener(
      'wheel',
      (e) => {
        // 光标在长图模式容器内:普通滚轮让容器原生滚动浏览长条图片;
        // Ctrl+滚轮缩放(与滚动区分,§需求)
        const overLongView =
          e.target instanceof Element && e.target.closest('#long-view') !== null
        if (overLongView) {
          if (e.ctrlKey) {
            e.preventDefault()
            this.events.onLongViewZoom(wheelDeltaToFactor(e.deltaY))
          }
          return
        }
        e.preventDefault()
        // 光标在侧栏内:滚轮翻页(不缩放);否则锚点缩放
        const overSidebar = e.target instanceof Element && e.target.closest('#sidebar') !== null
        if (overSidebar) {
          this.events.onWheelPage(e.deltaY)
        } else {
          this.events.onWheelZoom(e.clientX, e.clientY, e.deltaY)
        }
      },
      { passive: false }
    )

    window.addEventListener('dblclick', () => this.events.onDoubleClick())
    window.addEventListener('keydown', (e) => this.events.onKeyDown(e))
  }
}

/** 滚轮增量 → 缩放 factor(向下滚放大,>0 为放大) */
export function wheelDeltaToFactor(deltaY: number): number {
  return Math.pow(WHEEL_FACTOR, -deltaY)
}
