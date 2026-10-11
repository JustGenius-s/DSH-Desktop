<p align="center">
  <img src="../build/icon-app.png" width="128" alt="DSH-Desktop 应用图标" />
</p>

<p align="center">
  <a href="../README.md">English</a> ｜ <strong>简体中文</strong>
</p>

<h1 align="center">DSH-Desktop</h1>

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 Electron 桌面外壳。复用 Electron 内置 Node，通过随包 pnpm 把 `@deepseek-ai/dsh` 安装到 `~/.dsh/runtime`，并在浏览器窗口中运行 `dsh web` 界面。

<p align="center">
  <img src="../public/desktop.png" alt="DSH-Desktop 界面截图" />
</p>

## 下载与安装

预编译安装包发布在 [GitHub Releases](https://github.com/JustGenius-s/DSH-Desktop/releases)。首次启动会自动安装 DSH 运行时（约 1-2 分钟）。

### macOS

需要 macOS 13（Ventura）或更高版本。

1. 从最新 release 下载 `DSH-Desktop-*.dmg`。
2. 打开 `.dmg`，把 `DSH-Desktop.app` 拖进 `/Applications`。
3. 应用未签名，Gatekeeper 会拦截首次启动。右键应用 → **打开** 并确认，或运行：

```sh
xattr -dr com.apple.quarantine /Applications/DSH-Desktop.app
```

### Windows

需要 64 位 Windows。

1. 从最新 release 下载 `DSH-Desktop Setup *.exe`（安装包）或 `DSH-Desktop-*-win.zip`（便携版）。
2. 运行安装包，或解压后启动 `DSH-Desktop.exe`。
3. 构建未签名，SmartScreen 可能警告。点击 **更多信息** → **仍要运行**。

## 工作原理

```
Electron 主进程
  ├─ Electron 内置 Node（ELECTRON_RUN_AS_NODE）+ 随包 pnpm
  ├─ node/pnpm 命令转发器（resources/runtime；开发时用仓库根目录 runtime/）
  ├─ 首次启动：pnpm 安装 @deepseek-ai/dsh → ~/.dsh/runtime（可升级）
  ├─ 启动 dsh web --host 127.0.0.1 --port <空闲端口>
  └─ BrowserWindow → http://127.0.0.1:<端口>
```

DSH 在运行时从 npm 安装，不随应用打包。升级 DSH = 启动时检测到新版本 → 点击 "Update" → 可选择重启网页服务（桌面应用本身不退出），无需重新构建或签名。

## 开发

本机构建和测试建议使用 Node 24 LTS。测试命令使用递归 glob，macOS 启动测试还需要支持 `--no-use-system-ca`。

```sh
pnpm install
pnpm collect      # 收集 pnpm 和 Electron 命令转发器到 runtime/
pnpm start        # 首次启动会安装 @deepseek-ai/dsh（约 1-2 分钟）
pnpm dev          # start 的别名
```

开发和打包都使用当前 Electron 可执行文件和外部 `~/.dsh/runtime`，不再下载或携带独立 Node。插件通过 PATH 找到轻量 `node` 转发器；Electron 路径在每次启动时传入，更新或移动应用后不会沿用旧路径。

测试（不需要 Electron 窗口或浏览器）：

```sh
pnpm test         # 构建 + Vitest .ts 测试 + Node .cjs 测试
pnpm test:unit    # Vitest，test/unit/**，不需要构建
pnpm test:integration # 构建 + 所有 .cjs 测试
pnpm typecheck
pnpm check        # 格式检查 + 类型检查 + 构建 + 完整测试
```

测试命令会先清理并编译产物。模块职责、依赖方向和 Electron 启动约束见
[源码组织](../src/README.md)。

## 打包

```sh
pnpm dist:mac     # macOS dmg + zip
pnpm dist:win     # Windows nsis + zip（需在 Windows 上运行）
```

打包时会重新收集 pnpm 和转发器。Windows 构建需要对应架构的 MSVC Native Tools 环境及 Windows SDK，用于编译小型 `node.exe` 转发器。

macOS 产物默认采用 ad-hoc bundle 签名，尚未公证；Gatekeeper 可能拦截首次启动。允许方式：

```sh
xattr -dr com.apple.quarantine /Applications/DSH-Desktop.app
```

Developer ID 签名与公证步骤见 [macOS 签名说明](./signing-and-notarization.md)。

## 运行时依赖

- Node 由 Electron 提供；pnpm（最新）和命令转发器由 `scripts/collect-runtime.mjs` 收集
- `@deepseek-ai/dsh`（npm 最新版），安装到 `~/.dsh/runtime`

## 后续更新 Electron

升级时执行 `pnpm add -D -E electron@<版本>` 和 `pnpm check`，然后启动并验证打包后的应用。

转发器和原生插件构建均使用当前 Electron 的路径与版本，并保持 `runAsNode` fuse 启用。DSH 可能不支持新的 Node/V8 组合，旧 ABI 插件也可能需要重编译，发布前仍应验证界面、终端和插件安装。DSH 与 CLI 共用安装目录，不应把整个共享运行时统一重编译为 Electron。

## 桌面插件 API

壳把 `window.dshDesktop` 注入到 DSH 网页（`updates` / `seats` / `notify` / `overlays` / `plugins`）。插件应依赖这份契约，而不是 Electron 打包代码。见 [desktop-api.md](desktop-api.md)。

其中 `updates` 只做**执行**：壳负责报自己的版本、跑 `pnpm add` 装 DSH 运行时、打开下载页、重启。
更新检测与菜单展示由桌面壳完成：启动时查询 GitHub Releases 与 npm registry，
之后每 6 小时检查一次。网页侧保留更新执行和服务重启的调用契约。

## 我们的插件

配套 DSH 插件见 [DSH-Plugs](https://github.com/JustGenius-s/DSH-Plugs)。

## 致谢

- [Linux do](https://linux.do/)
