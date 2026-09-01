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
    // 壳只执行，不检测：没有 getState / state / checkNow / setGate /
    // setDshChannel / skipVersion 了——那些属于插件 host 半侧的检测器。
    appVersion: 'desktop:updates:app-version',
    downloadApp: 'desktop:updates:download-app',
    updateDsh: 'desktop:updates:update-dsh',
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
