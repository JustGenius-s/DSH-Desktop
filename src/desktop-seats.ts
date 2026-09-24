/**
 * 桌面席位所有者：主进程声明 `applicationMenu` / `tray`，把插件的声明式
 * 贡献渲染成原生菜单。对应 DSH 的 slot 模型——所有者声明席位，贡献方只
 * 注入规格，点击以 id 回传给贡献窗口；贡献方卸掉（revoke 或窗口销毁）后
 * 条目消失。主进程不跑 Cordis，也不把 Electron Menu/Tray 对象暴露给网页。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  app,
  dialog,
  ipcMain,
  shell,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import {
  DESKTOP_ID_RE,
  type DesktopMenuAttach,
  type DesktopMenuItemSpec,
  type DesktopSeatAction,
  type DesktopSeatInfo,
  type DesktopSeatName,
} from './api'
import { restartDshWeb } from './dsh-lifecycle'
import { Ipc } from './ipc'
import { menuStrings, withAppName, type MenuStrings } from './menu-i18n'
import { dshHome } from './runtime-manager'
import { checkDesktopUpdates, RELEASES_FALLBACK, setMenuRefreshHook, updateDshRuntime } from './desktop-bridge'
import { updateSummary } from './update-state'
import { currentShellLang, type ShellLang } from './shell-locale'
import { focusMainWindow, webContentsById } from './windows'

export type {
  DesktopContribution,
  DesktopMenuAttach,
  DesktopMenuItemSpec,
  DesktopSeatAction,
  DesktopSeatInfo,
  DesktopSeatName,
} from './api'

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

const MAX_ITEMS = 24
const MAX_DEPTH = 2
const MAX_LABEL = 120
const ID_RE = DESKTOP_ID_RE
const ACCEL_RE =
  /^(?:(?:CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|AltGr|Shift|Super|Meta)\+)*(?:[A-Za-z0-9]+|F(?:[1-9]|1[0-9]|2[0-4])|Plus|Space|Tab|Backspace|Delete|Return|Enter|Up|Down|Left|Right)$/

interface StoredContribution {
  wcId: number
  seat: DesktopSeatName
  contributor: string
  menu: DesktopMenuAttach
  order: number
  tooltip: string | undefined
  items: DesktopMenuItemSpec[]
}

const contributions: StoredContribution[] = []
const watchedWc = new Set<number>()
let tray: Tray | null = null
let rebuildTimer: NodeJS.Timeout | null = null
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
 * 由 plugin-config-watch 在 cordis.patch.yml 变化时调用。
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

function sanitizeItems(raw: unknown, depth: number): DesktopMenuItemSpec[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS || depth > MAX_DEPTH) return null
  const out: DesktopMenuItemSpec[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return null
    const item = entry as Record<string, unknown>
    if (item.type === 'separator') {
      out.push({ type: 'separator' })
      continue
    }
    const type =
      item.type === 'checkbox' || item.type === 'radio' || item.type === 'normal'
        ? item.type
        : 'normal'
    if (typeof item.id !== 'string' || !ID_RE.test(item.id)) return null
    if (typeof item.label !== 'string' || item.label.length === 0 || item.label.length > MAX_LABEL) {
      return null
    }
    const spec: DesktopMenuItemSpec = {
      id: item.id,
      type,
      label: item.label,
    }
    if (typeof item.enabled === 'boolean') spec.enabled = item.enabled
    if (typeof item.visible === 'boolean') spec.visible = item.visible
    if (typeof item.checked === 'boolean') spec.checked = item.checked
    if (typeof item.accelerator === 'string' && ACCEL_RE.test(item.accelerator)) {
      spec.accelerator = item.accelerator
    }
    if (item.submenu !== undefined) {
      const nested = sanitizeItems(item.submenu, depth + 1)
      if (nested === null) return null
      spec.submenu = nested
    }
    out.push(spec)
  }
  return out
}

function sanitizeContribution(raw: unknown): Omit<StoredContribution, 'wcId'> | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (obj.seat !== 'applicationMenu' && obj.seat !== 'tray') return null
  if (typeof obj.contributor !== 'string' || !ID_RE.test(obj.contributor)) return null
  const items = sanitizeItems(obj.items, 0)
  if (items === null) return null
  const menu: DesktopMenuAttach = obj.menu === 'app' ? 'app' : 'plugins'
  const order = typeof obj.order === 'number' && Number.isFinite(obj.order) ? obj.order : 0
  const tooltip =
    typeof obj.tooltip === 'string' && obj.tooltip.length > 0 && obj.tooltip.length <= MAX_LABEL
      ? obj.tooltip
      : undefined
  return { seat: obj.seat, contributor: obj.contributor, menu, order, items, tooltip }
}

function sameContribution(a: StoredContribution, b: Pick<StoredContribution, 'wcId' | 'seat' | 'contributor' | 'menu'>): boolean {
  return a.wcId === b.wcId && a.seat === b.seat && a.contributor === b.contributor && a.menu === b.menu
}

function upsert(row: StoredContribution): void {
  const idx = contributions.findIndex((c) => sameContribution(c, row))
  if (idx >= 0) contributions[idx] = row
  else contributions.push(row)
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
): MenuItemConstructorOptions[] {
  return items.map((item) => {
    if (item.type === 'separator') return { type: 'separator' }
    const opts: MenuItemConstructorOptions = {
      id: `${row.contributor}:${item.id ?? ''}`,
      type: item.type ?? 'normal',
      label: item.label,
      enabled: item.enabled ?? true,
      visible: item.visible ?? true,
      checked: item.checked,
      accelerator: item.accelerator,
    }
    if (item.submenu !== undefined && item.submenu.length > 0) {
      opts.submenu = toElectronItems(row, item.submenu)
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

function groupedPluginItems(rows: StoredContribution[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  for (const row of rows) {
    if (row.items.length === 0) continue
    if (out.length > 0) out.push({ type: 'separator' })
    out.push(...toElectronItems(row, row.items))
  }
  return out
}

function rebuildApplicationMenu(): void {
  const appItems = sorted('applicationMenu', 'app').flatMap((row) => {
    const built = toElectronItems(row, row.items)
    return built.length === 0 ? [] : built
  })
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


/** 帮助菜单：DSH 运行时更新。 */
function helpMenu(t: MenuStrings): MenuItemConstructorOptions {
  const s = updateSummary()
  return {
    role: 'help',
    label: t.help,
    submenu: [
      { label: t.updateDsh, enabled: s.dshUpdate !== null, click: () => void updateDshRuntime() },
    ],
  }
}

/** 关于弹窗：显示版本，带一个「检查更新」按钮。 */
export async function showAboutDialog(): Promise<void> {
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

/** 查一轮更新并弹结果：有更新给「下载并安装」，否则只说当前版本。 */
export async function checkAndShowDialog(): Promise<void> {
  const t = menuStrings(currentMenuLang())
  await checkDesktopUpdates()
  const s = updateSummary()
  const hasUpdate = s.appUpdate !== null
  const buttons = hasUpdate ? [t.downloadLatest, t.aboutClose] : [t.aboutClose]
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: hasUpdate ? t.updateAvailable.replace('{update}', s.appUpdate ?? '') : t.upToDate.replace('{version}', s.app),
    detail: versionDetail(t, s),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  })
  if (hasUpdate && response === 0) void shell.openExternal(RELEASES_FALLBACK)
}

/** 版本详情两行：桌面版 + DSH 运行时。 */
function versionDetail(t: MenuStrings, s: ReturnType<typeof updateSummary>): string {
  const name = app.name || 'DSH-Desktop'
  return [
    t.aboutDetail.replace('{name}', name).replace('{version}', s.app),
    s.dsh === null ? t.dshNotInstalled : t.dshRuntime.replace('{version}', s.dsh),
  ].join('\n')
}

function ownerAppMenu(
  pluginItems: MenuItemConstructorOptions[],
  t: MenuStrings,
): MenuItemConstructorOptions {
  const name = app.name || 'DSH-Desktop'
  const extra =
    pluginItems.length > 0 ? [...pluginItems, { type: 'separator' as const }] : []
  if (process.platform === 'darwin') {
    return {
      label: name,
      submenu: [
        { label: withAppName(t.about, name), click: () => void showAboutDialog() },
        { label: t.checkUpdates, accelerator: 'CmdOrCtrl+U', click: () => void checkAndShowDialog() },
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
  const pluginItems = groupedPluginItems(rows)
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
    const image = existsSync(iconFile) ? nativeImage.createFromPath(iconFile) : nativeImage.createEmpty()
    const sized = image.isEmpty() ? image : image.resize({ width: 18, height: 18 })
    tray = new Tray(sized)
    tray.on('click', () => focusMainWindow())
  }
  tray.setToolTip(tooltip)
  tray.setContextMenu(menu)
}

function scheduleRebuild(): void {
  if (rebuildTimer !== null) return
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null
    rebuildApplicationMenu()
    rebuildTray()
  }, 16)
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
  // 检测结果变了要重画菜单；用钩子注入，避免与 desktop-bridge 循环依赖。
  setMenuRefreshHook(() => scheduleRebuild())

  ipcMain.handle(Ipc.seats.list, () => DECLARED_SEATS)

  ipcMain.handle(Ipc.seats.contribute, (event, raw: unknown) => {
    const spec = sanitizeContribution(raw)
    if (spec === null) {
      console.warn('[DSH-Desktop] rejected desktop contribution', raw)
      throw new Error('invalid desktop contribution')
    }
    const wc = event.sender
    upsert({ wcId: wc.id, ...spec })
    watchSender(wc)
    console.log(
      `[DSH-Desktop] seat ${spec.seat}/${spec.menu} from ${spec.contributor} (${spec.items.length} items)`,
    )
    scheduleRebuild()
  })

  ipcMain.handle(Ipc.seats.revoke, (event, seat: unknown, contributor: unknown) => {
    if (seat !== 'applicationMenu' && seat !== 'tray') return
    if (typeof contributor !== 'string' || !ID_RE.test(contributor)) return
    remove(event.sender.id, seat, contributor)
    scheduleRebuild()
  })

  rebuildApplicationMenu()
}
