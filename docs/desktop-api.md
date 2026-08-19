# `window.dshDesktop` 插件契约

这是桌面壳注入到 DSH 网页的标准 API。插件只应依赖这里的形状；菜单、托盘、通知、更新检测、overlay 窗口的原生实现都在 Electron 主进程，与打包脚本分开。

源码真相：`src/api.ts`（类型）+ `src/preload.ts`（注入）+ `src/ipc.ts`（频道名，插件看不见）。

普通浏览器没有 `window.dshDesktop`。检测方式：

```ts
const desktop = window.dshDesktop
if (desktop === undefined) return // 非桌面壳，空操作
```

四族并列，不要把动作摊到根上，也不要把通知或 overlay 做成席位。

| 族 | 语义 | 寿命 |
|---|---|---|
| `updates` | 桌面更新领域动作 | 一次请求 |
| `seats` | 持久原生 UI 贡献（菜单 / 托盘） | 跟插件 fiber 同寿 |
| `notify` | 系统通知 | 弹出 / 替换 / 关掉 |
| `overlays` | 同源原生小窗（透明置顶等） | 跟贡献窗口同寿 |

主进程不跑 Cordis，也不把 `Menu` / `Tray` / `Notification` / `BrowserWindow` 对象交给网页。点击只回传 `{ contributor, id }`。

## `updates`

```ts
const state = await desktop.updates.getState()
const stop = desktop.updates.onState((next) => { /* ... */ })
await desktop.updates.checkNow()
await desktop.updates.downloadApp()
await desktop.updates.updateDsh()
await desktop.updates.skipVersion('app') // 或 'dsh'
await desktop.updates.setGate('dsh', false)
desktop.updates.relaunch()
```

`state.app` / `state.dsh` 为 `null` 表示该侧无待处理更新。自动检查开关写在 `~/.dsh/settings.yaml` 的 `desktop-update` 分节。

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
