import { describe, expect, it } from 'vitest'
import type { MessageEntry } from '../src/shared/contracts'
import { messageTail } from '../src/renderer/src/results/MessagesView'
import { completionSentence, formatCount, formatElapsed, statusSentence } from '../src/renderer/src/results/status'
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
    // Batches that raised errors did not complete successfully, even when every batch ran.
    expect(messageTail({ status: 'completedWithErrors', messages: [{ text: 'Msg 8134, Level 16, State 1, Line 1\nDivide by zero error encountered.', kind: 'error' }], notices: 0, summary }))
      .toEqual(['', 'Completion time: 2026-10-08T21:48:01.1234567+00:00'])
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
})
