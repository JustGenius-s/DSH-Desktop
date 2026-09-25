/** 校验来自网页的浮窗请求，不读取 Electron 或全局窗口状态。 */
import {
  DESKTOP_ID_RE,
  type DesktopOverlayBounds,
  type DesktopOverlayChrome,
  type DesktopOverlayIgnoreMouse,
  type DesktopOverlayOpenSpec,
} from '../../shared/api'

const MIN_SIZE = 64
const MAX_SIZE = 800
const MAX_URL = 512

export function roundInt(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  return Math.round(n)
}

function clampSize(n: number): number {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, n))
}

function sanitizeIgnore(raw: unknown): DesktopOverlayIgnoreMouse | undefined {
  if (raw === 'none' || raw === 'all' || raw === 'forward') return raw
  return undefined
}

export function sanitizeChrome(raw: unknown): DesktopOverlayChrome | null {
  if (raw === undefined) return {}
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const chrome: DesktopOverlayChrome = {}
  for (const key of [
    'transparent',
    'frame',
    'alwaysOnTop',
    'skipTaskbar',
    'resizable',
    'hasShadow',
  ] as const) {
    const value = obj[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') return null
    chrome[key] = value
  }
  if (obj.ignoreMouseEvents !== undefined) {
    const ignore = sanitizeIgnore(obj.ignoreMouseEvents)
    if (ignore === undefined) return null
    chrome.ignoreMouseEvents = ignore
  }
  return chrome
}

export function sanitizeBounds(raw: unknown, partial: boolean): DesktopOverlayBounds | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const bounds: DesktopOverlayBounds = { width: 0, height: 0 }
  if (obj.width !== undefined || !partial) {
    const width = roundInt(obj.width)
    if (width === null) return null
    bounds.width = clampSize(width)
  }
  if (obj.height !== undefined || !partial) {
    const height = roundInt(obj.height)
    if (height === null) return null
    bounds.height = clampSize(height)
  }
  if (obj.x !== undefined) {
    const x = roundInt(obj.x)
    if (x === null) return null
    bounds.x = x
  }
  if (obj.y !== undefined) {
    const y = roundInt(obj.y)
    if (y === null) return null
    bounds.y = y
  }
  return bounds
}

function sanitizePath(raw: unknown, origin: string | null): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL) return null
  if (!raw.startsWith('/') || raw.startsWith('//')) return null
  if (raw.includes('\\') || raw.includes('://')) return null
  if (origin === null) return null
  try {
    const resolved = new URL(raw, origin)
    if (resolved.origin !== new URL(origin).origin) return null
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null
    if (resolved.pathname.includes('..')) return null
    return resolved.href
  } catch {
    return null
  }
}

export function sanitizeOpen(raw: unknown, origin: string | null): DesktopOverlayOpenSpec | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.contributor !== 'string' || !DESKTOP_ID_RE.test(obj.contributor)) return null
  if (typeof obj.id !== 'string' || !DESKTOP_ID_RE.test(obj.id)) return null
  const url = sanitizePath(obj.url, origin)
  if (url === null) return null
  const bounds = sanitizeBounds(obj.bounds, false)
  if (bounds === null) return null
  const chrome = sanitizeChrome(obj.chrome)
  if (chrome === null) return null
  return { contributor: obj.contributor, id: obj.id, url, bounds, chrome }
}
