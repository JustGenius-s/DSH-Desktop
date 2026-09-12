/**
 * 主进程窗口辅助：席位点击与通知点击都要找到主窗口并前置。
 * 窗口按角色标记，避免 overlay / splash 被误当成主窗口。
 */

import { app, BrowserWindow, type WebContents } from 'electron'

export type WindowRole = 'main' | 'splash' | 'overlay'

const roles = new WeakMap<BrowserWindow, WindowRole>()

export function setWindowRole(win: BrowserWindow, role: WindowRole): void {
  roles.set(win, role)
}

export function getWindowRole(win: BrowserWindow): WindowRole | undefined {
  return roles.get(win)
}

export function getMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && roles.get(w) === 'main')
}

/**
 * 显示并前置一个普通应用窗口。
 *
 * splash → 主窗口、Dock/托盘点击、通知跳转都走这里。
 * 不用 alwaysOnTop：前台由系统调度，主窗口只负责 show / focus。
 */
export function focusWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (process.platform === 'darwin') app.focus({ steal: true })
  win.show()
  win.moveTop()
  win.focus()
}

export function focusMainWindow(): void {
  const win = getMainWindow()
  if (win === undefined) return
  focusWindow(win)
}

export function webContentsById(id: number): WebContents | undefined {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents.id === id) return win.webContents
  }
  return undefined
}
