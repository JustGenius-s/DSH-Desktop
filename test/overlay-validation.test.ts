import { expect, test } from 'vitest'
import { sanitizeBounds, sanitizeChrome, sanitizeOpen } from '../src/main/overlays/validation'

const origin = 'http://127.0.0.1:49487'
const request = {
  contributor: 'desktop-pet',
  id: 'pet',
  url: '/plugins/pet?theme=dark',
  bounds: { width: 330, height: 230 },
}

test('overlay requests resolve relative URLs against the current host origin', () => {
  expect(sanitizeOpen(request, origin)).toEqual({
    ...request,
    url: origin + request.url,
    chrome: {},
  })
  expect(sanitizeOpen(request, null)).toBeNull()
})

test.each([
  'https://example.com/pet',
  '//example.com/pet',
  '/\\example.com/pet',
  'file:///tmp/pet',
])('overlay requests reject external or non-relative URLs: %s', (url) =>
  expect(sanitizeOpen({ ...request, url }, origin)).toBeNull(),
)

test('overlay bounds round coordinates and constrain sizes without inventing partial sizes', () => {
  expect(sanitizeBounds({ width: 1, height: 1000, x: -12.4, y: 5.6 }, false)).toEqual({
    width: 64,
    height: 800,
    x: -12,
    y: 6,
  })
  expect(sanitizeBounds({ x: 10 }, true)).toEqual({ width: 0, height: 0, x: 10 })
  expect(sanitizeBounds({ width: Infinity, height: 100 }, false)).toBeNull()
  expect(sanitizeBounds({ width: 100 }, false)).toBeNull()
})

test('overlay requests validate identity and chrome before reaching Electron', () => {
  expect(sanitizeOpen({ ...request, contributor: '../plugin' }, origin)).toBeNull()
  expect(sanitizeOpen({ ...request, id: '' }, origin)).toBeNull()
  expect(sanitizeChrome({ alwaysOnTop: 'yes' })).toBeNull()
  expect(sanitizeChrome({ ignoreMouseEvents: 'forward' })).toEqual({ ignoreMouseEvents: 'forward' })
  expect(sanitizeChrome({ ignoreMouseEvents: true })).toBeNull()
})
