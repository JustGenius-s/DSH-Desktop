import { beforeEach, expect, test, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  installedDshVersion: vi.fn<() => string | undefined>(() => '0.1.0'),
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.2.0', getLocale: () => 'en', name: 'DSH-Desktop' },
  dialog: {},
  ipcMain: {},
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
  nativeImage: { createFromPath: vi.fn(), createEmpty: vi.fn() },
  shell: {},
  session: {},
  Tray: class {},
}))
vi.mock('../../../../src/main/runtime/installation', () => runtime)
vi.mock('../../../../src/main/locale', () => ({ currentShellLang: () => 'en' }))
vi.mock('../../../../src/main/restart', () => ({
  offerRestartDshWeb: vi.fn(),
  onDshWebRestarted: vi.fn(),
  restartDshWeb: vi.fn(),
  setupRestartPromptIpc: vi.fn(),
}))
vi.mock('../../../../src/main/updates/bridge', () => ({
  applyPendingDshRuntime: vi.fn(),
  checkDesktopUpdates: vi.fn(),
  setMenuRefreshHook: vi.fn(),
  updateDshRuntime: vi.fn(),
}))
vi.mock('../../../../src/main/windows/registry', () => ({
  focusMainWindow: vi.fn(),
  webContentsById: vi.fn(),
}))

import { menuStrings } from '../../../../src/main/menus/i18n'
import { dshUpdateItem } from '../../../../src/main/menus/seats'
import {
  clearDshPendingRestart,
  setDshPendingRestart,
  setDshUpdating,
  setUpdateResult,
  updateSummary,
} from '../../../../src/main/updates/state'

const t = menuStrings('en')

beforeEach(() => {
  runtime.installedDshVersion.mockReturnValue('0.1.0')
  setDshUpdating(false)
  clearDshPendingRestart()
  setUpdateResult({ app: null, dsh: null })
})

test('shows the installed runtime version when there is nothing to update', () => {
  // 光一个禁用的「更新」看不出装的是哪个版本，也看不出到底有没有更新。
  const item = dshUpdateItem(t, updateSummary())
  expect(item.label).toBe('DSH runtime 0.1.0')
  expect(item.enabled).toBe(false)
})

test('shows that the runtime is missing when it is not installed', () => {
  runtime.installedDshVersion.mockReturnValue(undefined)
  const item = dshUpdateItem(t, updateSummary())
  expect(item.label).toBe('DSH runtime not installed')
  expect(item.enabled).toBe(false)
})

test('offers the target version when an update is available', () => {
  setUpdateResult({ app: null, dsh: '0.2.0' })
  const item = dshUpdateItem(t, updateSummary())
  expect(item.label).toBe('Update to DSH runtime 0.2.0')
  expect(item.enabled).toBeUndefined()
})

test('shows progress while pnpm is installing', () => {
  setDshUpdating(true)
  const item = dshUpdateItem(t, updateSummary())
  expect(item.label).toBe('Updating DSH runtime…')
  expect(item.enabled).toBe(false)
})

test('offers a restart instead of a reinstall while the install is pending', () => {
  setDshPendingRestart('0.2.0')
  const item = dshUpdateItem(t, updateSummary())
  expect(item.label).toBe('Restart service to apply 0.2.0')
  expect(item.enabled).toBeUndefined()
})
