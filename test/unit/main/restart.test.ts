import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Ipc } from '../../../src/shared/ipc'

const mocks = vi.hoisted(() => {
  const frame = {}
  const send = vi.fn()
  const contents = {
    id: 7,
    isDestroyed: () => false,
    mainFrame: frame,
    send,
    on: () => undefined,
    off: () => undefined,
    once: () => undefined,
  }
  return {
    handlers: new Map<string, (...args: unknown[]) => void>(),
    send,
    frame,
    contents,
    restart: vi.fn(),
  }
})
vi.mock('electron', () => ({
  app: { getLocale: () => 'en' },
  ipcMain: {
    on: (channel: string, handler: (...args: unknown[]) => void) =>
      mocks.handlers.set(channel, handler),
  },
}))
vi.mock('../../../src/main/locale', () => ({ currentShellLang: () => 'en' }))
vi.mock('../../../src/main/windows/registry', () => ({
  focusMainWindow: vi.fn(),
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: mocks.contents,
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
  const restart = await import('../../../src/main/restart')
  restart.registerDshWebHost({ isReady: () => true, restart: mocks.restart })
  return restart
}

function respond(choice: 'later' | 'restart'): void {
  const prompt = mocks.send.mock.lastCall?.[1] as { id: string }
  const event = { sender: mocks.contents, senderFrame: mocks.frame }
  mocks.handlers.get(Ipc.updates.promptAck)?.(event, prompt.id)
  mocks.handlers.get(Ipc.updates.promptResponse)?.(event, prompt.id, choice)
}

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
