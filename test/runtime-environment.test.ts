import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ exists: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/desktop test' } }))
vi.mock('node:fs', () => ({ existsSync: mocks.exists }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }))

import { runPnpm, withElectronNodeEnvironment } from '../src/main/runtime/environment'

const originalPlatform = process.platform
const originalExecutable = process.execPath
const bundledBin = join('/desktop test', 'runtime', 'bin')
const nodeGypBin = join('/desktop test', 'runtime', 'pnpm', 'dist', 'node-gyp-bin')

beforeEach(() => {
  vi.resetAllMocks()
  mocks.exists.mockImplementation((path: string) =>
    [join(bundledBin, process.platform === 'win32' ? 'node.exe' : 'node'), nodeGypBin].includes(
      path,
    ),
  )
  mocks.spawnSync.mockReturnValue({ status: 1, stdout: '' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  Object.defineProperty(process, 'execPath', { value: originalExecutable })
  vi.restoreAllMocks()
})

test('Windows preserves Path and merges duplicate PATH keys without changing the input', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const env = { Path: 'C:\\Windows;C:\\Git\\cmd', PATH: 'C:\\Git\\cmd;C:\\Tools', KEEP: 'yes' }
  expect(withElectronNodeEnvironment(env)).toMatchObject({
    PATH: [bundledBin, nodeGypBin, 'C:\\Windows', 'C:\\Git\\cmd', 'C:\\Tools'].join(';'),
    KEEP: 'yes',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NODE_EXEC_PATH: process.execPath,
  })
  expect(env.Path).toBe('C:\\Windows;C:\\Git\\cmd')
})

test('Git discovery uses the supplied Windows environment', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const programFiles = '/custom programs'
  const gitBin = join(programFiles, 'Git', 'cmd')
  mocks.exists.mockImplementation((path: string) =>
    [join(bundledBin, 'node.exe'), join(gitBin, 'git.exe')].includes(path),
  )
  expect(withElectronNodeEnvironment({ ProgramFiles: programFiles, Path: 'tools' }).PATH).toBe(
    `${bundledBin};${gitBin};tools`,
  )
})

test('missing launcher fails before starting pnpm instead of using system Node', async () => {
  mocks.exists.mockReturnValue(false)
  await expect(runPnpm(['add', 'example-package'])).rejects.toThrow('pnpm collect')
  expect(mocks.spawn).not.toHaveBeenCalled()
})

test('Unix keeps case-sensitive environment keys and deduplicates individual PATH entries', () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  expect(
    withElectronNodeEnvironment({ PATH: `${bundledBin}:/usr/bin:/usr/bin`, Path: 'unrelated' }),
  ).toMatchObject({
    PATH: [bundledBin, nodeGypBin, '/usr/bin'].join(':'),
    Path: 'unrelated',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NODE_EXEC_PATH: process.execPath,
  })
  expect(mocks.spawnSync).not.toHaveBeenCalled()
  expect(mocks.exists.mock.calls.some(([path]) => String(path).endsWith('git.exe'))).toBe(false)
})

test('a relocated or upgraded Electron overrides an inherited launcher path only in the child', () => {
  const env = { ELECTRON_NODE_EXEC_PATH: '/old/Electron', ELECTRON_RUN_AS_NODE: '0' }
  Object.defineProperty(process, 'execPath', { value: '/new app/DSH-Desktop' })
  expect(withElectronNodeEnvironment(env)).toMatchObject({
    ELECTRON_NODE_EXEC_PATH: '/new app/DSH-Desktop',
    ELECTRON_RUN_AS_NODE: '1',
  })
  expect(env).toEqual({ ELECTRON_NODE_EXEC_PATH: '/old/Electron', ELECTRON_RUN_AS_NODE: '0' })
})

test('native plugin builds target the running Electron instead of a previous Node target', () => {
  const original = process.versions.electron
  Object.defineProperty(process.versions, 'electron', { value: '99.1.2', configurable: true })
  try {
    const env = withElectronNodeEnvironment({ npm_config_target: 'old-version' })
    expect(env).toMatchObject({
      npm_config_runtime: 'electron',
      npm_config_target: '99.1.2',
      npm_config_arch: process.arch,
      npm_config_disturl: 'https://electronjs.org/headers',
      npm_package_config_node_gyp_target: '99.1.2',
      npm_package_config_node_gyp_arch: process.arch,
      npm_package_config_node_gyp_dist_url: 'https://electronjs.org/headers',
    })
  } finally {
    if (original === undefined) Reflect.deleteProperty(process.versions, 'electron')
    else
      Object.defineProperty(process.versions, 'electron', { value: original, configurable: true })
  }
})

test('Windows clears inherited case variants of native build targets and Node header paths', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const inherited = {
    NPM_CONFIG_TARGET: 'old-version',
    NPM_CONFIG_NODEDIR: 'C:\\old-node',
    NPM_PACKAGE_CONFIG_NODE_GYP_TARGET: 'other-version',
    NPM_PACKAGE_CONFIG_NODE_GYP_NODEDIR: 'C:\\other-node',
  }
  const env = withElectronNodeEnvironment(inherited)
  for (const key of Object.keys(inherited)) expect(env).not.toHaveProperty(key)
  expect(env.npm_config_target).toBe(process.versions.electron)
  expect(env.npm_package_config_node_gyp_target).toBe(process.versions.electron)
  expect(inherited.NPM_CONFIG_TARGET).toBe('old-version')
  expect(inherited.NPM_CONFIG_NODEDIR).toBe('C:\\old-node')
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
  expect(mocks.spawn).toHaveBeenCalledWith(
    process.execPath,
    expect.arrayContaining(['add', 'example-package']),
    expect.objectContaining({
      env: expect.objectContaining({
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_NODE_EXEC_PATH: process.execPath,
      }),
    }),
  )
  child.emit('exit', 1, null)
  child.stderr.write('final diagnostic')
  child.emit('close', 1, null)
  await result
})
