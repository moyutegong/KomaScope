/**
 * 长图模式(§需求4):单页无限下拉——所有图片垂直拼接成长条,滚动浏览。
 * 每张图片全宽显示、高度自适应;点击某张跳转到对应页并切回翻页模式。
 */
import type { PageItem } from '../../shared/types'

export interface LongViewEvents {
  onSelectPage: (index: number) => void
}

/** 扩展名 → MIME(压缩包条目字节构造 Blob 时需要具体类型,img 才能解码) */
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

function mimeFromName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

export class LongView {
  private readonly el: HTMLElement
  private currentIndex = -1
  private blobUrls = new Map<number, string>()
  /** 缩放倍率(§需求 Ctrl+滚轮):1 = 适应视口宽,0.5~4 */
  private scale = 1

  constructor(private readonly events: LongViewEvents) {
    this.el = document.getElementById('long-view') as HTMLElement
  }

  /** Ctrl+滚轮缩放:改变所有图片显示宽度,高度自适应;容器可横向滚动 */
  zoomBy(factor: number): void {
    this.scale = Math.min(4, Math.max(0.5, this.scale * factor))
    for (const img of this.el.querySelectorAll<HTMLImageElement>('img')) {
      img.style.width = `${(this.scale * 100).toFixed(1)}%`
    }
  }

  /** 更新页面列表并重新渲染长图列表 */
  setPages(pages: PageItem[], currentIndex: number): void {
    this.revokeBlobUrls()
    this.currentIndex = currentIndex
    this.el.innerHTML = ''
    for (let i = 0; i < pages.length; i++) {
      this.el.appendChild(this.makeItem(pages[i], i))
    }
  }

  setVisible(visible: boolean): void {
    this.el.hidden = !visible
  }

  /** 图片源:磁盘页用自定义协议 URL;压缩包条目读字节转 blob URL */
  private imageUrl(page: PageItem, index: number): string {
    if (page.archiveEntry) {
      void window.komascope
        .readArchiveEntry(page.path, page.archiveEntry)
        .then((bytes) => {
          const url = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], { type: mimeFromName(page.name) })
          )
          this.blobUrls.set(index, url)
          const img = this.el.querySelector<HTMLImageElement>(`img[data-index="${index}"]`)
          if (img) img.src = url
        })
        .catch(() => {
          // 读取失败:图片留空
        })
      return ''
    }
    return window.komascope.fileUrl(page.path)
  }

  private makeItem(page: PageItem, index: number): HTMLElement {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'long-item' + (index === this.currentIndex ? ' long-item-active' : '')
    item.title = page.name
    item.addEventListener('click', () => this.events.onSelectPage(index))

    const img = document.createElement('img')
    img.dataset['index'] = String(index)
    img.loading = 'lazy'
    img.alt = page.name
    const url = this.imageUrl(page, index)
    if (url) img.src = url

    item.appendChild(img)
    return item
  }

  private revokeBlobUrls(): void {
    for (const url of this.blobUrls.values()) URL.revokeObjectURL(url)
    this.blobUrls.clear()
  }
}
