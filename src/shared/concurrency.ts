/**
 * 并发工具(§4.4 超大图瓦片解码限流):
 * 以固定并发上限执行异步任务并保持输入顺序,避免瞬间并发解码过多
 * 瓦片导致 CPU/内存峰值(§12 解码并发上限)。
 */

/**
 * 以 maxConcurrent 并发上限映射异步任务,结果顺序与输入一致。
 * 空输入或 maxConcurrent <= 0 时返回空数组。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  maxConcurrent: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  if (items.length === 0 || maxConcurrent <= 0) return []
  let next = 0
  const workers = Array.from({ length: Math.min(maxConcurrent, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}
