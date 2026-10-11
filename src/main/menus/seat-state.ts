/** Pure state and scheduling helpers for native desktop menu contributions. */

export interface ComparableSeatContribution {
  wcId: number
  seat: string
  contributor: string
  menu: string
  order: number
  tooltip: string | undefined
  items: readonly unknown[]
}

function sameIdentity(a: ComparableSeatContribution, b: ComparableSeatContribution): boolean {
  return (
    a.wcId === b.wcId && a.seat === b.seat && a.contributor === b.contributor && a.menu === b.menu
  )
}

function sameContribution(a: ComparableSeatContribution, b: ComparableSeatContribution): boolean {
  return (
    sameIdentity(a, b) &&
    a.order === b.order &&
    a.tooltip === b.tooltip &&
    JSON.stringify(a.items) === JSON.stringify(b.items)
  )
}

/** Upsert one bounded JSON contribution and report whether rendered state changed. */
export function upsertContribution<T extends ComparableSeatContribution>(
  rows: T[],
  row: T,
): boolean {
  const index = rows.findIndex((candidate) => sameIdentity(candidate, row))
  if (index < 0) {
    rows.push(row)
    return true
  }
  if (sameContribution(rows[index], row)) return false
  rows[index] = row
  return true
}

export interface TrailingClock<Handle> {
  set(task: () => void, delayMs: number): Handle
  clear(handle: Handle): void
  unref?(handle: Handle): void
}

/** Scope one renderer item id to the native menu surface that owns it. */
export function nativeMenuItemId(
  contribution: Pick<ComparableSeatContribution, 'seat' | 'menu' | 'contributor'>,
  itemId: string,
): string {
  return `${contribution.seat}:${contribution.menu}:${contribution.contributor}:${itemId}`
}

/** Replace a pending timer so a burst runs exactly one trailing task. */
export function scheduleTrailing<Handle>(
  current: Handle | null,
  task: () => void,
  delayMs: number,
  clock: TrailingClock<Handle>,
): Handle {
  if (current !== null) clock.clear(current)
  const next = clock.set(task, delayMs)
  clock.unref?.(next)
  return next
}
