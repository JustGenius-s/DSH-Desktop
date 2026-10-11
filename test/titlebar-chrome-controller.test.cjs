// 标题栏 chrome 注入器的测试。
//
// 注入方式已从 `wc.insertCSS` 改为「在页面里维护一个带 id 的 <style>」
// （原因见 src/main/windows/titlebar-controller.ts：insertCSS 的规则在 0.1.7 +
// Electron 43 上不参与最终层叠，压不过上游的作者级规则）。
//
// 因此这里不再断言「insertCSS 的调用序列」，而是**真的执行注入脚本**：
// 用一个最小的 DOM 桩跑脚本，再断言它做了什么。这样测的是行为，
// 不是实现细节，换注入方式时只有桩要跟着变。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const vm = require('node:vm')
const { installTitleBarChrome } = require('../dist/main/windows/titlebar-controller.js')
const { titleBarChromeCSS } = require('../dist/main/windows/titlebar.js')

const STYLE_ID = '__dsh_desktop_titlebar_chrome'

/** 极简 DOM 桩：只实现注入脚本用到的那几个 API，并记录所有写入。 */
function makeDom() {
  const created = []
  const elements = new Map()
  const doc = {
    head: {
      appendChild(node) {
        elements.set(node.id, node)
        created.push(node)
        return node
      },
    },
    documentElement: {
      attrs: new Set(),
      setAttribute(name) {
        this.attrs.add(name)
      },
      removeAttribute(name) {
        this.attrs.delete(name)
      },
    },
    getElementById(id) {
      return elements.get(id) ?? null
    },
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        id: '',
        textContent: '',
      }
    },
  }
  return { doc, created, elements }
}

/** 在 DOM 桩里执行一段注入脚本，返回该桩。 */
function runScript(script, dom) {
  const sandbox = { document: dom.doc }
  vm.createContext(sandbox)
  vm.runInContext(script, sandbox, { timeout: 1000 })
}

function fixture(fullscreen = false) {
  const win = new EventEmitter()
  const wc = new EventEmitter()
  const dom = makeDom()
  /** 每次 executeJavaScript 的脚本文本（按调用顺序）。 */
  const scripts = []
  win.webContents = wc
  win.fullscreen = fullscreen
  win.destroyed = false
  wc.destroyed = false
  win.isDestroyed = () => win.destroyed
  win.isFullScreen = () => win.fullscreen
  wc.isDestroyed = () => wc.destroyed
  wc.executeJavaScript = async (code) => {
    scripts.push(code)
    // 只执行「注入 CSS / 写标记」这两类脚本，让它们真的作用到 DOM 桩上。
    if (code.includes('createElement') || code.includes('data-fullscreen')) {
      runScript(code, dom)
    }
    return undefined
  }
  installTitleBarChrome(win, 'darwin')
  return { win, wc, dom, scripts }
}

async function emitAsync(emitter, event) {
  await Promise.all(emitter.listeners(event).map((listener) => listener()))
}

/** DOM 桩里当前 <style id=...> 的 CSS 文本。 */
function injectedCSS(dom) {
  const tag = dom.elements.get(STYLE_ID)
  return tag === undefined ? undefined : tag.textContent
}

test('用作者级 <style> 注入，而不是 insertCSS', async () => {
  // insertCSS 的规则在实测中不参与最终层叠（压不过上游作者级规则），
  // 因此注入方式必须是作者级的 <style> 元素。
  const { wc, dom } = fixture()
  await emitAsync(wc, 'did-finish-load')
  const tag = dom.elements.get(STYLE_ID)
  assert.ok(tag !== undefined, `没有创建 #${STYLE_ID}`)
  assert.equal(tag.tagName, 'STYLE')
  assert.equal(tag.textContent, titleBarChromeCSS('darwin', false))
})

test('重复刷新只替换内容，不重复追加节点（幂等）', async () => {
  const { wc, dom } = fixture()
  await emitAsync(wc, 'did-finish-load')
  await emitAsync(wc, 'did-finish-load')
  await emitAsync(wc, 'did-finish-load')
  const sameId = dom.created.filter((el) => el.id === STYLE_ID)
  assert.equal(sameId.length, 1, `#${STYLE_ID} 被创建了 ${sameId.length} 次`)
  assert.equal(injectedCSS(dom), titleBarChromeCSS('darwin', false))
})

test('原生全屏状态写进 <html data-fullscreen>，离开时清除', async () => {
  const { win, wc, dom } = fixture()
  await emitAsync(wc, 'did-finish-load')
  assert.ok(!dom.doc.documentElement.attrs.has('data-fullscreen'), '非全屏不应带标记')

  win.fullscreen = true
  await emitAsync(win, 'enter-full-screen')
  assert.ok(dom.doc.documentElement.attrs.has('data-fullscreen'), '全屏时必须设置标记')

  win.fullscreen = false
  await emitAsync(win, 'leave-full-screen')
  assert.ok(!dom.doc.documentElement.attrs.has('data-fullscreen'), '离开全屏必须清除标记')
})

test('重载后重新同步标记与样式，不依赖上一次状态', async () => {
  const { wc, dom } = fixture(true)
  await emitAsync(wc, 'did-finish-load')
  assert.ok(dom.doc.documentElement.attrs.has('data-fullscreen'))
  await emitAsync(wc, 'did-finish-load')
  assert.ok(dom.doc.documentElement.attrs.has('data-fullscreen'), '重载后仍须是全屏标记')
  assert.equal(injectedCSS(dom), titleBarChromeCSS('darwin', true))
})

test('非 darwin 平台不写 data-fullscreen，但仍注入样式', async () => {
  // 上游只在 [data-platform=darwin] 分支消费该标记；样式则各平台都注入
  // （Windows 上 Electron 会忽略拖拽区，留着也无害）。
  const win = new EventEmitter()
  const wc = new EventEmitter()
  const dom = makeDom()
  const scripts = []
  win.webContents = wc
  win.isDestroyed = () => false
  win.isFullScreen = () => true
  wc.isDestroyed = () => false
  wc.executeJavaScript = async (code) => {
    scripts.push(code)
    runScript(code, dom)
  }
  installTitleBarChrome(win, 'win32')
  await emitAsync(wc, 'did-finish-load')
  assert.equal(scripts.filter((c) => c.includes('data-fullscreen')).length, 0)
  assert.equal(injectedCSS(dom), titleBarChromeCSS('win32', true))
})

test('重叠的全屏与重载事件后，只剩最新状态', async () => {
  const { win, wc, dom } = fixture()
  await emitAsync(wc, 'did-finish-load')
  win.fullscreen = true
  const entering = emitAsync(win, 'enter-full-screen')
  win.fullscreen = false
  const leaving = emitAsync(win, 'leave-full-screen')
  const reloading = emitAsync(wc, 'did-finish-load')
  await Promise.all([entering, leaving, reloading])
  assert.ok(!dom.doc.documentElement.attrs.has('data-fullscreen'))
  assert.equal(injectedCSS(dom), titleBarChromeCSS('darwin', false))
})

test('每个窗口各自持有自己的样式节点', async () => {
  const first = fixture()
  const second = fixture(true)
  await emitAsync(first.wc, 'did-finish-load')
  await emitAsync(second.wc, 'did-finish-load')
  assert.equal(injectedCSS(first.dom), titleBarChromeCSS('darwin', false))
  assert.equal(injectedCSS(second.dom), titleBarChromeCSS('darwin', true))
})

test('脚本执行失败不阻断后续刷新', async () => {
  const { win, wc, dom } = fixture()
  await emitAsync(wc, 'did-finish-load')
  const ok = wc.executeJavaScript
  wc.executeJavaScript = async () => {
    throw new Error('navigation in progress')
  }
  win.fullscreen = true
  await emitAsync(win, 'enter-full-screen')
  // 失败不应抛出，也不应污染已有样式
  assert.equal(injectedCSS(dom), titleBarChromeCSS('darwin', false))
  wc.executeJavaScript = ok
  await emitAsync(wc, 'did-finish-load')
  assert.equal(injectedCSS(dom), titleBarChromeCSS('darwin', true))
})

test('销毁的窗口与 webContents 跳过排队中的刷新', async () => {
  for (const target of ['win', 'wc']) {
    const f = fixture()
    const loading = emitAsync(f.wc, 'did-finish-load')
    f[target].destroyed = true
    await loading
    assert.equal(f.scripts.length, 0, `${target} 销毁后仍有脚本执行`)
  }
})
