/**
 * 桌面更新桥：主进程侧的更新「执行器」+ 兼容层 IPC 端点。
 *
 * ── 0.2.0 的职责划分 ──────────────────────────────────────────
 * 检测（查 GitHub Releases / npm registry、比版本、定期间隔）已迁到
 * dsh-desktop-update 插件的 host 半侧：它跑在 dsh web host 的 Node 进程里，
 * 没有 CORS 限制，也不依赖某个窗口开着。新插件走那条路。
 *
 * 但 npm 上目前还没有 0.2.0 的插件，已装的还是 0.1.x（REQUIRED_VERSION 停在
 * 0.1.2，见 scripts/install-desktop-plugin.mjs）：它们只认壳侧的 getState /
 * checkNow / setGate / setDshChannel / skipVersion。这批端点连同状态机一起
 * 保留成「兼容层」，让旧插件不至于连更新徽章都拿不到；等 0.2.0 插件发布、
 * REQUIRED_VERSION 提上去之后，本文件可以只留执行端点。
 *
 * ── 壳独有的执行能力 ──────────────────────────────────────────
 * 只有打包后的桌面应用做得到：报自己的版本号、跑 `pnpm add` 装运行时、
 * 用系统浏览器打开下载页、热重启网页服务、重启整个应用。
 *
 * 其中 restartWeb 是本分支加的：装完运行时 / 插件配置变了之后，不再强制
 * `app.relaunch()`，只杀掉并拉起 `dsh web` 子进程再刷新窗口，桌面壳不退出。
 */

import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { DesktopUpdateConfig, DesktopUpdateInfo, DesktopUpdateState, DshChannel } from './api'
import { checkForAppUpdate, compareVersions } from './app-updater'
import { offerRestartDshWeb, restartDshWeb, setupRestartPromptIpc } from './dsh-lifecycle'
import { Ipc } from './ipc'
import {
  dshHome,
  installedDshVersion,
  resolveDshChannelVersion,
  updateDsh,
} from './runtime-manager'

export type { DesktopUpdateConfig, DesktopUpdateInfo, DesktopUpdateState } from './api'

/** 兜底下载页：插件未给出具体 release URL 时用它。 */
const RELEASES_FALLBACK = 'https://github.com/JustGenius-s/DSH-Desktop/releases/latest'

/** 兼容层后台轮询间隔：6 小时。新插件的检测间隔由它自己的 host 半侧决定。 */
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000

let state: DesktopUpdateState = {
  app: null,
  dsh: null,
  checking: false,
  updatingDsh: false,
  updateMessage: null,
  needsRelaunch: false,
  config: readUpdateConfig(),
  versions: currentVersions(),
}

let pollTimer: NodeJS.Timeout | null = null
let settingsWatcher: FSWatcher | null = null

/** 当前安装版本快照。 */
function currentVersions(): { app: string; dsh: string | null } {
  return { app: app.getVersion(), dsh: installedDshVersion() ?? null }
}

// ---------------------------------------------------------------------------
// settings.yaml 读写（兼容层）：desktop-update 分节的开关与渠道
// ---------------------------------------------------------------------------

/** DSH settings.yaml 路径（dsh-settings-file 的默认文档位置）。 */
function settingsFilePath(): string {
  return join(dshHome(), 'settings.yaml')
}

/** 手写极简解析：只匹配 `desktop-update:` 段内的相关行，避免引入 YAML 依赖；
 *  解析失败一律回退默认。 */
const DSH_CHANNELS: readonly DshChannel[] = ['latest', 'next', 'alpha', 'custom'] as const

function parseChannel(raw: string | undefined): DshChannel {
  if (raw !== undefined && (DSH_CHANNELS as readonly string[]).includes(raw)) return raw as DshChannel
  return 'latest'
}

export function readUpdateConfig(): DesktopUpdateConfig {
  const base = { checkApp: true, checkDsh: true, dshChannel: 'latest' as DshChannel, dshVersion: '' }
  try {
    const text = readFileSync(settingsFilePath(), 'utf8')
    const m = /(?:^|\n)desktop-update:\n((?:[ \t]+[^\n]*\n?)*)/.exec(text)
    const section = m?.[1] ?? ''
    const pickBool = (key: string): boolean => {
      const km = new RegExp('(?:^|\\n)\\s*' + key + ':\\s*(true|false)').exec(section)
      return km === null ? true : km[1] === 'true'
    }
    const pickStr = (key: string): string | undefined => {
      const km = new RegExp('(?:^|\\n)\\s*' + key + ':\\s*([^\\n\\r]+)').exec(section)
      if (km === null) return undefined
      const value = km[1].trim().replace(/^(['"])(.*)\\1$/, '$2')
      return value === '' ? undefined : value
    }
    return {
      checkApp: pickBool('checkApp'),
      checkDsh: pickBool('checkDsh'),
      dshChannel: parseChannel(pickStr('dshChannel')),
      dshVersion: pickStr('dshVersion') ?? '',
    }
  } catch {
    return { ...base }
  }
}

/** 渠道 → settings.yaml 的完整 desktop-update 分节（保留文件其余内容）。 */
export function writeUpdateChannel(channel: DshChannel, version?: string): void {
  const dshLine = '  dshChannel: ' + channel
  const versionLine = '  dshVersion: ' + String(version ?? '')
  let text = ''
  try {
    text = readFileSync(settingsFilePath(), 'utf8')
  } catch {
    // 文件不存在：从空文档开始。
  }
  let next: string
  if (/(?:^|\n)desktop-update:\n/.test(text)) {
    next = text.replace(/(^|\n)(desktop-update:\n)((?:[ \t]+[^\n]*\n?)*)/, (_all, head: string, ns: string, body: string) => {
      const replaceKey = (input: string, key: string, line: string): string => {
        const keyRe = new RegExp('(^|\\n)\\s*' + key + ':[^\\n]*')
        return keyRe.test(input) ? input.replace(keyRe, (_m, nl: string) => nl + line) : input + line + '\n'
      }
      let newBody = replaceKey(body, 'dshChannel', dshLine)
      newBody = replaceKey(newBody, 'dshVersion', versionLine)
      return head + ns + newBody
    })
  } else {
    next = text + (text.endsWith('\n') || text === '' ? '' : '\n') + 'desktop-update:\n' + dshLine + '\n' + versionLine + '\n'
  }
  mkdirSync(dirname(settingsFilePath()), { recursive: true })
  writeFileSync(settingsFilePath(), next)
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

// ---------------------------------------------------------------------------
// 「跳过该版本」记录（兼容层）
// ---------------------------------------------------------------------------

/** kind → 被跳过的 latest 版本号。 */
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
    writeFileSync(skipFilePath(), JSON.stringify(map, null, 2) + '\n')
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

// ---------------------------------------------------------------------------
// 兼容层状态机
// ---------------------------------------------------------------------------

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
      gates.checkDsh
        ? resolveDshChannelVersion(gates.dshChannel ?? 'latest', gates.dshVersion).catch(() => undefined)
        : Promise.resolve(undefined),
    ])
    const dshInstalled = installedDshVersion()
    const dshInfo: DesktopUpdateInfo | null =
      gates.checkDsh &&
      dshLatest !== undefined &&
      dshInstalled !== undefined &&
      compareVersions(dshLatest, dshInstalled) > 0
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

// ---------------------------------------------------------------------------
// IPC 端点
// ---------------------------------------------------------------------------

/** 注册 IPC 端点并启动兼容层轮询。分两组：执行端点（正式契约）与兼容端点。 */
export function setupDesktopBridge(): void {
  setupRestartPromptIpc()

  // ---- 执行端点：只有壳做得到 ----

  // 壳自己的版本。插件需要它才能判断「有没有比我新的 App 发布」。
  ipcMain.handle(Ipc.updates.appVersion, () => app.getVersion())

  // 打开 App 发布页。URL 由插件给出（只有它知道 latest 是哪个 release），
  // 壳只负责用系统浏览器打开，并只接受 GitHub 地址，避免被网页带着开任意 URL。
  ipcMain.handle(Ipc.updates.downloadApp, (_event, url: unknown) => {
    const target =
      typeof url === 'string' && /^https:\/\/github\.com\//.test(url) ? url : RELEASES_FALLBACK
    void shell.openExternal(target)
  })

  // 把 DSH 运行时装成指定版本。版本由新插件给出；旧插件（0.1.x）不传版本，
  // 由壳按当前渠道解析——它们不知道自己在跟哪个版本的壳说话。
  // 装完后问一句是否热重启网页服务：接受则新版本立即生效，不必整壳重启。
  ipcMain.handle(Ipc.updates.updateDsh, async (_event, version: unknown) => {
    if (updating) throw new Error('已有更新在进行中')
    const target =
      typeof version === 'string' && version !== ''
        ? version
        : await resolveDshChannelVersion(state.config.dshChannel ?? 'latest', state.config.dshVersion)
    // 旧插件走的兼容路径：没传版本时，优先用它正看着的那条提示里的 latest
    // （它刚刚才点下「更新」，state 里就是它期望的版本）。
    const latest = target ?? state.dsh?.latest
    if (latest === undefined) throw new Error('当前没有可更新的 DSH 版本')

    updating = true
    await setState({
      updatingDsh: true,
      updateMessage: `正在更新 DSH 运行时到 ${latest}…`,
      needsRelaunch: false,
    })
    try {
      await updateDsh(latest, (message) => {
        void setState({ updateMessage: message })
      })
      // 升级成功后清除 dsh 更新提示；弹窗询问是否热重启网页服务（不强制、
      // 不关壳）：接受且重启成功则新 bin 立即生效；拒绝则保留整壳重启提示。
      const restarted = await offerRestartDshWeb('dsh-runtime').catch(() => false)
      await setState(
        restarted
          ? {
              dsh: null,
              updatingDsh: false,
              updateMessage: `已更新到 ${latest}，网页服务已热重启`,
              needsRelaunch: false,
              versions: currentVersions(),
            }
          : {
              dsh: null,
              updatingDsh: false,
              updateMessage: `已安装 ${latest}，请重启 DSH-Desktop 生效`,
              needsRelaunch: true,
              versions: currentVersions(),
            },
      )
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      await setState({
        updatingDsh: false,
        updateMessage: `更新失败：${detail}`,
        needsRelaunch: false,
      })
      throw err
    } finally {
      updating = false
    }
  })

  // 热重启网页服务：杀掉并拉起 dsh web 子进程，刷新主窗口，桌面壳不退出。
  ipcMain.handle(Ipc.updates.restartWeb, () => restartDshWeb())

  ipcMain.on(Ipc.updates.relaunch, () => {
    app.relaunch()
    app.quit()
  })

  // ---- 兼容端点：仅 0.1.x 旧插件使用，新插件请用插件 host 半侧的检测 ----

  ipcMain.handle(Ipc.updates.getState, () => state)

  ipcMain.handle(Ipc.updates.checkNow, () => checkDesktopUpdates())

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
    await setState({
      config: { ...state.config, [kind === 'app' ? 'checkApp' : 'checkDsh']: enabled },
    })
    return checkDesktopUpdates()
  })

  // 写 DSH 更新渠道（与插件注册的命名空间共享 settings.yaml 存储），
  // 随后按新渠道重查一轮并广播结果。
  ipcMain.handle(Ipc.updates.setDshChannel, async (_event, channel: unknown, version?: unknown) => {
    if (channel !== 'latest' && channel !== 'next' && channel !== 'alpha' && channel !== 'custom') {
      return state
    }
    if (typeof version !== 'string' && version !== undefined) return state
    writeUpdateChannel(channel, version)
    await setState({
      config: {
        ...state.config,
        dshChannel: channel,
        dshVersion: channel === 'custom' ? (version ?? '') : '',
      },
    })
    return checkDesktopUpdates()
  })

  // settings.yaml 也可能被插件半侧或用户手改：监听变化，重读开关/渠道并广播。
  try {
    settingsWatcher = watch(settingsFilePath(), () => {
      const config = readUpdateConfig()
      const prev = state.config
      if (
        config.checkApp !== prev.checkApp ||
        config.checkDsh !== prev.checkDsh ||
        config.dshChannel !== prev.dshChannel ||
        config.dshVersion !== prev.dshVersion
      ) {
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

/** 串行保护：pnpm 装运行时要一两分钟，不允许并发跑。 */
let updating = false
