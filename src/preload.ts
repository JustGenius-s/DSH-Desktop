/**
 * DSH-Desktop preload：以 contextBridge 向 DSH 网页暴露标准桌面 API。
 *
 * 契约见 `./api`（updates / seats / notify）。本文件只做 IPC 转发，
 * 不引入 Menu / Tray / Notification。普通浏览器没有 window.dshDesktop。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopContribution,
  DesktopNotifyAction,
  DesktopNotifySpec,
  DesktopSeatAction,
  DesktopSeatName,
  DesktopUpdateKind,
  DesktopUpdateState,
  DshDesktop,
} from './api'
import { Ipc } from './ipc'

const api: DshDesktop = {
  updates: {
    getState: (): Promise<DesktopUpdateState> => ipcRenderer.invoke(Ipc.updates.getState),
    onState: (listener: (state: DesktopUpdateState) => void): (() => void) => {
      const wrapped = (_event: unknown, state: DesktopUpdateState) => listener(state)
      ipcRenderer.on(Ipc.updates.state, wrapped)
      return () => ipcRenderer.removeListener(Ipc.updates.state, wrapped)
    },
    checkNow: (): Promise<DesktopUpdateState> => ipcRenderer.invoke(Ipc.updates.checkNow),
    downloadApp: (): Promise<void> => ipcRenderer.invoke(Ipc.updates.downloadApp),
    updateDsh: (): Promise<void> => ipcRenderer.invoke(Ipc.updates.updateDsh),
    skipVersion: (kind: DesktopUpdateKind): Promise<void> =>
      ipcRenderer.invoke(Ipc.updates.skipVersion, kind),
    setGate: (kind: DesktopUpdateKind, enabled: boolean): Promise<DesktopUpdateState> =>
      ipcRenderer.invoke(Ipc.updates.setGate, kind, enabled),
    relaunch: (): void => ipcRenderer.send(Ipc.updates.relaunch),
  },
  seats: {
    list: () => ipcRenderer.invoke(Ipc.seats.list),
    contribute: (contribution: DesktopContribution) =>
      ipcRenderer.invoke(Ipc.seats.contribute, contribution),
    revoke: (seat: DesktopSeatName, contributor: string) =>
      ipcRenderer.invoke(Ipc.seats.revoke, seat, contributor),
    onAction: (listener: (action: DesktopSeatAction) => void): (() => void) => {
      const wrapped = (_event: unknown, action: DesktopSeatAction) => listener(action)
      ipcRenderer.on(Ipc.seats.action, wrapped)
      return () => ipcRenderer.removeListener(Ipc.seats.action, wrapped)
    },
  },
  notify: {
    show: (spec: DesktopNotifySpec) => ipcRenderer.invoke(Ipc.notify.show, spec),
    close: (contributor: string, id?: string) =>
      ipcRenderer.invoke(Ipc.notify.close, contributor, id),
    onAction: (listener: (action: DesktopNotifyAction) => void): (() => void) => {
      const wrapped = (_event: unknown, action: DesktopNotifyAction) => listener(action)
      ipcRenderer.on(Ipc.notify.action, wrapped)
      return () => ipcRenderer.removeListener(Ipc.notify.action, wrapped)
    },
  },
}

contextBridge.exposeInMainWorld('dshDesktop', api)
