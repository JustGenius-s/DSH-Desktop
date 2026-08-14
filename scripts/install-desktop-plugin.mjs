#!/usr/bin/env node
/**
 * dsh-desktop-update 插件安装/卸载脚本（由 Electron 主进程调用，也可手动跑）。
 *
 * 安装策略：仅 npm——插件的唯一分发渠道是 npm registry。
 *   1. 查 npm registry 上 @just-genius/dsh-desktop-update 的最新版本；
 *      有则用内置 node+pnpm 把它装进 <DSH_HOME>/plugins/desktop-update/；
 *   2. 包尚未发布（404）则正常退出、什么都不装——下次启动重试，发布后
 *      用户重启 App 即自动装上；
 *   3. 得到带 lib/index.js + lib/client.js 的插件目录后，向
 *      ~/.dsh/profiles/web/package.json 注册（bundles + dependencies link:），
 *      并在 profile 下跑一次 pnpm install：bundle 解析走 Node 的
 *      node_modules 向上查找（resolveBundleDir），link: 条目只是元数据，
 *      必须物化成 profile node_modules 里的符号链接才会被解析到；最后为
 *      插件安装目录补 host 半侧运行时依赖的符号链接。
 *
 * 卸载只做注册移除；插件文件保留，重新安装时秒回。
 * 全部操作幂等：重复执行结果一致，中途失败留下可重试的状态。
 *
 * 用法：
 *   node install-desktop-plugin.mjs install [--home <DSH_HOME>]
 *   node install-desktop-plugin.mjs uninstall [--home <DSH_HOME>]
 *
 * 退出码：0 成功/已到位/包未发布跳过；1 失败（消息在 stderr，主进程记日志即可）。
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_NAME = '@just-genius/dsh-desktop-update'
const PLUGINS_DIR_NAME = 'plugins'
const INSTALL_DIR_NAME = 'desktop-update'
/** 宿主 App 要求的最小插件版本；已装版本 >= 它时跳过安装。 */
const REQUIRED_VERSION = '0.1.0'
/** 单个网络/安装动作的超时。 */
const ACTION_TIMEOUT_MS = 120_000
/** 读取版本所用的 dist-tag（0.1.1 起正式版在 latest；beta 期曾用 'beta'）。 */
const DIST_TAG = 'latest'

const args = process.argv.slice(2)
const command = args[0]

function opt(name) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : undefined
}

function fail(message) {
  console.error('[install-desktop-plugin] ' + message)
  process.exit(1)
}

if (command !== 'install' && command !== 'uninstall') {
  fail('用法: install-desktop-plugin.mjs install|uninstall [--home <dir>]')
}

const dshHome = opt('home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const pluginsDir = join(dshHome, PLUGINS_DIR_NAME)
const installDir = join(pluginsDir, INSTALL_DIR_NAME)
const profilePkgPath = join(dshHome, 'profiles', 'web', 'package.json')

/** 脚本位于 <app>/scripts/；内置 node/pnpm 在同级 runtime/ 下（打包时同为 resources 子目录）。 */
const scriptDir = dirname(fileURLToPath(import.meta.url))
const runtimeRoot = join(scriptDir, '..', 'runtime')
const nodeBin = join(runtimeRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
const pnpmCjs = join(runtimeRoot, 'pnpm', 'bin', 'pnpm.cjs')
const bundledBinDir = join(runtimeRoot, 'bin')

if (!existsSync(nodeBin) || !existsSync(pnpmCjs)) {
  fail('内置运行时缺失（' + runtimeRoot + '）；开发模式请先 npm run collect')
}

function run(cmd, cmdArgs, timeoutMs) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, cmdArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: bundledBinDir + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? ''),
        // 所有 pnpm 动作统一走官方源（本机默认可能是镜像；pack 子命令不支持
        // --registry 选项，env 是唯一一致的传递方式）。
        npm_config_registry: 'https://registry.npmjs.org/',
      },
    })
    let stderr = ''
    child.stderr?.on('data', (c) => { stderr += c.toString() })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(cmd + ' ' + cmdArgs.join(' ') + ' 超时'))
    }, timeoutMs ?? ACTION_TIMEOUT_MS)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveRun()
      else reject(new Error(cmd + ' ' + cmdArgs.join(' ') + ' 退出码 ' + code + ': ' + stderr.trim().slice(0, 300)))
    })
  })
}

function pnpm(pnpmArgs, timeoutMs) {
  return run(nodeBin, [pnpmCjs, ...pnpmArgs], timeoutMs)
}
/** 解析 semver：返回 [major, minor, patch, prerelease 数组]（无 prerelease 为空数组）。 */
function parseVersion(v) {
  const m = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim())
  if (m === null) return [0, 0, 0, []]
  const pre = m[4] === undefined ? [] : m[4].split('.')
  return [Number(m[1]), Number(m[2]), Number(m[3]), pre]
}

/** semver 比较（含 prerelease 规则：有 prerelease < 同版本正式版；逐段数值/字典序）。 */
function compareVersions(a, b) {
  const [aMaj, aMin, aPat, aPre] = parseVersion(a)
  const [bMaj, bMin, bPat, bPre] = parseVersion(b)
  for (const [x, y] of [[aMaj, bMaj], [aMin, bMin], [aPat, bPat]]) {
    if (x !== y) return x - y
  }
  if (aPre.length === 0 && bPre.length === 0) return 0
  if (aPre.length === 0) return 1 // 正式版 > 任何 prerelease
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

/** 已安装且构建完整的插件版本；未安装/不完整返回 undefined。 */
function installedPluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8'))
    if (pkg.name !== PLUGIN_NAME || typeof pkg.version !== 'string') return undefined
    if (!existsSync(join(installDir, 'lib', 'client.js'))) return undefined
    return pkg.version
  } catch {
    return undefined
  }
}

/** 查 npm 上插件最新版本；未发布/网络失败返回 undefined。 */
async function latestPluginVersion() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch('https://registry.npmjs.org/' + PLUGIN_NAME.replace('/', '%2F'), {
      signal: controller.signal,
      headers: { 'User-Agent': 'DSH-Desktop' },
    })
    if (!res.ok) return undefined
    const body = await res.json()
    const v = body?.['dist-tags']?.[DIST_TAG]
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** npm 路线：直接从 registry 拉 tarball（pnpm pack <pkg> 语义不对——它打包的是
 *  当前目录而非目标包），解出插件本体到安装目录（不保留 node_modules 布局依赖）。 */
async function installFromNpm(version) {
  const spec = PLUGIN_NAME + '@' + version
  // 先读包文档拿 tarball URL（dist.tarball 是权威入口，避免猜文件名规则）。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  let tarballUrl
  try {
    const res = await fetch('https://registry.npmjs.org/' + PLUGIN_NAME.replace('/', '%2F'), {
      signal: controller.signal,
      headers: { 'User-Agent': 'DSH-Desktop' },
    })
    if (!res.ok) throw new Error('包文档拉取失败：HTTP ' + res.status)
    const doc = await res.json()
    tarballUrl = doc?.versions?.[version]?.dist?.tarball
    if (typeof tarballUrl !== 'string') throw new Error('包文档缺 dist.tarball（' + spec + '）')
  } finally {
    clearTimeout(timer)
  }

  const tmp = join(pluginsDir, '.tmp-desktop-update-' + Date.now())
  mkdirSync(tmp, { recursive: true })
  try {
    const tgzPath = join(tmp, 'pkg.tgz')
    const dl = await fetch(tarballUrl, { headers: { 'User-Agent': 'DSH-Desktop' } })
    if (!dl.ok) throw new Error('tarball 下载失败：HTTP ' + dl.status)
    writeFileSync(tgzPath, Buffer.from(await dl.arrayBuffer()))
    const extractDir = join(tmp, 'x')
    mkdirSync(extractDir, { recursive: true })
    await run('tar', ['-xzf', tgzPath, '-C', extractDir])
    const pkgRoot = join(extractDir, 'package')
    if (!existsSync(join(pkgRoot, 'lib', 'client.js'))) {
      throw new Error('npm 包 ' + spec + ' 缺少 lib/client.js')
    }
    rmSync(installDir, { recursive: true, force: true })
    mkdirSync(pluginsDir, { recursive: true })
    cpSync(pkgRoot, installDir, { recursive: true })
    return version
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** 向 web profile 注册/注销插件（幂等）。 */
function setRegistration(enabled) {
  if (!existsSync(profilePkgPath)) {
    if (enabled) throw new Error('profile 未初始化（' + profilePkgPath + ' 不存在）——请先启动一次 DSH')
    return
  }
  const pkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  const deps = typeof pkg.dependencies === 'object' && pkg.dependencies !== null ? pkg.dependencies : {}
  const link = 'link:' + installDir
  const hasBundle = bundles.includes(PLUGIN_NAME)
  const hasDep = deps[PLUGIN_NAME] === link

  if (enabled) {
    if (hasBundle && hasDep) return false
    pkg.dsh.profile.bundles = hasBundle ? bundles : [...bundles, PLUGIN_NAME]
    pkg.dependencies = { ...deps, [PLUGIN_NAME]: link }
  } else {
    if (!hasBundle && !(PLUGIN_NAME in deps)) return false
    pkg.dsh.profile.bundles = bundles.filter((b) => b !== PLUGIN_NAME)
    const nextDeps = { ...deps }
    delete nextDeps[PLUGIN_NAME]
    pkg.dependencies = nextDeps
  }
  writeFileSync(profilePkgPath, JSON.stringify(pkg, null, 2) + '\n')
  return true // 发生了变更
}

/** 在 profile 下跑 pnpm install，把 link: 依赖物化成 node_modules 符号链接。
 *  profile 自带 pnpm-workspace.yaml（nodeLinker: hoisted、autoInstallPeers: false），
 *  link 目标无 node_modules 时安装是秒级的纯链接操作。 */
async function materializeProfileLinks() {
  const profileDir = join(dshHome, 'profiles', 'web')
  if (!existsSync(join(profileDir, 'pnpm-workspace.yaml'))) {
    throw new Error('profile 缺 pnpm-workspace.yaml（' + profileDir + '）——无法安全地 pnpm install')
  }
  await pnpm(['--dir', profileDir, 'install', '--no-frozen-lockfile', '--prefer-offline'], 180_000)
}

/** 为安装目录补 host 半侧的运行时依赖符号链接。
 *  插件被复制到 <DSH_HOME>/plugins/desktop-update 后脱离原工作区，其
 *  dependencies（@deepseek-ai/dsh-settings、@deepseek-ai/schemastery 等）
 *  在自身向上查找链里不存在；而 Loader 从 profile 目录 import 插件时，插件
 *  自己的 import 以插件目录为锚点解析——必须自带 node_modules。
 *  链接目标取自 profile 的解析锚点（healProfilesModuleFallback 会把 dsh 安装
 *  树里所有包铺到 profiles/node_modules），保证与宿主同一份实现、零下载。 */
async function linkHostDeps() {
  const { createRequire } = await import('node:module')
  const anchor = createRequire(join(dshHome, 'profiles', 'web', 'package.json'))
  const pkg = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8'))
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) }
  const nmDir = join(installDir, 'node_modules')
  for (const name of Object.keys(deps)) {
    const link = join(nmDir, ...name.split('/'))
    if (existsSync(join(link, 'package.json'))) continue
    let target
    try {
      target = dirname(anchor.resolve(name + '/package.json'))
    } catch {
      console.warn('[install-desktop-plugin] 警告：无法从 profile 锚点解析 ' + name + '（host 半侧 import 可能失败）')
      continue
    }
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link, 'dir')
  }
}

if (command === 'uninstall') {
  if (setRegistration(false)) await materializeProfileLinks()
  console.log('[install-desktop-plugin] 已从 web profile 注销（插件文件保留）')
  process.exit(0)
}

// ---- install ----
const installed = installedPluginVersion()

try {
  if (installed !== undefined && compareVersions(installed, REQUIRED_VERSION) >= 0) {
    const changed = setRegistration(true)
    // 注册没变化也要兜底：链接缺失（pnpm install 没跑过/被清）同样致命。
    const linkExists = existsSync(join(dshHome, 'profiles', 'web', 'node_modules', ...PLUGIN_NAME.split('/'), 'package.json'))
    if (changed || !linkExists) await materializeProfileLinks()
    await linkHostDeps()
    console.log('[install-desktop-plugin] 已安装 ' + installed + '，注册已确认')
    process.exit(0)
  }

  const latest = await latestPluginVersion()
  if (latest === undefined) {
    // 包尚未发布（或 registry 暂不可达）：不算失败——下次启动重试，发布后自动装上。
    console.log('[install-desktop-plugin] npm 上尚无 ' + PLUGIN_NAME + '，跳过安装（下次启动重试）')
    process.exit(0)
  }
  if (compareVersions(latest, REQUIRED_VERSION) < 0) {
    console.log('[install-desktop-plugin] npm 最新版 ' + latest + ' 低于要求的 ' + REQUIRED_VERSION + '，跳过安装')
    process.exit(0)
  }

  console.log('[install-desktop-plugin] 从 npm 安装 ' + PLUGIN_NAME + '@' + latest + ' …')
  const version = await installFromNpm(latest)

  setRegistration(true)
  await materializeProfileLinks()
  await linkHostDeps()
  console.log('[install-desktop-plugin] 安装完成：' + PLUGIN_NAME + '@' + version + ' → ' + installDir + '（重启 DSH 生效）')
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
