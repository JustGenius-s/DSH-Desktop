import type { BrowserWindow } from 'electron'
import { titleBarChromeCSS } from './titlebar'

/**
 * 维护窗口级 DOM 标记与注入样式。
 *
 * ## 两类写入
 *
 * 1. `data-fullscreen` —— 原生窗口全屏状态。上游只消费不设置（全库搜索
 *    `dataset.fullscreen` / `setAttribute('data-fullscreen')` 均无结果），
 *    属桌面壳的职责。上游据此在原生全屏时把红绿灯内缩改回 10px：
 *      [data-platform=darwin][data-fullscreen] .P3OORG_panel[...] [data-dockkit-column="0"]
 *    以及对 `--dsh-frame-leading-clearance` 取 84px 而非 160px。
 *
 *    `data-platform=darwin` **不在这里设置** —— 它必须早于页面首次渲染，
 *    由 preload 负责（见 `preload.ts`）。这里只维护会随窗口状态变化的那部分。
 *
 * 2. 标题栏 chrome CSS —— 本壳仍需自己声明的那几条拖拽/避让规则。
 *    接上平台标记后上游已承担大部分（`.leadingBand` 全宽拖拽带、
 *    strip 的 drag/no-drag、88px 内缩），本壳只剩少数上游未覆盖的补充。
 */
export function installTitleBarChrome(win: BrowserWindow, platform: NodeJS.Platform): void {
  const wc = win.webContents
  let pending = Promise.resolve()

  const refresh = (): Promise<void> => {
    // Fullscreen changes and reloads can overlap; read the state when each update runs.
    pending = pending
      .then(async () => {
        if (win.isDestroyed() || wc.isDestroyed()) return

        // 原生全屏标记。非 darwin 平台不写：上游只在 darwin 分支消费它。
        if (platform === 'darwin') {
          const fullscreen = win.isFullScreen()
          await wc
            .executeJavaScript(
              `(() => {
             const root = document.documentElement
             if (root === null) return
             if (${String(fullscreen)}) root.setAttribute('data-fullscreen', '')
             else root.removeAttribute('data-fullscreen')
           })()`,
              true,
            )
            .catch(() => {
              // 导航中执行会失败；下一次事件仍会重试。
            })
        }

        // 用作者级 <style> 注入，而不是 wc.insertCSS。
        //
        // 为什么不用 insertCSS：实测（0.1.7-alpha.2 + Electron 43.4.0）它注入的
        // 规则**不参与最终层叠** —— 日志确认注入成功（返回 key、字节数正确），
        // 但页面上遍历 document.styleSheets 看不到该规则，两个满屏浮层
        // 仍计算为 no-drag；同一份 CSS 用 <style> 注入则立刻生效
        // （no-drag → none）。insertCSS 走的是调试器式的独立样式表，
        // 优先级低于文档作者样式，而本壳要覆盖的正是上游的作者级规则。
        //
        // 因此改为在页面里维护一个带 id 的 <style>，每次刷新**替换内容**
        // 而不是追加，天然幂等（旧实现要额外记 cssKey 再 removeInsertedCSS）。
        const css = titleBarChromeCSS(platform, win.isFullScreen())
        await wc
          .executeJavaScript(
            `(() => {
           const ID = '__dsh_desktop_titlebar_chrome'
           let tag = document.getElementById(ID)
           if (tag === null) {
             tag = document.createElement('style')
             tag.id = ID
             document.head.appendChild(tag)
           }
           tag.textContent = ${JSON.stringify(css)}
         })()`,
            true,
          )
          .catch(() => {
            // 导航中执行会失败；下一次事件仍会重试。
          })
      })
      .catch(() => {
        // Navigation or closing can invalidate CSS keys; later events still retry.
      })
    return pending
  }

  wc.on('did-finish-load', refresh)
  win.on('enter-full-screen', refresh)
  win.on('leave-full-screen', refresh)
}
