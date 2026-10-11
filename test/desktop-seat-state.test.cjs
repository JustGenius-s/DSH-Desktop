const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  nativeMenuItemId,
  scheduleTrailing,
  upsertContribution,
} = require('../dist/main/menus/seat-state.js')

function contribution(overrides = {}) {
  return {
    wcId: 7,
    seat: 'applicationMenu',
    contributor: 'updates',
    menu: 'app',
    order: 10,
    tooltip: undefined,
    items: [{ id: 'check', label: 'Check' }],
    ...overrides,
  }
}

test('identical repeated contributions do not request another native rebuild', () => {
  const rows = []
  assert.equal(upsertContribution(rows, contribution()), true)
  assert.equal(
    upsertContribution(rows, contribution({ items: [{ id: 'check', label: 'Check' }] })),
    false,
  )
  assert.equal(rows.length, 1)

  assert.equal(
    upsertContribution(rows, contribution({ items: [{ id: 'check', label: 'Checking…' }] })),
    true,
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].items[0].label, 'Checking…')
})

test('the same command has a distinct native id on every menu surface', () => {
  const app = contribution({ seat: 'applicationMenu', menu: 'app' })
  const plugins = contribution({ seat: 'applicationMenu', menu: 'plugins' })
  const tray = contribution({ seat: 'tray', menu: 'plugins' })
  const ids = [app, plugins, tray].map((row) => nativeMenuItemId(row, 'check'))

  assert.equal(new Set(ids).size, 3)
  assert.deepEqual(ids, [
    'applicationMenu:app:updates:check',
    'applicationMenu:plugins:updates:check',
    'tray:plugins:updates:check',
  ])
})

test('a contribution burst retains only the final scheduled rebuild', () => {
  let nextId = 0
  const pending = new Map()
  const cleared = []
  const unrefed = []
  const clock = {
    set(task, delayMs) {
      const id = ++nextId
      pending.set(id, { task, delayMs })
      return id
    },
    clear(id) {
      cleared.push(id)
      pending.delete(id)
    },
    unref(id) {
      unrefed.push(id)
    },
  }

  let runs = 0
  const first = scheduleTrailing(
    null,
    () => {
      runs += 1
    },
    100,
    clock,
  )
  const final = scheduleTrailing(
    first,
    () => {
      runs += 1
    },
    100,
    clock,
  )

  assert.deepEqual(cleared, [first])
  assert.deepEqual(unrefed, [first, final])
  assert.deepEqual(
    [...pending.values()].map((entry) => entry.delayMs),
    [100],
  )
  pending.get(final).task()
  assert.equal(runs, 1)
})
