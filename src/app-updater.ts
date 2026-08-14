/**
 * 应用本体更新检测：查 GitHub Releases 是否有比当前版本更新的发布。
 * 命中返回更新信息，由 main.ts 弹窗提示下载。与 DSH 运行时升级
 * （runtime-manager.ts 管 `@deepseek-ai/dsh` 包）是两回事——这里只管
 * 桌面 App 自己，只做「检测 + 提示跳下载」，不做静默自动安装。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/**
 * GitHub Releases 的 latest 网页地址（非 REST API）。它 302 跳转到
 * `/releases/tag/vX.Y.Z`，从 Location 头即可解析版本号。
 * 不用 `api.github.com` 的原因：REST API 未认证限流 60 次/小时/来源 IP，
 * 企业 NAT / 共享出口下容易被打满导致检测静默失败；网页端点无此限制，
 * 行为一致（draft 404、prerelease 不算 latest）。
 */
const RELEASES_URL = 'https://github.com/JustGenius-s/DSH-Desktop/releases/latest'

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

/** 记录「用户已关闭更新提示」的标记：写入后任何新版本都不再弹窗。 */
function skipFilePath(): string {
  return join(app.getPath('userData'), 'app-update-skip.json')
}

/** 用户是否已选择「不再提示」应用更新。 */
export function appUpdateDismissed(): boolean {
  try {
    const obj = JSON.parse(readFileSync(skipFilePath(), 'utf8')) as { dismissed?: unknown }
    return obj.dismissed === true
  } catch {
    return false
  }
}

/** 用户点「不再提示」时调用，永久关闭应用更新弹窗（删掉该文件可恢复）。 */
export function dismissAppUpdate(): void {
  try {
    mkdirSync(dirname(skipFilePath()), { recursive: true })
    writeFileSync(skipFilePath(), JSON.stringify({ dismissed: true }, null, 2) + '\n')
  } catch {
    // 写失败无妨：最坏只是下次启动再提示一次。
  }
}

/** 查 GitHub 最新发布；网络失败 / 无 release（404）/ 非预期响应都静默返回 undefined。 */
export async function latestAppRelease(): Promise<{ version: string; url: string } | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    // redirect:'manual' 拿到 302 的 Location，不跟随跳转（省一次整页下载）。
    const res = await fetch(RELEASES_URL, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'DSH-Desktop' },
    })
    // 无 release 时该地址直接 404（不跳转），视为没有更新。
    if (res.status !== 302 && res.status !== 301) return undefined
    const location = res.headers.get('location')
    if (location === null) return undefined
    // Location 形如 https://github.com/<owner>/<repo>/releases/tag/vX.Y.Z
    const tag = /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1]
    if (tag === undefined) return undefined
    return { version: normalizeVersion(decodeURIComponent(tag)), url: location }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** 检测是否有比当前更新的版本；用户已关闭提示、没有更新或失败返回 undefined。 */
export async function checkForAppUpdate(): Promise<AppUpdateInfo | undefined> {
  if (appUpdateDismissed()) return undefined
  const release = await latestAppRelease()
  if (release === undefined) return undefined

  const current = normalizeVersion(app.getVersion())
  if (compareVersions(release.version, current) <= 0) return undefined

  return { current, latest: release.version, url: release.url }
}
