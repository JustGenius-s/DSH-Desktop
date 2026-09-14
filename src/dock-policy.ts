/**
 * macOS Dock 图标守卫。
 *
 * Dock 瓷砖读 bundle 的 icon.icns。icns / dock-icon.png 必须从带 84px 边距的
 * build/icon-mac.png 生成（画布 1024、内容 856，约 83.5%，与系统 App 的 squircle 一致）。
 * 全铺满的 icon-app.png 会让图标比旁边的 App 大一圈；不要拿它去 dock.setIcon。
 *
 * dock.setIcon 仍用 PNG：Electron 43 的 createFromPath(icns) 可能返回 empty。
 * 不要 dock.hide()：hide 之后 show 会按 bundle icns 重建瓷砖，自定义 setIcon 会被冲掉。
 * 不要在 /Applications 留同 bundle id 的 .bak。
 * 改 icon-app.png 后跑 python3 scripts/build-mac-icon.py 再打包。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, nativeImage, type NativeImage } from 'electron'

let guardTimer: ReturnType<typeof setInterval> | null = null
let kickTimers: ReturnType<typeof setTimeout>[] = []
let lastIconAppliedAt = 0

function dockIconCandidates(): string[] {
  return [
    join(process.resourcesPath, 'dock-icon.png'),
    join(app.getAppPath(), 'build', 'icon-mac.png'),
    join(process.resourcesPath, 'icon.icns'),
  ]
}

function loadDockImage(): NativeImage | null {
  for (const path of dockIconCandidates()) {
    if (!existsSync(path)) continue
    let image = nativeImage.createFromPath(path)
    if (image.isEmpty()) {
      try {
        image = nativeImage.createFromBuffer(readFileSync(path))
      } catch {
        continue
      }
    }
    if (!image.isEmpty()) return image
  }
  return null
}

function applyDockIcon(force = false): void {
  const dock = app.dock
  if (dock === undefined) return
  const now = Date.now()
  if (!force && now - lastIconAppliedAt < 1000) return
  const image = loadDockImage()
  if (image === null) return
  dock.setIcon(image)
  lastIconAppliedAt = now
}

function showAndStamp(): void {
  const dock = app.dock
  if (dock === undefined) return
  app.setActivationPolicy('regular')
  applyDockIcon(true)
  void dock.show().then(() => applyDockIcon(true)).catch(() => {})
}

export function enforceRegularDockPolicy(): void {
  if (process.platform !== 'darwin') return
  showAndStamp()
}

export function startDockPolicyGuard(): void {
  if (process.platform !== 'darwin') return
  stopDockPolicyGuard()
  showAndStamp()
  for (const ms of [1200, 3000, 6000]) {
    kickTimers.push(setTimeout(() => showAndStamp(), ms))
  }
  guardTimer = setInterval(() => {
    const dock = app.dock
    if (dock === undefined) return
    applyDockIcon()
    if (!dock.isVisible()) showAndStamp()
  }, 500)
}

export function stopDockPolicyGuard(): void {
  if (guardTimer !== null) {
    clearInterval(guardTimer)
    guardTimer = null
  }
  for (const t of kickTimers) clearTimeout(t)
  kickTimers = []
}
