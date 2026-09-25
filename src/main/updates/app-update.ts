/**
 * 应用本体更新检测：查 GitHub Releases 是否有比当前版本更新的发布。
 * 检测结果由 updates/bridge.ts 聚合，交给应用菜单展示。
 * DSH 运行时安装由 runtime/installation.ts 负责；本模块只检测桌面 App
 * 自己的版本并提供下载页，不做静默自动安装。
 */

import { app, session } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions } from '../../shared/version'

/**
 * GitHub Releases 的 latest 网页地址（非 REST API）。它 302 跳转到
 * `/releases/tag/vX.Y.Z`，从 Location 头即可解析版本号。
 * 不用 `api.github.com` 的原因：REST API 未认证限流 60 次/小时/来源 IP，
 * 企业 NAT / 共享出口下容易被打满导致检测静默失败；网页端点无此限制，
 * 行为一致（draft 404、prerelease 不算 latest）。
 */
export const APP_RELEASES_URL = 'https://github.com/JustGenius-s/DSH-Desktop/releases/latest'

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

/** 兼容旧版永久「不再提示」的标记文件，尊重老用户的选择。 */
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
async function latestAppRelease(): Promise<{ version: string; url: string } | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    // redirect:'manual' 拿到 302 的 Location，不跟随跳转（省一次整页下载）。
    // session.fetch 走 Chromium 栈，不触发 Node TLS，绕开打包版 SetRootCerts 崩溃。
    const res = await session.defaultSession.fetch(APP_RELEASES_URL, {
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
