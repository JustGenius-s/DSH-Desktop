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
 * 没有 CORS 限制，也不依赖窗口开着。
 *
 * 壳侧仍保留一套检测作为兼容层：已装插件可能还是 0.1.x（npm 上暂无
 * 0.2.0），它们只认 getState / checkNow / setGate / setDshChannel /
 * skipVersion；这些端点留着，旧插件不至于连更新徽章都拿不到。新插件
 * 走 host 半侧检测，只用下面四个「只有壳做得到」的执行端点。
 *
 * 壳独有的执行能力：报自己的版本号、跑 `pnpm add` 装运行时、打开下载页、
 * 热重启网页服务、重启整个应用。
 */

/** contributor 与条目 id：字母数字开头，最长 64。 */
export const DESKTOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

// ---------------------------------------------------------------------------
// updates — 执行（只有壳做得到）+ 兼容旧插件的检测层
// ---------------------------------------------------------------------------

/** App 本体或 DSH 运行时的一则可更新信息；无更新时为 null。 */
export interface DesktopUpdateInfo {
  current: string
  latest: string
  url?: string
}

/**
 * DSH 运行时更新渠道：npm dist-tag，或 `custom` 表示按精确版本匹配。
 * `alpha` 对应 npm 的 `alpha` dist-tag（上游发 alpha 时不会动 `latest`，
 * 不加这个渠道的话 alpha 版本永远不会出现在检测结果里）。
 */
export type DshChannel = 'latest' | 'next' | 'alpha' | 'custom'

/** 两个自动检查开关 + DSH 更新渠道（持久化在 DSH settings.yaml 的 desktop-update 分节）。 */
export interface DesktopUpdateConfig {
  checkApp: boolean
  checkDsh: boolean
  /** DSH 运行时匹配渠道；仅 `custom` 时 `dshVersion` 参与。 */
  dshChannel?: DshChannel
  /** 精确匹配的版本（dshChannel === 'custom' 时生效）。 */
  dshVersion?: string
}

/**
 * 壳侧兼容层的更新状态快照。
 *
 * 新插件不读它——检测在插件 host 半侧；这里只给 0.1.x 旧插件用，以及给
 * 壳自己判断「刚装完运行时、要不要问一句是否热重启」。
 */
export interface DesktopUpdateState {
  app: DesktopUpdateInfo | null
  dsh: DesktopUpdateInfo | null
  checking: boolean
  /** 正在执行 `pnpm add @deepseek-ai/dsh@…`。 */
  updatingDsh: boolean
  /** 更新过程中的进度/结果文案；空闲时为 null。 */
  updateMessage: string | null
  /** 运行时已装完新版本，需重启（热重启或整壳重启）才生效。 */
  needsRelaunch: boolean
  config: DesktopUpdateConfig
  /** 当前安装版本（无更新态弹层用；app 恒有值，dsh 未安装时为 null）。 */
  versions: { app: string; dsh: string | null }
}

export type DesktopUpdateKind = 'app' | 'dsh'

/** 询问热重启网页服务的原因。 */
export type DesktopRestartWebReason = 'plugin' | 'dsh-runtime'

/** 用户对热重启询问的选择。 */
export type DesktopRestartChoice = 'later' | 'restart'

/**
 * 主进程推到网页的热重启询问文案。由桌面插件用 DSH Modal 渲染，
 * 不要走系统原生 dialog。
 */
export interface DesktopRestartPrompt {
  id: string
  reason: DesktopRestartWebReason
  title: string
  message: string
  detail: string
  later: string
  restart: string
}

/**
 * 桌面壳的更新执行器 + 兼容层。
 *
 * 执行端点（appVersion / downloadApp / updateDsh / restartWeb / relaunch）
 * 是壳的正式契约：只有壳做得到这些事。`updateDsh` 的目标版本由调用方
 * （新插件）给出；兼容旧插件时不带版本也能调，壳自己解析渠道取版本。
 *
 * 检测端点（getState / onState / checkNow / setGate / setDshChannel /
 * skipVersion）仅为兼容 0.1.x 旧插件保留，新插件不要依赖。
 */
export interface DshDesktopUpdates {
  /** 壳自身的打包版本（如 `0.2.0`）；插件需要它才能比较 App 更新。 */
  appVersion(): Promise<string>
  /** 打开浏览器到 App 的发布页（下载新版本）。只接受 GitHub 地址。 */
  downloadApp(url?: string): Promise<void>
  /**
   * 把 DSH 运行时装成指定版本（pnpm add）。
   * 省略版本（旧插件）时按当前渠道解析；装完后可 restartWeb 生效，
   * 不强制整壳 relaunch。
   */
  updateDsh(version?: string): Promise<void>
  /** 热重启 dsh web 子进程并刷新窗口；Electron 壳不退出。 */
  restartWeb(): Promise<void>
  /** 重启整个桌面应用（壳 + 网页服务）。 */
  relaunch(): void

  // ---- 兼容层：仅 0.1.x 旧插件使用，新插件请用插件 host 半侧的检测 ----

  /** 读壳侧兼容层维护的更新状态快照。 */
  getState(): Promise<DesktopUpdateState>
  /** 订阅状态广播（旧插件的更新徽章靠它刷新）。 */
  onState(listener: (state: DesktopUpdateState) => void): () => void
  /** 立即检查一次并广播。 */
  checkNow(): Promise<DesktopUpdateState>
  /** 写 DSH 更新渠道；写后立即按新渠道重查并广播。 */
  setDshChannel(channel: DshChannel, version?: string): Promise<DesktopUpdateState>
  /** 「跳过该版本」：当前 latest 不再提示，出现更新的版本后恢复。 */
  skipVersion(kind: DesktopUpdateKind): Promise<void>
  /** 写一个自动检查开关。 */
  setGate(kind: DesktopUpdateKind, enabled: boolean): Promise<DesktopUpdateState>
  /** 订阅主进程的热重启询问；页面用 DSH 组件渲染。 */
  onPrompt(listener: (prompt: DesktopRestartPrompt) => void): () => void
  /** 页面已接到询问、即将展示 DSH Modal。 */
  ackPrompt(id: string): void
  /** 用户选择「稍后」或「立即重启服务」。 */
  respondPrompt(id: string, choice: DesktopRestartChoice): void
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
 * updates = 更新执行（检测在插件 host 半侧；壳侧另留一套兼容 0.1.x 旧插件
 * 的检测端点）；seats = 持久原生 UI 贡献；notify = 短暂系统通知；
 * overlays = 同源原生小窗；plugins = 插件清单。
 */
export interface DshDesktop {
  updates: DshDesktopUpdates
  seats: DshDesktopSeats
  notify: DshDesktopNotify
  overlays: DshDesktopOverlays
  plugins: DshDesktopPlugins
}
