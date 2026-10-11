/**
 * 桌面席位所有者：主进程声明 `applicationMenu` / `tray`，把插件的声明式
 * 贡献渲染成原生菜单。对应 DSH 的 slot 模型——所有者声明席位，贡献方只
 * 注入规格，点击以 id 回传给贡献窗口；贡献方卸掉（revoke 或窗口销毁）后
 * 条目消失。主进程不跑 Cordis，也不把 Electron Menu/Tray 对象暴露给网页。
 */

import {
  app,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  DESKTOP_ID_RE,
  type DesktopMenuAttach,
  type DesktopMenuItemSpec,
  type DesktopSeatAction,
  type DesktopSeatInfo,
  type DesktopSeatName,
} from '../../shared/api'
import { Ipc } from '../../shared/ipc'
import { currentShellLang, type ShellLang } from '../locale'
import { restartDshWeb } from '../restart'
import { APP_RELEASES_URL } from '../updates/app-update'
import {
  applyPendingDshRuntime,
  checkDesktopUpdates,
  setMenuRefreshHook,
  updateDshRuntime,
} from '../updates/bridge'
import { updateSummary } from '../updates/state'
import { focusMainWindow, webContentsById } from '../windows/registry'
import { sanitizeContribution, type MenuContribution } from './contributions'
import { nativeMenuItemId, scheduleTrailing, upsertContribution } from './seat-state'
import { menuStrings, withAppName, type MenuStrings } from './i18n'

const DECLARED_SEATS: readonly DesktopSeatInfo[] = [
  {
    name: 'applicationMenu',
    declared: true,
    description: 'macOS 屏幕顶栏应用菜单（Windows/Linux 为窗口菜单栏，桌面壳默认隐藏）',
  },
  {
    name: 'tray',
    declared: true,
    description: '菜单栏右侧状态图标 / 系统托盘；有贡献时才创建',
  },
]

interface StoredContribution extends MenuContribution {
  wcId: number
}

const contributions: StoredContribution[] = []
const watchedWc = new Set<number>()
let tray: Tray | null = null
let rebuildTimer: NodeJS.Timeout | null = null
/** Wait for one client contribution burst to settle before replacing native menus. */
const REBUILD_DEBOUNCE_MS = 100
/**
 * 壳菜单当前语言。来源是 web profile 里的 locale 偏好（用户设置、稳定契约）；
 * 没有偏好（用户没选过）时回落系统语言。缓存到下一次配置变化。
 */
let menuLang: ShellLang | null = null

/** 当前菜单语言：偏好优先，其次系统语言。 */
function currentMenuLang(): ShellLang {
  menuLang ??= currentShellLang(app.getLocale())
  return menuLang
}

/**
 * 重读语言偏好；真的变了才重建菜单（托盘一起）。
 * 由 app.ts 订阅插件配置变化后调用。
 */
export function refreshMenuLanguage(): void {
  const next = currentShellLang(app.getLocale())
  if (next === currentMenuLang()) return
  menuLang = next
  scheduleRebuild()
}

function trayIconPath(): string {
  return join(app.getAppPath(), 'build', 'icon.png')
}

function remove(wcId: number, seat: DesktopSeatName, contributor: string): void {
  for (let i = contributions.length - 1; i >= 0; i--) {
    const row = contributions[i]
    if (row.wcId === wcId && row.seat === seat && row.contributor === contributor) {
      contributions.splice(i, 1)
    }
  }
}

function removeWindow(wcId: number): void {
  for (let i = contributions.length - 1; i >= 0; i--) {
    if (contributions[i].wcId === wcId) contributions.splice(i, 1)
  }
  watchedWc.delete(wcId)
  scheduleRebuild()
}

function sorted(seat: DesktopSeatName, menu?: DesktopMenuAttach): StoredContribution[] {
  return contributions
    .filter((c) => c.seat === seat && (menu === undefined || c.menu === menu))
    .sort((a, b) => a.order - b.order || a.contributor.localeCompare(b.contributor))
}

function toElectronItems(
  row: StoredContribution,
  items: DesktopMenuItemSpec[],
  options: { accelerators?: boolean } = {},
): MenuItemConstructorOptions[] {
  return items.map((item) => {
    if (item.type === 'separator') return { type: 'separator' }
    const opts: MenuItemConstructorOptions = {
      // One contribution can appear in several native NSMenu trees. Keep each
      // native item identity unique to its owning surface.
      id: nativeMenuItemId(row, item.id ?? ''),
      type: item.type ?? 'normal',
      label: item.label,
      enabled: item.enabled ?? true,
      visible: item.visible ?? true,
      checked: item.checked,
      // Tray is alternate access to commands already present in the app menu;
      // it must not register the same application accelerator a second time.
      accelerator: options.accelerators === false ? undefined : item.accelerator,
    }
    if (item.submenu !== undefined && item.submenu.length > 0) {
      opts.submenu = toElectronItems(row, item.submenu, options)
    } else if (item.id !== undefined) {
      const { seat, contributor } = row
      const actionId = item.id
      const wcId = row.wcId
      opts.click = () => {
        const wc = webContentsById(wcId)
        if (wc === undefined || wc.isDestroyed()) return
        wc.send(Ipc.seats.action, { seat, contributor, id: actionId } satisfies DesktopSeatAction)
      }
    }
    return opts
  })
}

function groupedPluginItems(
  rows: StoredContribution[],
  options?: { accelerators?: boolean },
): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  for (const row of rows) {
    if (row.items.length === 0) continue
    if (out.length > 0) out.push({ type: 'separator' })
    out.push(...toElectronItems(row, row.items, options))
  }
  return out
}

function rebuildApplicationMenu(): void {
  const appItems = sorted('applicationMenu', 'app').flatMap((row) =>
    toElectronItems(row, row.items),
  )
  const pluginItems = groupedPluginItems(sorted('applicationMenu', 'plugins'))
  // Electron 的 role 条目默认文案永远是英文（不做本地化，--lang=zh-CN 也不变），
  // 所以每一个 role 都要显式带 label 才会跟着语言走。
  const t = menuStrings(currentMenuLang())
  const template: MenuItemConstructorOptions[] = [
    ownerAppMenu(appItems, t),
    {
      label: t.edit,
      submenu: [
        { role: 'undo', label: t.undo },
        { role: 'redo', label: t.redo },
        { type: 'separator' },
        { role: 'cut', label: t.cut },
        { role: 'copy', label: t.copy },
        { role: 'paste', label: t.paste },
        { role: 'selectAll', label: t.selectAll },
      ],
    },
    {
      label: t.view,
      submenu: [
        { role: 'reload', label: t.reload },
        {
          label: t.restartService,
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            void restartDshWeb().catch((err: unknown) => {
              console.error('[DSH-Desktop] restart web failed', err)
            })
          },
        },
        { role: 'togglefullscreen', label: t.toggleFullScreen },
        ...(app.isPackaged
          ? []
          : ([
              { type: 'separator' },
              { role: 'toggleDevTools', label: t.toggleDevTools },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: t.window,
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: t.minimize },
        { role: 'zoom', label: t.zoom },
        { type: 'separator' },
        { role: 'front', label: t.bringAllToFront },
      ],
    },
    helpMenu(t),
  ]
  if (pluginItems.length > 0) {
    template.push({ label: t.plugins, submenu: pluginItems })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * 帮助菜单：DSH 运行时更新。
 *
 * 这一项的状态必须跟着安装过程走：pnpm 要跑一两分钟，期间文案切成「正在更新」
 * 并禁用入口，装好待重启时切成「重启以应用」。全程不给反馈的话，用户点完会以为
 * 菜单坏了。
 */
function helpMenu(t: MenuStrings): MenuItemConstructorOptions {
  const s = updateSummary()
  const item = dshUpdateItem(t, s)
  return {
    role: 'help',
    label: t.help,
    submenu: [item],
  }
}

/**
 * 运行时更新那一项：文案 / 禁用 / 动作都由当前状态决定。
 *
 * 没有更新时这一项不是死项，而是把已安装的运行时版本号显示出来——光一个禁用的
 * 「更新」看不出装的是哪个版本、也看不出到底有没有更新。
 *
 * 导出是为了让四种状态能被单测直接覆盖（见 menus/update-item.test.ts）。
 */
export function dshUpdateItem(
  t: MenuStrings,
  s: ReturnType<typeof updateSummary>,
): MenuItemConstructorOptions {
  if (s.dshUpdating) return { label: t.updatingDsh, enabled: false }
  if (s.dshPendingRestart !== null) {
    return {
      label: t.restartToApplyDsh.replace('{version}', s.dshPendingRestart),
      click: () => void applyPendingDshRuntime().catch(logDshFailure),
    }
  }
  if (s.dshUpdate !== null) {
    return {
      label: t.updateDshTo.replace('{version}', s.dshUpdate),
      click: () => void updateDshRuntime().catch(logDshFailure),
    }
  }
  // 已是最新：显示当前版本号。禁用是因为点下去没有可做的事。
  return {
    label: s.dsh === null ? t.dshNotInstalled : t.dshRuntime.replace('{version}', s.dsh),
    enabled: false,
  }
}

/**
 * 菜单点击是 fire-and-forget，不接住就是未处理 rejection。
 * 用户可见的错误框由 updates/bridge 统一弹一次，这里只留诊断日志，避免弹两遍。
 */
function logDshFailure(err: unknown): void {
  console.error('[DSH-Desktop] dsh runtime update failed', err)
}

/** 关于弹窗：显示版本，带一个「检查更新」按钮。 */
async function showAboutDialog(): Promise<void> {
  const t = menuStrings(currentMenuLang())
  const name = app.name || 'DSH-Desktop'
  const s = updateSummary()
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: t.aboutTitle.replace('{name}', name),
    detail: versionDetail(t, s),
    buttons: [t.checkUpdates, t.aboutClose],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) await checkAndShowDialog()
}

/** 查一轮更新并弹结果；下载按钮打开发布页，不在这里安装。 */
async function checkAndShowDialog(): Promise<void> {
  const t = menuStrings(currentMenuLang())
  await checkDesktopUpdates()
  const s = updateSummary()
  const hasUpdate = s.appUpdate !== null
  const buttons = hasUpdate ? [t.downloadLatest, t.aboutClose] : [t.aboutClose]
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: hasUpdate
      ? t.updateAvailable.replace('{update}', s.appUpdate ?? '')
      : t.upToDate.replace('{version}', s.app),
    detail: versionDetail(t, s),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  })
  if (hasUpdate && response === 0) void shell.openExternal(APP_RELEASES_URL)
}

/**
 * 版本详情两行：桌面版 + DSH 运行时。
 *
 * 运行时那行要区分三种状态：正在安装、装好待重启、正常运行。装好但没重启时，
 * 磁盘上是新版、跑着的是旧版，两行都说清楚才不会让人以为更新没生效。
 */
function versionDetail(t: MenuStrings, s: ReturnType<typeof updateSummary>): string {
  const name = app.name || 'DSH-Desktop'
  return [
    t.aboutDetail.replace('{name}', name).replace('{version}', s.app),
    dshRuntimeLine(t, s),
  ].join('\n')
}

function dshRuntimeLine(t: MenuStrings, s: ReturnType<typeof updateSummary>): string {
  if (s.dshUpdating) return t.updatingDsh
  if (s.dshPendingRestart !== null) {
    return t.dshPendingRestart
      .replace('{installed}', s.dshPendingRestart)
      .replace('{running}', s.dsh ?? t.dshNotInstalled)
  }
  return s.dsh === null ? t.dshNotInstalled : t.dshRuntime.replace('{version}', s.dsh)
}

function ownerAppMenu(
  pluginItems: MenuItemConstructorOptions[],
  t: MenuStrings,
): MenuItemConstructorOptions {
  const name = app.name || 'DSH-Desktop'
  const extra = pluginItems.length > 0 ? [...pluginItems, { type: 'separator' as const }] : []
  if (process.platform === 'darwin') {
    return {
      label: name,
      submenu: [
        { label: withAppName(t.about, name), click: () => void showAboutDialog() },
        {
          label: t.checkUpdates,
          accelerator: 'CmdOrCtrl+U',
          click: () => void checkAndShowDialog(),
        },
        { type: 'separator' },
        ...extra,
        { role: 'hide', label: withAppName(t.hide, name) },
        { role: 'hideOthers', label: t.hideOthers },
        { role: 'unhide', label: t.showAll },
        { type: 'separator' },
        { role: 'quit', label: withAppName(t.quit, name) },
      ],
    }
  }
  return {
    label: t.file,
    submenu: [
      { label: withAppName(t.about, name), click: () => void showAboutDialog() },
      { label: t.checkUpdates, accelerator: 'CmdOrCtrl+U', click: () => void checkAndShowDialog() },
      { type: 'separator' },
      ...extra,
      { role: 'quit', label: t.exit },
    ],
  }
}

function rebuildTray(): void {
  const rows = sorted('tray')
  const pluginItems = groupedPluginItems(rows, { accelerators: false })
  if (pluginItems.length === 0) {
    if (tray !== null) {
      tray.destroy()
      tray = null
    }
    return
  }
  const tooltip = rows.map((r) => r.tooltip).find((t) => t !== undefined) ?? 'DSH-Desktop'
  const t = menuStrings(currentMenuLang())
  const name = app.name || 'DSH-Desktop'
  const menu = Menu.buildFromTemplate([
    {
      label: withAppName(t.trayShow, name),
      click: () => focusMainWindow(),
    },
    { type: 'separator' },
    ...pluginItems,
    { type: 'separator' },
    { role: 'quit', label: withAppName(t.quit, name) },
  ])
  if (tray === null) {
    const iconFile = trayIconPath()
    const image = existsSync(iconFile)
      ? nativeImage.createFromPath(iconFile)
      : nativeImage.createEmpty()
    const sized = image.isEmpty() ? image : image.resize({ width: 18, height: 18 })
    tray = new Tray(sized)
    tray.on('click', () => focusMainWindow())
  }
  tray.setToolTip(tooltip)
  tray.setContextMenu(menu)
}

function scheduleRebuild(): void {
  // Contributions arrive as several sequential IPC calls. Reset the timer on
  // each call so macOS sees one native NSMenu replacement after the burst,
  // instead of repeatedly destroying live menus between individual seats.
  rebuildTimer = scheduleTrailing(
    rebuildTimer,
    () => {
      rebuildTimer = null
      rebuildApplicationMenu()
      rebuildTray()
    },
    REBUILD_DEBOUNCE_MS,
    {
      set: (task, delayMs) => setTimeout(task, delayMs),
      clear: (timer) => clearTimeout(timer),
      unref: (timer) => timer.unref?.(),
    },
  )
}

/** 窗口创建后 Electron 可能冲掉应用菜单；主窗口 ready-to-show 时再刷一次。 */
export function refreshDesktopSeats(): void {
  rebuildApplicationMenu()
  rebuildTray()
}

function watchSender(wc: WebContents): void {
  if (watchedWc.has(wc.id)) return
  watchedWc.add(wc.id)
  wc.once('destroyed', () => removeWindow(wc.id))
}

/** 声明席位、装 IPC、立刻渲染所有者自己的应用菜单。 */
export function setupDesktopSeats(): void {
  // 检测结果变了要重画菜单；用钩子注入，避免与 updates/bridge 循环依赖。
  setMenuRefreshHook(scheduleRebuild)

  ipcMain.handle(Ipc.seats.list, () => DECLARED_SEATS)

  ipcMain.handle(Ipc.seats.contribute, (event, raw: unknown) => {
    const spec = sanitizeContribution(raw)
    if (spec === null) {
      console.warn('[DSH-Desktop] rejected desktop contribution', raw)
      throw new Error('invalid desktop contribution')
    }
    const wc = event.sender
    const changed = upsertContribution(contributions, { wcId: wc.id, ...spec })
    watchSender(wc)
    if (changed) {
      console.log(
        `[DSH-Desktop] seat ${spec.seat}/${spec.menu} from ${spec.contributor} (${spec.items.length} items)`,
      )
      scheduleRebuild()
    }
  })

  ipcMain.handle(Ipc.seats.revoke, (event, seat: unknown, contributor: unknown) => {
    if (seat !== 'applicationMenu' && seat !== 'tray') return
    if (typeof contributor !== 'string' || !DESKTOP_ID_RE.test(contributor)) return
    remove(event.sender.id, seat, contributor)
    scheduleRebuild()
  })

  rebuildApplicationMenu()
}
