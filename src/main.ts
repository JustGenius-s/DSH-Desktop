/**
 * DSH-Desktop Electron 主进程。
 *
 * 职责：应用就绪后拉起一个 dsh web host 子进程，等它就绪，再开一个
 * BrowserWindow 指向 `dsh web` 打印的启动 URL（新运行时带 `?token=`）；
 * 退出时负责回收子进程。
 * 运行中可热重启网页服务（不关桌面壳），让插件配置 / DSH 运行时立刻生效。
 * 前端是纯 web SPA，host 是纯 node 服务，本进程只做编排。
 *
 * 首启可能要先装外置 DSH 运行时（几十秒），期间用一个 splash 窗口给
 * 用户进度反馈，装完/就绪后再过渡到主窗口。启动失败则进插件恢复页，
 * 由用户决定禁用哪些插件后重启（不自动隔离）。
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
import { openRecoveryWindow, recordBootFailure, setupPluginRecovery } from './plugin-recovery'
import { checkDesktopUpdates, setupDesktopBridge } from './desktop-bridge'
import { setupDesktopNotify } from './desktop-notify'
import { closeAllOverlays, setupDesktopOverlays } from './desktop-overlays'
import { refreshDesktopSeats, setupDesktopSeats } from './desktop-seats'
import { installDesktopPlugin } from './plugin-installer'
import { focusMainWindow, focusWindow, setWindowRole } from './windows'
import { titleBarChromeCSS } from './titlebar-chrome'

/**
 * 开发版可以和已安装版同时运行，但两者不能共享 Chromium 数据目录：
 * 已安装版占用 Service Worker 数据库时，开发版清理同一数据库会永久卡住。
 * DSH runtime/profile 仍按原约定共用 ~/.dsh，这里只隔离 Electron userData。
 *
 * 必须在 ready 之前改路径——上游注释里提到的「第二个窗口期」不存在，
 * setPath 在 ready 之后改就晚了。
 */
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'dsh-desktop-dev'))
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

let dshProcess: ChildProcess | null = null
let dshBin: string | undefined
let dshPort: number | null = null
let mainWindow: BrowserWindow | null = null
/**
 * 当前注入的标题栏 chrome 样式 key。
 *
 * `did-finish-load` 每次导航都会重跑，而旧 `<style>` 不随导航丢弃：
 * 不先移除就会在热重启/刷新后把同一套规则叠上一层又一层（每层都带
 * `!important`，面板的内缩 padding 会越叠越宽）。
 */
const titleBarChromeKeys: string[] = []
let dshOrigin: string | null = null
/** 打开窗口用的 URL：新运行时带启动 token，旧运行时等于 origin。 */
let dshLaunchUrl: string | null = null
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

function createWindow(url: string, splash: BrowserWindow): BrowserWindow {
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
    // 先显示并前置主窗口，再关 splash：全程保持至少一个可见窗口，避免出现
    // 「零可见窗口」空档，否则 macOS 会把前台还给 Finder / 上一个前台 App，
    // 主窗口就会显示在别的窗口后面。
    focusWindow(win)
    // 首窗显示也是 Dock 瓷砖最容易被系统压掉的时刻；show 之后立刻拉回。
    enforceRegularDockPolicy()
    if (!splash.isDestroyed()) splash.close()
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
 * 把标题栏 chrome（窗口拖动热区 + 浮层穿透切断）注入 DSH 网页。
 *
 * 规则本体在 `titlebar-chrome.ts` 的纯函数里，便于单测；这里只做注入。
 * 注入必须幂等：`did-finish-load` 会在每次 reload / 热重启后重跑，而旧的
 * `<style>` 不会随导航清掉，重复 insertCSS 会让规则无限堆积。
 */
async function applyTitleBarChrome(win: BrowserWindow): Promise<void> {
  const wc = win.webContents
  if (wc.isDestroyed()) return

  for (const key of titleBarChromeKeys) {
    if (wc.isDestroyed()) return
    try {
      await wc.removeInsertedCSS(key)
    } catch {
      // 上一轮注入的 key 在导航后已失效；没有可移除的样式，继续。
    }
  }
  titleBarChromeKeys.length = 0

  if (wc.isDestroyed()) return
  try {
    titleBarChromeKeys.push(await wc.insertCSS(titleBarChromeCSS(process.platform)))
  } catch {
    // 注入失败不阻断启动：窗口只是拖不动，页面功能不受影响。
  }
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

/** 等 dsh 就绪或进程退出；就绪时带回应 load 的 URL，超时返回 'timeout'。 */
async function waitExitOrReady(
  host: DshHost,
  port: number,
): Promise<{ kind: 'ready'; url: string } | { kind: 'exited' | 'timeout' }> {
  const controller = new AbortController()
  const exited = new Promise<{ kind: 'exited' }>((resolveExit) =>
    host.child.once('exit', () => resolveExit({ kind: 'exited' })),
  )
  const ready = waitForReady(host, port, READY_TIMEOUT_MS, controller.signal).then(
    (url) => ({ kind: 'ready' as const, url }),
    () => ({ kind: 'timeout' as const }),
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
  /** 打开窗口用的 URL：新运行时带启动 token，旧运行时等于 origin。 */
  launchUrl: string | null
  port: number
  lastOutput: string
}

/**
 * 拉起一次 dsh web，等它就绪。
 *
 * 单次启动、不自动隔离：失败时把输出带回给调用方，由启动流程走插件恢复页
 * （recordBootFailure → openRecoveryWindow），用户自己决定禁用哪些插件再
 * 重启。只有用户明确禁用才会改动 bundles。
 *
 * 成功时更新模块级 dshProcess / dshPort / dshOrigin / dshLaunchUrl。
 */
async function bootDsh(
  initialPort: number,
  bin: string,
): Promise<BootResult> {
  let port = initialPort
  const host = startDsh(port, bin)
  dshProcess = host.child
  attachExitHandler(host)

  const outcome = await waitExitOrReady(host, port)
  if (outcome.kind === 'ready') {
    dshPort = port
    dshOrigin = `http://${DSH_HOST}:${port}`
    dshLaunchUrl = outcome.url
    return { launchUrl: outcome.url, port, lastOutput: '' }
  }

  const lastOutput = host.recentOutput()
  if (outcome.kind === 'timeout' && host.child.exitCode === null) {
    await stopDsh(host.child)
  }
  if (dshProcess === host.child) dshProcess = null
  return { launchUrl: null, port, lastOutput }
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

      // 热重启失败不自动隔离插件（启动流程已改为「提示 + 恢复页由用户决定」）：
      // 把失败原因摊开给用户看，保持与首次启动一致的处理方式。
      const result = await bootDsh(port, bin)
      if (result.launchUrl === null) {
        const summary = summarizeDshFailure(result.lastOutput)
        const detail = summary === '' ? '' : `\n${summary}`
        reportError('DSH-Desktop', `DSH 服务重启失败${detail}`)
        throw new Error('DSH 服务重启失败')
      }

      markPluginConfigApplied()

      const launchUrl = dshLaunchUrl
      const win = mainWindow
      if (launchUrl !== null && win !== null && !win.isDestroyed()) {
        await win.loadURL(launchUrl)
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
      // Chromium 的清理调用在数据库被另一实例占用时可能既不成功也不 reject；
      // 超时后继续启动，避免 splash 尚未创建时整个应用无界面卡死。
      await withTimeout(ses.clearStorageData({ storages: ['serviceworkers'] }), 2_000)
    } catch {
      // A leftover SW LevelDB from a previous crash is noisy but not fatal.
    }
  }
}

function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolveTimeout, rejectTimeout) => {
    const timer = setTimeout(resolveTimeout, timeoutMs)
    promise.then(
      () => {
        clearTimeout(timer)
        resolveTimeout()
      },
      (err: unknown) => {
        clearTimeout(timer)
        rejectTimeout(err)
      },
    )
  })
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
  // 安装脚本自己会写 profile 配置，暂停监听免得刚装完就弹「配置已变」。
  {
    const resume = pausePluginConfigWatch()
    try {
      await installDesktopPlugin()
    } finally {
      resume()
    }
  }

  // 单次启动：不自动隔离。失败时归因（仅用于高亮）并跳转自建插件管理页，
  // 由用户决定禁用哪些插件后重启。只有用户明确禁用才会改动 bundles。
  setSplashStatus(splash, '正在启动 DSH 服务…')
  const boot = await bootDsh(port, bin)

  if (boot.launchUrl === null) {
    recordBootFailure(boot.lastOutput)
    // 启动失败统一进自建插件管理页：页面展示错误尾部 + 疑似元凶（归因命中时
    // 高亮）+ 全部插件开关 + 重启。用户禁用疑似插件后重启即可；归因未命中时
    // 页面仍能展示原始错误尾部并允许用户手动排查插件。
    setupPluginRecovery()
    splash.close()
    openRecoveryWindow()
    return
  }

  // 各 IPC 必须在 loadURL 之前挂上，避免插件首帧 contribute / notify / open 打空。
  setupDesktopBridge()
  setupDesktopSeats()
  setupDesktopNotify()
  setupDesktopOverlays(() => dshOrigin, () => dshLaunchUrl)
  setupPluginRecovery()
  // splash 不在这里关闭，交给 createWindow 的 ready-to-show 在显示主窗口后关闭，
  // 确保启动全程始终有可见窗口（见 createWindow 内注释）。
  mainWindow = createWindow(boot.launchUrl, splash)
  startPluginConfigWatch()

  // 更新检测已移到 dsh-desktop-update 插件的 host 半侧（跑在 dsh web host
  // 的 Node 进程里）。这里只把插件装齐，并把「执行」端点挂上；壳侧的兼容层
  // 检测负责喂 0.1.x 旧插件的更新徽章（见 desktop-bridge.ts 顶部说明）。
  // 安装不阻塞窗口出现，失败只记日志。
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
