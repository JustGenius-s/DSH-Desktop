import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ exists: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/desktop test' } }))
vi.mock('node:fs', () => ({ existsSync: mocks.exists }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }))

import { runPnpm, withBundledBinPath } from '../src/main/runtime/environment'

const originalPlatform = process.platform
const bundledBin = join('/desktop test', 'runtime', 'bin')
const nodeGypBin = join('/desktop test', 'runtime', 'pnpm', 'dist', 'node-gyp-bin')

beforeEach(() => {
  vi.resetAllMocks()
  mocks.exists.mockImplementation((path: string) => [bundledBin, nodeGypBin].includes(path))
  mocks.spawnSync.mockReturnValue({ status: 1, stdout: '' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.restoreAllMocks()
})

test('Windows preserves Path and merges duplicate PATH keys without changing the input', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const env = { Path: 'C:\\Windows;C:\\Git\\cmd', PATH: 'C:\\Git\\cmd;C:\\Tools', KEEP: 'yes' }
  expect(withBundledBinPath(env)).toEqual({
    PATH: [bundledBin, nodeGypBin, 'C:\\Windows', 'C:\\Git\\cmd', 'C:\\Tools'].join(';'),
    KEEP: 'yes',
  })
  expect(env.Path).toBe('C:\\Windows;C:\\Git\\cmd')
})

test('Git discovery uses the supplied Windows environment', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const programFiles = '/custom programs'
  const gitBin = join(programFiles, 'Git', 'cmd')
  mocks.exists.mockImplementation((path: string) => path === join(gitBin, 'git.exe'))
  expect(withBundledBinPath({ ProgramFiles: programFiles, Path: 'tools' }).PATH).toBe(
    `${gitBin};tools`,
  )
})

test('Unix keeps case-sensitive environment keys and deduplicates individual PATH entries', () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  expect(
    withBundledBinPath({ PATH: `${bundledBin}:/usr/bin:/usr/bin`, Path: 'unrelated' }),
  ).toEqual({
    PATH: [bundledBin, nodeGypBin, '/usr/bin'].join(':'),
    Path: 'unrelated',
  })
  expect(mocks.spawnSync).not.toHaveBeenCalled()
  expect(mocks.exists.mock.calls.some(([path]) => String(path).endsWith('git.exe'))).toBe(false)
})

test('pnpm waits for output streams to close before reporting its final error', async () => {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  mocks.spawn.mockReturnValue(child)
  const result = expect(runPnpm(['add', 'example-package'])).rejects.toThrow('final diagnostic')
  child.emit('exit', 1, null)
  child.stderr.write('final diagnostic')
  child.emit('close', 1, null)
  await result
})
