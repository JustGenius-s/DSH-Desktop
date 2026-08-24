/**
 * 插件隔离：dsh 启动失败时，从子进程输出中归因故障插件、把它从 web
 * profile 的 bundles 里摘除（禁用），并把隔离记录写到 userData 下的
 * quarantined-plugins.json，供启动成功后的提示与「恢复并重启服务」使用。
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

/** 单条错误摘要的最大长度。 */
const MAX_SUMMARY = 300

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

/** 从失败输出中截取与该插件相关的首行作为摘要。 */
function summarize(name: string, output: string): string {
  const line =
    output.split('\n').find((l) => l.includes(name)) ??
    output.trim().split('\n')[0] ??
    ''
  return line.trim().slice(0, MAX_SUMMARY)
}

export function readQuarantine(): QuarantineRecord[] {
  try {
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

/**
 * 把插件从 web profile 的 bundles 中摘除并记录隔离；返回是否实际禁用。
 * dependencies 里的 link: 条目保留：bundle 解析只遍历 bundles 列表，留着
 * 它恢复时无需重建链接。
 */
export function quarantineBundle(name: string, errorOutput: string): boolean {
  if (CORE_BUNDLES.has(name)) return false
  try {
    const pkgPath = profilePkgPath()
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const bundles = pkg.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || !bundles.includes(name)) return false
    pkg.dsh.profile.bundles = bundles.filter((b: unknown) => b !== name)
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  } catch (err) {
    console.warn(`[DSH-Desktop] 禁用插件 ${name} 失败:`, err)
    return false
  }
  const records = readQuarantine().filter((r) => r.name !== name)
  records.push({ name, disabledAt: new Date().toISOString(), errorSummary: summarize(name, errorOutput) })
  writeQuarantine(records)
  return true
}

/** 恢复：把插件加回 bundles 末尾并清除隔离记录。 */
export function restoreQuarantined(names: string[]): void {
  if (names.length === 0) return
  try {
    const pkgPath = profilePkgPath()
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    pkg.dsh ??= {}
    pkg.dsh.profile ??= {}
    const bundles: unknown[] = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
    pkg.dsh.profile.bundles = [...bundles, ...names.filter((n) => !bundles.includes(n))]
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  } catch (err) {
    console.warn('[DSH-Desktop] 恢复插件失败:', err)
    return
  }
  writeQuarantine(readQuarantine().filter((r) => !names.includes(r.name)))
}
