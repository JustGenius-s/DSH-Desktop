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
    │   ├── environment.ts     # 内置 node/pnpm、PATH、pnpm 执行
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

`preload.ts` 保持独立：沙箱中的 `require` 不能加载本地模块。它只在运行时
导入 `electron`，共享契约使用 `import type`；内联 IPC 常量由 `satisfies`
检查一致性。网页通知脚本在 preload 和主进程各保留一份，分别用于首次注入及
整页加载后的补注入，拆文件时不能直接给 preload 添加普通本地导入。

所有需要 preload 的窗口统一使用 `platform/paths.ts`，定位应用根目录下的
`dist/preload.js`，不依赖功能模块自身的 `__dirname`。应用入口仍是 `dist/main.js`。

## 验证

```sh
pnpm build       # 清理 dist 后编译，移除搬迁/删除文件留下的旧产物
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
- 共用实际重复的流程，例如 npm 渠道查询、Cookie 清理和重启文案类型。
  单次调用的简单表达式直接写在使用处；涉及平台兼容的分支保留说明。
- 异步操作在第一次 `await` 前设置并发保护；定时器、监听器在成功与超时路径都清理。
  IPC 初始化通过明确的注册状态保持幂等，不用普通事件监听数量推断 invoke 处理器。
- 修改行为时增加对应回归测试。沙箱 preload 的必要内联代码保留，并通过类型和测试
  检查契约一致性。
