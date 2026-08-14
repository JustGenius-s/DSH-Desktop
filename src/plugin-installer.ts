/**
 * dsh-desktop-update 插件的自动安装编排：主进程调用 installDesktopPlugin()
 * 即完成「跑安装脚本 → 记日志」全流程，失败静默（只记日志），绝不阻塞启动。
 * 脚本本体（scripts/install-desktop-plugin.mjs）幂等，可重复跑；npm 上尚无
 * 插件包时脚本正常退出（跳过），下次启动重试。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { bundledNodeBin } from './runtime-manager'

/**
 * 安装/修复 dsh-desktop-update 插件。成功或「包未发布跳过」返回 true；
 * 脚本执行失败记日志并返回 false。
 * 注意：脚本依赖 ~/.dsh/profiles/web（由 dsh web 首次启动初始化），
 * 因此本函数必须在 DSH host 就绪之后调用。
 */
export async function installDesktopPlugin(): Promise<boolean> {
  const script = app.isPackaged
    ? join(process.resourcesPath, 'scripts', 'install-desktop-plugin.mjs')
    : join(app.getAppPath(), 'scripts', 'install-desktop-plugin.mjs')
  if (!existsSync(script)) {
    console.warn('[DSH-Desktop] 插件安装脚本缺失: ' + script)
    return false
  }

  const { spawn } = await import('node:child_process')
  return new Promise((resolveRun) => {
    const child = spawn(bundledNodeBin(), [script, 'install'], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (c: Buffer) => process.stdout.write('[plugin-installer] ' + c.toString()))
    child.stderr?.on('data', (c: Buffer) => process.stderr.write('[plugin-installer] ' + c.toString()))
    child.on('error', (err) => {
      console.warn('[DSH-Desktop] 插件安装脚本启动失败: ' + err.message)
      resolveRun(false)
    })
    child.on('exit', (code) => {
      if (code !== 0) console.warn('[DSH-Desktop] 插件安装未完成（退出码 ' + (code ?? 'null') + '）')
      resolveRun(code === 0)
    })
  })
}
