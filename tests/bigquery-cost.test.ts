import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type * as Monaco from 'monaco-editor'
import type { BigQueryDryRunResult } from '../src/shared/bigquery/dry-run'
import { serializeCrossEngineSql } from '../src/shared/multi-query'
import { defaultSettings } from '../src/shared/settings/catalog'
import { formatBytes, formatDollars, processedFact } from '../src/shared/bigquery/cost'
import { runSummary } from '../src/renderer/src/results/status'
import { BigQueryCostService, costOptOut, dryRunMarkerOwner } from '../src/renderer/src/services/bigquery-cost'
import { CostPromptService } from '../src/renderer/src/services/bigquery-cost-prompt'
import type { LiveConnection } from '../src/renderer/src/services/connections'
import { executeMultiTab, MultiExecutePromptService } from '../src/renderer/src/services/multi-execute'
import { documentFixture, TestModel } from './fixtures/documents'

// The backend's BigQueryCost reads the same file (BigQueryExecutionChecks), so both write the same text.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/bigquery/cost.json', import.meta.url), 'utf8')) as { cases: { bytes: number; text: string; dollars: string }[] }

describe('BigQuery cost text', () => {
  it('writes bytes in binary units and on-demand dollars as the backend does', () => {
    expect(fixture.cases.length).toBeGreaterThan(10)
    for (const { bytes, text, dollars } of fixture.cases) {
      expect(formatBytes(bytes), String(bytes)).toBe(text)
      expect(formatDollars(bytes), String(bytes)).toBe(dollars)
    }
  })

  it('shows the bytes processed beside the row count in the Results status', () => {
    const base = { status: 'completed' as const, elapsedMs: 1200, rows: 3, completedBatches: 1, totalBatches: 1 }
    expect(runSummary(base).facts.some(fact => fact.includes('processed'))).toBe(false)
    const facts = runSummary({ ...base, bytesProcessed: 1331439862 }).facts
    expect(facts[1]).toBe(processedFact(1331439862))
    expect(facts[1]).toBe('1.24 GiB processed · < $0.01')
    expect(runSummary({ ...base, bytesProcessed: 0 }).facts[1]).toBe('0 B processed · $0.00')
  })
})

describe('BigQueryCostService: multi-server and Cross-Engine live diagnostics (Finding 1)', () => {
  const bqUuid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`
  const sqlUuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  function createCostHarness(conns: readonly LiveConnection[], dryRunImpl: (req: Parameters<BigQueryCostService['deps']['api']['bigQueryDryRun']>[0]) => Promise<{ ok: true; value: BigQueryDryRunResult } | { ok: false; error: string; code?: string }>) {
    const f = documentFixture()
    const connMap = new Map(conns.map(c => [c.id, c]))
    const markers = new Map<unknown, Monaco.editor.IMarkerData[]>()
    const setModelMarkers = vi.fn((model: unknown, _owner: string, list: Monaco.editor.IMarkerData[]) => {
      markers.set(model, list)
    })
    const timers: (() => void)[] = []
    const dryRun = vi.fn(dryRunImpl)
    const settingValues = { ...defaultSettings, 'textEditor.googleSql.dryRunDiagnostics': true }
    const service = new BigQueryCostService({
      api: { bigQueryDryRun: dryRun as never },
      documents: f.documents,
      connections: {
        get: id => connMap.get(id),
        isLive: id => connMap.has(id),
        subscribe: () => () => {}
      },
      settings: {
        get: key => settingValues[key],
        subscribe: () => () => {},
        choose: async () => {}
      },
      events: { subscribe: () => ({ dispose() {} }) },
      monaco: { MarkerSeverity: { Error: 8 } as typeof Monaco.MarkerSeverity, editor: { setModelMarkers } },
      ask: vi.fn(async () => ({ run: true })),
      optOut: costOptOut({ loadConnectionLibrary: async () => ({ ok: false, error: 'none' }), setBigQueryCostPrompt: async () => ({ ok: true, value: true }) }),
      schedule: cb => { timers.push(cb); return timers.length as unknown as ReturnType<typeof setTimeout> }
    })
    const runTimers = async () => {
      for (const cb of timers.splice(0)) cb()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    }
    return { f, service, dryRun, markers, setModelMarkers, runTimers }
  }

  it('dry-runs multi-server BigQuery tabs using first enabled live target dataset and omitting sessionId', async () => {
    const bq1: LiveConnection = { id: bqUuid(1), server: 'proj-1', database: 'ds_one', serverVersion: '', generation: 1, providerId: 'bigquery', options: { provider: 'bigquery', project: 'proj-1', authentication: 'gcloud' } } as LiveConnection
    const bq2: LiveConnection = { id: bqUuid(2), server: 'proj-2', database: 'ds_two', serverVersion: '', generation: 1, providerId: 'bigquery', options: { provider: 'bigquery', project: 'proj-2', authentication: 'gcloud' } } as LiveConnection
    const h = createCostHarness([bq1, bq2], async () => ({ ok: true, value: { bytesProcessed: 4096 } }))

    const doc = h.f.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      sql: 'SELECT 1',
      targets: [
        { targetId: bqUuid(10), connectionId: bq1.id, database: 'ds_one', enabled: false, provider: 'bigquery' },
        { targetId: bqUuid(20), connectionId: bq2.id, database: 'ds_two', enabled: true, provider: 'bigquery' }
      ]
    })

    h.f.model(doc.id).edit('SELECT * FROM ds_two.orders')
    await h.runTimers()

    expect(h.dryRun).toHaveBeenCalledTimes(1)
    expect(h.dryRun).toHaveBeenCalledWith({ connectionId: bq2.id, sql: 'SELECT * FROM ds_two.orders', dataset: 'ds_two' })
    expect('sessionId' in h.dryRun.mock.calls[0]![0]).toBe(false)
    expect(h.service.getSnapshot().get(doc.id)).toEqual({ phase: 'estimate', bytes: 4096 })
    h.service.dispose()
  })

  it('dry-runs Cross-Engine Split secondary model and maps Cross-Engine File errors using bigQueryStartLine', async () => {
    const sql1: LiveConnection = { id: sqlUuid(1), server: 'sql-1', database: 'Sales', serverVersion: '16.0', generation: 1, providerId: 'sqlserver', options: { provider: 'sqlserver', server: 'sql-1', database: 'Sales', authentication: 'sql', trustServerCertificate: true } } as LiveConnection
    const bq1: LiveConnection = { id: bqUuid(1), server: 'proj-1', database: 'analytics', serverVersion: '', generation: 1, providerId: 'bigquery', options: { provider: 'bigquery', project: 'proj-1', authentication: 'gcloud' } } as LiveConnection
    const h = createCostHarness([sql1, bq1], async req => {
      if ('sql' in req && req.sql.includes('BAD_COL')) {
        return { ok: false, code: 'SQL_ERROR', error: 'Unrecognized name: BAD_COL at [2:8]' }
      }
      return { ok: true, value: { bytesProcessed: 2048 } }
    })

    const doc = h.f.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1\nFROM dbo.Sales',
      bigQuerySql: 'SELECT 2',
      targets: [
        { targetId: sqlUuid(10), connectionId: sql1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: bqUuid(10), connectionId: bq1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })

    // 1. Split mode observes the secondary GoogleSQL model.
    const secModel = h.f.documents.getSecondaryModel(doc.id) as unknown as TestModel
    secModel.edit('SELECT 20 FROM analytics.events')
    await h.runTimers()
    expect(h.dryRun).toHaveBeenCalledTimes(1)
    expect(h.dryRun).toHaveBeenCalledWith({ connectionId: bq1.id, sql: 'SELECT 20 FROM analytics.events', dataset: 'analytics' })
    expect(h.service.getSnapshot().get(doc.id)).toEqual({ phase: 'estimate', bytes: 2048 })

    // 2. Switch to File mode: extracts GoogleSQL block and offsets [2:8] by bigQueryStartLine!
    expect(h.f.documents.setCrossView(doc.id, 'file')).toEqual({ ok: true })
    expect(h.service.getSnapshot().get(doc.id)).toBeUndefined()
    // Line 1: -- #Dialect="sqlserver"
    // Line 2: SELECT 1
    // Line 3: FROM dbo.Sales
    // Line 4: -- #Dialect="bigquery"
    // Line 5: SELECT 1
    // Line 6: SELECT BAD_COL
    const fileText = serializeCrossEngineSql('SELECT 1\nFROM dbo.Sales', 'SELECT 1\nSELECT BAD_COL')
    h.f.model(doc.id).edit(fileText)
    await h.runTimers()

    expect(h.dryRun).toHaveBeenCalledTimes(2)
    expect(h.dryRun.mock.calls[1]![0]).toEqual({ connectionId: bq1.id, sql: 'SELECT 1\nSELECT BAD_COL', dataset: 'analytics' })
    expect(h.service.getSnapshot().get(doc.id)).toMatchObject({ phase: 'refused' })
    const primaryModel = h.f.documents.getModel(doc.id)!
    const placed = h.markers.get(primaryModel) ?? []
    expect(placed).toHaveLength(1)
    // bigQueryStartLine is 5; error at [2:8] maps to line 5 + 2 - 1 = 6!
    expect(placed[0]!.startLineNumber).toBe(6)
    expect(placed[0]!.startColumn).toBe(8)
    expect(h.setModelMarkers).toHaveBeenCalledWith(primaryModel, dryRunMarkerOwner, expect.any(Array))

    // 3. Malformed File mode clears markers and estimate without sending a dry run.
    h.f.model(doc.id).edit('SELECT 1 -- broken headers')
    await h.runTimers()
    expect(h.dryRun).toHaveBeenCalledTimes(2)
    expect(h.markers.get(primaryModel)).toEqual([])
    expect(h.service.getSnapshot().get(doc.id)).toBeUndefined()

    h.service.dispose()
  })

  it('R3 Finding 1: connectionForRemote never falls back to first multiMode target when connectionForResult is absent or becomes closed mid-dry-run', async () => {
    const bq1: LiveConnection = { id: bqUuid(1), server: 'proj-1', database: 'ds_one', serverVersion: '', generation: 1, providerId: 'bigquery', options: { provider: 'bigquery', project: 'proj-1', authentication: 'gcloud' } } as LiveConnection
    const bq2: LiveConnection = { id: bqUuid(2), server: 'proj-2', database: 'ds_two', serverVersion: '', generation: 1, providerId: 'bigquery', options: { provider: 'bigquery', project: 'proj-2', authentication: 'gcloud' } } as LiveConnection
    const f = documentFixture()
    const liveIds = new Set([bq1.id, bq2.id])
    const connMap = new Map([[bq1.id, bq1], [bq2.id, bq2]])
    const resultOwners = new Map<number, string>([[10, bq1.id], [20, bq2.id]])
    let resolveDryRun!: (value: { ok: true; value: BigQueryDryRunResult }) => void
    const dryRun = vi.fn(() => new Promise<{ ok: true; value: BigQueryDryRunResult }>(resolve => { resolveDryRun = resolve }))
    const ask = vi.fn(async () => ({ run: true }))

    const service = new BigQueryCostService({
      api: { bigQueryDryRun: dryRun as never },
      documents: f.documents,
      connections: { get: id => connMap.get(id), isLive: id => liveIds.has(id), subscribe: () => () => {} },
      settings: { get: key => defaultSettings[key], subscribe: () => () => {}, choose: async () => {} },
      events: { subscribe: () => ({ dispose() {} }) },
      monaco: { MarkerSeverity: { Error: 8 } as typeof Monaco.MarkerSeverity, editor: { setModelMarkers: vi.fn() } },
      ask,
      optOut: costOptOut({ loadConnectionLibrary: async () => ({ ok: false, error: 'none' }), setBigQueryCostPrompt: async () => ({ ok: true, value: true }) }),
      connectionForResult: (_tabId, resultId) => resultOwners.get(resultId)
    })

    const doc = f.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      sql: 'SELECT 1',
      targets: [
        { targetId: bqUuid(10), connectionId: bq1.id, database: 'ds_one', enabled: true, provider: 'bigquery' },
        { targetId: bqUuid(20), connectionId: bq2.id, database: 'ds_two', enabled: true, provider: 'bigquery' }
      ]
    })

    // 1. Unmapped resultId must NOT fall back to bq1 (zero dry-run IPC).
    await expect(service.estimateRemote(doc.id, { resultId: 999, generation: 1, kind: 'sample', rows: 10, method: 'first' }))
      .rejects.toThrow('no longer connected')
    await expect(service.beforeRemote(doc.id, { resultId: 999, generation: 1, kind: 'view', sort: [] }))
      .rejects.toThrow('no longer connected')
    expect(dryRun).not.toHaveBeenCalled()

    // 2. Mapped resultId whose connection is not live must NOT fall back to bq1.
    liveIds.delete(bq2.id)
    await expect(service.beforeRemote(doc.id, { resultId: 20, generation: 1, kind: 'view', sort: [] }))
      .rejects.toThrow('no longer connected')
    expect(dryRun).not.toHaveBeenCalled()

    // 3. Result on first target (bq1) closes while beforeRemote dry-run is in flight -> returns undefined WITHOUT prompting!
    const remotePending = service.beforeRemote(doc.id, { resultId: 10, generation: 1, kind: 'view', sort: [] })
    expect(dryRun).toHaveBeenCalledTimes(1)
    resultOwners.delete(10)
    resolveDryRun({ ok: true, value: { bytesProcessed: 50 * 2 ** 30 } })
    await expect(remotePending).resolves.toBeUndefined()
    expect(ask).not.toHaveBeenCalled()

    service.dispose()
  })

  it('R3 Finding 5: shares incompleteEstimateWarning opt-out tracking synchronously between BigQueryCostService and executeMultiTab', async () => {
    const bq1: LiveConnection = { id: bqUuid(1), server: 'proj-1', database: 'ds_one', serverVersion: '', generation: 1, providerId: 'bigquery', options: { provider: 'bigquery', project: 'proj-1', authentication: 'gcloud' } } as LiveConnection
    const f = documentFixture()
    const connMap = new Map([[bq1.id, bq1]])
    let settingValues = { ...defaultSettings, 'queryExecution.bigQuery.incompleteEstimateWarning': true }
    let releaseSave!: () => void
    let saveGate = new Promise<void>(resolve => { releaseSave = resolve })
    const settings = {
      get: <K extends keyof typeof defaultSettings>(key: K) => settingValues[key],
      subscribe: () => () => {},
      choose: async <K extends keyof typeof defaultSettings>(key: K, value: (typeof defaultSettings)[K]) => {
        await saveGate
        settingValues = { ...settingValues, [key]: value }
      }
    }
    const costPrompts = new CostPromptService()
    const optOut = costOptOut({ loadConnectionLibrary: async () => ({ ok: false, error: 'none' }), setBigQueryCostPrompt: async () => ({ ok: true, value: true }) })
    const dryRun = vi.fn(async () => ({ ok: true as const, value: { bytesProcessed: 0, incomplete: 'zeroBytes' as const } }))

    const costService = new BigQueryCostService({
      api: { bigQueryDryRun: dryRun as never },
      documents: f.documents,
      connections: { get: id => connMap.get(id), isLive: id => connMap.has(id), subscribe: () => () => {} },
      settings,
      events: { subscribe: () => ({ dispose() {} }) },
      monaco: { MarkerSeverity: { Error: 8 } as typeof Monaco.MarkerSeverity, editor: { setModelMarkers: vi.fn() } },
      ask: (req, signal, stillAsks, onAnswer) => costPrompts.ask(req, signal, stillAsks, onAnswer),
      optOut
    })

    const singleDoc = f.documents.create('single.sql', 'SELECT 1', 'ds_one', bq1.id)
    const multiDoc = f.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      sql: 'SELECT 2',
      targets: [{ targetId: bqUuid(10), connectionId: bq1.id, database: 'ds_one', enabled: true, provider: 'bigquery' }]
    })
    const executeMulti = vi.fn(async () => {})
    const multiDeps = {
      documents: f.documents,
      connections: { get: (id: string) => connMap.get(id), isLive: (id: string) => connMap.has(id) },
      queries: { isRunning: () => false, executeMulti, refuseReadOnly: vi.fn() },
      settings,
      api: { bigQueryDryRun: dryRun as never },
      optOut,
      costPrompts,
      multiExecutePrompts: new MultiExecutePromptService(),
      notify: vi.fn(),
      disableIncompleteWarning: () => settings.choose('queryExecution.bigQuery.incompleteEstimateWarning', false)
    }

    // Direction A: BigQueryCostService opts out while settings.choose is in flight -> queued executeMultiTab prompt is synchronously mooted!
    const singleRun = costService.beforeExecute(singleDoc.id, 'SELECT 1')
    const multiRun = executeMultiTab(multiDoc.id, multiDeps)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const first = costPrompts.getSnapshot().pending!
    expect(first.request.prompt.kind).toBe('incomplete')
    costPrompts.answer(first.id, { run: true, dontAskAgain: true })
    expect(costPrompts.getSnapshot().pending).toBeUndefined()
    releaseSave()
    await expect(singleRun).resolves.toBe(true)
    await expect(multiRun).resolves.toMatchObject({ status: 'executed' })

    // Direction B: executeMultiTab opts out while disableIncompleteWarning is in flight -> queued BigQueryCostService prompt is synchronously mooted!
    settingValues = { ...defaultSettings, 'queryExecution.bigQuery.incompleteEstimateWarning': true }
    saveGate = new Promise<void>(resolve => { releaseSave = resolve })
    const singleDoc2 = f.documents.create('single2.sql', 'SELECT 3', 'ds_one', bq1.id)
    const multiRun2 = executeMultiTab(multiDoc.id, multiDeps)
    const singleRun2 = costService.beforeExecute(singleDoc2.id, 'SELECT 3')
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const second = costPrompts.getSnapshot().pending!
    expect(second.request.prompt.kind).toBe('incomplete')
    costPrompts.answer(second.id, { run: true, dontAskAgain: true })
    expect(costPrompts.getSnapshot().pending).toBeUndefined()
    releaseSave()
    await expect(multiRun2).resolves.toMatchObject({ status: 'executed' })
    await expect(singleRun2).resolves.toBe(true)

    costService.dispose()
    costPrompts.dispose()
  })

  it('R4 D1 #1: status() returns undefined in Cross-Engine Split when primary T-SQL pane is focused, shows BigQuery status on secondary pane, and preserves status in File mode', async () => {
    const sql1: LiveConnection = { id: sqlUuid(1), server: 'sql-1', database: 'Sales', serverVersion: '16.0', generation: 1, providerId: 'sqlserver', options: { provider: 'sqlserver', server: 'sql-1', database: 'Sales', authentication: 'sql', trustServerCertificate: true } } as LiveConnection
    const bq1: LiveConnection = { id: bqUuid(1), server: 'proj-1', database: 'analytics', serverVersion: '', generation: 1, providerId: 'bigquery', options: { provider: 'bigquery', project: 'proj-1', authentication: 'gcloud' } } as LiveConnection
    const h = createCostHarness([sql1, bq1], async () => ({ ok: true, value: { bytesProcessed: 1024 } }))

    const doc = h.f.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2',
      targets: [
        { targetId: sqlUuid(10), connectionId: sql1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: bqUuid(10), connectionId: bq1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })

    // Produce a BigQuery dry-run estimate on the secondary GoogleSQL model.
    const secModel = h.f.documents.getSecondaryModel(doc.id) as unknown as TestModel
    secModel.edit('SELECT 42 FROM analytics.events')
    await h.runTimers()
    expect(h.service.getSnapshot().get(doc.id)).toEqual({ phase: 'estimate', bytes: 1024 })

    // Primary T-SQL pane focused (default or explicit): BigQuery status must NOT shadow T-SQL diagnostics.
    expect(h.service.status(doc.id)).toBeUndefined()
    h.f.documents.setActivePane(doc.id, 'primary')
    expect(h.service.status(doc.id)).toBeUndefined()

    // Secondary GoogleSQL pane focused: BigQuery status is returned.
    h.f.documents.setActivePane(doc.id, 'secondary')
    expect(h.service.status(doc.id)).toMatchObject({ label: 'BigQuery: no issues' })

    // Returning to primary hides BigQuery status again.
    h.f.documents.setActivePane(doc.id, 'primary')
    expect(h.service.status(doc.id)).toBeUndefined()

    // Cross-Engine File mode preserves BigQuery dry-run status regardless of activePane.
    expect(h.f.documents.setCrossView(doc.id, 'file')).toEqual({ ok: true })
    h.f.model(doc.id).edit(serializeCrossEngineSql('SELECT 1', 'SELECT 99 FROM analytics.events'))
    await h.runTimers()
    expect(h.service.status(doc.id)).toMatchObject({ label: 'BigQuery: no issues' })

    h.service.dispose()
  })

  it('R7 #5: CostPromptService short-circuits ask() and askMulti() immediately after dispose()', async () => {
    const prompts = new CostPromptService()
    const pendingBefore = prompts.ask({
      prompt: { kind: 'threshold', bytes: 15 * 1024 ** 3 },
      connection: 'proj-before',
      thresholdBytes: 10 * 1024 ** 3,
      prices: true
    })
    prompts.dispose()
    await expect(pendingBefore).resolves.toEqual({ run: false })

    const afterSingle = await prompts.ask({
      prompt: { kind: 'threshold', bytes: 15 * 1024 ** 3 },
      connection: 'proj-after',
      thresholdBytes: 10 * 1024 ** 3,
      prices: true
    })
    const afterMulti = await prompts.askMulti({
      kind: 'multi',
      prices: true,
      totalBytes: 20 * 1024 ** 3,
      projects: [{ connectionId: 'c1', label: 'proj-after', prompt: { kind: 'threshold', bytes: 20 * 1024 ** 3 }, thresholdBytes: 10 * 1024 ** 3 }]
    })
    expect(afterSingle).toEqual({ run: false })
    expect(afterMulti).toEqual({ run: false })
    expect(prompts.getSnapshot()).toEqual({})
  })
})
