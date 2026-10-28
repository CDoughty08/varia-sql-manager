// The output pane's sentences: the status line, the live region at completion, and byte and row counts.
import type { MessageEntry, QueryStatus } from '../../../shared/contracts'

/** Counts in en-US grouping, as SSMS shows them. */
export const formatCount = (value: number): string => Math.max(0, Math.floor(value)).toLocaleString('en-US')
export const plural = (count: number, noun: string): string => count === 1 ? noun : noun + 's'
const pad = (value: number) => String(value).padStart(2, '0')

/** Elapsed time as hh:mm:ss (hours keep counting past 99). */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

/** Memory as the status bar shows it: "<1 MB", whole megabytes up to 9,999 MB, then gigabytes with one decimal. */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1048576
  if (mb < 1) return '<1 MB'
  if (mb < 9999.5) return formatCount(Math.round(mb)) + ' MB'
  return (bytes / 1073741824).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' GB'
}

export type StatusKind = 'running' | QueryStatus | 'lost' | 'closed'
/** SSMS's sentence for each state of a run; 'completedWithErrors' is a run whose batches all ran though some raised errors,
 *  'failed' one an error stopped. The output pane's status line and the query status bar start with it. */
export const statusLeads: Readonly<Record<Exclude<StatusKind, 'lost'>, string>> = {
  running: 'Executing query…', completed: 'Query executed successfully.', completedWithErrors: 'Query completed with errors.', failed: 'Query failed.',
  cancelled: 'Query was cancelled.', timedOut: 'Query timed out.', closed: 'Query executed successfully.'
}
/** The status line: "Executing query… · 00:00:03 · 1,234 rows", with " · 2/3 batches" when the script has several. */
export function statusSentence(o: { status: StatusKind; elapsedMs: number; rows: number; completedBatches: number; totalBatches: number }): string {
  if (o.status === 'lost') return 'The SQL backend stopped while this query was running.'
  const text = `${statusLeads[o.status]} · ${formatElapsed(o.elapsedMs)} · ${formatCount(o.rows)} ${plural(o.rows, 'row')}`
  return o.totalBatches > 1 ? `${text} · ${o.completedBatches}/${o.totalBatches} batches` : text
}

/** What the live region says when a run ends. */
export function completionSentence(status: StatusKind, sets: number, rows: number): string {
  if (status === 'completed' || status === 'completedWithErrors') return `${statusLeads[status]} ${formatCount(sets)} result ${plural(sets, 'set')}, ${formatCount(rows)} ${plural(rows, 'row')}.`
  if (status === 'lost') return 'The SQL backend stopped while this query was running.'
  return statusLeads[status === 'running' ? 'failed' : status]
}

/** A run's duration in the results head: seconds to the millisecond under a minute ("0.184 s"), then hh:mm:ss. */
export function formatDuration(ms: number): string {
  const value = Math.max(0, Math.floor(ms))
  return value < 60_000 ? (value / 1000).toFixed(3) + ' s' : formatElapsed(value)
}

/** "22:44:51" from the backend's completion time (yyyy-MM-ddTHH:mm:ss.fffffffzzz, its local time); '' without one. */
export function timeOfDay(completedAt: string | undefined): string {
  return completedAt ? /T(\d\d:\d\d:\d\d)/.exec(completedAt)?.[1] ?? '' : ''
}

const outcomes: Readonly<Record<Exclude<StatusKind, 'lost' | 'closed'>, string>> = {
  running: 'Executing', completed: 'Completed', completedWithErrors: 'Completed with errors', failed: 'Failed', cancelled: 'Cancelled', timedOut: 'Timed out'
}
export type RunTone = 'running' | 'success' | 'warning' | 'error'
export type RunIcon = 'loading' | 'pass' | 'warning' | 'error' | 'debug-stop' | 'watch'
const tones: Readonly<Record<Exclude<StatusKind, 'lost' | 'closed'>, readonly [RunTone, RunIcon]>> = {
  running: ['running', 'loading'], completed: ['success', 'pass'], completedWithErrors: ['warning', 'warning'], failed: ['error', 'error'], cancelled: ['warning', 'debug-stop'], timedOut: ['error', 'watch']
}
/** The results head's one run summary: an outcome, its facts, and SSMS's sentence for the tooltip and screen readers. */
export interface RunSummary { readonly tone: RunTone; readonly icon: RunIcon; readonly outcome: string; readonly facts: readonly string[]; readonly sentence: string }

/**
 * "Completed · 204 rows · 0.184 s · 22:44:51" (and "· 2/3 batches" for a script of several): how the run went, its rows,
 * how long it took (hh:mm:ss, ticking, while it runs) and when it ended. Results closed to free memory keep how the run
 * ended; a run the backend lost says only that.
 */
export function runSummary(o: { status: StatusKind; closedStatus?: QueryStatus; elapsedMs: number; rows: number; completedBatches: number; totalBatches: number; completedAt?: string }): RunSummary {
  const sentence = statusSentence({ status: o.status === 'closed' ? o.closedStatus ?? 'completed' : o.status, elapsedMs: o.elapsedMs, rows: o.rows, completedBatches: o.completedBatches, totalBatches: o.totalBatches })
  if (o.status === 'lost') return { tone: 'error', icon: 'error', outcome: sentence, facts: [], sentence }
  const status = o.status === 'closed' ? o.closedStatus ?? 'completed' : o.status
  const running = status === 'running', [tone, icon] = tones[status]
  const facts = [`${formatCount(o.rows)} ${plural(o.rows, 'row')}`, running ? formatElapsed(o.elapsedMs) : formatDuration(o.elapsedMs)]
  const time = running ? '' : timeOfDay(o.completedAt)
  if (time) facts.push(time)
  if (o.totalBatches > 1) facts.push(`${o.completedBatches}/${o.totalBatches} batches`)
  return { tone, icon, outcome: outcomes[status], facts, sentence }
}

/** The Messages strip's line: "Messages · 2 · no errors", or "· 1 error". */
export function messagesSummary(messages: readonly MessageEntry[]): { readonly count: number; readonly errors: number; readonly text: string } {
  let errors = 0
  for (const entry of messages) if (entry.kind === 'error') errors++
  return { count: messages.length, errors, text: `${formatCount(messages.length)} · ${errors === 0 ? 'no errors' : `${formatCount(errors)} ${plural(errors, 'error')}`}` }
}
