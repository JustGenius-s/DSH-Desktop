import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { listPlugins, setBundleEnabled } from '../src/main/plugins/quarantine'

let home: string
let packagePath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-plugin-config-'))
  vi.stubEnv('DSH_HOME', home)
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  packagePath = join(profile, 'package.json')
  writeFileSync(
    packagePath,
    JSON.stringify({
      dependencies: { 'example-plugin': 'link:./plugins/example' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'example-plugin'] } },
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

test('plugin toggles update only the profile and keep dependencies available for re-enabling', () => {
  expect(setBundleEnabled('example-plugin', false)).toEqual({ ok: true })
  const disabled = readFileSync(packagePath, 'utf8')
  expect(JSON.parse(disabled).dependencies).toEqual({
    'example-plugin': 'link:./plugins/example',
  })
  expect(setBundleEnabled('example-plugin', true)).toEqual({ ok: true })
  expect(listPlugins()).toContainEqual({ name: 'example-plugin', enabled: true, core: false })
  expect(setBundleEnabled('@deepseek-ai/dsh-base', false).ok).toBe(false)
})
