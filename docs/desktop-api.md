# `window.dshDesktop` 插件契约

这是桌面壳注入到 DSH 网页的标准 API。插件只应依赖这里的形状；菜单、托盘、通知、更新检测的原生实现都在 Electron 主进程，与打包脚本分开。

源码真相：`src/api.ts`（类型）+ `src/preload.ts`（注入）+ `src/ipc.ts`（频道名，插件看不见）。

普通浏览器没有 `window.dshDesktop`。检测方式：

```ts
const desktop = window.dshDesktop
if (desktop === undefined) return // 非桌面壳，空操作
```

三族并列，不要把动作摊到根上，也不要把通知做成席位。

| 族 | 语义 | 寿命 |
|---|---|---|
| `updates` | 桌面更新领域动作 | 一次请求 |
| `seats` | 持久原生 UI 贡献（菜单 / 托盘） | 跟插件 fiber 同寿 |
| `notify` | 系统通知 | 弹出 / 替换 / 关掉 |

主进程不跑 Cordis，也不把 `Menu` / `Tray` / `Notification` 对象交给网页。点击只回传 `{ contributor, id }`。

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
