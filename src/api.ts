/**
 * DSH-Desktop 插件契约。
 *
 * 这是 `window.dshDesktop` 的标准表面：四族能力，纯 JSON / 回调，
 * 不出现 Electron 类型。插件只应依赖本文件里的形状；菜单、托盘、
 * 通知、overlay 窗口与更新执行的原生实现都在主进程，与打包代码分开。
 *
 * 普通浏览器没有该对象。桌面壳以 contextIsolation preload 注入。
 *
 * ── 更新职责的划分（0.2.0 起）────────────────────────────────
 * 检测（查 GitHub Releases / npm registry、比版本、定期间隔）已迁到
 * dsh-desktop-update 插件的 host 半侧：它跑在 dsh web host 的 Node 进程里，
 * 没有 CORS 限制，也不依赖窗口开着。壳不再检测任何东西。
 *
 * 壳只保留只有它做得到的事——执行：报自己的版本号、跑 `pnpm add` 装运行时、
 * 打开下载页、重启。插件的 browser 半侧是唯一能同时触达两侧的地方，由它
 * 把「壳的版本」和「执行的成败」转交给插件 host 半侧。
 */

/** contributor 与条目 id：字母数字开头，最长 64。 */
export const DESKTOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

// ---------------------------------------------------------------------------
// updates — 只执行，不检测
// ---------------------------------------------------------------------------

/**
 * 桌面壳的更新执行器。
 *
 * 刻意不含任何「当前有没有更新」的状态：那是插件 host 半侧的领域，
 * 由它检测并广播。壳不知道也不需要知道 latest 是什么——`updateDsh` 的
 * 目标版本由调用方（插件）给出。
 */
export interface DshDesktopUpdates {
  /** 壳自身的打包版本（如 `0.2.0`）；插件需要它才能比较 App 更新。 */
  appVersion(): Promise<string>
  /** 打开浏览器到 App 的发布页（下载新版本）。 */
  downloadApp(): Promise<void>
  /** 把 DSH 运行时装成指定版本（pnpm add）；完成后需 relaunch 才生效。 */
  updateDsh(version: string): Promise<void>
  /** 重启应用。 */
  relaunch(): void
}

// ---------------------------------------------------------------------------
// seats — 持久贡献，fiber 同寿
// ---------------------------------------------------------------------------

export type DesktopSeatName = 'applicationMenu' | 'tray'

/** 应用菜单挂载点：app = 应用/文件菜单；plugins = Plugins 子菜单。 */
export type DesktopMenuAttach = 'app' | 'plugins'

export interface DesktopMenuItemSpec {
  id?: string
  type?: 'normal' | 'separator' | 'checkbox' | 'radio'
  label?: string
  accelerator?: string
  enabled?: boolean
  visible?: boolean
  checked?: boolean
  submenu?: DesktopMenuItemSpec[]
}

export interface DesktopContribution {
  seat: DesktopSeatName
  contributor: string
  menu?: DesktopMenuAttach
  order?: number
  tooltip?: string
  items: DesktopMenuItemSpec[]
}

export interface DesktopSeatAction {
  seat: DesktopSeatName
  contributor: string
  id: string
}

export interface DesktopSeatInfo {
  name: DesktopSeatName
  declared: true
  description: string
}

export interface DshDesktopSeats {
  list(): Promise<DesktopSeatInfo[]>
  contribute(contribution: DesktopContribution): Promise<void>
  revoke(seat: DesktopSeatName, contributor: string): Promise<void>
  onAction(listener: (action: DesktopSeatAction) => void): () => void
}

// ---------------------------------------------------------------------------
// notify — 一次性动作，不是席位
// ---------------------------------------------------------------------------

export interface DesktopNotifySpec {
  contributor: string
  id: string
  title: string
  body: string
  silent?: boolean
}

export interface DesktopNotifyAction {
  contributor: string
  id: string
}

export interface DesktopNotifyResult {
  shown: boolean
}

export interface DshDesktopNotify {
  /**
   * 弹出一条系统通知。同 contributor+id 替换，不堆叠。
   * 不支持或被限流时 `{ shown: false }`，不抛错。
   */
  show(spec: DesktopNotifySpec): Promise<DesktopNotifyResult>
  /** 关掉一条；省略 id 则关掉该 contributor 的全部。 */
  close(contributor: string, id?: string): Promise<void>
  /** 用户点击通知时回传 contributor+id；主进程同时前置窗口。 */
  onAction(listener: (action: DesktopNotifyAction) => void): () => void
}

// ---------------------------------------------------------------------------
// overlays — 同源原生小窗，跟贡献窗口同寿
// ---------------------------------------------------------------------------

export interface DesktopOverlayBounds {
  width: number
  height: number
  x?: number
  y?: number
}

export interface DesktopOverlayRect {
  x: number
  y: number
  width: number
  height: number
}

export type DesktopOverlayIgnoreMouse = 'none' | 'all' | 'forward'

export interface DesktopOverlayChrome {
  transparent?: boolean
  frame?: boolean
  alwaysOnTop?: boolean
  skipTaskbar?: boolean
  resizable?: boolean
  hasShadow?: boolean
  ignoreMouseEvents?: DesktopOverlayIgnoreMouse
}

export interface DesktopOverlayOpenSpec {
  contributor: string
  id: string
  /** 当前 DSH origin 的 path（如 `/whale-girl/overlay`）。 */
  url: string
  bounds: DesktopOverlayBounds
  chrome?: DesktopOverlayChrome
}

export interface DesktopOverlayUpdateSpec {
  bounds?: Partial<DesktopOverlayBounds>
  chrome?: DesktopOverlayChrome
}

export interface DesktopOverlayPoint {
  x: number
  y: number
}

export interface DesktopOverlayDelta {
  dx: number
  dy: number
}

export type DesktopOverlayMoveSpec = DesktopOverlayPoint | DesktopOverlayDelta

export interface DesktopOverlayMoveResult {
  x: number
  y: number
  hitEdge: boolean
}

export interface DesktopOverlayInfo {
  contributor: string
  id: string
  bounds: DesktopOverlayRect
}

export interface DesktopOverlayClosed {
  contributor: string
  id: string
}

export interface DshDesktopOverlays {
  /** 打开一扇同源 overlay；同一 contributor 再次 open 会替换旧窗。 */
  open(spec: DesktopOverlayOpenSpec): Promise<DesktopOverlayInfo>
  update(id: string, spec: DesktopOverlayUpdateSpec): Promise<DesktopOverlayInfo>
  /** 绝对坐标或 delta；越界会被 clamp，`hitEdge` 表示撞到屏边。 */
  move(id: string, spec: DesktopOverlayMoveSpec): Promise<DesktopOverlayMoveResult>
  setIgnoreMouseEvents(id: string, ignore: boolean, opts?: { forward?: boolean }): Promise<void>
  focus(id: string): Promise<void>
  close(id: string): Promise<void>
  list(): Promise<DesktopOverlayInfo[]>
  onClosed(listener: (event: DesktopOverlayClosed) => void): () => void
}

// ---------------------------------------------------------------------------
// plugins — 插件清单 / 启用禁用（启动失败恢复页）
// ---------------------------------------------------------------------------

/** 单个 bundle 插件在恢复页里的展示行。 */
export interface DesktopPluginInfo {
  /** bundle 包名（如 `@just-genius/dsh-desktop-update`）。 */
  name: string
  /** 是否启用（在 profile 的 `dsh.profile.bundles` 里）。 */
  enabled: boolean
  /** 核心 bundle（禁了 dsh 更起不来），界面上锁定。 */
  core: boolean
  /** 疑似导致本次启动失败的元凶（高亮，不自动禁用）。 */
  suspected: boolean
  /** 是否为桌面端自带插件的目录。 */
  desktopOwned: boolean
}

/** 启动失败归因结果：故障摘要 + 疑似元凶 bundle 列表。 */
export interface DesktopBootFailure {
  /** 最近一次启动失败的输出尾部（最多 5 行），用于展示。 */
  tail: string
  /** 疑似元凶 bundle 名（可能为空，此时不归因只列全部）。 */
  suspected: string[]
}

/** 插件清单 + 禁用/启用/重启。 */
export interface DshDesktopPlugins {
  /** 读全部插件（profile bundles 视图）。 */
  list(): Promise<{ plugins: DesktopPluginInfo[]; failure: DesktopBootFailure | null }>
  /** 启用/禁用一个 bundle；核心 bundle 拒绝。 */
  setEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>
  /** 清除桌面端维护的隔离记录（保留 bundles 现状）。 */
  clearFailure(): Promise<void>
  /** 重启应用（等同 relaunch）。 */
  relaunch(): void
}

// ---------------------------------------------------------------------------
// root
// ---------------------------------------------------------------------------

/**
 * 桌面壳注入到网页的标准 API。五族并列：
 * updates = 更新执行（检测已迁到插件 host 半侧）；seats = 持久原生 UI 贡献；
 * notify = 短暂系统通知；overlays = 同源原生小窗；plugins = 插件清单。
 */
export interface DshDesktop {
  updates: DshDesktopUpdates
  seats: DshDesktopSeats
  notify: DshDesktopNotify
  overlays: DshDesktopOverlays
  plugins: DshDesktopPlugins
}
