/**
 * DSH-Decktop Electron 主进程。
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

/** DSH 深色主题的窗口底色（`--dsw-alias-bg-base` = rgb(21, 21, 23)），让窗口顶部与 DSH UI 无缝融合。 */
const DSH_BG = '#151517'

let dshProcess: ChildProcess | null = null
let mainWindow: BrowserWindow | null = null
let stopping = false

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'DSH-Decktop',
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    // 隐藏 macOS 原生标题栏、保留红绿灯按钮，让窗口顶部直接露出 DSH 深色底色。
    titleBarStyle: 'hiddenInset',
    backgroundColor: DSH_BG,
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
  // DSH 网页加载完成后注入顶部拖拽条与红绿灯避让样式（隐藏原生标题栏后必需）。
  win.webContents.on('did-finish-load', () => {
    void applyTitleBarChrome(win)
  })
  void win.loadURL(url)
  return win
}

/**
 * 隐藏原生标题栏后，把 DSH 侧栏顶部的 logo 行当作“标题栏”拖拽区，并给其中
 * 的交互控件标 `no-drag`，让红绿灯按钮悬浮其上、互不遮挡，窗口仍可拖动。
 * DSH 是运行时升级的 web 包，类名是 hash 过的，故用属性选择器尽量兼容。
 */
async function applyTitleBarChrome(win: BrowserWindow): Promise<void> {
  const wc = win.webContents
  if (wc.isDestroyed()) return

  // 侧栏顶部行（logoRow）作为可拖拽区域；其中的按钮/链接保持可点击。
  // 红绿灯按钮约占左上角 28px 高，给 logo 行顶部留出空间，避免按钮贴得太近。
  // DSH 的组件样式在运行时才注入，可能盖过我方样式，故用 !important 强制。
  // 属性选择器 [class*='logoRow'] 匹配 hash 前缀 + 稳定的 camelCase 类名。
  await wc.insertCSS(`
    [class*='logoRow'] { -webkit-app-region: drag; margin-top: 20px !important; }
    [class*='logoRow'] button,
    [class*='logoRow'] a,
    [class*='logoRow'] [role='button'] { -webkit-app-region: no-drag; }

    /* logo 行上方因 margin-top 留出的空隙：用伪元素做成顶部可拖拽条，恢复窗口拖动/双击热区 */
    :has(> [class*='logoRow']) { position: relative; }
    :has(> [class*='logoRow'])::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 40px;
      -webkit-app-region: drag;
    }
  `).catch(() => {})
}

/** 启动/安装期间的 splash 窗口：本地静态页，进度条由 CSS 动画驱动，文字靠主进程更新。 */
function createSplash(): BrowserWindow {
  const win = new BrowserWindow({
    width: 880,
    height: 600,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: DSH_BG,
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
  console.error(`[DSH-Decktop] ${title}: ${message}`)
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
    reportError('DSH-Decktop', `更新失败：${err instanceof Error ? err.message : String(err)}`)
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
    reportError('DSH-Decktop', `无法分配端口：${err instanceof Error ? err.message : String(err)}`)
    app.quit()
    return
  }

  const splash = createSplash()

  let bin: string
  try {
    bin = await ensureDshInstalled((message) => setSplashStatus(splash, message))
  } catch (err) {
    splash.close()
    reportError('DSH-Decktop', `无法准备 DSH 运行时：${err instanceof Error ? err.message : String(err)}`)
    app.quit()
    return
  }

  setSplashStatus(splash, '正在启动 DSH 服务…')
  dshProcess = startDsh(port, bin)
  dshProcess.on('exit', (code, signal) => {
    // 主动退出（before-quit 已置 stopping）不弹错误框。
    if (stopping) return
    if (mainWindow && !mainWindow.isDestroyed()) {
      reportError('DSH-Decktop', `DSH 服务意外退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`)
    }
  })

  try {
    await waitForReady(port)
  } catch (err) {
    splash.close()
    reportError('DSH-Decktop', err instanceof Error ? err.message : String(err))
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
