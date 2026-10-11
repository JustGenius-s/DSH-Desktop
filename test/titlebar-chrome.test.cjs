// 标题栏 chrome 的规则回归测试。
//
// 接入 `<html data-platform="darwin">` 之后，上游 DSH 接管了绝大部分窗口
// 集成（全宽拖拽带、侧栏顶部条、全屏面板 strip 的 drag/no-drag、88px 内缩、
// 面板与浮层的 no-drag）。本文件因此**只断言本壳仍需自己负责的两条**，
// 并显式断言「我们不再重复上游职责」——包括那条最容易误加的
// 「面板 no-drag」，它会掐掉上游的拖拽带。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { FULLSCREEN_STRIP_INSET_PX, titleBarChromeCSS } = require('../dist/main/windows/titlebar.js')

const mac = titleBarChromeCSS('darwin')
const macFullscreen = titleBarChromeCSS('darwin', true)
const win = titleBarChromeCSS('win32')

/** 抽出某条规则体，忽略空白差异。 */
function body(css, selector) {
  const index = css.indexOf(selector)
  assert.notEqual(index, -1, `缺少选择器：${selector}`)
  return css.slice(index + selector.length, css.indexOf('}', index))
}

test('侧栏 logo 行的交互控件 no-drag', () => {
  // 上游只声明 `.logoRow { drag }`；`app-region` 不继承，若不给其中的
  // `<button>` 挖回来，点收起按钮会变成拖窗口。上游的全局 `[role=button]`
  // 覆盖不到裸 `<button>`。
  for (const target of ['button', 'a', "[role='button']"]) {
    assert.ok(
      mac.includes(`[class*='logoRow'] ${target}`),
      `logoRow 下缺少 no-drag 目标：${target}`,
    )
  }
  assert.match(body(mac, "[class*='logoRow'] button"), /-webkit-app-region:\s*no-drag/)
})

test('会话顶栏整行可拖，控件 no-drag', () => {
  // 上游没提供这条：`ui-conversation` 只给了 header 内部四个区域的 no-drag，
  // 从未把 header 本身声明为 drag；而 `.leadingBand` 只覆盖顶部 52px，
  // 带视图 tab 条的 header 约 76px，下半部分不在 band 内。
  assert.match(
    body(mac, "header[class*='header']:not([class*='headerHidden']) "),
    /-webkit-app-region:\s*drag/,
  )
  for (const target of ['button', 'a', "[role='button']", "[role='tab']", 'input', 'select']) {
    assert.ok(
      mac.includes(`header[class*='header'] ${target}`),
      `会话顶栏下缺少 no-drag 目标：${target}`,
    )
  }
})

test('不给右侧面板整块加 no-drag', () => {
  // 全屏面板铺满窗口。上游对面板内部的 strip / chip / 分隔条已有 darwin
  // 门控的 no-drag 覆盖，本壳无需重复，也**不应**给整个面板加 no-drag：
  // 面板内大部分区域本就该可拖（它是标题栏的延伸），整块减区会掐掉
  // 那块拖拽面积。
  assert.doesNotMatch(mac, /\[data-sidebar-right-panel[^\]]*\]\s*[,{][^}]*app-region:\s*no-drag/)
  assert.doesNotMatch(mac, /\[data-sidebar-right-panel\]/)
})

test('顶部有可命中的全宽热区（0.2.1 拖不动窗口的回归）', () => {
  // 0.2.1 曾删掉本壳自写的顶部通条，改依赖上游 `.leadingBand`，结果
  // 窗口在任何位置都拖不动。该 band 是 `pointer-events: none`，
  // elementFromPoint 实测穿透到下层，自身不被命中，因此不产生可用热区。
  // 本壳必须自备一条 pointer-events:auto 的全宽 drag 带。
  const band = body(mac, "html[data-platform='darwin'] #root::before ")
  assert.match(band, /-webkit-app-region:\s*drag/)
  assert.match(band, /pointer-events:\s*auto/)
  assert.match(band, /position:\s*fixed/)
  assert.match(band, /height:\s*52px/)
  // 不能遮挡内容：必须压在下层
  assert.match(band, /z-index:\s*-1/)
})

test('中和上游 body > :not(#root) 的整窗减区（拖不动的真正根因）', () => {
  // 打上 data-platform=darwin 后，上游这条兜底规则会命中两个**铺满整窗**
  // 的插件浮层（.PCRLGG_*_layer / .dsh-status-rotator-danmaku-layer），
  // 它们绘制在 #root 之后，按「后绘制者胜出」把整窗从拖拽区减掉。
  // 实测：带标记时两者 = no-drag；移除标记 = none。
  // 本壳用 revert 还原为初值（不产生矩形），无需 !important。
  const neuter = body(mac, "html[data-platform='darwin'] body > :not(#root) ")
  assert.match(neuter, /-webkit-app-region:\s*revert/)
  assert.match(neuter, /app-region:\s*revert/)
  // 不能用 none/auto —— 都不是 -webkit-app-region 的合法关键字，
  // 声明会被丢弃（曾据此写出无效修复）。
  assert.doesNotMatch(neuter, /(none|auto)\s*;/)
})

test('不重复上游已承担的全屏面板与内缩规则', () => {
  // 这些上游都已提供，且全在 darwin 门控下：
  //   ._stripTabs / ._stripChrome / ._paneBody / ._float / ._divider → no-drag
  //   --dsh-dockkit-strip-inline-start: 88px → 首列让位红绿灯
  // 本壳重复声明只会制造两套真相。
  assert.doesNotMatch(mac, /--dsh-dockkit-strip-inline-start/)
  assert.doesNotMatch(mac, /\[data-dockkit-strip\]\s*\{[^}]*drag/)
  assert.doesNotMatch(mac, /\[data-dockkit-divider\]/)
  assert.doesNotMatch(mac, /\[data-dockkit-float\]/)
})

test('不再手写侧栏让位 hack（上游 .topStrip 接管）', () => {
  // 上游在 darwin 下渲染 52px `.topStrip`，logoRow 随之落在 y=40。
  // 本壳历史上用 `margin-top: 20px !important` 顶替，实测会把 logoRow
  // 推到 y=26 —— 仍在红绿灯竖直带（y 20~32）内，既不准又会与上游叠加。
  assert.doesNotMatch(mac, /margin-top:/)
  assert.doesNotMatch(mac, /:has\(> \[class\*='logoRow'\]\)/)
  assert.doesNotMatch(mac, /centerCol/)
})

test('所有拖拽声明同时带 -webkit- 前缀与标准属性', () => {
  for (const css of [mac, macFullscreen, win]) {
    const regions = [...css.matchAll(/-webkit-app-region:\s*(no-drag|drag);/g)]
    assert.ok(regions.length > 0)
    for (const region of regions) {
      const following = css.slice(region.index + region[0].length)
      assert.match(following, new RegExp(`^\\s*app-region:\\s*${region[1]};`))
    }
  }
})

test('原生全屏不影响本壳输出（上游用 data-fullscreen 自行处理）', () => {
  // 上游在 [data-fullscreen] 下把内缩改回 10px、leading-clearance 取 84px。
  // 该标记由 controller 维护，本函数不再按全屏分支。
  assert.equal(mac, macFullscreen)
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(titleBarChromeCSS(platform, true), titleBarChromeCSS(platform, false))
  }
})

test('Windows 输出同样是上游未覆盖的那两条', () => {
  assert.equal(win, mac)
})

test('导出的红绿灯留白常量与上游取值一致', () => {
  // 上游 `ui-sidebar-right` 用 88px；本常量保留作为可对照的单一来源，
  // 若上游改值，这里会先暴露出来。
  assert.equal(FULLSCREEN_STRIP_INSET_PX, 88)
})
