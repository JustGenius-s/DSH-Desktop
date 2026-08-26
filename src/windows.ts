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
 * macOS 上从 splash 过渡到主窗口时，应用可能因为短暂无可见普通窗口而
 * 失去 active 状态；此时 BrowserWindow.show() 只能把窗口显示出来，不一定
 * 会把整个应用带到前台。overlay panel 又可以继续置顶，于是看起来像主界面
 * 被压到了后面。先显式激活应用，再按窗口层级前置并聚焦，可同时覆盖首次
 * 启动、Dock/托盘点击和通知跳转三种入口。
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
