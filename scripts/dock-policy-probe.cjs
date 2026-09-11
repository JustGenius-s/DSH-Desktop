/**
 * Dock 策略探针（纯 CJS，可直接被 node_modules/.bin/electron 加载）。
 * 轮询 getActivationPolicy()，只在值变化时打印，精确定位降级时刻。
 *
 * 用法：
 *   node_modules/.bin/electron scripts/dock-policy-probe.cjs [holdSecs]
 * 后台拉起（模拟 open -g / Finder 后台打开）：
 *   node_modules/.bin/electron scripts/dock-policy-probe.cjs --bg
 *   —— 实际效果取决于谁拉起；也可以 `open -g` 一个打包好的 .app 复现。
 */
const { app, BrowserWindow, dialog } = require('electron')
// DSH 沙盒环境禁掉了 GPU/沙箱子进程，关掉避免 FATAL。
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')

const args = process.argv.slice(2)
const holdSecs = Number(args.find((a) => /^\d+$/.test(a)) ?? 20)

const t0 = Date.now()
let lastPolicy = '(init)'
// Electron 43 无 getActivationPolicy，用 dock.isVisible() 推断：降级为
// accessory/prohibited 时 Dock 图标消失，isVisible=false。
function currentPolicy() {
  if (typeof app.getActivationPolicy === 'function') return app.getActivationPolicy()
  if (process.platform !== 'darwin') return 'n/a'
  return app.dock.isVisible() ? 'regular' : 'accessory(probed-by-dock)'
}
function probe(tag, force) {
  const p = currentPolicy()
  if (force || p !== lastPolicy) {
    console.log(`[probe] +${String(Date.now() - t0).padStart(6)}ms  ${tag}: policy ${lastPolicy} -> ${p}`)
    lastPolicy = p
  }
}

app.whenReady().then(() => {
  probe('whenReady', true)
  if (process.platform === 'darwin') app.setActivationPolicy('regular')
  probe('whenReady+setRegular', true)

  const win = new BrowserWindow({ width: 640, height: 420, show: false })
  win.once('ready-to-show', () => {
    probe('ready-to-show(pre-show)', true)
    win.show()
    if (process.platform === 'darwin') app.setActivationPolicy('regular')
    probe('ready-to-show(post-show+setRegular)', true)
  })
  win.webContents.on('did-finish-load', () => {
    if (process.platform === 'darwin') app.setActivationPolicy('regular')
    probe('did-finish-load(+setRegular)', true)
  })

  const timer = setInterval(() => probe('poll'), 100)
  setTimeout(() => clearInterval(timer), holdSecs * 1000)

  setTimeout(() => {
    if (process.platform === 'darwin') app.setActivationPolicy('regular')
    probe('+10s setRegular', true)
  }, 10_000)

  void win.loadURL('about:blank')

  setTimeout(() => {
    probe('final', true)
    if (lastPolicy !== 'regular') {
      dialog.showErrorBox('Dock Probe', `最终策略=${lastPolicy}（Dock 不可见）。详见终端日志。`)
    }
    app.quit()
  }, holdSecs * 1000 + 500)
})
