/**
 * 主进程窗口辅助：席位点击与通知点击都要找到贡献窗口并前置。
 */

import { BrowserWindow, type WebContents } from 'electron'

export function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
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
