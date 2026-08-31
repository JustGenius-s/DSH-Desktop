/**
 * 外置 DSH 运行时管理：内置 node + pnpm，把 `@deepseek-ai/dsh` 装到
 * `~/.dsh/runtime`，并支持自动检测 / 手动触发升级。DSH 升级从此只走
 * pnpm，不再重打包、重签名桌面版。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { DshChannel } from './api'

/** DSH home（与 CLI 约定一致：`$DSH_HOME` 或 `~/.dsh`）。 */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 外置运行时安装根目录，CLI 与桌面版共用。 */
export function runtimeDir(): string {
  return join(dshHome(), 'runtime')
}

/** 内置运行时根目录：打包在 `resources/runtime`，开发模式在仓库根 `runtime/`。 */
function bundledRuntimeRoot(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(base, 'runtime')
}

/** 内置 node 可执行文件（打包时按目标平台放入 `bin/`）。 */
export function bundledNodeBin(): string {
  return join(bundledRuntimeRoot(), 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
}

/** 内置 pnpm 入口（bin/pnpm.cjs 依赖同层 pnpm.mjs 与 ../dist/，故整包解到 runtime/pnpm/）。 */
function bundledPnpmCjs(): string {
  return join(bundledRuntimeRoot(), 'pnpm', 'bin', 'pnpm.cjs')
}

/** 内置 `bin/` 目录：前置进子进程 PATH，让 dsh 内部的 `spawnSync('pnpm')` 找得到 pnpm。 */
function bundledBinDir(): string {
  return join(bundledRuntimeRoot(), 'bin')
}

/** 把内置 `bin/` 目录前置进 PATH。 */
export function withBundledBinPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':'
  return { ...env, PATH: `${bundledBinDir()}${sep}${env.PATH ?? ''}` }
}

/** 已安装的 dsh bin.js；未安装返回 undefined。 */
export function installedDshBin(): string | undefined {
  const bin = join(runtimeDir(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return existsSync(bin) ? bin : undefined
}

/** 已安装的 dsh 版本；未安装返回 undefined。 */
export function installedDshVersion(): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(join(runtimeDir(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
    ) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/** 跑一次内置 pnpm。日志接到父进程；Windows 隐藏控制台，避免打包后弹出黑窗口。 */
function runPnpm(args: readonly string[]): Promise<void> {
  return new Promise((resolvePnpm, reject) => {
    const child: ChildProcess = spawn(bundledNodeBin(), [bundledPnpmCjs(), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // node 必须进 PATH：pnpm 跑原生依赖的构建脚本时依赖它。
      env: withBundledBinPath(process.env),
    })
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk))
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolvePnpm()
      else reject(new Error(`pnpm 退出码 ${code ?? 'null'}`))
    })
  })
}

/** 安装/升级统一走官方源，避免本机镜像 dist-tags 滞后装到坏版本。 */
const DSH_REGISTRY = 'https://registry.npmjs.org/'

/**
 * 组装 `pnpm add @deepseek-ai/dsh@<version>` 的完整参数。
 * 显式版本而非 `@latest`：`latest` 标签会被本机镜像 / pnpm 元数据缓存污染，
 * 解析到已下架的坏版本（0.0.1-rc.2）导致 404。
 */
function installDshArgs(dir: string, version: string): string[] {
  return [
    '--dir', dir,
    '--registry', DSH_REGISTRY,
    '--dangerously-allow-all-builds',
    'add', `@deepseek-ai/dsh@${version}`,
  ]
}

/** 首次启动时安装最新版 `@deepseek-ai/dsh`（已装则跳过），返回 bin.js 路径。 */
export async function ensureDshInstalled(onStatus?: (message: string) => void): Promise<string> {
  const bin = installedDshBin()
  if (bin !== undefined) return bin

  onStatus?.('正在检查 DSH 最新版本…')
  const version = await latestDshVersion()
  if (version === undefined) {
    throw new Error('无法从 npm 获取 @deepseek-ai/dsh 最新版本（请检查网络或 npm registry 可达性）')
  }

  onStatus?.(`正在安装 DSH 运行时 ${version}…（首次约需 1-2 分钟）`)
  const dir = runtimeDir()
  mkdirSync(dir, { recursive: true })
  const pj = join(dir, 'package.json')
  if (!existsSync(pj)) {
    writeFileSync(pj, JSON.stringify({ name: 'dsh-runtime', private: true }, null, 2) + '\n')
  }

  await runPnpm(installDshArgs(dir, version))

  const after = installedDshBin()
  if (after === undefined) throw new Error('安装完成但未找到 @deepseek-ai/dsh 的 bin.js')
  return after
}

/** 查 npm registry 上 `@deepseek-ai/dsh` 的 dist-tags；失败返回 undefined。 */
async function fetchDshDistTags(): Promise<Record<string, string> | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh', { signal: controller.signal })
    if (!res.ok) return undefined
    const body = (await res.json()) as { 'dist-tags'?: unknown }
    const tags = body['dist-tags']
    if (tags === null || typeof tags !== 'object') return undefined
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(tags as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** 判断一个字符串是否像 npm 包版本（不含 tag 语义）——用于 custom 渠道兜底校验。 */
export function looksLikeVersion(input: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(input.trim())
}

/**
 * 按更新渠道解析目标版本：
 * - `latest` / `next` / `alpha`：读 npm 上同名 dist-tag；标签不存在返回 undefined。
 *   （`alpha` 是上游发 alpha 时专用的 tag，发 alpha 不会动 `latest`，
 *   所以必须显式支持这个渠道，否则 alpha 版本永远检测不到。）
 * - `custom`：`exact` 指定精确版本直接采用；否则按 channel 解析 dist-tag，
 *   但只有当结果不含 prerelease（正式版）时才算「渠道已发布」。
 * 全部失败返回 undefined（调用方静默吞掉，保持现状）。
 */
export async function resolveDshChannelVersion(channel: DshChannel, exact?: string): Promise<string | undefined> {
  const tags = await fetchDshDistTags()
  if (tags === undefined) return undefined
  if (channel === 'custom') {
    const version = (exact ?? '').trim()
    if (version !== '' && looksLikeVersion(version)) return version
    return undefined
  }
  const version = tags[channel]
  if (typeof version !== 'string' || version === '') return undefined
  return version
}

/** 查 npm registry 上 `@deepseek-ai/dsh` 的最新版本；失败返回 undefined。 */
export async function latestDshVersion(): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh', { signal: controller.signal })
    if (!res.ok) return undefined
    const body = (await res.json()) as { 'dist-tags'?: { latest?: unknown } }
    const version = body['dist-tags']?.latest
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** 升级到指定版本（由调用方先 `latestDshVersion()` 解析好）。 */
export async function updateDsh(
  version: string,
  onStatus?: (message: string) => void,
): Promise<void> {
  onStatus?.(`正在通过 pnpm 安装 @deepseek-ai/dsh@${version}…（约需 1–2 分钟）`)
  await runPnpm(installDshArgs(runtimeDir(), version))
  onStatus?.('安装完成，正在校验…')
}
