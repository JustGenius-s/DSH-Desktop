import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, onTestFinished, test } from 'vitest'

const pluginName = '@just-genius/dsh-desktop-update'

interface ProfilePackage {
  name: string
  dependencies: Record<string, string>
  dsh: { profile: { bundles: string[] } }
}

/** 断言脚本成功退出；失败时把 stderr 一起抛出来，否则退出码本身没法定位。 */
function expectSuccess(result: SpawnSyncReturns<string>): void {
  if (result.status !== 0) {
    throw new Error(`installer exited ${String(result.status)}: ${
      result.stderr || result.error?.message || '(no output)'}`)
  }
}

interface Fixture {
  /** 以「安装」子命令跑一次脚本。 */
  run: () => SpawnSyncReturns<string>
  /** 读回被脚本改写的 web profile。 */
  profile: () => ProfilePackage
}

/**
 * 搭一个临时 ~/.dsh 布局：脚本本体 + 内置运行时桩 + 已安装的插件 + profile。
 * 临时目录在用例结束时清理，并顺带守住「只删自己建的目录」这条底线。
 */
function fixture(version: string, pnpmEntry: string | undefined): Fixture {
  const tempRoot = resolve(tmpdir())
  const root = mkdtempSync(join(tempRoot, 'dsh-desktop-installer-'))
  onTestFinished(() => {
    expect(dirname(resolve(root))).toBe(tempRoot)
    expect(root.startsWith(join(tempRoot, 'dsh-desktop-installer-'))).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  const script = join(root, 'scripts', 'install-desktop-plugin.mjs')
  const home = join(root, 'home')
  const installed = join(home, 'plugins', 'desktop-update')
  const profile = join(home, 'profiles', 'web', 'package.json')
  function write(file: string, value: string): void {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, value)
  }
  write(script, '')
  copyFileSync(new URL('../scripts/install-desktop-plugin.mjs', import.meta.url), script)
  // These fixtures take the already-installed path, so only presence matters.
  write(join(root, 'runtime', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), '')
  if (pnpmEntry) write(join(root, 'runtime', 'pnpm', 'bin', pnpmEntry), '')
  write(join(installed, 'package.json'), JSON.stringify({ name: pluginName, version }))
  write(join(installed, 'lib', 'index.js'), 'export function apply() {}')
  write(join(installed, 'lib', 'client.js'), 'export function apply() {}')
  write(profile, JSON.stringify({
    name: 'test-profile',
    dependencies: { [pluginName]: 'link:' + installed },
    dsh: { profile: { bundles: ['unrelated-plugin', pluginName] } },
  }))
  write(join(dirname(profile), 'node_modules', ...pluginName.split('/'), 'package.json'), '{}')

  // 版本已满足时不联网；否则只回报 registry 上的 0.1.2，用来走「旧版」分支。
  const network = join(root, 'network.mjs')
  write(network, `globalThis.fetch = async () => {
    if (${JSON.stringify(version)} === '0.2.0') throw new Error('Unexpected network request');
    return { ok: true, json: async () => ({ 'dist-tags': { latest: '0.1.2' } }) };
  };`)

  return {
    run: () => spawnSync(process.execPath, ['--import', pathToFileURL(network).href, script, 'install', '--home', home], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    }),
    profile: () => JSON.parse(readFileSync(profile, 'utf8')) as ProfilePackage,
  }
}

for (const entry of ['pnpm.mjs', 'pnpm.cjs'] as const) {
  test(`accepts a compatible installed plugin with ${entry}`, () => {
    const setup = fixture('0.2.0', entry)
    const result = setup.run()
    expectSuccess(result)
    expect(result.stdout).toMatch(/已安装 0\.2\.0/)
    expect(setup.profile().dsh.profile.bundles).toContain(pluginName)
  })
}

test('unregisters the old bridge client when the registry has no compatible version', () => {
  const setup = fixture('0.1.2', 'pnpm.mjs')
  const result = setup.run()
  expectSuccess(result)
  expect(result.stdout).toMatch(/低于要求的 0\.2\.0/)
  expect(setup.profile().dsh.profile.bundles).toEqual(['unrelated-plugin'])
  expect(setup.profile().dependencies[pluginName]).toBeUndefined()
})

test('reports a missing bundled pnpm entry', () => {
  const setup = fixture('0.2.0', undefined)
  const result = setup.run()
  expect(result.status).toBe(1)
  expect(result.stderr).toMatch(/内置运行时缺失/)
  expect(setup.profile().dsh.profile.bundles).toContain(pluginName)
})
