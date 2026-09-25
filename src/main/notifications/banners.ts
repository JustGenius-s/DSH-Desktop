/** 原生通知的壳内横幅，以及二次启动的通知自检入口。 */
import { BrowserWindow, screen, type WebContents } from 'electron'
import type { DesktopNotifySpec } from '../../shared/api'
import { Ipc } from '../../shared/ipc'
import { focusMainWindow, webContentsById } from '../windows/registry'
import { WEB_NOTIFICATION_CONTRIBUTOR } from './constants'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const bannerWindows = new Map<string, BrowserWindow>()

export function bannerKey(wcId: number, contributor: string, id: string): string {
  return `${wcId}:${contributor}:${id}`
}

export function closeBanner(key: string): void {
  const win = bannerWindows.get(key)
  if (win === undefined) return
  bannerWindows.delete(key)
  if (!win.isDestroyed()) win.close()
}

/** 壳内横幅：不依赖 macOS 通知授权。系统 Notification 在这台机器上会静默失败。 */
export function showBannerOverlay(wc: WebContents, spec: DesktopNotifySpec): void {
  const key = bannerKey(wc.id, spec.contributor, spec.id)
  closeBanner(key)

  const display = screen.getPrimaryDisplay()
  const width = 380
  const height = 92
  const x = display.workArea.x + display.workArea.width - width - 16
  const y = display.workArea.y + 16
  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    show: false,
    type: process.platform === 'darwin' ? 'panel' : 'normal',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.platform === 'darwin') win.setAlwaysOnTop(true, 'screen-saver')
  bannerWindows.set(key, win)

  const title = escapeHtml(spec.title)
  const body = escapeHtml(spec.body)
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
.b{height:100%;box-sizing:border-box;padding:14px 16px;border-radius:12px;background:rgba(28,28,30,.94);color:#f5f5f7;box-shadow:0 8px 28px rgba(0,0,0,.4);display:flex;flex-direction:column;justify-content:center;cursor:pointer;user-select:none}
.t{font-size:13px;font-weight:600;line-height:1.3}
.d{font-size:12px;opacity:.85;margin-top:4px;line-height:1.35}
</style></head><body><div class="b" id="b"><div class="t">${title}</div><div class="d">${body}</div></div>
<script>document.getElementById('b').addEventListener('click',function(){location.href='dsh-notify://click'})</script></body></html>`

  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (url.startsWith('dsh-notify://')) {
      closeBanner(key)
      focusMainWindow()
      const target = webContentsById(wc.id)
      if (target !== undefined && !target.isDestroyed()) {
        target.send(Ipc.notify.action, { contributor: spec.contributor, id: spec.id })
      }
    }
  })
  win.on('closed', () => {
    bannerWindows.delete(key)
  })
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive()
  })
  setTimeout(() => closeBanner(key), 6000)
}

/** 给二次启动 `--dsh-test-notify` 用：不经过网页。 */
export function showTestBanner(): void {
  showBannerOverlay({ id: 0 } as WebContents, {
    contributor: WEB_NOTIFICATION_CONTRIBUTOR,
    id: 'agent-test',
    title: 'DSH-Desktop',
    body: '测试横幅',
  })
}
