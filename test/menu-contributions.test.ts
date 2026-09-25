import { expect, test } from 'vitest'
import { sanitizeContribution } from '../src/main/menus/contributions'

const request = { seat: 'tray', contributor: 'plugin', items: [{ id: 'open', label: 'Open' }] }

test('menu contributions normalize defaults and accept only supported accelerators', () => {
  expect(
    sanitizeContribution({
      ...request,
      order: NaN,
      items: [
        { id: 'open', label: 'Open', accelerator: 'CmdOrCtrl+O' },
        { type: 'separator' },
        { id: 'close', label: 'Close', accelerator: 'arbitrary script()' },
      ],
    }),
  ).toEqual({
    ...request,
    menu: 'plugins',
    order: 0,
    tooltip: undefined,
    items: [
      { id: 'open', type: 'normal', label: 'Open', accelerator: 'CmdOrCtrl+O' },
      { type: 'separator' },
      { id: 'close', type: 'normal', label: 'Close' },
    ],
  })
})

test('menu contributions reject invalid identities and oversized menus', () => {
  expect(sanitizeContribution({ ...request, contributor: '../plugin' })).toBeNull()
  expect(sanitizeContribution({ ...request, seat: 'unknown' })).toBeNull()
  expect(sanitizeContribution({ ...request, items: Array(25).fill(request.items[0]) })).toBeNull()
  expect(
    sanitizeContribution({ ...request, items: [{ id: 'open', label: 'x'.repeat(121) }] }),
  ).toBeNull()
})

test('menu contributions accept two submenu levels but reject deeper nesting', () => {
  const leaf = { id: 'leaf', label: 'Leaf' }
  const menu = {
    id: 'menu',
    label: 'Menu',
    submenu: [{ id: 'sub', label: 'Sub', submenu: [leaf] }],
  }
  expect(sanitizeContribution({ ...request, items: [menu] })).not.toBeNull()
  expect(sanitizeContribution({ ...request, items: [{ ...menu, submenu: [menu] }] })).toBeNull()
})
