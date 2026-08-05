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
    'toolbar.fitScreen': '适应屏幕',
    'toolbar.noFolder': '未打开文件夹',
    'toolbar.lang': 'EN',
    'placeholder.hint': '打开文件夹或拖入图片开始阅读',
    'status.page': '第 {current} / {total} 页',
    'status.page.empty': '— / —',
    'status.size.empty': '—',
    'status.zoom': '缩放 {percent}%',
    'status.zoom.empty': '缩放 —',
    'status.lockTitle': '缩放锁定',
    'error.loadPage': '页面加载失败:',
    'error.loadConfig': '读取配置失败:'
  },
  en: {
    'app.title': 'KomaScope',
    'toolbar.openFolder': 'Open Folder',
    'toolbar.fitScreen': 'Fit Screen',
    'toolbar.noFolder': 'No folder opened',
    'toolbar.lang': '中',
    'placeholder.hint': 'Open a folder or drop images to start reading',
    'status.page': 'Page {current} / {total}',
    'status.page.empty': '— / —',
    'status.size.empty': '—',
    'status.zoom': 'Zoom {percent}%',
    'status.zoom.empty': 'Zoom —',
    'status.lockTitle': 'Zoom locked',
    'error.loadPage': 'Failed to load page:',
    'error.loadConfig': 'Failed to load config:'
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
