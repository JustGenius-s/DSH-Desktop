/** 启动及热重载前的 Chromium 存储清理。 */
import { session, type Session } from 'electron'
import { dshAuthCookieUrl, isDshAuthCookie } from './auth-cookies'

/**
 * The auth cookie name includes the host port, but browser cookies do not
 * scope by port. After enough restarts, every old loopback-port cookie is sent
 * with the current plugin combo request and can exceed Node's header limit.
 * Remove only DSH's own loopback auth cookies; the next tokenized root load
 * mints the one cookie for the current host.
 */
export async function clearStaleDshAuthCookies(): Promise<void> {
  const sessions = [session.defaultSession, session.fromPartition('persist:dsh-overlay')]
  for (const ses of sessions) {
    await clearLoopbackAuthCookies(ses)
  }
}

export async function hardenChromiumStorage(): Promise<void> {
  // overlay 已改用 defaultSession。启动时不要创建 persist:dsh-overlay：
  // 首次会摸 Keychain / CA，打包版从 Finder 打开容易 SIGSEGV。
  const sessions = [session.defaultSession]
  for (const ses of sessions) {
    try {
      // Chromium 的清理调用在数据库被另一实例占用时可能既不成功也不 reject；
      // 超时后继续启动，避免 splash 尚未创建时整个应用无界面卡死。
      await withTimeout(ses.clearStorageData({ storages: ['serviceworkers'] }), 2_000)
    } catch {
      // A leftover SW LevelDB from a previous crash is noisy but not fatal.
    }
    try {
      // dsh web 每个随机端口都会种一颗 `dsh-auth-*` cookie，且 cookie 不区分端口。
      // 打包版用同一 userData 连开几十次后，`<script src="/plugins/??…">` 的 Cookie
      // 头加上 2KB+ combo URL 会超过 Node 默认 16KiB，host 回 431，页面报
      // Failed to load plugins。必须在 loadURL 之前清掉上一轮的死 cookie。
      await withTimeout(clearLoopbackAuthCookies(ses), 2_000)
    } catch {
      // Cookie 库被锁时同样不阻断启动；子进程还有 header-size 兜底。
    }
  }
}

/** 删掉上一轮 localhost 会话留下的 `dsh-auth-*`，避免 Cookie 头把 combo 请求顶到 431。 */
async function clearLoopbackAuthCookies(ses: Session): Promise<void> {
  const cookies = await ses.cookies.get({ domain: '127.0.0.1' })
  const stale = cookies.filter(isDshAuthCookie)
  if (stale.length === 0) return
  await Promise.all(
    stale.map((cookie) => ses.cookies.remove(dshAuthCookieUrl(cookie), cookie.name)),
  )
  console.log(`[DSH-Desktop] cleared ${String(stale.length)} leftover 127.0.0.1 auth cookies`)
}

function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolveTimeout, rejectTimeout) => {
    const timer = setTimeout(resolveTimeout, timeoutMs)
    promise.then(
      () => {
        clearTimeout(timer)
        resolveTimeout()
      },
      (err: unknown) => {
        clearTimeout(timer)
        rejectTimeout(err)
      },
    )
  })
}
