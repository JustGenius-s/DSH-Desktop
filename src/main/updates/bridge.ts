/**
 * 桌面更新桥：主进程自己检测更新，并把「只有壳做得到」的动作挂成 IPC。
 *
 * 检测全在壳里：GitHub Releases 查 App 本体，npm dist-tags 查 DSH 运行时
 * （取所有渠道里版本最高的）。不再有插件、不再有渠道配置——启动自动查一轮，
 * 之后每 6 小时一次；结果显示在应用菜单里（无更新显示版本号，有更新显示新版本）。
 *
 * 网页只能请求「执行」，因为下面每件事都必须由打包后的桌面应用来做：
 * 报自己的版本号、跑 pnpm add 装运行时、用系统浏览器打开下载页、热重启
 * 网页服务、重启整个应用。
 */

import { app, ipcMain, shell } from 'electron'
import { Ipc } from '../../shared/ipc'
import { compareVersions } from '../../shared/version'
import { currentShellLang } from '../locale'
import {
  offerRestartDshWeb,
  onDshWebRestarted,
  restartDshWeb,
  setupRestartPromptIpc,
} from '../restart'
import { installedDshVersion, latestDshAcrossChannels, updateDsh } from '../runtime/installation'
import { APP_RELEASES_URL, checkForAppUpdate } from './app-update'
import { notifyDshUpdateDone, notifyDshUpdateStarted, reportDshUpdateFailure } from './feedback'
import {
  clearDshPendingRestart,
  clearDshUpdate,
  setDshPendingRestart,
  setDshUpdating,
  setUpdateResult,
} from './state'

/** 后台轮询间隔：6 小时。 */
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 串行保护：pnpm 装运行时要一两分钟，不允许并发跑。 */
let updating = false

/** 菜单刷新钩子：由 menus/seats.ts 注入，更新模块不导入菜单实现。 */
let refreshMenu: () => void = () => {}

export function setMenuRefreshHook(fn: () => void): void {
  refreshMenu = fn
}

/** 查一轮 App 本体与 DSH 运行时；无法确认新版本时不显示更新提示。 */
export async function checkDesktopUpdates(): Promise<void> {
  const [appInfo, dshLatest, dshInstalled] = await Promise.all([
    checkForAppUpdate().catch(() => undefined),
    latestDshAcrossChannels().catch(() => undefined),
    Promise.resolve(installedDshVersion()),
  ])
  setUpdateResult({
    app: appInfo?.latest ?? null,
    dsh:
      dshLatest !== undefined &&
      dshInstalled !== undefined &&
      compareVersions(dshLatest, dshInstalled) > 0
        ? dshLatest
        : null,
  })
  // 菜单里那行版本/更新文案要跟着结果变。
  refreshMenu()
}

/**
 * 把 DSH 运行时装到指定版本；省略版本时装所有渠道里最高的。
 *
 * pnpm 装一次要一两分钟，全程必须有回执：开始就把菜单切成「正在更新」并禁用入口，
 * 装完弹结果，失败弹错误框。否则点下去界面毫无变化，用户只会以为菜单坏了。
 *
 * 装完不无条件清掉更新提示：用户选「稍后」时新运行时还没生效，此时改成提示
 * 「重启服务以应用」——既不再重复安装，也不会假装已经是最新的。
 */
export async function updateDshRuntime(version?: unknown): Promise<void> {
  if (updating) throw new Error('已有更新在进行中')
  updating = true
  setDshUpdating(true)
  refreshMenu()
  const lang = currentShellLang(app.getLocale())
  try {
    const target =
      typeof version === 'string' && version !== '' ? version : await latestDshAcrossChannels()
    if (target === undefined) throw new Error('当前没有可更新的 DSH 版本')
    notifyDshUpdateStarted(lang, target)
    await updateDsh(target)
    const restarted = await offerRestartDshWeb('dsh-runtime').catch(() => false)
    if (restarted) {
      clearDshUpdate()
      clearDshPendingRestart()
    } else {
      setDshPendingRestart(target)
    }
    // 装完重新核对一次：已安装版本变了，菜单上的「有更新」要跟着变。
    await checkDesktopUpdates()
    notifyDshUpdateDone(lang, target, !restarted)
  } catch (err) {
    reportDshUpdateFailure(lang, err)
    throw err
  } finally {
    updating = false
    setDshUpdating(false)
    refreshMenu()
  }
}

/**
 * 应用已装好但还没生效的运行时：热重启网页服务，桌面壳不退出。
 *
 * 清理交给 onDshWebRestarted 钩子，这样从「重启 DSH 服务」等其他入口重启后，
 * 待生效状态同样会消失——不用在每个入口都补一遍。
 */
export async function applyPendingDshRuntime(): Promise<void> {
  const lang = currentShellLang(app.getLocale())
  try {
    await restartDshWeb()
  } catch (err) {
    reportDshUpdateFailure(lang, err)
    throw err
  }
}

/** 注册 IPC：只有执行端点，检测不再对网页开放。 */
export function setupDesktopBridge(): void {
  setupRestartPromptIpc()

  // 服务一起来，磁盘上装好的新运行时就变成正在跑的版本：清掉待生效状态，
  // 重新核对一次「还有没有更新」，再重画菜单。
  onDshWebRestarted(() => {
    clearDshPendingRestart()
    clearDshUpdate()
    refreshMenu()
    void checkDesktopUpdates()
  })

  ipcMain.handle(Ipc.updates.appVersion, () => app.getVersion())

  // 打开 App 发布页。只接受 GitHub 地址，避免被网页带着开任意 URL。
  ipcMain.handle(Ipc.updates.downloadApp, () => {
    void shell.openExternal(APP_RELEASES_URL)
  })

  // 把 DSH 运行时装到指定版本（默认取所有渠道里最高的）。
  // 装完问一句是否热重启网页服务：接受则立即生效，拒绝则提示重启应用。
  ipcMain.handle(Ipc.updates.updateDsh, (_event, version: unknown) => updateDshRuntime(version))

  // 热重启网页服务：杀掉并拉起 dsh web 子进程，刷新主窗口，桌面壳不退出。
  ipcMain.handle(Ipc.updates.restartWeb, () => restartDshWeb())

  ipcMain.on(Ipc.updates.relaunch, () => {
    app.relaunch()
    app.quit()
  })

  const timer = setInterval(() => {
    void checkDesktopUpdates()
  }, POLL_INTERVAL_MS)
  timer.unref()
}
