/**
 * 收集桌面版内置运行时到 apps/desktop/runtime/：node + pnpm（都用最新版）。
 * 不再收集整个 monorepo 闭包——DSH 本体由首启时 `ensureDshInstalled()` 用
 * 内置 pnpm 装到 `~/.dsh/runtime`。
 *
 * 依赖：node >= 18（内置 fetch）与 `tar`（macOS/Windows 10+ 自带，Linux 必备）。
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(__dirname, '..')
const target = process.argv[2] ?? join(desktopDir, 'runtime')
const binDir = join(target, 'bin')

// 目标平台/架构：默认本机，可经 TARGET_PLATFORM / TARGET_ARCH 覆盖（交叉打包用）。
const platform = process.env.TARGET_PLATFORM ?? process.platform // darwin | win32 | linux
const arch = process.env.TARGET_ARCH ?? process.arch // arm64 | x64
const isWin = platform === 'win32'
const nodeOs = isWin ? 'win' : platform // nodejs.org 把 win32 记作 win
const nodeName = isWin ? 'node.exe' : 'node'

/** 下载并返回二进制内容。 */
async function download(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Node.js 最新稳定版号（index.json 已按新→旧排序）。 */
async function latestNodeVersion() {
  const list = JSON.parse(await (await fetch('https://nodejs.org/dist/index.json')).text())
  return list[0].version // e.g. v24.19.0
}

/**
 * 内置 pnpm 的版本范围。
 *
 * **不要改成 `latest`。** pnpm 12 起入口与原生二进制都换了形状：只剩
 * `bin/pnpm.mjs`（`pnpm.cjs` 被删除），且首次使用要**联网下载**原生二进制。
 * 对一个「首启要装 DSH 运行时」的路径来说，那个隐式网络依赖不能接受，因此
 * 这里固定在 11.x——它是最后一条 tarball 自带 JS 实现、入口完整的版本线。
 * （主进程侧已改为按实际存在的文件挑入口，见 runtime-manager.ts 的
 * `bundledPnpmEntry()`；这里固定版本是为了别把网络依赖带进打包产物。）
 * 下面的 `fetchPnpmNativeBinary()` 对 11.x 因此是空操作。
 */
const PNPM_MAJOR = 11

/** pnpm 版本号：锁定 `PNPM_MAJOR` 主版本下的最新一个，而不是 `latest`。 */
async function pinnedPnpmVersion() {
  const doc = JSON.parse(await (await fetch('https://registry.npmjs.org/pnpm')).text())
  const candidates = Object.keys(doc.versions)
    .filter((version) => version.startsWith(`${PNPM_MAJOR}.`))
    .filter((version) => version.includes('-') === false)
  if (candidates.length === 0) {
    throw new Error(`npm registry 里找不到 pnpm ${PNPM_MAJOR}.x 的稳定版本`)
  }
  // 语义化排序：逐段数值比较，避免字符串序把 11.9 排在 11.26 后面。
  candidates.sort((a, b) => {
    const left = a.split('.').map(Number)
    const right = b.split('.').map(Number)
    for (let i = 0; i < 3; i += 1) {
      if (left[i] !== right[i]) return left[i] - right[i]
    }
    return 0
  })
  return candidates[candidates.length - 1]
}

/** 下载并解出目标平台的 node 二进制到 bin/。 */
async function fetchNode(version) {
  const ext = isWin ? 'zip' : 'tar.gz'
  const distId = `${nodeOs}-${arch}` // darwin-arm64 / win-x64 / linux-x64
  const archive = join(target, `node.${ext}`)
  const url = `https://nodejs.org/dist/${version}/node-${version}-${distId}.${ext}`
  writeFileSync(archive, await download(url))

  const extracted = join(target, `node-${version}-${distId}`)
  execFileSync('tar', ['-xf', archive, '-C', target])
  // Windows zip 把 node.exe 放在包根；macOS/Linux tarball 在 bin/。
  const nodeSrc = isWin ? join(extracted, nodeName) : join(extracted, 'bin', nodeName)
  copyFileSync(nodeSrc, join(binDir, nodeName))
  chmodSync(join(binDir, nodeName), 0o755)
  rmSync(archive, { force: true })
  rmSync(extracted, { recursive: true, force: true })
}

/** 下载 pnpm tarball，整包解到 runtime/pnpm/（bin/ 与 dist/ 是一个整体，缺一不可）。 */
async function fetchPnpm(version) {
  const tgz = join(target, 'pnpm.tgz')
  writeFileSync(tgz, await download(`https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`))
  execFileSync('tar', ['-xzf', tgz, '-C', target, 'package'])
  rmSync(tgz, { force: true })
  rmSync(join(target, 'pnpm'), { recursive: true, force: true })
  renameSync(join(target, 'package'), join(target, 'pnpm'))
}

/**
 * 把 pnpm 的原生二进制放进 `runtime/pnpm/node_modules/@pnpm/exe.<platform>-<arch>/`。
 *
 * pnpm >= 12 的 `bin/pnpm.mjs` 只是 Corepack 入口：它先找这个目录里的原生二进制，
 * 找不到就**联网下载到包内同目录**。打包后的 App 在 /Applications 下受 SIP 与
 * com.apple.provenance 保护，那里不可写，于是 pnpm 每次都 EPERM 失败——更新
 * 功能在 pnpm 12 上等于作废。预先把二进制装好就不会走到下载分支。
 *
 * pnpm < 12 的 tarball 自带 JS 实现，不需要原生二进制，跳过即可。
 */
async function fetchPnpmNativeBinary(version) {
  const major = Number(version.split('.')[0])
  if (!Number.isInteger(major) || major < 12) {
    console.log(`[collect-runtime] pnpm ${version} bundles a JS CLI; no native binary needed`)
    return
  }

  const pkgName = `@pnpm/exe.${platform}-${arch}` // darwin-arm64 / win32-x64 / linux-x64
  const tgz = join(target, 'pnpm-exe.tgz')
  writeFileSync(
    tgz,
    await download(`https://registry.npmjs.org/@pnpm%2Fexe.${platform}-${arch}/-/exe.${platform}-${arch}-${version}.tgz`),
  )

  // 解到 node_modules/@pnpm/exe.<target>：pnpm 的 native-binary.mjs 正是
  // 在「包裹自己所在目录的 node_modules」里按这个名字找二进制。
  const destParent = join(target, 'pnpm', 'node_modules')
  const dest = join(destParent, ...pkgName.split('/'))
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(join(destParent, '@pnpm'), { recursive: true })
  execFileSync('tar', ['-xzf', tgz, '-C', destParent, 'package'])
  renameSync(join(destParent, 'package'), dest)
  rmSync(tgz, { force: true })
  console.log(`[collect-runtime] pnpm native binary: ${pkgName}`)
}

/**
 * pnpm 入口文件名：12.x 只有 `bin/pnpm.mjs`，11.x 两者都有，10.x 只有 `pnpm.cjs`。
 * 挑实际存在的那个，别写死——写死 `.cjs` 在 pnpm 12 上就是 MODULE_NOT_FOUND。
 */
function resolvePnpmEntry() {
  for (const name of ['pnpm.mjs', 'pnpm.cjs']) {
    if (existsSync(join(target, 'pnpm', 'bin', name))) return name
  }
  throw new Error('pnpm tarball 里找不到 bin/pnpm.mjs 或 bin/pnpm.cjs')
}

/** 写 pnpm shim：dsh 内部 spawnSync('pnpm') 靠 PATH 找到它，shim 用内置 node 跑 pnpm 入口。 */
function writePnpmShim(entry) {
  if (isWin) {
    writeFileSync(join(binDir, 'pnpm.cmd'), `@"%~dp0${nodeName}" "%~dp0..\\pnpm\\bin\\${entry}" %*\r\n`)
  } else {
    writeFileSync(join(binDir, 'pnpm'), `#!/bin/sh\nexec "$(dirname "$0")/${nodeName}" "$(dirname "$0")/../pnpm/bin/${entry}" "$@"\n`)
    chmodSync(join(binDir, 'pnpm'), 0o755)
  }
}

rmSync(target, { recursive: true, force: true })
mkdirSync(binDir, { recursive: true })

const nodeVersion = await latestNodeVersion()
console.log(`[collect-runtime] node ${nodeVersion} (${nodeOs}-${arch})`)
await fetchNode(nodeVersion)

const pnpmVersion = await pinnedPnpmVersion()
console.log(`[collect-runtime] pnpm ${pnpmVersion}（${PNPM_MAJOR}.x 固定线，非 latest）`)
await fetchPnpm(pnpmVersion)
await fetchPnpmNativeBinary(pnpmVersion)

writePnpmShim(resolvePnpmEntry())
console.log(`[collect-runtime] done: ${target}`)
