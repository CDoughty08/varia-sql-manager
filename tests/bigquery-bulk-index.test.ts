import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import type { BigQueryDryRunResult } from '../src/shared/bigquery/dry-run'
import { methodPolicies } from '../src/shared/ipc/methods'
import { requestSchemas, resultSchemas } from '../src/main/validation'
import { defaultSettings } from '../src/shared/settings/catalog'
import { bigQueryBulkLocations, objectIndexParamsSchema, type BigQueryIndexEstimateResult, type ObjectIndexResult, type ObjectIndexStatus } from '../src/shared/explorer/search'
import { SnapshotStore } from '../src/renderer/src/core/store'
import type { LiveConnection } from '../src/renderer/src/services/connections'
import { ObjectSearchService, type ObjectSearchOptions } from '../src/renderer/src/search/ObjectSearchService'
import { bigQueryIndexSummary } from '../src/renderer/src/search/SearchPanel'

class Connections extends SnapshotStore<readonly LiveConnection[]> {
  set(list: readonly LiveConnection[]) { this.publish(list) }
  get = (id: string) => this.getSnapshot().find(connection => connection.id === id)
}
const bigQuery = (id: string) => ({ id, server: 'bigquery', database: 'sales', serverVersion: '', providerId: 'bigquery', options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } }) as unknown as LiveConnection
const sqlServer = (id: string) => ({ id, server: 'srv', database: 'master', serverVersion: '16.0', options: {} }) as unknown as LiveConnection
const status = (overrides: Partial<ObjectIndexStatus> = {}): ObjectIndexStatus => ({ state: 'ready', databases: 2, indexed: 2, objects: 40, modules: 5, cut: 0, skipped: [], definitions: true, provider: 'bigquery', ...overrides })
const estimate: BigQueryIndexEstimateResult = { locations: [{ project: 'varia-alpha', location: 'US' }], estimate: { bytesProcessed: 50 * 2 ** 20, statementType: 'SELECT' }, cut: false, elapsedMs: 3 }
const settle = () => new Promise(resolve => setImmediate(resolve))

function harness(options: { bulk?: boolean; extraProjects?: boolean; estimate?: ApiResult<BigQueryIndexEstimateResult> | 'throw'; gate?: false } = {}) {
  const index: Parameters<VariaApi['explorerIndex']>[0][] = []
  const pending: ((result: ApiResult<ObjectIndexResult>) => void)[] = []
  const estimates: Parameters<VariaApi['bigQueryIndexEstimate']>[0][] = []
  const gates: { connectionId: string; estimate: BigQueryDryRunResult; signal: AbortSignal; answer: (value: { run: boolean; maximumBytesBilled?: number }) => void; fail: (error: Error) => void }[] = []
  const api: ObjectSearchOptions['api'] = {
    explorerIndex: vi.fn(params => { index.push(params); return new Promise<ApiResult<ObjectIndexResult>>(resolve => pending.push(resolve)) }),
    explorerSearch: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
    explorerCancel: vi.fn(async ids => ({ ok: true as const, value: { cancelled: ids.length } })),
    onExplorerIndexProgress: vi.fn(() => () => {}),
    bigQueryIndexEstimate: vi.fn(async params => {
      estimates.push(params)
      if (options.estimate === 'throw') throw new Error('IPC lost')
      return options.estimate ?? { ok: true as const, value: estimate }
    })
  }
  const documents = { openCustom: vi.fn(), registerProvider: vi.fn(() => ({ dispose: () => {} })), get: vi.fn(), activate: vi.fn(), getSnapshot: vi.fn() } as unknown as ObjectSearchOptions['documents']
  const connections = new Connections([])
  const values: Record<string, unknown> = {
    'objectExplorer.search.indexOnConnect': true, 'objectExplorer.search.definitions': true, 'objectExplorer.search.bigQueryExtraProjects': options.extraProjects ?? false,
    'textEditor.googleSql.bulkIndex': options.bulk ?? defaultSettings['textEditor.googleSql.bulkIndex']
  }
  let ids = 0
  const service = new ObjectSearchService({
    api, documents, connections, settings: { get: (key => values[key]) as ObjectSearchOptions['settings']['get'] }, newId: () => 'req' + ++ids,
    ...options.gate === false ? {} : { billedGate: (connectionId, value, signal) => new Promise((answer, fail) => { gates.push({ connectionId, estimate: value, signal, answer, fail }) }) }
  })
  return { service, api, index, pending, estimates, gates, connections }
}

describe('BigQuery bulk index path (renderer)', () => {
  it('is off by default: a BigQuery build sends no estimate and no bulk locations', async () => {
    expect(defaultSettings['textEditor.googleSql.bulkIndex']).toBe(false)
    const { index, estimates, gates, connections } = harness()
    connections.set([bigQuery('bq')])
    await settle()
    expect(estimates).toEqual([])
    expect(gates).toEqual([])
    expect(index).toEqual([{ connectionId: 'bq', requestId: 'req1', definitions: true, extraDetails: false }])
  })

  it('estimates first, asks through the cost prompts, and only then builds with the estimated locations and the cap', async () => {
    const { service, index, estimates, gates, connections, pending } = harness({ bulk: true, extraProjects: true })
    connections.set([bigQuery('bq')])
    expect(service.getSnapshot().indexes.bq).toMatchObject({ requestId: 'req1', phase: 'estimate' })
    expect(bigQueryIndexSummary(service.getSnapshot().indexes.bq, undefined)).toMatch(/^Estimating the billed INFORMATION_SCHEMA read/)
    await settle()
    expect(estimates).toEqual([{ connectionId: 'bq', definitions: true, extraDetails: true }])
    // Nothing is sent before the prompt's answer.
    expect(index).toEqual([])
    expect(gates).toHaveLength(1)
    expect(gates[0]).toMatchObject({ connectionId: 'bq', estimate: estimate.estimate })
    gates[0].answer({ run: true, maximumBytesBilled: 2 ** 30 })
    await settle()
    expect(index).toEqual([{ connectionId: 'bq', requestId: 'req1', definitions: true, extraDetails: true, bulk: { locations: estimate.locations, budgetBytes: estimate.estimate.bytesProcessed, maximumBytesBilled: 2 ** 30 } }])
    expect(service.getSnapshot().indexes.bq.phase).toBeUndefined()
    pending[0]({ ok: true, value: { status: status({ bulk: { locations: 1, failed: 0 } }), elapsedMs: 9 } })
    await settle()
    expect(bigQueryIndexSummary(service.getSnapshot().indexes.bq, service.getSnapshot().indexes.bq.status)).toContain('details read with INFORMATION_SCHEMA in 1 location')
  })

  it('builds with the free calls only when the prompt is declined, the estimate fails or finds nothing to read', async () => {
    const declined = harness({ bulk: true })
    declined.connections.set([bigQuery('bq')])
    await settle()
    declined.gates[0].answer({ run: false })
    await settle()
    expect(declined.index).toEqual([{ connectionId: 'bq', requestId: 'req1', definitions: true, extraDetails: false }])
    for (const failure of [{ ok: false as const, error: 'Timed out.', code: 'TIMEOUT' as const }, { ok: true as const, value: { ...estimate, locations: [] } }, { ok: true as const, value: { ...estimate, estimate: { ...estimate.estimate, bytesProcessed: 0 } } }, 'throw' as const]) {
      const failed = harness({ bulk: true, estimate: failure })
      failed.connections.set([bigQuery('bq')])
      await settle()
      expect(failed.gates).toEqual([])
      expect(failed.index).toEqual([{ connectionId: 'bq', requestId: 'req1', definitions: true, extraDetails: false }])
    }
    // A prompt that fails (its service gone, an IPC failure) is no consent, and the index does not stay at Estimating.
    const broken = harness({ bulk: true })
    broken.connections.set([bigQuery('bq')])
    await settle()
    broken.gates[0].fail(new Error('prompt lost'))
    await settle()
    expect(broken.index).toEqual([{ connectionId: 'bq', requestId: 'req1', definitions: true, extraDetails: false }])
    expect(broken.service.getSnapshot().indexes.bq.phase).toBeUndefined()
  })

  it('Stop at the prompt closes it and sends nothing; a newer build closes the older one\'s prompt', async () => {
    const { service, index, gates, connections } = harness({ bulk: true })
    connections.set([bigQuery('bq')])
    await settle()
    service.stopBuild('bq')
    expect(gates[0].signal.aborted).toBe(true)
    gates[0].answer({ run: false })
    await settle()
    expect(index).toEqual([])
    expect(service.getSnapshot().indexes.bq.requestId).toBeUndefined()
    service.build('bq')
    await settle()
    service.build('bq')
    await settle()
    expect(gates[1].signal.aborted).toBe(true)
    gates[1].answer({ run: true })
    gates[2].answer({ run: true })
    await settle()
    expect(index.map(call => call.requestId)).toEqual(['req3'])
  })

  it('sends the estimate as the build budget and no cap of its own without one, stops an older running build, and closes the prompt on a disconnect', async () => {
    const { service, api, index, gates, connections, pending } = harness({ bulk: true })
    connections.set([bigQuery('bq')])
    await settle()
    gates[0].answer({ run: true })
    await settle()
    expect(index[0]?.bulk).toEqual({ locations: estimate.locations, budgetBytes: estimate.estimate.bytesProcessed })
    // Rebuild while a build runs: the running one is stopped at once, since the new one is sent only after its prompt.
    service.build('bq')
    await settle()
    expect(api.explorerCancel).toHaveBeenCalledWith(['req1'])
    expect(gates).toHaveLength(2)
    pending[0]({ ok: false, error: 'The object index build was stopped.', code: 'CANCELLED' })
    await settle()
    connections.set([])
    await settle()
    expect(gates[1].signal.aborted).toBe(true)
    gates[1].answer({ run: true })
    await settle()
    expect(index).toHaveLength(1)
    // Refresh on the connection's node is a rebuild, so it takes the bulk path too.
    connections.set([bigQuery('bq')])
    await settle()
    gates[2].answer({ run: false })
    await settle()
    pending[1]({ ok: true, value: { status: status(), elapsedMs: 1 } })
    await settle()
    service.refreshNode('bq', { type: 'object', object: { kind: 'server' } } as never)
    await settle()
    expect(gates).toHaveLength(4)
  })

  it('never estimates for a refresh, a SQL Server connection or without the cost prompts', async () => {
    const { service, estimates, index, connections, gates, pending } = harness({ bulk: true })
    connections.set([sqlServer('a')])
    await settle()
    expect(estimates).toEqual([])
    expect(index).toEqual([{ connectionId: 'a', requestId: 'req1', definitions: true }])
    connections.set([sqlServer('a'), bigQuery('bq')])
    await settle()
    gates[0].answer({ run: false })
    await settle()
    pending[1]({ ok: true, value: { status: status(), elapsedMs: 1 } })
    await settle()
    service.refreshBigQuery('bq', { scope: { project: 'varia-alpha', dataset: 'sales' } })
    service.refreshNode('bq', { type: 'object', object: { kind: 'bqProject', name: 'varia-alpha' } } as never)
    await settle()
    expect(estimates).toHaveLength(1)
    expect(index.slice(2).every(call => call.bulk === undefined)).toBe(true)
    const ungated = harness({ bulk: true, gate: false })
    ungated.connections.set([bigQuery('bq')])
    await settle()
    expect(ungated.estimates).toEqual([])
    expect(ungated.index).toHaveLength(1)
  })

  it('says when a location\'s billed read failed and its datasets were read with free calls', () => {
    const text = bigQueryIndexSummary({ connectionId: 'bq', done: 2, total: 2, objects: 40 }, status({ bulk: { locations: 1, failed: 1, code: 'COST_CAP', message: 'The cap was reached.' } }))
    expect(text).toContain('details read with INFORMATION_SCHEMA in 1 location')
    expect(text).toContain('the billed read failed in 1 location (COST_CAP), read with free calls instead')
  })
})

describe('BigQuery bulk index contracts', () => {
  it('declares bigquery.indexEstimate in every place a backend method lives', () => {
    expect(methodPolicies['bigquery.indexEstimate']).toMatchObject({ kind: 'unary', lane: 'metadata', providers: ['bigquery'] })
    expect(requestSchemas['bigquery.indexEstimate']).toBeDefined()
    expect(resultSchemas['bigquery.indexEstimate']).toBeDefined()
    expect(readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')).toContain("bigQueryIndexEstimate: params => request('bigquery.indexEstimate', params)")
    const backend = (file: string) => readFileSync(new URL('../backend/Varia.Backend/' + file, import.meta.url), 'utf8')
    expect(backend('SqlService.cs')).toContain('"bigquery.indexEstimate" => await bigQuery.IndexEstimateAsync(')
    expect(backend('Providers.cs')).toContain('"bigquery.indexEstimate"')
    expect(backend('Search/BigQueryBulk.cs')).toContain(`public const int MaxLocations = ${bigQueryBulkLocations};`)
  })

  it('accepts bulk only on a full build, with valid locations and at most 64 of them', () => {
    const base = { connectionId: crypto.randomUUID(), requestId: crypto.randomUUID() }
    const locations = [{ project: 'varia-alpha', location: 'us-east1' }]
    expect(objectIndexParamsSchema.safeParse({ ...base, bulk: { locations, budgetBytes: 1, maximumBytesBilled: 2 ** 30 } }).success).toBe(true)
    // The budget is required: the backend never runs bulk jobs without the estimate the prompts showed.
    expect(objectIndexParamsSchema.safeParse({ ...base, bulk: { locations } }).success).toBe(false)
    expect(objectIndexParamsSchema.safeParse({ ...base, bulk: { locations, budgetBytes: 0 } }).success).toBe(false)
    expect(objectIndexParamsSchema.safeParse({ ...base, bulk: { locations, budgetBytes: 1 }, scope: { project: 'varia-alpha' } }).success).toBe(false)
    expect(objectIndexParamsSchema.safeParse({ ...base, bulk: { locations, budgetBytes: 1 }, stale: true }).success).toBe(false)
    expect(objectIndexParamsSchema.safeParse({ ...base, bulk: { locations: [], budgetBytes: 1 } }).success).toBe(false)
    expect(objectIndexParamsSchema.safeParse({ ...base, bulk: { locations: [{ project: 'varia-alpha', location: 'us`; --' }], budgetBytes: 1 } }).success).toBe(false)
    expect(objectIndexParamsSchema.safeParse({ ...base, bulk: { locations: Array.from({ length: bigQueryBulkLocations + 1 }, () => locations[0]), budgetBytes: 1 } }).success).toBe(false)
    const result = resultSchemas['bigquery.indexEstimate']!
    expect(result.safeParse(estimate).success).toBe(true)
    expect(result.safeParse({ ...estimate, locations: [{ project: 'varia-alpha', location: 'US', extra: 1 }] }).success).toBe(false)
  })
})
