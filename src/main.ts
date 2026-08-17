/**
 * DSH-Desktop Electron 主进程。
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
import { ensureDshInstalled } from './runtime-manager'
import { checkDesktopUpdates, setupDesktopBridge } from './desktop-bridge'
import { refreshDesktopSeats, setupDesktopSeats } from './desktop-seats'
import { installDesktopPlugin } from './plugin-installer'

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
    title: 'DSH-Desktop',
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    // 隐藏 macOS 原生标题栏、保留红绿灯按钮，让窗口顶部直接露出 DSH 深色底色。
    titleBarStyle: 'hiddenInset',
    backgroundColor: DSH_BG,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 向 DSH 网页暴露 window.dshDesktop（更新状态查询/操作），preload 自身零依赖。
      preload: join(__dirname, 'preload.js'),
    },
  })

  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => {
    refreshDesktopSeats()
    win.show()
  })
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
 * 隐藏原生标题栏后恢复窗口拖动热区。分三块，全部用 `-webkit-app-region`：
 *
 * 1. 侧栏顶部 logo 行（logoRow）：原有拖拽区，保留；其中按钮/链接标 `no-drag`。
 * 2. 中间列会话顶栏（ConversationRoot 的 `<header>`）：整行可拖，面包屑、
 *    标签页、右侧动作按钮全部标 `no-drag`，不影响菜单/按钮功能。
 * 3. 中间列顶部通条：会话顶栏在 hero/空会话态会隐藏（headerHidden），此时用
 *    中间列容器（centerCol）的 `::before` 伪元素补一条 40px 高的顶部拖拽带；
 *    顶栏显示时该伪元素压在其下方，不可点击但可拖动，不遮挡任何交互控件。
 *
 * DSH 是运行时升级的 web 包，类名是构建时 hash 的（形如 `wSkVaW_header`），
 * 故一律用 `[class*='xxx']` 属性选择器匹配稳定的 camelCase 后缀，并用
 * `!important` 防止运行时注入的样式覆盖。
 */
async function applyTitleBarChrome(win: BrowserWindow): Promise<void> {
  const wc = win.webContents
  if (wc.isDestroyed()) return

  const isMac = process.platform === 'darwin'
  // Windows 有原生标题栏，侧栏不必为红绿灯再留上边距。
  const macSidebarInset = isMac
    ? `
    [class*='logoRow'] { -webkit-app-region: drag; margin-top: 20px !important; }
    :has(> [class*='logoRow']) { position: relative; }
    :has(> [class*='logoRow'])::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 40px;
      -webkit-app-region: drag;
    }`
    : `
    [class*='logoRow'] { -webkit-app-region: drag; }`

  await wc.insertCSS(`
    /* ---- 1. 侧栏 logo 行：macOS 为红绿灯留白；Windows 贴顶 ---- */
    ${macSidebarInset}
    [class*='logoRow'] button,
    [class*='logoRow'] a,
    [class*='logoRow'] [role='button'] { -webkit-app-region: no-drag; }

    /* ---- 2. 中间列会话顶栏：整行可拖，交互控件除外 ----
       整个应用只有会话顶栏渲染 <header> 元素（详情面板等均为 div），
       故直接用元素选择器；headerHidden 时 display:none，规则自然失效。 */
    header[class*='header']:not([class*='headerHidden']) {
      -webkit-app-region: drag;
    }
    header[class*='header'] button,
    header[class*='header'] a,
    header[class*='header'] [role='button'],
    header[class*='header'] [role='tab'],
    header[class*='header'] input,
    header[class*='header'] select {
      -webkit-app-region: no-drag;
    }

    /* ---- 3. 中间列顶部通条：顶栏隐藏时（hero/空会话态）仍可拖动 ----
       伪元素压在顶栏/内容下层（z-index:0），不可点击但可拖动，不遮挡交互控件。 */
    [class*='centerCol'] { position: relative; }
    [class*='centerCol']::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 40px;
      z-index: 0;
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
  console.error(`[DSH-Desktop] ${title}: ${message}`)
  dialog.showErrorBox(title, message)
}

app.whenReady().then(async () => {
  // pnpm start 跑的是 Electron 二进制，菜单栏最左默认写 "Electron"；
  // 先改名，后面 setApplicationMenu 才显示 DSH-Desktop。
  app.setName('DSH-Desktop')

  let port: number
  try {
    port = await findFreePort()
  } catch (err) {
    reportError('DSH-Desktop', `无法分配端口：${err instanceof Error ? err.message : String(err)}`)
    app.quit()
    return
  }

  const splash = createSplash()

  let bin: string
  try {
    bin = await ensureDshInstalled((message) => setSplashStatus(splash, message))
  } catch (err) {
    splash.close()
    reportError('DSH-Desktop', `无法准备 DSH 运行时：${err instanceof Error ? err.message : String(err)}`)
    app.quit()
    return
  }

  // profile 已把插件写进 bundles 但 node_modules 链接缺失时，dsh 会在
  // loadProfile 阶段直接抛错。必须在 startDsh 之前修链接；profile 尚未
  // 初始化（首启）则安装脚本会跳过，等 host 就绪后再装一次。
  setSplashStatus(splash, '正在检查桌面插件…')
  await installDesktopPlugin()

  setSplashStatus(splash, '正在启动 DSH 服务…')
  dshProcess = startDsh(port, bin)
  dshProcess.on('exit', (code, signal) => {
    // 主动退出（before-quit 已置 stopping）不弹错误框。
    if (stopping) return
    if (mainWindow && !mainWindow.isDestroyed()) {
      reportError('DSH-Desktop', `DSH 服务意外退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`)
    }
  })

  try {
    await waitForReady(port)
  } catch (err) {
    splash.close()
    reportError('DSH-Desktop', err instanceof Error ? err.message : String(err))
    app.quit()
    return
  }

  splash.close()
  // 桥与席位 IPC 必须在 loadURL 之前挂上，避免插件首帧 contribute 打空。
  setupDesktopBridge()
  setupDesktopSeats()
  mainWindow = createWindow(`http://${DSH_HOST}:${port}`)

  // 更新检查改为后台静默进行：桌面桥负责检测 + 轮询 + 通过 preload 暴露给
  // 网页；dsh-desktop-update 插件（由安装脚本装进 web profile）在侧栏设置
  // 按钮旁渲染更新徽章。安装脚本与首查都不阻塞窗口出现，失败只记日志。
  void (async () => {
    await installDesktopPlugin()
    await checkDesktopUpdates()
  })()
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
