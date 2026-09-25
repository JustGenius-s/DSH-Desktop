import { expect, test } from 'vitest'
import { compareVersions } from '../src/shared/version'

test.each([
  ['0.1.0-rc.7', '0.1.0-rc.6'],
  ['0.1.0-rc.10', '0.1.0-rc.9'],
  ['0.1.0', '0.1.0-rc.10'],
  ['0.2.0-alpha.1', '0.1.0'],
  ['1.0.0-alpha.beta', '1.0.0-alpha.1'],
  ['1.0.0-alpha.1', '1.0.0-alpha'],
])('version comparison orders %s after %s', (newer, older) => {
  expect(compareVersions(newer, older)).toBeGreaterThan(0)
  expect(compareVersions(older, newer)).toBeLessThan(0)
})

test('version comparison ignores the release tag prefix and build metadata', () => {
  expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
  expect(compareVersions('1.2.3+build.2', '1.2.3+build.1')).toBe(0)
})
