/**
 * 工具栏:打开文件夹、适应屏幕(FR-8)。
 * 语言切换统一使用应用菜单 Language(§菜单)。
 */
import type { ScanResult } from '../../shared/types'
import { t } from '../i18n'

export interface ToolbarEvents {
  onFolderOpened: (result: ScanResult) => void
  /** 一键"适应屏幕":铺满当前显示器工作区(FR-8) */
  onFitScreen: () => void
}

export class Toolbar {
  private readonly folderEl: HTMLElement
  private folderPath = ''

  constructor(private readonly events: ToolbarEvents) {
    this.folderEl = document.getElementById('toolbar-folder') as HTMLElement
    const openBtn = document.getElementById('btn-open-folder') as HTMLButtonElement
    openBtn.addEventListener('click', () => void this.openFolder())
    const fitBtn = document.getElementById('btn-fit-screen') as HTMLButtonElement
    fitBtn.addEventListener('click', () => this.events.onFitScreen())
  }

  setFolder(folderPath: string): void {
    this.folderPath = folderPath
    this.renderFolder()
  }

  /** 语言切换后刷新文案 */
  refresh(): void {
    this.renderFolder()
  }

  private renderFolder(): void {
    this.folderEl.textContent = this.folderPath === '' ? t('toolbar.noFolder') : this.folderPath
    this.folderEl.title = this.folderPath
  }

  private async openFolder(): Promise<void> {
    const result = await window.komascope.openFolderDialog()
    if (result) this.events.onFolderOpened(result)
  }
}
