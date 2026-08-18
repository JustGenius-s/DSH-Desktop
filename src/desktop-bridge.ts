/**
 * 桌面更新桥：主进程侧的更新状态机 + IPC 端点。
 *
 * 后台静默检测 App 本体（GitHub Releases）与 DSH 运行时（npm）的新版本，
 * 状态变化推给所有窗口；preload 以 window.dshDesktop.updates 暴露给网页，
 * 由 dsh-desktop-update 客户端插件在侧栏设置按钮旁渲染更新徽章。
 *
 * 「跳过该版本」按版本号记录：被跳过的 latest 不再提示，出现更新的版本后
 * 自动恢复提示。与旧版「不再提示」（永久关闭）不同——徽章模式不打扰用户，
 * 没有永久关闭的必要。
 */

import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { DesktopUpdateConfig, DesktopUpdateInfo, DesktopUpdateState } from './api'
import { checkForAppUpdate, compareVersions } from './app-updater'
import { Ipc } from './ipc'
import { dshHome, installedDshVersion, latestDshVersion, updateDsh } from './runtime-manager'

export type { DesktopUpdateConfig, DesktopUpdateInfo, DesktopUpdateState } from './api'

/** 后台轮询间隔：6 小时。 */
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000

let state: DesktopUpdateState = { app: null, dsh: null, checking: false, config: readUpdateConfig(), versions: currentVersions() }

/** 当前安装版本快照。 */
function currentVersions(): { app: string; dsh: string | null } {
  return { app: app.getVersion(), dsh: installedDshVersion() ?? null }
}
let pollTimer: NodeJS.Timeout | null = null
let settingsWatcher: FSWatcher | null = null


/** DSH settings.yaml 路径（dsh-settings-file 的默认文档位置）。 */
function settingsFilePath(): string {
  return join(dshHome(), 'settings.yaml')
}

/** 从 settings.yaml 读 desktop-update 分节的两个开关（缺失 → 默认 true）。
 *  手写极简解析：只匹配 `desktop-update:` 段内的两个布尔行，避免引入 YAML
 *  依赖；解析失败一律回退默认（开）。 */
export function readUpdateConfig(): DesktopUpdateConfig {
  try {
    const text = readFileSync(settingsFilePath(), 'utf8')
    const m = /(?:^|\n)desktop-update:\n((?:[ \t]+[^\n]*\n?)*)/.exec(text)
    const section = m?.[1] ?? ''
    const pick = (key: string): boolean => {
      const km = new RegExp('(?:^|\\n)\\s*' + key + ':\\s*(true|false)').exec(section)
      return km === null ? true : km[1] === 'true'
    }
    return { checkApp: pick('checkApp'), checkDsh: pick('checkDsh') }
  } catch {
    return { checkApp: true, checkDsh: true }
  }
}

/** 写一个开关到 settings.yaml 的 desktop-update 分节（保留文件其余内容）。 */
export function writeUpdateGate(kind: 'app' | 'dsh', enabled: boolean): void {
  const key = kind === 'app' ? 'checkApp' : 'checkDsh'
  const line = '  ' + key + ': ' + String(enabled)
  let text = ''
  try {
    text = readFileSync(settingsFilePath(), 'utf8')
  } catch {
    // 文件不存在：从空文档开始。
  }
  let next: string
  if (/(?:^|\n)desktop-update:\n/.test(text)) {
    // 分节已存在：替换对应键（缺失则追加到分节尾）。
    next = text.replace(/(^|\n)(desktop-update:\n)((?:[ \t]+[^\n]*\n?)*)/, (_all, head: string, ns: string, body: string) => {
      const keyRe = new RegExp('(^|\\n)\\s*' + key + ':[^\\n]*')
      const newBody = keyRe.test(body)
        ? body.replace(keyRe, (_m, nl: string) => nl + line)
        : body + line + '\n'
      return head + ns + newBody
    })
  } else {
    next = text + (text.endsWith('\n') || text === '' ? '' : '\n') + 'desktop-update:\n' + line + '\n'
  }
  mkdirSync(dirname(settingsFilePath()), { recursive: true })
  writeFileSync(settingsFilePath(), next)
}

/** 「跳过该版本」记录：kind → 被跳过的 latest 版本号。 */
function skipFilePath(): string {
  return join(app.getPath('userData'), 'desktop-update-skip.json')
}

function readSkipped(): Record<string, string> {
  try {
    const obj = JSON.parse(readFileSync(skipFilePath(), 'utf8')) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const k of ['app', 'dsh']) {
      if (typeof obj[k] === 'string') out[k] = obj[k]
    }
    return out
  } catch {
    return {}
  }
}

function writeSkipped(map: Record<string, string>): void {
  try {
    mkdirSync(dirname(skipFilePath()), { recursive: true })
    writeFileSync(skipFilePath(), JSON.stringify(map, null, 2) + "\n")
  } catch {
    // 写失败无妨：最坏只是本次跳过不生效。
  }
}

/** latest 命中跳过记录时不展示（视为无更新）。 */
function applySkip(info: DesktopUpdateInfo | null, kind: 'app' | 'dsh'): DesktopUpdateInfo | null {
  if (info === null) return null
  const skipped = readSkipped()[kind]
  if (skipped !== undefined && compareVersions(info.latest, skipped) <= 0) return null
  return info
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(Ipc.updates.state, state)
  }
}

async function setState(next: Partial<DesktopUpdateState>): Promise<void> {
  state = { ...state, ...next }
  broadcast()
}

/** 静默检测一轮；任何网络/解析失败都吞掉，保持现状。两个开关各自门控：
 *  关闭的一侧不发起网络请求，已有提示也随之隐藏（状态置 null）。 */
export async function checkDesktopUpdates(): Promise<DesktopUpdateState> {
  await setState({ checking: true })
  try {
    const gates = state.config
    const [appInfo, dshLatest] = await Promise.all([
      gates.checkApp ? checkForAppUpdate().catch(() => undefined) : Promise.resolve(undefined),
      gates.checkDsh ? latestDshVersion().catch(() => undefined) : Promise.resolve(undefined),
    ])
    const dshInstalled = installedDshVersion()
    const dshInfo: DesktopUpdateInfo | null =
      gates.checkDsh && dshLatest !== undefined && dshInstalled !== undefined && compareVersions(dshLatest, dshInstalled) > 0
        ? { current: dshInstalled, latest: dshLatest }
        : null
    await setState({
      app: gates.checkApp ? applySkip(appInfo ?? null, 'app') : null,
      dsh: gates.checkDsh ? applySkip(dshInfo, 'dsh') : null,
      checking: false,
      versions: currentVersions(),
    })
  } catch {
    await setState({ checking: false })
  }
  return state
}

/** 注册 IPC 端点并启动后台轮询；返回当前状态（供启动时首查）。 */
export function setupDesktopBridge(): void {
  ipcMain.handle(Ipc.updates.getState, () => state)

  ipcMain.handle(Ipc.updates.checkNow, () => checkDesktopUpdates())

  ipcMain.handle(Ipc.updates.downloadApp, () => {
    const url = state.app?.url
    if (url !== undefined) void shell.openExternal(url)
  })

  ipcMain.handle(Ipc.updates.updateDsh, async () => {
    const latest = state.dsh?.latest
    if (latest === undefined) throw new Error('当前没有可更新的 DSH 版本')
    await updateDsh(latest)
    // 升级成功后清除 dsh 更新提示；重启后由新 bin 生效。
    await setState({ dsh: null })
  })

  ipcMain.handle(Ipc.updates.skipVersion, (_event, kind: 'app' | 'dsh') => {
    if (kind !== 'app' && kind !== 'dsh') return
    const info = state[kind]
    if (info === null) return
    writeSkipped({ ...readSkipped(), [kind]: info.latest })
    void setState({ [kind]: null })
  })

  // 写一个自动检查开关：持久化到 settings.yaml（与插件注册的命名空间共享
  // 存储），随后按新开关重查一轮并广播结果。
  ipcMain.handle(Ipc.updates.setGate, async (_event, kind: 'app' | 'dsh', enabled: unknown) => {
    if ((kind !== 'app' && kind !== 'dsh') || typeof enabled !== 'boolean') return state
    writeUpdateGate(kind, enabled)
    await setState({ config: { ...state.config, [kind === 'app' ? 'checkApp' : 'checkDsh']: enabled } })
    return checkDesktopUpdates()
  })

  ipcMain.on(Ipc.updates.relaunch, () => {
    app.relaunch()
    app.quit()
  })

  // settings.yaml 也可能被插件半侧或用户手改：监听变化，重读开关并广播
  // （debounce 由 fs.watch 的粗粒度自然承担——一次写入至多触发两轮重读）。
  try {
    settingsWatcher = watch(settingsFilePath(), () => {
      const config = readUpdateConfig()
      if (config.checkApp !== state.config.checkApp || config.checkDsh !== state.config.checkDsh) {
        void setState({ config }).then(() => checkDesktopUpdates())
      }
    })
  } catch {
    // 文件尚不存在（首启）：不监听，首次写入由本进程发起。
    settingsWatcher = null
  }

  pollTimer = setInterval(() => {
    void checkDesktopUpdates()
  }, POLL_INTERVAL_MS)
  pollTimer.unref()
}

/** 跳过记录文件是否已存在（仅测试与调试便利）。 */
export function desktopUpdateSkipFileExists(): boolean {
  return existsSync(skipFilePath())
}

