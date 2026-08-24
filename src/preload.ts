/**
 * DSH-Desktop preload：以 contextBridge 向 DSH 网页暴露标准桌面 API。
 *
 * 契约见 `./api`（updates / seats / notify / overlays）。本文件只做 IPC 转发，
 * 不引入 Menu / Tray / Notification / BrowserWindow。普通浏览器没有 window.dshDesktop。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopContribution,
  DesktopNotifyAction,
  DesktopNotifySpec,
  DesktopOverlayClosed,
  DesktopOverlayMoveSpec,
  DesktopOverlayOpenSpec,
  DesktopOverlayUpdateSpec,
  DesktopRestartChoice,
  DesktopRestartPrompt,
  DesktopSeatAction,
  DesktopSeatName,
  DesktopUpdateKind,
  DesktopUpdateState,
  DshChannel,
  DshDesktop,
} from './api'
import type { Ipc as IpcShape } from './ipc'

// 窗口 webPreferences 开了 sandbox:true，sandboxed preload 的 require 只认
// electron 等极少数模块，require('./ipc') 会直接抛错、整个 preload 夭折，
// window.dshDesktop 永远注入不进来。因此频道常量必须内联在本文件里；
// import type 编译后完全擦除（不产生 require），satisfies 把下面每个
// 字面量值强绑定到 ./ipc.ts 的 as const 类型上——任一边改了一个字符，
// tsc 都会在这里报错，无需人工同步。
const Ipc = {
  updates: {
    getState: 'desktop:updates:get-state',
    state: 'desktop:updates:state',
    checkNow: 'desktop:updates:check-now',
    downloadApp: 'desktop:updates:download-app',
    updateDsh: 'desktop:updates:update-dsh',
    setDshChannel: 'desktop:updates:set-dsh-channel',
    skipVersion: 'desktop:updates:skip-version',
    setGate: 'desktop:updates:set-gate',
    restartWeb: 'desktop:updates:restart-web',
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
} satisfies typeof IpcShape

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
    setDshChannel: (channel: DshChannel, version?: string): Promise<DesktopUpdateState> =>
      ipcRenderer.invoke(Ipc.updates.setDshChannel, channel, version),
    skipVersion: (kind: DesktopUpdateKind): Promise<void> =>
      ipcRenderer.invoke(Ipc.updates.skipVersion, kind),
    setGate: (kind: DesktopUpdateKind, enabled: boolean): Promise<DesktopUpdateState> =>
      ipcRenderer.invoke(Ipc.updates.setGate, kind, enabled),
    restartWeb: (): Promise<void> => ipcRenderer.invoke(Ipc.updates.restartWeb),
    onPrompt: (listener: (prompt: DesktopRestartPrompt) => void): (() => void) => {
      const wrapped = (_event: unknown, prompt: DesktopRestartPrompt) => listener(prompt)
      ipcRenderer.on(Ipc.updates.prompt, wrapped)
      return () => ipcRenderer.removeListener(Ipc.updates.prompt, wrapped)
    },
    ackPrompt: (id: string): void => {
      ipcRenderer.send(Ipc.updates.promptAck, id)
    },
    respondPrompt: (id: string, choice: DesktopRestartChoice): void => {
      ipcRenderer.send(Ipc.updates.promptResponse, id, choice)
    },
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
  overlays: {
    open: (spec: DesktopOverlayOpenSpec) => ipcRenderer.invoke(Ipc.overlays.open, spec),
    update: (id: string, spec: DesktopOverlayUpdateSpec) =>
      ipcRenderer.invoke(Ipc.overlays.update, id, spec),
    move: (id: string, spec: DesktopOverlayMoveSpec) =>
      ipcRenderer.invoke(Ipc.overlays.move, id, spec),
    setIgnoreMouseEvents: (id: string, ignore: boolean, opts?: { forward?: boolean }) =>
      ipcRenderer.invoke(Ipc.overlays.setIgnoreMouseEvents, id, ignore, opts),
    focus: (id: string) => ipcRenderer.invoke(Ipc.overlays.focus, id),
    close: (id: string) => ipcRenderer.invoke(Ipc.overlays.close, id),
    list: () => ipcRenderer.invoke(Ipc.overlays.list),
    onClosed: (listener: (event: DesktopOverlayClosed) => void): (() => void) => {
      const wrapped = (_event: unknown, event: DesktopOverlayClosed) => listener(event)
      ipcRenderer.on(Ipc.overlays.closed, wrapped)
      return () => ipcRenderer.removeListener(Ipc.overlays.closed, wrapped)
    },
  },
}

contextBridge.exposeInMainWorld('dshDesktop', api)
