/**
 * 收集 pnpm 与 Node 命令转发器到 runtime/；Node 由 Electron 提供。
 * DSH 本体不在这里收——首启由 ensureDshInstalled() 用内置 pnpm 装到 ~/.dsh/runtime。
 *
 * 依赖 node >= 18 与 tar（macOS/Windows 自带，Linux 必备）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(process.argv[2] ?? join(desktopDir, 'runtime'))
const binDir = join(target, 'bin')

// 默认本机平台；Windows 转发器需要在 Windows 上编译。
const platform = process.env.TARGET_PLATFORM ?? process.platform
const arch = process.env.TARGET_ARCH ?? process.arch
const targetId = `${platform}-${arch}` // darwin-arm64 / win32-x64 / linux-x64

async function download(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

/** 下载 npm tarball，把其中的 package/ 解成 dest。 */
async function installTarball(url, dest) {
  const tgz = join(target, 'dl.tgz')
  writeFileSync(tgz, await download(url))
  execFileSync('tar', ['-xzf', tgz, '-C', target, 'package'])
  rmSync(tgz, { force: true })
  mkdirSync(dirname(dest), { recursive: true })
  rmSync(dest, { recursive: true, force: true })
  renameSync(join(target, 'package'), dest)
}

async function latestPnpmVersion() {
  const doc = JSON.parse(await (await fetch('https://registry.npmjs.org/pnpm')).text())
  return doc['dist-tags'].latest
}

async function fetchPnpm(version) {
  await installTarball(
    `https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`,
    join(target, 'pnpm'),
  )
}

/**
 * 预装 pnpm 原生二进制到 runtime/pnpm/node_modules/@pnpm/exe.<target>/。
 *
 * pnpm >= 12 的 bin/pnpm.mjs 只是 Corepack 入口，找不到这个二进制就会联网下载到
 * 包内目录；打包后的 App 在 /Applications 下只读，那必然 EPERM、更新功能作废。
 * 装好即避开下载分支。pnpm < 12 自带 JS 实现，无需二进制。
 * 注：只按 <platform>-<arch> 拼接，不覆盖 musl（Alpine）。
 */
async function fetchPnpmNativeBinary(version) {
  if (Number(version.split('.')[0]) < 12) return
  const pkg = `@pnpm/exe.${targetId}`
  const url = `https://registry.npmjs.org/${pkg.replace('/', '%2F')}/-/exe.${targetId}-${version}.tgz`
  await installTarball(url, join(target, 'pnpm', 'node_modules', ...pkg.split('/')))
}

/** 挑实际存在的入口：pnpm 12 只有 pnpm.mjs，10.x 只有 pnpm.cjs——写死会 MODULE_NOT_FOUND。 */
function resolvePnpmEntry() {
  for (const name of ['pnpm.mjs', 'pnpm.cjs']) {
    if (existsSync(join(target, 'pnpm', 'bin', name))) return name
  }
  throw new Error('pnpm tarball 里没有 bin/pnpm.mjs 或 bin/pnpm.cjs')
}

/** Windows 的 spawn('node') 需要 exe，cmd 脚本无法替代。 */
function buildWindowsLauncher() {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(arch)) {
    throw new Error('Windows Node 转发器需要在 Windows 的 MSVC x64/ARM64 Native Tools 环境中编译。')
  }
  const buildDir = mkdtempSync(join(tmpdir(), 'dsh-node-launcher-'))
  try {
    execFileSync(
      'cl.exe',
      [
        '/nologo',
        '/TC',
        '/W4',
        '/WX',
        '/O2',
        '/MT',
        join(desktopDir, 'scripts', 'node-launcher.c'),
        '/link',
        '/SUBSYSTEM:CONSOLE',
        `/MACHINE:${arch === 'x64' ? 'X64' : 'ARM64'}`,
        `/OUT:${join(binDir, 'node.exe')}`,
      ],
      { cwd: buildDir, stdio: 'inherit' },
    )
  } finally {
    rmSync(buildDir, { recursive: true, force: true })
  }
}

/** 插件的 node/pnpm 命令始终转发到本次启动的 Electron。 */
function writeCommandLaunchers(entry) {
  if (platform === 'win32') {
    buildWindowsLauncher()
    writeFileSync(
      join(binDir, 'pnpm.cmd'),
      `@"%~dp0node.exe" "%~dp0..\\pnpm\\bin\\${entry}" %*\r\n`,
    )
  } else {
    const flags = platform === 'darwin' ? ' --no-use-system-ca' : ''
    writeFileSync(
      join(binDir, 'node'),
      `#!/bin/sh
: "\${ELECTRON_NODE_EXEC_PATH:?DSH-Desktop Electron runtime is missing}"
export ELECTRON_RUN_AS_NODE=1
exec "$ELECTRON_NODE_EXEC_PATH"${flags} "$@"
`,
      { mode: 0o755 },
    )
    writeFileSync(
      join(binDir, 'pnpm'),
      `#!/bin/sh
exec "$(dirname "$0")/node" "$(dirname "$0")/../pnpm/bin/${entry}" "$@"
`,
      { mode: 0o755 },
    )
  }
}

rmSync(target, { recursive: true, force: true })
mkdirSync(binDir, { recursive: true })

const pnpmVersion = await latestPnpmVersion()
console.log(`[collect-runtime] pnpm ${pnpmVersion}`)
await fetchPnpm(pnpmVersion)
await fetchPnpmNativeBinary(pnpmVersion)
writeCommandLaunchers(resolvePnpmEntry())

console.log(`[collect-runtime] done: ${target}`)
