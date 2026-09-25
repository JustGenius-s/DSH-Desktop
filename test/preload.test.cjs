const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { Ipc } = require('../dist/shared/ipc.js')

function loadPreload() {
  const page = {}
  const calls = []
  const ipcRenderer = new EventEmitter()
  ipcRenderer.invoke = async (...args) => {
    calls.push(args)
    return { shown: true }
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
      executeJavaScript: async (source) => runInNewContext(source, { window: page, Event }),
    },
  }
  runInNewContext(readFileSync(join(__dirname, '../dist/preload.js'), 'utf8'), {
    exports: {},
    require: (name) => {
      assert.equal(name, 'electron', 'sandboxed preload cannot require local modules')
      return electron
    },
  })
  return { page, api: page.dshDesktop, calls, ipcRenderer }
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
  ipcRenderer.emit(Ipc.notify.action, {}, { contributor: 'web-notification', id: spec.id })
  assert.equal(clicks, 1)
  note.close()
  assert.deepEqual(calls[1], [Ipc.notify.close, 'web-notification', spec.id])
})
