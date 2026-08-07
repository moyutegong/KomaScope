/**
 * KomaScope 性能优化量化基准(纯计算模拟,node scripts/perf-benchmark.mjs)
 * 覆盖:rAF 渲染合并 / mip 显示缩放缓存 / 瓦片渐进显示 / setConfig IPC 防抖。
 * 不依赖 DOM,结果用于回归对比。
 */
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : (n / 1e4).toFixed(0) + '万')

/** 与 src/shared/transform-model.ts 的 mipLevelForScale 一致 */
function mipK(scale, dpr) {
  const effective = scale * dpr
  if (effective >= 1) return 0
  let k = 0
  let half = 0.5
  while (half >= effective && k < 5) {
    k++
    half /= 2
  }
  return k
}

const results = {}

// 1) rAF 合并:滚轮 100 事件/秒,60Hz 屏幕
const eventsPerSec = 100
const fps = 60
results.raf = {
  oldFramesPerSec: eventsPerSec,
  newFramesPerSec: fps,
  drawCallsReducedPct: Math.round((1 - fps / eventsPerSec) * 100)
}

// 2) mip 显示缓存:每帧 GPU 源采样像素
const mipCases = [
  ['8K 图 7680×4320 fitScreen@1080p(dpr=1, scale=0.25)', 7680 * 4320, mipK(0.25, 1)],
  ['1 亿像素图 10000×7000 fitScreen@4K 屏(dpr=2, scale=0.192)', 10000 * 7000, mipK(0.192, 2)],
  ['4K 图 3840×2160 fitScreen@4K 屏(dpr=2, scale=0.5)', 3840 * 2160, mipK(0.5, 2)],
  ['4K 图 3840×2160 fitWidth@1080p(dpr=1, scale=0.5)', 3840 * 2160, mipK(0.5, 1)]
]
results.mip = mipCases.map(([name, px, k]) => ({
  name,
  k,
  sourcePx: px,
  sampledPx: px / 2 ** (2 * k),
  reductionX: k > 0 ? Math.round(px / (px / 2 ** (2 * k))) : 1
}))

// 3) 渐进绘制:可见 30 块缺失瓦片,每块解码 50ms,4 并发
const tiles = 30
const per = 50
const conc = 4
results.progressive = {
  oldFirstPaintMs: Math.ceil(tiles / conc) * per,
  newFirstPaintMs: per,
  totalTiles: tiles
}

// 4) IPC 防抖:滚轮缩放期间 setConfig 频率
results.ipc = {
  oldPerSec: eventsPerSec,
  newPerSec: Math.round(1000 / 150),
  reducedPct: Math.round((1 - 1000 / 150 / eventsPerSec) * 100)
}

console.log('== rAF 渲染合并 ==')
console.log(
  `旧实现:每事件同步整帧重绘 → ${results.raf.oldFramesPerSec} 帧/秒(远超屏幕刷新率)`
)
console.log(`新实现:合并到下一帧 → ${results.raf.newFramesPerSec} 帧/秒上限,绘制调用减少 ${results.raf.drawCallsReducedPct}%`)

console.log('== mip 显示缩放缓存(每帧 GPU 采样像素)==')
for (const c of results.mip) {
  console.log(
    `${c.name.padEnd(46)} → k=${c.k} 采样 ${fmt(c.sourcePx)} → ${fmt(c.sampledPx)}` +
      (c.k > 0 ? ` (${c.reductionX}× 减少)` : ' (无需缓存,物理 1:1)')
  )
}

console.log('== 瓦片渐进显示 ==')
console.log(
  `旧实现:整批 ${results.progressive.totalTiles} 块全部解码后一次性显示 → 空白等待 ${results.progressive.oldFirstPaintMs}ms`
)
console.log(`新实现:单块完成即增量绘制 → 首块 ${results.progressive.newFirstPaintMs}ms 出现,画面渐进填充`)

console.log('== setConfig IPC 防抖 ==')
console.log(`旧实现:每事件 1 次 IPC → ${results.ipc.oldPerSec} 次/秒`)
console.log(`新实现:150ms 防抖合并 → ≤${results.ipc.newPerSec} 次/秒(减少 ${results.ipc.reducedPct}%)`)
