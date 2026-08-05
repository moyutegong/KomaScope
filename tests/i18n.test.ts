import { describe, expect, it } from 'vitest'
import { getLocale, isLocale, messages, setLocale, t } from '../src/renderer/i18n'

describe('i18n', () => {
  it('中英文 key 集合完全一致', () => {
    const zhKeys = Object.keys(messages.zh).sort()
    const enKeys = Object.keys(messages.en).sort()
    expect(zhKeys).toEqual(enKeys)
    expect(zhKeys.length).toBeGreaterThan(5)
  })

  it('t() 默认中文,setLocale 切换生效', () => {
    setLocale('zh')
    expect(t('toolbar.openFolder')).toBe('打开文件夹')
    setLocale('en')
    expect(t('toolbar.openFolder')).toBe('Open Folder')
    expect(getLocale()).toBe('en')
    setLocale('zh')
  })

  it('t() 支持 {var} 插值', () => {
    setLocale('zh')
    expect(t('status.page', { current: 3, total: 240 })).toBe('第 3 / 240 页')
    setLocale('en')
    expect(t('status.page', { current: 3, total: 240 })).toBe('Page 3 / 240')
    setLocale('zh')
  })

  it('缺失 key 回退中文,再缺失返回 key 本身', () => {
    setLocale('en')
    // zh 存在但 en 缺失:回退 zh
    expect(t('status.zoom.empty')).toBe('Zoom —')
    // 双方都缺失:返回 key
    expect(t('no.such.key')).toBe('no.such.key')
    setLocale('zh')
  })

  it('isLocale 校验', () => {
    expect(isLocale('zh')).toBe(true)
    expect(isLocale('en')).toBe(true)
    expect(isLocale('fr')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
  })
})
