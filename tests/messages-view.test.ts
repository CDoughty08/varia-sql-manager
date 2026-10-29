import { describe, expect, it } from 'vitest'
import type { MessageEntry } from '../src/shared/contracts'
import { messageTail } from '../src/renderer/src/results/MessagesView'
import { completionSentence, formatCount, formatDuration, formatElapsed, messagesSummary, runSummary, statusSentence, timeOfDay } from '../src/renderer/src/results/status'
import { summaryOf } from './fixtures/results'

const info = (text: string): MessageEntry => ({ text, kind: 'info' })

describe('Messages and the status line', () => {
  it('end Messages with SSMS\'s line when there was nothing else, then the completion time', () => {
    const summary = summaryOf([])
    expect(messageTail({ status: 'running', messages: [], notices: 0, summary: undefined })).toEqual([])
    expect(messageTail({ status: 'completed', messages: [], notices: 0, summary })).toEqual(['Commands completed successfully.', '', 'Completion time: 2026-10-08T21:48:01.1234567+00:00'])
    expect(messageTail({ status: 'completed', messages: [info('(1 row affected)')], notices: 0, summary })).toEqual(['', 'Completion time: 2026-10-08T21:48:01.1234567+00:00'])
    // A failure has its error entries; one main reported has no completion time.
    expect(messageTail({ status: 'failed', messages: [{ text: 'The SQL backend stopped.', kind: 'error' }], notices: 0, summary: undefined })).toEqual([])
    expect(messageTail({ status: 'cancelled', messages: [], notices: 0, summary })).toEqual(['', 'Completion time: 2026-10-08T21:48:01.1234567+00:00'])
    // Batches that raised errors did not complete successfully, even when every batch ran and no message is shown.
    expect(messageTail({ status: 'completedWithErrors', messages: [], notices: 0, summary })).toEqual(['', 'Completion time: 2026-10-08T21:48:01.1234567+00:00'])
    // Varia's notice about a new session is not a message from SQL Server.
    expect(messageTail({ status: 'completed', messages: [info('The SQL backend restarted. This query runs in a new session.')], notices: 1, summary })).toEqual(['Commands completed successfully.', '', 'Completion time: 2026-10-08T21:48:01.1234567+00:00'])
  })
  it('say how a run is going in SSMS\'s words, with hh:mm:ss, en-US counts and batches', () => {
    expect(formatElapsed(0)).toBe('00:00:00')
    expect(formatElapsed(3_723_999)).toBe('01:02:03')
    expect(formatElapsed(360_000_000)).toBe('100:00:00')
    expect(formatCount(1_234_567)).toBe('1,234,567')
    const base = { elapsedMs: 3000, completedBatches: 1, totalBatches: 1 }
    expect(statusSentence({ ...base, status: 'running', rows: 1234 })).toBe('Executing query… · 00:00:03 · 1,234 rows')
    expect(statusSentence({ ...base, status: 'completed', rows: 1 })).toBe('Query executed successfully. · 00:00:03 · 1 row')
    // Like SSMS, the batches after one that raised an error run, and the run completes with errors; one an error stopped failed.
    expect(statusSentence({ ...base, status: 'completedWithErrors', rows: 2, completedBatches: 3, totalBatches: 3 })).toBe('Query completed with errors. · 00:00:03 · 2 rows · 3/3 batches')
    expect(statusSentence({ ...base, status: 'failed', rows: 0, completedBatches: 1, totalBatches: 3 })).toBe('Query failed. · 00:00:03 · 0 rows · 1/3 batches')
    expect(statusSentence({ ...base, status: 'cancelled', rows: 2 })).toBe('Query was cancelled. · 00:00:03 · 2 rows')
    expect(statusSentence({ ...base, status: 'timedOut', rows: 2 })).toBe('Query timed out. · 00:00:03 · 2 rows')
    expect(statusSentence({ ...base, status: 'lost', rows: 2 })).toBe('The SQL backend stopped while this query was running.')
  })
  it('announce how a run ended', () => {
    expect(completionSentence('completed', 3, 1500)).toBe('Query executed successfully. 3 result sets, 1,500 rows.')
    expect(completionSentence('completed', 1, 1)).toBe('Query executed successfully. 1 result set, 1 row.')
    expect(completionSentence('completedWithErrors', 2, 1)).toBe('Query completed with errors. 2 result sets, 1 row.')
    expect(completionSentence('failed', 0, 0)).toBe('Query failed.')
    expect(completionSentence('lost', 0, 0)).toBe('The SQL backend stopped while this query was running.')
  })
  it('sum a run up in the results head: outcome, rows, duration to the millisecond, end time and batches', () => {
    expect(formatDuration(184)).toBe('0.184 s')
    expect(formatDuration(59_999)).toBe('59.999 s')
    expect(formatDuration(60_000)).toBe('00:01:00')
    expect(formatDuration(-5)).toBe('0.000 s')
    expect(timeOfDay('2026-10-08T21:48:01.1234567+00:00')).toBe('21:48:01')
    expect(timeOfDay(undefined)).toBe('')
    expect(timeOfDay('not a time')).toBe('')
    const base = { elapsedMs: 184, rows: 204, completedBatches: 1, totalBatches: 1, completedAt: '2026-10-08T22:44:51.0000000+00:00' }
    const text = (summary: ReturnType<typeof runSummary>) => [summary.outcome, ...summary.facts].join(' · ')
    const completed = runSummary({ ...base, status: 'completed' })
    expect(text(completed)).toBe('Completed · 204 rows · 0.184 s · 22:44:51')
    expect(completed).toMatchObject({ tone: 'success', icon: 'pass', sentence: 'Query executed successfully. · 00:00:00 · 204 rows' })
    // While it runs: hh:mm:ss as it ticks, no end time; batches for a script of several.
    expect(text(runSummary({ ...base, status: 'running', elapsedMs: 3000, rows: 1, completedBatches: 1, totalBatches: 3 }))).toBe('Executing · 1 row · 00:00:03 · 1/3 batches')
    expect(runSummary({ ...base, status: 'running' })).toMatchObject({ tone: 'running', icon: 'loading' })
    expect(runSummary({ ...base, status: 'completedWithErrors', completedBatches: 3, totalBatches: 3 })).toMatchObject({ outcome: 'Completed with errors', tone: 'warning', icon: 'warning', facts: ['204 rows', '0.184 s', '22:44:51', '3/3 batches'] })
    expect(runSummary({ ...base, status: 'failed' })).toMatchObject({ outcome: 'Failed', tone: 'error', icon: 'error' })
    expect(runSummary({ ...base, status: 'cancelled' })).toMatchObject({ outcome: 'Cancelled', tone: 'warning', icon: 'debug-stop' })
    expect(runSummary({ ...base, status: 'timedOut' })).toMatchObject({ outcome: 'Timed out', tone: 'error', icon: 'watch' })
    // Results closed to free memory keep how the run ended; a run the backend lost says only that.
    expect(text(runSummary({ ...base, status: 'closed', closedFrom: 'completedWithErrors' }))).toBe('Completed with errors · 204 rows · 0.184 s · 22:44:51')
    const lost = { tone: 'error', icon: 'error', outcome: 'The SQL backend stopped while this query was running.', facts: [], sentence: 'The SQL backend stopped while this query was running.' }
    expect(runSummary({ ...base, status: 'lost' })).toEqual(lost)
    // A lost run, or one main failed without a summary, keeps saying so after Close Results, never "Completed".
    expect(runSummary({ ...base, status: 'closed', closedFrom: 'lost', completedAt: undefined })).toEqual(lost)
    expect(runSummary({ ...base, status: 'closed', closedFrom: 'failed', completedAt: undefined })).toMatchObject({ outcome: 'Failed', tone: 'error', icon: 'error', facts: ['204 rows', '0.184 s'] })
  })
  it('sum Messages up in the strip line, with a spoken name like the Messages tab\'s and the first error', () => {
    expect(messagesSummary([])).toEqual({ count: 0, errors: 0, text: '0 · no errors', label: 'Messages, 0 messages, no errors', readable: false })
    // Row counts alone are nothing to read; what the script printed and SQL Server's warnings are.
    expect(messagesSummary([info('(1 row affected)'), { text: 'printed', kind: 'print' }])).toEqual({ count: 2, errors: 0, text: '2 · no errors', label: 'Messages, 2 messages, no errors', readable: true })
    expect(messagesSummary([info('(1 row affected)')]).readable).toBe(false)
    expect(messagesSummary([{ text: 'Warning: Null value is eliminated by an aggregate or other SET operation.', kind: 'server' }]).readable).toBe(true)
    // The first error's message without SSMS's "Msg …" line; one Varia wrote (lost, cancelled) whole.
    expect(messagesSummary([info('a'), { text: 'Msg 8134, Level 16, State 1, Line 3\nDivide by zero error encountered.', kind: 'error' }, { text: 'Msg 2', kind: 'error' }]))
      .toMatchObject({ text: '3 · 2 errors', label: 'Messages, 3 messages, 2 errors', firstError: 'Divide by zero error encountered.', readable: true })
    expect(messagesSummary([{ text: 'The query was cancelled.', kind: 'error' }])).toMatchObject({ text: '1 · 1 error', label: 'Messages, 1 message, 1 error', firstError: 'The query was cancelled.' })
  })
})
