/**
 * DSH-Desktop preload：以 contextBridge 向 DSH 网页暴露标准桌面 API。
 *
 * 契约见 `./shared/api`（updates / seats / notify / overlays）。本文件只做 IPC 转发，
 * 不引入 Menu / Tray / Notification / BrowserWindow。普通浏览器没有 window.dshDesktop。
 */

import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { MAX_BODY, MAX_TITLE, WEB_NOTIFICATION_CONTRIBUTOR } from './main/notifications/constants'
import { installWebNotificationBridge } from './main/notifications/web-bridge'
import type {
  DesktopContribution,
  DesktopNotifyAction,
  DesktopNotifySpec,
  DesktopOverlayClosed,
  DesktopOverlayMoveSpec,
  DesktopOverlayOpenSpec,
  DesktopOverlayUpdateSpec,
  DesktopPluginInfo,
  DesktopPluginFailure,
  DesktopRestartChoice,
  DesktopRestartPrompt,
  DesktopSeatAction,
  DesktopSeatName,
  DshDesktop,
} from './shared/api'
import { Ipc } from './shared/ipc'

const api: DshDesktop = {
  updates: {
    // ---- 执行端点：正式契约 ----
    appVersion: (): Promise<string> => ipcRenderer.invoke(Ipc.updates.appVersion),
    downloadApp: (): Promise<void> => ipcRenderer.invoke(Ipc.updates.downloadApp),
    updateDsh: (version?: string): Promise<void> =>
      ipcRenderer.invoke(Ipc.updates.updateDsh, version),
    restartWeb: (): Promise<void> => ipcRenderer.invoke(Ipc.updates.restartWeb),
    relaunch: (): void => ipcRenderer.send(Ipc.updates.relaunch),

    // ---- 热重启询问：主进程推、页面渲染 Modal 后回执 ----
    onPrompt: (listener: (prompt: DesktopRestartPrompt) => void): (() => void) => {
      const wrapped = (_event: unknown, prompt: DesktopRestartPrompt) => listener(prompt)
      ipcRenderer.on(Ipc.updates.prompt, wrapped)
      return () => ipcRenderer.removeListener(Ipc.updates.prompt, wrapped)
    },
    ackPrompt: (id: string): void => {
      ipcRenderer.send(Ipc.updates.promptAck, id)
    },
    respondPrompt: (id: string, choice: DesktopRestartChoice): void => {
      ipcRenderer.send(Ipc.updates.promptResponse, id, choice)
    },
  },
  seats: {
    list: () => ipcRenderer.invoke(Ipc.seats.list),
    contribute: (contribution: DesktopContribution) =>
      ipcRenderer.invoke(Ipc.seats.contribute, contribution),
    revoke: (seat: DesktopSeatName, contributor: string) =>
      ipcRenderer.invoke(Ipc.seats.revoke, seat, contributor),
    onAction: (listener: (action: DesktopSeatAction) => void): (() => void) => {
      const wrapped = (_event: unknown, action: DesktopSeatAction) => listener(action)
      ipcRenderer.on(Ipc.seats.action, wrapped)
      return () => ipcRenderer.removeListener(Ipc.seats.action, wrapped)
    },
  },
  notify: {
    show: (spec: DesktopNotifySpec) => ipcRenderer.invoke(Ipc.notify.show, spec),
    close: (contributor: string, id?: string) =>
      ipcRenderer.invoke(Ipc.notify.close, contributor, id),
    onAction: (listener: (action: DesktopNotifyAction) => void): (() => void) => {
      const wrapped = (_event: unknown, action: DesktopNotifyAction) => listener(action)
      ipcRenderer.on(Ipc.notify.action, wrapped)
      return () => ipcRenderer.removeListener(Ipc.notify.action, wrapped)
    },
    onClosed: (listener: (action: DesktopNotifyAction) => void): (() => void) => {
      const wrapped = (_event: unknown, action: DesktopNotifyAction) => listener(action)
      ipcRenderer.on(Ipc.notify.closed, wrapped)
      return () => ipcRenderer.removeListener(Ipc.notify.closed, wrapped)
    },
  },
  overlays: {
    open: (spec: DesktopOverlayOpenSpec) => ipcRenderer.invoke(Ipc.overlays.open, spec),
    update: (id: string, spec: DesktopOverlayUpdateSpec) =>
      ipcRenderer.invoke(Ipc.overlays.update, id, spec),
    move: (id: string, spec: DesktopOverlayMoveSpec) =>
      ipcRenderer.invoke(Ipc.overlays.move, id, spec),
    setIgnoreMouseEvents: (id: string, ignore: boolean, opts?: { forward?: boolean }) =>
      ipcRenderer.invoke(Ipc.overlays.setIgnoreMouseEvents, id, ignore, opts),
    activateOwner: (id: string) => ipcRenderer.invoke(Ipc.overlays.activateOwner, id),
    focus: (id: string) => ipcRenderer.invoke(Ipc.overlays.focus, id),
    close: (id: string) => ipcRenderer.invoke(Ipc.overlays.close, id),
    list: () => ipcRenderer.invoke(Ipc.overlays.list),
    onClosed: (listener: (event: DesktopOverlayClosed) => void): (() => void) => {
      const wrapped = (_event: unknown, event: DesktopOverlayClosed) => listener(event)
      ipcRenderer.on(Ipc.overlays.closed, wrapped)
      return () => ipcRenderer.removeListener(Ipc.overlays.closed, wrapped)
    },
  },
  plugins: {
    list: (): Promise<{ plugins: DesktopPluginInfo[]; failure: DesktopPluginFailure | null }> =>
      ipcRenderer.invoke(Ipc.plugins.list),
    setEnabled: (name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(Ipc.plugins.setEnabled, name, enabled),
    clearFailure: (): Promise<void> => ipcRenderer.invoke(Ipc.plugins.clearFailure),
    onFailureChanged: (listener: () => void): (() => void) => {
      const wrapped = () => listener()
      ipcRenderer.on(Ipc.plugins.failureChanged, wrapped)
      return () => ipcRenderer.removeListener(Ipc.plugins.failureChanged, wrapped)
    },
    relaunch: (): void => ipcRenderer.send(Ipc.plugins.relaunch),
  },
}

contextBridge.exposeInMainWorld('dshDesktop', api)

// 告诉 DSH 网页「我跑在 macOS 原生壳里」。上游用 `<html data-platform="darwin">`
// 决定拖拽带、侧栏和列宽；普通网页不会设这个标记。preload 可能早于 documentElement，
// 所以立刻试一次，并在 readystatechange / DOMContentLoaded 再补。
if (process.platform === 'darwin') {
  const MARK_DARWIN = `(() => {
  const apply = () => {
    const root = document.documentElement
    if (root === null) return
    if (root.dataset.platform === 'darwin') return
    root.dataset.platform = 'darwin'
  }
  apply()
  document.addEventListener('readystatechange', apply)
  document.addEventListener('DOMContentLoaded', apply, { once: true })
})()`
  void webFrame.executeJavaScript(MARK_DARWIN).catch(() => {
    // 文档尚未建立时执行会失败；下一次导航仍会重试。
  })
}

// Electron 会序列化函数；跨上下文所需的常量必须显式传参。
try {
  contextBridge.executeInMainWorld({
    func: installWebNotificationBridge,
    args: [WEB_NOTIFICATION_CONTRIBUTOR, MAX_TITLE, MAX_BODY],
  })
} catch (error) {
  console.warn('[DSH-Desktop] preload notification bridge failed', error)
}
