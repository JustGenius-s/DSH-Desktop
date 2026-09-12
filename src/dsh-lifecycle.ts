/**
 * 网页服务热重启的注册表：main.ts 提供实现，更新桥 / 菜单 / 插件 IPC 共用。
 *
 * 桌面壳（Electron）保持运行，只杀掉并拉起 `dsh web` 子进程，再让主窗口
 * 重新加载。插件配置、DSH 运行时升级都走这条路径，不再强制 `app.relaunch()`。
 *
 * 询问用 DSH 网页 Modal（由 desktop-update 插件渲染），不走系统原生 dialog。
 */

import { randomUUID } from 'node:crypto'
import { app, ipcMain } from 'electron'
import type { DesktopRestartChoice, DesktopRestartPrompt } from './api'
import { Ipc } from './ipc'
import { focusMainWindow, getMainWindow } from './windows'

export type RestartWebReason = 'plugin' | 'dsh-runtime'

export interface DshWebHostControl {
  restart: () => Promise<void>
  isReady: () => boolean
}

let control: DshWebHostControl | null = null

export function registerDshWebHost(next: DshWebHostControl): void {
  control = next
}

/** 立刻重启网页服务（菜单 / IPC 显式动作，不再弹确认框）。 */
export async function restartDshWeb(): Promise<void> {
  if (control === null) throw new Error('DSH 网页服务尚未就绪')
  if (!control.isReady()) throw new Error('DSH 网页服务尚未就绪')
  await control.restart()
}

const COPY: Record<RestartWebReason, { zh: { title: string; message: string; detail: string; later: string; restart: string }; en: { title: string; message: string; detail: string; later: string; restart: string } }> = {
  plugin: {
    zh: {
      title: '插件配置已变更',
      message: '检测到插件配置有更新，但尚未生效',
      detail: '重启 DSH 网页服务即可加载新配置，桌面应用本身不会关闭。选择「稍后」可继续用当前服务，之后仍可从菜单 View → Restart DSH Service 手动重启。',
      later: '稍后',
      restart: '立即重启服务',
    },
    en: {
      title: 'Plugin configuration changed',
      message: 'Plugin configuration changed, but is not applied yet',
      detail: 'Restart the DSH web service to load the new configuration. DSH-Desktop itself will stay open. Choose Later to keep the current service; you can still restart later from View → Restart DSH Service.',
      later: 'Later',
      restart: 'Restart service now',
    },
  },
  'dsh-runtime': {
    zh: {
      title: 'DSH 运行时已更新',
      message: '新版本已安装完成',
      detail: '重启 DSH 网页服务即可切换到新版本，无需关闭 DSH-Desktop。选择「稍后」将继续使用当前版本，直到下次重启服务。',
      later: '稍后',
      restart: '立即重启服务',
    },
    en: {
      title: 'DSH runtime updated',
      message: 'The new runtime is installed',
      detail: 'Restart the DSH web service to switch to the new version. DSH-Desktop itself will stay open. Choose Later to keep the current version until the next service restart.',
      later: 'Later',
      restart: 'Restart service now',
    },
  },
}

function isZh(): boolean {
  return app.getLocale().toLowerCase().startsWith('zh')
}

const ACK_RETRY_MS = 400
const ACK_TRIES = 8
const RESPOND_TIMEOUT_MS = 120_000

interface PendingPrompt {
  id: string
  acked: boolean
  resolve: (choice: DesktopRestartChoice | 'dropped') => void
}

let pending: PendingPrompt | null = null
let ipcReady = false
let offerChain: Promise<unknown> = Promise.resolve()

function settlePending(id: string, choice: DesktopRestartChoice | 'dropped'): void {
  if (pending === null || pending.id !== id) return
  const { resolve } = pending
  pending = null
  resolve(choice)
}

/** 注册询问 IPC。setupDesktopBridge 时调一次。 */
export function setupRestartPromptIpc(): void {
  if (ipcReady) return
  ipcReady = true
  ipcMain.on(Ipc.updates.promptAck, (_event, id: unknown) => {
    if (typeof id !== 'string' || pending === null || pending.id !== id) return
    pending.acked = true
  })
  ipcMain.on(Ipc.updates.promptResponse, (_event, id: unknown, choice: unknown) => {
    if (typeof id !== 'string') return
    if (choice !== 'later' && choice !== 'restart') return
    settlePending(id, choice)
  })
}

function sendPrompt(prompt: DesktopRestartPrompt): boolean {
  const win = getMainWindow()
  if (win === undefined || win.isDestroyed() || win.webContents.isDestroyed()) return false
  try {
    focusMainWindow()
    win.webContents.send(Ipc.updates.prompt, prompt)
    return true
  } catch {
    return false
  }
}

async function askRenderer(reason: RestartWebReason): Promise<DesktopRestartChoice | 'dropped'> {
  const zh = isZh()
  const copy = COPY[reason][zh ? 'zh' : 'en']
  const prompt: DesktopRestartPrompt = {
    id: randomUUID(),
    reason,
    title: copy.title,
    message: copy.message,
    detail: copy.detail,
    later: copy.later,
    restart: copy.restart,
  }

  return new Promise((resolve) => {
    pending = { id: prompt.id, acked: false, resolve }
    let tries = 0
    const tick = (): void => {
      if (pending === null || pending.id !== prompt.id) return
      if (pending.acked) return
      tries += 1
      if (tries > ACK_TRIES) {
        console.warn('[DSH-Desktop] restart prompt not acknowledged by page, skipping')
        settlePending(prompt.id, 'dropped')
        return
      }
      if (!sendPrompt(prompt)) {
        if (tries >= ACK_TRIES) settlePending(prompt.id, 'dropped')
        else setTimeout(tick, ACK_RETRY_MS).unref?.()
        return
      }
      setTimeout(tick, ACK_RETRY_MS).unref?.()
    }
    tick()
    setTimeout(() => {
      settlePending(prompt.id, 'dropped')
    }, RESPOND_TIMEOUT_MS).unref?.()
  })
}

/**
 * 弹窗询问是否重启网页服务；用户选「稍后」则什么都不做。
 * 不强制重启。服务尚未起来时静默跳过。
 * 询问交给网页里的 DSH Modal；页面没接住则当作稍后。
 */
export async function offerRestartDshWeb(reason: RestartWebReason): Promise<boolean> {
  const run = offerChain.then(() => offerRestartDshWebImpl(reason), () => offerRestartDshWebImpl(reason))
  offerChain = run.then(() => undefined, () => undefined)
  return run
}

async function offerRestartDshWebImpl(reason: RestartWebReason): Promise<boolean> {
  if (control === null || !control.isReady()) return false
  setupRestartPromptIpc()
  const choice = await askRenderer(reason)
  if (choice !== 'restart') return false
  try {
    await restartDshWeb()
    return true
  } catch (err) {
    console.error('[DSH-Desktop] restart web failed', err)
    return false
  }
}
