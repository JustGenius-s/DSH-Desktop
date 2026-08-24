/**
 * DSH-Desktop Electron 主进程。
 *
 * 职责：应用就绪后拉起一个 dsh web host 子进程，等它就绪，再开一个
 * BrowserWindow 指向 `http://127.0.0.1:<port>`；退出时负责回收子进程。
 * 运行中可热重启网页服务（不关桌面壳），让插件配置 / DSH 运行时立刻生效。
 * 前端是纯 web SPA，host 是纯 node 服务，本进程只做编排。
 *
 * 首启可能要先装外置 DSH 运行时（几十秒），期间用一个 splash 窗口给
 * 用户进度反馈，装完/就绪后再过渡到主窗口。
 */

import { type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, session, shell } from 'electron'
import { DSH_HOST, READY_TIMEOUT_MS, findFreePort, startDsh, stopDsh, waitForPortFree, waitForReady, type DshHost } from './dsh-host'
import { registerDshWebHost, restartDshWeb } from './dsh-lifecycle'
import {
  markPluginConfigApplied,
  notifyPluginConfigChanged,
  pausePluginConfigWatch,
  startPluginConfigWatch,
  stopPluginConfigWatch,
} from './plugin-config-watch'
import { ensureDshInstalled, installedDshBin } from './runtime-manager'
import { extractFailedPlugins, getProfileBundles, quarantineBundle, restoreQuarantined } from './plugin-quarantine'
import { checkDesktopUpdates, setupDesktopBridge } from './desktop-bridge'
import { setupDesktopNotify } from './desktop-notify'
import { closeAllOverlays, setupDesktopOverlays } from './desktop-overlays'
import { refreshDesktopSeats, setupDesktopSeats } from './desktop-seats'
import { installDesktopPlugin } from './plugin-installer'
import { focusMainWindow, setWindowRole } from './windows'

// 必须在 ready 之前改路径 / 抢锁。unpackaged 的 `electron .` 和已安装的
// `.app` 共用 package.json 名 `dsh-desktop`，默认会写进同一份
// Application Support/dsh-desktop（SingletonLock、GPU cache、通知）。
// 开发态单独开一份，避免验证新代码时把正在用的桌面壳打坏。
if (!app.isPackaged) {
  app.setPath('userData', join(__dirname, '..', '.userdata-dev'))
}

const isPrimaryInstance = app.isPackaged ? app.requestSingleInstanceLock() : true
if (!isPrimaryInstance) {
  app.quit()
} else if (app.isPackaged) {
  app.on('second-instance', () => {
    focusMainWindow()
  })
}

/** DSH 深色主题的窗口底色（`--dsw-alias-bg-base` = rgb(21, 21, 23)），让窗口顶部与 DSH UI 无缝融合。 */
const DSH_BG = '#151517'

/** 启动失败时「隔离插件 + 重启」的最大轮数，防止归因错误导致死循环。 */
const MAX_QUARANTINE_RESTARTS = 3

let dshProcess: ChildProcess | null = null
let dshBin: string | undefined
let dshPort: number | null = null
let mainWindow: BrowserWindow | null = null
let dshOrigin: string | null = null
let stopping = false
let restartingWeb = false
let restartInFlight: Promise<void> | null = null

/**
 * 把链接交给系统默认浏览器打开。只放行 http/https：AI 输出里可能出现
 * `file:`、自定义协议等任意 scheme，直接 openExternal 等于让网页调起
 * 本机任一协议处理器，必须白名单。返回是否已受理，未受理由调用方拦截。
 */
function openInDefaultBrowser(rawUrl: string): boolean {
  let protocol = ''
  try {
    protocol = new URL(rawUrl).protocol
  } catch {
    return false
  }
  if (protocol !== 'http:' && protocol !== 'https:') return false
  shell.openExternal(rawUrl).catch((err: unknown) => {
    console.error(`[DSH-Desktop] 用默认浏览器打开链接失败：${rawUrl}`, err)
  })
  return true
}

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
      // 向 DSH 网页暴露 window.dshDesktop（updates / seats / notify / overlays）。
      preload: join(__dirname, 'preload.js'),
    },
  })

  setWindowRole(win, 'main')
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => {
    refreshDesktopSeats()
    win.show()
    // 首次显示窗口时系统可能按保存的 UIElement endowment 降级策略（见
    // enforceRegularDockPolicy），在 show 之后再断言一次以覆盖。
    enforceRegularDockPolicy()
  })
  win.on('closed', () => {
    if (mainWindow !== win) return
    mainWindow = null
    // overlay 不能单独续命应用：主窗口关了就把桌宠一起收掉。
    closeAllOverlays()
    if (!stopping) app.quit()
  })
  // DSH 网页加载完成后注入顶部拖拽条与红绿灯避让样式（隐藏原生标题栏后必需）。
  win.webContents.on('did-finish-load', () => {
    void applyTitleBarChrome(win)
    enforceRegularDockPolicy()
  })
  // AI 输出的超链接不在壳内开新窗口、也不把应用窗口整页跳走：
  // 1. target=_blank / window.open（AI 链接的常态）→ 拦截新窗口，交给默认浏览器；
  // 2. 页面发起的整页导航：同源放行（SPA 路由 / 热重启刷新），跨源改为外开。
  //    主进程 loadURL 不触发 will-navigate，热重启换端口不受影响。
  // 两者都必须在 loadURL 之前挂上，避免首帧点击打空。
  const isSameOrigin = (target: string): boolean => {
    if (dshOrigin === null) return false
    try {
      return new URL(target).origin === new URL(dshOrigin).origin
    } catch {
      return false
    }
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!openInDefaultBrowser(url)) console.warn(`[DSH-Desktop] 已拦截不受支持的弹窗链接：${url}`)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isSameOrigin(url)) return
    event.preventDefault()
    if (!openInDefaultBrowser(url)) console.warn(`[DSH-Desktop] 已拦截跨源导航：${url}`)
  })
  void win.loadURL(url)
  return win
}

/** macOS 启动期 Dock 策略守卫：系统会在「应用首个窗口首次显示」这一时刻，
 *  按保存的 UIElement endowment 把应用降级为 accessory 策略（实测启动后约
 *  4s、主窗口 ready-to-show 时发生），Dock 图标随之消失。因此在各关键节点
 *  重复断言 regular，覆盖这次降级；断言幂等、开销可忽略。 */
function enforceRegularDockPolicy(): void {
  if (process.platform === 'darwin') app.setActivationPolicy('regular')
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
  setWindowRole(win, 'splash')
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

/** 从 dsh 子进程输出里抽出真正有用的失败原因（优先 Error: / YAMLException，而不是栈底）。 */
function summarizeDshFailure(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const errorLine = lines.find((line) => line.startsWith('Error:') || line.includes('YAMLException:'))
  if (errorLine !== undefined) return errorLine
  return lines.slice(-5).join('\n')
}

/** 等 dsh 就绪或进程退出；waitForReady 超时返回 'timeout'。 */
async function waitExitOrReady(host: DshHost, port: number): Promise<'ready' | 'exited' | 'timeout'> {
  const controller = new AbortController()
  const exited = new Promise<'exited'>((resolveExit) => host.child.once('exit', () => resolveExit('exited')))
  const ready = waitForReady(port, READY_TIMEOUT_MS, controller.signal).then(
    () => 'ready' as const,
    () => 'timeout' as const,
  )
  const result = await Promise.race([exited, ready])
  controller.abort()
  return result
}

function attachExitHandler(host: DshHost): void {
  host.child.on('exit', (code, signal) => {
    // 主动退出、热重启换进程、或隔离重试的旧进程不弹错误框。
    if (stopping || restartingWeb || dshProcess !== host.child) return
    if (mainWindow && !mainWindow.isDestroyed()) {
      reportError('DSH-Desktop', `DSH 服务意外退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`)
    }
  })
}

interface BootResult {
  ready: boolean
  port: number
  quarantined: string[]
  lastOutput: string
}

/**
 * 拉起 dsh web：失败则归因隔离插件并换端口重试。
 * 成功时更新模块级 dshProcess / dshPort / dshOrigin。
 */
async function bootDsh(initialPort: number, bin: string, onStatus?: (message: string) => void): Promise<BootResult> {
  const quarantined: string[] = []
  let lastOutput = ''
  let port = initialPort

  for (let attempt = 0; attempt <= MAX_QUARANTINE_RESTARTS; attempt++) {
    if (attempt > 0) {
      port = await findFreePort()
      onStatus?.('已隔离故障插件，正在重启 DSH 服务…')
    }
    const host = startDsh(port, bin)
    dshProcess = host.child
    attachExitHandler(host)

    const outcome = await waitExitOrReady(host, port)
    if (outcome === 'ready') {
      dshPort = port
      dshOrigin = `http://${DSH_HOST}:${port}`
      return { ready: true, port, quarantined, lastOutput }
    }

    lastOutput = host.recentOutput()
    if (outcome === 'timeout' && host.child.exitCode === null) {
      await stopDsh(host.child)
    }
    if (dshProcess === host.child) dshProcess = null

    const disabled = extractFailedPlugins(lastOutput, getProfileBundles()).filter((name) =>
      quarantineBundle(name, lastOutput),
    )
    if (disabled.length === 0) break
    quarantined.push(...disabled)
    console.warn(`[DSH-Desktop] 已隔离导致启动失败的插件：${disabled.join(', ')}`)
  }

  return { ready: false, port, quarantined, lastOutput }
}

/** 热重启网页服务：杀掉当前 dsh 子进程，尽量复用原端口，再刷新主窗口。壳不退出。 */
async function restartDshWebImpl(): Promise<void> {
  if (stopping) throw new Error('应用正在退出')
  const bin = installedDshBin() ?? dshBin
  if (bin === undefined) throw new Error('DSH 运行时尚未就绪')
  dshBin = bin
  if (restartInFlight !== null) return restartInFlight

  const run = (async () => {
    restartingWeb = true
    const resumeWatch = pausePluginConfigWatch()
    try {
      closeAllOverlays()
      const previous = dshProcess
      dshProcess = null
      if (previous !== null) await stopDsh(previous)

      let port = dshPort
      if (port !== null) {
        try {
          await waitForPortFree(port)
        } catch {
          port = await findFreePort()
        }
      } else {
        port = await findFreePort()
      }

      const result = await bootDsh(port, bin)
      if (!result.ready) {
        const tail = result.lastOutput.trim().split('\n').slice(-5).join('\n')
        reportError('DSH-Desktop', tail.length > 0 ? `DSH 服务重启失败：\n${tail}` : 'DSH 服务重启失败')
        throw new Error('DSH 服务重启失败')
      }

      markPluginConfigApplied()

      const origin = dshOrigin
      const win = mainWindow
      if (origin !== null && win !== null && !win.isDestroyed()) {
        await win.loadURL(origin)
      }
    } finally {
      restartingWeb = false
      resumeWatch()
    }
  })()

  restartInFlight = run
  try {
    await run
  } finally {
    if (restartInFlight === run) restartInFlight = null
  }
}

registerDshWebHost({
  restart: restartDshWebImpl,
  isReady: () => dshBin !== undefined && dshOrigin !== null && !stopping,
})

async function hardenChromiumStorage(): Promise<void> {
  const sessions = [session.defaultSession, session.fromPartition('persist:dsh-overlay')]
  for (const ses of sessions) {
    try {
      await ses.clearStorageData({ storages: ['serviceworkers'] })
    } catch {
      // A leftover SW LevelDB from a previous crash is noisy but not fatal.
    }
  }
}

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return
  // macOS 会根据启动上下文决定本应用的激活策略：一旦曾经以后台方式拉起过
  // （open -g、Spotlight、登录项、app.relaunch 直拉等），FrontBoard 会保存
  // UIElement endowment，后续每次启动都注入，导致应用以 accessory 策略运行、
  // Dock 图标不出现（实测 `open -n` 全新实例也复现）。这里在 ready 后先断言
  // 一次 regular；系统还会在主窗口首次显示时再降级一次，由
  // enforceRegularDockPolicy 在 ready-to-show / did-finish-load 覆盖。
  enforceRegularDockPolicy()
  // pnpm start 跑的是 Electron 二进制，菜单栏最左默认写 "Electron"；
  // 先改名，后面 setApplicationMenu 才显示 DSH-Desktop。
  app.setName('DSH-Desktop')
  await hardenChromiumStorage()

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
    dshBin = bin
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
  {
    const resume = pausePluginConfigWatch()
    try {
      await installDesktopPlugin()
    } finally {
      resume()
    }
  }

  setSplashStatus(splash, '正在启动 DSH 服务…')
  const boot = await bootDsh(port, bin, (message) => setSplashStatus(splash, message))

  if (!boot.ready) {
    splash.close()
    const tail = boot.lastOutput.trim().split('\n').slice(-5).join('\n')
    reportError('DSH-Desktop', tail.length > 0 ? `DSH 服务启动失败：\n${tail}` : 'DSH 服务未能就绪')
    app.quit()
    return
  }

  splash.close()
  markPluginConfigApplied()
  // 四族 IPC 必须在 loadURL 之前挂上，避免插件首帧 contribute / notify / open 打空。
  setupDesktopBridge()
  setupDesktopSeats()
  setupDesktopNotify()
  setupDesktopOverlays(() => dshOrigin)
  mainWindow = createWindow(`http://${DSH_HOST}:${boot.port}`)
  startPluginConfigWatch()

  // 有插件被隔离时告知用户，并提供「恢复并重启」入口；恢复后只热重启网页
  // 服务，不关桌面壳。恢复后仍崩会被再次隔离。
  if (boot.quarantined.length > 0) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '已自动禁用故障插件',
      message: '以下插件导致 DSH 启动失败，已自动禁用：',
      detail:
        boot.quarantined.map((n) => `• ${n}`).join('\n') +
        '\n\n修复插件问题后可选择「恢复并重启服务」重新启用（桌面应用不会关闭）；若恢复后仍导致启动失败，会被再次自动禁用。',
      buttons: ['保持禁用', '恢复并重启服务'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response === 1) {
      restoreQuarantined(boot.quarantined)
      try {
        await restartDshWeb()
      } catch {
        // 失败已在 restart 路径里弹过错。
      }
    }
  }

  // 更新检查改为后台静默进行：桌面桥负责检测 + 轮询 + 通过 preload 暴露给
  // 网页；dsh-desktop-update 插件（由安装脚本装进 web profile）在侧栏设置
  // 按钮旁渲染更新徽章。安装脚本与首查都不阻塞窗口出现，失败只记日志。
  // 若这次才真正改了插件登记，走统一的「配置已变但未生效」弹窗——不强制。
  void (async () => {
    const resume = pausePluginConfigWatch()
    let installed
    try {
      installed = await installDesktopPlugin()
    } finally {
      resume()
    }
    if (installed.restartNeeded) await notifyPluginConfigChanged()
    await checkDesktopUpdates()
  })()

  // 兜底：启动序列全部结束后再断言一次 regular，防御系统在更晚时刻
  // 再次按保存的 endowment 降级（幂等，开销可忽略）。
  setTimeout(() => enforceRegularDockPolicy(), 10_000)
})

app.on('activate', () => {
  // Dock / 托盘激活时 AppKit 常把最上层 panel overlay 当成前台窗。
  focusMainWindow()
})

app.on('before-quit', () => {
  stopping = true
  stopPluginConfigWatch()
  closeAllOverlays()
  const p = dshProcess
  dshProcess = null
  if (p && !p.killed) {
    p.kill('SIGTERM')
  }
})

app.on('window-all-closed', () => {
  app.quit()
})
