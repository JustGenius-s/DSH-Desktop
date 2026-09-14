const { test } = require('node:test')
const assert = require('node:assert/strict')
const { dshAuthCookieUrl, isDshAuthCookie } = require('../dist/dsh-auth-cookies.js')

test('recognizes only DSH loopback auth cookies', () => {
  assert.equal(isDshAuthCookie({ name: 'dsh-auth-old', domain: '127.0.0.1' }), true)
  assert.equal(isDshAuthCookie({ name: 'dsh-auth-old', domain: '.127.0.0.1' }), true)
  assert.equal(isDshAuthCookie({ name: 'dsh-auth-old', domain: 'localhost' }), false)
  assert.equal(isDshAuthCookie({ name: 'other', domain: '127.0.0.1' }), false)
})

test('builds a removable URL for each cookie variant', () => {
  assert.equal(dshAuthCookieUrl({ domain: '127.0.0.1', path: '/' }), 'http://127.0.0.1/')
  assert.equal(dshAuthCookieUrl({ domain: '.127.0.0.1', path: '/nested' }), 'http://127.0.0.1/nested')
  assert.equal(dshAuthCookieUrl({ domain: '127.0.0.1', path: '/secure', secure: true }), 'https://127.0.0.1/secure')
  assert.equal(dshAuthCookieUrl({}), 'http://127.0.0.1/')
})
