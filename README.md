# DSH-Decktop

DeepSeek Harness（DSH）的 Electron 桌面壳：内置 node + pnpm，把 `@deepseek-ai/dsh`
装到 `~/.dsh/runtime`，启动 `dsh web` 并用浏览器窗口呈现 Web UI。

## 架构

```
Electron 主进程 (src/main.ts)
  ├─ 内置 node + pnpm（打包进 resources/runtime，dev 模式在仓库根 runtime/）
  ├─ 首启：用内置 pnpm 装 @deepseek-ai/dsh 到 ~/.dsh/runtime（可升级）
  ├─ spawn  dsh web --host 127.0.0.1 --port <free-port>   (src/dsh-host.ts)
  └─ BrowserWindow ──加载──▶ http://127.0.0.1:<port>
```

DSH 本体不随 App 发布，从 npm 动态安装到 `~/.dsh/runtime`。升级 DSH =
启动时检测新版本 → 弹窗「立即更新」→ 重启，无需重新打包、签名。

## 目录

- `src/` — Electron 主进程：
  - `main.ts` — 窗口编排、splash、自动检测/手动更新
  - `dsh-host.ts` — 端口分配、spawn、就绪探测
  - `runtime-manager.ts` — 内置 node/pnpm 定位、安装/检测/升级 `@deepseek-ai/dsh`
- `scripts/collect-runtime.mjs` — 打包时下载最新 node + pnpm 到 `runtime/`
- `build/` — 图标与 splash 页
- `runtime/` — collect 生成（gitignored），内置 node + pnpm

## 开发运行

开发与打包行为一致：都用内置 node + 外置 `~/.dsh/runtime`。

```sh
pnpm install
pnpm collect       # 下载 node + pnpm 到 runtime/
pnpm start         # 首启会自动装 @deepseek-ai/dsh（约 1-2 分钟）
```

## 打包

```sh
pnpm dist:mac      # macOS dmg + zip
pnpm dist:win      # Windows nsis + zip（建议在 Windows 机器上执行）
```

macOS 产物未做 Developer ID 签名与公证，首次打开会被 Gatekeeper 拦截，放行：

```sh
xattr -dr com.apple.quarantine /Applications/DSH-Deck.app
```

## 依赖

- 运行时：内置 node（最新）+ pnpm（最新）
- DSH：`@deepseek-ai/dsh`（npm 最新版，装到 `~/.dsh/runtime`）
