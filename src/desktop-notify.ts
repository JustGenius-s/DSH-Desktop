/**
 * 系统通知所有者：主进程用 Electron Notification 弹出，preload 只过 JSON。
 * 不是席位——没有合并/重建，同 contributor+id 替换，窗口销毁或 close 即消失。
 */

import { Notification, ipcMain, type WebContents } from 'electron'
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
    if (prevId !== spec.id) {
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
    drop(row)
  })

  try {
    notification.show()
  } catch (err) {
    console.warn('[DSH-Desktop] notification.show failed', err)
    drop(row)
    return { shown: false }
  }

  console.log(`[DSH-Desktop] notify ${keyOf(spec.contributor, spec.id)}`)
  return { shown: true }
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
