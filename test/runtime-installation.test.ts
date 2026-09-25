import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const registry = vi.hoisted(() => vi.fn())
const runPnpm = vi.hoisted(() => vi.fn<(args: readonly string[]) => Promise<void>>())
vi.mock('electron', () => ({ session: { defaultSession: { fetch: registry } } }))
vi.mock('../src/main/runtime/environment', () => ({ runPnpm }))

import { ensureDshInstalled, latestDshAcrossChannels } from '../src/main/runtime/installation'

let home: string
let bin: string

beforeEach(() => {
  vi.resetAllMocks()
  home = mkdtempSync(join(tmpdir(), 'dsh-installation-test-'))
  vi.stubEnv('DSH_HOME', home)
  bin = join(home, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')
  registry.mockResolvedValue({
    ok: true,
    json: async () => ({
      'dist-tags': { latest: '0.1.0', next: '0.2.0-rc.7', alpha: '0.2.0-rc.6', invalid: 42 },
    }),
  })
  runPnpm.mockImplementation(async () => {
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, '// installed by the test')
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

test('first install uses latest while update discovery compares all valid channels', async () => {
  await expect(ensureDshInstalled()).resolves.toBe(bin)
  expect(runPnpm.mock.calls[0][0]).toContain('@deepseek-ai/dsh@0.1.0')
  await expect(latestDshAcrossChannels()).resolves.toBe('0.2.0-rc.7')
})

test('an existing runtime skips registry requests and package installation', async () => {
  mkdirSync(dirname(bin), { recursive: true })
  writeFileSync(bin, '// existing runtime')
  await expect(ensureDshInstalled()).resolves.toBe(bin)
  expect(registry).not.toHaveBeenCalled()
  expect(runPnpm).not.toHaveBeenCalled()
})

test('registry failures do not trigger an installation with an unknown version', async () => {
  registry.mockRejectedValue(new Error('offline'))
  await expect(latestDshAcrossChannels()).resolves.toBeUndefined()
  await expect(ensureDshInstalled()).rejects.toThrow('无法从 npm 获取')
  expect(runPnpm).not.toHaveBeenCalled()
})
