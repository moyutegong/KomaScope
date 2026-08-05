/**
 * 冒烟脚本(诊断用,不属于应用代码):
 * 复刻生产代码的 komascope-file:// 协议注册与 preload 的 toFileUrl,
 * 在真实渲染进程(file:// 安全上下文)中验证:fetch 自定义协议 → createImageBitmap 解码,
 * 覆盖纯 ASCII / 空格 / 括号方括号 / 中文 文件路径。
 */
const { app, BrowserWindow, protocol, net } = require('electron')
const { pathToFileURL } = require('url')
const path = require('path')

// ---- 复刻生产逻辑(src/main/ipc.ts registerFileSchemePrivilege + registerFileProtocol) ----
// 必须在 app ready 之前声明特权,否则渲染进程 fetch 自定义协议失败(TypeError: Failed to fetch)
protocol.registerSchemesAsPrivileged([
  // 注意:不能启用 standard——standard scheme 会把盘符 F: 解析成 host,
  // 导致 komascope-file:///F:/path 变成 komascope-file://f/path(路径损坏)
  { scheme: 'komascope-file', privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

function registerFileProtocol() {
  protocol.handle('komascope-file', async (request) => {
    try {
      const url = new URL(request.url)
      let filePath = decodeURIComponent(url.pathname)
      if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1)
      const target = pathToFileURL(filePath).toString()
      console.log('[handler] url:', request.url)
      console.log('[handler] filePath:', filePath)
      console.log('[handler] target:', target)
      const res = await net.fetch(target)
      const headers = new Headers(res.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    } catch (e) {
      console.log('[handler] ERROR:', String(e))
      return new Response('handler error', { status: 500 })
    }
  })
}

// ---- 复刻生产逻辑(src/preload/index.ts toFileUrl) ----
function toFileUrl(p) {
  return 'komascope-file://' + encodeURI('/' + p.replace(/\\/g, '/'))
}

const testFiles = [
  'F:\\MyProject\\KomaScope\\testImg\\0003.jpg',
  'F:\\MyProject\\KomaScope\\testImg\\0002.webp',
  'F:\\MyProject\\KomaScope\\testImg\\(FF42) [Gekidoku Shoujo (ke-ta)] UNCENSKIN (Touhou Project) [Decensored]_2893079-0001.png',
  'C:\\Users\\yehew\\AppData\\Local\\Temp\\komascope-smoke\\测试 图片.webp'
]

app.whenReady().then(async () => {
  // 全局超时保护:任何环节卡住都强制退出
  setTimeout(() => {
    console.log('=== TIMEOUT ===')
    app.exit(2)
  }, 45000)

  registerFileProtocol()

  // 1) 主进程 net.fetch:验证协议 handler 本身
  const mainResults = []
  for (const p of testFiles) {
    const url = toFileUrl(p)
    try {
      const res = await net.fetch(url)
      mainResults.push({ file: p.split('\\').pop(), status: res.status, contentType: res.headers.get('content-type') })
    } catch (e) {
      mainResults.push({ file: p.split('\\').pop(), error: String(e) })
    }
  }

  // 2) 渲染进程:file:// 页面(安全上下文)执行 fetch + createImageBitmap
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await win.loadFile(path.join(__dirname, 'smoke-page.html'))
  const urls = testFiles.map(toFileUrl)
  const rendererResults = await win.webContents.executeJavaScript(`
    (async () => {
      const urls = ${JSON.stringify(urls)}
      const results = []
      for (const url of urls) {
        const out = { url, phase: 'fetch' }
        try {
          const res = await fetch(url)
          out.status = res.status
          out.contentType = res.headers.get('content-type')
          if (!res.ok) { out.phase = 'fetch-fail'; results.push(out); continue }
          out.phase = 'blob'
          const blob = await res.blob()
          out.blobSize = blob.size
          out.blobType = blob.type
          out.phase = 'decode'
          const bmp = await createImageBitmap(blob)
          out.bitmap = bmp.width + 'x' + bmp.height
          bmp.close()
          out.phase = 'done'
        } catch (e) {
          out.phase = out.phase + '-error'
          out.error = String((e && e.message) || e)
          out.errorName = e && e.name
        }
        results.push(out)
      }
      return results
    })()
  `)

  console.log('=== MAIN PROCESS net.fetch ===')
  console.log(JSON.stringify(mainResults, null, 2))
  console.log('=== RENDERER fetch+decode ===')
  console.log(JSON.stringify(rendererResults, null, 2))
  app.exit(0)
})
