/**
 * 瓦片解码并发限流工具测试(§4.4 / §12 解码并发上限)。
 */
import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from '../src/shared/concurrency'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('mapWithConcurrency', () => {
  it('结果顺序与输入一致', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10)
    expect(out).toEqual([10, 20, 30, 40, 50])
  })

  it('并发数不超过上限', async () => {
    let active = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (n) => {
      active++
      peak = Math.max(peak, active)
      await delay(10)
      active--
      return n
    })
    expect(peak).toBe(3)
  })

  it('并发数小于任务数时全部执行', async () => {
    const done: number[] = []
    await mapWithConcurrency([1, 2, 3], 5, async (n) => {
      await delay(5)
      done.push(n)
      return n
    })
    expect(done).toEqual([1, 2, 3])
  })

  it('空输入返回空数组', async () => {
    const out = await mapWithConcurrency([], 4, async () => 1)
    expect(out).toEqual([])
  })

  it('并发上限为 0 时返回空数组(不执行任务)', async () => {
    let called = 0
    const out = await mapWithConcurrency([1, 2], 0, async (n) => {
      called++
      return n
    })
    expect(out).toEqual([])
    expect(called).toBe(0)
  })

  it('单个任务失败会整体拒绝', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      })
    ).rejects.toThrow('boom')
  })
})
