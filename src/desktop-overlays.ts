/**
 * Overlay 窗口所有者：主进程持有 BrowserWindow，preload 只过 JSON。
 * 插件打开同源小窗（透明置顶桌宠等）；贡献窗口销毁时自动关掉。
 * 主进程不把 BrowserWindow 交给网页。
 */

import { join } from 'node:path'
import { BrowserWindow, ipcMain, screen, session, type Session, type WebContents } from 'electron'
import {
  DESKTOP_ID_RE,
  type DesktopOverlayBounds,
  type DesktopOverlayChrome,
  type DesktopOverlayClosed,
  type DesktopOverlayIgnoreMouse,
  type DesktopOverlayInfo,
  type DesktopOverlayMoveResult,
  type DesktopOverlayOpenSpec,
  type DesktopOverlayRect,
} from './api'
import { Ipc } from './ipc'
import { setWindowRole, webContentsById } from './windows'

const MIN_SIZE = 64
const MAX_SIZE = 800
const MAX_URL = 512

interface OverlayRow {
  contributor: string
  id: string
  ownerWcId: number
  win: BrowserWindow
}

const overlays: OverlayRow[] = []
const watchedOwners = new Set<number>()
let getOrigin: () => string | null = () => null
const OVERLAY_PARTITION = 'persist:dsh-overlay'
let overlaySessionReady = false

function ensureOverlaySession(): Session {
  const ses = session.fromPartition(OVERLAY_PARTITION)
  if (!overlaySessionReady) {
    overlaySessionReady = true
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
  }
  return ses
}

function preloadFile(): string {
  return join(__dirname, 'preload.js')
}

function watchOwner(wc: WebContents): void {
  if (watchedOwners.has(wc.id)) return
  watchedOwners.add(wc.id)
  wc.once('destroyed', () => {
    closeOwned(wc.id, true)
    watchedOwners.delete(wc.id)
  })
}

function isOverlaySender(wc: WebContents): OverlayRow | undefined {
  return overlays.find((row) => !row.win.isDestroyed() && row.win.webContents.id === wc.id)
}

function resolveOverlay(sender: WebContents, id: string): OverlayRow | undefined {
  const self = isOverlaySender(sender)
  if (self !== undefined) return self.id === id ? self : undefined
  return overlays.find((row) => row.ownerWcId === sender.id && row.id === id)
}

function infoOf(row: OverlayRow): DesktopOverlayInfo {
  const b = row.win.getBounds()
  return {
    contributor: row.contributor,
    id: row.id,
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
  }
}

function sendClosed(row: OverlayRow): void {
  const event: DesktopOverlayClosed = { contributor: row.contributor, id: row.id }
  const owner = webContentsById(row.ownerWcId)
  if (owner !== undefined && !owner.isDestroyed()) owner.send(Ipc.overlays.closed, event)
}

function dispose(row: OverlayRow, notify: boolean): void {
  const idx = overlays.indexOf(row)
  if (idx >= 0) overlays.splice(idx, 1)
  if (!row.win.isDestroyed()) {
    row.win.removeAllListeners('closed')
    row.win.close()
  }
  if (notify) sendClosed(row)
}

function closeOwned(ownerWcId: number, notify: boolean): void {
  for (const row of overlays.filter((r) => r.ownerWcId === ownerWcId)) {
    dispose(row, notify)
  }
}

export function closeAllOverlays(): void {
  for (const row of [...overlays]) dispose(row, false)
}

function roundInt(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  return Math.round(n)
}

function clampSize(n: number): number {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, n))
}

function workAreaFor(x: number, y: number, width: number, height: number): Electron.Rectangle {
  return screen.getDisplayMatching({ x, y, width, height }).workArea
}

function clampRect(x: number, y: number, width: number, height: number): DesktopOverlayRect & { hitEdge: boolean } {
  const area = workAreaFor(x, y, width, height)
  const maxX = area.x + Math.max(0, area.width - width)
  const maxY = area.y + Math.max(0, area.height - height)
  const nx = Math.min(maxX, Math.max(area.x, x))
  const ny = Math.min(maxY, Math.max(area.y, y))
  return { x: nx, y: ny, width, height, hitEdge: nx !== x || ny !== y }
}

function defaultPosition(width: number, height: number): { x: number; y: number } {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
  }
}

function sanitizeIgnore(raw: unknown): DesktopOverlayIgnoreMouse | undefined {
  if (raw === 'none' || raw === 'all' || raw === 'forward') return raw
  return undefined
}

function sanitizeChrome(raw: unknown): DesktopOverlayChrome | null {
  if (raw === undefined) return {}
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const chrome: DesktopOverlayChrome = {}
  if (obj.transparent !== undefined) {
    if (typeof obj.transparent !== 'boolean') return null
    chrome.transparent = obj.transparent
  }
  if (obj.frame !== undefined) {
    if (typeof obj.frame !== 'boolean') return null
    chrome.frame = obj.frame
  }
  if (obj.alwaysOnTop !== undefined) {
    if (typeof obj.alwaysOnTop !== 'boolean') return null
    chrome.alwaysOnTop = obj.alwaysOnTop
  }
  if (obj.skipTaskbar !== undefined) {
    if (typeof obj.skipTaskbar !== 'boolean') return null
    chrome.skipTaskbar = obj.skipTaskbar
  }
  if (obj.resizable !== undefined) {
    if (typeof obj.resizable !== 'boolean') return null
    chrome.resizable = obj.resizable
  }
  if (obj.hasShadow !== undefined) {
    if (typeof obj.hasShadow !== 'boolean') return null
    chrome.hasShadow = obj.hasShadow
  }
  if (obj.ignoreMouseEvents !== undefined) {
    const ignore = sanitizeIgnore(obj.ignoreMouseEvents)
    if (ignore === undefined) return null
    chrome.ignoreMouseEvents = ignore
  }
  return chrome
}

function sanitizeBounds(raw: unknown, partial: boolean): DesktopOverlayBounds | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const bounds: DesktopOverlayBounds = { width: 0, height: 0 }
  if (obj.width !== undefined || !partial) {
    const width = roundInt(obj.width)
    if (width === null) return null
    bounds.width = clampSize(width)
  }
  if (obj.height !== undefined || !partial) {
    const height = roundInt(obj.height)
    if (height === null) return null
    bounds.height = clampSize(height)
  }
  if (obj.x !== undefined) {
    const x = roundInt(obj.x)
    if (x === null) return null
    bounds.x = x
  }
  if (obj.y !== undefined) {
    const y = roundInt(obj.y)
    if (y === null) return null
    bounds.y = y
  }
  return bounds
}

function sanitizePath(raw: unknown): { href: string; pathname: string; search: string } | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL) return null
  if (!raw.startsWith('/') || raw.startsWith('//')) return null
  if (raw.includes('\\') || raw.includes('://')) return null
  const origin = getOrigin()
  if (origin === null) return null
  try {
    const resolved = new URL(raw, origin)
    if (resolved.origin !== new URL(origin).origin) return null
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null
    if (resolved.pathname.includes('..')) return null
    return { href: resolved.href, pathname: resolved.pathname, search: resolved.search }
  } catch {
    return null
  }
}

function sanitizeOpen(raw: unknown): DesktopOverlayOpenSpec | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.contributor !== 'string' || !DESKTOP_ID_RE.test(obj.contributor)) return null
  if (typeof obj.id !== 'string' || !DESKTOP_ID_RE.test(obj.id)) return null
  const url = sanitizePath(obj.url)
  if (url === null) return null
  const bounds = sanitizeBounds(obj.bounds, false)
  if (bounds === null) return null
  const chrome = sanitizeChrome(obj.chrome)
  if (chrome === null) return null
  return { contributor: obj.contributor, id: obj.id, url: url.href, bounds, chrome }
}

function applyIgnore(win: BrowserWindow, mode: DesktopOverlayIgnoreMouse | undefined): void {
  if (mode === 'all') win.setIgnoreMouseEvents(true)
  else if (mode === 'forward') win.setIgnoreMouseEvents(true, { forward: true })
  else win.setIgnoreMouseEvents(false)
}

function applyAlwaysOnTop(win: BrowserWindow, enabled: boolean): void {
  if (enabled) {
    if (process.platform === 'darwin') win.setAlwaysOnTop(true, 'screen-saver')
    else win.setAlwaysOnTop(true)
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } else {
    win.setAlwaysOnTop(false)
    win.setVisibleOnAllWorkspaces(false)
  }
}

function applyChrome(win: BrowserWindow, chrome: DesktopOverlayChrome, initial: boolean): void {
  if (chrome.alwaysOnTop !== undefined) applyAlwaysOnTop(win, chrome.alwaysOnTop)
  else if (initial) applyAlwaysOnTop(win, false)
  if (chrome.skipTaskbar !== undefined) win.setSkipTaskbar(chrome.skipTaskbar)
  if (chrome.resizable !== undefined) win.setResizable(chrome.resizable)
  if (chrome.hasShadow !== undefined) win.setHasShadow(chrome.hasShadow)
  if (chrome.ignoreMouseEvents !== undefined) applyIgnore(win, chrome.ignoreMouseEvents)
  else if (initial) applyIgnore(win, 'none')
}

function isAllowedOverlayUrl(url: string): boolean {
  try {
    const origin = getOrigin()
    return origin !== null && new URL(url).origin === new URL(origin).origin
  } catch {
    return false
  }
}

function isBenignLoadError(err: unknown): boolean {
  const code = err !== null && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : ''
  const message = err instanceof Error ? err.message : String(err)
  return code === 'ERR_ABORTED' || code === 'ERR_FAILED' || /ERR_ABORTED|ERR_FAILED/.test(message)
}

async function loadOverlayUrl(win: BrowserWindow, url: string): Promise<void> {
  try {
    await win.loadURL(url)
    return
  } catch (err) {
    // Closing a still-loading overlay (replace / settings remount) aborts Chromium
    // with ERR_FAILED / ERR_ABORTED even when a later window loaded fine.
    if (win.isDestroyed() && isBenignLoadError(err)) return
    if (!win.isDestroyed() && win.webContents.getURL() === url && isBenignLoadError(err)) return
    throw err
  }
}

async function openOverlay(owner: WebContents, spec: DesktopOverlayOpenSpec): Promise<DesktopOverlayInfo> {
  const existing = overlays.find((row) => row.contributor === spec.contributor && !row.win.isDestroyed())
  if (existing !== undefined) {
    existing.id = spec.id
    existing.ownerWcId = owner.id
    applyChrome(existing.win, spec.chrome ?? {}, false)
    const current = existing.win.getBounds()
    const width = spec.bounds.width
    const height = spec.bounds.height
    const x = spec.bounds.x ?? current.x
    const y = spec.bounds.y ?? current.y
    const placed = clampRect(x, y, width, height)
    existing.win.setBounds({ x: placed.x, y: placed.y, width: placed.width, height: placed.height })
    if (existing.win.webContents.getURL() !== spec.url) await loadOverlayUrl(existing.win, spec.url)
    if (!existing.win.isDestroyed()) existing.win.showInactive()
    return infoOf(existing)
  }

  const chrome = spec.chrome ?? {}
  const width = spec.bounds.width
  const height = spec.bounds.height
  const pos =
    spec.bounds.x !== undefined && spec.bounds.y !== undefined
      ? { x: spec.bounds.x, y: spec.bounds.y }
      : defaultPosition(width, height)
  const placed = clampRect(pos.x, pos.y, width, height)
  const frame = chrome.frame === true
  const transparent = chrome.transparent === true

  const win = new BrowserWindow({
    x: placed.x,
    y: placed.y,
    width: placed.width,
    height: placed.height,
    transparent,
    frame,
    type: !frame && process.platform === 'darwin' ? 'panel' : undefined,
    alwaysOnTop: chrome.alwaysOnTop === true,
    focusable: false,
    show: false,
    resizable: chrome.resizable === true,
    hasShadow: chrome.hasShadow === true,
    skipTaskbar: chrome.skipTaskbar !== false && !frame ? true : chrome.skipTaskbar === true,
    fullscreenable: false,
    maximizable: false,
    minimizable: frame,
    hiddenInMissionControl: chrome.skipTaskbar === true || (!frame && chrome.skipTaskbar !== false),
    backgroundColor: transparent ? '#00000000' : '#151517',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: ensureOverlaySession(),
      preload: preloadFile(),
    },
  })
  setWindowRole(win, 'overlay')
  win.setMenuBarVisibility(false)
  win.setTitle('')
  win.setFocusable(false)
  applyChrome(win, chrome, true)

  const row: OverlayRow = {
    contributor: spec.contributor,
    id: spec.id,
    ownerWcId: owner.id,
    win,
  }
  overlays.push(row)
  watchOwner(owner)

  win.on('closed', () => {
    const idx = overlays.indexOf(row)
    if (idx >= 0) {
      overlays.splice(idx, 1)
      sendClosed(row)
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedOverlayUrl(url)) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedOverlayUrl(url)) event.preventDefault()
  })
  win.webContents.on('render-process-gone', () => {
    if (!win.isDestroyed()) win.close()
  })

  try {
    await loadOverlayUrl(win, spec.url)
  } catch (err) {
    const detail = err instanceof Error ? `${err.message} (${spec.url})` : String(err)
    console.error(`[DSH-Desktop] overlay load failed: ${detail}`)
    dispose(row, false)
    throw err instanceof Error ? err : new Error('desktop overlay failed to load')
  }
  if (win.isDestroyed()) throw new Error('desktop overlay closed while loading')
  win.showInactive()
  console.log(`[DSH-Desktop] overlay ${spec.contributor}/${spec.id} ${placed.width}x${placed.height}`)
  return infoOf(row)
}

function moveOverlay(row: OverlayRow, raw: unknown): DesktopOverlayMoveResult {
  if (raw === null || typeof raw !== 'object') throw new Error('invalid desktop overlay move')
  const obj = raw as Record<string, unknown>
  const current = row.win.getBounds()
  let x = current.x
  let y = current.y
  if (typeof obj.dx === 'number' || typeof obj.dy === 'number') {
    const dx = roundInt(obj.dx ?? 0)
    const dy = roundInt(obj.dy ?? 0)
    if (dx === null || dy === null) throw new Error('invalid desktop overlay move')
    x = current.x + dx
    y = current.y + dy
  } else {
    const nx = roundInt(obj.x)
    const ny = roundInt(obj.y)
    if (nx === null || ny === null) throw new Error('invalid desktop overlay move')
    x = nx
    y = ny
  }
  const placed = clampRect(x, y, current.width, current.height)
  row.win.setPosition(placed.x, placed.y)
  return { x: placed.x, y: placed.y, hitEdge: placed.hitEdge }
}

function updateOverlay(row: OverlayRow, raw: unknown): DesktopOverlayInfo {
  if (raw === null || typeof raw !== 'object') throw new Error('invalid desktop overlay update')
  const obj = raw as Record<string, unknown>
  if (obj.bounds !== undefined) {
    const bounds = sanitizeBounds(obj.bounds, true)
    if (bounds === null) throw new Error('invalid desktop overlay update')
    const current = row.win.getBounds()
    const width = bounds.width > 0 ? bounds.width : current.width
    const height = bounds.height > 0 ? bounds.height : current.height
    const x = bounds.x ?? current.x
    const y = bounds.y ?? current.y
    const placed = clampRect(x, y, width, height)
    row.win.setBounds({ x: placed.x, y: placed.y, width: placed.width, height: placed.height })
  }
  if (obj.chrome !== undefined) {
    const chrome = sanitizeChrome(obj.chrome)
    if (chrome === null) throw new Error('invalid desktop overlay update')
    applyChrome(row.win, chrome, false)
  }
  return infoOf(row)
}

function listFor(sender: WebContents): DesktopOverlayInfo[] {
  const self = isOverlaySender(sender)
  if (self !== undefined) return [infoOf(self)]
  return overlays.filter((row) => row.ownerWcId === sender.id && !row.win.isDestroyed()).map(infoOf)
}

/** 注册 overlay IPC。必须在 loadURL 之前调用。 */
export function setupDesktopOverlays(origin: () => string | null): void {
  getOrigin = origin
  ensureOverlaySession()

  ipcMain.handle(Ipc.overlays.open, async (event, raw: unknown): Promise<DesktopOverlayInfo> => {
    if (isOverlaySender(event.sender) !== undefined) throw new Error('overlay cannot open another overlay')
    const spec = sanitizeOpen(raw)
    if (spec === null) {
      console.warn('[DSH-Desktop] rejected overlay spec', raw)
      throw new Error('invalid desktop overlay')
    }
    watchOwner(event.sender)
    return openOverlay(event.sender, spec)
  })

  ipcMain.handle(Ipc.overlays.update, (event, id: unknown, raw: unknown): DesktopOverlayInfo => {
    if (typeof id !== 'string' || !DESKTOP_ID_RE.test(id)) throw new Error('invalid desktop overlay')
    const row = resolveOverlay(event.sender, id)
    if (row === undefined) throw new Error('desktop overlay not found')
    return updateOverlay(row, raw)
  })

  ipcMain.handle(Ipc.overlays.move, (event, id: unknown, raw: unknown): DesktopOverlayMoveResult => {
    if (typeof id !== 'string' || !DESKTOP_ID_RE.test(id)) throw new Error('invalid desktop overlay')
    const row = resolveOverlay(event.sender, id)
    if (row === undefined) throw new Error('desktop overlay not found')
    return moveOverlay(row, raw)
  })

  ipcMain.handle(
    Ipc.overlays.setIgnoreMouseEvents,
    (event, id: unknown, ignore: unknown, opts: unknown): void => {
      if (typeof id !== 'string' || !DESKTOP_ID_RE.test(id)) throw new Error('invalid desktop overlay')
      if (typeof ignore !== 'boolean') throw new Error('invalid desktop overlay')
      const row = resolveOverlay(event.sender, id)
      if (row === undefined) throw new Error('desktop overlay not found')
      const forward = opts !== null && typeof opts === 'object' && (opts as { forward?: unknown }).forward === true
      row.win.setIgnoreMouseEvents(ignore, forward ? { forward: true } : undefined)
    },
  )

  ipcMain.handle(Ipc.overlays.focus, (event, id: unknown): void => {
    if (typeof id !== 'string' || !DESKTOP_ID_RE.test(id)) throw new Error('invalid desktop overlay')
    const row = resolveOverlay(event.sender, id)
    if (row === undefined) throw new Error('desktop overlay not found')
    if (row.win.isMinimized()) row.win.restore()
    row.win.show()
    row.win.focus()
  })

  ipcMain.handle(Ipc.overlays.close, (event, id: unknown): void => {
    if (typeof id !== 'string' || !DESKTOP_ID_RE.test(id)) return
    const row = resolveOverlay(event.sender, id)
    if (row === undefined) return
    dispose(row, true)
  })

  ipcMain.handle(Ipc.overlays.list, (event): DesktopOverlayInfo[] => listFor(event.sender))
}
