/**
 * dsh-desktop-update 插件的自动安装编排：主进程调用 installDesktopPlugin()
 * 即完成「跑安装脚本 → 记日志」全流程，失败静默（只记日志），绝不阻塞启动。
 * 脚本本体（scripts/install-desktop-plugin.mjs）幂等，可重复跑；npm 上尚无
 * 插件包时脚本正常退出（跳过），下次启动重试。
 *
 * 脚本在 stdout 打 `restart-needed=yes|no`：host 已在跑且 profile/插件文件
 * 变了时为 yes，由调用方弹窗询问是否热重启网页服务（不强制）。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { bundledNodeBin } from './runtime-manager'
import { isQuarantined } from './plugin-quarantine'

/** 与 scripts/install-desktop-plugin.mjs 的 PLUGIN_NAME 保持一致。 */
const DESKTOP_UPDATE_PLUGIN = '@just-genius/dsh-desktop-update'

const RESTART_MARKER = /\[install-desktop-plugin\] restart-needed=(yes|no)/

export interface InstallDesktopPluginResult {
  ok: boolean
  /** profile / 插件文件已变更，正在跑的 dsh web 需要重启才能加载。 */
  restartNeeded: boolean
}

/**
 * 安装/修复 dsh-desktop-update 插件。成功或「包未发布跳过」ok=true；
 * 脚本执行失败记日志并 ok=false。
 * 注意：profile 尚未初始化时脚本会跳过（首启由 dsh 创建 profile 后再
 * 调一次）。profile 已存在时必须在 startDsh 之前调用：bundles 已登记
 * 但 node_modules 链接缺失会让 dsh 在 loadProfile 阶段直接退出。
 */
export async function installDesktopPlugin(): Promise<InstallDesktopPluginResult> {
  const skipped: InstallDesktopPluginResult = { ok: true, restartNeeded: false }
  const failed: InstallDesktopPluginResult = { ok: false, restartNeeded: false }
  // 插件因导致启动失败被隔离时跳过：安装脚本会无条件重新登记 bundles，
  // 不跳过的话隔离永远立不住。
  if (isQuarantined(DESKTOP_UPDATE_PLUGIN)) {
    console.warn('[DSH-Desktop] 桌面更新插件已被隔离，跳过自动安装/登记')
    return skipped
  }
  const script = app.isPackaged
    ? join(process.resourcesPath, 'scripts', 'install-desktop-plugin.mjs')
    : join(app.getAppPath(), 'scripts', 'install-desktop-plugin.mjs')
  if (!existsSync(script)) {
    console.warn('[DSH-Desktop] 插件安装脚本缺失: ' + script)
    return failed
  }

  const { spawn } = await import('node:child_process')
  return new Promise((resolveRun) => {
    const child = spawn(bundledNodeBin(), [script, 'install'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    child.stdout?.on('data', (c: Buffer) => {
      const text = c.toString()
      stdout += text
      process.stdout.write('[plugin-installer] ' + text)
    })
    child.stderr?.on('data', (c: Buffer) => process.stderr.write('[plugin-installer] ' + c.toString()))
    child.on('error', (err) => {
      console.warn('[DSH-Desktop] 插件安装脚本启动失败: ' + err.message)
      resolveRun(failed)
    })
    child.on('exit', (code) => {
      if (code !== 0) console.warn('[DSH-Desktop] 插件安装未完成（退出码 ' + (code ?? 'null') + '）')
      const marker = RESTART_MARKER.exec(stdout)
      resolveRun({ ok: code === 0, restartNeeded: marker?.[1] === 'yes' })
    })
  })
}
