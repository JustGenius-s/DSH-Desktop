import { beforeEach, expect, test, vi } from 'vitest'

const sessions = vi.hoisted(() => {
  const create = () => ({
    cookies: { get: vi.fn(), remove: vi.fn() },
    clearStorageData: vi.fn(),
  })
  return { current: create(), legacy: create(), fromPartition: vi.fn() }
})

vi.mock('electron', () => ({
  session: { defaultSession: sessions.current, fromPartition: sessions.fromPartition },
}))

import { clearStaleDshAuthCookies, hardenChromiumStorage } from '../src/main/platform/session'

beforeEach(() => {
  vi.resetAllMocks()
  sessions.fromPartition.mockReturnValue(sessions.legacy)
  for (const session of [sessions.current, sessions.legacy]) {
    session.clearStorageData.mockResolvedValue(undefined)
    session.cookies.remove.mockResolvedValue(undefined)
    session.cookies.get.mockResolvedValue([
      { name: 'dsh-auth-old', domain: '.127.0.0.1', path: '/secure', secure: true },
      { name: 'preference', domain: '127.0.0.1', path: '/' },
      { name: 'dsh-auth-remote', domain: 'example.test', path: '/' },
    ])
  }
})

test('reload cleanup removes only loopback DSH auth cookies from both session generations', async () => {
  await clearStaleDshAuthCookies()
  for (const session of [sessions.current, sessions.legacy]) {
    expect(session.cookies.remove.mock.calls).toEqual([
      ['https://127.0.0.1/secure', 'dsh-auth-old'],
    ])
  }
})

test('initial storage hardening reuses cookie cleanup without creating the legacy partition', async () => {
  await hardenChromiumStorage()
  expect(sessions.current.clearStorageData.mock.calls).toEqual([[{ storages: ['serviceworkers'] }]])
  expect(sessions.current.cookies.remove.mock.calls).toEqual([
    ['https://127.0.0.1/secure', 'dsh-auth-old'],
  ])
  expect(sessions.fromPartition).not.toHaveBeenCalled()
})
