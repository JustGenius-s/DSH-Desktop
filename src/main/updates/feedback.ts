/**
 * DSH 运行时更新的用户可见反馈：开始 / 完成 / 失败各给一次明确回执。
 *
 * 单独成文件是为了让 updates/bridge 不直接碰 Electron 的
 * Notification / dialog——更新流程本身（装、重启询问）与「怎么告诉用户」
 * 是两件事，分开后桥只管编排。
 *
 * 通道是系统通知而非网页 Modal：安装由菜单点击发起，用户可能正切在别的
 * App 里，只有系统通知能在那种情况下送达。
 */

import { Notification, dialog } from 'electron'
import type { ShellLang } from '../locale'

interface Copy {
  started: string
  done: string
  /** 装完但还没重启服务时的补充说明。 */
  pendingRestart: string
  /** 装完且已生效。 */
  applied: string
  failedTitle: string
}

const COPY: Record<ShellLang, Copy> = {
  zh: {
    started: '正在更新 DSH 运行时…',
    done: 'DSH 运行时已更新',
    pendingRestart: '重启 DSH 服务后生效',
    applied: '已生效',
    failedTitle: 'DSH 运行时更新失败',
  },
  en: {
    started: 'Updating DSH runtime…',
    done: 'DSH runtime updated',
    pendingRestart: 'Takes effect after restarting the DSH service',
    applied: 'Already in effect',
    failedTitle: 'DSH runtime update failed',
  },
}

/**
 * 弹一条系统通知；不支持 / 构造失败都静默——反馈不是主流程，
 * 不能因为通知弹不出来就把一次成功的更新判成失败。
 */
function notify(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return
    new Notification({ title, body, silent: true }).show()
  } catch (err) {
    console.warn('[DSH-Desktop] update notification failed', err)
  }
}

/** 通知「开始安装」：用户点完菜单立刻能看到东西在跑。 */
export function notifyDshUpdateStarted(lang: ShellLang, version: string): void {
  notify(COPY[lang].started, version)
}

/** 通知「装完了」，并说明是否还要重启服务才生效。 */
export function notifyDshUpdateDone(lang: ShellLang, version: string, needsRestart: boolean): void {
  const copy = COPY[lang]
  notify(copy.done + ' ' + version, needsRestart ? copy.pendingRestart : copy.applied)
}

/** 装失败：弹错误框，把失败原因带上，别只留一句「失败」。 */
export function reportDshUpdateFailure(lang: ShellLang, err: unknown): void {
  console.error('[DSH-Desktop] dsh runtime update failed', err)
  const message = err instanceof Error ? err.message : String(err)
  try {
    dialog.showErrorBox(COPY[lang].failedTitle, message)
  } catch (dialogErr) {
    console.error('[DSH-Desktop] update failure dialog failed', dialogErr)
  }
}
