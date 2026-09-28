/**
 * Electron 应用编排：准备 DSH 运行时、启动服务、交接启动页与主窗口，
 * 并处理热重启和退出。启动失败时打开恢复页，由用户决定是否禁用插件。
 */

import { app, dialog, type BrowserWindow } from 'electron'
import type { ChildProcess } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { refreshDesktopSeats, refreshMenuLanguage, setupDesktopSeats } from './menus/seats'
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
 * 在 ready 前隔离开发版的 Chromium 数据，避免与已安装版争用数据库。
 * DSH runtime/profile 仍共用 DSH_HOME。
 */
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'dsh-desktop-dev'))
}

const isPrimaryInstance = app.isPackaged ? app.requestSingleInstanceLock() : true
if (!isPrimaryInstance) {
  app.quit()
} else if (app.isPackaged) {
  app.on('second-instance', () => {
    // 二次启动退出后恢复已有实例的 Dock 图标和主窗口。
    enforceRegularDockPolicy()
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
    // 主动退出、热重启或已被替换的进程不弹错误框。
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
 * 启动一次 dsh web。成功后记住进程、端口与 origin；失败时返回输出，
 * 由调用方选择恢复页或错误提示，不自动改动插件配置。
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

      // 热重启失败时保留配置并显示原因，供用户排查。
      const result = await bootDsh(port, bin)
      if (result.launchUrl === null) {
        const summary = summarizeDshFailure(result.lastOutput)
        const detail = summary === '' ? '' : `\n${summary}`
        reportError('DSH-Desktop', `DSH 服务重启失败${detail}`)
        throw new Error('DSH 服务重启失败')
      }

      markPluginConfigApplied()

      const win = mainWindow
      if (win !== null && !win.isDestroyed()) {
        await clearStaleDshAuthCookies()
        await win.loadURL(result.launchUrl)
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
  // 窗口切换可能隐藏 Dock 图标，守卫会在应用运行期间尝试恢复。
  startDockPolicyGuard()
  // pnpm start 跑的是 Electron 二进制，菜单栏最左默认写 "Electron"；
  // 先改名，后面 setApplicationMenu 才显示 DSH-Desktop。
  app.setName('DSH-Desktop')
  await hardenChromiumStorage()

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

  setSplashStatus(splash, '正在启动 DSH 服务…')
  const boot = await bootDsh(port, bin)

  if (boot.launchUrl === null) {
    recordBootFailure(boot.lastOutput)
    // 即使无法归因到插件，恢复页也能展示原始错误。
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
  const child = dshProcess
  dshProcess = null
  if (child && !child.killed) {
    child.kill('SIGTERM')
  }
})

app.on('window-all-closed', () => {
  app.quit()
})
