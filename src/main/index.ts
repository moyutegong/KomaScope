/**
 * 主进程入口(§4.1):创建窗口、注册 IPC 与自定义协议。
 * 安全基线(contextIsolation/nodeIntegration/sandbox)在 window-manager.ts 中设置。
 */
import { app, BrowserWindow } from 'electron'
import { registerFileProtocol, registerIpc } from './ipc'
import { createMainWindow } from './window-manager'
import { configStore } from './config-store'

app.whenReady().then(() => {
  registerFileProtocol()
  registerIpc()
  createMainWindow()

  // macOS:点击 Dock 图标且无窗口时重建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// 非 macOS:全部窗口关闭即退出
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出前立即落盘配置,避免防抖定时器丢失最后一次修改
app.on('before-quit', () => {
  configStore.flush()
})
