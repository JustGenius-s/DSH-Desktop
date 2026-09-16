/**
 * 隐藏原生标题栏（`titleBarStyle: 'hiddenInset'`）之后，网页必须自己声明
 * 窗口拖动热区，否则窗口拖不动；同时必须把「盖在热区上的操作区」标成
 * `no-drag`，否则点不动。
 *
 * ## Electron 的判定规则（不是 CSS 层叠）
 *
 * 渲染进程把最终的拖动区域作为**有序矩形列表**发给浏览器进程，Electron
 * 按顺序叠加：drag 矩形加区、no-drag 矩形减区，**重叠处后出现的矩形胜出**
 * （顺序 = 元素的绘制顺序，见 `shell/browser/ui/drag_util.cc` 注释）。
 *
 * 关键推论：**没声明 `app-region` 的元素不产生矩形，因此挡不住下层热区**。
 * 任何覆盖在热区之上的浮层（全屏右侧面板、桌宠、overlay 窗口）都必须自己
 * 显式声明 `no-drag`，否则下层的 drag 会穿透上来 —— 表现为「点不动」。
 *
 * ## 选择器策略
 *
 * DSH 是运行时升级的 web 包，CSS Module 类名带构建 hash（`wSkVaW_header`），
 * 只用 `[class*='camelCase 后缀']` 属性选择器匹配稳定后缀；新版本 DSH 提供了
 * 稳定的 `data-dockkit-*` / `data-sidebar-right-*` 属性，优先用它们。
 * 覆盖性质的声明（内缩、外边距）带 `!important`，防止运行时注入的样式推翻。
 */

/** macOS 红绿灯带所需的最小左侧留白：三个按钮 + 最左侧按钮的左边距。 */
export const FULLSCREEN_STRIP_INSET_PX = 80

/**
 * 生成注入到 DSH 网页的标题栏 chrome CSS。
 *
 * @param platform - `process.platform`；只有 macOS 需要为红绿灯让位，
 *   Windows 有原生标题栏，侧栏与面板都不必留白。
 * @returns 注入用的完整 CSS 文本。
 */
export function titleBarChromeCSS(platform: NodeJS.Platform): string {
  const isMac = platform === 'darwin'

  // Windows 有原生标题栏，侧栏不必为红绿灯留上边距，也没有红绿灯要避。
  const macSidebarInset = isMac
    ? `
    [class*='logoRow'] { -webkit-app-region: drag; margin-top: 20px !important; }
    :has(> [class*='logoRow']) { position: relative; }
    :has(> [class*='logoRow'])::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 40px;
      -webkit-app-region: drag;
    }`
    : `
    [class*='logoRow'] { -webkit-app-region: drag; }`

  // 全屏右侧面板铺满整个窗口（`position:fixed; inset:0; z-index:40`），
  // 左上角正好压住红绿灯与侧栏顶部通条。macOS 下给「贴着窗口左边缘」的那条
  // tab strip 内缩，让 chip 落到红绿灯右侧；strip 其余部分保持可拖。
  //
  // **必须完整地用子代组合器链一路限定到 pane 本身**，否则会把右 pane 也命中：
  // 每个 pane 的 strip 都是它自己 pane 的直接子元素，所以
  // `[data-dockkit-pane] > [data-dockkit-strip]` 并不等于「最左侧那个 pane」，
  // 它匹配所有 pane。只有 pane 自己坐在下面两种位置时，它的左边缘才等于
  // 窗口左边缘：
  //
  //   未分屏：`surface > pane`（根 pane 是 surface 的直接子元素）
  //   分屏后：`cell:first-child > pane`（左 pane 是第一个 cell 的直接子元素；
  //           右 pane 在 `cell[data-dockkit-cell='…:1']` 里，起点在窗口中
  //           部，够不着红绿灯，不缩进）
  //
  // `.split` 的子元素顺序是 [cell0, divider, cell1]，故 cell0 确实是第一个
  // 子元素；子代组合器 `>` 保证不会把 cell 里的后代 strip 误当成 cell 的直属子代。
  const fullscreenStripInset = isMac
    ? `
    [data-sidebar-right-panel='fullscreen'] :is([data-dockkit-surface], [data-dockkit-cell]:first-child) > [data-dockkit-pane] > [data-dockkit-strip] {
      padding-left: ${FULLSCREEN_STRIP_INSET_PX}px !important;
    }`
    : ''

  return `
    /* ================= 1. 侧栏 logo 行：macOS 为红绿灯留白；Windows 贴顶 ================= */
    ${macSidebarInset}
    [class*='logoRow'] button,
    [class*='logoRow'] a,
    [class*='logoRow'] [role='button'] { -webkit-app-region: no-drag; }

    /* ================= 2. 中间列会话顶栏：整行可拖，交互控件除外 =================
       整个应用只有会话顶栏渲染 <header> 元素（详情面板等均为 div），
       故直接用元素选择器；headerHidden 时 display:none，规则自然失效。 */
    header[class*='header']:not([class*='headerHidden']) {
      -webkit-app-region: drag;
    }
    header[class*='header'] button,
    header[class*='header'] a,
    header[class*='header'] [role='button'],
    header[class*='header'] [role='tab'],
    header[class*='header'] input,
    header[class*='header'] select {
      -webkit-app-region: no-drag;
    }

    /* ================= 3. 中间列顶部通条：顶栏隐藏时（hero/空会话态）仍可拖动 =================
       伪元素压在顶栏/内容下层（z-index:0），不可点击但可拖动，不遮挡交互控件。 */
    [class*='centerCol'] { position: relative; }
    [class*='centerCol']::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 40px;
      z-index: 0;
      -webkit-app-region: drag;
    }

    /* ================= 4. 浮层穿透切断：浮层必须自己声明 no-drag =================
       没声明 app-region 的元素不产生矩形，挡不住第 1~3 条的热区。全屏右侧
       面板、浮动面板覆盖在上方时，必须由自己把下层热区减掉。

       面板铺满窗口后，第 1、3 条的顶部通条都在它下面：这里先整块 no-drag，
       再由第 5 条把全屏面板的 tab strip 单独挖回来当标题栏用。push 模式下面板
       只占右侧一条，整块 no-drag 同样正确（面板内不该触发窗口拖动）。

       Windows 有原生标题栏，Electron 会整份忽略渲染进程上报的拖动区域
       （WebContents::DraggableRegionsChanged 在 owner_window()->has_frame()
       时直接 return），故这两条无需按平台分支，留着也不会有副作用。 */
    [data-sidebar-right-panel],
    [data-dockkit-float],
    [data-sidebar-right-float-host] { -webkit-app-region: no-drag; }

    /* ================= 5. 全屏右侧面板的 tab strip：当标题栏用 =================
       面板自己没有 header，tab strip 就是它的整个顶边。全屏时它是窗口顶部
       唯一空着的横条，声明成 drag 让窗口仍可拖动；chip、close、addTab、两个
       面板控制按钮、以及分屏分隔条全部 no-drag。strip 上的空白处（stripFill）
       故意保持 drag —— 那是这一行里唯一该用来拖窗口的地方。 */
    [data-sidebar-right-panel='fullscreen'] [data-dockkit-strip] {
      -webkit-app-region: drag;
    }
    [data-sidebar-right-panel='fullscreen'] [data-dockkit-strip] [data-dockkit-tab],
    [data-sidebar-right-panel='fullscreen'] [data-dockkit-strip] [data-dockkit-strip-chrome],
    [data-sidebar-right-panel='fullscreen'] [data-dockkit-strip] button,
    [data-sidebar-right-panel='fullscreen'] [data-dockkit-strip] a,
    [data-sidebar-right-panel='fullscreen'] [data-dockkit-strip] input,
    [data-sidebar-right-panel='fullscreen'] [data-dockkit-strip] select,
    [data-sidebar-right-panel='fullscreen'] [data-dockkit-strip] [role='button'],
    [data-sidebar-right-panel='fullscreen'] [data-dockkit-strip] [role='tab'],
    [data-sidebar-right-panel='fullscreen'] [data-dockkit-divider] {
      -webkit-app-region: no-drag;
    }
    ${fullscreenStripInset}
  `
}
