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
 * **不要改成 `latest`。** 应用主进程硬编码了 `pnpm/bin/pnpm.cjs`
 * （`src/runtime-manager.ts` 的 `bundledPnpmCjs()`），而该入口在 pnpm 12 里
 * 被删除了：12 只发布 `bin/pnpm.mjs`，它会在首次使用时**联网下载**原生
 * 二进制。对一个「首启要装 DSH 运行时」的路径来说，那个隐式网络依赖不能接受，
 * 且 `pnpm.cjs` 缺失会让 `ensureDshInstalled()` 直接 MODULE_NOT_FOUND。
 * 11.x 两个入口都有，是最后一个能静态内置的版本线。
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
 * 断言内置 pnpm 真的能跑：应用主进程只会用「内置 node + bin/pnpm.cjs」这一条
 * 路径装 DSH，缺了入口的包在用户首启时才会炸。这里提前在打包阶段拦住。
 *
 * 两个坑：
 *
 * 1. **必须真的执行一次**，不能只查文件存在：pnpm 12 自带的 `pnpm.mjs` 需要
 *    联网下载原生二进制，文件在也不等于能用。
 * 2. **必须把 `--dir` 指向自己**（或任一没有 `packageManager` 字段的目录）。
 *    11.x 的 `bin/pnpm.cjs` 是个 Corepack 式转发器，会根据「目标目录向上
 *    找到的 `packageManager` 字段」切换成另一个 pnpm。本仓根目录写的是
 *    `pnpm@10.30.3`，所以不带 `--dir` 跑会打印 10.30.3 —— 那是它正确地转发
 *    到另一个版本，不是内置副本坏了。应用自己的调用带 `--dir ~/.dsh/runtime`
 *    （那边没有该字段），不受影响。
 *
 * @param version - 本次解出的 pnpm 版本，用于校验输出。
 */
function assertPnpmRunnable(version) {
  const pnpmDir = join(target, 'pnpm')
  const entry = join(pnpmDir, 'bin', 'pnpm.cjs')
  if (!existsSync(entry)) {
    throw new Error(
      `内置 pnpm ${version} 缺少 bin/pnpm.cjs（应用硬编码的入口）。` +
        `pnpm 12 起不再发布该文件，请检查 collect-runtime.mjs 的 PNPM_MAJOR。`,
    )
  }
  const output = execFileSync(join(binDir, nodeName), [entry, '--dir', pnpmDir, '--version'], {
    encoding: 'utf8',
  }).trim()
  if (output !== version) {
    throw new Error(`内置 pnpm 自检失败：期望 ${version}，实际输出 ${output}`)
  }
  return output
}

/** 写 pnpm shim：dsh 内部 spawnSync('pnpm') 靠 PATH 找到它，shim 用内置 node 跑 pnpm.cjs。 */
function writePnpmShim() {
  if (isWin) {
    writeFileSync(join(binDir, 'pnpm.cmd'), `@"%~dp0${nodeName}" "%~dp0..\\pnpm\\bin\\pnpm.cjs" %*\r\n`)
  } else {
    writeFileSync(join(binDir, 'pnpm'), `#!/bin/sh\nexec "$(dirname "$0")/${nodeName}" "$(dirname "$0")/../pnpm/bin/pnpm.cjs" "$@"\n`)
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
console.log(`[collect-runtime] pnpm 自检通过：${assertPnpmRunnable(pnpmVersion)}`)

writePnpmShim()
console.log(`[collect-runtime] done: ${target}`)
