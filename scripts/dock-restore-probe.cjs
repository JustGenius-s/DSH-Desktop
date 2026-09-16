/**
 * 复现「activationPolicy 已是 regular，但 Dock 瓷砖被藏掉」：
 * dock.hide() → setActivationPolicy('regular') 是否仍 invisible；
 * 再 dock.show() 是否恢复。
 */
const { app, BrowserWindow } = require('electron')

const t0 = Date.now()
function log(msg) {
  console.log(`+${String(Date.now() - t0).padStart(6)}ms  ${msg}`)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 240, show: false })
  win.once('ready-to-show', () => win.show())
  void win.loadURL('data:text/html,<h1>dock restore probe</h1>')

  await new Promise((r) => setTimeout(r, 500))
  log(`initial visible=${app.dock.isVisible()}`)

  app.dock.hide()
  await new Promise((r) => setTimeout(r, 300))
  log(`after hide visible=${app.dock.isVisible()}`)

  app.setActivationPolicy('regular')
  await new Promise((r) => setTimeout(r, 300))
  log(`after setActivationPolicy(regular) only visible=${app.dock.isVisible()}`)

  const shown = app.dock.show()
  await shown
  await new Promise((r) => setTimeout(r, 300))
  log(`after dock.show() visible=${app.dock.isVisible()} promiseSettled=yes`)

  app.quit()
})
