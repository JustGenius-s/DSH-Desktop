const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { Ipc } = require('../dist/shared/ipc.js')

function loadPreload(invoke = async () => ({ shown: true })) {
  const reportedErrors = []
  const page = { reportError: (error) => reportedErrors.push(error) }
  const calls = []
  const bridgeSources = []
  const instanceMaps = []
  class InstanceMap extends Map {
    constructor(...args) {
      super(...args)
      instanceMaps.push(this)
    }
  }
  const ipcRenderer = new EventEmitter()
  ipcRenderer.invoke = async (...args) => {
    calls.push(args)
    return invoke(...args)
  }
  ipcRenderer.send = (...args) => calls.push(args)
  const electron = {
    ipcRenderer,
    contextBridge: {
      exposeInMainWorld: (name, api) => {
        page[name] = api
      },
    },
    webFrame: {
      executeJavaScript: async (source) => {
        bridgeSources.push(source)
        return runInNewContext(source, {
          window: page,
          Event,
          Map: InstanceMap,
          Date: { now: () => 12345 },
        })
      },
    },
  }
  runInNewContext(readFileSync(join(__dirname, '../dist/preload.js'), 'utf8'), {
    exports: {},
    require: (name) => {
      assert.equal(name, 'electron', 'sandboxed preload cannot require local modules')
      return electron
    },
  })
  return {
    page,
    api: page.dshDesktop,
    calls,
    ipcRenderer,
    bridgeSources,
    instances: instanceMaps[0],
    reportedErrors,
  }
}

test('sandboxed preload exposes every desktop capability without local requires', async () => {
  const { api, calls } = loadPreload()
  assert.deepEqual(Object.keys(api), ['updates', 'seats', 'notify', 'overlays', 'plugins'])
  const spec = { contributor: 'plugin', id: 'pet', url: '/pet' }
  await api.overlays.open(spec)
  await api.updates.restartWeb()
  await api.plugins.setEnabled('@example/plugin', false)
  assert.deepEqual(calls, [
    [Ipc.overlays.open, spec],
    [Ipc.updates.restartWeb],
    [Ipc.plugins.setEnabled, '@example/plugin', false],
  ])
})

test('desktop event subscriptions forward payloads and can be removed', () => {
  const { api, ipcRenderer } = loadPreload()
  const received = []
  const unsubscribe = api.seats.onAction((action) => received.push(action))
  const action = { contributor: 'plugin', seat: 'tray', id: 'open' }
  ipcRenderer.emit(Ipc.seats.action, {}, action)
  unsubscribe()
  ipcRenderer.emit(Ipc.seats.action, {}, action)
  assert.deepEqual(received, [action])
})

test('page notifications use desktop IPC and route clicks to the matching notification', async () => {
  const { page, calls, ipcRenderer } = loadPreload()
  const note = new page.Notification('A'.repeat(100), { body: 'B'.repeat(300), tag: 'hello world' })
  const [channel, spec] = calls[0]
  assert.equal(channel, Ipc.notify.show)
  assert.equal(spec.title.length, 80)
  assert.equal(spec.body.length, 240)
  assert.equal(spec.id, 'hello-world')
  let clicks = 0
  note.onclick = () => {
    clicks += 1
  }
  ipcRenderer.emit(Ipc.notify.action, {}, { contributor: 'another-plugin', id: spec.id })
  ipcRenderer.emit(Ipc.notify.action, {}, spec)
  assert.equal(clicks, 1)
  note.close()
  assert.equal(calls.length, 1, 'click already releases the notification')
})

test('sandboxed preload inlines the canonical notification script', () => {
  const { WEB_NOTIFICATION_BRIDGE } = require('../dist/main/notifications/web-bridge.js')
  const { bridgeSources } = loadPreload()
  assert.deepEqual(bridgeSources, [WEB_NOTIFICATION_BRIDGE])
})

test('untagged notifications in the same millisecond keep separate IDs and instances', () => {
  const { page, calls, instances } = loadPreload()
  new page.Notification('First')
  new page.Notification('Second')
  assert.notEqual(calls[0][1].id, calls[1][1].id)
  assert.notEqual(calls[0][1].instanceId, calls[1][1].instanceId)
  assert.equal(instances.size, 2)
})

test('closing a notification releases it once and ignores subsequent native events', () => {
  const { page, calls, ipcRenderer, instances } = loadPreload()
  const note = new page.Notification('Title', { tag: 'message' })
  const spec = calls[0][1]
  let clicks = 0
  let closes = 0
  note.onclick = () => clicks++
  note.onclose = () => closes++
  note.close()
  note.close()
  ipcRenderer.emit(Ipc.notify.action, {}, spec)
  ipcRenderer.emit(Ipc.notify.closed, {}, spec)
  assert.equal(instances.size, 0)
  assert.equal(clicks, 0)
  assert.equal(closes, 1)
  assert.deepEqual(calls[1], [Ipc.notify.close, 'web-notification', spec.id])
  assert.equal(calls.length, 2)
})

test('same-tag replacement ignores old instance events, close calls, and pending show results', async () => {
  const pending = []
  const { page, calls, ipcRenderer, instances } = loadPreload(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  )
  const old = new page.Notification('Old', { tag: 'message' })
  let oldCloses = 0
  let oldErrors = 0
  old.onclose = () => oldCloses++
  old.onerror = () => oldErrors++
  const current = new page.Notification('Current', { tag: 'message' })
  const firstSpec = calls[0][1]
  const currentSpec = calls[1][1]
  let currentClicks = 0
  let currentCloses = 0
  let currentShows = 0
  current.onclick = () => currentClicks++
  current.onclose = () => currentCloses++
  current.onshow = () => currentShows++
  assert.equal(oldCloses, 1)
  old.close()
  assert.equal(
    calls.length,
    2,
    'the replaced instance cannot close the current same-tag native notification',
  )
  ipcRenderer.emit(Ipc.notify.action, {}, firstSpec)
  ipcRenderer.emit(Ipc.notify.closed, {}, firstSpec)
  pending[0].reject(new Error('old invocation failed'))
  pending[1].resolve({ shown: true })
  await new Promise(setImmediate)
  assert.equal(oldErrors, 0)
  assert.equal(currentShows, 1)
  assert.equal(currentClicks, 0)
  assert.equal(currentCloses, 0)
  assert.equal(instances.size, 1)
  ipcRenderer.emit(Ipc.notify.action, {}, currentSpec)
  ipcRenderer.emit(Ipc.notify.closed, {}, currentSpec)
  assert.equal(currentClicks, 1)
  assert.equal(currentCloses, 1)
  assert.equal(instances.size, 0)
})

test('native close and failed show results release browser notification instances', async () => {
  for (const invoke of [
    async () => ({ shown: false }),
    async () => {
      throw new Error('IPC failed')
    },
  ]) {
    const { page, instances } = loadPreload(invoke)
    const note = new page.Notification('Failed', { tag: 'failed' })
    let errors = 0
    note.onerror = () => errors++
    await new Promise(setImmediate)
    assert.equal(errors, 1)
    assert.equal(instances.size, 0)
  }
  const { page, calls, ipcRenderer, instances } = loadPreload()
  const note = new page.Notification('Closed by system', { tag: 'closed' })
  let closes = 0
  note.onclose = () => closes++
  ipcRenderer.emit(Ipc.notify.closed, {}, calls[0][1])
  assert.equal(closes, 1)
  assert.equal(instances.size, 0)
})

test('permission queries do not emit synthetic test notifications', async () => {
  const { page, calls } = loadPreload()
  assert.equal(await page.Notification.requestPermission(), 'granted')
  assert.equal(calls.length, 0)
})

test('a replacement created by an onclose handler stays the newest notification', () => {
  const { page, calls, instances } = loadPreload()
  const first = new page.Notification('First', { tag: 'message' })
  let newest
  first.onclose = function () {
    assert.equal(this, first)
    newest = new page.Notification('Newest', { tag: 'message' })
  }
  new page.Notification('Superseded inside close handler', { tag: 'message' })
  assert.equal(calls.length, 2)
  assert.equal(calls[1][1].title, 'Newest')
  assert.equal(instances.get('message'), newest)
})

test('throwing notification handlers report errors without aborting replacement or cleanup', async () => {
  const { page, calls, ipcRenderer, instances, reportedErrors } = loadPreload()
  const first = new page.Notification('First', { tag: 'message' })
  const closeError = new Error('old close listener failed')
  first.onclose = () => {
    throw closeError
  }
  const current = new page.Notification('Current', { tag: 'message' })
  assert.equal(calls.length, 2, 'replacement must still reach the native notification service')
  assert.equal(calls[1][1].title, 'Current')
  assert.equal(instances.get('message'), current)
  assert.deepEqual(reportedErrors, [closeError])

  const showError = new Error('show listener failed')
  current.onshow = () => {
    throw showError
  }
  await new Promise(setImmediate)
  assert.equal(
    instances.get('message'),
    current,
    'a page handler failure does not end the native notification',
  )
  assert.deepEqual(reportedErrors, [closeError, showError])

  const clickError = new Error('click listener failed')
  current.onclick = () => {
    throw clickError
  }
  ipcRenderer.emit(Ipc.notify.action, {}, calls[1][1])
  assert.equal(instances.size, 0)
  assert.deepEqual(reportedErrors, [closeError, showError, clickError])
})
