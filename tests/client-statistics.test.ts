import { describe, expect, it, vi } from 'vitest'
import type { QueryResult } from '../src/shared/contracts'
import { clientStatisticsSchema, providerMetricDefinitions } from '../src/shared/client-statistics'
import { localExportBytes } from '../src/shared/results/local-table'
import { validateRequest } from '../src/main/validation'
import { ClientStatisticsService, metricAverage, statisticsPeers, statisticsTable } from '../src/renderer/src/statistics/ClientStatisticsService'

const summary = (bytes: number, status: QueryResult['status'] = 'completed') => ({ status, clientStatistics: { counters: { BytesSent: bytes }, collectionElapsedMs: bytes } }) as QueryResult
describe('client statistics history', () => {
  it('bounds independent samples per query and compares only successful runs with the same context', () => {
    const service = new ClientStatisticsService()
    for (let i = 1; i <= 15; i++) {
      service.begin('a', String(i), 'connection', 'master', false)
      service.finish('a', String(i), summary(i, i === 14 ? 'cancelled' : 'completed'))
    }
    service.begin('b', 'other', 'other connection', 'master', false)
    service.finish('b', 'other', summary(1000))
    const runs = service.getSnapshot().a, selected = runs.at(-1)!, peers = statisticsPeers(runs, selected)
    expect(runs.map(run => run.sequence)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    expect(peers).toHaveLength(9)
    expect(metricAverage(peers, sample => sample.counters.BytesSent)).toBeCloseTo(91 / 9)
    expect(metricAverage(peers, sample => sample.counters.BytesReceived)).toBeUndefined()
    expect(service.getSnapshot().b).toHaveLength(1)
  })
  it('uses a new comparison context after a session ends or connection, database or actual-plan mode changes', () => {
    const service = new ClientStatisticsService()
    const run = (id: string, connection = 'c', database = 'master', plan = false) => {
      service.begin('a', id, connection, database, plan); service.finish('a', id, summary(1))
    }
    run('first'); run('same'); service.sessionEnded('a'); run('new session'); run('db', 'c', 'tempdb'); run('server', 'd', 'tempdb'); run('plan', 'd', 'tempdb', true)
    expect(service.getSnapshot().a.map(run => run.scope)).toEqual([1, 1, 2, 3, 4, 5])
    const runs = service.getSnapshot().a
    expect(statisticsPeers(runs, runs.at(-1)!)).toHaveLength(1)
  })
  it('keeps failures and backend loss visible without treating them as successful samples', () => {
    const service = new ClientStatisticsService()
    for (const status of ['failed', 'timedOut', 'cancelled', 'completedWithErrors'] as const) {
      service.begin('a', status, 'c', 'master', false); service.finish('a', status, summary(10, status))
    }
    service.begin('a', 'lost', 'c', 'master', false); service.finish('a', 'lost')
    const runs = service.getSnapshot().a
    expect(runs.at(-1)).toMatchObject({ status: 'unavailable', sample: { counters: {}, unavailable: expect.any(String) } })
    expect(statisticsPeers(runs, runs.at(-1)!)).toEqual([])
  })
  it('reset and tab disposal cannot resurrect an in-flight sample or contaminate a later run', () => {
    const service = new ClientStatisticsService()
    service.begin('a', 'old', 'c', 'master', false); service.reset('a')
    service.begin('a', 'new', 'c', 'master', false); service.finish('a', 'old', summary(100)); service.finish('a', 'new', summary(1))
    expect(service.getSnapshot().a).toHaveLength(1)
    expect(service.getSnapshot().a[0]).toMatchObject({ sequence: 1, sample: { counters: { BytesSent: 1 } } })
    service.reset('a'); expect(service.getSnapshot()).toEqual({})
    service.finish('a', 'new', summary(100)); expect(service.getSnapshot()).toEqual({})
  })
  it('averages only available values and keeps a measured zero', () => {
    const service = new ClientStatisticsService()
    service.begin('a', '0', 'c', 'master', false); service.finish('a', '0', summary(0))
    service.begin('a', '1', 'c', 'master', false); service.finish('a', '1', { status: 'completed', clientStatistics: { counters: {} } } as QueryResult)
    expect(metricAverage(service.getSnapshot().a, sample => sample.counters.BytesSent)).toBe(0)
  })
})

describe('statistics wire boundaries', () => {
  it('accepts partial counter sets and refuses unknown, unsafe, negative and nonnumeric metrics', () => {
    expect(clientStatisticsSchema.parse({ counters: { BytesSent: 0 } })).toEqual({ counters: { BytesSent: 0 } })
    for (const counters of [{ Unknown: 1 }, { BytesSent: -1 }, { BytesSent: Number.MAX_SAFE_INTEGER + 1 }, { BytesSent: '1' }])
      expect(clientStatisticsSchema.safeParse({ counters }).success).toBe(false)
  })
  it('keeps old execute callers valid and validates the optional flag', () => {
    const args = { connectionId: crypto.randomUUID(), sessionId: crypto.randomUUID(), queryId: crypto.randomUUID(), database: 'master', sql: 'SELECT 1', maxRows: 0, timeoutSeconds: 0 }
    expect(validateRequest('query.execute', args)).not.toHaveProperty('includeClientStatistics')
    expect(validateRequest('query.execute', { ...args, includeClientStatistics: true })).toMatchObject({ includeClientStatistics: true })
    expect(() => validateRequest('query.execute', { ...args, includeClientStatistics: 'true' })).toThrow()
  })
})
describe('client statistics report', () => {
  it('saves its figures as text, never as numbers read from a locale\'s grouping', async () => {
    const service = new ClientStatisticsService()
    for (const [id, bytes] of [['1', 1000], ['2', 1500]] as const) { service.begin('a', id, 'connection', 'master', false); service.finish('a', id, summary(bytes)) }
    const runs = service.getSnapshot().a
    // German groups thousands with a dot: 1.500, which a number column would write to JSON as 1.5.
    const toLocale = Number.prototype.toLocaleString
    const spy = vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (this: number, _locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) { return toLocale.call(this, 'de-DE', options) })
    let table
    try { table = statisticsTable(runs, runs[1]) } finally { spy.mockRestore() }
    expect(table.rows[0].slice(1, 3)).toEqual(['1.500', '1.000'])
    const saved = await localExportBytes(table, { format: 'json', headers: true, nullText: 'NULL' })
    const rows = JSON.parse(new TextDecoder().decode(saved.data).replace(/^﻿/, '')) as Record<string, unknown>[]
    expect(rows[0]).toMatchObject({ Measurement: 'Bytes sent', 'Run 2': '1.500', 'Previous (run 1)': '1.000', Change: '+500', 'Average (2 runs)': '1.250' })
    for (const row of rows) for (const value of Object.values(row)) expect(typeof value).toBe('string')
  })
  it('builds the grid\'s ordered report: the selected run, the previous in its context, the change and the mean', () => {
    const service = new ClientStatisticsService()
    for (const [id, bytes] of [['1', 1000], ['2', 1500]] as const) { service.begin('a', id, 'connection', 'master', false); service.finish('a', id, summary(bytes)) }
    const runs = service.getSnapshot().a, table = statisticsTable(runs, runs[1])
    expect(table.columns.map(column => column.name)).toEqual(['Measurement', 'Run 2', 'Previous (run 1)', 'Change', 'Average (2 runs)', 'Definition'])
    // The provider's order, then the backend's wall time: a report, which the grid shows unsorted.
    expect(table.rows.map(row => row[0])).toEqual([...providerMetricDefinitions.map(([, label]) => label), 'Collection wall time (ms)'])
    const bytes = table.rows[0]
    expect(bytes.slice(1, 5)).toEqual([(1500).toLocaleString(), (1000).toLocaleString(), `+${(500).toLocaleString()}`, (1250).toLocaleString()])
    expect(bytes[5]).toBe(providerMetricDefinitions[0][2])
    // A counter neither run reported is Unavailable throughout, never zero.
    expect(table.rows[1].slice(1, 5)).toEqual(['Unavailable', 'Unavailable', 'Unavailable', 'Unavailable'])
    // The first run has no previous run in its context.
    const first = statisticsTable(runs, runs[0])
    expect(first.columns[2].name).toBe('Previous')
    expect(first.rows[0].slice(2, 4)).toEqual(['Unavailable', 'Unavailable'])
    // A previous run that did not complete says so in the column's name, which Copy with Headers keeps.
    service.begin('a', '3', 'connection', 'master', false); service.finish('a', '3', summary(10, 'cancelled'))
    service.begin('a', '4', 'connection', 'master', false); service.finish('a', '4', summary(20))
    const later = service.getSnapshot().a
    expect(statisticsTable(later, later[3]).columns[2].name).toBe('Previous (run 3, cancelled)')
  })
})
