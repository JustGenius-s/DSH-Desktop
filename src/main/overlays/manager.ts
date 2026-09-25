/**
 * Overlay 窗口所有者：主进程持有 BrowserWindow，preload 只过 JSON。
 * 插件打开同源小窗（透明置顶桌宠等）；贡献窗口销毁时自动关掉。
 * 主进程不把 BrowserWindow 交给网页。
 */

import { BrowserWindow, ipcMain, screen, type WebContents } from 'electron'
import {
  DESKTOP_ID_RE,
  type DesktopOverlayChrome,
  type DesktopOverlayClosed,
  type DesktopOverlayIgnoreMouse,
  type DesktopOverlayInfo,
  type DesktopOverlayMoveResult,
  type DesktopOverlayOpenSpec,
  type DesktopOverlayRect,
} from '../../shared/api'
import { Ipc } from '../../shared/ipc'
import { enforceRegularDockPolicy } from '../platform/dock-policy'
import { preloadPath } from '../platform/paths'
import { setWindowRole, webContentsById } from '../windows/registry'
import { roundInt, sanitizeBounds, sanitizeChrome, sanitizeOpen } from './validation'

interface OverlayRow {
  contributor: string
  id: string
  ownerWcId: number
  win: BrowserWindow
}

const overlays: OverlayRow[] = []
const watchedOwners = new Set<number>()
let getOrigin: () => string | null = () => null
/** 主窗口还没前置完成时，立刻 *显示* overlay 会抢前台。窗体本身必须更早建好。 */
let overlaysReleased = false
const overlayWaiters: Array<() => void> = []
/**
 * macOS 26 + Electron 43：页面起来之后再 `new BrowserWindow` 会在主线程
 * SetRootCerts SIGSEGV。启动时（和 splash 同期）预建一扇隐藏窗，之后只复用。
 */
let idleOverlay: BrowserWindow | null = null

/** 主窗口完成前置后再放行桌宠等 overlay。 */
export function allowOverlays(): void {
  overlaysReleased = true
  while (overlayWaiters.length > 0) overlayWaiters.pop()?.()
}

function whenOverlaysAllowed(): Promise<void> {
  if (overlaysReleased) return Promise.resolve()
  return new Promise((resolve) => overlayWaiters.push(resolve))
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

function recycleOverlayWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.hide()
  applyAlwaysOnTop(win, false)
  applyIgnore(win, 'none')
  void win.loadURL('about:blank').catch(() => {})
  if (idleOverlay === null || idleOverlay.isDestroyed()) idleOverlay = win
  else win.close()
}

function dispose(row: OverlayRow, notify: boolean): void {
  const idx = overlays.indexOf(row)
  if (idx >= 0) overlays.splice(idx, 1)
  if (!row.win.isDestroyed()) {
    row.win.removeAllListeners('closed')
    recycleOverlayWindow(row.win)
  }
  if (notify) sendClosed(row)
}

function closeOwned(ownerWcId: number, notify: boolean): void {
  for (const row of overlays.filter((r) => r.ownerWcId === ownerWcId)) {
    dispose(row, notify)
  }
}

export function closeAllOverlays(): void {
  for (const row of [...overlays]) {
    const idx = overlays.indexOf(row)
    if (idx >= 0) overlays.splice(idx, 1)
    if (!row.win.isDestroyed()) {
      row.win.removeAllListeners('closed')
      row.win.close()
    }
  }
  if (idleOverlay !== null && !idleOverlay.isDestroyed()) idleOverlay.close()
  idleOverlay = null
}

function createOverlayBrowserWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 330,
    height: 230,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: false,
    focusable: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    hiddenInMissionControl: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath(),
    },
  })
  setWindowRole(win, 'overlay')
  win.setMenuBarVisibility(false)
  win.setTitle('')
  win.setFocusable(false)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedOverlayUrl(url)) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedOverlayUrl(url)) event.preventDefault()
  })
  return win
}

/** 与 splash 同期调用：此时建窗安全，页面加载后再建会 SIGSEGV。 */
export function prewarmOverlayWindow(): void {
  if (idleOverlay !== null && !idleOverlay.isDestroyed()) return
  idleOverlay = createOverlayBrowserWindow()
  void idleOverlay.loadURL('about:blank').catch(() => {})
}

function adoptIdleOverlayWindow(): BrowserWindow {
  const win = idleOverlay !== null && !idleOverlay.isDestroyed() ? idleOverlay : null
  idleOverlay = null
  if (win !== null) return win
  console.warn(
    '[DSH-Desktop] overlay prewarm missed; creating a window now (may SIGSEGV on macOS 26)',
  )
  return createOverlayBrowserWindow()
}

function workAreaFor(x: number, y: number, width: number, height: number): Electron.Rectangle {
  return screen.getDisplayMatching({ x, y, width, height }).workArea
}

function clampRect(
  x: number,
  y: number,
  width: number,
  height: number,
): DesktopOverlayRect & { hitEdge: boolean } {
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

function applyIgnore(win: BrowserWindow, mode: DesktopOverlayIgnoreMouse | undefined): void {
  if (mode === 'all') win.setIgnoreMouseEvents(true)
  else if (mode === 'forward') win.setIgnoreMouseEvents(true, { forward: true })
  else win.setIgnoreMouseEvents(false)
}

function applyAlwaysOnTop(win: BrowserWindow, enabled: boolean): void {
  if (win.isDestroyed()) return
  if (enabled) {
    // 分层：普通浮动窗口即可。不要用 screen-saver / panel / pop-up-menu 变体——
    // macOS 上 setVisibleOnAllWorkspaces(true) 会让 AppKit 把应用判为辅助应用，
    // Dock 会删除应用的 tile（表现为「Dock 图标闪一下就没」，且不可恢复）。
    // 注意 setAlwaysOnTop(true) 的默认 level 就是 'floating'，两者等价；
    // 显式写出来只为让「不要抬高层级」这件事在代码里看得见。
    if (process.platform === 'darwin') win.setAlwaysOnTop(true, 'floating')
    else win.setAlwaysOnTop(true)
  } else {
    win.setAlwaysOnTop(false)
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
  if (url === 'about:blank') return true
  try {
    const origin = getOrigin()
    return origin !== null && new URL(url).origin === new URL(origin).origin
  } catch {
    return false
  }
}

function isBenignLoadError(err: unknown): boolean {
  const code =
    err !== null && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code)
      : ''
  const message = err instanceof Error ? err.message : String(err)
  return code === 'ERR_ABORTED' || code === 'ERR_FAILED' || /ERR_ABORTED|ERR_FAILED/.test(message)
}

function isDestroyedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /Object has been destroyed|Render frame was disposed/i.test(message)
}

async function loadOverlayUrl(win: BrowserWindow, url: string): Promise<void> {
  if (win.isDestroyed()) return
  try {
    await win.loadURL(url)
    return
  } catch (err) {
    // Closing a still-loading overlay (replace / settings remount) aborts
    // Chromium, or throws TypeError once the BrowserWindow is already gone.
    if (win.isDestroyed() || isDestroyedError(err)) return
    if (isBenignLoadError(err)) {
      try {
        if (win.webContents.getURL() === url) return
      } catch {
        return
      }
    }
    throw err
  }
}

async function openOverlay(
  owner: WebContents,
  spec: DesktopOverlayOpenSpec,
): Promise<DesktopOverlayInfo> {
  await whenOverlaysAllowed()
  if (owner.isDestroyed()) throw new Error('desktop overlay owner gone')
  const existing = overlays.find(
    (row) => row.contributor === spec.contributor && !row.win.isDestroyed(),
  )
  if (existing !== undefined) {
    existing.id = spec.id
    existing.ownerWcId = owner.id
    const reuseChrome = spec.chrome ?? {}
    applyChrome(existing.win, { ...reuseChrome, alwaysOnTop: undefined }, false)
    const current = existing.win.getBounds()
    const width = spec.bounds.width
    const height = spec.bounds.height
    const x = spec.bounds.x ?? current.x
    const y = spec.bounds.y ?? current.y
    const placed = clampRect(x, y, width, height)
    existing.win.setBounds({ x: placed.x, y: placed.y, width: placed.width, height: placed.height })
    if (existing.win.webContents.getURL() !== spec.url) {
      if (existing.win.isDestroyed()) throw new Error('desktop overlay closed while loading')
      await loadOverlayUrl(existing.win, spec.url)
    }
    if (!existing.win.isDestroyed()) {
      existing.win.show()
      if (reuseChrome.alwaysOnTop !== undefined)
        applyAlwaysOnTop(existing.win, reuseChrome.alwaysOnTop)
    }
    enforceRegularDockPolicy()
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
  // 预建窗固定为无框透明；frame / transparent 因此只影响运行期可改的属性。
  const frame = chrome.frame === true
  const transparent = chrome.transparent === true

  // 复用启动时预建的隐藏窗：页面加载完再 new BrowserWindow 会撞
  // Electron 43 + macOS 26 的 SetRootCerts SIGSEGV（见 prewarmOverlayWindow）。
  const win = adoptIdleOverlayWindow()
  if (win.isDestroyed()) throw new Error('desktop overlay closed while loading')
  win.setBounds({ x: placed.x, y: placed.y, width: placed.width, height: placed.height })
  // 预建窗按最保守的形态出生（透明 / 无框），open 时再按请求调整成最终形态。
  // 这些属性在运行期可改，但必须在 show 之前改完，否则会看到一帧错形态。
  win.setResizable(chrome.resizable === true)
  win.setHasShadow(chrome.hasShadow === true)
  win.setSkipTaskbar(chrome.skipTaskbar !== false && !frame ? true : chrome.skipTaskbar === true)
  win.setHiddenInMissionControl(
    chrome.skipTaskbar === true || (!frame && chrome.skipTaskbar !== false),
  )
  win.setBackgroundColor(transparent ? '#00000000' : '#151517')
  // alwaysOnTop 留到 show 之后再设：创建期设成浮层会让窗口在加载期间抢层级。
  applyChrome(win, { ...chrome, alwaysOnTop: undefined }, true)

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
    idleOverlay = null
  })
  win.webContents.on('render-process-gone', () => {
    dispose(row, true)
  })

  try {
    if (win.isDestroyed()) throw new Error('desktop overlay closed while loading')
    await loadOverlayUrl(win, spec.url)
  } catch (err) {
    const closed =
      win.isDestroyed() ||
      isDestroyedError(err) ||
      (err instanceof Error && err.message === 'desktop overlay closed while loading')
    dispose(row, false)
    if (closed) throw new Error('desktop overlay closed while loading')
    const detail = err instanceof Error ? `${err.message} (${spec.url})` : String(err)
    console.error(`[DSH-Desktop] overlay load failed: ${detail}`)
    throw err instanceof Error ? err : new Error('desktop overlay failed to load')
  }
  if (win.isDestroyed()) throw new Error('desktop overlay closed while loading')
  win.show()
  if (chrome.alwaysOnTop === true) applyAlwaysOnTop(win, true)
  // 幂等守卫：overlay 打开后把被压掉的 Dock tile 拉回来。
  enforceRegularDockPolicy()
  console.log(
    `[DSH-Desktop] overlay ${spec.contributor}/${spec.id} ${placed.width}x${placed.height}`,
  )
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
  overlaysReleased = false
  overlayWaiters.length = 0

  ipcMain.handle(Ipc.overlays.open, async (event, raw: unknown): Promise<DesktopOverlayInfo> => {
    if (isOverlaySender(event.sender) !== undefined)
      throw new Error('overlay cannot open another overlay')
    const spec = sanitizeOpen(raw, getOrigin())
    if (spec === null) {
      console.warn('[DSH-Desktop] rejected overlay spec', raw)
      throw new Error('invalid desktop overlay')
    }
    watchOwner(event.sender)
    return openOverlay(event.sender, spec)
  })

  ipcMain.handle(Ipc.overlays.update, (event, id: unknown, raw: unknown): DesktopOverlayInfo => {
    if (typeof id !== 'string' || !DESKTOP_ID_RE.test(id))
      throw new Error('invalid desktop overlay')
    const row = resolveOverlay(event.sender, id)
    if (row === undefined) throw new Error('desktop overlay not found')
    return updateOverlay(row, raw)
  })

  ipcMain.handle(
    Ipc.overlays.move,
    (event, id: unknown, raw: unknown): DesktopOverlayMoveResult => {
      if (typeof id !== 'string' || !DESKTOP_ID_RE.test(id))
        throw new Error('invalid desktop overlay')
      const row = resolveOverlay(event.sender, id)
      if (row === undefined) throw new Error('desktop overlay not found')
      return moveOverlay(row, raw)
    },
  )

  ipcMain.handle(
    Ipc.overlays.setIgnoreMouseEvents,
    (event, id: unknown, ignore: unknown, opts: unknown): void => {
      if (typeof id !== 'string' || !DESKTOP_ID_RE.test(id))
        throw new Error('invalid desktop overlay')
      if (typeof ignore !== 'boolean') throw new Error('invalid desktop overlay')
      const row = resolveOverlay(event.sender, id)
      if (row === undefined) throw new Error('desktop overlay not found')
      const forward =
        opts !== null &&
        typeof opts === 'object' &&
        (opts as { forward?: unknown }).forward === true
      row.win.setIgnoreMouseEvents(ignore, forward ? { forward: true } : undefined)
    },
  )

  ipcMain.handle(Ipc.overlays.activateOwner, (event, id: unknown): void => {
    if (typeof id !== 'string' || !DESKTOP_ID_RE.test(id))
      throw new Error('invalid desktop overlay')
    const row = resolveOverlay(event.sender, id)
    if (row === undefined) throw new Error('desktop overlay not found')
    const owner = webContentsById(row.ownerWcId)
    const ownerWindow = owner === undefined ? null : BrowserWindow.fromWebContents(owner)
    if (ownerWindow === null || ownerWindow.isDestroyed())
      throw new Error('desktop overlay owner not found')
    if (ownerWindow.isMinimized()) ownerWindow.restore()
    ownerWindow.show()
    ownerWindow.focus()
  })

  ipcMain.handle(Ipc.overlays.focus, (event, id: unknown): void => {
    if (typeof id !== 'string' || !DESKTOP_ID_RE.test(id))
      throw new Error('invalid desktop overlay')
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
