import { expect, test, vi } from 'vitest'

type Handler = (...args: unknown[]) => unknown
const ipc = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  handle: vi.fn<(channel: string, handler: Handler) => void>(),
  on: vi.fn(),
  // Electron stores invoke handlers separately from EventEmitter listeners.
  listenerCount: () => 0,
}))

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, ipcMain: ipc }))
vi.mock('../src/main/plugins/quarantine', () => ({
  extractFailedPlugins: () => ['example-plugin'],
  getProfileBundles: () => ['example-plugin'],
  listPlugins: () => [{ name: 'example-plugin', enabled: true, core: false, desktopOwned: false }],
  clearQuarantine: vi.fn(),
  setBundleEnabled: vi.fn(),
}))

import { recordBootFailure, setupPluginRecovery } from '../src/main/plugins/recovery'
import { Ipc } from '../src/shared/ipc'

test('recovery IPC can be initialized twice without duplicating handlers or losing failure state', () => {
  ipc.handle.mockImplementation((channel, handler) => {
    if (ipc.handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`)
    ipc.handlers.set(channel, handler)
  })

  setupPluginRecovery()
  recordBootFailure('Error: example-plugin failed')
  expect(() => setupPluginRecovery()).not.toThrow()
  expect(ipc.handlers.get(Ipc.plugins.list)?.()).toEqual({
    plugins: [
      { name: 'example-plugin', enabled: true, core: false, desktopOwned: false, suspected: true },
    ],
    failure: { tail: 'Error: example-plugin failed', suspected: ['example-plugin'] },
  })
  expect(ipc.on).toHaveBeenCalledTimes(1)
})
