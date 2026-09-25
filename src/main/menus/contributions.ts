/** 菜单贡献的校验与默认值；不依赖 Electron 菜单实例。 */
import {
  DESKTOP_ID_RE,
  type DesktopMenuAttach,
  type DesktopMenuItemSpec,
  type DesktopSeatName,
} from '../../shared/api'

const MAX_ITEMS = 24
const MAX_DEPTH = 2
const MAX_LABEL = 120
const ACCEL_RE =
  /^(?:(?:CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|AltGr|Shift|Super|Meta)\+)*(?:[A-Za-z0-9]+|F(?:[1-9]|1[0-9]|2[0-4])|Plus|Space|Tab|Backspace|Delete|Return|Enter|Up|Down|Left|Right)$/

export interface MenuContribution {
  seat: DesktopSeatName
  contributor: string
  menu: DesktopMenuAttach
  order: number
  tooltip: string | undefined
  items: DesktopMenuItemSpec[]
}

function sanitizeItems(raw: unknown, depth: number): DesktopMenuItemSpec[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS || depth > MAX_DEPTH) return null
  const out: DesktopMenuItemSpec[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return null
    const item = entry as Record<string, unknown>
    if (item.type === 'separator') {
      out.push({ type: 'separator' })
      continue
    }
    const type =
      item.type === 'checkbox' || item.type === 'radio' || item.type === 'normal'
        ? item.type
        : 'normal'
    if (typeof item.id !== 'string' || !DESKTOP_ID_RE.test(item.id)) return null
    if (
      typeof item.label !== 'string' ||
      item.label.length === 0 ||
      item.label.length > MAX_LABEL
    ) {
      return null
    }
    const spec: DesktopMenuItemSpec = {
      id: item.id,
      type,
      label: item.label,
    }
    if (typeof item.enabled === 'boolean') spec.enabled = item.enabled
    if (typeof item.visible === 'boolean') spec.visible = item.visible
    if (typeof item.checked === 'boolean') spec.checked = item.checked
    if (typeof item.accelerator === 'string' && ACCEL_RE.test(item.accelerator)) {
      spec.accelerator = item.accelerator
    }
    if (item.submenu !== undefined) {
      const nested = sanitizeItems(item.submenu, depth + 1)
      if (nested === null) return null
      spec.submenu = nested
    }
    out.push(spec)
  }
  return out
}

export function sanitizeContribution(raw: unknown): MenuContribution | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (obj.seat !== 'applicationMenu' && obj.seat !== 'tray') return null
  if (typeof obj.contributor !== 'string' || !DESKTOP_ID_RE.test(obj.contributor)) return null
  const items = sanitizeItems(obj.items, 0)
  if (items === null) return null
  const menu: DesktopMenuAttach = obj.menu === 'app' ? 'app' : 'plugins'
  const order = typeof obj.order === 'number' && Number.isFinite(obj.order) ? obj.order : 0
  const tooltip =
    typeof obj.tooltip === 'string' && obj.tooltip.length > 0 && obj.tooltip.length <= MAX_LABEL
      ? obj.tooltip
      : undefined
  return { seat: obj.seat, contributor: obj.contributor, menu, order, items, tooltip }
}
