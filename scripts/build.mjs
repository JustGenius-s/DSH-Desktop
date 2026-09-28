import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

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

// 沙箱 preload 只能 require Electron；本地模块在构建时打包到同一文件。
await build({
  absWorkingDir: root,
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  external: ['electron'],
})
