/**
 * 应用菜单(替代 Electron 默认英文菜单):File/Edit/View/Window/Language/Help 双语。
 * 菜单动作经 webContents.send('menu:action', action) 转发给渲染进程执行;
 * 语言切换经 'locale:changed' 通知渲染进程,并在此重建菜单。
 */
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { configStore } from './config-store'

type Locale = 'zh' | 'en'

const MENU_TEXT: Record<Locale, Record<string, string>> = {
  zh: {
    file: '文件(&F)',
    openFolder: '打开文件夹(&O)',
    quit: '退出(&Q)',
    edit: '编辑(&E)',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    view: '视图(&V)',
    prevPage: '上一页',
    nextPage: '下一页',
    zoomIn: '放大',
    zoomOut: '缩小',
    fitWidth: '适应宽度',
    fitHeight: '适应高度',
    fitScreen: '适应屏幕',
    actualSize: '实际大小',
    resetView: '重置视图',
    fullscreen: '全屏',
    window: '窗口(&W)',
    minimize: '最小化',
    close: '关闭窗口',
    language: '语言',
    langZh: '中文',
    langEn: 'English',
    help: '帮助(&H)',
    about: '关于 KomaScope'
  },
  en: {
    file: 'File',
    openFolder: 'Open Folder',
    quit: 'Quit',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    view: 'View',
    prevPage: 'Previous Page',
    nextPage: 'Next Page',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    fitWidth: 'Fit Width',
    fitHeight: 'Fit Height',
    fitScreen: 'Fit Screen',
    actualSize: 'Actual Size',
    resetView: 'Reset View',
    fullscreen: 'Toggle Fullscreen',
    window: 'Window',
    minimize: 'Minimize',
    close: 'Close Window',
    language: 'Language',
    langZh: '中文',
    langEn: 'English',
    help: 'Help',
    about: 'About KomaScope'
  }
}

function txt(locale: Locale, key: string): string {
  return MENU_TEXT[locale][key] ?? key
}

/** 发送动作给渲染进程(仅发送给目标窗口) */
function sendAction(win: BrowserWindow, action: string): void {
  if (!win.isDestroyed()) win.webContents.send('menu:action', action)
}

/** 切换语言:持久化 + 通知渲染进程 + 重建菜单 */
function switchLocale(win: BrowserWindow, locale: Locale): void {
  configStore.set({ locale })
  if (!win.isDestroyed()) win.webContents.send('locale:changed', locale)
  buildAppMenu(locale, win)
}

/** 构建并设置应用菜单 */
export function buildAppMenu(locale: Locale, win: BrowserWindow): void {
  const t = (key: string): string => txt(locale, key)

  const template: MenuItemConstructorOptions[] = [
    {
      label: t('file'),
      submenu: [
        {
          label: t('openFolder'),
          accelerator: 'CmdOrCtrl+O',
          click: () => sendAction(win, 'open-folder')
        },
        { type: 'separator' },
        { role: 'quit', label: t('quit') }
      ]
    },
    {
      label: t('edit'),
      submenu: [
        { role: 'undo', label: t('undo') },
        { role: 'redo', label: t('redo') },
        { type: 'separator' },
        { role: 'cut', label: t('cut') },
        { role: 'copy', label: t('copy') },
        { role: 'paste', label: t('paste') },
        { role: 'selectAll', label: t('selectAll') }
      ]
    },
    {
      label: t('view'),
      submenu: [
        { label: t('prevPage'), accelerator: 'Left', click: () => sendAction(win, 'prev-page') },
        { label: t('nextPage'), accelerator: 'Right', click: () => sendAction(win, 'next-page') },
        { type: 'separator' },
        { label: t('zoomIn'), accelerator: 'Plus', click: () => sendAction(win, 'zoom-in') },
        { label: t('zoomOut'), accelerator: 'Minus', click: () => sendAction(win, 'zoom-out') },
        { type: 'separator' },
        { label: t('fitWidth'), accelerator: 'W', click: () => sendAction(win, 'fit-width') },
        { label: t('fitHeight'), accelerator: 'H', click: () => sendAction(win, 'fit-height') },
        { label: t('fitScreen'), accelerator: '0', click: () => sendAction(win, 'fit-screen') },
        { label: t('actualSize'), accelerator: '1', click: () => sendAction(win, 'actual-size') },
        { label: t('resetView'), accelerator: 'R', click: () => sendAction(win, 'reset-view') },
        { type: 'separator' },
        {
          label: t('fullscreen'),
          accelerator: 'F11',
          click: () => sendAction(win, 'toggle-fullscreen')
        }
      ]
    },
    {
      label: t('window'),
      submenu: [
        { role: 'minimize', label: t('minimize') },
        { role: 'close', label: t('close') }
      ]
    },
    {
      label: t('language'),
      submenu: [
        {
          label: t('langZh'),
          type: 'radio',
          checked: locale === 'zh',
          click: () => switchLocale(win, 'zh')
        },
        {
          label: t('langEn'),
          type: 'radio',
          checked: locale === 'en',
          click: () => switchLocale(win, 'en')
        }
      ]
    },
    {
      label: t('help'),
      role: 'help',
      submenu: [
        {
          label: t('about'),
          click: () => {
            void app.showAboutPanel()
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
