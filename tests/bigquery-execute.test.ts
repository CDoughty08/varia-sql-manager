import { describe, expect, it } from 'vitest'
import { validateRequest } from '../src/main/validation'
import { queryResultSchema } from '../src/shared/ipc/port-messages'
import { methodAllows, optionsAllow } from '../src/shared/ipc/methods'

// query.execute for BigQuery handles (docs/bigquery.md, Execution): the request's dataset, the options main refuses, and
// the summary's job.
describe('BigQuery query.execute', () => {
  const base = { connectionId: crypto.randomUUID(), sessionId: crypto.randomUUID(), queryId: crypto.randomUUID(), sql: 'SELECT 1', maxRows: 1000, timeoutSeconds: 30 }

  it('takes a dataset, and no database, for a BigQuery query', () => {
    expect(validateRequest('query.execute', { ...base, dataset: 'sales_2026' })).toEqual({ ...base, dataset: 'sales_2026' })
    expect(validateRequest('query.execute', base)).toEqual(base)
    expect(validateRequest('query.execute', { ...base, dataset: 'd'.repeat(1024) })).toMatchObject({ dataset: 'd'.repeat(1024) })
    for (const dataset of ['', 'd'.repeat(1025), 'sales-2026', 'a.b', 7]) expect(() => validateRequest('query.execute', { ...base, dataset }), String(dataset)).toThrow('Invalid request')
  })

  it('serves both engines and refuses each engine the options of the other in main', () => {
    expect(methodAllows('query.execute', 'bigquery')).toBe(true)
    expect(optionsAllow('query.execute', 'bigquery', { ...base, dataset: 'd' })).toBe(true)
    expect(optionsAllow('query.execute', 'bigquery', { ...base, discardResults: true, stopOnError: false })).toBe(true)
    for (const option of ['stopOnError', 'includeActualPlan', 'includeLivePlan', 'includeClientStatistics'])
      expect(optionsAllow('query.execute', 'bigquery', { ...base, [option]: true }), option).toBe(false)
    expect(optionsAllow('query.execute', 'sqlserver', { ...base, database: 'master', includeActualPlan: true })).toBe(true)
    expect(optionsAllow('query.execute', 'sqlserver', { ...base, database: 'master', dataset: 'd' })).toBe(false)
    // An unknown handle is the backend's to answer; other methods are not checked.
    expect(optionsAllow('query.execute', undefined, { ...base, dataset: 'd', stopOnError: true })).toBe(true)
    expect(optionsAllow('results.read', 'bigquery', { stopOnError: true })).toBe(true)
  })

  it("accepts a summary's job, strictly", () => {
    const summary = {
      resultSets: [], discardedResultSets: 0, messages: [], recordsAffected: -1, elapsedMs: 5, status: 'completed', completedBatches: 1, totalBatches: 1,
      database: 'd'.repeat(1024), messagesTruncated: false, budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1, seq: 1 }, completedAt: '2026-11-18T09:30:00.0000000+00:00'
    }
    const job = { project: 'example-project', jobId: 'varia_0123', location: 'US', statementType: 'SELECT', bytesProcessed: 1024, bytesBilled: 10485760, cacheHit: false, slotMs: 250 }
    expect(queryResultSchema.safeParse({ ...summary, job }).success).toBe(true)
    expect(queryResultSchema.safeParse({ ...summary, job: { project: 'p', jobId: 'j' } }).success).toBe(true)
    expect(queryResultSchema.safeParse({ ...summary, job: { ...job, extra: 1 } }).success).toBe(false)
    expect(queryResultSchema.safeParse({ ...summary, job: { ...job, bytesProcessed: -1 } }).success).toBe(false)
  })
})
