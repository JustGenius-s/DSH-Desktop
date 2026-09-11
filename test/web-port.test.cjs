const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:net')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { DSH_HOST, findFreePort, readWebPort, rememberWebPort } = require('../dist/web-port.js')

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'dsh-web-port-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

test('cold boots reuse the port persisted by the previous successful host', async (t) => {
  const userData = directory(t)
  assert.equal(readWebPort(userData), undefined)
  const first = await findFreePort()
  rememberWebPort(userData, first)
  assert.equal(await findFreePort(readWebPort(userData)), first)
  assert.deepEqual(JSON.parse(readFileSync(join(userData, 'web-port.json'), 'utf8')), { port: first })
  assert.deepEqual(readdirSync(userData), ['web-port.json'])
})

test('an occupied remembered port falls back without contacting its owner', async (t) => {
  const server = createServer(() => assert.fail('must not contact another service'))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  await new Promise((resolve) => server.listen(0, DSH_HOST, resolve))
  const occupied = server.address().port
  const selected = await findFreePort(occupied)
  assert.notEqual(selected, occupied)
  const userData = directory(t)
  rememberWebPort(userData, selected)
  assert.equal(await findFreePort(readWebPort(userData)), selected)
})

test('corrupt and invalid port records do not block startup', (t) => {
  const userData = directory(t)
  for (const raw of ['{broken', 'null', '{}', '{"port":"49487"}', '{"port":0}', '{"port":80}', '{"port":65536}', '{"port":4096.5}']) {
    writeFileSync(join(userData, 'web-port.json'), raw)
    assert.equal(readWebPort(userData), undefined)
  }
  assert.throws(() => rememberWebPort(userData, 0), /invalid web port/)
})

test('development and installed profiles retain independent origins', async (t) => {
  const production = directory(t)
  const development = directory(t)
  rememberWebPort(production, 49487)
  rememberWebPort(development, 65333)
  assert.equal(readWebPort(production), 49487)
  assert.equal(readWebPort(development), 65333)
})
