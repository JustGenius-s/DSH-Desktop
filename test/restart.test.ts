import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Ipc } from '../src/shared/ipc'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  send: vi.fn(),
  restart: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getLocale: () => 'en' },
  ipcMain: {
    on: (channel: string, handler: (...args: unknown[]) => void) =>
      mocks.handlers.set(channel, handler),
  },
}))
vi.mock('../src/main/locale', () => ({ currentShellLang: () => 'en' }))
vi.mock('../src/main/windows/registry', () => ({
  focusMainWindow: vi.fn(),
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: mocks.send },
  }),
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.restart.mockResolvedValue(undefined)
  vi.useFakeTimers()
})

afterEach(() => vi.useRealTimers())

async function loadRestart() {
  const restart = await import('../src/main/restart')
  restart.registerDshWebHost({ isReady: () => true, restart: mocks.restart })
  return restart
}

function respond(choice: 'later' | 'restart'): void {
  const prompt = mocks.send.mock.lastCall?.[1] as { id: string }
  mocks.handlers.get(Ipc.updates.promptAck)?.({}, prompt.id)
  mocks.handlers.get(Ipc.updates.promptResponse)?.({}, prompt.id, choice)
}

test('answering a restart prompt releases both retry and response timers', async () => {
  const { offerRestartDshWeb } = await loadRestart()
  const offered = offerRestartDshWeb('plugin')
  await Promise.resolve()
  respond('later')
  await expect(offered).resolves.toBe(false)
  expect(mocks.restart).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

test('an unacknowledged prompt stops retrying and releases the response timeout', async () => {
  const { offerRestartDshWeb } = await loadRestart()
  const offered = offerRestartDshWeb('dsh-runtime')
  await vi.advanceTimersByTimeAsync(4_000)
  await expect(offered).resolves.toBe(false)
  expect(mocks.send).toHaveBeenCalledTimes(8)
  expect(vi.getTimerCount()).toBe(0)
})

test('queued prompts are shown in order and only an accepted prompt restarts the service', async () => {
  const { offerRestartDshWeb } = await loadRestart()
  const first = offerRestartDshWeb('plugin')
  const second = offerRestartDshWeb('dsh-runtime')
  await Promise.resolve()
  expect(mocks.send).toHaveBeenCalledTimes(1)
  respond('later')
  await first
  await Promise.resolve()
  expect(mocks.send).toHaveBeenCalledTimes(2)
  respond('restart')
  await expect(second).resolves.toBe(true)
  expect(mocks.restart).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
