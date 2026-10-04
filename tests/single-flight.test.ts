/**
 * 单飞(重入)保护单测:并发去重、锁释放(成功/抛错)、结果透传。
 * 纯逻辑,无 Electron/DOM 依赖。
 */
import { describe, expect, it, vi } from 'vitest'
import { createSingleFlight } from '../src/shared/single-flight'

describe('createSingleFlight(重入保护)', () => {
  it('正常调用透传任务结果', async () => {
    const once = createSingleFlight<string>()
    expect(await once(async () => 'ok')).toBe('ok')
  })

  it('在途期间的重复调用立即返回 null,且不执行任务', async () => {
    const once = createSingleFlight<string>()
    let resolve!: (value: string) => void
    const task = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r
        })
    )

    const first = once(task)
    const second = once(task)
    expect(await second).toBeNull()

    resolve('done')
    expect(await first).toBe('done')
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('完成后锁被释放,可再次调用(连续两次选择目录都有效)', async () => {
    const once = createSingleFlight<number>()
    expect(await once(async () => 1)).toBe(1)
    expect(await once(async () => 2)).toBe(2)
  })

  it('任务抛错时锁同样释放', async () => {
    const once = createSingleFlight<string>()
    await expect(
      once(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(await once(async () => 'after')).toBe('after')
  })

  it('并发三路调用只执行一次,其余返回 null', async () => {
    const once = createSingleFlight<string>()
    const task = async (): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return 'picked'
    }
    const results = await Promise.all([once(task), once(task), once(task)])
    expect(results.filter((r) => r === 'picked')).toHaveLength(1)
    expect(results.filter((r) => r === null)).toHaveLength(2)
  })
})
