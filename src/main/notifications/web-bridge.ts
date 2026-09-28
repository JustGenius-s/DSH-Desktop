import type { DesktopNotifyAction, DshDesktop } from '../../shared/api'

declare global {
  interface Window {
    dshDesktop: DshDesktop
  }
}

/**
 * 将网页 Notification 接入桌面通知桥，统一使用主进程的原生通知和横幅。
 * Chromium 的权限状态不代表系统已授权；系统通知能否展示仍取决于系统设置。
 */
export function installWebNotificationBridge(
  contributor: string,
  maxTitle: number,
  maxBody: number,
): void {
  const { notify } = window.dshDesktop
  const instances = new Map<string, DesktopNotification>()
  type NotificationEvent = 'click' | 'show' | 'error' | 'close'
  type Listener = ((this: DesktopNotification, event: Event) => void) | null
  let sequence = 0
  const nextInstanceId = () => 'n' + Date.now() + '-' + ++sequence

  function toId(tag: string): string {
    const raw = String(tag)
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 64)
    return /^[A-Za-z0-9]/.test(raw) ? raw : ('n' + raw).slice(0, 64)
  }

  class DesktopNotification {
    readonly title: string
    readonly body: string
    readonly tag?: string
    onclick: Listener = null
    onshow: Listener = null
    onerror: Listener = null
    onclose: Listener = null
    private _closed = false
    readonly _instanceId = nextInstanceId()
    private readonly _id: string

    static get permission(): NotificationPermission {
      return 'granted'
    }
    static requestPermission(): Promise<NotificationPermission> {
      return Promise.resolve('granted')
    }
    static get maxActions() {
      return 0
    }
    constructor(title: string, options?: NotificationOptions) {
      const opts = options ?? {}
      this.title = String(title ?? '')
      this.body = String(opts.body ?? '')
      this.tag = opts.tag
      this._id = toId(opts.tag || this._instanceId)
      const previous = instances.get(this._id)
      instances.set(this._id, this)
      if (previous !== undefined) previous._finish('close')
      if (instances.get(this._id) !== this) return
      const shownTitle = this.title.slice(0, maxTitle) || 'DSH'
      const shownBody = (this.body === '' ? ' ' : this.body).slice(0, maxBody)
      void notify
        .show({
          contributor,
          id: this._id,
          instanceId: this._instanceId,
          title: shownTitle,
          body: shownBody,
          silent: opts.silent === true,
        })
        .then((result) => {
          if (instances.get(this._id) !== this) return
          if (result !== undefined && result.shown === true) {
            this._dispatch('show')
          } else {
            this._finish('error')
          }
        })
        .catch(() => this._finish('error'))
    }
    _dispatch(type: NotificationEvent): void {
      const listener = this[`on${type}`]
      if (typeof listener !== 'function') return
      try {
        listener.call(this, new Event(type))
      } catch (error) {
        window.reportError(error)
      }
    }
    _finish(type: 'close' | 'error'): void {
      if (this._closed) return
      this._closed = true
      if (instances.get(this._id) === this) instances.delete(this._id)
      this._dispatch(type)
    }
    close(): void {
      if (this._closed || instances.get(this._id) !== this) return
      void notify.close(contributor, this._id).catch(() => {})
      this._finish('close')
    }
    addEventListener(type: string, fn: Listener): void {
      if (type === 'click') this.onclick = fn
      else if (type === 'show') this.onshow = fn
      else if (type === 'error') this.onerror = fn
      else if (type === 'close') this.onclose = fn
    }
    removeEventListener(type: string, fn: Listener): void {
      if (type === 'click' && this.onclick === fn) this.onclick = null
      else if (type === 'show' && this.onshow === fn) this.onshow = null
      else if (type === 'error' && this.onerror === fn) this.onerror = null
      else if (type === 'close' && this.onclose === fn) this.onclose = null
    }
  }

  function findInstance(action: DesktopNotifyAction): DesktopNotification | undefined {
    if (action.contributor !== contributor) return
    const inst = instances.get(action.id)
    return inst !== undefined && inst._instanceId === action.instanceId ? inst : undefined
  }
  notify.onAction((action) => {
    const inst = findInstance(action)
    if (inst === undefined) return
    try {
      inst._dispatch('click')
    } finally {
      inst._finish('close')
    }
  })
  notify.onClosed((action) => {
    const inst = findInstance(action)
    if (inst !== undefined) inst._finish('close')
  })

  Object.defineProperty(window, 'Notification', {
    value: DesktopNotification,
    writable: true,
    configurable: true,
  })
}
