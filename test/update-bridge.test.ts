import { beforeEach, expect, test, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  installedDshVersion: vi.fn(() => '0.1.0'),
  latestDshAcrossChannels: vi.fn<() => Promise<string | undefined>>(),
  updateDsh: vi.fn<(version: string) => Promise<void>>(),
}))
const restart = vi.hoisted(() => vi.fn<() => Promise<boolean>>())

vi.mock('electron', () => ({ app: { getVersion: () => '0.2.0' }, ipcMain: {}, shell: {} }))
vi.mock('../src/main/runtime/installation', () => runtime)
vi.mock('../src/main/updates/app-update', () => ({
  APP_RELEASES_URL: 'https://example.test/releases',
  checkForAppUpdate: vi.fn(),
}))
vi.mock('../src/main/restart', () => ({
  offerRestartDshWeb: restart,
  restartDshWeb: vi.fn(),
  setupRestartPromptIpc: vi.fn(),
}))

import { updateDshRuntime } from '../src/main/updates/bridge'
import { setUpdateResult, updateSummary } from '../src/main/updates/state'

beforeEach(() => {
  vi.resetAllMocks()
  runtime.latestDshAcrossChannels.mockResolvedValue('0.2.0')
  runtime.updateDsh.mockResolvedValue(undefined)
  restart.mockResolvedValue(false)
  setUpdateResult({ app: null, dsh: '0.2.0' })
})

test('blocks a second update while the first is still resolving its target version', async () => {
  let finishLookup!: (version: string) => void
  runtime.latestDshAcrossChannels.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLookup = resolve
      }),
  )
  const first = updateDshRuntime()
  const second = updateDshRuntime('0.3.0').catch((error: unknown) => error)
  finishLookup('0.2.0')
  await first

  expect(await second).toEqual(new Error('已有更新在进行中'))
  expect(runtime.updateDsh.mock.calls).toEqual([['0.2.0']])
})

test('releases the update guard after version lookup or installation fails', async () => {
  runtime.latestDshAcrossChannels.mockResolvedValueOnce(undefined)
  await expect(updateDshRuntime()).rejects.toThrow('当前没有可更新的 DSH 版本')
  runtime.updateDsh.mockRejectedValueOnce(new Error('install failed'))
  await expect(updateDshRuntime('0.2.0')).rejects.toThrow('install failed')
  await expect(updateDshRuntime('0.2.0')).resolves.toBeUndefined()
})

test('clears the runtime update only after the new runtime is active', async () => {
  await updateDshRuntime('0.2.0')
  expect(updateSummary().dshUpdate).toBe('0.2.0')
  restart.mockResolvedValueOnce(true)
  await updateDshRuntime('0.2.0')
  expect(updateSummary().dshUpdate).toBeNull()
})
