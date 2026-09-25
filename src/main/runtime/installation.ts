/**
 * 外置 DSH 运行时管理：内置 node + pnpm，把 `@deepseek-ai/dsh` 装到
 * `~/.dsh/runtime`，并支持自动检测 / 手动触发升级。DSH 升级从此只走
 * pnpm，不再重打包、重签名桌面版。
 */

import { session } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions } from '../../shared/version'
import { runPnpm } from './environment'
import { runtimeDir } from './paths'

/** 已安装的 dsh bin.js；未安装返回 undefined。 */
export function installedDshBin(): string | undefined {
  const bin = join(runtimeDir(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return existsSync(bin) ? bin : undefined
}

/** 已安装的 dsh 版本；未安装返回 undefined。 */
export function installedDshVersion(): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(runtimeDir(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
        'utf8',
      ),
    ) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
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
    '--dir',
    dir,
    '--registry',
    DSH_REGISTRY,
    '--dangerously-allow-all-builds',
    'add',
    `@deepseek-ai/dsh@${version}`,
  ]
}

/**
 * 查 npm registry 上 `@deepseek-ai/dsh` 的全部 dist-tags；失败返回 undefined。
 *
 * 首装取 latest，更新检查比较全部渠道。用 `session.defaultSession.fetch`
 * 而非全局 fetch：它走 Chromium 栈，不触发 Node TLS，绕开打包版
 * SetRootCerts 崩溃。
 */
async function fetchDshDistTags(): Promise<Record<string, string> | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await session.defaultSession.fetch(`${DSH_REGISTRY}@deepseek-ai%2Fdsh`, {
      signal: controller.signal,
    })
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

/**
 * 全部 dist-tag 里版本最高的那个；失败返回 undefined。
 *
 * 不看单个渠道：上游发 alpha / rc 时不会动 `latest`，只看 latest 就永远看不到
 * 更新的 next / alpha。这里把所有 tag 的版本都比一遍取最高（含 prerelease 规则，
 * 否则 rc.6 与 rc.7 会被判相等）。
 */
export async function latestDshAcrossChannels(): Promise<string | undefined> {
  const tags = await fetchDshDistTags()
  if (tags === undefined) return undefined
  let best: string | undefined
  for (const version of Object.values(tags)) {
    if (version === '') continue
    if (best === undefined || compareVersions(version, best) > 0) best = version
  }
  return best
}

/** 首次启动时安装最新版 `@deepseek-ai/dsh`（已装则跳过），返回 bin.js 路径。 */
export async function ensureDshInstalled(onStatus?: (message: string) => void): Promise<string> {
  const bin = installedDshBin()
  if (bin !== undefined) return bin

  onStatus?.('正在检查 DSH 最新版本…')
  const version = (await fetchDshDistTags())?.latest
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

/** 升级到调用方指定的版本；版本选择由 updates/bridge.ts 负责。 */
export async function updateDsh(
  version: string,
  onStatus?: (message: string) => void,
): Promise<void> {
  onStatus?.(`正在通过 pnpm 安装 @deepseek-ai/dsh@${version}…（约需 1–2 分钟）`)
  await runPnpm(installDshArgs(runtimeDir(), version))
  onStatus?.('安装完成，正在校验…')
}
