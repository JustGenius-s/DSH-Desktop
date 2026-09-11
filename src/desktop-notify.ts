/**
 * 系统通知所有者：主进程用 Electron Notification 弹出，preload 只过 JSON。
 * 不是席位——没有合并/重建，同 contributor+id 替换，窗口销毁或 close 即消失。
 */

import { Notification, ipcMain, BrowserWindow, screen, type WebContents } from 'electron'
import {
  DESKTOP_ID_RE,
  type DesktopNotifyAction,
  type DesktopNotifyResult,
  type DesktopNotifySpec,
} from './api'
import { Ipc } from './ipc'
import { focusMainWindow, webContentsById } from './windows'

const MAX_TITLE = 80
const MAX_BODY = 240
const MAX_ACTIVE_PER_CONTRIBUTOR = 3
const MIN_NEW_ID_INTERVAL_MS = 10_000

/** 网页 Notification API 转原生桥的 contributor。不限流：插件测试按钮会连点。 */
const WEB_NOTIFICATION_CONTRIBUTOR = 'web-notification'

interface ActiveNote {
  contributor: string
  id: string
  wcId: number
  notification: Notification
}

const active: ActiveNote[] = []
const watchedWc = new Set<number>()
const lastNewIdAt = new Map<string, number>()
const lastShownId = new Map<string, string>()

function sanitizeShow(raw: unknown): DesktopNotifySpec | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.contributor !== 'string' || !DESKTOP_ID_RE.test(obj.contributor)) return null
  if (typeof obj.id !== 'string' || !DESKTOP_ID_RE.test(obj.id)) return null
  if (typeof obj.title !== 'string' || obj.title.length === 0 || obj.title.length > MAX_TITLE) {
    return null
  }
  if (typeof obj.body !== 'string' || obj.body.length === 0 || obj.body.length > MAX_BODY) {
    return null
  }
  const spec: DesktopNotifySpec = {
    contributor: obj.contributor,
    id: obj.id,
    title: obj.title,
    body: obj.body,
  }
  if (typeof obj.silent === 'boolean') spec.silent = obj.silent
  return spec
}

function keyOf(contributor: string, id: string): string {
  return contributor + ':' + id
}

function drop(row: ActiveNote): void {
  try {
    row.notification.close()
  } catch {
    // 系统侧可能已经关掉。
  }
  closeBanner(bannerKey(row.wcId, row.contributor, row.id))
  const idx = active.indexOf(row)
  if (idx >= 0) active.splice(idx, 1)
}

function closeMatching(wcId: number, contributor: string, id?: string): void {
  for (let i = active.length - 1; i >= 0; i--) {
    const row = active[i]
    if (row.wcId !== wcId || row.contributor !== contributor) continue
    if (id !== undefined && row.id !== id) continue
    drop(row)
  }
}

function closeWindow(wcId: number): void {
  for (let i = active.length - 1; i >= 0; i--) {
    if (active[i].wcId === wcId) drop(active[i])
  }
  watchedWc.delete(wcId)
}

function watchSender(wc: WebContents): void {
  if (watchedWc.has(wc.id)) return
  watchedWc.add(wc.id)
  wc.once('destroyed', () => closeWindow(wc.id))
}

function countContributor(wcId: number, contributor: string): number {
  return active.filter((row) => row.wcId === wcId && row.contributor === contributor).length
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const bannerWindows = new Map<string, BrowserWindow>()

function bannerKey(wcId: number, contributor: string, id: string): string {
  return `${wcId}:${contributor}:${id}`
}

function closeBanner(key: string): void {
  const win = bannerWindows.get(key)
  if (win === undefined) return
  bannerWindows.delete(key)
  if (!win.isDestroyed()) win.close()
}

/** 壳内横幅：不依赖 macOS 通知授权。系统 Notification 在这台机器上会静默失败。 */
function showBannerOverlay(wc: WebContents, spec: DesktopNotifySpec): void {
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

function showNote(wc: WebContents, spec: DesktopNotifySpec): DesktopNotifyResult {
  if (!Notification.isSupported()) {
    console.warn('[DSH-Desktop] system notifications not supported')
    return { shown: false }
  }

  const stampKey = String(wc.id) + ':' + spec.contributor
  const existing = active.find(
    (row) => row.wcId === wc.id && row.contributor === spec.contributor && row.id === spec.id,
  )
  if (existing === undefined) {
    const prevId = lastShownId.get(stampKey)
    if (prevId !== spec.id && spec.contributor !== WEB_NOTIFICATION_CONTRIBUTOR) {
      const last = lastNewIdAt.get(stampKey) ?? 0
      if (Date.now() - last < MIN_NEW_ID_INTERVAL_MS) {
        console.warn('[DSH-Desktop] notify rate-limited', spec.contributor)
        return { shown: false }
      }
      lastNewIdAt.set(stampKey, Date.now())
    }
    if (countContributor(wc.id, spec.contributor) >= MAX_ACTIVE_PER_CONTRIBUTOR) {
      console.warn('[DSH-Desktop] notify cap reached', spec.contributor)
      return { shown: false }
    }
  } else {
    drop(existing)
  }
  lastShownId.set(stampKey, spec.id)

  let notification: Notification
  try {
    notification = new Notification({
      title: spec.title,
      body: spec.body,
      silent: spec.silent === true,
    })
  } catch (err) {
    console.warn('[DSH-Desktop] Notification constructor failed', err)
    return { shown: false }
  }

  const row: ActiveNote = {
    contributor: spec.contributor,
    id: spec.id,
    wcId: wc.id,
    notification,
  }
  active.push(row)

  const action: DesktopNotifyAction = { contributor: spec.contributor, id: spec.id }
  notification.on('click', () => {
    drop(row)
    focusMainWindow()
    const target = webContentsById(wc.id)
    if (target === undefined || target.isDestroyed()) return
    target.send(Ipc.notify.action, action)
  })
  notification.on('close', () => {
    const idx = active.indexOf(row)
    if (idx >= 0) active.splice(idx, 1)
  })
  notification.on('failed', (event) => {
    console.warn('[DSH-Desktop] notification failed', spec.contributor, spec.id, event)
    const idx = active.indexOf(row)
    if (idx >= 0) active.splice(idx, 1)
  })

  try {
    notification.show()
  } catch (err) {
    console.warn('[DSH-Desktop] notification.show failed', err)
  }
  showBannerOverlay(wc, spec)

  console.log(`[DSH-Desktop] notify ${keyOf(spec.contributor, spec.id)}`)
  return { shown: true }
}

/**
 * 网页 `new Notification()` 在 Chromium 里可能显示已授权，但 macOS 的
 * UNUserNotificationCenter 从未被问过——系统静默丢掉横幅，连 error 都不回。
 * 把页面里的 Notification 接到壳的原生通知：第一次 show 会弹出系统授权框。
 */
const WEB_NOTIFICATION_BRIDGE = `(() => {
  if (window.__dshNotifyBridge) return
  const desktop = window.dshDesktop
  if (desktop === undefined || desktop.notify === undefined) return
  window.__dshNotifyBridge = true

  const CONTRIBUTOR = ${JSON.stringify(WEB_NOTIFICATION_CONTRIBUTOR)}
  const instances = new Map()

  function toId(tag) {
    const raw = String(tag || ('n' + Date.now())).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64)
    return /^[A-Za-z0-9]/.test(raw) ? raw : ('n' + raw).slice(0, 64)
  }

  class DesktopNotification {
    static get permission() { return 'granted' }
    static requestPermission() {
      void desktop.notify.show({
        contributor: CONTRIBUTOR,
        id: toId('permission-' + Date.now()),
        title: 'DSH-Desktop',
        body: '通知已接通',
      })
      return Promise.resolve('granted')
    }
    static get maxActions() { return 0 }
    constructor(title, options) {
      const opts = options === undefined || options === null ? {} : options
      this.title = String(title ?? '')
      this.body = String(opts.body ?? '')
      this.tag = opts.tag
      this.onclick = null
      this.onshow = null
      this.onerror = null
      this.onclose = null
      this._id = toId(opts.tag)
      instances.set(this._id, this)
      const shownTitle = this.title.slice(0, ${MAX_TITLE}) || 'DSH'
      const shownBody = (this.body === '' ? ' ' : this.body).slice(0, ${MAX_BODY})
      void desktop.notify.show({
        contributor: CONTRIBUTOR,
        id: this._id,
        title: shownTitle,
        body: shownBody,
        silent: opts.silent === true,
      }).then((result) => {
        if (result !== undefined && result.shown === true) {
          if (typeof this.onshow === 'function') this.onshow(new Event('show'))
        } else if (typeof this.onerror === 'function') {
          this.onerror(new Event('error'))
        }
      }).catch(() => {
        if (typeof this.onerror === 'function') this.onerror(new Event('error'))
      })
    }
    close() {
      void desktop.notify.close(CONTRIBUTOR, this._id)
      if (typeof this.onclose === 'function') this.onclose(new Event('close'))
    }
    addEventListener(type, fn) {
      if (type === 'click') this.onclick = fn
      else if (type === 'show') this.onshow = fn
      else if (type === 'error') this.onerror = fn
      else if (type === 'close') this.onclose = fn
    }
    removeEventListener(type, fn) {
      if (type === 'click' && this.onclick === fn) this.onclick = null
      else if (type === 'show' && this.onshow === fn) this.onshow = null
      else if (type === 'error' && this.onerror === fn) this.onerror = null
      else if (type === 'close' && this.onclose === fn) this.onclose = null
    }
  }

  desktop.notify.onAction((action) => {
    if (action.contributor !== CONTRIBUTOR) return
    const inst = instances.get(action.id)
    if (inst !== undefined && typeof inst.onclick === 'function') inst.onclick(new Event('click'))
  })

  window.Notification = DesktopNotification
})()`

function injectWebNotificationBridge(wc: WebContents): void {
  if (wc.isDestroyed()) return
  void wc.executeJavaScript(WEB_NOTIFICATION_BRIDGE).catch((err: unknown) => {
    console.warn('[DSH-Desktop] inject web notification bridge failed', err)
  })
}

/** 主窗口每次整页加载后把网页 Notification 接到原生桥。 */
export function installWebNotificationBridge(win: BrowserWindow): void {
  const inject = () => injectWebNotificationBridge(win.webContents)
  win.webContents.on('dom-ready', inject)
  win.webContents.on('did-finish-load', inject)
}

/** 注册通知 IPC。必须在 loadURL 之前调用。 */
export function setupDesktopNotify(): void {
  ipcMain.handle(Ipc.notify.show, (event, raw: unknown): DesktopNotifyResult => {
    const spec = sanitizeShow(raw)
    if (spec === null) {
      console.warn('[DSH-Desktop] rejected notify spec', raw)
      throw new Error('invalid desktop notification')
    }
    const wc = event.sender
    watchSender(wc)
    return showNote(wc, spec)
  })

  ipcMain.handle(Ipc.notify.close, (event, contributor: unknown, id: unknown) => {
    if (typeof contributor !== 'string' || !DESKTOP_ID_RE.test(contributor)) return
    if (id !== undefined && (typeof id !== 'string' || !DESKTOP_ID_RE.test(id))) return
    closeMatching(event.sender.id, contributor, typeof id === 'string' ? id : undefined)
  })
}
