import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const sessions = vi.hoisted(() => {
  const create = () => ({
    cookies: { get: vi.fn(), remove: vi.fn() },
    clearStorageData: vi.fn(),
  })
  return { current: create() }
})

vi.mock('electron', () => ({
  session: { defaultSession: sessions.current },
}))

import {
  clearStaleDshAuthCookies,
  hardenChromiumStorage,
} from '../../../../src/main/platform/session'

beforeEach(() => {
  vi.resetAllMocks()
  sessions.current.clearStorageData.mockResolvedValue(undefined)
  sessions.current.cookies.remove.mockResolvedValue(undefined)
  sessions.current.cookies.get.mockResolvedValue([
    { name: 'dsh-auth-old', domain: '.127.0.0.1', path: '/secure', secure: true },
    { name: 'dsh-auth-older', domain: '127.0.0.1', path: '/' },
    { name: 'preference', domain: '127.0.0.1', path: '/' },
    { name: 'dsh-auth-remote', domain: 'example.test', path: '/' },
  ])
})

afterEach(() => {
  vi.useRealTimers()
})

test('reload cleanup removes only loopback DSH auth cookies', async () => {
  await clearStaleDshAuthCookies()
  expect(sessions.current.cookies.remove.mock.calls).toEqual([
    ['https://127.0.0.1/secure', 'dsh-auth-old'],
    ['http://127.0.0.1/', 'dsh-auth-older'],
  ])
})

test('cookie removal failures do not reject cleanup', async () => {
  sessions.current.cookies.remove.mockRejectedValue(new Error('cookie database is locked'))
  await expect(clearStaleDshAuthCookies()).resolves.toBeUndefined()
})

test('a service worker cleanup failure does not skip cookie cleanup or reject startup', async () => {
  sessions.current.clearStorageData.mockRejectedValue(
    new Error('service worker database is locked'),
  )
  await expect(hardenChromiumStorage()).resolves.toBeUndefined()
  expect(sessions.current.cookies.remove).toHaveBeenCalledTimes(2)
})

test('hung startup cleanup is bounded and a late cookie query cannot delete new session cookies', async () => {
  vi.useFakeTimers()
  let resolveCookies!: (cookies: { name: string; domain: string; path: string }[]) => void
  sessions.current.cookies.get.mockReturnValue(
    new Promise((resolve) => {
      resolveCookies = resolve
    }),
  )
  sessions.current.clearStorageData.mockReturnValue(new Promise(() => {}))
  const settled = vi.fn()
  const cleanup = hardenChromiumStorage().then(settled)
  await vi.advanceTimersByTimeAsync(1_999)
  expect(settled).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await cleanup
  expect(settled).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  resolveCookies([{ name: 'dsh-auth-new', domain: '127.0.0.1', path: '/' }])
  await Promise.resolve()
  expect(sessions.current.cookies.remove).not.toHaveBeenCalled()
})

test('cleanup consumes failures that arrive after its timeout', async () => {
  vi.useFakeTimers()
  let rejectCookies!: (error: Error) => void
  sessions.current.cookies.get.mockReturnValue(
    new Promise((_, reject) => {
      rejectCookies = reject
    }),
  )
  const cleanup = clearStaleDshAuthCookies()
  await vi.advanceTimersByTimeAsync(2_000)
  await cleanup
  rejectCookies(new Error('late cookie database failure'))
  await vi.runAllTimersAsync()
  expect(sessions.current.cookies.remove).not.toHaveBeenCalled()
})
