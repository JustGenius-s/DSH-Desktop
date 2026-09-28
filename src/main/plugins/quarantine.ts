/**
 * 插件故障归因与启用状态管理。启动失败只提供疑似插件，由用户在恢复页
 * 决定启用/禁用，并直接更新 web profile 的 bundles。
 *
 * 核心 bundle 不允许禁用。无法归因时返回空列表，恢复页仍展示原始错误。
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../runtime/paths'

/** 核心 bundle：禁用后 dsh 必然无法启动，永不隔离。 */
const CORE_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

function profilePackagePath(): string {
  return join(dshHome(), 'profiles', 'web', 'package.json')
}

/** 当前 web profile 登记的 bundle 列表；读不到返回空数组。 */
export function getProfileBundles(): string[] {
  try {
    const pkg = JSON.parse(readFileSync(profilePackagePath(), 'utf8'))
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
  const nodeModulesDir = join(dshHome(), 'profiles', 'web', 'node_modules')
  for (const name of bundles) {
    try {
      dirs.set(name, realpathSync(join(nodeModulesDir, ...name.split('/'))))
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

/**
 * 启用/禁用一个 bundle：启用时追加到 bundles 末尾（依赖里的 link: 条目保留，
 * 便于恢复时无需重建链接），禁用时从 bundles 摘除。核心 bundle 拒绝。
 * 已处于目标状态时也返回 ok，不重复写入 profile。
 */
export function setBundleEnabled(name: string, enabled: boolean): { ok: boolean; error?: string } {
  if (CORE_BUNDLES.has(name)) return { ok: false, error: `核心插件 ${name} 不可禁用` }
  try {
    const packagePath = profilePackagePath()
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
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
      return { ok: true } // 已是目标状态，无写入。
    }
    writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n')
    return { ok: true }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`[DSH-Desktop] 设置插件 ${name} ${enabled ? '启用' : '禁用'}失败:`, err)
    return { ok: false, error: detail }
  }
}

/** 插件清单视图：列出当前 profile 的 bundles，核心 bundle 恒在列表并锁定。 */
export function listPlugins(): {
  name: string
  enabled: boolean
  core: boolean
}[] {
  const bundles = getProfileBundles()
  const names = new Set<string>([...CORE_BUNDLES, ...bundles])
  return [...names].map((name) => ({
    name,
    enabled: bundles.includes(name),
    core: CORE_BUNDLES.has(name),
  }))
}
