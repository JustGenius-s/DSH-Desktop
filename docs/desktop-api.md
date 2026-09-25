# `window.dshDesktop` 插件契约

这是桌面壳注入到 DSH 网页的标准 API。插件只应依赖这里的形状；菜单、托盘、通知、overlay 窗口与更新的原生实现都在 Electron 主进程，与打包脚本分开。**更新检测与展示都在壳里**（启动自动查、之后每 6 小时一次），网页只能请求执行。

源码真相：`src/shared/api.ts`（类型）+ `src/preload.ts`（注入）+ `src/shared/ipc.ts`（频道名，插件看不见）。

普通浏览器没有 `window.dshDesktop`。检测方式：

```ts
const desktop = window.dshDesktop
if (desktop === undefined) return // 非桌面壳，空操作
```

四族并列，不要把动作摊到根上，也不要把通知或 overlay 做成席位。其中 `updates` 只做执行——检测在壳里。

| 族 | 语义 | 寿命 |
|---|---|---|
| `updates` | 更新执行（检测在壳里） | 一次请求 |
| `seats` | 持久原生 UI 贡献（菜单 / 托盘） | 跟插件 fiber 同寿 |
| `notify` | 系统通知 | 弹出 / 替换 / 关掉 |
| `overlays` | 同源原生小窗（透明置顶等） | 跟贡献窗口同寿 |

主进程不跑 Cordis，也不把 `Menu` / `Tray` / `Notification` / `BrowserWindow` 对象交给网页。点击只回传 `{ contributor, id }`。

## `updates`

**检测与展示在壳，执行也在壳。** 壳启动后自动查一轮：GitHub Releases
查 App 本体，npm 的 `@deepseek-ai/dsh` dist-tags 查 DSH 运行时——取**所有渠道里
版本最高的**（上游发 alpha/rc 时不动 `latest`，只看 latest 会漏掉更新的版本）。
之后每 6 小时一次。结果展示在应用菜单里：无更新显示当前版本号，有更新显示
`有更新：X`。没有任何渠道/开关配置。

网页这一族只剩执行——因为下面每件事都必须由打包好的桌面应用来做：

```ts
const version = await desktop.updates.appVersion()   // 壳的打包版本，如 '0.2.0'
await desktop.updates.downloadApp()                 // 用系统浏览器打开发布页
await desktop.updates.updateDsh('0.1.7-rc.1')       // pnpm 装指定版本（省略则装最高的）
await desktop.updates.restartWeb()                   // 热重启 dsh web，桌面壳不退出
desktop.updates.onPrompt((prompt) => { /* 用 DSH Modal 渲染 */ })
desktop.updates.ackPrompt(prompt.id)
desktop.updates.respondPrompt(prompt.id, 'later')    // 或 'restart'
desktop.updates.relaunch()                           // 重启整个桌面应用
```

要点：

- `updateDsh` 省略版本时，壳自己取所有 dist-tag 里最高的那个装上。
- `downloadApp()` 打开仓库 Releases 页，不接受 URL 参数——避免网页借壳打开任意 URL。
- `restartWeb()` 只杀掉并拉起 `dsh web` 子进程，再刷新主窗口；Electron 壳、席位、
  托盘都还在。装完 DSH 运行时、或插件配置变了之后，壳会通过 `onPrompt` 推一条
  询问，由插件用 DSH Modal 渲染「稍后 / 立即重启服务」——不是系统原生 dialog，
  也不强制。用户点「稍后」后同一份变更不再烦，再改才再问。

## `seats`

所有者（主进程）声明席位：`applicationMenu`、`tray`。插件只提交 JSON 规格。

```ts
await desktop.seats.contribute({
  seat: 'applicationMenu',
  contributor: 'desktop-update',
  menu: 'app',       // 或 'plugins'
  order: 20,
  items: [
    { id: 'check-now', label: '检查更新…', accelerator: 'CmdOrCtrl+Shift+U' },
  ],
})
await desktop.seats.contribute({
  seat: 'tray',
  contributor: 'desktop-update',
  tooltip: 'DSH-Desktop',
  items: [/* 同上 */],
})
const off = desktop.seats.onAction((action) => {
  if (action.contributor !== 'desktop-update') return
  // action.seat + action.id
})
await desktop.seats.revoke('applicationMenu', 'desktop-update')
await desktop.seats.revoke('tray', 'desktop-update')
```

约束（主进程消毒，非法贡献抛错）：

- `contributor` / 条目 `id`：字母数字开头，最长 64
- 每份贡献最多 24 项，子菜单深度最多 2
- 标签最长 120
- 窗口销毁时该窗口的贡献自动卸掉

**菜单语言**：壳自己的条目（应用菜单、Edit / View / Window，以及 About / Hide / Quit
这些 role 条目——Electron 的 role 默认文案永远是英文）按 DSH 用户设置里的语言偏好取词
（web profile 的 `locale.preference`），没设置过时回落系统语言；改语言后壳会立刻重建菜单，
不需要热重启。

**贡献条目的文案由贡献方自带**：请按 DSH 当前界面语言（`ctx.locale` 的 active，
*不要*用 `navigator.language`）取词，并在语言变化时用新文案重新 `contribute`
（同 contributor 覆盖），否则菜单会出现中英混排。

## `notify`

不是席位：没有合并重建。同 `contributor`+`id` 替换，不堆叠。

```ts
const { shown } = await desktop.notify.show({
  contributor: 'desktop-update',
  id: 'update-ready',
  title: 'DSH-Desktop — 有可用更新',
  body: '下载桌面版 0.1.2…',
})
const off = desktop.notify.onAction((action) => {
  if (action.contributor !== 'desktop-update') return
  // 用户点了通知；主进程已前置窗口
})
await desktop.notify.close('desktop-update', 'update-ready')
await desktop.notify.close('desktop-update') // 该 contributor 全部
```

- 不支持或被限流时 `{ shown: false }`，规格非法才抛错
- 每个 contributor 最多 3 条同时存在；新 id 间隔至少 10 秒
- 标题最长 80，正文最长 240
- 插件卸载时应 `close(contributor)`

macOS 打包包在 `Info.plist` 里声明了 `NSUserNotificationAlertStyle=alert`。开发态 `pnpm start` 走 Electron 二进制，通知可能显示为 Electron，系统也可能先问权限。

网页里的 `new Notification()`（例如 `dsh-notification` 插件）由主窗口 preload 接到本族原生通知。Chromium 自己的 Notification API 在桌面壳里会显示已授权、却不向系统申请 UNUserNotificationCenter，横幅被静默丢掉。

## `overlays`

主进程开一扇同源小窗。插件只交 JSON：URL、尺寸、窗口铬（透明 / 置顶 / 点穿）。拿不到 `BrowserWindow`。

```ts
const info = await desktop.overlays.open({
  contributor: 'whale-girl',
  id: 'pet',
  url: '/whale-girl/overlay',
  bounds: { width: 160, height: 160 },
  chrome: {
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    ignoreMouseEvents: 'forward', // none | all | forward
  },
})
const off = desktop.overlays.onClosed((event) => {
  if (event.contributor !== 'whale-girl') return
  // event.id
})
await desktop.overlays.move('pet', { dx: 12, dy: 0 }) // 或 { x, y }；撞屏返回 hitEdge
await desktop.overlays.setIgnoreMouseEvents('pet', true, { forward: true })
await desktop.overlays.update('pet', { bounds: { width: 180, height: 180 } })
await desktop.overlays.close('pet')
```

约束（主进程消毒，非法规格抛错）：

- `contributor` / `id`：字母数字开头，最长 64
- 每个 contributor 同时最多 1 扇；再次 `open` 替换旧窗
- `url` 必须是当前 DSH origin 的 path（`/foo`），禁止 `file:` / `data:` / 远程 / `..`
- 宽高夹在 64–800；位置 clamp 到可见工作区
- overlay 窗口也注入 `window.dshDesktop`，渲染页可 `move` / `setIgnoreMouseEvents` / `close` 自己
- overlay 不能再开另一扇 overlay
- 贡献窗口销毁或主窗口关闭时，该窗口开的 overlay 自动卸掉
- overlay 不能单独续命应用：主窗口关了，应用退出
- `transparent` / `frame` 只在 `open` 时生效，`update` 改不了
