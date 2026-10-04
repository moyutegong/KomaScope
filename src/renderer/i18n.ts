/**
 * 中英文切换(FR-9 扩展):文案字典 + locale 状态 + 变量插值。
 * 纯逻辑可单测;DOM 静态文本经 [data-i18n] 属性由 applyStaticText() 应用。
 */

export type Locale = 'zh' | 'en'

/** 文案键值对:值中的 {var} 占位符由 t() 的 vars 参数替换 */
type Messages = Record<string, string>

export const messages: Record<Locale, Messages> = {
  zh: {
    'app.title': 'KomaScope',
    'toolbar.openFolder': '打开文件夹',
    'toolbar.library': '书库目录',
    'toolbar.libraryRoot': '返回书库',
    'toolbar.browse': '缩略图浏览',
    'toolbar.fitScreen': '适应屏幕',
    'toolbar.immersive': '沉浸模式',
    'toolbar.noFolder': '未打开文件夹',
    'placeholder.hint': '打开文件夹或拖入图片开始阅读',
    'sidebar.history': '历史',
    'sidebar.pages': '图片',
    'browser.library': '书库',
    'browser.root': '书库根目录',
    'browser.back': '返回上级',
    'browser.continue': '继续阅读',
    'browser.readAll': '阅读本文件夹',
    'browser.empty': '此文件夹为空',
    'browser.noLibrary': '未设置书库目录',
    'browser.pickLibrary': '选择书库目录',
    'browser.count': '{dirs} 个文件夹 · {archives} 个压缩包 · {images} 张图片',
    'browser.error': '无法读取该文件夹:{path}',
    'status.page': '第 {current} / {total} 页',
    'status.resume': '已从上次位置继续 ({current}/{total})',
    'status.page.empty': '— / —',
    'status.size.empty': '—',
    'status.zoom': '缩放 {percent}%',
    'status.zoom.empty': '缩放 —',
    'status.lockTitle': '缩放锁定',
    'status.busy': '解码中…',
    'error.loadPage': '页面加载失败:',
    'error.loadConfig': '读取配置失败:',
    'error.openPath': '无法打开历史路径:',
    'error.openDroppedPath': '无法打开拖入的文件/文件夹:',
    'error.browseFolder': '无法浏览文件夹:'
  },
  en: {
    'app.title': 'KomaScope',
    'toolbar.openFolder': 'Open Folder',
    'toolbar.library': 'Library Folder',
    'toolbar.libraryRoot': 'Back to Library',
    'toolbar.browse': 'Thumbnail Browser',
    'toolbar.fitScreen': 'Fit Screen',
    'toolbar.immersive': 'Immersive',
    'toolbar.noFolder': 'No folder opened',
    'placeholder.hint': 'Open a folder or drop images to start reading',
    'sidebar.history': 'History',
    'sidebar.pages': 'Images',
    'browser.library': 'Library',
    'browser.root': 'Library root',
    'browser.back': 'Back',
    'browser.continue': 'Continue reading',
    'browser.readAll': 'Read this folder',
    'browser.empty': 'This folder is empty',
    'browser.noLibrary': 'No library folder set',
    'browser.pickLibrary': 'Choose library folder',
    'browser.count': '{dirs} folders · {archives} archives · {images} images',
    'browser.error': 'Cannot read folder: {path}',
    'status.page': 'Page {current} / {total}',
    'status.resume': 'Resumed from last position ({current}/{total})',
    'status.page.empty': '— / —',
    'status.size.empty': '—',
    'status.zoom': 'Zoom {percent}%',
    'status.zoom.empty': 'Zoom —',
    'status.lockTitle': 'Zoom locked',
    'status.busy': 'Decoding…',
    'error.loadPage': 'Failed to load page:',
    'error.loadConfig': 'Failed to load config:',
    'error.openPath': 'Cannot open history path:',
    'error.openDroppedPath': 'Cannot open dropped file/folder:',
    'error.browseFolder': 'Cannot browse folder:'
  }
}

let currentLocale: Locale = 'zh'

export function getLocale(): Locale {
  return currentLocale
}

export function setLocale(locale: Locale): void {
  currentLocale = locale
}

export function isLocale(v: unknown): v is Locale {
  return v === 'zh' || v === 'en'
}

/** 取当前语言文案,支持 {var} 插值;缺失 key 回退到中文,仍缺失返回 key 本身 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const text =
    messages[currentLocale][key] ?? messages.zh[key] ?? key
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  )
}

/** 应用静态文案:扫描 [data-i18n] 元素设置 textContent;title 用 data-i18n-title */
export function applyStaticText(locale: Locale = currentLocale): void {
  currentLocale = locale
  document.documentElement.lang = locale
  document.title = t('app.title')
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n ?? '')
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle ?? '')
  }
}
