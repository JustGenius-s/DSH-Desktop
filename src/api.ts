/**
 * DSH-Desktop 插件契约。
 *
 * 这是 `window.dshDesktop` 的标准表面：四族能力，纯 JSON / 回调，
 * 不出现 Electron 类型。插件只应依赖本文件里的形状；菜单、托盘、
 * 通知、更新检测、overlay 窗口的原生实现都在主进程，与打包代码分开。
 *
 * 普通浏览器没有该对象。桌面壳以 contextIsolation preload 注入。
 */

/** contributor 与条目 id：字母数字开头，最长 64。 */
export const DESKTOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

// ---------------------------------------------------------------------------
// updates
// ---------------------------------------------------------------------------

/** App 本体或 DSH 运行时的一则可更新信息；无更新时为 null。 */
export interface DesktopUpdateInfo {
  current: string
  latest: string
  url?: string
}

/** DSH 运行时更新渠道：npm dist-tag，或 `custom` 表示按精确版本匹配。 */
export type DshChannel = 'latest' | 'next' | 'custom'

/** 两个自动检查开关 + DSH 更新渠道（持久化在 DSH settings.yaml 的 desktop-update 分节）。 */
export interface DesktopUpdateConfig {
  checkApp: boolean
  checkDsh: boolean
  /** DSH 运行时匹配渠道；仅 `custom` 时 `dshVersion` 参与。 */
  dshChannel?: DshChannel
  /** 精确匹配的版本（dshChannel === 'custom' 时生效）。 */
  dshVersion?: string
}

export interface DesktopUpdateState {
  app: DesktopUpdateInfo | null
  dsh: DesktopUpdateInfo | null
  checking: boolean
  config: DesktopUpdateConfig
  /** 当前安装版本（无更新态弹层用；app 恒有值，dsh 未安装时为 null）。 */
  versions: { app: string; dsh: string | null }
}

export type DesktopUpdateKind = 'app' | 'dsh'

export interface DshDesktopUpdates {
  /** 读取当前更新状态快照。 */
  getState(): Promise<DesktopUpdateState>
  /** 订阅更新状态变化；返回取消订阅函数。 */
  onState(listener: (state: DesktopUpdateState) => void): () => void
  /** 立即重新检测一次。 */
  checkNow(): Promise<DesktopUpdateState>
  /** 打开 App 新版本下载页（GitHub Releases）。 */
  downloadApp(): Promise<void>
  /** 把 DSH 运行时升到检测到的 latest（完成后需 relaunch）。 */
  updateDsh(): Promise<void>
  /** 写 DSH 更新渠道；写后立即按新渠道重查并广播。 */
  setDshChannel(channel: DshChannel, version?: string): Promise<DesktopUpdateState>
  /** 「跳过该版本」：当前 latest 不再提示，出现更新的版本后恢复。 */
  skipVersion(kind: DesktopUpdateKind): Promise<void>
  /** 写一个自动检查开关。 */
  setGate(kind: DesktopUpdateKind, enabled: boolean): Promise<DesktopUpdateState>
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
// root
// ---------------------------------------------------------------------------

/**
 * 桌面壳注入到网页的标准 API。四族并列：
 * updates = 领域动作；seats = 持久原生 UI 贡献；notify = 短暂系统通知；
 * overlays = 同源原生小窗。
 */
export interface DshDesktop {
  updates: DshDesktopUpdates
  seats: DshDesktopSeats
  notify: DshDesktopNotify
  overlays: DshDesktopOverlays
}
