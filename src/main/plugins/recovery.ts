/**
 * 启动失败、运行期服务退出与界面故障共用本地恢复页。
 * 恢复页不依赖 DSH 服务；仅记录故障，由用户决定是否禁用插件或重启。
 */

import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { join } from 'node:path'
import type { DesktopPluginFailure, DesktopPluginInfo } from '../../shared/api'
import { Ipc } from '../../shared/ipc'
import { preloadPath } from '../platform/paths'
import { focusWindow, setWindowRole } from '../windows/registry'
import {
  extractFailedPlugins,
  getProfileBundles,
  listPlugins,
  setBundleEnabled,
} from './quarantine'

const DSH_BG = '#151517'

let failure: DesktopPluginFailure | null = null
let recoveryWindow: BrowserWindow | null = null
let ipcReady = false

/** 更新故障并打开或复用恢复页，避免连续故障创建多个窗口。 */
export function openRecoveryWindow(
  kind: DesktopPluginFailure['kind'],
  output: string,
): BrowserWindow {
  failure = {
    kind,
    detail: output.trim().slice(-16 * 1024),
    // 浏览器边界报告不含可靠的 bundle 身份；只对服务日志做现有启动归因。
    suspected:
      kind === 'startup' || kind === 'service'
        ? extractFailedPlugins(output, getProfileBundles())
        : [],
  }
  if (recoveryWindow !== null) {
    recoveryWindow.webContents.send(Ipc.plugins.failureChanged)
    focusWindow(recoveryWindow)
    return recoveryWindow
  }
  const win = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    title: 'DSH-Desktop — 插件恢复',
    backgroundColor: DSH_BG,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath(),
    },
  })
  recoveryWindow = win
  setWindowRole(win, 'recovery')
  win.once('closed', () => {
    recoveryWindow = null
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => {
    win.show()
  })
  void win.loadFile(join(app.getAppPath(), 'build', 'plugin-recovery.html'))
  return win
}

/** 消费 DSH SlotErrorBoundary 的现有报告，不改写页面的 React 或 console。 */
export function watchPluginFailures(
  contents: WebContents,
  onFailure: (output: string) => void,
): void {
  let lastError = ''
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) lastError = ''
  })
  contents.on('console-message', (details) => {
    if (
      details.level !== 'error' ||
      details.frame !== contents.mainFrame ||
      !/^slot (?:entry|factory occurrence) crashed in '[^']+':/.test(details.message) ||
      details.message === lastError
    )
      return
    lastError = details.message
    onFailure(details.message)
  })
}

/** 组装恢复页展示数据。 */
function recoveryPayload(): { plugins: DesktopPluginInfo[]; failure: DesktopPluginFailure | null } {
  const suspected = new Set(failure?.suspected ?? [])
  const plugins = listPlugins().map((p) => ({
    ...p,
    suspected: suspected.has(p.name),
  }))
  return { plugins, failure }
}

/** 注册插件管理 IPC 端点；重复调用保持已有处理器和恢复状态。 */
export function setupPluginRecovery(): void {
  if (ipcReady) return
  ipcMain.handle(Ipc.plugins.list, () => recoveryPayload())
  ipcMain.handle(Ipc.plugins.setEnabled, (_event, name: unknown, enabled: unknown) => {
    if (typeof name !== 'string' || typeof enabled !== 'boolean') {
      return { ok: false, error: '参数类型错误' }
    }
    return setBundleEnabled(name, enabled)
  })
  ipcMain.handle(Ipc.plugins.clearFailure, () => {
    failure = null
    recoveryWindow?.webContents.send(Ipc.plugins.failureChanged)
  })
  ipcMain.on(Ipc.plugins.relaunch, () => {
    app.relaunch()
    app.quit()
  })
  ipcReady = true
}
