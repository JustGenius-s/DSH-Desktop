/**
 * 网页服务热重启的协调入口：app.ts 提供实现，更新桥 / 菜单 / 插件 IPC 共用。
 *
 * 重启 `dsh web` 后刷新主窗口，Electron 继续运行。
 * 重启询问通过 IPC 交给网页订阅者渲染；没有订阅者时超时跳过。
 */

import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type {
  DesktopRestartChoice,
  DesktopRestartPrompt,
  DesktopRestartWebReason,
} from '../shared/api'
import { Ipc } from '../shared/ipc'
import { currentShellLang, type ShellLang } from './locale'
import { focusMainWindow, getMainWindow } from './windows/registry'

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
  if (control === null || !control.isReady()) throw new Error('DSH 网页服务尚未就绪')
  await control.restart()
}

type RestartPromptCopy = Omit<DesktopRestartPrompt, 'id' | 'reason'>

const PROMPT_COPY: Record<DesktopRestartWebReason, Record<ShellLang, RestartPromptCopy>> = {
  plugin: {
    zh: {
      title: '插件配置已变更',
      message: '检测到插件配置有更新，但尚未生效',
      detail:
        '重启 DSH 网页服务即可加载新配置，桌面应用本身不会关闭。选择「稍后」可继续用当前服务，之后仍可从菜单 View → Restart DSH Service 手动重启。',
      later: '稍后',
      restart: '立即重启服务',
    },
    en: {
      title: 'Plugin configuration changed',
      message: 'Plugin configuration changed, but is not applied yet',
      detail:
        'Restart the DSH web service to load the new configuration. DSH-Desktop itself will stay open. Choose Later to keep the current service; you can still restart later from View → Restart DSH Service.',
      later: 'Later',
      restart: 'Restart service now',
    },
  },
  'dsh-runtime': {
    zh: {
      title: 'DSH 运行时已更新',
      message: '新版本已安装完成',
      detail:
        '重启 DSH 网页服务即可切换到新版本，无需关闭 DSH-Desktop。选择「稍后」将继续使用当前版本，直到下次重启服务。',
      later: '稍后',
      restart: '立即重启服务',
    },
    en: {
      title: 'DSH runtime updated',
      message: 'The new runtime is installed',
      detail:
        'Restart the DSH web service to switch to the new version. DSH-Desktop itself will stay open. Choose Later to keep the current version until the next service restart.',
      later: 'Later',
      restart: 'Restart service now',
    },
  },
}

const ACK_RETRY_MS = 400
const MAX_ACK_ATTEMPTS = 8
const RESPONSE_TIMEOUT_MS = 120_000

interface PendingPrompt {
  id: string
  acknowledged: boolean
  resolve: (choice: DesktopRestartChoice | 'dropped') => void
}

let pending: PendingPrompt | null = null
let ipcReady = false
let offerChain: Promise<void> = Promise.resolve()

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
    pending.acknowledged = true
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

async function askRenderer(
  reason: DesktopRestartWebReason,
): Promise<DesktopRestartChoice | 'dropped'> {
  const copy = PROMPT_COPY[reason][currentShellLang(app.getLocale())]
  const prompt: DesktopRestartPrompt = {
    id: randomUUID(),
    reason,
    ...copy,
  }

  let retryTimer: NodeJS.Timeout | undefined
  let responseTimer: NodeJS.Timeout | undefined
  try {
    return await new Promise((resolve) => {
      pending = { id: prompt.id, acknowledged: false, resolve }
      let attempts = 0
      const sendOrRetry = (): void => {
        if (pending === null || pending.id !== prompt.id || pending.acknowledged) return
        if (attempts === MAX_ACK_ATTEMPTS) {
          console.warn('[DSH-Desktop] restart prompt not acknowledged by page, skipping')
          settlePending(prompt.id, 'dropped')
          return
        }
        attempts += 1
        if (!sendPrompt(prompt) && attempts === MAX_ACK_ATTEMPTS) {
          settlePending(prompt.id, 'dropped')
          return
        }
        retryTimer = setTimeout(sendOrRetry, ACK_RETRY_MS)
        retryTimer.unref()
      }
      responseTimer = setTimeout(() => settlePending(prompt.id, 'dropped'), RESPONSE_TIMEOUT_MS)
      responseTimer.unref()
      sendOrRetry()
    })
  } finally {
    clearTimeout(retryTimer)
    clearTimeout(responseTimer)
  }
}

/**
 * 弹窗询问是否重启网页服务；用户选「稍后」则什么都不做。
 * 不强制重启。服务尚未起来时静默跳过。
 * 询问交给网页里的 DSH Modal；页面没接住则当作稍后。
 */
export async function offerRestartDshWeb(reason: DesktopRestartWebReason): Promise<boolean> {
  const run = offerChain.then(() => offerRestartDshWebImpl(reason))
  offerChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function offerRestartDshWebImpl(reason: DesktopRestartWebReason): Promise<boolean> {
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
