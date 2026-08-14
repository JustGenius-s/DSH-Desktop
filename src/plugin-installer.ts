/**
 * dsh-desktop-update 插件的自动安装编排：主进程调用 installDesktopPlugin()
 * 即完成「定位源码 → 跑安装脚本 → 记日志」全流程，失败静默（只记日志），
 * 绝不阻塞启动。脚本本体（scripts/install-desktop-plugin.mjs）幂等，可重复跑。
 *
 * 当前阶段为本地源码安装：从 DSH-Plugs 工作副本复制预构建产物。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { bundledNodeBin } from './runtime-manager'

/** 插件源码目录：开发模式 = 仓库平级的 DSH-Plugs 工作副本；
 *  打包模式 = extraResources 里的 resources/pluginSrc（由打包流程同步）。 */
function sourceDir(): string | undefined {
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'pluginSrc')
    return existsSync(bundled) ? bundled : undefined
  }
  const sibling = join(app.getAppPath(), '..', 'DSH-Plugs', 'plugins', 'dsh-desktop-update')
  return existsSync(sibling) ? sibling : undefined
}

/**
 * 安装/修复 dsh-desktop-update 插件。成功返回 true；失败记日志并返回 false。
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
  const src = sourceDir()
  if (src === undefined) {
    console.warn('[DSH-Desktop] 插件源码目录不存在（本地安装模式需要 DSH-Plugs 工作副本或打包的 pluginSrc）')
    return false
  }

  const { spawn } = await import('node:child_process')
  return new Promise((resolveRun) => {
    const child = spawn(bundledNodeBin(), [script, 'install', '--source', src], { stdio: ['ignore', 'pipe', 'pipe'] })
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
