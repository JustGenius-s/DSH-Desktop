import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { enforceRegularDockPolicy } from '../platform/dock-policy'
import { setWindowRole } from './registry'

const DSH_BG = '#151517'
const splashStates = new WeakMap<BrowserWindow, { text?: string; loaded: boolean }>()

/** 启动/安装期间的 splash 窗口：本地静态页，进度条由 CSS 动画驱动，文字靠主进程更新。 */
export function createSplash(): BrowserWindow {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = 880
  const height = 600
  const win = new BrowserWindow({
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: DSH_BG,
    webPreferences: {
      preload: join(app.getAppPath(), 'dist', 'splash-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const state: { text?: string; loaded: boolean } = { loaded: false }
  splashStates.set(win, state)
  win.webContents.on('did-start-loading', () => {
    state.loaded = false
  })
  win.webContents.on('did-finish-load', () => {
    state.loaded = true
    if (state.text !== undefined) setSplashStatus(win, state.text)
  })
  setWindowRole(win, 'splash')
  // splash 是启动期第一个窗口；Dock 图标「闪一下就没」就发生在这里，
  // 主窗口尚未出现。show 后立刻 dock.show()，避免只剩无 Dock 瓷砖的壳。
  win.once('ready-to-show', () => {
    win.show()
    enforceRegularDockPolicy()
  })
  void win.loadFile(join(app.getAppPath(), 'build', 'splash.html'))
  return win
}

/** 更新 splash 状态文字；页面加载完成后显示加载期间收到的最新状态。 */
export function setSplashStatus(win: BrowserWindow, text: string): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  const state = splashStates.get(win)
  if (state === undefined) return
  state.text = text
  if (state.loaded) win.webContents.send('desktop:splash:status', text)
}
