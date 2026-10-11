const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createOverlayOperations } = require('../dist/main/overlays/operations.js')

function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('opens for one contributor are serialized without blocking another contributor', async () => {
  const queue = createOverlayOperations()
  const gate = deferred()
  const calls = []
  const first = queue.run('a', async () => {
    calls.push('first')
    await gate.promise
  })
  const second = queue.run('a', async () => {
    calls.push('second')
  })
  await queue.run('b', async () => {
    calls.push('other')
  })
  assert.deepEqual(calls, ['first', 'other'])
  gate.resolve()
  await Promise.all([first, second])
  assert.deepEqual(calls, ['first', 'other', 'second'])
})

test('restart invalidates active and queued opens while a fresh generation can start', async () => {
  const queue = createOverlayOperations()
  const gate = deferred()
  let check
  const first = queue.run('a', async (isCurrent) => {
    check = isCurrent
    await gate.promise
  })
  const stale = queue.run('a', async () => assert.fail('stale open must not create a window'))
  const rejected = assert.rejects(stale, /closed while loading/)
  await Promise.resolve()
  queue.cancelAll()
  assert.equal(check(), false)
  assert.equal(await queue.run('a', async (isCurrent) => isCurrent()), true)
  gate.resolve()
  await first
  await rejected
})

test('closing one contributor leaves the others available', async () => {
  const queue = createOverlayOperations()
  const closed = queue.run('a', async () => assert.fail('closed'))
  queue.cancel('a')
  await assert.rejects(closed, /closed while loading/)
  assert.equal(await queue.run('b', async () => 42), 42)
})

test('a failed operation does not poison later opens', async () => {
  const queue = createOverlayOperations()
  await assert.rejects(
    queue.run('a', async () => {
      throw new Error('failed')
    }),
    /failed/,
  )
  assert.equal(await queue.run('a', async () => 'retry'), 'retry')
})
