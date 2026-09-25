import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = fileURLToPath(new URL('../', import.meta.url))
// 在 Electron 启动前设置 TLS 兼容选项，保留调用方的其他 Node 参数。
const env = {
  ...process.env,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, '--no-use-system-ca'].filter(Boolean).join(' '),
}
const child = spawn(electronPath, [root, ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: 'inherit',
})

child.on('error', (error) => {
  console.error('[start] 无法启动 Electron:', error.message)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1))
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}
