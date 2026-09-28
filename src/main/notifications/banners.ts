/** 原生通知的壳内横幅。 */
import {
  BrowserWindow,
  screen,
  type Event,
  type WebContentsWillNavigateEventParams,
} from 'electron'
import type { DesktopNotifySpec } from '../../shared/api'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

interface Banner {
  close: () => void
}

const bannerWindows = new Map<string, Banner>()

export function bannerKey(wcId: number, contributor: string, id: string): string {
  return `${wcId}:${contributor}:${id}`
}

export function closeBanner(key: string): void {
  bannerWindows.get(key)?.close()
}

/** 壳内横幅：在系统通知未展示时仍提供可点击的提示。 */
export function showBannerOverlay(
  wcId: number,
  spec: DesktopNotifySpec,
  callbacks: { onAction: () => void; onClosed: () => void },
): void {
  const key = bannerKey(wcId, spec.contributor, spec.id)
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
  const bannerContents = win.webContents
  if (process.platform === 'darwin') win.setAlwaysOnTop(true, 'screen-saver')

  const title = escapeHtml(spec.title)
  const body = escapeHtml(spec.body)
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
.b{height:100%;box-sizing:border-box;padding:14px 16px;border-radius:12px;background:rgba(28,28,30,.94);color:#f5f5f7;box-shadow:0 8px 28px rgba(0,0,0,.4);display:flex;flex-direction:column;justify-content:center;cursor:pointer;user-select:none}
.t{font-size:13px;font-weight:600;line-height:1.3}
.d{font-size:12px;opacity:.85;margin-top:4px;line-height:1.35}
</style></head><body><div class="b" id="b"><div class="t">${title}</div><div class="d">${body}</div></div>
<script>document.getElementById('b').addEventListener('click',function(){location.href='dsh-notify://click'})</script></body></html>`

  let closed = false
  const cleanup = (): void => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    if (!bannerContents.isDestroyed()) bannerContents.removeListener('will-navigate', onNavigate)
    win.removeListener('ready-to-show', onReady)
    win.removeListener('closed', cleanup)
    if (bannerWindows.get(key) === banner) bannerWindows.delete(key)
    callbacks.onClosed()
  }
  const banner: Banner = {
    close: () => {
      if (closed) return
      cleanup()
      if (!win.isDestroyed()) win.close()
    },
  }
  const onNavigate = (event: Event<WebContentsWillNavigateEventParams>): void => {
    event.preventDefault()
    if (event.url !== 'dsh-notify://click') return
    try {
      callbacks.onAction()
    } finally {
      banner.close()
    }
  }
  const onReady = (): void => {
    if (!closed && !win.isDestroyed()) win.showInactive()
  }
  // 计时器和监听器属于具体窗口；同 id 替换后，旧窗口不能关闭或移除新窗口。
  const timer = setTimeout(banner.close, 6000)
  bannerWindows.set(key, banner)
  bannerContents.on('will-navigate', onNavigate)
  win.once('closed', cleanup)
  win.once('ready-to-show', onReady)
  void win
    .loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    .catch((err: unknown) => {
      console.warn('[DSH-Desktop] notification banner failed', err)
      banner.close()
    })
}
