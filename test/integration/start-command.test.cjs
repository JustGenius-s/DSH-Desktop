const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

function launcherFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh start test ')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'node_modules', 'electron'), { recursive: true })
  copyFileSync(join(__dirname, '../../scripts/start.mjs'), join(root, 'scripts/start.mjs'))
  // 用 Node 代替 Electron，真实验证包含空格的路径、参数和进程退出码。
  writeFileSync(
    join(root, 'node_modules/electron/index.js'),
    `module.exports = ${JSON.stringify(process.execPath)}`,
  )
  writeFileSync(join(root, 'package.json'), JSON.stringify({ main: 'app.cjs' }))
  writeFileSync(
    join(root, 'app.cjs'),
    `
    console.log(JSON.stringify({
      args: process.argv.slice(2),
      cwd: process.cwd(),
      nodeOptions: process.env.NODE_OPTIONS,
    }))
    process.exitCode = 23
  `,
  )
  return root
}

test('start forwards arguments, preserves Node options, and returns the application exit code', (t) => {
  const root = launcherFixture(t)
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts/start.mjs'), '--flag', 'two words'],
    {
      cwd: tmpdir(),
      env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
      encoding: 'utf8',
      timeout: 10_000,
    },
  )
  assert.equal(result.status, 23, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    args: ['--flag', 'two words'],
    cwd: root,
    nodeOptions:
      process.platform === 'darwin' ? '--no-warnings --no-use-system-ca' : '--no-warnings',
  })
})
