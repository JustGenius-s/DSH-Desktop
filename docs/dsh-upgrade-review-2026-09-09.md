# DSH 0.1.2-rc.1 -> 0.1.5-alpha.1 升级评估

检查日期：2026-09-09（Asia/Shanghai）。

## 结论

**新版通过了临时环境的安装和 Web 服务启动冒烟，但不足以认定当前主环境可以无风险升级。建议主环境暂留 0.1.2-rc.1，完成停服备份和真实数据副本验证后再试用 alpha。**

这是 `@deepseek-ai/dsh` 运行时升级，不是把 DSH-Desktop 桌面壳升级到同一版本号。此次没有执行主环境升级，也没有停止真实 DSH 服务；临时测试服务已退出。

## 发布范围

官方 npm 查询结果：

| 项目 | 结果 |
| --- | --- |
| 本机安装版本 | `0.1.2-rc.1` |
| `latest` | `0.1.2-rc.1` |
| `next` | `0.1.2-rc.1` |
| `alpha` | `0.1.5-alpha.1` |
| 旧版发布时间 | 2026-09-03 14:21:52，UTC+8 |
| 新版发布时间 | 2026-09-08 23:57:30，UTC+8 |

版本来源为官方 npm 元数据，不以预发布版本号的大小推断稳定性。`latest` 指向的旧版本本身仍是 RC，不应称为正式稳定版。[S1]

官方源码比较端点：[S2]

- `dsh-v0.1.2-rc.1`：`a66e4702047846cdaa10c66c9d3df3951f5ea70d`
- `dsh-v0.1.5-alpha.1`：`5dda764ed3aa172535a7967b06ff95d9cbfe536a`

## 主要更新

以下是两端源码差异和合入记录的重点摘要，不是完整发布流水账。

| 方向 | 变化 | 依据 |
| --- | --- | --- |
| 会话数据 | 新增会话格式 v3；系统提示词成为会话历史节点；历史 `code` 预设引用转换为 `ptc`；相关事件和引用同步迁移 | [S3] [S4] |
| 性能与恢复 | 流式历史迁移、只读迁移准备、会话事件按需处理和客户端流处理优化；持久化写入租约、收件箱恢复等改动 | [S3] [S6] |
| Web 功能 | 通用文件上传、工作区侧栏、从 Web 打开本地应用；相关 SSH 和工作区浏览问题修复 | [S6] |
| 交互修复 | Web 重连、发送队列、忙碌时发送按钮、滚动跟随、Goal 恢复和子代理控制等修复 | [S6] |
| 网络与 CLI | 新增 HTTP 代理组件；代理环境变量及启动 `.env` 层可直接生效；新增 `--from-default-profile` 创建自定义 profile | [S5] |
| 日志上传 | DeepSeek 会话日志贡献与 OTel 上传分开控制；OTel 默认反馈门控；`DSH_TELEMETRY_MODE=FULL` 不再受支持 | [S5] |

CLI 顶层依赖集合未删除旧模块，新增运行时依赖为 `@deepseek-ai/dsh-http-proxy`。Web 别名和应用参数透传仍存在；实际冒烟也使用了桌面当前的 `web --host ... --port ... --no-open` 参数组合。[S5] [S7]

## 主要风险

### 1. 数据迁移不等于可无损降级

官方方案保留已经提交的旧代际文件，不移动、覆盖或删除原件。历史只读打开可以先在内存中使用迁移结果；写入打开需要在追加数据前完成新代际的发布。拒绝迁移时保留源字节，不发布新代际。[S3] [S4]

但官方明确不承诺降级兼容或自动回退。新版本续写的历史不能假定可由旧 runtime 读取。因此，仅重装旧 npm 包不是完整的数据回滚方案。[S3]

本机只抽样检查了一个历史目录，看到 `session.jsonl.zstd`。这能证明存在旧格式数据，不能代表全部会话或当前版本的 writer 格式。没有对真实会话副本执行迁移或恢复验证。

历史转换对未知事件、未经审计的字段和某些不一致记录会拒绝迁移；有自定义插件记录的历史尤其需要用副本验证。拒绝本身不等于文件已被破坏。[S4]

### 2. 桌面源码中的更新不是事务式切换

已检查的仓库 `HEAD` 中，`updateDsh()` 直接在 runtime 目录执行 `pnpm add`，没有在该流程中建立完整备份或自动回滚。安装后可选择热重启；重启实现先停止旧进程，再尝试启动新进程，失败时没有恢复旧 runtime 的逻辑。[S8]

这是对仓库源码的结论；没有展开已安装应用的 `app.asar` 来证明其实现与该提交完全相同。

### 3. 插件完整兼容性仍未验证

当前 Web profile 包含 19 个 bundle，其中 17 个是外部 bundle，多数通过本地 `link:` 接入。临时环境成功启动，排除了这次测试条件下明显的启动阻断，但没有覆盖各插件完整工作流。[S7]

本地 link 插件仍指向原源码目录，依赖解析也可能包含插件自己的依赖；这不是所有组件均使用新核心包的封闭兼容性测试。`DSH_HOME` 隔离也不等于操作系统沙箱。

此前检查发现的 peer 版本声明，不能单独作为本次升级新增故障的证据。临时 profile 重装暴露的 package/lockfile 不一致也属于已有状态，不是 alpha 引入的故障。

### 4. 配置和隐私语义改变

新版本会读取代理环境变量；需要确认实际启动环境的代理设置是否符合预期。OTel 反馈授权可能释放包含已存上下文的完整历史前缀，导出可含消息、工具参数、结果及工作区路径；关闭 OTel 不等于关闭 DeepSeek 日志贡献。[S5]

只读 YAML 检查确认，当前 `settings.yaml` 没有值精确等于 `code` 的字段。未据此推断全部配置均已兼容，也未完整验证遥测配置。

## 实际验证

| 检查 | 结果与边界 |
| --- | --- |
| 安装新版到临时 runtime | 成功；主 runtime 未执行安装操作 |
| 使用桌面内置 Node 执行新版 | Node `v26.8.1`；`dsh --version` 返回 `0.1.5-alpha.1` |
| 复制现有 Web profile 并修复临时链接 | 成功；修复只针对临时副本 |
| 使用复制的 profile 启动新版 | 服务输出监听地址，进程保持运行 |
| 本地 HTTP 检查 | 未带 token 请求返回 `401`，仅证明 HTTP 鉴权端点响应 |
| 停止临时服务 | 已退出，退出码 `130` |
| 设置中的旧预设值检查 | 无精确等于 `code` 的值 |
| 浏览器和登录后 UI | 未验证，未打开浏览器 |
| 真实设置、凭据文件、历史会话 | 没有复制这些文件用于启动测试；真实环境覆盖不足 |
| 模型请求、终端、原生工具、插件工作流 | 未验证 |
| 历史迁移和降级恢复 | 未验证 |

安装成功和 HTTP 响应不等于上述未覆盖项目通过。临时安装采用桌面内置 Node 启动 pnpm，但没有完整复现桌面更新器的 PATH 环境，不能由安装结果推断原生工具全部兼容。

## 建议的升级条件

1. 结束任务并停止 DSH 服务，再对整个 `~/.dsh` 做一致性备份，包含 runtime、profiles、settings、sessions、attachments、storages 等；备份应按含凭据的数据保护。
2. 记录或备份本地 link 插件的当前源码及构建状态，避免验证期间与正式升级时发生漂移。
3. 在隔离副本中带入实际配置，选少量有代表性的历史会话验证打开、续写、fork、压缩、附件、终端及关键插件。不要让新旧 runtime 同时写同一个 home。
4. 回滚应恢复升级前一致的 runtime 和数据快照，而不只是降级 npm 包；另行保留升级后的新增数据，不假定能合并回旧版。

## 证据索引

- [S1] 官方 registry 查询：`npm view @deepseek-ai/dsh@0.1.5-alpha.1 --json`；收尾时再次执行 `npm view @deepseek-ai/dsh dist-tags --json --registry https://registry.npmjs.org/`。本机版本读取自 `~/.dsh/runtime/node_modules/@deepseek-ai/dsh/package.json`。
- [S2] 官方仓库 `https://github.com/deepseek-ai/deepseek-harness.git` 的两个固定标签。用于比较的本地 Git 仓库：`/tmp/dsh-harness-compare.wmNn4d/repo`。
- [S3] 新标签下 `.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md`，重点为 publication、只读准备、保留与降级限制。
- [S4] 新标签下 `packages/session/session-format-v2-to-v3/README.zh.md`，重点为预设、源审计、拒绝与原生 v3 准入规则。
- [S5] 两端 `apps/cli/package.json`、`apps/cli/src/args.ts` 和 `apps/cli/reference/README.zh.md` 的差异。
- [S6] 官方合入记录示例：`53f6590f7` 通用文件上传；`de01754f1` 侧栏；`9292dd8a2` 本地应用打开；`0707f4af3` SSH；`0ea65903c` 重连；`4dd2c7b51` 发送队列；`28d478a80` 忙碌发送按钮；`66ac8cc09` Goal 恢复；`b0a7d2ce3` 收件箱恢复；`9d93c5705` 延迟事件；`81dcacbb4` 客户端流处理。此项依据为合入记录，非逐项功能测试。
- [S7] 本机 Web profile manifest；临时环境 `/tmp/dsh-alpha-smoke.LRa82H/home` 的安装、版本、启动和 HTTP 检查输出。未在报告中保留启动 token。
- [S8] DSH-Desktop 仓库 `HEAD:src/runtime-manager.ts` 的 `installDshArgs()` / `updateDsh()`；`HEAD:src/desktop-bridge.ts` 的升级 IPC；`HEAD:src/main.ts` 的 `restartDshWebImpl()`。

网页读取未取得可用的发布说明页面，不能据此断言官方没有发布说明。本报告依据直接获取的官方 npm 元数据、Git 对象和本机检查结果，不以搜索缺失作为发布事实。
