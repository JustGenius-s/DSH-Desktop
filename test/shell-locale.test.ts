import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, onTestFinished, test } from 'vitest'

import {
  currentShellLang,
  localePatchPath,
  parseLocalePreference,
  readLocalePreference,
  resolveShellLang,
} from '../src/shell-locale'

/** 临时 DSH home；用例结束自动清理。 */
function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-shell-locale-'))
  const homePath = join(root, 'home')
  onTestFinished(() => {
    expect(root.startsWith(join(tmpdir(), 'dsh-shell-locale-'))).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })
  return homePath
}

/** 写一份 profile 补丁文档。 */
function writePatch(home: string, body: string): string {
  const file = localePatchPath(home)
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(file, body)
  return file
}

test('resolveShellLang folds zh variants into zh and everything else into en', () => {
  for (const tag of ['zh', 'zh-CN', 'zh_CN', 'zh-Hans', 'ZH-tw', '  zh  ']) {
    expect(resolveShellLang(tag)).toBe('zh')
  }
  for (const tag of ['en', 'en-US', 'fr', 'zho', '', '   ', undefined, null]) {
    expect(resolveShellLang(tag)).toBe('en')
  }
})

test('parses the block form DSH writes', () => {
  const patch = [
    '# dsh profile patch',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: tt',
    '- id: locale',
    '  name: "@deepseek-ai/dsh-client-locale"',
    '  config:',
    '    preference: zh',
    '- id: ui-theme',
    '  name: "@deepseek-ai/dsh-client-ui-theme"',
    '  config:',
    '    preference: dark',
  ].join('\n')
  expect(parseLocalePreference(patch)).toBe('zh')
})

test('ignores other entries that also carry a preference', () => {
  const patch = [
    '- id: ui-theme',
    '  config:',
    '    preference: dark',
    '- id: locale',
    '  config:',
    '    preference: en',
  ].join('\n')
  expect(parseLocalePreference(patch)).toBe('en')
})

test('the last locale entry wins (layered patches override)', () => {
  const patch = [
    '- id: locale',
    '  config:',
    '    preference: zh',
    '- id: locale',
    '  config:',
    '    preference: en',
  ].join('\n')
  expect(parseLocalePreference(patch)).toBe('en')
})

test('reads inline and quoted forms', () => {
  expect(parseLocalePreference('- id: locale\n  config: { preference: en }')).toBe('en')
  expect(parseLocalePreference('- id: locale\n  config:\n    preference: "zh-CN"')).toBe('zh-CN')
  expect(parseLocalePreference("- id: locale\n  config:\n    preference: 'en' # picked by user")).toBe('en')
})

test('treats an absent or empty preference as unset', () => {
  expect(parseLocalePreference('[]')).toBeUndefined()
  expect(parseLocalePreference('- id: locale\n  config:\n    preference:')).toBeUndefined()
  expect(parseLocalePreference('- id: locale\n  config:\n    preference: null')).toBeUndefined()
  expect(parseLocalePreference('- id: locale\n  config: { }')).toBeUndefined()
  // config 之后的同级 key 不能把别的字段当成 preference。
  expect(parseLocalePreference('- id: locale\n  name: x\n- id: other\n  config:\n    preference: zh')).toBeUndefined()
})

test('a missing or unreadable document reads as unset', () => {
  expect(readLocalePreference(join(tempHome(), 'profiles', 'web', 'cordis.patch.yml'))).toBeUndefined()
  expect(readLocalePreference('/definitely/not/here')).toBeUndefined()
})

test('currentShellLang prefers the document over the system locale', () => {
  const home = tempHome()
  writePatch(home, '- id: locale\n  config:\n    preference: zh')
  // 系统英文、但用户选了中文 → 跟随用户选择。
  expect(currentShellLang('en-US', home)).toBe('zh')
})

test('currentShellLang falls back to the system locale when unset', () => {
  const home = tempHome()
  expect(currentShellLang('zh-CN', home)).toBe('zh')
  expect(currentShellLang('en-US', home)).toBe('en')
  // 文档存在但没写 locale 条目 → 同样回落。
  writePatch(home, '- id: ui-theme\n  config:\n    preference: dark')
  expect(currentShellLang('zh-CN', home)).toBe('zh')
})
