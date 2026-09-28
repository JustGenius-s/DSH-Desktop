/** 启动及热重载前的 Chromium 存储清理。 */
import { session } from 'electron'
import { dshAuthCookieUrl, isDshAuthCookie } from './auth-cookies'

const STORAGE_CLEANUP_TIMEOUT_MS = 2_000

/**
 * The auth cookie name includes the host port, but browser cookies do not
 * scope by port. After enough restarts, every old loopback-port cookie is sent
 * with the current plugin combo request and can exceed Node's header limit.
 * Remove only DSH's own loopback auth cookies; the next tokenized root load
 * mints the one cookie for the current host.
 */
export async function clearStaleDshAuthCookies(): Promise<void> {
  await runBoundedCleanup(async (signal) => {
    const ses = session.defaultSession
    const cookies = await ses.cookies.get({ domain: '127.0.0.1' })
    // 超时后页面已经可以开始加载，迟到的查询不能再删除新会话的认证 cookie。
    if (signal.aborted) return
    const stale = cookies.filter(isDshAuthCookie)
    if (stale.length === 0) return
    await Promise.all(
      stale.map((cookie) => ses.cookies.remove(dshAuthCookieUrl(cookie), cookie.name)),
    )
    console.log(`[DSH-Desktop] cleared ${String(stale.length)} leftover 127.0.0.1 auth cookies`)
  })
}

export async function hardenChromiumStorage(): Promise<void> {
  // 主窗口与 overlay 共用 defaultSession；两个独立的存储清理并行完成。
  await Promise.all([
    runBoundedCleanup(() =>
      session.defaultSession.clearStorageData({ storages: ['serviceworkers'] }),
    ),
    clearStaleDshAuthCookies(),
  ])
}

async function runBoundedCleanup(cleanup: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController()
  // Chromium 存储被另一实例占用时可能既不成功也不 reject，启动和热重载都必须有界。
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve()
    }, STORAGE_CLEANUP_TIMEOUT_MS)
  })
  try {
    await Promise.race([cleanup(controller.signal), timeout])
  } catch {
    // 上次崩溃残留或数据库锁不应阻止应用启动或热重载。
  } finally {
    clearTimeout(timer)
  }
}
