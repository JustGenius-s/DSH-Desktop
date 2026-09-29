import { beforeEach, expect, test, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  installedDshVersion: vi.fn(() => '0.1.0'),
  latestDshAcrossChannels: vi.fn<() => Promise<string | undefined>>(),
  updateDsh: vi.fn<(version: string) => Promise<void>>(),
}))
const restart = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
const feedback = vi.hoisted(() => ({
  started: vi.fn(),
  done: vi.fn(),
  failed: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.2.0', getLocale: () => 'en' },
  ipcMain: {},
  shell: {},
}))
vi.mock('../../../../src/main/runtime/installation', () => runtime)
const appUpdate = vi.hoisted(() => ({ check: vi.fn<() => Promise<unknown>>() }))

vi.mock('../../../../src/main/updates/app-update', () => ({
  APP_RELEASES_URL: 'https://example.test/releases',
  checkForAppUpdate: appUpdate.check,
}))
vi.mock('../../../../src/main/updates/feedback', () => ({
  notifyDshUpdateStarted: feedback.started,
  notifyDshUpdateDone: feedback.done,
  reportDshUpdateFailure: feedback.failed,
}))
// 语言走真实实现会读到本机 DSH home 里的偏好，这里固定成英文。
vi.mock('../../../../src/main/locale', () => ({ currentShellLang: () => 'en' }))
vi.mock('../../../../src/main/restart', () => ({
  offerRestartDshWeb: restart,
  onDshWebRestarted: vi.fn(),
  restartDshWeb: vi.fn(),
  setupRestartPromptIpc: vi.fn(),
}))

import { updateDshRuntime } from '../../../../src/main/updates/bridge'
import {
  clearDshPendingRestart,
  setUpdateResult,
  updateSummary,
} from '../../../../src/main/updates/state'

beforeEach(() => {
  vi.resetAllMocks()
  runtime.installedDshVersion.mockReturnValue('0.1.0')
  runtime.latestDshAcrossChannels.mockResolvedValue('0.2.0')
  // 装完之后磁盘上的版本就是新版，后续的更新核对要看到这一点。
  runtime.updateDsh.mockImplementation(async (version: string) => {
    runtime.installedDshVersion.mockReturnValue(version)
  })
  restart.mockResolvedValue(false)
  appUpdate.check.mockResolvedValue(undefined)
  clearDshPendingRestart()
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

test('keeps the update visible as pending restart until the service restarts', async () => {
  // 用户选「稍后」：新运行时只是装到了磁盘上，跑着的还是旧的。此时不能再把
  // 它当成「有更新」——否则菜单会催着用户把已经装好的版本再装一遍。
  await updateDshRuntime('0.2.0')
  const pending = updateSummary()
  expect(pending.dshUpdate).toBeNull()
  expect(pending.dshPendingRestart).toBe('0.2.0')

  restart.mockResolvedValueOnce(true)
  await updateDshRuntime('0.2.0')
  const applied = updateSummary()
  expect(applied.dshUpdate).toBeNull()
  expect(applied.dshPendingRestart).toBeNull()
})

test('reports the update from start to finish', async () => {
  await updateDshRuntime('0.2.0')
  // 开始和结束各一次反馈，用户点完菜单不至于毫无动静。
  expect(feedback.started).toHaveBeenCalledWith('en', '0.2.0')
  expect(feedback.done).toHaveBeenCalledWith('en', '0.2.0', true)
  expect(feedback.failed).not.toHaveBeenCalled()
})

test('reports installation failure before rethrowing', async () => {
  const failure = new Error('install failed')
  runtime.updateDsh.mockRejectedValueOnce(failure)
  await expect(updateDshRuntime('0.2.0')).rejects.toThrow('install failed')
  // 失败不能只落在日志里：菜单点击是 fire-and-forget，用户看不到原因。
  expect(feedback.failed).toHaveBeenCalledWith('en', failure)
  expect(updateSummary().dshUpdating).toBe(false)
})
