import { describe, expect, it } from 'vitest'
import type { QueryResult } from '../src/shared/contracts'
import { clientStatisticsSchema } from '../src/shared/client-statistics'
import { validateRequest } from '../src/main/validation'
import { ClientStatisticsService, metricAverage, statisticsPeers } from '../src/renderer/src/statistics/ClientStatisticsService'

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
