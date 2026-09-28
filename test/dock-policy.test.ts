import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const dock = { isVisible: vi.fn(), setIcon: vi.fn(), show: vi.fn() }
  return {
    app: {
      dock,
      isPackaged: false,
      getAppPath: () => '/desktop test',
      setActivationPolicy: vi.fn(),
    },
    image: { isEmpty: () => false },
    createFromPath: vi.fn(),
  }
})

vi.mock('electron', () => ({
  app: mocks.app,
  nativeImage: { createFromPath: mocks.createFromPath },
}))

const originalPlatform = process.platform
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
let policy: typeof import('../src/main/platform/dock-policy')

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  Object.defineProperty(process, 'resourcesPath', { value: '/resources test', configurable: true })
  mocks.app.isPackaged = false
  mocks.app.dock.isVisible.mockReturnValue(true)
  mocks.app.dock.show.mockResolvedValue(undefined)
  mocks.createFromPath.mockReturnValue(mocks.image)
  policy = await import('../src/main/platform/dock-policy')
})

afterEach(() => {
  policy.stopDockPolicyGuard()
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  if (originalResourcesPath) {
    Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
  } else {
    Reflect.deleteProperty(process, 'resourcesPath')
  }
})

test.each([false, true])('loads the canonical PNG once (packaged: %s)', async (isPackaged) => {
  mocks.app.isPackaged = isPackaged
  policy.startDockPolicyGuard()
  await vi.advanceTimersByTimeAsync(6000)

  expect(mocks.createFromPath.mock.calls).toEqual([
    [
      isPackaged
        ? join('/resources test', 'dock-icon.png')
        : join('/desktop test', 'build', 'icon-mac.png'),
    ],
  ])
  expect(mocks.app.dock.show).toHaveBeenCalled()
  const iconCallsAfterStartup = mocks.app.dock.setIcon.mock.calls.length
  const showCallsAfterStartup = mocks.app.dock.show.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.app.dock.setIcon).toHaveBeenCalledTimes(iconCallsAfterStartup)
  expect(mocks.app.dock.show).toHaveBeenCalledTimes(showCallsAfterStartup)

  policy.enforceRegularDockPolicy()
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.createFromPath).toHaveBeenCalledTimes(1)
  expect(mocks.app.dock.setIcon.mock.calls.every(([image]) => image === mocks.image)).toBe(true)
})

test('hidden Dock recovery waits for an in-flight show before retrying', async () => {
  let finishShow!: () => void
  const pendingShow = new Promise<void>((resolve) => {
    finishShow = resolve
  })
  mocks.app.dock.isVisible.mockReturnValue(false)
  mocks.app.dock.show.mockReturnValueOnce(pendingShow)
  policy.startDockPolicyGuard()
  policy.enforceRegularDockPolicy()
  await vi.advanceTimersByTimeAsync(6000)
  expect(mocks.app.dock.show).toHaveBeenCalledTimes(1)

  finishShow()
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.app.dock.setIcon).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(500)
  expect(mocks.app.dock.show).toHaveBeenCalledTimes(2)
  expect(mocks.createFromPath).toHaveBeenCalledTimes(1)
})

test('a failed Dock show releases the recovery guard', async () => {
  mocks.app.dock.isVisible.mockReturnValue(false)
  mocks.app.dock.show.mockRejectedValueOnce(new Error('Dock not ready'))
  policy.startDockPolicyGuard()
  await vi.advanceTimersByTimeAsync(500)
  expect(mocks.app.dock.show).toHaveBeenCalledTimes(2)
  expect(mocks.app.setActivationPolicy).toHaveBeenLastCalledWith('regular')
  expect(mocks.createFromPath).toHaveBeenCalledTimes(1)
})

test('an empty PNG is retried without changing resource formats or caching failure', async () => {
  mocks.createFromPath.mockReturnValueOnce({ isEmpty: () => true })
  policy.enforceRegularDockPolicy()
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.createFromPath.mock.calls).toEqual([
    [join('/desktop test', 'build', 'icon-mac.png')],
    [join('/desktop test', 'build', 'icon-mac.png')],
  ])
  expect(mocks.app.dock.setIcon).toHaveBeenCalledTimes(1)

  policy.enforceRegularDockPolicy()
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.createFromPath).toHaveBeenCalledTimes(2)
})

test('stopping cancels both the periodic guard and startup restamps', async () => {
  policy.startDockPolicyGuard()
  await vi.advanceTimersByTimeAsync(0)
  policy.stopDockPolicyGuard()
  expect(vi.getTimerCount()).toBe(0)
  mocks.app.dock.isVisible.mockReturnValue(false)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(mocks.app.dock.show).toHaveBeenCalledTimes(1)
})

test('non-macOS platforms do not load or schedule Dock operations', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  policy.startDockPolicyGuard()
  policy.enforceRegularDockPolicy()
  expect(mocks.createFromPath).not.toHaveBeenCalled()
  expect(mocks.app.dock.show).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
