// The output pane's sentences: the status line, the live region at completion, and byte and row counts.

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

export type StatusKind = 'running' | 'completed' | 'failed' | 'cancelled' | 'timedOut' | 'lost' | 'closed'
const lead: Record<Exclude<StatusKind, 'lost'>, string> = {
  running: 'Executing query…', completed: 'Query executed successfully.', failed: 'Query completed with errors.', cancelled: 'Query was cancelled.', timedOut: 'Query timed out.',
  closed: 'Query executed successfully.'
}
/** The status line: "Executing query… · 00:00:03 · 1,234 rows", with " · 2/3 batches" when the script has several. */
export function statusSentence(o: { status: StatusKind; elapsedMs: number; rows: number; completedBatches: number; totalBatches: number }): string {
  if (o.status === 'lost') return 'The SQL backend stopped while this query was running.'
  const text = `${lead[o.status]} · ${formatElapsed(o.elapsedMs)} · ${formatCount(o.rows)} ${plural(o.rows, 'row')}`
  return o.totalBatches > 1 ? `${text} · ${o.completedBatches}/${o.totalBatches} batches` : text
}

/** What the live region says when a run ends. */
export function completionSentence(status: StatusKind, sets: number, rows: number): string {
  if (status === 'completed') return `Query executed successfully. ${formatCount(sets)} result ${plural(sets, 'set')}, ${formatCount(rows)} ${plural(rows, 'row')}.`
  if (status === 'lost') return 'The SQL backend stopped while this query was running.'
  return lead[status === 'running' ? 'failed' : status]
}
