/**
 * 模拟 DSH-Desktop 启动：splash(frameless) → 主窗(hiddenInset)，
 * 全程 100ms 轮询 dock.isVisible，找出消失时刻。
 */
const { app, BrowserWindow } = require('electron')

const t0 = Date.now()
let last = null
function log(msg) {
  console.log(`+${String(Date.now() - t0).padStart(6)}ms  ${msg}`)
}
function tick(tag) {
  const v = app.dock.isVisible()
  if (v !== last) {
    log(`VISIBLE ${last} -> ${v}  (${tag})`)
    last = v
  }
}

app.whenReady().then(() => {
  app.setActivationPolicy('regular')
  log('whenReady set regular')
  setInterval(() => tick('poll'), 100)

  const splash = new BrowserWindow({
    width: 880,
    height: 600,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: '#151517',
  })
  splash.once('ready-to-show', () => {
    tick('pre-splash-show')
    splash.show()
    tick('post-splash-show')
    // old code path: only setActivationPolicy
    app.setActivationPolicy('regular')
    tick('post-splash-setPolicy')
  })
  void splash.loadURL('data:text/html,<body style="background:#151517;color:#fff;font:24px sans-serif;padding:40px">splash</body>')

  setTimeout(() => {
    splash.close()
    const main = new BrowserWindow({
      width: 1280,
      height: 800,
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#151517',
      show: false,
    })
    main.once('ready-to-show', () => {
      tick('pre-main-show')
      main.show()
      tick('post-main-show')
      app.setActivationPolicy('regular')
      void app.dock.show()
      tick('post-main-dock.show')
    })
    void main.loadURL('data:text/html,<body style="background:#151517;color:#fff;font:24px sans-serif;padding:40px">main</body>')
  }, 3000)

  setTimeout(() => {
    log(`final visible=${app.dock.isVisible()}`)
    app.quit()
  }, 8000)
})
