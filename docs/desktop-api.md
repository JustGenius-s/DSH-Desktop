# `window.dshDesktop` 插件契约

这是桌面壳注入到 DSH 网页的标准 API。插件只应依赖这里的形状；菜单、托盘、通知、overlay 窗口与更新**执行**的原生实现都在 Electron 主进程，与打包脚本分开。**更新检测不在壳里**——见下文 `updates`。

源码真相：`src/api.ts`（类型）+ `src/preload.ts`（注入）+ `src/ipc.ts`（频道名，插件看不见）。

普通浏览器没有 `window.dshDesktop`。检测方式：

```ts
const desktop = window.dshDesktop
if (desktop === undefined) return // 非桌面壳，空操作
```

四族并列，不要把动作摊到根上，也不要把通知或 overlay 做成席位。其中 `updates` 只做执行——检测在插件里。

| 族 | 语义 | 寿命 |
|---|---|---|
| `updates` | 更新执行（检测已迁到插件 host 半侧） | 一次请求 |
| `seats` | 持久原生 UI 贡献（菜单 / 托盘） | 跟插件 fiber 同寿 |
| `notify` | 系统通知 | 弹出 / 替换 / 关掉 |
| `overlays` | 同源原生小窗（透明置顶等） | 跟贡献窗口同寿 |

主进程不跑 Cordis，也不把 `Menu` / `Tray` / `Notification` / `BrowserWindow` 对象交给网页。点击只回传 `{ contributor, id }`。

## `updates`

**检测在插件，执行在壳。** 检测（查 GitHub Releases / npm registry、比较版本、定期间隔、
「跳过该版本」记录）在 [dsh-desktop-update](https://github.com/JustGenius-s/DSH-Plugs)
插件的 **host 半侧**：它跑在 dsh web host 的 Node 进程里，没有 CORS 限制，也不依赖
某个窗口开着。插件通过自己的同源路由（`/dsh-desktop-update/state` 等）把结果提供给
网页。新插件请用那条路。

壳这族只留只有打包好的桌面应用做得到的事——**执行**：

```ts
const version = await desktop.updates.appVersion()   // 壳的打包版本，如 '0.2.0'
await desktop.updates.downloadApp(url)               // 用系统浏览器打开发布页
await desktop.updates.updateDsh('0.1.2-alpha.3')     // pnpm 装指定版本
await desktop.updates.restartWeb()                   // 热重启 dsh web，桌面壳不退出
desktop.updates.onPrompt((prompt) => { /* 用 DSH Modal 渲染 */ })
desktop.updates.ackPrompt(prompt.id)
desktop.updates.respondPrompt(prompt.id, 'later')    // 或 'restart'
desktop.updates.relaunch()                           // 重启整个桌面应用
```

要点：

- `updateDsh` 的目标版本由新插件给出；壳不知道 latest 是什么，也不判断该不该更新。
- 执行进度不由壳广播。插件的 browser 半侧驱动执行后，把成败回报给它自己的
  host 半侧（`POST /dsh-desktop-update/exec`），因此进度跨窗口一致，刷新页面也不丢。
- `downloadApp(url)` 只接受 `https://github.com/` 开头的地址，否则回落到仓库
  Releases 页——避免网页借壳打开任意 URL。
- `restartWeb()` 只杀掉并拉起 `dsh web` 子进程，再刷新主窗口；Electron 壳、席位、
  托盘都还在。装完 DSH 运行时、或插件配置变了之后，壳会通过 `onPrompt` 推一条
  询问，由插件用 DSH Modal 渲染「稍后 / 立即重启服务」——不是系统原生 dialog，
  也不强制。用户点「稍后」后同一份变更不再烦，再改才再问。

### 兼容层（0.1.x 旧插件）

npm 上暂无 `dsh-desktop-update@0.2.0`，已装的插件还是 0.1.x，只认壳侧的这批端点。
它们保留到 0.2.0 插件发布为止（见 `scripts/install-desktop-plugin.mjs` 的
`REQUIRED_VERSION`），**新插件不要依赖**：

```ts
const state = await desktop.updates.getState()
const stop = desktop.updates.onState((next) => { /* ... */ })
await desktop.updates.checkNow()
await desktop.updates.setDshChannel('next')          // 或 'latest' / 'alpha' / 'custom'
await desktop.updates.skipVersion('app')             // 或 'dsh'
await desktop.updates.setGate('dsh', false)
```

兼容层的状态与配置写在 `~/.dsh/settings.yaml` 的 `desktop-update` 分节，壳自己
watch 并 6 小时轮询一次；`updateDsh()` 不传版本时由壳按当前渠道解析。

浏览器半侧是唯一同时触达两侧（壳的 preload 与 host 的路由）的地方，所以由它
摆渡两件谁都做不了的事：把壳的版本号交给 host（检测 App 更新要用），把执行
结果交给 host（进度要共享）。

主进程还监听 `~/.dsh/profiles/web/` 下的 `package.json`、`cordis.patch.yml`、
`cordis.yml`：配置变了但当前网页服务还没加载时，通过 `onPrompt` 让桌面插件用
DSH Modal 询问「稍后 / 立即重启服务」（不是系统原生 dialog）。同一份变更点
「稍后」后不再烦，再改才再问。插件安装/升级、DSH 运行时更新也走同一套询问，
不强制。`relaunch()` 才会退出并拉起整个桌面应用。

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
