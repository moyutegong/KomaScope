/**
 * 工具栏:打开文件夹(浏览视图)、书库目录、缩略图/阅读视图切换、适应屏幕(FR-8)。
 * 语言切换统一使用应用菜单 Language(§菜单)。
 */
import { createSingleFlight } from '../../shared/single-flight'
import { t } from '../i18n'

export interface ToolbarEvents {
  /** 选择文件夹后打开(进入缩略图浏览视图,§资源管理器模式) */
  onFolderPicked: (folderPath: string) => void
  /**
   * 选好书库根目录后应用(§观看历史:自动列出其下一级文件夹)。
   * 回调接收**已选路径**而非自己去弹框 —— 否则按钮的弹框 + 回调内部再弹框
   * 会弹出两个选择框(§4.1 缺陷根因)。
   */
  onLibraryPick: (folderPath: string) => void
  /** 缩略图浏览 ↔ 阅读视图切换 */
  onBrowseToggle: () => void
  /** 一键返回书库根目录(阅读中也可用;未设置书库时进入选择流程) */
  onLibraryRoot: () => void
  /** 一键"适应屏幕":铺满当前显示器工作区(FR-8) */
  onFitScreen: () => void
}

export class Toolbar {
  private readonly folderEl: HTMLElement
  private readonly browseBtn: HTMLButtonElement
  private folderPath = ''
  /** 选择框重入保护:弹框期间忽略重复点击,不叠加对话框(§4.1) */
  private readonly pickFolderOnce = createSingleFlight<string | null>()

  constructor(private readonly events: ToolbarEvents) {
    this.folderEl = document.getElementById('toolbar-folder') as HTMLElement
    this.browseBtn = document.getElementById('btn-browse') as HTMLButtonElement
    const openBtn = document.getElementById('btn-open-folder') as HTMLButtonElement
    const libraryBtn = document.getElementById('btn-library') as HTMLButtonElement
    const libraryRootBtn = document.getElementById('btn-library-root') as HTMLButtonElement
    const fitBtn = document.getElementById('btn-fit-screen') as HTMLButtonElement
    openBtn.addEventListener('click', () => void this.pickFolder(this.events.onFolderPicked))
    libraryBtn.addEventListener('click', () => void this.pickFolder(this.events.onLibraryPick))
    libraryRootBtn.addEventListener('click', () => this.events.onLibraryRoot())
    this.browseBtn.addEventListener('click', () => this.events.onBrowseToggle())
    fitBtn.addEventListener('click', () => this.events.onFitScreen())
  }

  setFolder(folderPath: string): void {
    this.folderPath = folderPath
    this.renderFolder()
  }

  /**
   * 缩略图浏览按钮态(§5.2):`active` = 当前处于浏览视图,`enabled` = 存在可切换的阅读内容。
   * 无阅读内容(尚未打开 / 已结束阅读)时按钮不高亮且禁用 ——
   * 避免"点返回书库后它却像被按下过"的误导,也避免空切换。
   */
  setBrowseState(active: boolean, enabled: boolean): void {
    this.browseBtn.classList.toggle('toolbar-btn-active', active && enabled)
    this.browseBtn.disabled = !enabled
  }

  /** 语言切换后刷新文案 */
  refresh(): void {
    this.renderFolder()
  }

  private renderFolder(): void {
    this.folderEl.textContent = this.folderPath === '' ? t('toolbar.noFolder') : this.folderPath
    this.folderEl.title = this.folderPath
  }

  /** 选择文件夹(仅返回路径,不扫描内容:大目录/书库根目录秒开) */
  private async pickFolder(onPicked: (folderPath: string) => void): Promise<void> {
    const folderPath = await this.pickFolderOnce(() => window.komascope.pickFolder())
    if (folderPath) onPicked(folderPath)
  }
}
