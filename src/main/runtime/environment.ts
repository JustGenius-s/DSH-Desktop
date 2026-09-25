/** 内置 node / pnpm 定位、子进程 PATH 与 pnpm 执行。 */
import { app } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
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
        const res = spawnSync(reg, ['query', key, '/v', 'Path'], {
          encoding: 'utf8',
          windowsHide: true,
        })
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

/** 跑一次内置 pnpm。日志接到父进程；Windows 隐藏控制台，避免打包后弹出黑窗口。 */
export function runPnpm(args: readonly string[]): Promise<void> {
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
      else
        reject(new Error(`pnpm 退出码 ${code ?? 'null'}${tail === '' ? '' : `\n${tail.trim()}`}`))
    })
  })
}
