/**
 * 主进程 ↔ preload 的 IPC 频道名。插件看不见这些字符串，
 * 只通过 window.dshDesktop 的四族方法说话。
 *
 * 本文件是频道名的唯一事实源，构建时与 preload 一起打包。
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
    closed: 'desktop:notify:closed',
  },
  overlays: {
    open: 'desktop:overlays:open',
    update: 'desktop:overlays:update',
    move: 'desktop:overlays:move',
    setIgnoreMouseEvents: 'desktop:overlays:set-ignore-mouse-events',
    activateOwner: 'desktop:overlays:activate-owner',
    focus: 'desktop:overlays:focus',
    close: 'desktop:overlays:close',
    list: 'desktop:overlays:list',
    closed: 'desktop:overlays:closed',
  },
  plugins: {
    list: 'desktop:plugins:list',
    setEnabled: 'desktop:plugins:set-enabled',
    clearFailure: 'desktop:plugins:clear-failure',
    failureChanged: 'desktop:plugins:failure-changed',
    relaunch: 'desktop:plugins:relaunch',
  },
} as const
