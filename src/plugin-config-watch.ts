/**
 * 监听 web profile / 插件相关配置文件变化。
 *
 * 配置改了但正在跑的 `dsh web` 还没加载时，弹一次询问是否热重启网页服务：
 * 用户可「稍后」或「立即重启」；不关桌面壳。同一指纹只问一次，改完再问。
 */

import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { offerRestartDshWeb } from './dsh-lifecycle'
import { dshHome } from './runtime-manager'

const DEBOUNCE_MS = 600

/** 影响 web 插件加载的配置文件（相对 DSH home）。 */
const WATCHED_RELATIVE = [
  join('profiles', 'web', 'package.json'),
  join('profiles', 'web', 'cordis.patch.yml'),
  join('profiles', 'web', 'cordis.yml'),
] as const

let watchers: FSWatcher[] = []
let debounceTimer: NodeJS.Timeout | null = null
let paused = 0
let dialogOpen = false
/** 当前正在跑的网页服务所加载的配置指纹。 */
let appliedFingerprint = ''
/** 用户点「稍后」时的指纹：同一份变更不再弹。 */
let dismissedFingerprint = ''
let started = false

function profileWebDir(): string {
  return join(dshHome(), 'profiles', 'web')
}

function watchedPaths(): string[] {
  const home = dshHome()
  return WATCHED_RELATIVE.map((rel) => join(home, rel))
}

/** 读配置指纹；文件缺失当空串。 */
export function readPluginConfigFingerprint(): string {
  const parts: string[] = []
  for (const path of watchedPaths()) {
    try {
      parts.push(path + '\n' + readFileSync(path, 'utf8'))
    } catch {
      parts.push(path + '\n')
    }
  }
  return parts.join('\n---\n')
}

function scheduleCheck(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void checkAndOffer()
  }, DEBOUNCE_MS)
  debounceTimer.unref?.()
}

async function checkAndOffer(): Promise<void> {
  if (paused > 0 || dialogOpen) return
  const next = readPluginConfigFingerprint()
  if (next === appliedFingerprint) return
  if (next === dismissedFingerprint) return

  console.log('[DSH-Desktop] plugin config changed, offering restart')
  dialogOpen = true
  try {
    const restarted = await offerRestartDshWeb('plugin')
    if (restarted) {
      // 热重启成功后由 markPluginConfigApplied 刷新指纹；这里兜底一次。
      appliedFingerprint = readPluginConfigFingerprint()
      dismissedFingerprint = ''
    } else {
      // 稍后 / 失败：同一指纹不再弹，直到再改一次。
      dismissedFingerprint = next
    }
  } finally {
    dialogOpen = false
  }
}

/**
 * 标记「当前网页服务已加载这份配置」。
 * 在 boot / 热重启成功后调用；同时清掉「稍后」记录。
 */
export function markPluginConfigApplied(): void {
  appliedFingerprint = readPluginConfigFingerprint()
  dismissedFingerprint = ''
}

/** 暂停监听（安装脚本自己写配置、热重启换进程时用），返回恢复函数。 */
export function pausePluginConfigWatch(): () => void {
  paused += 1
  let released = false
  return () => {
    if (released) return
    released = true
    paused = Math.max(0, paused - 1)
  }
}

/**
 * 外部已知配置刚变了（例如安装脚本返回 restartNeeded）：走同一套去重弹窗。
 * 不会强制重启。
 */
export async function notifyPluginConfigChanged(): Promise<boolean> {
  if (dialogOpen) return false
  const next = readPluginConfigFingerprint()
  if (next === appliedFingerprint) return false
  if (next === dismissedFingerprint) return false

  dialogOpen = true
  try {
    const restarted = await offerRestartDshWeb('plugin')
    if (restarted) {
      appliedFingerprint = readPluginConfigFingerprint()
      dismissedFingerprint = ''
      return true
    }
    dismissedFingerprint = next
    return false
  } finally {
    dialogOpen = false
  }
}

function attachWatcher(path: string): void {
  try {
    if (!existsSync(path)) return
    const w = watch(path, { persistent: false }, () => {
      if (paused > 0) return
      scheduleCheck()
    })
    w.on('error', () => {
      // 文件被删重建时 watch 可能报错；下次 start 会重挂。
    })
    watchers.push(w)
  } catch {
    // 文件尚不存在等：跳过。
  }
}

/** 开始监听。幂等；应在网页服务就绪后调用。 */
export function startPluginConfigWatch(): void {
  if (started) return
  started = true
  if (appliedFingerprint === '') markPluginConfigApplied()

  // 目录级 watch：新建缺失文件也能感知；再对已有文件挂一份细粒度。
  try {
    const dir = profileWebDir()
    if (existsSync(dir)) {
      const w = watch(dir, { persistent: false }, (event, filename) => {
        if (paused > 0) return
        const name = filename === null || filename === undefined ? '' : String(filename)
        if (
          name === 'package.json' ||
          name === 'cordis.patch.yml' ||
          name === 'cordis.yml' ||
          name === ''
        ) {
          scheduleCheck()
        }
      })
      watchers.push(w)
    }
  } catch {
    // ignore
  }

  for (const path of watchedPaths()) attachWatcher(path)
}

/** 停止监听（应用退出前可选）。 */
export function stopPluginConfigWatch(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  for (const w of watchers) {
    try {
      w.close()
    } catch {
      // ignore
    }
  }
  watchers = []
  started = false
}
