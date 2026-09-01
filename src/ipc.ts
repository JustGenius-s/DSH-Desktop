/**
 * 主进程 ↔ preload 的 IPC 频道名。插件看不见这些字符串，
 * 只通过 window.dshDesktop 的四族方法说话。
 *
 * 本文件是频道名的唯一事实源。preload.ts 在 sandboxed 环境里不能
 * require 本文件，只内联了一份值并用 `satisfies typeof Ipc` 绑定：
 * 这里任何改动都会让 preload.ts 编译报错，不存在悄悄漂移。
 */

export const Ipc = {
  updates: {
    // 执行端点只有壳做得到，正式契约。
    appVersion: 'desktop:updates:app-version',
    downloadApp: 'desktop:updates:download-app',
    updateDsh: 'desktop:updates:update-dsh',
    restartWeb: 'desktop:updates:restart-web',
    // 热重启询问：主进程推给网页，网页用 DSH Modal 渲染后回 ack / 选择。
    prompt: 'desktop:updates:prompt',
    promptAck: 'desktop:updates:prompt-ack',
    promptResponse: 'desktop:updates:prompt-response',
    // 兼容层：仅 0.1.x 旧插件用，新插件的检测在插件 host 半侧。
    getState: 'desktop:updates:get-state',
    state: 'desktop:updates:state',
    checkNow: 'desktop:updates:check-now',
    setDshChannel: 'desktop:updates:set-dsh-channel',
    skipVersion: 'desktop:updates:skip-version',
    setGate: 'desktop:updates:set-gate',
    relaunch: 'desktop:updates:relaunch',
  },
  seats: {
    list: 'desktop:seats:list',
    contribute: 'desktop:seats:contribute',
    revoke: 'desktop:seats:revoke',
    action: 'desktop:seats:action',
  },
  notify: {
    show: 'desktop:notify:show',
    close: 'desktop:notify:close',
    action: 'desktop:notify:action',
  },
  overlays: {
    open: 'desktop:overlays:open',
    update: 'desktop:overlays:update',
    move: 'desktop:overlays:move',
    setIgnoreMouseEvents: 'desktop:overlays:set-ignore-mouse-events',
    focus: 'desktop:overlays:focus',
    close: 'desktop:overlays:close',
    list: 'desktop:overlays:list',
    closed: 'desktop:overlays:closed',
  },
  plugins: {
    list: 'desktop:plugins:list',
    setEnabled: 'desktop:plugins:set-enabled',
    clearFailure: 'desktop:plugins:clear-failure',
    relaunch: 'desktop:plugins:relaunch',
  },
} as const
