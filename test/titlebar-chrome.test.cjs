// 标题栏 chrome 的规则回归测试。
//
// 这些断言不是「CSS 长这样」的快照，而是四条一旦丢失就会让真实环境复现
// bug 的不变量：面板穿透、红绿灯遮挡、拖动带丢失、幂等注入。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { FULLSCREEN_STRIP_INSET_PX, titleBarChromeCSS } = require('../dist/titlebar-chrome.js')

const mac = titleBarChromeCSS('darwin')
const win = titleBarChromeCSS('win32')

/** 抽出某条规则体，忽略空白差异。 */
function body(css, selector) {
  const index = css.indexOf(selector)
  assert.notEqual(index, -1, `缺少选择器：${selector}`)
  return css.slice(index + selector.length, css.indexOf('}', index))
}

test('面板整块 no-drag，切断下层热区穿透', () => {
  // Electron 只把显式声明 app-region 的元素算进拖动区域；全屏面板
  // （position:fixed; inset:0）不自己声明 no-drag，侧栏与中间列的顶部
  // 40px 通条就会穿透上来，标签页点不动。
  const rule = body(mac, '[data-sidebar-right-panel],')
  assert.match(rule, /-webkit-app-region:\s*no-drag/)
  assert.match(mac, /\[data-dockkit-float\],/)
  assert.match(mac, /\[data-sidebar-right-float-host\]/)
})

test('全屏面板的 tab strip 声明为 drag，窗口仍可拖动', () => {
  // 全屏后 centerCol 的顶部通条被面板盖住，AppFrame 的左右 handle 又在
  // 屏幕两侧，strip 是窗口顶部唯一还能拖的横条。
  const rule = body(mac, "[data-sidebar-right-panel='fullscreen'] [data-dockkit-strip] ")
  assert.match(rule, /-webkit-app-region:\s*drag/)
})

test('strip 上的交互控件全部 no-drag', () => {
  // chip（role=tab / data-dockkit-tab）、关闭按钮、addTab、两个面板控制
  // 按钮、分屏分隔条：任意一个漏掉，那一片按下去就变成拖窗口。
  const strip = "[data-sidebar-right-panel='fullscreen'] [data-dockkit-strip]"
  for (const target of [
    '[data-dockkit-tab]',
    'button',
    "[role='tab']",
    "[role='button']",
    'input',
  ]) {
    assert.ok(
      mac.includes(`${strip} ${target}`),
      `全屏 strip 下缺少 no-drag 目标：${target}`,
    )
  }
  assert.ok(mac.includes(`[data-sidebar-right-panel='fullscreen'] [data-dockkit-divider]`))
})

test('macOS 只给贴窗口左边缘的那条 strip 内缩，避让红绿灯', () => {
  // 每个 pane 的 strip 都是【它自己 pane 的直接子元素】，所以
  // `[data-dockkit-pane] > [data-dockkit-strip]` 并不是「最左侧那个 pane」，
  // 它匹配所有 pane —— 曾经因此让分屏后的右 pane 也白吃 80px 内缩。
  // 必须把 pane 的【父级】也限定住：只有 pane 自己坐在 surface 里（未分屏）
  // 或 cell:first-child 里（分屏后的左 pane），它的左边缘才等于窗口左边缘。
  const inset = body(mac, '[data-sidebar-right-panel=\'fullscreen\'] :is(')
  assert.match(inset, /\[data-dockkit-surface\]/)
  assert.match(inset, /\[data-dockkit-cell\]:first-child/)
  assert.match(inset, />\s*\[data-dockkit-pane\]\s*>\s*\[data-dockkit-strip\]/)
  assert.match(inset, new RegExp(`padding-left:\\s*${FULLSCREEN_STRIP_INSET_PX}px`))

  // 任何【未限定 pane 父级】的内缩选择器都会命中右 pane：同一份样式里
  // 不允许出现这种写法。比对时先去掉已限定的那条。
  const withoutFixed = mac.replace(inset, '')
  assert.doesNotMatch(withoutFixed, /\[data-dockkit-pane\]\s*>\s*\[data-dockkit-strip\]\s*[,{]/)

  assert.equal(mac.split('padding-left').length - 1, 1, '内缩只应出现在一条规则里')
})

test('Windows 保留基础热区，但不为红绿灯做面板内缩', () => {
  // Windows 有原生标题栏，Electron 会整份忽略渲染进程上报的拖动区域
  // （owner_window()->has_frame() 时直接 return），所以这里的规则既不生效
  // 也不有害；真正要不成立的是「为红绿灯让位」那条。
  assert.equal(win.includes('padding-left'), false)
  assert.equal(win.includes('margin-top: 20px'), false)
})

test('基础的侧栏与会话顶栏热区保留', () => {
  for (const css of [mac, win]) {
    assert.match(css, /\[class\*='logoRow'\] \{ -webkit-app-region: drag;/)
    assert.match(css, /header\[class\*='header'\]:not\(\[class\*='headerHidden'\]\)/)
    assert.match(css, /\[class\*='centerCol'\]::before/)
  }
  assert.match(mac, /margin-top:\s*20px !important/)
  assert.equal(win.includes('margin-top: 20px'), false)
})
