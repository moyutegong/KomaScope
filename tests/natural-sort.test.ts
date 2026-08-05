import { describe, expect, it } from 'vitest'
import { naturalCompare } from '../src/shared/natural-sort'

function sorted(list: string[]): string[] {
  return [...list].sort(naturalCompare)
}

describe('natural-sort', () => {
  it('数字段按数值比较:p1 < p2 < p10 < p11', () => {
    expect(sorted(['p11', 'p1', 'p10', 'p2'])).toEqual(['p1', 'p2', 'p10', 'p11'])
  })

  it('大小写不敏感:Page10 排在 Page2 之后', () => {
    expect(sorted(['Page10', 'Page2', 'page1'])).toEqual(['page1', 'Page2', 'Page10'])
  })

  it('大小写不同的同名文件保持稳定顺序(比较器返回 0)', () => {
    expect(sorted(['Page2', 'page2'])).toEqual(['Page2', 'page2'])
    expect(sorted(['page2', 'Page2'])).toEqual(['page2', 'Page2'])
  })

  it('中英文混排:第1话 < 第2话 < 第10话', () => {
    expect(sorted(['第10话', '第2话', '第1话'])).toEqual(['第1话', '第2话', '第10话'])
  })

  it('前导零:数值相等时前导零多的排后面', () => {
    expect(sorted(['p02', 'p1', 'p01'])).toEqual(['p1', 'p01', 'p02'])
  })

  it('数字段优先于字符串段:p2 < pa', () => {
    expect(sorted(['pa', 'p2'])).toEqual(['p2', 'pa'])
  })

  it('相同字符串返回 0(排序稳定)', () => {
    expect(naturalCompare('page1', 'page1')).toBe(0)
  })

  it('空字符串排在非空之前', () => {
    expect(sorted(['a', ''])).toEqual(['', 'a'])
  })
})
