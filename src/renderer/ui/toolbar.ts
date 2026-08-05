/**
 * 工具栏(M0 骨架):打开文件夹按钮;适应屏幕按钮(FR-8)。
 * 拖拽导入(FR-2)在 M2 接入。
 */
import type { ScanResult } from '../../shared/types'

export interface ToolbarEvents {
  onFolderOpened: (result: ScanResult) => void
  /** 一键"适应屏幕":铺满当前显示器工作区(FR-8) */
  onFitScreen: () => void
}

export class Toolbar {
  private readonly folderEl: HTMLElement

  constructor(private readonly events: ToolbarEvents) {
    this.folderEl = document.getElementById('toolbar-folder') as HTMLElement
    const openBtn = document.getElementById('btn-open-folder') as HTMLButtonElement
    openBtn.addEventListener('click', () => void this.openFolder())
    const fitBtn = document.getElementById('btn-fit-screen') as HTMLButtonElement
    fitBtn.addEventListener('click', () => this.events.onFitScreen())
  }

  setFolder(folderPath: string): void {
    this.folderEl.textContent = folderPath
    this.folderEl.title = folderPath
  }

  private async openFolder(): Promise<void> {
    const result = await window.komascope.openFolderDialog()
    if (result) this.events.onFolderOpened(result)
  }
}
