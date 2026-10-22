// The states kit's words: live labels, ages, stale notices and the text Copy details puts on the clipboard. Kept pure
// so the sentences are tested once and every live view says the same thing.
import type { ErrorDetails } from '../../../shared/contracts'

const pad = (value: number) => String(value).padStart(2, '0')

/** An interval as people say it: "500 ms", "2 s", "1.5 s", "1 min", "1 min 30 s", "1 h". */
export function formatInterval(ms: number): string {
  const value = Math.max(0, Math.round(ms))
  if (value < 1000) return `${value} ms`
  if (value < 60_000) return `${Number((value / 1000).toFixed(1))} s`
  const seconds = Math.round(value / 1000), minutes = Math.floor(seconds / 60), rest = seconds % 60
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`
  const hours = Math.floor(minutes / 60), restMinutes = minutes % 60
  return restMinutes ? `${hours} h ${restMinutes} min` : `${hours} h`
}

/** How long ago something happened: "just now" under a second, then whole seconds, minutes, hours and days. */
export function formatAge(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 1) return 'just now'
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`
}

/** A time of day on the local clock, 24-hour with seconds ("22:44:03"), as live views stamp their samples. */
export function formatClock(time: number | Date): string {
  const date = typeof time === 'number' ? new Date(time) : time
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * What a live view is doing: the live layer's subscription status (D-live §6.1, `LiveSnapshot.status`), plus `slowed`,
 * which is `live` while the server asks for a longer interval than the one chosen.
 */
export type LiveState = 'connecting' | 'live' | 'slowed' | 'paused' | 'dormant' | 'lost' | 'ended'
/** Why a subscription ended (the live layer's `LiveEnd.ended`). */
export type LiveEndReason = 'cancelled' | 'disconnected' | 'sourceEnded' | 'failed' | 'shutdown'
export interface LiveStatus {
  readonly state: LiveState
  readonly intervalMs: number
  readonly effectiveMs?: number
  /** Who paused it: the person, or the view being hidden (which the live layer resumes by itself). */
  readonly pausedBy?: 'hidden' | 'user'
  readonly ended?: LiveEndReason
}

/**
 * "Live · every 2 s", "Live · slowed to 4 s", "Starting…" before the first sample, "Paused" or "Paused while hidden",
 * "Stopped while hidden" (dormant: it starts again when shown), "Stopped · backend unavailable" once the backend was
 * lost, and for an ended view "Finished", "Disconnected", "Stopped · failed" or "Stopped".
 */
export function liveLabel({ state, intervalMs, effectiveMs, pausedBy, ended }: LiveStatus): string {
  switch (state) {
    case 'connecting': return 'Starting…'
    case 'paused': return pausedBy === 'hidden' ? 'Paused while hidden' : 'Paused'
    case 'dormant': return 'Stopped while hidden'
    case 'lost': return 'Stopped · backend unavailable'
    case 'ended': return ended === 'sourceEnded' ? 'Finished' : ended === 'disconnected' ? 'Disconnected' : ended === 'failed' ? 'Stopped · failed' : 'Stopped'
    case 'slowed': if (effectiveMs !== undefined && effectiveMs > intervalMs) return `Live · slowed to ${formatInterval(effectiveMs)}`
  }
  return `Live · every ${formatInterval(intervalMs)}`
}

/** The glyph a view that is not collecting shows in place of the dot. */
export function liveIcon({ state, ended }: LiveStatus): string | undefined {
  switch (state) {
    case 'connecting': return 'circle-outline'
    case 'paused': case 'dormant': return 'debug-pause'
    case 'lost': return 'debug-disconnect'
    case 'ended': return ended === 'disconnected' ? 'debug-disconnect' : ended === 'sourceEnded' ? 'pass' : 'debug-stop'
    default: return undefined
  }
}

/** A live view's age line: "Updated 12 s ago", or "Waiting for data" before the first sample. */
export function updatedLabel(updatedAt: number | undefined, now: number): string {
  return updatedAt === undefined ? 'Waiting for data' : `Updated ${formatAge(now - updatedAt)}`
}

/** "Stale since 22:44:03 · retrying in 4 s" (or "· retrying now" once the retry is due). */
export function staleLabel(since: number, now: number, retryAt?: number): string {
  const retry = retryAt === undefined ? '' : retryAt <= now ? ' · retrying now' : ` · retrying in ${formatInterval(Math.ceil((retryAt - now) / 1000) * 1000)}`
  return `Stale since ${formatClock(since)}${retry}`
}

/** The outcome of the last Copy details: which text it took, and whether main put it on the clipboard. */
export interface CopyRecord { readonly text: string; readonly ok: boolean }

/** Copies through `write` and settles with the outcome; a rejected write counts as not copied, never as an error. */
export function copyText(write: (text: string) => Promise<{ readonly ok: boolean }>, text: string): Promise<CopyRecord> {
  return write(text).then(result => ({ text, ok: result.ok === true }), () => ({ text, ok: false }))
}

/** What Copy details says, only about the details shown now: an error that replaces the copied one says nothing yet. */
export function copyStatus(copied: CopyRecord | undefined, text: string): string {
  if (copied?.text !== text) return ''
  return copied.ok ? 'Details copied.' : 'The details could not be copied.'
}

/** Copy details stays well inside main's clipboard limit and a support message. */
export const maxErrorDetails = 16_000

export interface ErrorReport {
  /** The sentence shown, as the backend or main wrote it. */
  readonly message: string
  /** The error code from docs/ipc.md (`SQL_ERROR`, `BACKEND_ERROR`, …), when the failure carried one. */
  readonly code?: string
  /** SQL Server's error number, state, class and server, when the failure came from SQL Server. */
  readonly details?: ErrorDetails
  /** What was being done, as in "Loading Databases on localhost". */
  readonly context?: string
  /** More for Copy details only, after a blank line, such as where a rendering fault happened. */
  readonly extra?: string
}

/**
 * The text Copy details puts on the clipboard: what was being done, the code, the message and SQL Server's numbers,
 * one per line, then any extra text; bounded. Callers pass only what the view shows plus diagnostics, never SQL text or
 * credentials.
 */
export function errorDetailsText({ message, code, details, context, extra }: ErrorReport): string {
  const sql = details && [details.number !== undefined && `Msg ${details.number}`, details.class !== undefined && `Level ${details.class}`,
    details.state !== undefined && `State ${details.state}`, details.server && `Server ${details.server}`].filter(Boolean).join(', ')
  const lines = [context, code && `Code: ${code}`, `Message: ${message}`, sql && `SQL Server: ${sql}`].filter((line): line is string => !!line)
  const text = lines.join('\n') + (extra?.trim() ? '\n\n' + extra.trim() : '')
  return text.length > maxErrorDetails ? text.slice(0, maxErrorDetails - 1) + '…' : text
}
