/**
 * 桌面更新桥：主进程侧的更新「执行器」+ IPC 端点。
 *
 * 0.2.0 起壳不再检测更新。检测（查 GitHub Releases / npm registry、比版本、
 * 定期间隔、跳过版本的记录）全部在 dsh-desktop-update 插件的 host 半侧：
 * 它跑在 dsh web host 的 Node 进程里，没有 CORS 限制，也不依赖某个窗口开着。
 *
 * 这里只留两件只有壳做得到的事：
 *   1. 报自己的打包版本号（插件比较 App 更新要用，它自己拿不到）；
 *   2. 执行——跑 `pnpm add` 装运行时、打开下载页、重启应用。
 *
 * 执行期间不再维护任何状态机：进度与成败由插件的 browser 半侧回报给它自己
 * 的 host 半侧（`POST /dsh-desktop-update/exec`），这样进度跨窗口一致，刷新
 * 页面也不会丢。这里只做「同一时刻只跑一个 pnpm」的串行保护。
 */

import { app, ipcMain, shell } from 'electron'
import { Ipc } from './ipc'
import { updateDsh } from './runtime-manager'

/** 兜底下载页：插件未给出具体 release URL 时用它。 */
const RELEASES_FALLBACK = 'https://github.com/JustGenius-s/DSH-Desktop/releases/latest'

/** 串行保护：pnpm 装运行时要一两分钟，不允许并发跑。 */
let updating = false

/**
 * 注册 IPC 端点。
 *
 * 与旧版不同：不启动轮询、不监听 settings.yaml、不维护状态机——检测与配置
 * 都在插件侧。旧端点的配置读写（setGate / setDshChannel / skipVersion）与
 * 状态查询（getState / checkNow）已随检测一起移除。
 */
export function setupDesktopBridge(): void {
  // 壳自己的版本。插件需要它才能判断「有没有比我新的 App 发布」。
  ipcMain.handle(Ipc.updates.appVersion, () => app.getVersion())

  // 打开 App 发布页。URL 由插件给出（只有它知道 latest 是哪个 release），
  // 壳只负责用系统浏览器打开，并只接受 GitHub 地址，避免被网页带着开任意 URL。
  ipcMain.handle(Ipc.updates.downloadApp, (_event, url: unknown) => {
    const target =
      typeof url === 'string' && /^https:\/\/github\.com\//.test(url) ? url : RELEASES_FALLBACK
    void shell.openExternal(target)
  })

  // 把 DSH 运行时装成指定版本。版本由插件给出；装完需 relaunch 才生效。
  // 抛错即失败，由插件的 browser 半侧回报给 host 半侧。
  ipcMain.handle(Ipc.updates.updateDsh, async (_event, version: unknown) => {
    if (typeof version !== 'string' || version === '') {
      throw new Error('缺少目标版本')
    }
    if (updating) throw new Error('已有更新在进行中')
    updating = true
    try {
      // 进度回调不再广播给网页：插件的 browser 半侧负责把成败回报给 host 半侧。
      await updateDsh(version)
    } finally {
      updating = false
    }
  })

  ipcMain.on(Ipc.updates.relaunch, () => {
    app.relaunch()
    app.quit()
  })
}
