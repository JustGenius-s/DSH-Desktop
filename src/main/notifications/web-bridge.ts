import type { BrowserWindow, WebContents } from 'electron'
import { MAX_BODY, MAX_TITLE, WEB_NOTIFICATION_CONTRIBUTOR } from './constants'

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
