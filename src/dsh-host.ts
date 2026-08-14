/**
 * dsh web host 的生命周期管理：定位 CLI 入口、分配端口、spawn 子进程、
 * 以及轮询就绪。Electron 主进程（main.ts）负责窗口与退出编排，本模块
 * 只关心「把 dsh 当作一个本地服务拉起来」这一件事，方便单独测试。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { get } from 'node:http'
import { bundledNodeBin, withBundledBinPath } from './runtime-manager'

/** host 只绑定回环地址：桌面端单机使用，绝不对外网暴露 RCE 面。 */
export const DSH_HOST = '127.0.0.1'

/** dsh 启动后轮询就绪的总超时。 */
export const READY_TIMEOUT_MS = 30_000

/** 就绪轮询间隔。 */
const READY_POLL_MS = 250

/** 分配一个空闲的回环 TCP 端口。 */
export function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, DSH_HOST, () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      srv.close(() => resolvePort(port))
    })
  })
}

/**
 * spawn dsh web 子进程，用内置 node 跑外置 dsh（打包与开发模式一致）。
 * @param port - 回环端口。
 * @param bin - dsh CLI 入口（由 main.ts 先 `ensureDshInstalled()` 解析）。
 */
export function startDsh(port: number, bin: string): ChildProcess {
  const env: NodeJS.ProcessEnv = withBundledBinPath({ ...process.env })
  const args = [bin, 'web', '--host', DSH_HOST, '--port', String(port)]

  const child = spawn(bundledNodeBin(), args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

  // 把 dsh 的日志透传到 Electron 的 stdout/stderr，方便排查。
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[dsh] ${chunk.toString()}`))
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[dsh] ${chunk.toString()}`))

  return child
}

/** 探测 host 是否已响应（任意非 5xx 都算「起来了」）。 */
function probe(url: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const req = get(url, (res) => {
      res.resume()
      resolveProbe(res.statusCode !== undefined && res.statusCode < 500)
    })
    req.on('error', () => resolveProbe(false))
    req.setTimeout(1000, () => {
      req.destroy()
      resolveProbe(false)
    })
  })
}

/** 轮询直到 host 响应，超时抛错。 */
export async function waitForReady(port: number, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const url = `http://${DSH_HOST}:${port}/`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe(url)) return
    await new Promise(r => setTimeout(r, READY_POLL_MS))
  }
  throw new Error(`dsh host 未在 ${timeoutMs}ms 内就绪（${url}）`)
}
