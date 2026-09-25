/** 主窗口的原生外观、导航规则和页面集成；应用编排通过回调接入。 */
import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { installWebNotificationBridge } from '../notifications/web-bridge'
import { enforceRegularDockPolicy } from '../platform/dock-policy'
import { preloadPath } from '../platform/paths'
import { setWindowRole } from './registry'
import { titleBarChromeCSS } from './titlebar'

const DSH_BG = '#151517'

interface MainWindowOptions {
  getOrigin: () => string | null
  onReady: (win: BrowserWindow) => void
  onClosed: (win: BrowserWindow) => void
}

/**
 * 当前注入的标题栏 chrome 样式 key。
 *
 * `did-finish-load` 每次导航都会重跑，而旧 `<style>` 不随导航丢弃：
 * 不先移除就会在热重启/刷新后把同一套规则叠上一层又一层（每层都带
 * `!important`，面板的内缩 padding 会越叠越宽）。
 */
const titleBarChromeKeys: string[] = []

/**
 * 把链接交给系统默认浏览器打开。只放行 http/https：AI 输出里可能出现
 * `file:`、自定义协议等任意 scheme，直接 openExternal 等于让网页调起
 * 本机任一协议处理器，必须白名单。返回是否已受理，未受理由调用方拦截。
 */
function openInDefaultBrowser(rawUrl: string): boolean {
  let protocol = ''
  try {
    protocol = new URL(rawUrl).protocol
  } catch {
    return false
  }
  if (protocol !== 'http:' && protocol !== 'https:') return false
  shell.openExternal(rawUrl).catch((err: unknown) => {
    console.error(`[DSH-Desktop] 用默认浏览器打开链接失败：${rawUrl}`, err)
  })
  return true
}

/**
 * 按光标所在屏的工作区算首启位置和尺寸，保证窗口在屏幕正中。
 * 至少约 1440×900（屏够大时），大约占工作区 82%，并限制上限，
 * 避免 4K 上铺满整屏。
 */
function defaultMainBounds(): { x: number; y: number; width: number; height: number } {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const availableWidth = Math.max(area.width - 48, 800)
  const availableHeight = Math.max(area.height - 48, 600)
  const width = Math.round(Math.min(Math.max(area.width * 0.82, 1440), 1800, availableWidth))
  const height = Math.round(Math.min(Math.max(area.height * 0.82, 900), 1120, availableHeight))
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  }
}

export function createMainWindow(url: string, options: MainWindowOptions): BrowserWindow {
  const { x, y, width, height } = defaultMainBounds()
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 800,
    minHeight: 600,
    title: 'DSH-Desktop',
    icon: join(app.getAppPath(), 'build', 'icon-app.png'),
    // 隐藏 macOS 原生标题栏、保留红绿灯按钮，让窗口顶部直接露出 DSH 深色底色。
    titleBarStyle: 'hiddenInset',
    backgroundColor: DSH_BG,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 向 DSH 网页暴露 window.dshDesktop（updates / seats / notify / overlays）。
      preload: preloadPath(),
    },
  })

  setWindowRole(win, 'main')
  win.setMenuBarVisibility(false)
  // 首启最大化（铺满工作区）：默认 bounds 仍作为最大化前的还原创备用。
  win.maximize()
  win.once('ready-to-show', () => options.onReady(win))
  win.on('closed', () => options.onClosed(win))
  // DSH 网页加载完成后注入顶部拖拽条与红绿灯避让样式（隐藏原生标题栏后必需）。
  win.webContents.on('did-finish-load', () => {
    void applyTitleBarChrome(win)
    enforceRegularDockPolicy()
  })
  // AI 输出的超链接不在壳内开新窗口、也不把应用窗口整页跳走：
  // 1. target=_blank / window.open（AI 链接的常态）→ 拦截新窗口，交给默认浏览器；
  // 2. 页面发起的整页导航：同源放行（SPA 路由 / 热重启刷新），跨源改为外开。
  //    主进程 loadURL 不触发 will-navigate，热重启换端口不受影响。
  // 两者都必须在 loadURL 之前挂上，避免首帧点击打空。
  const isSameOrigin = (target: string): boolean => {
    const dshOrigin = options.getOrigin()
    if (dshOrigin === null) return false
    try {
      return new URL(target).origin === new URL(dshOrigin).origin
    } catch {
      return false
    }
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!openInDefaultBrowser(url)) console.warn(`[DSH-Desktop] 已拦截不受支持的弹窗链接：${url}`)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isSameOrigin(url)) return
    event.preventDefault()
    if (!openInDefaultBrowser(url)) console.warn(`[DSH-Desktop] 已拦截跨源导航：${url}`)
  })
  // 必须在 loadURL 之前挂上：网页 Notification 接到原生桥，否则插件测试按钮
  // 会走 Chromium 那条「已授权但系统没问过」的静默丢弃路径。
  installWebNotificationBridge(win)
  void win.loadURL(url)
  return win
}

/**
 * 把标题栏 chrome（窗口拖动热区 + 浮层穿透切断）注入 DSH 网页。
 *
 * 规则本体在 `titlebar.ts` 的纯函数里，便于单测；这里只做注入。
 * 注入必须幂等：`did-finish-load` 会在每次 reload / 热重启后重跑，而旧的
 * `<style>` 不会随导航清掉，重复 insertCSS 会让规则无限堆积。
 */
async function applyTitleBarChrome(win: BrowserWindow): Promise<void> {
  const wc = win.webContents
  if (wc.isDestroyed()) return

  for (const key of titleBarChromeKeys) {
    if (wc.isDestroyed()) return
    try {
      await wc.removeInsertedCSS(key)
    } catch {
      // 上一轮注入的 key 在导航后已失效；没有可移除的样式，继续。
    }
  }
  titleBarChromeKeys.length = 0

  if (wc.isDestroyed()) return
  try {
    titleBarChromeKeys.push(await wc.insertCSS(titleBarChromeCSS(process.platform)))
  } catch {
    // 注入失败不阻断启动：窗口只是拖不动，页面功能不受影响。
  }
}
