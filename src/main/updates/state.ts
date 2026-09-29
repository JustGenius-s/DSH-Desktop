/**
 * 更新检测结果状态。
 *
 * 单独成文件是为了断开 updates/bridge（检测 + IPC）与 menus/seats（菜单）
 * 之间的循环依赖：两边都只依赖本模块。
 */

import { app } from 'electron'
import { installedDshVersion } from '../runtime/installation'

/** 最近一次检测结果：有新版本时为该版本号，否则 null。 */
let result: { app: string | null; dsh: string | null } = { app: null, dsh: null }

/**
 * DSH 运行时是否正在安装。
 *
 * pnpm 装一次要一两分钟，这段时间内菜单必须显示进度并禁用入口——否则点下去没有
 * 任何反馈，用户只会以为菜单坏了。
 */
let dshUpdating = false

/**
 * 已装好、但还没生效的运行时版本。
 *
 * 装完新运行时后用户可能选「稍后」不重启服务，此时磁盘上已经是新版、跑着的还是
 * 旧版。记下这个版本，菜单才不会把已经装好的更新再推荐一遍。
 */
let dshPendingRestart: string | null = null

export function setUpdateResult(next: { app: string | null; dsh: string | null }): void {
  result = next
}

export function clearDshUpdate(): void {
  result = { ...result, dsh: null }
}

export function setDshUpdating(next: boolean): void {
  dshUpdating = next
}

export function setDshPendingRestart(version: string): void {
  dshPendingRestart = version
}

export function clearDshPendingRestart(): void {
  dshPendingRestart = null
}

/** 当前版本 + 有无更新 + 安装是否在进行，给菜单拼文案用。 */
export function updateSummary(): {
  app: string
  dsh: string | null
  appUpdate: string | null
  dshUpdate: string | null
  dshUpdating: boolean
  dshPendingRestart: string | null
} {
  return {
    app: app.getVersion(),
    dsh: installedDshVersion() ?? null,
    appUpdate: result.app,
    // 装好待重启时不显示「有更新」：再点一次不该重复安装。
    dshUpdate: dshPendingRestart === null ? result.dsh : null,
    dshUpdating,
    dshPendingRestart,
  }
}
