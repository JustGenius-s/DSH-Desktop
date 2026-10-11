/**
 * 隐藏原生标题栏（`titleBarStyle: 'hiddenInset'`）之后，本壳仍需自己声明的
 * 少数拖拽热区。
 *
 * ## 本文件现在的职责已经很小——大部分交给上游了
 *
 * 上游 DSH 把「运行在 macOS 桌面壳」编码成 `<html data-platform="darwin">`
 * 标记（由 `preload.ts` 设置），并围绕它提供了一整套窗口集成。因此历史上
 * 本文件承担的多数规则**已由上游接管**，这里不再重复：
 *
 * | 职责 | 现在由谁负责 |
 * | --- | --- |
 * | 全宽顶部拖拽带（52px / 带 tab 时 76px） | 上游 `ui-layout` 的 `.leadingBand` |
 * | 侧栏 logo 行 drag、brand 光标 | 上游 `ui-sidebar` |
 * | 侧栏顶部 52px 让位条 | 上游 `ui-sidebar` 的 `.topStrip`（条件渲染） |
 * | 全屏面板 strip 的 drag / chip 的 no-drag | 上游前端 `._stripTabs` 等（darwin 门控） |
 * | 全屏面板 88px 内缩 | 上游 `ui-sidebar-right`（同一变量同一值） |
 * | 面板 / 浮层 / 分隔条 no-drag | 上游前端 CSS |
 *
 * 本文件因此只保留**上游没有提供**的两条，见下面各段注释。
 *
 * ## Electron 的判定规则（不是 CSS 层叠）
 *
 * 渲染进程把最终的拖动区域作为**有序矩形列表**发给浏览器进程，Electron
 * 按顺序叠加：drag 矩形加区、no-drag 矩形减区，**重叠处后出现的矩形胜出**
 * （顺序 = 元素的绘制顺序，见 `shell/browser/ui/drag_util.cc` 注释）。
 *
 * 关键推论：**没声明 `app-region` 的元素不产生矩形，因此挡不住下层热区**。
 * 上游正依赖这一点：全屏右侧面板铺满窗口且**不声明** app-region，于是
 * 框架的 `.leadingBand` 能穿透它继续提供顶部拖拽。**因此本文件绝不能给
 * 面板加 no-drag** —— 那会把上游的拖拽带整条掐掉，窗口拖不动。
 *
 * ## 选择器策略
 *
 * DSH 是运行时升级的 web 包，CSS Module 类名带构建 hash（`wSkVaW_header`），
 * 只用 `[class*='camelCase 后缀']` 属性选择器匹配稳定后缀；上游提供了稳定的
 * `data-*` 属性时优先用它们。覆盖性质的声明带 `!important`。
 */

/**
 * macOS 红绿灯带所需的最小左侧留白。
 *
 * 保留此常量是为了让上游值与本壳认知可对照：上游在
 * `ui-sidebar-right` 里用 `--dsh-dockkit-strip-inline-start: 88px`
 * 给全屏面板首列让位，本文件不再重复那条规则（见上文表格）。
 */
export const FULLSCREEN_STRIP_INSET_PX = 88

/**
 * 生成注入到 DSH 网页的标题栏 chrome CSS。
 *
 * @param platform - `process.platform`；只有 macOS 需要为红绿灯让位。
 * @param _nativeFullscreen - 原生窗口全屏。**当前不再影响本函数的输出** ——
 *   上游用 `<html data-fullscreen>` 自行处理全屏差异（内缩回 10px、
 *   `--dsh-frame-leading-clearance` 取 84px），该标记由
 *   `titlebar-controller.ts` 维护。保留形参以免调用方与测试改动。
 * @returns 注入用的完整 CSS 文本。
 */
export function titleBarChromeCSS(_platform: NodeJS.Platform, _nativeFullscreen = false): string {
  // 侧栏 logo 行的交互控件必须 no-drag。
  //
  // 上游只声明了 `.logoRow { drag }` 与 brand 的 `cursor: default`，并用
  // 「brand 不再是 New Session 入口」的方式避免误拖；但 logoRow 里仍有
  // 收起/展开等真实 `<button>`。`app-region` **不继承**，父级 drag 会让
  // 子按钮的点击被判成拖窗口，所以这里逐个挖回来。
  //
  // 上游的全局 `[role=button]` no-drag 覆盖不到裸 `<button>`（DOM 上没有
  // role 属性），故这条不能省。
  const logoRowControls = `
    [class*='logoRow'] button,
    [class*='logoRow'] a,
    [class*='logoRow'] [role='button'] { -webkit-app-region: no-drag; app-region: no-drag; }`

  // 中间列会话顶栏：整行可拖，交互控件除外。
  //
  // **上游没有提供这条**：`ui-conversation` 只给了 header 内部四个区域
  // （headerLeading / headerActions / headerUtilities / headerCorner）的
  // no-drag，以及 `.headerSessionless` 的间距调整，从未把 header 本身声明为
  // drag。上游的 `.leadingBand` 只覆盖顶部 52px，而带视图 tab 条的 header
  // 高约 76px，下半部分（tab 条那一行）不在 band 范围内。因此这条保留。
  //
  // 整个应用只有会话顶栏渲染 <header> 元素（详情面板等均为 div），
  // 故直接用元素选择器；headerHidden 时 display:none，规则自然失效。
  const conversationHeader = `
    header[class*='header']:not([class*='headerHidden']) {
      -webkit-app-region: drag;
      app-region: drag;
    }
    header[class*='header'] button,
    header[class*='header'] a,
    header[class*='header'] [role='button'],
    header[class*='header'] [role='tab'],
    header[class*='header'] input,
    header[class*='header'] select {
      -webkit-app-region: no-drag;
      app-region: no-drag;
    }`

  // Windows 有原生标题栏，Electron 会整份忽略渲染进程上报的拖动区域
  // （WebContents::DraggableRegionsChanged 在 owner_window()->has_frame()
  // 时直接 return），故这些规则在 Windows 上既不生效也不有害。
  //
  // ============ 窗口拖不动（0.2.1 回归）与修复 ============
  //
  // 症状：0.2.1 起窗口**任何位置**都拖不动；0.2.0 正常。
  //
  // 直接原因（已实测确证）：本壳从 0.2.1 起设置 `data-platform="darwin"`，
  // 激活了上游一条 darwin 门控的兜底规则：
  //
  //   html[data-platform="darwin"] body > :not(#root) { app-region: no-drag }
  //
  // 它在真实环境里命中 4 个 body 直系子元素，其中两个是**铺满整窗
  // 1280×800** 的插件浮层（绘制在 #root 之后）：
  //
  //   .PCRLGG_5b7534_layer              1280×800
  //   .dsh-status-rotator-danmaku-layer 1280×800
  //
  // Electron 把 drag/no-drag 当作有序矩形列表、重叠处**后绘制者胜出**，
  // 于是这两个 no-drag 矩形把整个窗口从拖拽区里减掉 —— 按在哪里都判定为
  // 「非拖拽区」。
  //
  // 实测对照（同一实例，仅切换标记）：
  //   带标记     → 两个浮层 getComputedStyle().webkitAppRegion = "no-drag"
  //   移除标记   → 变为 "none"
  // 即标记正是这两个矩形出现的开关。
  //
  // 上游本该由 `.leadingBand` 提供顶部拖拽带，但那条**不可用**：它是
  // `pointer-events: none`，实测 elementFromPoint(100,26) 穿透到下层 <p>，
  // 自身不被命中，因此不产生可用热区。
  //
  // 修复分两半：
  //
  //   a. 把整窗浮层还原为初值 `revert` —— 它们不再产生任何矩形，
  //      既不减区也不加区，整窗不再被误减。实测 `revert` 即可生效，
  //      无需 !important。
  //      真正需要 no-drag 的交互浮层不受影响：菜单/对话框自带 role，
  //      由上游前端 `[role=...] { no-drag }` 单独覆盖，与此无关。
  //
  //   b. 自补一条**可命中**的顶部全宽热区（0.2.0 的做法）。它必须
  //      `pointer-events: auto`（上游 band 的教训），并以伪元素 +
  //      z-index:-1 压在内容下层，既产生 drag 矩形又不遮挡顶栏按钮。
  //      高度 52px 与上游 band / 侧栏 `.topStrip` 同值。
  const topDragBand = `
    /* a. 中和上游 body>:not(#root){no-drag}：整窗不再被满屏浮层减区。
       必须 !important：本壳样式表与上游同为作者级，上游那条特异性相同
       且加载在后；不加 important 会被它压过（实测）。 */
    html[data-platform='darwin'] body > :not(#root) {
      -webkit-app-region: revert !important;
      app-region: revert !important;
    }

    /* b. 自补可命中的顶部全宽热区 */
    html[data-platform='darwin'] #root::before {
      content: '';
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 52px;
      z-index: -1;
      pointer-events: auto;
      -webkit-app-region: drag;
      app-region: drag;
    }`

  return `
    /* ================= 0. 顶部全宽拖拽带 ================= */
    ${topDragBand}

    /* ================= 1. 侧栏 logo 行的交互控件 ================= */
    ${logoRowControls}

    /* ================= 2. 中间列会话顶栏 ================= */
    ${conversationHeader}
  `
}
