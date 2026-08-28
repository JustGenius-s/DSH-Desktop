/**
 * 插件恢复页：DSH 启动失败（且归因为插件问题）时，把用户带到一张自建
 * 页面而不是直接弹错误框。页面列出全部 bundle 插件，标注疑似元凶，允许
 * 用户逐个禁用/启用后重启。页面本身是静态本地文件（build/plugin-recovery.html），
 * 通过 preload 暴露的 window.dshDesktop.plugins 与主进程对话。
 *
 * 为什么自建而不是跳 DSH 设置页：DSH 自带插件清单（pluginInventory/list）
 * 是只读的，没有禁用/启用开关；且 DSH 启动失败时它的 web 服务根本没起来，
 * 跳不进去。自建页只依赖 Electron 本地的 file:// 页面，任何情况下可用。
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import type { DesktopBootFailure, DesktopPluginInfo } from './api'
import { Ipc } from './ipc'
import { extractFailedPlugins, getProfileBundles, listPlugins, clearQuarantine, setBundleEnabled } from './plugin-quarantine'
import { setWindowRole } from './windows'

const DSH_BG = '#151517'

/** 恢复页入口缓存：最近一次启动失败的输出与归因。 */
let bootFailure: DesktopBootFailure | null = null

/** 记录一次启动失败，供恢复页展示；并标记疑似元凶。 */
export function recordBootFailure(output: string): void {
  const suspected = extractFailedPlugins(output, getProfileBundles())
  bootFailure = {
    tail: output.trim().split('\n').slice(-5).join('\n'),
    suspected,
  }
}

/** 是否有待展示的启动失败。 */
export function hasBootFailure(): boolean {
  return bootFailure !== null
}

/** 打开恢复页；返回创建的窗口。 */
export function openRecoveryWindow(): BrowserWindow {
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
      preload: join(__dirname, 'preload.js'),
    },
  })
  setWindowRole(win, 'splash') // 复用 splash 角色：不参与主窗口查找。
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => {
    win.show()
  })
  void win.loadFile(join(app.getAppPath(), 'build', 'plugin-recovery.html'))
  return win
}

/** 组装恢复页展示数据。 */
function recoveryPayload(): { plugins: DesktopPluginInfo[]; failure: DesktopBootFailure | null } {
  const suspected = new Set(bootFailure?.suspected ?? [])
  const plugins = listPlugins().map((p) => ({
    ...p,
    suspected: suspected.has(p.name),
  }))
  return { plugins, failure: bootFailure }
}

/** 注册插件管理 IPC 端点；返回 true 表示重复注册被跳过（幂等）。 */
export function setupPluginRecovery(): void {
  if (ipcMain.listenerCount(Ipc.plugins.list) > 0) return
  ipcMain.handle(Ipc.plugins.list, () => recoveryPayload())
  ipcMain.handle(Ipc.plugins.setEnabled, (_event, name: unknown, enabled: unknown) => {
    if (typeof name !== 'string' || typeof enabled !== 'boolean') {
      return { ok: false, error: '参数类型错误' }
    }
    return setBundleEnabled(name, enabled)
  })
  ipcMain.handle(Ipc.plugins.clearFailure, () => {
    clearQuarantine()
    bootFailure = null
  })
  ipcMain.on(Ipc.plugins.relaunch, () => {
    app.relaunch()
    app.quit()
  })
}
