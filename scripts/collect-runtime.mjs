/**
 * 收集内置运行时到 runtime/：最新 node + 最新 pnpm。
 * DSH 本体不在这里收——首启由 ensureDshInstalled() 用内置 pnpm 装到 ~/.dsh/runtime。
 *
 * 依赖 node >= 18 与 tar（macOS/Windows 自带，Linux 必备）。
 */

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2] ?? join(desktopDir, 'runtime')
const binDir = join(target, 'bin')

// 默认本机平台，可经环境变量覆盖以交叉打包。
const platform = process.env.TARGET_PLATFORM ?? process.platform
const arch = process.env.TARGET_ARCH ?? process.arch
const targetId = `${platform}-${arch}` // darwin-arm64 / win32-x64 / linux-x64
const isWin = platform === 'win32'
const nodeOs = isWin ? 'win' : platform // nodejs.org 把 win32 记作 win
const nodeName = isWin ? 'node.exe' : 'node'

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

/** nodejs.org 的 index.json 已按新→旧排序，首个即最新稳定版。 */
async function latestNodeVersion() {
  const list = JSON.parse(await (await fetch('https://nodejs.org/dist/index.json')).text())
  return list[0].version
}

async function latestPnpmVersion() {
  const doc = JSON.parse(await (await fetch('https://registry.npmjs.org/pnpm')).text())
  return doc['dist-tags'].latest
}

async function fetchNode(version) {
  const ext = isWin ? 'zip' : 'tar.gz'
  const distId = `${nodeOs}-${arch}`
  const archive = join(target, `node.${ext}`)
  writeFileSync(
    archive,
    await download(`https://nodejs.org/dist/${version}/node-${version}-${distId}.${ext}`),
  )
  const extracted = join(target, `node-${version}-${distId}`)
  execFileSync('tar', ['-xf', archive, '-C', target])
  // Windows zip 把 node.exe 放在包根，tarball 放在 bin/。
  copyFileSync(join(extracted, isWin ? '.' : 'bin', nodeName), join(binDir, nodeName))
  chmodSync(join(binDir, nodeName), 0o755)
  rmSync(archive, { force: true })
  rmSync(extracted, { recursive: true, force: true })
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

/** 写 shim：dsh 内部 spawnSync('pnpm') 靠 PATH 找到它，shim 用内置 node 跑入口。 */
function writePnpmShim(entry) {
  if (isWin) {
    writeFileSync(
      join(binDir, 'pnpm.cmd'),
      `@"%~dp0${nodeName}" "%~dp0..\\pnpm\\bin\\${entry}" %*\r\n`,
    )
  } else {
    writeFileSync(
      join(binDir, 'pnpm'),
      `#!/bin/sh
exec "$(dirname "$0")/${nodeName}" "$(dirname "$0")/../pnpm/bin/${entry}" "$@"
`,
    )
    chmodSync(join(binDir, 'pnpm'), 0o755)
  }
}

rmSync(target, { recursive: true, force: true })
mkdirSync(binDir, { recursive: true })

const nodeVersion = await latestNodeVersion()
console.log(`[collect-runtime] node ${nodeVersion} (${nodeOs}-${arch})`)
await fetchNode(nodeVersion)

const pnpmVersion = await latestPnpmVersion()
console.log(`[collect-runtime] pnpm ${pnpmVersion}`)
await fetchPnpm(pnpmVersion)
await fetchPnpmNativeBinary(pnpmVersion)
writePnpmShim(resolvePnpmEntry())

console.log(`[collect-runtime] done: ${target}`)
