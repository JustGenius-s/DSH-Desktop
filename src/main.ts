/**
 * DSH-Deck Electron 主进程。
 *
 * 职责：应用就绪后拉起一个 dsh web host 子进程，等它就绪，再开一个
 * BrowserWindow 指向 `http://127.0.0.1:<port>`；退出时负责回收子进程。
 * 前端是纯 web SPA，host 是纯 node 服务，本进程只做编排。
 *
 * 首启可能要先装外置 DSH 运行时（几十秒），期间用一个 splash 窗口给
 * 用户进度反馈，装完/就绪后再过渡到主窗口。
 */

import { type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { DSH_HOST, findFreePort, startDsh, waitForReady } from './dsh-host'
import { ensureDshInstalled, installedDshVersion, latestDshVersion, updateDsh } from './runtime-manager'

let dshProcess: ChildProcess | null = null
let mainWindow: BrowserWindow | null = null
let stopping = false

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'DSH-Deck',
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  void win.loadURL(url)
  return win
}

/** 启动/安装期间的 splash 窗口：本地静态页，进度条由 CSS 动画驱动，文字靠主进程更新。 */
function createSplash(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 300,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once('ready-to-show', () => win.show())
  void win.loadFile(join(app.getAppPath(), 'build', 'splash.html'))
  return win
}

/** 更新 splash 状态文字；页面未加载完时静默忽略（splash 自带默认文案）。 */
function setSplashStatus(win: BrowserWindow, text: string): void {
  if (win.isDestroyed()) return
  void win.webContents.executeJavaScript(`__setStatus(${JSON.stringify(text)})`).catch(() => {})
}

function reportError(title: string, message: string): void {
  console.error(`[DSH-Deck] ${title}: ${message}`)
  dialog.showErrorBox(title, message)
}

/** 自动检测 DSH 新版本；命中则弹窗，由用户手动触发升级。 */
async function promptUpdateIfAvailable(): Promise<void> {
  const installed = installedDshVersion()
  if (installed === undefined) return
  const latest = await latestDshVersion()
  if (latest === undefined || latest === installed) return

  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'DSH 更新',
    message: `检测到 DSH 新版本 ${latest}（当前 ${installed}）。`,
    buttons: ['立即更新', '稍后'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response !== 0) return

  try {
    await updateDsh(latest)
  } catch (err) {
    reportError('DSH-Deck', `更新失败：${err instanceof Error ? err.message : String(err)}`)
    return
  }

  const { response: restart } = await dialog.showMessageBox({
    type: 'info',
    title: 'DSH 更新',
    message: `已更新到 ${latest}，重启应用生效。`,
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
  })
  if (restart === 0) {
    app.relaunch()
    app.quit()
  }
}

app.whenReady().then(async () => {
  let port: number
  try {
    port = await findFreePort()
  } catch (err) {
    reportError('DSH-Deck', `无法分配端口：${err instanceof Error ? err.message : String(err)}`)
    app.quit()
    return
  }

  const splash = createSplash()

  let bin: string
  try {
    bin = await ensureDshInstalled((message) => setSplashStatus(splash, message))
  } catch (err) {
    splash.close()
    reportError('DSH-Deck', `无法准备 DSH 运行时：${err instanceof Error ? err.message : String(err)}`)
    app.quit()
    return
  }

  setSplashStatus(splash, '正在启动 DSH 服务…')
  dshProcess = startDsh(port, bin)
  dshProcess.on('exit', (code, signal) => {
    // 主动退出（before-quit 已置 stopping）不弹错误框。
    if (stopping) return
    if (mainWindow && !mainWindow.isDestroyed()) {
      reportError('DSH-Deck', `DSH 服务意外退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`)
    }
  })

  try {
    await waitForReady(port)
  } catch (err) {
    splash.close()
    reportError('DSH-Deck', err instanceof Error ? err.message : String(err))
    app.quit()
    return
  }

  splash.close()
  mainWindow = createWindow(`http://${DSH_HOST}:${port}`)

  if (app.isPackaged) void promptUpdateIfAvailable()
})

app.on('before-quit', () => {
  stopping = true
  const p = dshProcess
  dshProcess = null
  if (p && !p.killed) {
    p.kill('SIGTERM')
  }
})

app.on('window-all-closed', () => {
  app.quit()
})
