/**
 * 插件隔离：dsh 启动失败时，从子进程输出中归因故障插件、把它从 web
 * profile 的 bundles 里摘除（禁用），并把隔离记录写到 userData 下的
 * quarantined-plugins.json，供启动成功后的提示与「恢复并重启」使用。
 *
 * 只隔离能明确归因的第三方 bundle；@deepseek-ai/* 核心 bundle 永远不动
 * （禁了 dsh 更起不来）。归因不到时 extractFailedPlugins 返回空，由
 * 调用方走原来的报错退出路径。
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

/** 核心 bundle：禁用后 dsh 必然无法启动，永不隔离。 */
const CORE_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
])

export interface QuarantineRecord {
  name: string
  disabledAt: string
  errorSummary: string
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function profilePkgPath(): string {
  return join(dshHome(), 'profiles', 'web', 'package.json')
}

function quarantineFilePath(): string {
  return join(app.getPath('userData'), 'quarantined-plugins.json')
}

/** 当前 web profile 登记的 bundle 列表；读不到返回空数组。 */
export function getProfileBundles(): string[] {
  try {
    const pkg = JSON.parse(readFileSync(profilePkgPath(), 'utf8'))
    const bundles = pkg.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles.filter((b: unknown) => typeof b === 'string') : []
  } catch {
    return []
  }
}

/**
 * 各 bundle 的真实安装目录（profile node_modules 符号链接解析后）。
 * 堆栈里的文件路径是真实目录而非带 scope 的包名路径（Node 默认解
 * symlink），路径反推必须拿这个目录去匹配。
 */
function bundleRealDirs(bundles: string[]): Map<string, string> {
  const dirs = new Map<string, string>()
  const nm = join(dshHome(), 'profiles', 'web', 'node_modules')
  for (const name of bundles) {
    try {
      dirs.set(name, realpathSync(join(nm, ...name.split('/'))))
    } catch {
      // 链接缺失时该插件只剩名字匹配可用。
    }
  }
  return dirs
}

/**
 * 从 dsh 失败输出中提取可归因的第三方插件名。覆盖 dsh-app-boot 的四种
 * 报错形态：
 *   1. loadProfile 阶段：`cannot resolve profile bundle "<名字>"`；
 *   2. 插件解析失败：`plugin(s) failed to load: <名字, ...>`；
 *   3. 激活审计失败：`N entries did not activate\n<entry 名>: <堆栈>`，
 *      entry 名不是 bundle 名时在该条堆栈块内按真实安装路径反推所属 bundle；
 *   4. 晚期 rejection：`fatal load failure: <堆栈>`（不带名字，仅此时
 *      在整个尾部按包名/真实路径反推）。
 * 只返回仍在 profile bundles 里的第三方包名，其余视为不可归因。
 */
export function extractFailedPlugins(output: string, bundles: string[]): string[] {
  const thirdParty = bundles.filter((b) => !CORE_BUNDLES.has(b))
  if (thirdParty.length === 0 || output.length === 0) return []
  const found = new Set<string>()
  const realDirs = bundleRealDirs(thirdParty)
  const matchesBundle = (name: string, text: string): boolean => {
    const dir = realDirs.get(name)
    return text.includes(name) || (dir !== undefined && text.includes(dir))
  }

  for (const m of output.matchAll(/cannot resolve profile bundle "([^"]+)"/g)) {
    found.add(m[1])
  }
  for (const m of output.matchAll(/plugin\(s\) failed to load: ([^;\n]+)/g)) {
    for (const name of m[1].split(',')) found.add(name.trim())
  }

  const activateIdx = output.indexOf('did not activate')
  if (activateIdx >= 0) {
    // 每条失败 entry 占一个块：首行是「名字: 错误」，后续缩进行是它的堆栈。
    const blocks: string[][] = []
    for (const line of output.slice(activateIdx).split('\n').slice(1)) {
      if (/^(@?[\w.-]+(?:\/[\w.-]+)?): /.test(line)) {
        blocks.push([line])
      } else if (blocks.length > 0) {
        blocks[blocks.length - 1].push(line)
      }
    }
    for (const block of blocks) {
      const header = /^(@?[\w.-]+(?:\/[\w.-]+)?): /.exec(block[0])?.[1]
      if (header !== undefined && thirdParty.includes(header)) {
        found.add(header)
        continue
      }
      const text = block.join('\n')
      for (const name of thirdParty) {
        if (matchesBundle(name, text)) {
          found.add(name)
          break
        }
      }
    }
  }

  const fatalIdx = output.lastIndexOf('fatal load failure')
  if (fatalIdx >= 0) {
    const tail = output.slice(fatalIdx)
    for (const name of thirdParty) {
      if (matchesBundle(name, tail)) found.add(name)
    }
  }

  return [...found].filter((n) => thirdParty.includes(n))
}

export function readQuarantine(): QuarantineRecord[] {  try {
    const data: unknown = JSON.parse(readFileSync(quarantineFilePath(), 'utf8'))
    if (!Array.isArray(data)) return []
    return data.filter(
      (r): r is QuarantineRecord =>
        typeof r === 'object' && r !== null && typeof (r as QuarantineRecord).name === 'string',
    )
  } catch {
    return []
  }
}

function writeQuarantine(records: QuarantineRecord[]): void {
  try {
    writeFileSync(quarantineFilePath(), JSON.stringify(records, null, 2) + '\n')
  } catch (err) {
    console.warn('[DSH-Desktop] 写入隔离记录失败:', err)
  }
}

export function isQuarantined(name: string): boolean {
  return readQuarantine().some((r) => r.name === name)
}

/** 清空全部隔离记录（保持 bundles 现状，不重新启用任何插件）。 */
export function clearQuarantine(): void {
  writeQuarantine([])
}

/**
 * 启用/禁用一个 bundle：启用时追加到 bundles 末尾（依赖里的 link: 条目保留，
 * 便于恢复时无需重建链接），禁用时从 bundles 摘除。核心 bundle 拒绝。
 * 桌面端自带插件（DESKTOP_OWNED）禁用时额外落一条隔离记录——安装脚本
 * （plugin-installer）靠它识别「用户已禁用」，否则下次启动会重新登记回来。
 * @returns 是否实际写入了配置。
 */
export function setBundleEnabled(name: string, enabled: boolean): { ok: boolean; error?: string } {
  if (CORE_BUNDLES.has(name)) return { ok: false, error: `核心插件 ${name} 不可禁用` }
  try {
    const pkgPath = profilePkgPath()
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    pkg.dsh ??= {}
    pkg.dsh.profile ??= {}
    const bundles: unknown[] = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
    const names = bundles.filter((b): b is string => typeof b === 'string')
    const present = names.includes(name)
    if (enabled && !present) {
      pkg.dsh.profile.bundles = [...names, name]
    } else if (!enabled && present) {
      pkg.dsh.profile.bundles = names.filter((b) => b !== name)
    } else {
      syncDisabledMark(name, enabled)
      return { ok: true } // 已是目标状态，无写入。
    }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    syncDisabledMark(name, enabled)
    return { ok: true }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`[DSH-Desktop] 设置插件 ${name} ${enabled ? '启用' : '禁用'}失败:`, err)
    return { ok: false, error: detail }
  }
}

/** 桌面端自带插件（在 bundles 之外也登记了 link: 依赖）的目录清单。 */
const DESKTOP_OWNED = new Set(['@just-genius/dsh-desktop-update'])

/** 桌面端自带插件禁用时落/清隔离记录，让安装脚本不再自动重新登记。 */
function syncDisabledMark(name: string, enabled: boolean): void {
  if (!DESKTOP_OWNED.has(name)) return
  const records = readQuarantine().filter((r) => r.name !== name)
  if (!enabled) {
    records.push({ name, disabledAt: new Date().toISOString(), errorSummary: '用户已在插件列表禁用' })
  }
  writeQuarantine(records)
}

/**
 * 插件清单视图：bundles 里的是启用态；桌面端自带插件即使不在 bundles 里
 * 也列出（禁用态），让用户能重新启用。核心 bundle 恒在列表并锁定。
 */
export function listPlugins(): { name: string; enabled: boolean; core: boolean; desktopOwned: boolean }[] {
  const bundles = getProfileBundles()
  const names = new Set<string>([...CORE_BUNDLES, ...bundles, ...DESKTOP_OWNED])
  return [...names].map((name) => ({
    name,
    enabled: bundles.includes(name),
    core: CORE_BUNDLES.has(name),
    desktopOwned: DESKTOP_OWNED.has(name),
  }))
}
