# 源码组织

按进程与功能组织代码。根目录保留 Electron 的两个构建入口；主进程实现放在
`main/`，网页与主进程共用的契约放在 `shared/`。

```text
src/
├── main.ts                    # Electron 入口：先加载 TLS 补丁，再启动应用
├── preload.ts                 # 沙箱入口：暴露 window.dshDesktop
├── shared/
│   ├── api.ts                 # 桌面插件契约、JSON 类型、ID 约束
│   ├── ipc.ts                 # IPC 频道名
│   └── version.ts             # App 与 DSH 共用的版本比较
└── main/
    ├── app.ts                 # 冷启动、热重启、窗口交接、退出编排
    ├── restart.ts             # 服务控制注册、网页重启询问与回执
    ├── locale.ts              # 读取 DSH 用户语言偏好
    ├── runtime/               # DSH 服务与运行环境
    │   ├── paths.ts           # DSH_HOME 与外置运行时目录
    │   ├── environment.ts     # Electron Node 模式、工具 PATH、pnpm 执行
    │   ├── installation.ts    # 安装、版本读取、npm 渠道查询
    │   ├── host.ts            # 子进程启动/停止、就绪探测、日志尾部
    │   └── web-port.ts        # 回环端口分配与持久化
    ├── windows/               # 主窗口、启动页、角色注册、标题栏样式
    ├── platform/              # Electron 路径、会话清理、macOS CA/Dock 兼容
    ├── plugins/               # 配置监听、故障归因、插件恢复页
    ├── updates/               # App 更新检测、更新 IPC、更新状态
    ├── menus/                 # 菜单/托盘、贡献校验、菜单文案
    ├── notifications/         # 原生通知、横幅、网页 Notification 桥接
    └── overlays/              # 浮窗生命周期与请求校验
```

## 放置与依赖规则

- 新功能放进所属目录。功能内部的校验、展示、状态管理分开时，使用明确文件名，
  不增加通用 `utils`、`services` 目录或只做转发的 `index.ts`。
- `app.ts` 负责启动顺序和跨功能协调。窗口创建模块通过回调通知应用就绪/关闭；
  配置监听通过回调通知菜单语言刷新，插件模块不依赖菜单实现。
- `shared/` 不导入 Electron 或主进程模块。插件只依赖 `api.ts` 的契约；原生窗口、
  菜单与通知对象只存在于主进程。
- 功能间导入具体文件。通用底层能力保持单向依赖，例如运行时安装、语言读取和
  插件管理都从 `runtime/paths.ts` 获取 DSH home，版本比较统一用 `shared/version.ts`。
- 菜单和浮窗的网页输入校验分别放在 `menus/contributions.ts`、
  `overlays/validation.ts`，不依赖 Electron，便于独立测试。

## 必须保留的启动约束

1. `main.ts` 的 macOS TLS 补丁必须在加载应用模块前执行。
2. 开发版 `userData` 路径在 `app.whenReady()` 之前设置。
3. splash 与隐藏浮窗在启动阶段一起创建；主窗口就绪后关闭 splash，再放行浮窗。
4. 各功能 IPC 必须在主窗口 `loadURL()` 之前注册。
5. 主窗口导航规则每次读取当前 DSH origin，热重启换端口后仍保持同源限制。

`preload.ts` 通过 esbuild 将本地模块打包为一个文件，沙箱运行时只导入 `electron`。
IPC 常量直接复用 `shared/ipc.ts`。网页通知桥是普通 TypeScript 函数，使用
`contextBridge.executeInMainWorld` 安装；函数不能捕获外部变量，常量通过参数传入。
必须通过 `pnpm build` 构建，裸 `tsc` 输出不能用于运行。

主窗口、浮窗与恢复页使用 `platform/paths.ts` 定位 `dist/preload.js`。
启动页使用独立的 `dist/splash-preload.js`，仅通过 IPC 接收状态文字。
应用入口仍是 `dist/main.js`。

启动失败、服务异常退出、热重启失败与主窗口崩溃共用一个恢复窗口。
插件界面错误通过 Electron `console-message` 接收 DSH 当前的
`slot entry crashed` / `slot factory occurrence crashed` 报告，保留 DSH 的局部隔离。
这两类报告没有可靠的插件包名，因此只展示详情，不做包名归因或自动禁用；
升级 DSH 时需复核该报告格式。普通业务日志、点击回调和异步异常不走这个入口。

主窗口以固定名称 `dsh-main` 使用 Electron 的窗口状态持久化；首次采用默认尺寸，
之后恢复用户的尺寸、位置和显示状态，不额外强制最大化。浮窗使用独立缩放模式，
与主窗口共用会话但不共享页面缩放。

DSH、pnpm 和 node 转发器共用当前 `process.execPath`，仅在子进程设置 Node 模式。
原生模块构建也使用当前 Electron 版本与头文件；不要写死安装路径或版本。

## 验证

```sh
pnpm build       # 清理 dist 后编译，移除搬迁/删除文件留下的旧产物
pnpm start       # 编译后启动 Electron，支持 macOS、Windows 和 Linux
pnpm dev         # start 的别名；通过 -- 继续传递 Electron 参数
pnpm typecheck   # 源码及 TypeScript 测试的类型检查
pnpm test        # 自动构建，再运行 Vitest 与 node:test
pnpm format     # 按统一规则格式化源码、测试和构建脚本
pnpm check      # 格式检查、类型检查、构建及完整测试
```

测试继续集中在 `test/`。Vitest 覆盖纯函数和配置读取，`node:test` 覆盖编译产物、
端口持久化以及沙箱 preload 的契约；端口测试需要允许本机回环监听。

## 代码风格与精简原则

- `.editorconfig` 与 Prettier 统一使用两空格、单引号、无分号、LF 换行和 100 字符
  的目标行宽。提交前运行 `pnpm check`；格式检查也可单独用 `pnpm format:check`。
- TypeScript 持续检查未使用变量/参数、遗漏返回值和 switch 意外穿透。
  只有跨模块调用、诊断或独立测试需要的函数才导出；类型导入使用 `type` 修饰。
- 变量与函数用 camelCase，类型用 PascalCase，常量用 UPPER_SNAKE_CASE。
  `is` / `has` / `can` 前缀用于布尔判断；返回对象的查找函数用 `find` / `get`。
  文件路径、计时器等跨多行使用的变量用完整含义命名。
- 共用实际重复的流程，例如 npm 渠道查询、Cookie 清理和重启文案类型。
  单次调用的简单表达式直接写在使用处；涉及平台兼容的分支保留说明。
- 注释解释约束、兼容原因和失败处理，并与当前实现一致；删除过时流程和重复叙述。
- 命令通过参数数组启动子进程，不拼接 shell 命令。开发启动统一使用
  `scripts/start.mjs`，保留现有 `NODE_OPTIONS` 并追加 TLS 兼容选项。
- 异步操作在第一次 `await` 前设置并发保护；定时器、监听器在成功与超时路径都清理。
  IPC 初始化通过明确的注册状态保持幂等，不用普通事件监听数量推断 invoke 处理器。
- 通过类型检查和现有测试验证改动；新增测试遵循仓库的 `Agents.md` 约定。
