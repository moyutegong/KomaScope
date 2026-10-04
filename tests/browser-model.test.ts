/**
 * 浏览视图纯逻辑单测(§资源管理器模式):
 * 条目扁平化顺序、书签归属/排序、进度文本、方向键选中移动。
 * 纯函数,无 DOM/Electron 依赖。
 */
import { describe, expect, it } from 'vitest'
import {
  bookmarkProgress,
  flattenListing,
  folderName,
  isSelfOrDescendant,
  latestBookmarkFor,
  moveSelection,
  parentName,
  recentBookmarks
} from '../src/renderer/ui/browser-model'
import type { BookmarkMap, DirectoryListing, FolderBookmark } from '../src/shared/types'

function listing(partial: Partial<DirectoryListing> = {}): DirectoryListing {
  return { folderPath: 'F:\\lib', dirs: [], archives: [], images: [], ...partial }
}

function bookmark(folderPath: string, lastIndex: number, pageCount: number, updatedAt: number): FolderBookmark {
  return { folderPath, lastImagePath: `${folderPath}\\p${lastIndex}.jpg`, lastIndex, pageCount, updatedAt }
}

describe('flattenListing', () => {
  it('顺序为 文件夹 → 压缩包 → 图片,图片携带其在图片列表中的下标', () => {
    const entries = flattenListing(
      listing({
        dirs: [
          { path: 'F:\\lib\\a', name: 'a' },
          { path: 'F:\\lib\\b', name: 'b' }
        ],
        archives: [{ path: 'F:\\lib\\c.cbz', name: 'c.cbz' }],
        images: [
          { path: 'F:\\lib\\1.jpg', name: '1.jpg', width: 0, height: 0, size: 0 },
          { path: 'F:\\lib\\2.jpg', name: '2.jpg', width: 0, height: 0, size: 0 }
        ]
      })
    )
    expect(entries.map((e) => [e.kind, e.name])).toEqual([
      ['folder', 'a'],
      ['folder', 'b'],
      ['archive', 'c.cbz'],
      ['image', '1.jpg'],
      ['image', '2.jpg']
    ])
    // 图片条目下标 = 图片列表下标(点击缩略图进入阅读的起始页)
    expect(entries.filter((e) => e.kind === 'image').map((e) => (e.kind === 'image' ? e.index : -1))).toEqual([0, 1])
  })

  it('空目录返回空列表', () => {
    expect(flattenListing(listing())).toEqual([])
  })
})

describe('isSelfOrDescendant', () => {
  it('自身与子孙路径为真', () => {
    expect(isSelfOrDescendant('F:\\lib', 'F:\\lib')).toBe(true)
    expect(isSelfOrDescendant('F:\\lib', 'F:\\lib\\series\\ch1')).toBe(true)
  })

  it('兄弟目录与字符串前缀相似的目录为假', () => {
    expect(isSelfOrDescendant('F:\\lib', 'F:\\other')).toBe(false)
    // 'F:\\lib2' 不是 'F:\\lib' 的子孙(必须按路径分隔符比较)
    expect(isSelfOrDescendant('F:\\lib', 'F:\\lib2')).toBe(false)
  })

  it('分隔符混用不影响判断', () => {
    expect(isSelfOrDescendant('F:/lib', 'F:\\lib\\ch1')).toBe(true)
  })
})

describe('latestBookmarkFor', () => {
  it('自身或后代中取更新时间最新的一条', () => {
    const map: BookmarkMap = {
      'F:\\lib': bookmark('F:\\lib', 1, 10, 100),
      'F:\\lib\\series': bookmark('F:\\lib\\series', 3, 20, 300),
      'F:\\lib\\series\\ch1': bookmark('F:\\lib\\series\\ch1', 5, 40, 200)
    }
    expect(latestBookmarkFor(map, 'F:\\lib')?.folderPath).toBe('F:\\lib\\series')
    expect(latestBookmarkFor(map, 'F:\\lib\\series')?.folderPath).toBe('F:\\lib\\series')
  })

  it('无关目录不参与匹配;无书签返回 null', () => {
    const map: BookmarkMap = { 'F:\\other': bookmark('F:\\other', 1, 5, 999) }
    expect(latestBookmarkFor(map, 'F:\\lib')).toBeNull()
    expect(latestBookmarkFor({}, 'F:\\lib')).toBeNull()
  })
})

describe('recentBookmarks', () => {
  it('仅保留根目录下(含自身)的书签,按最近阅读倒序并限制条数', () => {
    const map: BookmarkMap = {
      'F:\\lib': bookmark('F:\\lib', 0, 9, 100),
      'F:\\lib\\a': bookmark('F:\\lib\\a', 2, 9, 400),
      'F:\\lib\\b': bookmark('F:\\lib\\b', 4, 9, 300),
      'F:\\other': bookmark('F:\\other', 7, 9, 900)
    }
    expect(recentBookmarks(map, 'F:\\lib', 2).map((b) => b.folderPath)).toEqual(['F:\\lib\\a', 'F:\\lib\\b'])
    expect(recentBookmarks(map, 'F:\\lib', 10).map((b) => b.folderPath)).toEqual([
      'F:\\lib\\a',
      'F:\\lib\\b',
      'F:\\lib'
    ])
  })
})

describe('bookmarkProgress / folderName', () => {
  it('进度文本为 当前/总数;总数未知时仅显示当前位置', () => {
    expect(bookmarkProgress(bookmark('F:\\lib\\a', 11, 58, 1))).toBe('12/58')
    expect(bookmarkProgress(bookmark('F:\\lib\\a', 11, 0, 1))).toBe('12')
  })

  it('folderName 取路径最后一段', () => {
    expect(folderName('F:\\lib\\series\\ch1')).toBe('ch1')
    expect(folderName('F:\\lib\\series\\ch1\\')).toBe('ch1')
    expect(folderName('/home/user/manga')).toBe('manga')
  })

  it('parentName 取倒数第二段;无父目录返回空串(§4.3.5)', () => {
    expect(parentName('F:\\lib\\series\\ch1')).toBe('series')
    expect(parentName('F:\\lib\\series\\ch1\\')).toBe('series')
    expect(parentName('/home/user/manga')).toBe('user')
    expect(parentName('F:\\lib')).toBe('')
    expect(parentName('lib')).toBe('')
  })
})

describe('moveSelection(方向键网格导航)', () => {
  it('左右移动 ±1 并在边界夹取', () => {
    expect(moveSelection(0, 'ArrowLeft', 4, 10)).toBe(0)
    expect(moveSelection(2, 'ArrowLeft', 4, 10)).toBe(1)
    expect(moveSelection(9, 'ArrowRight', 4, 10)).toBe(9)
  })

  it('上下移动按列数步进并在边界夹取', () => {
    expect(moveSelection(0, 'ArrowDown', 4, 10)).toBe(4)
    expect(moveSelection(4, 'ArrowUp', 4, 10)).toBe(0)
    // 最后一行不足一列:向下夹取到末尾
    expect(moveSelection(8, 'ArrowDown', 4, 10)).toBe(9)
  })

  it('Home/End 到首尾,PageUp/PageDown 翻三行', () => {
    expect(moveSelection(5, 'Home', 4, 10)).toBe(0)
    expect(moveSelection(5, 'End', 4, 10)).toBe(9)
    expect(moveSelection(9, 'PageUp', 4, 20)).toBe(0)
    expect(moveSelection(0, 'PageDown', 4, 20)).toBe(12)
  })

  it('无选中时从首项开始;空列表返回 -1;未知按键保持原值', () => {
    expect(moveSelection(-1, 'ArrowRight', 4, 5)).toBe(0)
    expect(moveSelection(-1, 'ArrowRight', 4, 0)).toBe(-1)
    expect(moveSelection(3, 'Enter', 4, 5)).toBe(3)
  })
})
