import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest'
import { Ipc } from '../../../../src/shared/ipc'
import type { DesktopNotifySpec } from '../../../../src/shared/api'

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
      webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        setWindowOpenHandler: vi.fn(),
      })
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
vi.mock('../../../../src/main/windows/registry', () => ({
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
  const { setupDesktopNotify } = await import('../../../../src/main/notifications/service')
  setupDesktopNotify()
})
afterEach(() => vi.useRealTimers())

test('a failed system notification reports shown false and opens no shell window', async () => {
  const wc = sender()
  const pending = show(wc)
  expect(state.windows).toHaveLength(0)
  state.notes[0].emit('failed', {}, 'UNErrorDomain 1')
  await expect(pending).resolves.toEqual({ shown: false })
  expect(wc.send).not.toHaveBeenCalled()
  expect(state.notes[0].eventNames()).toEqual([])
  expect(state.windows).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

test('no receipt counts as delivered after the confirm timeout, still without a shell window', async () => {
  const wc = sender()
  const pending = show(wc)
  await vi.advanceTimersByTimeAsync(1_499)
  expect(state.windows).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1)
  await expect(pending).resolves.toEqual({ shown: true })
  expect(state.windows).toHaveLength(0)
})

test('same-id replacement ignores late native events and keeps the current notification alive', async () => {
  const wc = sender()
  const first = show(wc)
  const old = state.notes[0]
  const second = show(wc, { instanceId: 'second' })
  const current = state.notes[1]
  expect(old.close).toHaveBeenCalledOnce()
  expect(old.eventNames()).toEqual([])
  old.emit('click')
  old.emit('failed', {}, 'late failure')
  expect(current.close).not.toHaveBeenCalled()
  expect(wc.send.mock.calls).toEqual([
    [Ipc.notify.closed, { contributor: 'plugin', id: 'message', instanceId: 'first' }],
  ])
  await expect(first).resolves.toEqual({ shown: false })
  current.emit('show')
  await expect(second).resolves.toEqual({ shown: true })
  current.emit('click')
  expect(state.windows).toHaveLength(0)
  expect(current.close).toHaveBeenCalledOnce()
  expect(wc.send.mock.calls.slice(1)).toEqual([
    [Ipc.notify.action, { contributor: 'plugin', id: 'message', instanceId: 'second' }],
    [Ipc.notify.closed, { contributor: 'plugin', id: 'message', instanceId: 'second' }],
  ])
})

test('native close releases a shown notification immediately', async () => {
  const wc = sender()
  const pending = show(wc)
  state.notes[0].emit('show')
  await expect(pending).resolves.toEqual({ shown: true })
  state.notes[0].emit('close')
  expect(wc.send.mock.calls).toEqual([
    [Ipc.notify.closed, { contributor: 'plugin', id: 'message', instanceId: 'first' }],
  ])
  expect(state.notes[0].eventNames()).toEqual([])
  expect(state.windows).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

test('native click focuses the main window and does not open a shell window', async () => {
  const wc = sender()
  const pending = show(wc)
  state.notes[0].emit('show')
  await pending
  state.notes[0].emit('click')
  expect(state.focus).toHaveBeenCalledOnce()
  expect(state.notes[0].close).toHaveBeenCalledOnce()
  expect(wc.send.mock.calls.map(([channel]) => channel)).toEqual([
    Ipc.notify.action,
    Ipc.notify.closed,
  ])
  expect(state.windows).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

test('sender disposal releases native listeners', async () => {
  const wc = sender()
  const pending = show(wc)
  wc.isDestroyed.mockReturnValue(true)
  wc.emit('destroyed')
  await expect(pending).resolves.toEqual({ shown: false })
  expect(state.windows).toHaveLength(0)
  expect(state.notes[0].eventNames()).toEqual([])
  expect(wc.listenerCount('did-start-navigation')).toBe(0)
  expect(wc.send).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

test('full navigation clears sender notifications and throttle while same-document navigation keeps them', async () => {
  const wc = sender()
  const pending = show(wc)
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  expect(state.notes[0].close).not.toHaveBeenCalled()
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(state.notes[0].close).toHaveBeenCalledOnce()
  expect(wc.send).not.toHaveBeenCalled()
  await expect(pending).resolves.toEqual({ shown: false })
  const next = show(wc, { id: 'new-page' })
  state.notes[1].emit('show')
  await expect(next).resolves.toEqual({ shown: true })
  expect(state.windows).toHaveLength(0)
})
