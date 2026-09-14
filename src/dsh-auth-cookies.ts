/** Cookie helpers for the loopback DSH web host. */

export const DSH_AUTH_COOKIE_PREFIX = 'dsh-auth-'

export interface DshAuthCookie {
  name?: unknown
  domain?: unknown
  path?: unknown
  secure?: unknown
}

export function isDshAuthCookie(cookie: DshAuthCookie): boolean {
  if (typeof cookie.name !== 'string' || !cookie.name.startsWith(DSH_AUTH_COOKIE_PREFIX)) return false
  return cookie.domain === '127.0.0.1' || cookie.domain === '.127.0.0.1'
}

export function dshAuthCookieUrl(cookie: DshAuthCookie): string {
  const domain = cookie.domain === '.127.0.0.1' ? '127.0.0.1' : String(cookie.domain ?? '127.0.0.1')
  const path = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/'
  const scheme = cookie.secure === true ? 'https' : 'http'
  return `${scheme}://${domain}${path}`
}
