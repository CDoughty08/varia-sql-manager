// The Backup Timeline's arithmetic (D1e): server-local times as plain numbers (the server's clock, not this machine's
// zone), the window an interval shows, and the keys that move the point. Pure, for vitest.
import { timelineIntervalSpecs, type BackupSetRow, type TimelineInterval } from '../../../shared/actions/restore.ts'
import { logCoverage } from '../../../shared/actions/restore-plan.ts'

const pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/
/** A server-local yyyy-MM-ddTHH:mm:ss as milliseconds on a zone-free clock, or undefined. */
export function timeMs(text: string): number | undefined {
  const match = pattern.exec(text)
  if (!match) return undefined
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const ms = Date.UTC(year, month - 1, day, hour, minute, second)
  return new Date(ms).getUTCDate() === day ? ms : undefined
}
const two = (value: number) => String(value).padStart(2, '0')
/** The inverse of timeMs, to the second. */
export function timeText(ms: number): string {
  const at = new Date(Math.floor(ms / 1000) * 1000)
  return `${at.getUTCFullYear()}-${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())}T${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())}`
}

export interface TimelineWindow { readonly from: number; readonly to: number }
/** The span the timeline shows: the interval, ending at the last backup's finish, or later when the point is after it. */
export function timelineWindow(sets: readonly BackupSetRow[], interval: TimelineInterval, point?: number): TimelineWindow {
  const finishes = sets.map(set => timeMs(set.finish)).filter((ms): ms is number => ms !== undefined)
  const last = finishes.length > 0 ? Math.max(...finishes) : point ?? 0
  const to = point !== undefined && point > last ? point : last
  return { from: to - timelineIntervalSpecs[interval].ms, to }
}
/** Where a key moves the point: a minute with the arrows, an hour with Shift, the window's ends with Home and End. */
export function stepPoint(key: string, shift: boolean, point: number, window: TimelineWindow): number | undefined {
  const step = shift ? 3_600_000 : 60_000
  switch (key) {
    case 'ArrowRight': case 'ArrowUp': return point + step
    case 'ArrowLeft': case 'ArrowDown': return point - step
    case 'PageUp': return point + 3_600_000
    case 'PageDown': return point - 3_600_000
    case 'Home': return window.from
    case 'End': return window.to
    default: return undefined
  }
}
/** The fraction of the window a time is at, clamped to it. */
export const position = (ms: number, window: TimelineWindow): number => window.to === window.from ? 1 : Math.min(1, Math.max(0, (ms - window.from) / (window.to - window.from)))
/** The green stretches log backups cover, as fractions of the window. */
export function coverage(sets: readonly BackupSetRow[], window: TimelineWindow): { readonly from: number; readonly to: number }[] {
  return logCoverage(sets).flatMap(stretch => {
    const from = timeMs(stretch.from), to = timeMs(stretch.to)
    return from === undefined || to === undefined || to < window.from || from > window.to ? [] : [{ from: position(from, window), to: position(to, window) }]
  })
}
