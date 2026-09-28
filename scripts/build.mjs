import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))

// tsc 不删除搬迁前的输出；每次重建，避免旧模块继续进入安装包或回归测试。
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true })
const result = spawnSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'],
  {
    cwd: root,
    stdio: 'inherit',
  },
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

// 沙箱 preload 不能 require 本地模块；只在构建时读取并内联网页通知脚本。
const { WEB_NOTIFICATION_BRIDGE } = require('../dist/main/notifications/web-bridge.js')
const preloadPath = new URL('../dist/preload.js', import.meta.url)
const preload = readFileSync(preloadPath, 'utf8')
const marker = '__DSH_WEB_NOTIFICATION_BRIDGE__'
if (preload.split(marker).length !== 2)
  throw new Error('preload notification marker must occur once')
writeFileSync(
  preloadPath,
  preload.replace(marker, () => JSON.stringify(WEB_NOTIFICATION_BRIDGE)),
)
