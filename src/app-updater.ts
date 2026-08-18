/**
 * 应用本体更新检测：查 GitHub Releases 是否有比当前版本更新的发布。
 * 检测结果由 desktop-bridge.ts 聚合并经 preload 暴露给网页（更新徽章）。
 * 与 DSH 运行时升级（runtime-manager.ts 管 `@deepseek-ai/dsh` 包）是两回事
 * ——这里只管桌面 App 自己，只做「检测 + 提示跳下载」，不做静默自动安装。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

/** 解析版本号为 [major, minor, patch, prerelease 段数组]；非数字段补 0。 */
function parseVersion(v: string): [number, number, number, string[]] {
  const m = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim())
  if (m === null) return [0, 0, 0, []]
  const pre = m[4] === undefined ? [] : m[4].split('.')
  return [Number(m[1]), Number(m[2]), Number(m[3]), pre]
}

/** 比较两个版本号（semver，含 prerelease 规则）：a > b 返回正数，相等 0，小于负数。
 *  正式版 > 同号的任何 prerelease；prerelease 之间逐段比较，纯数字段按数值、
 *  其余按字典序，数字段排在非数字段之前。DSH 运行时以 rc 后缀发版，这里必须
 *  感知 prerelease，否则 0.1.0-rc.6 与 0.1.0-rc.7 会被判成相等。 */
export function compareVersions(a: string, b: string): number {
  const [aMaj, aMin, aPat, aPre] = parseVersion(a)
  const [bMaj, bMin, bPat, bPre] = parseVersion(b)
  for (const [x, y] of [[aMaj, bMaj], [aMin, bMin], [aPat, bPat]]) {
    if (x !== y) return x - y
  }
  if (aPre.length === 0 && bPre.length === 0) return 0
  if (aPre.length === 0) return 1
  if (bPre.length === 0) return -1
  for (let i = 0; i < Math.max(aPre.length, bPre.length); i++) {
    const x = aPre[i]
    const y = bPre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = Number(x)
    const yn = Number(y)
    const xIsNum = !Number.isNaN(xn) && /^\d+$/.test(x)
    const yIsNum = !Number.isNaN(yn) && /^\d+$/.test(y)
    if (xIsNum && yIsNum) { if (xn !== yn) return xn - yn; continue }
    if (xIsNum) return -1
    if (yIsNum) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 「跳过该版本」记录：命中后该 latest 不再提示，出现更新的版本自动恢复。
 *  由 desktop-bridge.ts 读写；旧版永久「不再提示」的标记文件也在这里识别，
 *  视为跳过一切版本（尊重老用户的选择）。 */
function skipFilePath(): string {
  return join(app.getPath('userData'), 'app-update-skip.json')
}

function legacyDismissed(): boolean {
  try {
    const obj = JSON.parse(readFileSync(skipFilePath(), 'utf8')) as { dismissed?: unknown }
    return obj.dismissed === true
  } catch {
    return false
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

/** 检测是否有比当前更新的版本；老用户曾选「不再提示」、没有更新或失败返回 undefined。 */
export async function checkForAppUpdate(): Promise<AppUpdateInfo | undefined> {
  if (legacyDismissed()) return undefined
  const release = await latestAppRelease()
  if (release === undefined) return undefined

  const current = normalizeVersion(app.getVersion())
  if (compareVersions(release.version, current) <= 0) return undefined

  return { current, latest: release.version, url: release.url }
}
