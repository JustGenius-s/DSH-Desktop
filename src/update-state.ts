/**
 * 更新检测结果状态。
 *
 * 单独成文件是为了断开 desktop-bridge（检测 + IPC）与 desktop-seats（菜单）
 * 之间的循环依赖：两边都只依赖本模块。
 */

import { app } from 'electron'
import { installedDshVersion } from './runtime-manager'

/** 最近一次检测结果：有新版本时为该版本号，否则 null。 */
let result: { app: string | null; dsh: string | null } = { app: null, dsh: null }

export function setUpdateResult(next: { app: string | null; dsh: string | null }): void {
  result = next
}

export function clearDshUpdate(): void {
  result = { ...result, dsh: null }
}

/** 当前版本 + 有无更新，给菜单拼文案用。 */
export function updateSummary(): {
  app: string
  dsh: string | null
  appUpdate: string | null
  dshUpdate: string | null
} {
  return {
    app: app.getVersion(),
    dsh: installedDshVersion() ?? null,
    appUpdate: result.app,
    dshUpdate: result.dsh,
  }
}
