/** 主窗口的原生外观、导航规则和页面集成；应用编排通过回调接入。 */
import { app, BrowserWindow, screen, shell, systemPreferences } from 'electron'
import { join } from 'node:path'
import { enforceRegularDockPolicy } from '../platform/dock-policy'
import { installDshMicrophonePermission } from '../platform/microphone'
import { preloadPath } from '../platform/paths'
import { watchPluginFailures } from '../plugins/recovery'
import { setWindowRole } from './registry'
import { installTitleBarChrome } from './titlebar-controller'

const DSH_BG = '#151517'

interface MainWindowOptions {
  getOrigin: () => string | null
  onReady: (win: BrowserWindow) => void
  onClosed: (win: BrowserWindow) => void
  onFailure: (kind: 'renderer' | 'plugin', detail: string) => void
}

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
    name: 'dsh-main',
    windowStatePersistence: true,
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
      // 通过沙箱 preload 暴露 window.dshDesktop。
      preload: preloadPath(),
    },
  })

  setWindowRole(win, 'main')
  installDshMicrophonePermission(
    win.webContents.session,
    win.webContents,
    () => options.getOrigin(),
    process.platform,
    () => systemPreferences.askForMediaAccess('microphone'),
  )
  installTitleBarChrome(win, process.platform)
  win.setMenuBarVisibility(false)
  // Electron 恢复已保存的尺寸、位置和显示状态；首次启动采用上面的默认 bounds。
  win.once('ready-to-show', () => options.onReady(win))
  win.on('closed', () => options.onClosed(win))
  watchPluginFailures(win.webContents, (detail) => options.onFailure('plugin', detail))
  win.webContents.on('render-process-gone', (_event, { reason, exitCode }) => {
    if (win.isDestroyed() || win.webContents.isDestroyed() || reason === 'clean-exit') return
    options.onFailure(
      'renderer',
      `DSH 主窗口渲染进程退出（reason=${reason}, exitCode=${exitCode}）`,
    )
  })
  // 拖拽样式由 installTitleBarChrome 在加载和全屏切换时写入。
  win.webContents.on('did-finish-load', () => {
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
  void win.loadURL(url)
  return win
}
