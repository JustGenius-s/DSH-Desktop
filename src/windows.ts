/**
 * 主进程窗口辅助：席位点击与通知点击都要找到主窗口并前置。
 * 窗口按角色标记，避免 overlay / splash 被误当成主窗口。
 */

import { BrowserWindow, type WebContents } from 'electron'

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

export function focusMainWindow(): void {
  const win = getMainWindow()
  if (win === undefined) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function webContentsById(id: number): WebContents | undefined {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents.id === id) return win.webContents
  }
  return undefined
}
