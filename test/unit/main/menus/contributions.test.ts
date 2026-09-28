import { expect, test } from 'vitest'
import { sanitizeContribution } from '../../../../src/main/menus/contributions'

const request = { seat: 'tray', contributor: 'plugin', items: [{ id: 'open', label: 'Open' }] }

test('menu contributions strip unsupported accelerators before reaching Electron', () => {
  const contribution = sanitizeContribution({
    ...request,
    items: [
      { id: 'open', label: 'Open', accelerator: 'CmdOrCtrl+O' },
      { id: 'close', label: 'Close', accelerator: 'arbitrary script()' },
    ],
  })
  expect(contribution?.items[0]).toHaveProperty('accelerator', 'CmdOrCtrl+O')
  expect(contribution?.items[1]).not.toHaveProperty('accelerator')
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
