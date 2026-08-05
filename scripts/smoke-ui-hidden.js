/**
 * 冒烟脚本(诊断/回归用):验证 [hidden] { display:none !important } 修复
 * 在显式 display:flex 的元素上仍能隐藏(placeholder 提示不消失的 bug)。
 */
const { app, BrowserWindow } = require('electron')

const PAGE = `<!doctype html><html><head><style>
.placeholder {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
}
[hidden] { display: none !important; }
</style></head><body>
<div id="placeholder" class="placeholder">PLACEHOLDER TEXT</div>
<div id="canvas">CANVAS</div>
</body></html>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('data:text/html,' + encodeURIComponent(PAGE))
  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const ph = document.getElementById('placeholder')
      const before = getComputedStyle(ph).display
      ph.hidden = true
      const afterHidden = getComputedStyle(ph).display
      const afterAttr = ph.hasAttribute('hidden')
      ph.hidden = false
      const afterShown = getComputedStyle(ph).display
      return { before, afterHidden, afterAttr, afterShown }
    })()
  `)
  console.log('=== UI HIDDEN SMOKE ===')
  console.log(JSON.stringify(result, null, 2))
  app.exit(0)
})
