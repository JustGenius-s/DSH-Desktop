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

import { app, dialog, type BrowserWindow } from 'electron'
import type { ChildProcess } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { refreshDesktopSeats, refreshMenuLanguage, setupDesktopSeats } from './menus/seats'
import { showTestBanner } from './notifications/banners'
import { setupDesktopNotify } from './notifications/service'
import {
  allowOverlays,
  closeAllOverlays,
  prewarmOverlayWindow,
  setupDesktopOverlays,
} from './overlays/manager'
import {
  enforceRegularDockPolicy,
  startDockPolicyGuard,
  stopDockPolicyGuard,
} from './platform/dock-policy'
import { clearStaleDshAuthCookies, hardenChromiumStorage } from './platform/session'
import {
  markPluginConfigApplied,
  pausePluginConfigWatch,
  startPluginConfigWatch,
  stopPluginConfigWatch,
} from './plugins/config-watch'
import { openRecoveryWindow, recordBootFailure, setupPluginRecovery } from './plugins/recovery'
import { registerDshWebHost } from './restart'
import {
  READY_TIMEOUT_MS,
  startDsh,
  stopDsh,
  waitForPortFree,
  waitForReady,
  type DshHost,
} from './runtime/host'
import { ensureDshInstalled, installedDshBin } from './runtime/installation'
import { DSH_HOST, findFreePort, readWebPort, rememberWebPort } from './runtime/web-port'
import { checkDesktopUpdates, setupDesktopBridge } from './updates/bridge'
import { createMainWindow } from './windows/main-window'
import { focusMainWindow, focusWindow } from './windows/registry'
import { createSplash, setSplashStatus } from './windows/splash'

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
  app.on('second-instance', (_event, argv) => {
    // 二次启动会在 Dock 里闪一下再因单实例锁退出；顺带把旧实例瓷砖拉回。
    enforceRegularDockPolicy()
    if (argv.includes('--dsh-test-notify')) showTestBanner()
    focusMainWindow()
  })
}

let dshProcess: ChildProcess | null = null
let dshBin: string | undefined
let dshPort: number | null = null
let mainWindow: BrowserWindow | null = null
let dshOrigin: string | null = null
let stopping = false
let restartingWeb = false
let restartInFlight: Promise<void> | null = null

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
  const errorLine = lines.find(
    (line) => line.startsWith('Error:') || line.includes('YAMLException:'),
  )
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
    const output = host.recentOutput()
    try {
      const logPath = join(app.getPath('logs'), 'dsh-service.log')
      const record = [
        `[${new Date().toISOString()}] unexpected exit code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        output,
        '',
      ].join('\n')
      appendFileSync(logPath, record)
    } catch {
      // 诊断落盘失败不阻断错误提示。
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      const summary = summarizeDshFailure(output)
      const detail = summary ? `\n${summary}` : ''
      reportError(
        'DSH-Desktop',
        `DSH 服务意外退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）${detail}`,
      )
    }
  })
}

interface BootResult {
  /** 打开窗口用的 URL：新运行时带启动 token，旧运行时等于 origin。 */
  launchUrl: string | null
  lastOutput: string
}

/**
 * 拉起一次 dsh web，等它就绪。
 *
 * 单次启动、不自动隔离：失败时把输出带回给调用方，由启动流程走插件恢复页
 * （recordBootFailure → openRecoveryWindow），用户自己决定禁用哪些插件再
 * 重启。只有用户明确禁用才会改动 bundles。
 *
 * 成功时更新运行进程、端口与 origin，返回本次启动 URL。
 */
async function bootDsh(port: number, bin: string): Promise<BootResult> {
  const host = startDsh(port, bin)
  dshProcess = host.child
  attachExitHandler(host)

  const outcome = await waitExitOrReady(host, port)
  if (outcome.kind === 'ready') {
    dshPort = port
    dshOrigin = `http://${DSH_HOST}:${port}`
    try {
      rememberWebPort(app.getPath('userData'), port)
    } catch (error) {
      console.warn('[DSH-Desktop] failed to remember web port', error)
    }
    return { launchUrl: outcome.url, lastOutput: '' }
  }

  const lastOutput = host.recentOutput()
  if (outcome.kind === 'timeout' && host.child.exitCode === null) {
    await stopDsh(host.child)
  }
  if (dshProcess === host.child) dshProcess = null
  return { launchUrl: null, lastOutput }
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

      const launchUrl = result.launchUrl
      const win = mainWindow
      if (launchUrl !== null && win !== null && !win.isDestroyed()) {
        try {
          await clearStaleDshAuthCookies()
        } catch (error) {
          console.warn(
            '[DSH-Desktop] failed to clear stale DSH auth cookies before web reload',
            error,
          )
        }
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

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return
  // Dock 图标「闪一下就没」发生在 splash 首窗显示前后：瓷砖被压掉时
  // activationPolicy 往往仍是 regular，单靠 setActivationPolicy 拉不回来。
  // 常驻守卫：任何时刻瓷砖被压掉都会拉回（V2 不再设 20 秒截止）。
  startDockPolicyGuard()
  // pnpm start 跑的是 Electron 二进制，菜单栏最左默认写 "Electron"；
  // 先改名，后面 setApplicationMenu 才显示 DSH-Desktop。
  app.setName('DSH-Desktop')
  await hardenChromiumStorage()
  try {
    await clearStaleDshAuthCookies()
  } catch (error) {
    console.warn('[DSH-Desktop] failed to clear stale DSH auth cookies', error)
  }

  let port: number
  try {
    port = await findFreePort(readWebPort(app.getPath('userData')))
  } catch (err) {
    reportError('DSH-Desktop', `无法分配端口：${err instanceof Error ? err.message : String(err)}`)
    app.quit()
    return
  }

  const splash = createSplash()
  // 必须和 splash 一起建：等主窗口 load 完再 new BrowserWindow 会 SetRootCerts。
  prewarmOverlayWindow()

  let bin: string
  try {
    bin = await ensureDshInstalled((message) => setSplashStatus(splash, message))
    dshBin = bin
  } catch (err) {
    splash.close()
    reportError(
      'DSH-Desktop',
      `无法准备 DSH 运行时：${err instanceof Error ? err.message : String(err)}`,
    )
    app.quit()
    return
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
  setupDesktopOverlays(() => dshOrigin)
  setupPluginRecovery()
  // splash 不在这里关闭，交给 createMainWindow 的 ready-to-show 在显示主窗口后关闭，
  // 确保启动全程始终有可见窗口。
  mainWindow = createMainWindow(boot.launchUrl, {
    getOrigin: () => dshOrigin,
    onReady: (win) => {
      refreshDesktopSeats()
      // 先显示并前置主窗口，再关 splash：全程保持至少一个可见窗口，避免出现
      // 「零可见窗口」空档，否则 macOS 会把前台还给 Finder / 上一个前台 App，
      // 主窗口就会显示在别的窗口后面。
      focusWindow(win)
      // focusWindow 的 restore 只针对最小化；确保展示时保持最大化状态。
      if (!win.isMaximized()) win.maximize()
      // 首窗显示也是 Dock 瓷砖最容易被系统压掉的时刻；show 之后立刻拉回。
      enforceRegularDockPolicy()
      if (!splash.isDestroyed()) splash.close()
      // 主窗口站稳后再放行桌宠 overlay：启动瞬间建第二扇窗会撞
      // Electron 43 + macOS 26 的 SetRootCerts SIGSEGV。
      allowOverlays()
    },
    onClosed: (win) => {
      if (mainWindow !== win) return
      mainWindow = null
      // overlay 不能单独续命应用：主窗口关了就把桌宠一起收掉。
      closeAllOverlays()
      if (!stopping) app.quit()
    },
  })
  startPluginConfigWatch(refreshMenuLanguage)

  // 启动后自动查一轮更新；不阻塞窗口出现，网络失败静默。
  void checkDesktopUpdates()

  // 启动守卫会覆盖这段窗口期；再留一次显式断言兜底。
  setTimeout(() => enforceRegularDockPolicy(), 10_000)
})

app.on('activate', () => {
  // Dock / 托盘激活时最上层 overlay 常被 AppKit 当成前台窗。
  enforceRegularDockPolicy()
  focusMainWindow()
})

app.on('before-quit', () => {
  stopping = true
  stopDockPolicyGuard()
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
