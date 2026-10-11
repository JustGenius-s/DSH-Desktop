/**
 * 系统通知所有者：主进程用 Electron Notification 弹出，preload 只过 JSON。
 * 不是席位——没有合并/重建，同 contributor+id 替换，窗口销毁或 close 即消失。
 *
 * 只走系统通知。壳内自绘浮层会在系统没把通知发出时仍然显示，所以不再画。
 * `shown` 等系统回执：`failed` 返回 false；1.5 秒内没有回执则按已投递。
 */

import {
  Notification,
  ipcMain,
  type WebContents,
  type WebContentsDidStartNavigationEventParams,
} from 'electron'
import {
  DESKTOP_ID_RE,
  type DesktopNotifyAction,
  type DesktopNotifyResult,
  type DesktopNotifySpec,
} from '../../shared/api'
import { Ipc } from '../../shared/ipc'
import { focusMainWindow, webContentsById } from '../windows/registry'
import { MAX_BODY, MAX_TITLE, WEB_NOTIFICATION_CONTRIBUTOR } from './constants'

const MAX_ACTIVE_PER_CONTRIBUTOR = 3
const MIN_NEW_ID_INTERVAL_MS = 10_000
/** 等系统回执（show / failed）的上限；超时按已投递处理，不拖住调用方。 */
const SHOW_CONFIRM_TIMEOUT_MS = 1_500

interface ActiveNote {
  contributor: string
  id: string
  wcId: number
  instanceId?: string
  notification: Notification | null
  confirmed: boolean
  removeListeners: () => void
  /** 还在等回执时被关掉、替换或失败：这次 show 算失败。 */
  cancelConfirm?: () => void
  /** 用户点到了通知，说明它确实出现过。 */
  acceptConfirm?: () => void
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
  if (obj.instanceId !== undefined) {
    if (typeof obj.instanceId !== 'string' || !DESKTOP_ID_RE.test(obj.instanceId)) return null
    spec.instanceId = obj.instanceId
  }
  if (typeof obj.silent === 'boolean') spec.silent = obj.silent
  return spec
}

function sendEvent(row: ActiveNote, channel: string): void {
  const target = webContentsById(row.wcId)
  if (target === undefined || target.isDestroyed()) return
  const action: DesktopNotifyAction = { contributor: row.contributor, id: row.id }
  if (row.instanceId !== undefined) action.instanceId = row.instanceId
  target.send(channel, action)
}

function drop(row: ActiveNote, notify = true): void {
  const idx = active.indexOf(row)
  if (idx < 0) return
  // 先释放所有权和事件，再调用可能同步触发 close 的原生 API。
  active.splice(idx, 1)
  const cancel = row.cancelConfirm
  row.cancelConfirm = undefined
  row.acceptConfirm = undefined
  row.removeListeners()
  try {
    row.notification?.close()
  } catch {
    // 系统侧可能已经关掉。
  }
  if (notify) sendEvent(row, Ipc.notify.closed)
  cancel?.()
}

function closeMatching(wcId: number, contributor: string, id?: string): void {
  for (const row of [...active]) {
    if (row.wcId !== wcId || row.contributor !== contributor) continue
    if (id !== undefined && row.id !== id) continue
    drop(row)
  }
}

function closeWindow(wcId: number): void {
  for (const row of [...active]) {
    if (row.wcId === wcId) drop(row, false)
  }
  for (const key of lastShownId.keys()) {
    if (key.startsWith(`${wcId}:`)) lastShownId.delete(key)
  }
  for (const key of lastNewIdAt.keys()) {
    if (key.startsWith(`${wcId}:`)) lastNewIdAt.delete(key)
  }
}

function watchSender(wc: WebContents): void {
  if (watchedWc.has(wc.id)) return
  watchedWc.add(wc.id)
  const onNavigation = (details: WebContentsDidStartNavigationEventParams): void => {
    if (details.isMainFrame && !details.isSameDocument) closeWindow(wc.id)
  }
  wc.on('did-start-navigation', onNavigation)
  wc.once('destroyed', () => {
    closeWindow(wc.id)
    wc.removeListener('did-start-navigation', onNavigation)
    watchedWc.delete(wc.id)
  })
}

function countContributor(wcId: number, contributor: string): number {
  return active.filter((row) => row.wcId === wcId && row.contributor === contributor).length
}

/** 等系统 `show` 或超时。中途被关掉、替换或 `failed` 则结束为未展示。 */
function beginConfirm(row: ActiveNote, notification: Notification): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (shown: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      notification.removeListener('show', onShow)
      row.cancelConfirm = undefined
      row.acceptConfirm = undefined
      if (shown) row.confirmed = true
      resolve(shown)
    }
    const onShow = (): void => finish(true)
    timer = setTimeout(() => finish(true), SHOW_CONFIRM_TIMEOUT_MS)
    timer.unref?.()
    row.cancelConfirm = () => finish(false)
    row.acceptConfirm = () => finish(true)
    notification.on('show', onShow)
  })
}

async function showNote(wc: WebContents, spec: DesktopNotifySpec): Promise<DesktopNotifyResult> {
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
    instanceId: spec.instanceId,
    wcId: wc.id,
    notification,
    confirmed: false,
    removeListeners: () => {
      notification.removeListener('click', onAction)
      notification.removeListener('close', onNativeClosed)
      notification.removeListener('failed', onNativeFailed)
    },
  }
  active.push(row)

  const onAction = (): void => {
    if (!active.includes(row)) return
    row.acceptConfirm?.()
    focusMainWindow()
    sendEvent(row, Ipc.notify.action)
    drop(row)
  }
  const onNativeClosed = (): void => {
    if (!active.includes(row)) return
    // 还没有 show 回执时，关闭只结束这次 show，不把它报成已展示。
    drop(row, row.confirmed)
  }
  const onNativeFailed = (_event: unknown, error: string): void => {
    console.warn('[DSH-Desktop] notification failed', spec.contributor, spec.id, error)
    if (!active.includes(row)) return
    drop(row, row.confirmed)
  }
  notification.on('click', onAction)
  notification.on('close', onNativeClosed)
  notification.on('failed', onNativeFailed)

  const pending = beginConfirm(row, notification)
  try {
    notification.show()
  } catch (err) {
    console.warn('[DSH-Desktop] notification.show failed', err)
    drop(row, false)
    return { shown: false }
  }

  const shown = await pending
  if (!shown) {
    if (active.includes(row)) drop(row, false)
    return { shown: false }
  }

  console.log(`[DSH-Desktop] notify ${spec.contributor}:${spec.id}`)
  return { shown: true }
}

let initialized = false

/** 注册通知 IPC。必须在 loadURL 之前调用。 */
export function setupDesktopNotify(): void {
  if (initialized) return
  initialized = true
  ipcMain.handle(Ipc.notify.show, (event, raw: unknown): Promise<DesktopNotifyResult> => {
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
