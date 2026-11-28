// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MessageEntry } from '../src/shared/contracts'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import MessagesView, { jobLinkConnection, messageTail } from '../src/renderer/src/results/MessagesView'
import { completionSentence, formatCount, formatDuration, formatElapsed, messagesSummary, runSummary, statusSentence, timeOfDay } from '../src/renderer/src/results/status'
import { summaryOf } from './fixtures/results'
import { workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cleanups = new Set<() => void>()
afterEach(() => {
  for (const cleanup of [...cleanups].reverse()) cleanup()
  cleanups.clear()
  document.body.replaceChildren()
})

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

describe('the Messages job line', () => {
  it('links to Job History only while the tab is still on the project of the job', () => {
    const connection = (id: string, project: string) => ({ id, options: { provider: 'bigquery' as const, project } }) as unknown as Parameters<typeof jobLinkConnection>[2][number]
    const connections = [connection('bq-a', 'alpha'), connection('bq-b', 'beta')]
    expect(jobLinkConnection('alpha', 'bq-a', connections)).toBe('bq-a')
    expect(jobLinkConnection('alpha', 'bq-b', connections)).toBeUndefined()
    expect(jobLinkConnection('alpha', undefined, connections)).toBeUndefined()
    expect(jobLinkConnection('alpha', 'gone', connections)).toBeUndefined()
  })
})

describe('multi-server Messages filter pill accessibility (R5-D4-6)', () => {
  it('places the error count in the filter button aria-label and hides the decorative ! badge from screen readers', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('multi.sql', 'SELECT 1', 'master')
    const targets = [
      { targetKey: 'east', connectionId: 'c1', provider: 'sqlserver' as const, label: 'prod-east' },
      { targetKey: 'west', connectionId: 'c2', provider: 'sqlserver' as const, label: 'prod-west' },
      { targetKey: 'dev', connectionId: 'c3', provider: 'sqlserver' as const, label: 'dev-01' }
    ]
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets } })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: {
        status: 'completedWithErrors',
        mode: 'fireAndForget',
        targets: targets.map(target => ({
          targetKey: target.targetKey,
          provider: target.provider,
          label: target.label,
          status: target.targetKey === 'dev' ? 'succeeded' : 'failed',
          batchesCompleted: 1,
          batchesTotal: 1,
          rowsAffected: 0,
          elapsedMs: 12,
          resultSetIds: []
        })),
        resultSets: [],
        discardedResultSets: 0,
        messages: [
          { text: 'Divide by zero', kind: 'error', targetKey: 'east' },
          { text: 'Timeout expired', kind: 'error', targetKey: 'west' },
          { text: 'Deadlock victim', kind: 'error', targetKey: 'west' },
          { text: '(1 row affected)', kind: 'info', targetKey: 'dev' }
        ],
        messagesTruncated: false,
        elapsedMs: 12,
        budget: { usedBytes: 0, globalBytes: 1024, queryBytes: 1024, generation: 1, seq: 1 },
        completedAt: '2026-11-26T18:30:00.0000000+00:00'
      }
    })

    const host = document.body.appendChild(document.createElement('div'))
    const root: Root = createRoot(host)
    cleanups.add(() => { act(() => root.unmount()); host.remove() })
    act(() => {
      root.render(createElement(WorkbenchProvider, {
        workbench: f as unknown as Workbench,
        children: createElement(MessagesView, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
      }))
    })

    const pills = [...host.querySelectorAll<HTMLButtonElement>('.messages-filter-pill')]
    // [All, prod-east, prod-west, dev-01]
    expect(pills.map(pill => pill.getAttribute('aria-label'))).toEqual([
      null,
      'prod-east, 1 error',
      'prod-west, 2 errors',
      null
    ])
    const badges = [...host.querySelectorAll<HTMLElement>('.messages-filter-err')]
    expect(badges).toHaveLength(2)
    for (const badge of badges) {
      expect(badge.textContent).toBe('!')
      expect(badge.getAttribute('aria-hidden')).toBe('true')
      expect(badge.hasAttribute('aria-label')).toBe(false)
    }
  })

  it('R9 D4 #5: announces Coordinator error counts on both the pill and compact select option', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('coord-errors.sql', 'SELECT 1', 'SalesDB')
    const targets = [
      { targetKey: 'east', connectionId: 'c-east', provider: 'sqlserver' as const, label: 'prod-east' },
      { targetKey: 'west', connectionId: 'c-west', provider: 'sqlserver' as const, label: 'prod-west' }
    ]
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'transaction', targets } })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: {
        mode: 'transaction',
        status: 'rolledBack',
        targets: targets.map(target => ({
          targetKey: target.targetKey,
          provider: target.provider,
          label: target.label,
          status: 'rolledBack',
          batchesCompleted: 0,
          batchesTotal: 1,
          rowsAffected: 0,
          resultSetIds: [],
          elapsedMs: 10
        })),
        resultSets: [],
        discardedResultSets: 0,
        messages: [
          { text: 'Coordinator aborted run due to timeout.', kind: 'error' },
          { text: 'Second coordinator failure.', kind: 'error' },
          { text: 'Rolled back.', kind: 'info', targetKey: 'east' }
        ],
        messagesTruncated: false,
        elapsedMs: 12,
        budget: { usedBytes: 0, globalBytes: 1024, queryBytes: 1024, generation: 1, seq: 1 },
        completedAt: '2026-11-26T18:30:00.0000000+00:00'
      }
    })

    const host = document.body.appendChild(document.createElement('div'))
    const root: Root = createRoot(host)
    cleanups.add(() => { act(() => root.unmount()); host.remove() })

    // Pill bar mode (<= 6 targets, !firstError)
    act(() => {
      root.render(createElement(WorkbenchProvider, {
        workbench: f as unknown as Workbench,
        children: createElement(MessagesView, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
      }))
    })
    const coordPill = [...host.querySelectorAll<HTMLButtonElement>('.messages-filter-pill')].find(btn => btn.textContent?.includes('Coordinator'))!
    expect(coordPill.getAttribute('data-has-error')).toBe('true')
    expect(coordPill.getAttribute('aria-label')).toBe('Coordinator, 2 errors')
    expect(coordPill.querySelector('.messages-filter-err')?.textContent).toBe('!')

    // Compact select mode (`firstError: true`)
    act(() => {
      root.render(createElement(WorkbenchProvider, {
        workbench: f as unknown as Workbench,
        children: createElement(MessagesView, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id], firstError: true })
      }))
    })
    const coordOption = host.querySelector<HTMLOptionElement>('.messages-filter-select option[value="__coordinator__"]')!
    expect(coordOption.textContent).toBe('Coordinator (2 errors)')
  })
})
