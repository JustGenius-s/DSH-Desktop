const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { join } = require('node:path')
const vm = require('node:vm')
const { Ipc } = require('../dist/shared/ipc')

function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

function harness() {
  const windows = [],
    handlers = new Map()
  const owner = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false })
  class Window extends EventEmitter {
    constructor(options) {
      super()
      this.bounds = { x: 0, y: 0, width: 64, height: 64 }
      this.destroyed = false
      this.contentsDestroyed = false
      this.shows = 0
      this.loads = []
      this.url = ''
      this.webContents = Object.assign(new EventEmitter(), {
        id: windows.length + 2,
        isDestroyed: () => this.contentsDestroyed,
        getURL: () => this.url,
        setWindowOpenHandler() {},
      })
      windows.push(this)
    }
    isDestroyed() {
      return this.destroyed
    }
    getBounds() {
      return this.bounds
    }
    setBounds(bounds) {
      this.bounds = bounds
    }
    setMenuBarVisibility() {}
    setTitle() {}
    setFocusable() {}
    setAlwaysOnTop() {}
    setIgnoreMouseEvents() {}
    setSkipTaskbar() {}
    setResizable() {}
    setHasShadow() {}
    setHiddenInMissionControl() {}
    setBackgroundColor() {}
    hide() {}
    loadURL(url) {
      this.url = url
      const load = deferred()
      this.loads.push(load)
      return load.promise
    }
    show() {
      assert.equal(this.contentsDestroyed, false, 'would show a window with destroyed contents')
      this.shows += 1
    }
    close() {
      // Reproduce the native interval: contents die before the window does.
      this.contentsDestroyed = true
      for (const load of this.loads) load.reject(new Error('Object has been destroyed'))
    }
  }
  const area = { x: 0, y: 0, width: 1000, height: 800 }
  const electron = {
    BrowserWindow: Window,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    screen: {
      getDisplayMatching: () => ({ workArea: area }),
      getDisplayNearestPoint: () => ({ workArea: area }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    },
  }
  const path = join(__dirname, '../dist/main/overlays/manager.js')
  const localRequire = createRequire(path)
  const exports = {}
  const context = {
    exports,
    __dirname: join(__dirname, '../dist/main/overlays'),
    process,
    URL,
    Error,
    console: { ...console, log() {}, error() {} },
    require(name) {
      if (name === 'electron') return electron
      if (name === '../platform/dock-policy') return { enforceRegularDockPolicy() {} }
      if (name === '../platform/paths') return { preloadPath: () => 'preload.js' }
      if (name === '../windows/registry') return { setWindowRole() {}, webContentsById() {} }
      return localRequire(name)
    },
  }
  vm.runInNewContext(readFileSync(path, 'utf8'), context, { filename: path })
  exports.setupDesktopOverlays(() => 'http://127.0.0.1:12345')
  exports.allowOverlays()
  const open = (url = '/overlay', id = 'overlay') =>
    handlers.get(Ipc.overlays.open)(
      { sender: owner },
      {
        contributor: 'probe',
        id,
        url,
        bounds: { width: 64, height: 64 },
      },
    )
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  return { ...exports, windows, open, tick }
}

test('restart during initial load never shows a window with destroyed contents', async () => {
  const h = harness()
  const pending = h.open()
  const rejected = assert.rejects(pending, /closed while loading/)
  await h.tick()
  h.closeAllOverlays()
  await rejected
  assert.equal(h.windows[0].isDestroyed(), false)
  assert.equal(h.windows[0].contentsDestroyed, true)
  assert.equal(h.windows[0].shows, 0)
})

test('concurrent opens reuse one window without aborting each others navigation', async () => {
  const h = harness()
  const first = h.open('/first')
  const second = h.open('/second')
  await h.tick()
  assert.equal(h.windows.length, 1)
  assert.equal(h.windows[0].loads.length, 1)
  h.windows[0].loads[0].resolve()
  await first
  await h.tick()
  assert.equal(h.windows[0].loads.length, 2)
  h.windows[0].loads[1].resolve()
  await second
  assert.equal(h.windows[0].shows, 2)
})

test('restart cancels a reused window navigation and any queued reopen', async () => {
  const h = harness()
  const initial = h.open()
  await h.tick()
  h.windows[0].loads[0].resolve()
  await initial
  const pending = h.open('/next')
  const queued = h.open('/queued')
  const rejected = [pending, queued].map((p) => assert.rejects(p, /closed while loading/))
  await h.tick()
  h.closeAllOverlays()
  await Promise.all(rejected)
  assert.equal(h.windows.length, 1)
  assert.equal(h.windows[0].shows, 1)
})

test('a failed load at the requested URL is never treated as ready to show', async () => {
  const h = harness()
  const pending = h.open()
  const rejected = assert.rejects(pending, /ERR_FAILED/)
  await h.tick()
  h.windows[0].loads[0].reject(new Error('ERR_FAILED'))
  await rejected
  assert.equal(h.windows[0].shows, 0)
})

test('even a resolved navigation cannot show already-destroyed contents', async () => {
  const h = harness()
  const pending = h.open()
  const rejected = assert.rejects(pending, /closed while loading/)
  await h.tick()
  h.windows[0].contentsDestroyed = true
  h.windows[0].loads[0].resolve()
  await rejected
  assert.equal(h.windows[0].shows, 0)
})
