/**
 * 应用本体更新检测：查 GitHub Releases 是否有比当前版本更新的发布。
 * 命中返回更新信息，由 main.ts 弹窗提示下载。与 DSH 运行时升级
 * （runtime-manager.ts 管 `@deepseek-ai/dsh` 包）是两回事——这里只管
 * 桌面 App 自己，只做「检测 + 提示跳下载」，不做静默自动安装。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/** GitHub Releases 的 latest 接口（未认证，有 60 次/小时/来源 IP 的限流）。 */
const RELEASES_URL = 'https://api.github.com/repos/JustGenius-s/DSH-Desktop/releases/latest'

/** 一个更新提示结果：当前版本、最新版本、下载入口（Releases 页面）。 */
export interface AppUpdateInfo {
  current: string
  latest: string
  url: string
}

/** 去掉版本号前可能带的 `v`（tag 常写成 v0.1.0）。 */
function normalizeVersion(v: string): string {
  return v.replace(/^[vV]/, '')
}

/** 取 major.minor.patch 三个数字段，非数字补 0；忽略预发布后缀。 */
function parseVersion(v: string): number[] {
  return normalizeVersion(v)
    .split('.')
    .slice(0, 3)
    .map((p) => {
      const n = Number.parseInt(p, 10)
      return Number.isNaN(n) ? 0 : n
    })
}

/** 比较两个版本号：a > b 返回正数，相等 0，小于 负数。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da - db
  }
  return 0
}

/** 记录「用户已跳过」的版本，避免每次启动都重复弹窗。 */
function skipFilePath(): string {
  return join(app.getPath('userData'), 'app-update-skip.json')
}

function skippedAppVersion(): string | undefined {
  try {
    const obj = JSON.parse(readFileSync(skipFilePath(), 'utf8')) as { version?: unknown }
    return typeof obj.version === 'string' ? obj.version : undefined
  } catch {
    return undefined
  }
}

/** 用户点「稍后」时调用，记住该版本，下次启动不再提示。 */
export function dismissAppUpdate(version: string): void {
  try {
    mkdirSync(dirname(skipFilePath()), { recursive: true })
    writeFileSync(skipFilePath(), JSON.stringify({ version }, null, 2) + '\n')
  } catch {
    // 写失败无妨：最坏只是下次启动再提示一次。
  }
}

/** 查 GitHub 最新发布；网络失败 / 限流 / 非预期响应都静默返回 undefined。 */
export async function latestAppRelease(): Promise<{ version: string; url: string } | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(RELEASES_URL, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'DSH-Desktop',
        Accept: 'application/vnd.github+json',
      },
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown }
    const version = typeof body.tag_name === 'string' ? normalizeVersion(body.tag_name) : undefined
    const url = typeof body.html_url === 'string' ? body.html_url : undefined
    if (version === undefined || url === undefined) return undefined
    return { version, url }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** 检测是否有比当前更新、且未被用户跳过的版本；没有或失败返回 undefined。 */
export async function checkForAppUpdate(): Promise<AppUpdateInfo | undefined> {
  const release = await latestAppRelease()
  if (release === undefined) return undefined

  const current = normalizeVersion(app.getVersion())
  if (compareVersions(release.version, current) <= 0) return undefined
  if (release.version === skippedAppVersion()) return undefined

  return { current, latest: release.version, url: release.url }
}
