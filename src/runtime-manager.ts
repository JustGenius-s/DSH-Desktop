/**
 * 外置 DSH 运行时管理：内置 node + pnpm，把 `@deepseek-ai/dsh` 装到
 * `~/.dsh/runtime`，并支持自动检测 / 手动触发升级。DSH 升级从此只走
 * pnpm，不再重打包、重签名桌面版。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, session } from 'electron'

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

/**
 * 内置 pnpm 入口（整包解到 runtime/pnpm/：bin/ 与 dist/ 是一个整体，缺一不可）。
 *
 * 入口文件名随 pnpm 大版本变过，这里按实际存在的文件挑，不写死某一个：
 *   - pnpm 10.x：`bin/pnpm.cjs`（唯一的入口，纯 JS 实现）
 *   - pnpm 11.x：`.cjs` 与 `.mjs` 并存（`.cjs` 只是 `import('./pnpm.mjs')` 的壳）
 *   - pnpm 12.x：**只有** `bin/pnpm.mjs`，`.cjs` 已被移除
 * 写死 `.cjs` 会在 pnpm 12 上直接 MODULE_NOT_FOUND，更新必然失败（第 12 版起
 * 壳里报的 `pnpm 退出码 1` 就是它）。
 */
function bundledPnpmEntry(): string {
  const bin = join(bundledRuntimeRoot(), 'pnpm', 'bin')
  const candidates =
    process.platform === 'win32'
      ? ['pnpm.cjs', 'pnpm.mjs']
      : // Unix 上 .mjs 优先：pnpm 12 只有它；11.x 上两者等价。
        ['pnpm.mjs', 'pnpm.cjs']
  for (const name of candidates) {
    const entry = join(bin, name)
    if (existsSync(entry)) return entry
  }
  // 一个都没有时仍返回首选路径：让 spawn 抛出可诊断的错误，而不是这里抛。
  return join(bin, candidates[0])
}

/** 内置 `bin/` 目录：前置进子进程 PATH，让 dsh 内部的 `spawnSync('pnpm')` 找得到 pnpm。 */
function bundledBinDir(): string {
  return join(bundledRuntimeRoot(), 'bin')
}

/**
 * pnpm 自带的 `node-gyp` shim 目录（`runtime/pnpm/dist/node-gyp-bin`）。
 *
 * 必须进 PATH：`fs-ext` 这类原生依赖的安装脚本直接跑 `node-gyp configure build`，
 * 而桌面版常常在没有全局 node-gyp 的机器上运行，脚本会以 127（command not found）
 * 失败，整个 `pnpm add` 报 ERR_PNPM_EXECUTOR_LIFECYCLE_SCRIPT_FAILED。
 *
 * 选 `node-gyp-bin` 而不是 `dist/node_modules/.bin`：后者的 shim 在 pnpm 发布的
 * tarball 里就没有执行位（644），直接执行是 126 Permission denied。这里两个
 * shim 都是 pnpm 10→12 一直存在、且带执行位的可执行脚本，Windows 侧还有 `.cmd`。
 */
function bundledNodeGypBinDir(): string {
  return join(bundledRuntimeRoot(), 'pnpm', 'dist', 'node-gyp-bin')
}

/**
 * 定位 Git for Windows 的 `cmd` 目录（`git.exe` 所在处）。子进程母体的 PATH
 * 可能被裁剪到只剩内置 `bin/`（不含 git），导致 dsh host 里 git 面板
 * `spawn('git')` 报 ENOENT。这里从常见安装位置 + 注册表系统 PATH 兜底探测。
 * 找不到返回 undefined（此时保持旧行为）。
 */
function findGitBinDir(): string | undefined {
  const candidates = new Set<string>()
  const add = (dir: string | undefined) => {
    if (dir) candidates.add(dir)
  }

  // 常见 Git for Windows / scoop 安装位置。
  add(join(process.env.ProgramFiles ?? '', 'Git', 'cmd'))
  add(join(process.env['ProgramFiles(x86)'] ?? '', 'Git', 'cmd'))
  add(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'cmd'))
  add(join(process.env.USERPROFILE ?? '', 'scoop', 'apps', 'git', 'current', 'cmd'))

  // 从注册表系统 PATH（machine + user）里抽取含 git 的目录。
  const expand = (value: string) =>
    value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole)
  if (process.platform === 'win32') {
    const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
    const keys = [
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
      'HKCU\\Environment',
    ]
    for (const key of keys) {
      try {
        const res = spawnSync(reg, ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true })
        if (res.status !== 0 || !res.stdout) continue
        const m = /REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(res.stdout)
        for (const raw of (m?.[1] ?? '').split(';')) {
          const dir = expand(raw.trim())
          if (/git/i.test(dir)) add(dir)
        }
      } catch {
        // 读取失败不影响：下面用常见路径兜底。
      }
    }
  }

  for (const dir of candidates) {
    if (existsSync(join(dir, 'git.exe'))) return dir
  }
  return undefined
}

/** 把内置 `bin/` 与 pnpm 的 `node-gyp` 目录前置进 PATH，并确保 git 可用。 */
export function withBundledBinPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':'
  const bundledDirs = [bundledBinDir(), bundledNodeGypBinDir()].filter((dir) => existsSync(dir))
  const parts = [...bundledDirs, findGitBinDir(), env.PATH].filter(
    (p): p is string => typeof p === 'string' && p.trim() !== '',
  )
  return { ...env, PATH: [...new Set(parts)].join(sep) }
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
    const child: ChildProcess = spawn(bundledNodeBin(), [bundledPnpmEntry(), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // node 与 node-gyp 都要进 PATH：pnpm 跑原生依赖的构建脚本时依赖它们。
      env: withBundledBinPath(process.env),
    })
    // 留住最后几行输出：pnpm 自己会把原因打到 stderr（MODULE_NOT_FOUND、
    // EPERM、构建脚本失败…），只报退出码的话在界面上完全无法诊断。
    let tail = ''
    const remember = (chunk: Buffer) => {
      const text = chunk.toString()
      process.stderr.write(text)
      tail = (tail + text).slice(-800)
    }
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk))
    child.stderr?.on('data', remember)
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolvePnpm()
      else reject(new Error(`pnpm 退出码 ${code ?? 'null'}${tail === '' ? '' : `\n${tail.trim()}`}`))
    })
  })
}

/** 安装/升级统一走官方源，避免本机镜像 dist-tags 滞后装到坏版本。
 *  注意：这里只做「首装取最新」与「按指定版本安装」；「哪个渠道有更新」
 *  的判断属于 dsh-desktop-update 插件 host 半侧的检测器，不在壳里。 */
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

/**
 * 查 npm registry 上 `@deepseek-ai/dsh` 的 `latest` 版本；失败返回 undefined。
 * 仅供首装使用——「哪个渠道有更新、该不该提示」属于插件 host 半侧的检测器。
 */
async function latestDshVersion(): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    // session.fetch 走 Chromium 栈，不触发 Node TLS，绕开打包版 SetRootCerts 崩溃。
    const res = await session.defaultSession.fetch(
      'https://registry.npmjs.org/@deepseek-ai%2Fdsh',
      { signal: controller.signal },
    )
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

/** 升级到指定版本。目标版本由调用方（插件）给出，壳不判断哪个版本该装。 */
export async function updateDsh(
  version: string,
  onStatus?: (message: string) => void,
): Promise<void> {
  onStatus?.(`正在通过 pnpm 安装 @deepseek-ai/dsh@${version}…（约需 1–2 分钟）`)
  await runPnpm(installDshArgs(runtimeDir(), version))
  onStatus?.('安装完成，正在校验…')
}
