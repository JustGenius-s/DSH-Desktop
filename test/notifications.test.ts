import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest'
import { Ipc } from '../src/shared/ipc'
import type { DesktopNotifySpec } from '../src/shared/api'

type MockWindow = EventEmitter & {
  webContents: EventEmitter
  isDestroyed: () => boolean
}
type MockNotification = EventEmitter & { close: Mock }
type Sender = EventEmitter & { id: number; isDestroyed: Mock; send: Mock }

const state = vi.hoisted(() => ({
  windows: [] as MockWindow[],
  notes: [] as MockNotification[],
  senders: new Map<number, Sender>(),
  handles: new Map<string, (event: { sender: Sender }, ...args: unknown[]) => unknown>(),
  focus: vi.fn(),
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    BrowserWindow: class extends EventEmitter {
      webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false })
      destroyed = false
      isDestroyed = () => this.destroyed
      close = vi.fn(() => {
        this.destroyed = true
        this.emit('closed')
      })
      showInactive = vi.fn()
      setAlwaysOnTop = vi.fn()
      loadURL = vi.fn().mockResolvedValue(undefined)
      constructor() {
        super()
        state.windows.push(this)
      }
    },
    Notification: class extends EventEmitter {
      static isSupported = () => true
      close = vi.fn(() => this.emit('close'))
      show = vi.fn()
      constructor() {
        super()
        state.notes.push(this)
      }
    },
    ipcMain: { handle: (channel: string, handler: never) => state.handles.set(channel, handler) },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }) },
  }
})
vi.mock('../src/main/windows/registry', () => ({
  focusMainWindow: state.focus,
  webContentsById: (id: number) => state.senders.get(id),
}))

function sender(id = 1): Sender {
  const wc = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  })
  state.senders.set(id, wc)
  return wc
}

const spec: DesktopNotifySpec = {
  contributor: 'plugin',
  id: 'message',
  instanceId: 'first',
  title: 'Title',
  body: 'Body',
}

function show(wc: Sender, overrides: Partial<DesktopNotifySpec> = {}): unknown {
  return state.handles.get(Ipc.notify.show)!({ sender: wc }, { ...spec, ...overrides })
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(60_000)
  state.windows.length = 0
  state.notes.length = 0
  state.senders.clear()
  state.handles.clear()
  state.focus.mockClear()
  const { setupDesktopNotify } = await import('../src/main/notifications/service')
  setupDesktopNotify()
})
afterEach(() => vi.useRealTimers())

test('a replaced banner owns its timer and late closed event cannot remove its replacement', async () => {
  const { showBannerOverlay, closeBanner, bannerKey } =
    await import('../src/main/notifications/banners')
  const firstClosed = vi.fn()
  const secondClosed = vi.fn()
  showBannerOverlay(1, spec, { onAction: vi.fn(), onClosed: firstClosed })
  const first = state.windows[0]
  vi.advanceTimersByTime(5000)
  showBannerOverlay(1, spec, { onAction: vi.fn(), onClosed: secondClosed })
  const second = state.windows[1]
  expect(firstClosed).toHaveBeenCalledTimes(1)
  expect(first.listenerCount('ready-to-show')).toBe(0)
  expect(first.webContents.listenerCount('will-navigate')).toBe(0)
  first.emit('closed')
  vi.advanceTimersByTime(1000)
  expect(second.isDestroyed()).toBe(false)
  closeBanner(bannerKey(1, spec.contributor, spec.id))
  expect(second.isDestroyed()).toBe(true)
  expect(secondClosed).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

test('same-id replacement ignores late native events and keeps the current notification alive', () => {
  const wc = sender()
  show(wc)
  const old = state.notes[0]
  show(wc, { instanceId: 'second' })
  const current = state.notes[1]
  expect(old.close).toHaveBeenCalledOnce()
  expect(old.eventNames()).toEqual([])
  old.emit('click')
  old.emit('failed', {}, 'late failure')
  expect(current.close).not.toHaveBeenCalled()
  expect(wc.send.mock.calls).toEqual([
    [Ipc.notify.closed, { contributor: 'plugin', id: 'message', instanceId: 'first' }],
  ])
  current.emit('click')
  expect(state.windows[1].isDestroyed()).toBe(true)
  expect(current.close).toHaveBeenCalledOnce()
  expect(wc.send.mock.calls.slice(1)).toEqual([
    [Ipc.notify.action, { contributor: 'plugin', id: 'message', instanceId: 'second' }],
    [Ipc.notify.closed, { contributor: 'plugin', id: 'message', instanceId: 'second' }],
  ])
})

test('native close keeps a visible banner actionable, and the final presentation sends closed', () => {
  const wc = sender()
  show(wc)
  state.notes[0].emit('close')
  expect(wc.send).not.toHaveBeenCalled()
  vi.advanceTimersByTime(6000)
  expect(wc.send.mock.calls).toEqual([
    [Ipc.notify.closed, { contributor: 'plugin', id: 'message', instanceId: 'first' }],
  ])
  expect(state.notes[0].eventNames()).toEqual([])
})

test('banner click closes native presentation even when the system never fires a click', () => {
  const wc = sender()
  show(wc)
  const event = { url: 'dsh-notify://click', preventDefault: vi.fn() }
  state.windows[0].webContents.emit('will-navigate', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(state.focus).toHaveBeenCalledOnce()
  expect(state.notes[0].close).toHaveBeenCalledOnce()
  expect(wc.send.mock.calls.map(([channel]) => channel)).toEqual([
    Ipc.notify.action,
    Ipc.notify.closed,
  ])
  expect(vi.getTimerCount()).toBe(0)
})

test('sender disposal releases banners and native listeners', () => {
  const wc = sender()
  show(wc)
  wc.isDestroyed.mockReturnValue(true)
  wc.emit('destroyed')
  expect(state.windows[0].isDestroyed()).toBe(true)
  expect(state.notes[0].eventNames()).toEqual([])
  expect(wc.listenerCount('did-start-navigation')).toBe(0)
  expect(wc.send).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

test('full navigation clears sender notifications and throttle while same-document navigation keeps them', () => {
  const wc = sender()
  show(wc)
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  expect(state.windows[0].isDestroyed()).toBe(false)
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(state.windows[0].isDestroyed()).toBe(true)
  expect(wc.send).not.toHaveBeenCalled()
  expect(show(wc, { id: 'new-page' })).toEqual({ shown: true })
})
