import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('../src/main/runtime/environment', () => ({
  bundledNodeBin: () => '/unused/node',
  withBundledBinPath: (env: NodeJS.ProcessEnv) => env,
}))

import { onceExit } from '../src/main/runtime/host'

function childProcess(signalCode: NodeJS.Signals | null = null): ChildProcess {
  return Object.assign(new EventEmitter(), { exitCode: null, signalCode }) as ChildProcess
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('exit waits remove their listeners when a timeout expires', async () => {
  const child = childProcess()
  const waiting = onceExit(child, 50)
  await vi.advanceTimersByTimeAsync(50)
  await waiting
  expect(child.listenerCount('exit')).toBe(0)
})

test('an already signaled child does not wait for another exit event', async () => {
  const child = childProcess('SIGTERM')
  let finished = false
  const waiting = onceExit(child, 50).then(() => {
    finished = true
  })
  await Promise.resolve()
  try {
    expect(finished).toBe(true)
  } finally {
    await vi.runAllTimersAsync()
    await waiting
  }
})

test('an exit event cancels the pending timeout', async () => {
  const child = childProcess()
  const waiting = onceExit(child, 50)
  child.emit('exit', 0, null)
  await waiting
  expect(child.listenerCount('exit')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
