import { expect, test } from 'vitest'

import { menuStrings, withAppName } from '../src/menu-i18n'
import { resolveShellLang, type ShellLang } from '../src/shell-locale'

test('zh and en dictionaries carry identical key sets', () => {
  expect(Object.keys(menuStrings('zh')).sort()).toEqual(Object.keys(menuStrings('en')).sort())
})

test('every string is present and non-blank in both languages', () => {
  for (const lang of ['zh', 'en'] as ShellLang[]) {
    for (const [key, value] of Object.entries(menuStrings(lang))) {
      expect(value.trim(), lang + '.' + key).not.toBe('')
    }
  }
})

test('app-name templates keep their placeholder in both languages', () => {
  for (const lang of ['zh', 'en'] as ShellLang[]) {
    const t = menuStrings(lang)
    for (const key of ['about', 'hide', 'quit', 'trayShow'] as const) {
      expect(t[key], lang + '.' + key).toContain('{name}')
    }
  }
})

test('withAppName fills the placeholder and leaves plain labels alone', () => {
  expect(withAppName('About {name}', 'DSH-Desktop')).toBe('About DSH-Desktop')
  expect(withAppName('关于 {name}', 'DSH-Desktop')).toBe('关于 DSH-Desktop')
  expect(withAppName('Hide Others', 'DSH-Desktop')).toBe('Hide Others')
})

test('language follows the resolved shell language', () => {
  expect(menuStrings(resolveShellLang('zh-CN')).hideOthers).toBe('隐藏其他')
  expect(menuStrings(resolveShellLang('en-US')).hideOthers).toBe('Hide Others')
})

test('menu labels are actually translated, not copied', () => {
  const zh = menuStrings('zh')
  const en = menuStrings('en')
  // 这些文案都不含 {name} 占位，中英必须不同——相同即为漏翻。
  for (const key of ['edit', 'view', 'window', 'plugins', 'reload', 'undo', 'copy'] as const) {
    expect(zh[key], key).not.toBe(en[key])
  }
})
