/** 内置 node / pnpm 定位、子进程 PATH 与 pnpm 执行。 */
import { app } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 内置运行时根目录：打包在 `resources/runtime`，开发模式在仓库根 `runtime/`。 */
function bundledRuntimeRoot(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(base, 'runtime')
}

/** 内置 node 可执行文件（打包时按目标平台放入 `bin/`）。 */
export function bundledNodeBin(): string {
  return join(bundledRuntimeRoot(), 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
}

/** 按实际文件选择 pnpm 入口，兼容使用 .cjs 或 .mjs 的内置版本。 */
function bundledPnpmEntry(): string {
  const bin = join(bundledRuntimeRoot(), 'pnpm', 'bin')
  const candidates =
    process.platform === 'win32' ? ['pnpm.cjs', 'pnpm.mjs'] : ['pnpm.mjs', 'pnpm.cjs']
  for (const name of candidates) {
    const entry = join(bin, name)
    if (existsSync(entry)) return entry
  }
  // 缺少入口时由 node 输出具体路径，runPnpm 会把错误尾部带回调用方。
  return join(bin, candidates[0])
}

/** 内置 `bin/` 目录：前置进子进程 PATH，让 dsh 内部的 `spawnSync('pnpm')` 找得到 pnpm。 */
function bundledBinDir(): string {
  return join(bundledRuntimeRoot(), 'bin')
}

/** 原生依赖构建使用 pnpm 自带的可执行 node-gyp shim，不依赖全局安装。 */
function bundledNodeGypBinDir(): string {
  return join(bundledRuntimeRoot(), 'pnpm', 'dist', 'node-gyp-bin')
}

/** 从常见安装位置和注册表补找 Git for Windows；找不到时保留原 PATH。 */
function findGitBinDir(env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== 'win32') return undefined
  const candidates = new Set<string>()
  const add = (base: string | undefined, ...parts: string[]) => {
    if (base) candidates.add(join(base, ...parts))
  }

  // 常见 Git for Windows / scoop 安装位置。
  add(env.ProgramFiles, 'Git', 'cmd')
  add(env['ProgramFiles(x86)'], 'Git', 'cmd')
  add(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd')
  add(env.USERPROFILE, 'scoop', 'apps', 'git', 'current', 'cmd')

  // 从注册表系统 PATH（machine + user）里抽取含 git 的目录。
  const expand = (value: string) =>
    value.replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? whole)
  const reg = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
  const keys = [
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    'HKCU\\Environment',
  ]
  for (const key of keys) {
    try {
      const result = spawnSync(reg, ['query', key, '/v', 'Path'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      if (result.status !== 0 || !result.stdout) continue
      const match = /REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(result.stdout)
      for (const raw of (match?.[1] ?? '').split(';')) {
        const dir = expand(raw.trim())
        if (/git/i.test(dir)) add(dir)
      }
    } catch {
      // 注册表不可读时，仍检查上面的常见安装位置。
    }
  }

  for (const dir of candidates) {
    if (existsSync(join(dir, 'git.exe'))) return dir
  }
  return undefined
}

/** 前置内置工具目录，保留调用方 PATH，并在 Windows 补找 Git。 */
export function withBundledBinPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isWindows = process.platform === 'win32'
  const separator = isWindows ? ';' : ':'
  const pathKeys = Object.keys(env).filter((key) =>
    isWindows ? key.toUpperCase() === 'PATH' : key === 'PATH',
  )
  const bundledDirs = [bundledBinDir(), bundledNodeGypBinDir()].filter((dir) => existsSync(dir))
  const paths = [
    ...bundledDirs,
    findGitBinDir(env),
    ...pathKeys.flatMap((key) => env[key]?.split(separator) ?? []),
  ].filter((path): path is string => typeof path === 'string' && path.trim() !== '')
  const childEnv = { ...env }
  // Windows 的环境变量不区分大小写；只传一个 PATH，避免 Node 丢掉 Path 的值。
  for (const key of pathKeys) delete childEnv[key]
  childEnv.PATH = [...new Set(paths)].join(separator)
  return childEnv
}

/** 跑一次内置 pnpm。日志接到父进程；Windows 隐藏控制台，避免打包后弹出黑窗口。 */
export function runPnpm(args: readonly string[]): Promise<void> {
  return new Promise((resolvePnpm, reject) => {
    const child = spawn(bundledNodeBin(), [bundledPnpmEntry(), ...args], {
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
    // close 在 stdout/stderr 排空后触发，确保退出错误包含最后一段诊断。
    child.on('close', (code) => {
      if (code === 0) resolvePnpm()
      else
        reject(new Error(`pnpm 退出码 ${code ?? 'null'}${tail === '' ? '' : `\n${tail.trim()}`}`))
    })
  })
}
