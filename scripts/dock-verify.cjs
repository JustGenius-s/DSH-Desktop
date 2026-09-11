/**
 * 验证上游新版（未打 Dock patch）是否仍存在「Dock 图标消失」问题。
 *
 * 复刻 HEAD 的 desktop-overlays.ts 真实调用序列：
 *   openOverlay → applyChrome(win, chrome, true)
 *               → applyAlwaysOnTop(win, false)   // alwaysOnTop 未指定时的初始分支
 *               → win.setVisibleOnAllWorkspaces(false)
 *
 * 100ms 轮询 dock.isVisible()，只在变化时打印。
 *
/**
 * 用法（DSH 沙盒里必须带 no-sandbox 三件套）：
 *   ./node_modules/.bin/electron scripts/dock-verify.cjs [variant]
 *     variant = off      applyAlwaysOnTop(win, false)：alwaysOnTop 未指定时的初始分支（默认）
 *     variant = on       applyAlwaysOnTop(win, true)：插件指定 alwaysOnTop: true 时的路径
 *     variant = none     不建 overlay，作对照
 */
const { app, BrowserWindow } = require('electron')

// DSH 沙盒环境禁掉了 GPU/沙箱子进程，关掉避免 FATAL。
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')

const VARIANTS = ['off', 'on', 'none']
const VARIANT = VARIANTS.includes(process.argv[2]) ? process.argv[2] : 'off'
const t0 = Date.now()
let last = null

function log(msg) {
  console.log(`+${String(Date.now() - t0).padStart(6)}ms  ${msg}`)
}
function tick(tag) {
  const v = app.dock.isVisible()
  if (v !== last) {
    log(`dock.isVisible ${String(last)} -> ${v}   [${tag}]`)
    last = v
  }
}

/** HEAD 的 applyAlwaysOnTop，逐行照抄。 */
function applyAlwaysOnTop(win, enabled) {
  if (enabled) {
    if (process.platform === 'darwin') win.setAlwaysOnTop(true, 'screen-saver')
    else win.setAlwaysOnTop(true)
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } else {
    win.setAlwaysOnTop(false)
    win.setVisibleOnAllWorkspaces(false)
  }
}

/** HEAD 的 openOverlay 建窗参数（关键字段）。 */
function openOverlayLikeDsh() {
  const win = new BrowserWindow({
    width: 120,
    height: 120,
    transparent: true,
    frame: false,
    type: 'panel',
    alwaysOnTop: false,
    focusable: false,
    show: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    hiddenInMissionControl: true,
    backgroundColor: '#00000000',
  })
  win.setTitle('')
  win.setFocusable(false)
  // 复刻 HEAD 的 applyChrome(win, chrome, true)：
  //   on  → 插件给了 alwaysOnTop: true
  //   off → 没给，走 `else if (initial) applyAlwaysOnTop(win, false)` 分支
  applyAlwaysOnTop(win, VARIANT === 'on')
  win.loadURL('data:text/html,<body style="background:rgba(255,0,0,.5);margin:0"></body>')
  win.once('ready-to-show', () => {
    win.showInactive()
    log('overlay showInactive')
    tick('post-overlay-show')
  })
  return win
}

app.whenReady().then(() => {
  tick('whenReady')

  const main = new BrowserWindow({
    width: 480,
    height: 320,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#151517',
  })
  main.once('ready-to-show', () => {
    tick('pre-main-show')
    main.show()
    tick('post-main-show')
    if (VARIANT !== 'none') setTimeout(() => openOverlayLikeDsh(), 800)
  })
  main.webContents.on('did-finish-load', () => tick('did-finish-load'))
  void main.loadURL('data:text/html,<body style="background:#151517;color:#fff;font:20px sans-serif;padding:30px">main</body>')

  const poll = setInterval(() => tick('poll'), 100)
  setTimeout(() => clearInterval(poll), 12_000)
  setTimeout(() => {
    log(`FINAL variant=${VARIANT} dock.isVisible=${app.dock.isVisible()}`)
    app.quit()
  }, 13_000)
})
