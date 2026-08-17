/**
 * DSH-Desktop preload：以 contextBridge 向 DSH 网页暴露桌面专属能力。
 * 网页是纯 SPA，只在 Electron 里才有 window.dshDesktop；普通浏览器打开时
 * 该对象为 undefined，更新徽章插件据此决定渲染与否。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopContribution,
  DesktopSeatAction,
  DesktopSeatInfo,
  DesktopSeatName,
} from './desktop-seats'

/** 桌面更新状态：App 本体与 DSH 运行时各自的可更新信息（无更新为 null）。 */
export interface DesktopUpdateInfo {
  current: string
  latest: string
  url?: string
}

export interface DesktopUpdateState {
  app: DesktopUpdateInfo | null
  dsh: DesktopUpdateInfo | null
  checking: boolean
  config: { checkApp: boolean; checkDsh: boolean }
  versions: { app: string; dsh: string | null }
}

contextBridge.exposeInMainWorld('dshDesktop', {
  /** 读取当前更新状态快照。 */
  getUpdateState: (): Promise<DesktopUpdateState> => ipcRenderer.invoke('desktop:get-update-state'),

  /** 订阅更新状态变化；返回取消订阅函数。 */
  onUpdateState: (listener: (state: DesktopUpdateState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: DesktopUpdateState) => listener(state)
    ipcRenderer.on('desktop:update-state', wrapped)
    return () => ipcRenderer.removeListener('desktop:update-state', wrapped)
  },

  /** 打开 App 新版本的下载页（GitHub Releases）。 */
  downloadAppUpdate: (): Promise<void> => ipcRenderer.invoke('desktop:download-app-update'),

  /** 升级 DSH 运行时到检测到的最新版本（pnpm 安装，完成后需重启 App 生效）。 */
  updateDsh: (): Promise<void> => ipcRenderer.invoke('desktop:update-dsh'),

  /** 立即重新检测一次更新（通常在点击徽章时调用）。 */
  checkNow: (): Promise<DesktopUpdateState> => ipcRenderer.invoke('desktop:check-now'),

  /** 「跳过该版本」：当前 latest 不再亮徽章，出现更新的版本后恢复。 */
  skipVersion: (kind: 'app' | 'dsh'): Promise<void> => ipcRenderer.invoke('desktop:skip-version', kind),

  /** 写一个自动检查开关（持久化到 DSH settings.yaml 的 desktop-update 分节）。 */
  setGate: (kind: 'app' | 'dsh', enabled: boolean): Promise<DesktopUpdateState> =>
    ipcRenderer.invoke('desktop:set-gate', kind, enabled),

  /** 重启应用（DSH 运行时升级完成后调用）。 */
  relaunch: (): void => ipcRenderer.send('desktop:relaunch'),

  /**
   * 桌面席位：主进程声明 applicationMenu / tray，插件只提交菜单规格。
   * 普通浏览器没有该对象；点击以 id 回传，不暴露 Electron Menu。
   */
  seats: {
    list: (): Promise<DesktopSeatInfo[]> => ipcRenderer.invoke('desktop:seats-list'),
    contribute: (contribution: DesktopContribution): Promise<void> =>
      ipcRenderer.invoke('desktop:seats-contribute', contribution),
    revoke: (seat: DesktopSeatName, contributor: string): Promise<void> =>
      ipcRenderer.invoke('desktop:seats-revoke', seat, contributor),
    onAction: (listener: (action: DesktopSeatAction) => void): (() => void) => {
      const wrapped = (_event: unknown, action: DesktopSeatAction) => listener(action)
      ipcRenderer.on('desktop:seat-action', wrapped)
      return () => ipcRenderer.removeListener('desktop:seat-action', wrapped)
    },
  },
})

