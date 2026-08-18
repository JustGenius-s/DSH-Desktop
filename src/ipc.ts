/**
 * 主进程 ↔ preload 的 IPC 频道名。插件看不见这些字符串，
 * 只通过 window.dshDesktop 的三族方法说话。
 */

export const Ipc = {
  updates: {
    getState: 'desktop:updates:get-state',
    state: 'desktop:updates:state',
    checkNow: 'desktop:updates:check-now',
    downloadApp: 'desktop:updates:download-app',
    updateDsh: 'desktop:updates:update-dsh',
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
} as const
