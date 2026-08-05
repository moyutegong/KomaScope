/**
 * 窗口图标生成脚本(一次性工具):用 lucide 的 image 图标 SVG(ISC 许可)
 * 在 Chromium 中渲染为 256×256 PNG,写入 resources/window-icon.png。
 * 用法:./node_modules/electron/dist/electron.exe scripts/generate-window-icon.js
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

// lucide "image" 图标(https://lucide.dev/icons/image),白色线条适配深色标题栏
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`

const SIZE = 256

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL(`data:text/html,<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>`)
  const svgDataUrl = 'data:image/svg+xml;base64,' + Buffer.from(SVG).toString('base64')
  const pngDataUrl = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const c = document.getElementById('c')
        const ctx = c.getContext('2d')
        ctx.clearRect(0, 0, ${SIZE}, ${SIZE})
        ctx.drawImage(img, 0, 0, ${SIZE}, ${SIZE})
        resolve(c.toDataURL('image/png'))
      }
      img.onerror = (e) => reject(String(e))
      img.src = ${JSON.stringify(svgDataUrl)}
    })
  `)
  const buf = Buffer.from(pngDataUrl.split(',')[1], 'base64')
  const out = path.join(__dirname, '..', 'resources', 'window-icon.png')
  fs.writeFileSync(out, buf)
  console.log('window icon written:', out, buf.length, 'bytes')
  app.exit(0)
})
