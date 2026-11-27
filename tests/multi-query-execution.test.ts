import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, MultiQueryOptions, QueryMultiResult, VariaApi } from '../src/shared/contracts'
import type { BigQueryDryRunResult } from '../src/shared/bigquery/dry-run'
import { serializeCrossEngineSql } from '../src/shared/multi-query'
import { defaultSettings, type SettingKey, type SettingsValues } from '../src/shared/settings/catalog'
import { CostPromptService } from '../src/renderer/src/services/bigquery-cost-prompt'
import type { LiveConnection } from '../src/renderer/src/services/connections'
import {
  executeMultiTab,
  isBigQueryEmulatorConnection,
  MultiExecutePromptService,
  type MultiExecuteChoice,
  type MultiExecuteDeps,
  type MultiExecuteDialogRequest
} from '../src/renderer/src/services/multi-execute'
import { QueryService } from '../src/renderer/src/services/queries'
import type { MultiResultsSink } from '../src/renderer/src/results/multi-results-contract'
import { documentFixture } from './fixtures/documents'

const GiB = 2 ** 30
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function sqlConnection(n: number, extra: Partial<LiveConnection> = {}): LiveConnection {
  return {
    id: uuid(n),
    targetId: uuid(100 + n),
    generation: 1,
    server: `sql-srv-0${n}`,
    database: 'Sales',
    serverVersion: '16.0',
    providerId: 'sqlserver',
    options: { provider: 'sqlserver', server: `sql-srv-0${n}`, database: 'Sales', authentication: 'sql', trustServerCertificate: true },
    ...extra
  } as LiveConnection
}

function bqConnection(n: number, extra: Partial<LiveConnection> = {}): LiveConnection {
  return {
    id: uuid(200 + n),
    targetId: uuid(300 + n),
    generation: 1,
    server: `bq-proj-0${n}`,
    database: 'analytics',
    serverVersion: 'BigQuery',
    providerId: 'bigquery',
    principalId: 'bigquery:user:ada@example.com',
    options: { provider: 'bigquery', project: `bq-proj-0${n}`, dataset: 'analytics', authentication: 'gcloud' },
    ...extra
  } as LiveConnection
}

function createHarness(options: {
  connections?: readonly LiveConnection[]
  liveIds?: readonly string[]
  settings?: Partial<SettingsValues>
  dryRuns?: Record<string, ApiResult<BigQueryDryRunResult>>
  declinedIds?: readonly string[]
  ownThresholdsGiB?: Record<string, number>
  dialogChoice?: MultiExecuteChoice | undefined
  costAnswer?: { readonly run: boolean; readonly dontAskAgain?: boolean }
} = {}) {
  const docs = documentFixture()
  const conns = new Map((options.connections ?? []).map(c => [c.id, c]))
  const live = new Set(options.liveIds ?? (options.connections ?? []).map(c => c.id))
  const settingValues: SettingsValues = { ...defaultSettings, ...options.settings }
  const declined = new Set(options.declinedIds ?? [])
  const ownThresholds = new Map(Object.entries(options.ownThresholdsGiB ?? {}))
  const dryRunCalls: Parameters<VariaApi['bigQueryDryRun']>[0][] = []
  const executeMultiCalls: { tabId: string; request: Parameters<MultiExecuteDeps['queries']['executeMulti']>[1] }[] = []
  const refuseCalls: { tabId: string; violations: Parameters<MultiExecuteDeps['queries']['refuseReadOnly']>[1] }[] = []
  const dialogRequests: MultiExecuteDialogRequest[] = []
  const notifications: { message: string; severity?: string }[] = []
  const dontAskCalls: string[] = []
  const refreshCalls: string[] = []
  let incompleteDisabled = false

  const costPrompts = new CostPromptService()
  const singleAskSpy = vi.spyOn(costPrompts, 'ask').mockImplementation(async (_req, _signal, _still, onAnswer) => {
    const answer = options.costAnswer ?? { run: true }
    onAnswer?.(answer)
    return answer
  })
  const multiAskSpy = vi.spyOn(costPrompts, 'askMulti').mockImplementation(async (_req, _signal, _still, onAnswer) => {
    const answer = options.costAnswer ?? { run: true }
    onAnswer?.(answer)
    return answer
  })

  const multiExecutePrompts = new MultiExecutePromptService()
  const dialogAskSpy = vi.spyOn(multiExecutePrompts, 'ask').mockImplementation(async req => {
    dialogRequests.push(req)
    return 'dialogChoice' in options
      ? options.dialogChoice
      : { mode: 'transaction', sequential: false, preflightDryRun: false, stopOnError: false, autoCombine: true }
  })

  const deps: MultiExecuteDeps = {
    documents: docs.documents,
    connections: {
      get: id => conns.get(id),
      isLive: id => live.has(id) && conns.has(id)
    },
    queries: {
      isRunning: () => false,
      executeMulti: vi.fn(async (tabId, request) => { executeMultiCalls.push({ tabId, request }) }),
      refuseReadOnly: vi.fn((tabId, violations) => { refuseCalls.push({ tabId, violations }) })
    },
    settings: { get: <K extends SettingKey>(key: K) => settingValues[key] },
    api: {
      bigQueryDryRun: vi.fn<VariaApi['bigQueryDryRun']>(async req => {
        dryRunCalls.push(req)
        const mapped = 'sql' in req ? options.dryRuns?.[req.connectionId] : undefined
        return mapped ?? { ok: true, value: { bytesProcessed: 1024 } }
      })
    },
    optOut: {
      asks: conn => !declined.has(conn.id),
      refresh: async conn => { refreshCalls.push(conn.id) },
      dontAsk: async conn => { declined.add(conn.id); dontAskCalls.push(conn.id) },
      threshold: conn => ownThresholds.get(conn.id)
    },
    costPrompts,
    multiExecutePrompts,
    notify: (message, severity) => { notifications.push({ message, severity }) },
    disableIncompleteWarning: async () => { incompleteDisabled = true }
  }

  return {
    docs,
    deps,
    dryRunCalls,
    executeMultiCalls,
    refuseCalls,
    dialogRequests,
    notifications,
    dontAskCalls,
    refreshCalls,
    singleAskSpy,
    multiAskSpy,
    dialogAskSpy,
    isIncompleteDisabled: () => incompleteDisabled
  }
}

describe('executeMultiTab: Same-Engine execution orchestration', () => {
  it('refuses with zero IPC when 0 enabled live targets exist', async () => {
    const s1 = sqlConnection(1)
    const h = createHarness({ connections: [s1], liveIds: [] })
    const doc = h.docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'sqlserver',
      sql: 'SELECT 1',
      targets: [{ targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' }]
    })

    const outcome = await executeMultiTab(doc.id, h.deps)
    expect(outcome).toEqual({ status: 'refused', reason: 'noTargets' })
    expect(h.notifications[0]?.message).toContain('No connected SQL Server targets')
    expect(h.dialogAskSpy).not.toHaveBeenCalled()
    expect(h.executeMultiCalls).toHaveLength(0)
    expect(h.dryRunCalls).toHaveLength(0)
  })

  it('uses the 1-target shortcut (§1.3) on SQL Server when only 1 enabled live target remains, skipping MultiExecuteDialog', async () => {
    const s1 = sqlConnection(1)
    const s2 = sqlConnection(2)
    const h = createHarness({ connections: [s1, s2] })
    const doc = h.docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'sqlserver',
      sql: 'SELECT @@SERVERNAME;',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: s2.targetId, connectionId: s2.id, database: 'Sales', enabled: false, provider: 'sqlserver' }
      ]
    })

    const outcome = await executeMultiTab(doc.id, h.deps)
    expect(outcome).toEqual({ status: 'executed', mode: 'fireAndForget', targetCount: 1, skippedDialog: true })
    expect(h.dialogAskSpy).not.toHaveBeenCalled()
    expect(h.executeMultiCalls).toHaveLength(1)
    expect(h.executeMultiCalls[0]!.request).toMatchObject({
      mode: 'fireAndForget',
      autoCombine: false,
      sql: 'SELECT @@SERVERNAME;',
      targets: [{ connectionId: s1.id, database: 'Sales' }]
    })
  })

  it('uses the 1-target shortcut on BigQuery, skips MultiExecuteDialog, and still enforces single-project cost prompt', async () => {
    const b1 = bqConnection(1)
    const h = createHarness({
      connections: [b1],
      dryRuns: { [b1.id]: { ok: true, value: { bytesProcessed: 15 * GiB } } },
      costAnswer: { run: true, dontAskAgain: true }
    })
    const doc = h.docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      sql: 'SELECT * FROM analytics.events',
      targets: [{ targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }]
    })

    const outcome = await executeMultiTab(doc.id, h.deps)
    expect(outcome).toEqual({ status: 'executed', mode: 'fireAndForget', targetCount: 1, skippedDialog: true })
    expect(h.dialogAskSpy).not.toHaveBeenCalled()
    expect(h.dryRunCalls).toHaveLength(1)
    expect('sessionId' in h.dryRunCalls[0]!).toBe(false)
    expect(h.singleAskSpy).toHaveBeenCalledTimes(1)
    expect(h.multiAskSpy).not.toHaveBeenCalled()
    expect(h.dontAskCalls).toEqual([b1.id])
    expect(h.executeMultiCalls).toHaveLength(1)
  })

  it('aborts 1-target BigQuery shortcut when user declines the single-project cost prompt', async () => {
    const b1 = bqConnection(1)
    const h = createHarness({
      connections: [b1],
      dryRuns: { [b1.id]: { ok: true, value: { bytesProcessed: 25 * GiB } } },
      costAnswer: { run: false }
    })
    const doc = h.docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      sql: 'SELECT * FROM analytics.events',
      targets: [{ targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }]
    })

    const outcome = await executeMultiTab(doc.id, h.deps)
    expect(outcome).toEqual({ status: 'cancelled' })
    expect(h.executeMultiCalls).toHaveLength(0)
  })

  it('opens MultiExecuteDialog for >= 2 SQL Server targets and dispatches chosen mode and flags', async () => {
    const s1 = sqlConnection(1, { environment: 'Production' })
    const s2 = sqlConnection(2, { environment: 'Staging' })
    const h = createHarness({
      connections: [s1, s2],
      dialogChoice: { mode: 'fireAndForget', sequential: true, preflightDryRun: false, stopOnError: true, autoCombine: true }
    })
    const doc = h.docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'sqlserver',
      sql: 'UPDATE dbo.Items SET Active = 1;',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: s2.targetId, connectionId: s2.id, database: 'Sales', enabled: true, provider: 'sqlserver' }
      ]
    })

    const outcome = await executeMultiTab(doc.id, h.deps)
    expect(outcome).toEqual({ status: 'executed', mode: 'fireAndForget', targetCount: 2 })
    expect(h.dialogRequests).toHaveLength(1)
    expect(h.dialogRequests[0]!.targets.map(t => t.environment)).toEqual(['Production', 'Staging'])
    expect(h.executeMultiCalls).toHaveLength(1)
    expect(h.executeMultiCalls[0]!.request).toMatchObject({
      mode: 'fireAndForget',
      sequential: true,
      stopOnError: true,
      autoCombine: true
    })
  })

  it('opens MultiExecuteDialog for >= 2 BigQuery targets with refreshed per-connection cost metadata and never stacks BigQueryCostPrompt', async () => {
    const b1 = bqConnection(1, { environment: 'Production' })
    const b2 = bqConnection(2, { principalId: 'bigquery:anonymous:emulator' })
    expect(isBigQueryEmulatorConnection(b1)).toBe(false)
    expect(isBigQueryEmulatorConnection(b2)).toBe(true)

    const h = createHarness({
      connections: [b1, b2],
      declinedIds: [b2.id],
      ownThresholdsGiB: { [b1.id]: 3 },
      dialogChoice: { mode: 'fireAndForget', sequential: true, preflightDryRun: true, stopOnError: false, autoCombine: true }
    })
    const doc = h.docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      sql: 'CREATE OR REPLACE VIEW analytics.v AS SELECT 1;',
      targets: [
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' },
        { targetId: b2.targetId, connectionId: b2.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })

    const outcome = await executeMultiTab(doc.id, h.deps)
    expect(outcome).toEqual({ status: 'executed', mode: 'fireAndForget', targetCount: 2 })
    expect(h.refreshCalls).toEqual([b1.id, b2.id])
    expect(h.dialogRequests).toHaveLength(1)
    expect(h.dialogRequests[0]!.targets[0]).toMatchObject({
      costPrompt: true,
      costThresholdBytes: 3 * GiB,
      ownCostThreshold: true
    })
    expect(h.dialogRequests[0]!.targets[1]).toMatchObject({
      costPrompt: false,
      emulator: true
    })
    expect(h.singleAskSpy).not.toHaveBeenCalled()
    expect(h.multiAskSpy).not.toHaveBeenCalled()
    expect(h.executeMultiCalls[0]!.request).toMatchObject({
      mode: 'fireAndForget',
      sequential: true,
      preflightDryRun: true
    })
  })
})

describe('executeMultiTab: Cross-Engine orchestration, read-only guard, and multi-project cost prompt', () => {
  it('refuses Cross-Engine when either SQL Server or BigQuery live target is missing (zero IPC)', async () => {
    const s1 = sqlConnection(1)
    const b1 = bqConnection(1)
    const h = createHarness({ connections: [s1, b1], liveIds: [s1.id] })
    const doc = h.docs.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })

    const outcome = await executeMultiTab(doc.id, h.deps)
    expect(outcome).toEqual({ status: 'refused', reason: 'missingCrossEngineTarget' })
    expect(h.notifications[0]?.message).toContain('BigQuery')
    expect(h.dryRunCalls).toHaveLength(0)
    expect(h.executeMultiCalls).toHaveLength(0)
  })

  it('refuses locally when either Cross-Engine dialect pane is empty or comment-only (zero IPC)', async () => {
    const s1 = sqlConnection(1)
    const b1 = bqConnection(1)
    const h = createHarness({ connections: [s1, b1] })
    const doc = h.docs.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1 AS a',
      bigQuerySql: '  -- comment only\n   ',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })

    const outcome = await executeMultiTab(doc.id, h.deps)
    expect(outcome).toEqual({ status: 'refused', reason: 'emptySql' })
    expect(h.notifications[0]?.message).toContain('GoogleSQL')
    expect(h.dryRunCalls).toHaveLength(0)
    expect(h.executeMultiCalls).toHaveLength(0)
  })

  it('checks read-only guard on BOTH SQL Server and BigQuery panes and calls refuseReadOnly with line + dialect (zero IPC)', async () => {
    const s1 = sqlConnection(1)
    const b1 = bqConnection(1)
    const h = createHarness({ connections: [s1, b1] })
    const doc = h.docs.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1;\nUPDATE dbo.Orders SET Status = 1;',
      bigQuerySql: 'DELETE FROM analytics.orders WHERE true;',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })

    const outcome = await executeMultiTab(doc.id, h.deps)
    expect(outcome).toEqual({ status: 'refused', reason: 'readOnlyViolation' })
    expect(h.refuseCalls).toHaveLength(1)
    expect(h.refuseCalls[0]!.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ dialect: 'sqlserver', line: 2 }),
      expect.objectContaining({ dialect: 'bigquery', line: 1 })
    ]))
    expect(h.dryRunCalls).toHaveLength(0)
    expect(h.executeMultiCalls).toHaveLength(0)
  })

  it('maps File-mode read-only violation line numbers using parsed dialect startLines and refuses malformed File mode', async () => {
    const s1 = sqlConnection(1)
    const b1 = bqConnection(1)
    const h = createHarness({ connections: [s1, b1] })
    const doc = h.docs.documents.openMultiQuery({
      mode: 'cross',
      crossView: 'file',
      sql: serializeCrossEngineSql('SELECT 1\nFROM dbo.Orders', 'DROP TABLE analytics.orders'),
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })

    // Line 1: -- #Dialect="sqlserver"
    // Line 2: SELECT 1
    // Line 3: FROM dbo.Orders
    // Line 4: -- #Dialect="bigquery"
    // Line 5: DROP TABLE analytics.orders
    const outcome = await executeMultiTab(doc.id, h.deps)
    expect(outcome).toEqual({ status: 'refused', reason: 'readOnlyViolation' })
    expect(h.refuseCalls[0]!.violations[0]).toMatchObject({ dialect: 'bigquery', line: 5 })

    // Malformed canonical headers refuse locally with zero IPC.
    h.docs.model(doc.id).edit('SELECT 1;')
    const malformed = await executeMultiTab(doc.id, h.deps)
    expect(malformed).toEqual({ status: 'refused', reason: 'malformedCrossFile' })
    expect(h.executeMultiCalls).toHaveLength(0)
  })

  it('opens ONE multi-project BigQueryCostPrompt for only the projects exceeding their own threshold (with costPrompt !== false)', async () => {
    const s1 = sqlConnection(1)
    const b1 = bqConnection(1, { environment: 'Production' })
    const b2 = bqConnection(2, { environment: 'Staging' })
    const b3 = bqConnection(3)
    const b4 = bqConnection(4)

    const h = createHarness({
      connections: [s1, b1, b2, b3, b4],
      settings: { 'queryExecution.bigQuery.costThreshold': 10 },
      declinedIds: [b3.id], // costPrompt: false -> must be skipped even though 50 GiB > 10 GiB
      ownThresholdsGiB: { [b2.id]: 2 }, // own threshold 2 GiB -> 4 GiB exceeds it!
      dryRuns: {
        [b1.id]: { ok: true, value: { bytesProcessed: 15 * GiB } }, // exceeds global 10 GiB
        [b2.id]: { ok: true, value: { bytesProcessed: 4 * GiB } },  // exceeds own 2 GiB
        [b3.id]: { ok: true, value: { bytesProcessed: 50 * GiB } }, // opted out (costPrompt: false)
        [b4.id]: { ok: true, value: { bytesProcessed: 1 * GiB } }   // below 10 GiB
      },
      costAnswer: { run: true, dontAskAgain: true }
    })

    const doc = h.docs.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT COUNT(*) FROM dbo.Orders',
      bigQuerySql: 'SELECT COUNT(*) FROM analytics.orders',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' },
        { targetId: b2.targetId, connectionId: b2.id, database: 'analytics', enabled: true, provider: 'bigquery' },
        { targetId: b3.targetId, connectionId: b3.id, database: 'analytics', enabled: true, provider: 'bigquery' },
        { targetId: b4.targetId, connectionId: b4.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })

    const outcome = await executeMultiTab(doc.id, h.deps)
    expect(outcome).toEqual({ status: 'executed', mode: 'crossEngineReadOnly', targetCount: 5 })
    expect(h.dialogAskSpy).not.toHaveBeenCalled()
    expect(h.singleAskSpy).not.toHaveBeenCalled()
    expect(h.multiAskSpy).toHaveBeenCalledTimes(1)

    const promptReq = h.multiAskSpy.mock.calls[0]![0]
    expect(promptReq.projects.map(p => p.connectionId)).toEqual([b1.id, b2.id])
    expect(promptReq.totalBytes).toBe(19 * GiB)
    expect(promptReq.totalProjectCount).toBe(4)
    expect(promptReq.projects[1]!.ownThreshold).toBe(true)
    expect(h.dontAskCalls).toEqual([b1.id, b2.id])

    expect(h.executeMultiCalls).toHaveLength(1)
    expect(h.executeMultiCalls[0]!.request).toMatchObject({
      mode: 'crossEngineReadOnly',
      scripts: { sqlserver: 'SELECT COUNT(*) FROM dbo.Orders', bigquery: 'SELECT COUNT(*) FROM analytics.orders' }
    })
    expect(h.executeMultiCalls[0]!.request.targets).toHaveLength(5)
  })

  it('cancels Cross-Engine execution cleanly when user cancels multi-project BigQueryCostPrompt', async () => {
    const s1 = sqlConnection(1)
    const b1 = bqConnection(1)
    const h = createHarness({
      connections: [s1, b1],
      dryRuns: { [b1.id]: { ok: true, value: { bytesProcessed: 20 * GiB } } },
      costAnswer: { run: false }
    })
    const doc = h.docs.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })

    const outcome = await executeMultiTab(doc.id, h.deps)
    expect(outcome).toEqual({ status: 'cancelled' })
    expect(h.multiAskSpy).toHaveBeenCalledTimes(1)
    expect(h.executeMultiCalls).toHaveLength(0)
  })

  it('calls disableIncompleteWarning when Cross-Engine prompt only flagged incomplete estimates and user opts out', async () => {
    const s1 = sqlConnection(1)
    const b1 = bqConnection(1)
    const b2 = bqConnection(2)
    const h = createHarness({
      connections: [s1, b1, b2],
      dryRuns: {
        [b1.id]: { ok: true, value: { bytesProcessed: 0, incomplete: 'zeroBytes' } },
        [b2.id]: { ok: true, value: { bytesProcessed: 512 } }
      },
      costAnswer: { run: true, dontAskAgain: true }
    })
    const doc = h.docs.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' },
        { targetId: b2.targetId, connectionId: b2.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })

    const outcome = await executeMultiTab(doc.id, h.deps)
    expect(outcome).toEqual({ status: 'executed', mode: 'crossEngineReadOnly', targetCount: 3 })
    expect(h.multiAskSpy).toHaveBeenCalledTimes(1)
    expect(h.isIncompleteDisabled()).toBe(true)
    expect(h.dontAskCalls).toHaveLength(0)
  })

  it('integrates end-to-end with real QueryService for both refusal and execution', async () => {
    const docs = documentFixture()
    const s1 = sqlConnection(1)
    const b1 = bqConnection(1)
    const conns = new Map<string, LiveConnection>([[s1.id, s1], [b1.id, b1]])
    const executedOptions: MultiQueryOptions[] = []
    const finishedCalls: unknown[] = []
    const results: MultiResultsSink = {
      begin: vi.fn(),
      finish: vi.fn(async (_tabId, _queryId, end) => { finishedCalls.push(end) }),
      updateMultiTargetState: vi.fn(),
      updateResultMeta: vi.fn()
    }
    const queryResult: QueryMultiResult = {
      status: 'completed',
      mode: 'crossEngineReadOnly',
      targets: [],
      resultSets: [],
      discardedResultSets: 0,
      messages: [],
      messagesTruncated: false,
      elapsedMs: 12,
      budget: { usedBytes: 0, globalBytes: 1024, queryBytes: 1024, generation: 1, seq: 1 },
      completedAt: new Date().toISOString()
    }
    const queries = new QueryService(
      docs.documents,
      {
        execute: vi.fn(),
        cancel: vi.fn(),
        confirmSessions: vi.fn(),
        querySessionState: vi.fn(),
        executeMulti: vi.fn(async (opts: MultiQueryOptions): Promise<ApiResult<QueryMultiResult>> => { executedOptions.push(opts); return { ok: true, value: queryResult } })
      },
      id => conns.get(id),
      docs.events,
      results
    )
    const costPrompts = new CostPromptService()
    const multiExecutePrompts = new MultiExecutePromptService()
    const deps: MultiExecuteDeps = {
      documents: docs.documents,
      connections: { get: id => conns.get(id), isLive: id => conns.has(id) },
      queries,
      settings: { get: <K extends SettingKey>(key: K) => defaultSettings[key] },
      api: { bigQueryDryRun: vi.fn(async () => ({ ok: true as const, value: { bytesProcessed: 128 } })) },
      optOut: { asks: () => true, refresh: async () => {}, dontAsk: async () => {}, threshold: () => undefined },
      costPrompts,
      multiExecutePrompts,
      notify: vi.fn()
    }

    const doc = docs.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })

    const outcome = await executeMultiTab(doc.id, deps)
    expect(outcome).toEqual({ status: 'executed', mode: 'crossEngineReadOnly', targetCount: 2 })
    expect(executedOptions).toHaveLength(1)
    expect(executedOptions[0]!.mode).toBe('crossEngineReadOnly')
    expect(executedOptions[0]!.jobKey).toBeDefined()
    // Ephemeral jobKey must never be persisted onto the multi-target document.
    expect(docs.documents.get(doc.id)?.jobKey).toBeUndefined()

    // Now inject a mutation and verify real QueryService.refuseReadOnly logs clickable READ_ONLY_VIOLATION with zero IPC.
    docs.model(doc.id).edit('DELETE FROM dbo.Orders;')
    const refused = await executeMultiTab(doc.id, deps)
    expect(refused).toEqual({ status: 'refused', reason: 'readOnlyViolation' })
    expect(executedOptions).toHaveLength(1)
    expect(finishedCalls.at(-1)).toMatchObject({ code: 'READ_ONLY_VIOLATION' })
  })
})

describe('executeMultiTab: pre-dispatch revalidation and queued cost prompt mooting', () => {
  it('refuses with warning instead of dispatching stale targets if a target disconnects or is disabled while MultiExecuteDialog is open', async () => {
    const s1 = sqlConnection(1)
    const s2 = sqlConnection(2)
    const liveIds = new Set([s1.id, s2.id])
    const h = createHarness({ connections: [s1, s2] })
    const deps: MultiExecuteDeps = {
      ...h.deps,
      connections: { get: id => h.deps.connections.get(id), isLive: id => liveIds.has(id) }
    }
    const doc = h.docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'sqlserver',
      sql: 'UPDATE dbo.Items SET Active = 1;',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: s2.targetId, connectionId: s2.id, database: 'Sales', enabled: true, provider: 'sqlserver' }
      ]
    })

    // Case 1: target 2 disconnects while dialog is open.
    h.dialogAskSpy.mockImplementationOnce(async () => {
      liveIds.delete(s2.id)
      return { mode: 'transaction', sequential: false, preflightDryRun: false, stopOnError: false, autoCombine: true }
    })
    const disconnected = await executeMultiTab(doc.id, deps)
    expect(disconnected).toEqual({ status: 'refused', reason: 'targetsChanged' })
    expect(h.notifications.at(-1)?.severity).toBe('warning')
    expect(h.notifications.at(-1)?.message).toContain('sql-srv-02')
    expect(h.executeMultiCalls).toHaveLength(0)

    // Case 2: target 2 is disabled in document.multiTargets while dialog is open.
    liveIds.add(s2.id)
    h.dialogAskSpy.mockImplementationOnce(async () => {
      h.docs.documents.updateMultiTarget(doc.id, 1, { enabled: false })
      return { mode: 'transaction', sequential: false, preflightDryRun: false, stopOnError: false, autoCombine: true }
    })
    const disabled = await executeMultiTab(doc.id, deps)
    expect(disabled).toEqual({ status: 'refused', reason: 'targetsChanged' })
    expect(h.executeMultiCalls).toHaveLength(0)

    // Case 3: documents becomes busy before dispatch.
    h.docs.documents.updateMultiTarget(doc.id, 1, { enabled: true })
    let isBusy = false
    let modeOverride: 'same' | 'cross' | undefined
    const busyDeps: MultiExecuteDeps = {
      ...deps,
      documents: {
        get: id => {
          const current = h.docs.documents.get(id)
          return current && id === doc.id && modeOverride ? { ...current, multiMode: modeOverride } : current
        },
        getExecuteText: id => h.docs.documents.getExecuteText(id),
        getCrossEngineScripts: id => h.docs.documents.getCrossEngineScripts(id),
        getSnapshot: () => ({ ...h.docs.documents.getSnapshot(), busy: isBusy })
      }
    }
    h.dialogAskSpy.mockImplementationOnce(async () => {
      isBusy = true
      return { mode: 'fireAndForget', sequential: false, preflightDryRun: false, stopOnError: false, autoCombine: true }
    })
    const busyOutcome = await executeMultiTab(doc.id, busyDeps)
    expect(busyOutcome).toEqual({ status: 'refused', reason: 'busy' })
    expect(h.executeMultiCalls).toHaveLength(0)

    // Case 4: document.multiMode changes while dialog is open.
    isBusy = false
    h.dialogAskSpy.mockImplementationOnce(async () => {
      modeOverride = 'cross'
      return { mode: 'fireAndForget', sequential: false, preflightDryRun: false, stopOnError: false, autoCombine: true }
    })
    const modeChanged = await executeMultiTab(doc.id, busyDeps)
    expect(modeChanged).toEqual({ status: 'cancelled' })
    expect(h.executeMultiCalls).toHaveLength(0)
  })

  it('refuses 1-target shortcut and Cross-Engine runs with warning if a target disconnects during async dry run / cost prompt', async () => {
    const s1 = sqlConnection(1)
    const b1 = bqConnection(1)
    const liveIds = new Set([s1.id, b1.id])
    const h = createHarness({
      connections: [s1, b1],
      dryRuns: { [b1.id]: { ok: true, value: { bytesProcessed: 15 * GiB } } }
    })
    const deps: MultiExecuteDeps = {
      ...h.deps,
      connections: { get: id => h.deps.connections.get(id), isLive: id => liveIds.has(id) }
    }

    // 1-target BigQuery shortcut: target disconnects during cost prompt.
    const sameDoc = h.docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      sql: 'SELECT * FROM analytics.events',
      targets: [{ targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }]
    })
    h.singleAskSpy.mockImplementationOnce(async () => {
      liveIds.delete(b1.id)
      return { run: true }
    })
    const singleRefused = await executeMultiTab(sameDoc.id, deps)
    expect(singleRefused).toEqual({ status: 'refused', reason: 'targetsChanged' })
    expect(h.notifications.at(-1)?.severity).toBe('warning')
    expect(h.executeMultiCalls).toHaveLength(0)

    // Cross-Engine: SQL Server target disconnects during BigQuery cost prompt.
    liveIds.add(b1.id)
    const crossDoc = h.docs.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })
    h.multiAskSpy.mockImplementationOnce(async () => {
      liveIds.delete(s1.id)
      return { run: true }
    })
    const crossRefused = await executeMultiTab(crossDoc.id, deps)
    expect(crossRefused).toEqual({ status: 'refused', reason: 'targetsChanged' })
    expect(h.notifications.at(-1)?.message).toContain('sql-srv-01')
    expect(h.executeMultiCalls).toHaveLength(0)
  })

  it('passes stillAsks to costPrompts.ask and costPrompts.askMulti so Dont ask again moots queued prompts for the same project', async () => {
    const s1 = sqlConnection(1)
    const b1 = bqConnection(1)
    const docs = documentFixture()
    const conns = new Map<string, LiveConnection>([[s1.id, s1], [b1.id, b1]])
    const declined = new Set<string>()
    let settingValues: SettingsValues = { ...defaultSettings }
    const costPrompts = new CostPromptService()
    const multiExecutePrompts = new MultiExecutePromptService()
    const executeMulti = vi.fn(async () => {})
    const deps: MultiExecuteDeps = {
      documents: docs.documents,
      connections: { get: id => conns.get(id), isLive: id => conns.has(id) },
      queries: { isRunning: () => false, executeMulti, refuseReadOnly: vi.fn() },
      settings: { get: <K extends SettingKey>(key: K) => settingValues[key] },
      api: { bigQueryDryRun: vi.fn(async () => ({ ok: true as const, value: { bytesProcessed: 20 * GiB } })) },
      optOut: {
        asks: conn => !declined.has(conn.id),
        refresh: async () => {},
        dontAsk: async conn => { declined.add(conn.id) },
        threshold: () => undefined
      },
      costPrompts,
      multiExecutePrompts,
      notify: vi.fn(),
      disableIncompleteWarning: async () => { settingValues = { ...settingValues, 'queryExecution.bigQuery.incompleteEstimateWarning': false } }
    }

    // 1. Two queued 1-target BigQuery prompts for the same project.
    const tab1 = docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      sql: 'SELECT 1 FROM analytics.a',
      targets: [{ targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }]
    })
    const tab2 = docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      sql: 'SELECT 2 FROM analytics.b',
      targets: [{ targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }]
    })

    const run1 = executeMultiTab(tab1.id, deps)
    const run2 = executeMultiTab(tab2.id, deps)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    const firstPrompt = costPrompts.getSnapshot().pending
    expect(firstPrompt).toBeDefined()
    costPrompts.answer(firstPrompt!.id, { run: true, dontAskAgain: true })

    // Second prompt must be mooted immediately without appearing on screen.
    expect(costPrompts.getSnapshot().pending).toBeUndefined()
    await expect(run1).resolves.toEqual({ status: 'executed', mode: 'fireAndForget', targetCount: 1, skippedDialog: true })
    await expect(run2).resolves.toEqual({ status: 'executed', mode: 'fireAndForget', targetCount: 1, skippedDialog: true })
    expect(executeMulti).toHaveBeenCalledTimes(2)

    // 2. Two queued Cross-Engine multi-project prompts for the same project.
    declined.clear()
    const cross1 = docs.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 1 FROM analytics.a',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })
    const cross2 = docs.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 2',
      bigQuerySql: 'SELECT 2 FROM analytics.b',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })

    const cRun1 = executeMultiTab(cross1.id, deps)
    const cRun2 = executeMultiTab(cross2.id, deps)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    const firstMulti = costPrompts.getSnapshot().pendingMulti
    expect(firstMulti).toBeDefined()
    costPrompts.answer(firstMulti!.id, { run: true, dontAskAgain: true })

    // Second cross-engine prompt must be mooted immediately.
    expect(costPrompts.getSnapshot().pendingMulti).toBeUndefined()
    await expect(cRun1).resolves.toEqual({ status: 'executed', mode: 'crossEngineReadOnly', targetCount: 2 })
    await expect(cRun2).resolves.toEqual({ status: 'executed', mode: 'crossEngineReadOnly', targetCount: 2 })
    expect(executeMulti).toHaveBeenCalledTimes(4)

    costPrompts.dispose()
    multiExecutePrompts.dispose()
  })

  it('R2 Finding 9: rejects before dispatch if SQL revision changes, a target is added, or a target database/dataset changes while dialog or prompt is open', async () => {
    const s1 = sqlConnection(1)
    const s2 = sqlConnection(2)
    const s3 = sqlConnection(3)
    const b1 = bqConnection(1)
    const h = createHarness({ connections: [s1, s2, s3, b1], dryRuns: { [b1.id]: { ok: true, value: { bytesProcessed: 15 * GiB } } } })

    const sameDoc = h.docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'sqlserver',
      sql: 'SELECT 1;',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: s2.targetId, connectionId: s2.id, database: 'Sales', enabled: true, provider: 'sqlserver' }
      ]
    })

    // 1. SQL edited while MultiExecuteDialog is open -> refused with sqlChanged & warning.
    h.dialogAskSpy.mockImplementationOnce(async () => {
      h.docs.model(sameDoc.id).edit('DROP TABLE dbo.Orders;')
      return { mode: 'transaction', sequential: false, preflightDryRun: false, stopOnError: false, autoCombine: true }
    })
    expect(await executeMultiTab(sameDoc.id, h.deps)).toEqual({ status: 'refused', reason: 'sqlChanged' })
    expect(h.notifications.at(-1)?.severity).toBe('warning')
    expect(h.executeMultiCalls).toHaveLength(0)

    // 2. A 3rd target is enabled while dialog is open -> refused with targetsChanged.
    h.docs.model(sameDoc.id).edit('SELECT 1;')
    h.dialogAskSpy.mockImplementationOnce(async () => {
      h.docs.documents.setMultiTargets(sameDoc.id, [
        ...h.docs.documents.get(sameDoc.id)!.multiTargets!,
        { targetId: s3.targetId, connectionId: s3.id, database: 'Sales', enabled: true, provider: 'sqlserver' }
      ])
      return { mode: 'transaction', sequential: false, preflightDryRun: false, stopOnError: false, autoCombine: true }
    })
    expect(await executeMultiTab(sameDoc.id, h.deps)).toEqual({ status: 'refused', reason: 'targetsChanged' })
    expect(h.executeMultiCalls).toHaveLength(0)

    // 3. Target database changed while dialog is open -> refused with targetsChanged.
    h.docs.documents.setMultiTargets(sameDoc.id, [
      { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
      { targetId: s2.targetId, connectionId: s2.id, database: 'Sales', enabled: true, provider: 'sqlserver' }
    ])
    h.dialogAskSpy.mockImplementationOnce(async () => {
      h.docs.documents.updateMultiTarget(sameDoc.id, 1, { database: 'ProdArchive' })
      return { mode: 'transaction', sequential: false, preflightDryRun: false, stopOnError: false, autoCombine: true }
    })
    expect(await executeMultiTab(sameDoc.id, h.deps)).toEqual({ status: 'refused', reason: 'targetsChanged' })
    expect(h.executeMultiCalls).toHaveLength(0)

    // 4. Cross-Engine: SQL edited OR BigQuery dataset changed while cost prompt is open -> refused with zero IPC.
    const crossDoc = h.docs.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1;',
      bigQuerySql: 'SELECT 2;',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })
    h.multiAskSpy.mockImplementationOnce(async () => {
      h.docs.documents.updateMultiTarget(crossDoc.id, 1, { database: 'other_dataset' })
      return { run: true }
    })
    expect(await executeMultiTab(crossDoc.id, h.deps)).toEqual({ status: 'refused', reason: 'targetsChanged' })
    expect(h.executeMultiCalls).toHaveLength(0)

    h.multiAskSpy.mockImplementationOnce(async () => {
      h.docs.model(crossDoc.id).edit('DELETE FROM dbo.Orders;')
      return { run: true }
    })
    expect(await executeMultiTab(crossDoc.id, h.deps)).toEqual({ status: 'refused', reason: 'sqlChanged' })
    expect(h.executeMultiCalls).toHaveLength(0)
  })

  it('R2 Finding 12: tracks synchronous incompleteOff across queued prompts, re-evaluates moot 1-target prompts, and rebuilds partially-opted-out Cross-Engine prompts', async () => {
    const s1 = sqlConnection(1)
    const b1 = bqConnection(1)
    const b2 = bqConnection(2)
    const docs = documentFixture()
    const conns = new Map<string, LiveConnection>([[s1.id, s1], [b1.id, b1], [b2.id, b2]])
    const declined = new Set<string>()
    let settingValues: SettingsValues = { ...defaultSettings }
    const costPrompts = new CostPromptService()
    const multiExecutePrompts = new MultiExecutePromptService()
    const executeMulti = vi.fn(async () => {})
    let releaseIncompleteSave!: () => void
    const incompleteSaveGate = new Promise<void>(resolve => { releaseIncompleteSave = resolve })
    const dryRuns = new Map<string, BigQueryDryRunResult>()

    const deps: MultiExecuteDeps = {
      documents: docs.documents,
      connections: { get: id => conns.get(id), isLive: id => conns.has(id) },
      queries: { isRunning: () => false, executeMulti, refuseReadOnly: vi.fn() },
      settings: { get: <K extends SettingKey>(key: K) => settingValues[key] },
      api: { bigQueryDryRun: vi.fn(async req => ({ ok: true as const, value: dryRuns.get('connectionId' in req ? req.connectionId : '') ?? { bytesProcessed: 0 } })) },
      optOut: {
        asks: conn => !declined.has(conn.id),
        refresh: async () => {},
        dontAsk: async conn => { declined.add(conn.id) },
        threshold: () => undefined
      },
      costPrompts,
      multiExecutePrompts,
      notify: vi.fn(),
      disableIncompleteWarning: async () => {
        await incompleteSaveGate
        settingValues = { ...settingValues, 'queryExecution.bigQuery.incompleteEstimateWarning': false }
      }
    }

    // 1. Synchronous incompleteOff: two queued tabs with incomplete estimates; first checks dontAskAgain while async save is still pending -> second is mooted synchronously!
    dryRuns.set(b1.id, { bytesProcessed: 0, incomplete: 'zeroBytes' })
    const inc1 = docs.documents.openMultiQuery({
      mode: 'same', provider: 'bigquery', sql: 'SELECT 1',
      targets: [{ targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }]
    })
    const inc2 = docs.documents.openMultiQuery({
      mode: 'same', provider: 'bigquery', sql: 'SELECT 2',
      targets: [{ targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }]
    })
    const r1 = executeMultiTab(inc1.id, deps)
    const r2 = executeMultiTab(inc2.id, deps)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    const p1 = costPrompts.getSnapshot().pending!
    expect(p1.request.prompt.kind).toBe('incomplete')
    costPrompts.answer(p1.id, { run: true, dontAskAgain: true })
    // Even BEFORE incompleteSaveGate resolves, second prompt is mooted and never shown!
    expect(costPrompts.getSnapshot().pending).toBeUndefined()
    releaseIncompleteSave()
    await expect(r1).resolves.toMatchObject({ status: 'executed' })
    await expect(r2).resolves.toMatchObject({ status: 'executed' })

    // 2. 1-target re-evaluation on moot: estimate triggers BOTH threshold + incomplete.
    // Earlier prompt opts out threshold for b1 -> queued prompt becomes moot and re-evaluates to show the hidden incomplete warning!
    settingValues = { ...defaultSettings }
    declined.clear()
    dryRuns.set(b1.id, { bytesProcessed: 20 * GiB, incomplete: 'lowerBound' })
    const both1 = docs.documents.openMultiQuery({
      mode: 'same', provider: 'bigquery', sql: 'SELECT 10',
      targets: [{ targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }]
    })
    const both2 = docs.documents.openMultiQuery({
      mode: 'same', provider: 'bigquery', sql: 'SELECT 20',
      targets: [{ targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }]
    })
    const rb1 = executeMultiTab(both1.id, deps)
    const rb2 = executeMultiTab(both2.id, deps)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    const pb1 = costPrompts.getSnapshot().pending!
    expect(pb1.request.prompt.kind).toBe('threshold')
    costPrompts.answer(pb1.id, { run: true, dontAskAgain: true })
    await new Promise(resolve => { setTimeout(resolve, 0) })

    // Second tab's threshold prompt was mooted, then re-evaluated to its incomplete estimate prompt!
    const pb2 = costPrompts.getSnapshot().pending
    expect(pb2).toBeDefined()
    expect(pb2!.request.prompt.kind).toBe('incomplete')
    costPrompts.answer(pb2!.id, { run: true })
    await expect(rb1).resolves.toMatchObject({ status: 'executed' })
    await expect(rb2).resolves.toMatchObject({ status: 'executed' })

    // 3. Cross-Engine askMulti stillAsks uses flagged.every(...): opting out b1 in an earlier prompt moots queued {b1, b2} prompt and rebuilds it with ONLY b2!
    declined.clear()
    dryRuns.set(b1.id, { bytesProcessed: 20 * GiB })
    dryRuns.set(b2.id, { bytesProcessed: 25 * GiB })
    const singleB1 = docs.documents.openMultiQuery({
      mode: 'same', provider: 'bigquery', sql: 'SELECT 1',
      targets: [{ targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }]
    })
    const crossBoth = docs.documents.openMultiQuery({
      mode: 'cross', sql: 'SELECT 1', bigQuerySql: 'SELECT 2',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' },
        { targetId: b2.targetId, connectionId: b2.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })
    const rs = executeMultiTab(singleB1.id, deps)
    const rc = executeMultiTab(crossBoth.id, deps)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    const pSingle = costPrompts.getSnapshot().pending!
    expect(pSingle.request.connection).toBe(b1.server)
    costPrompts.answer(pSingle.id, { run: true, dontAskAgain: true })
    await new Promise(resolve => { setTimeout(resolve, 0) })

    // Rebuilt multi-project prompt must contain ONLY b2 (never the already-opted-out b1)!
    const rebuilt = costPrompts.getSnapshot().pendingMulti
    expect(rebuilt).toBeDefined()
    expect(rebuilt!.request.projects.map(p => p.connectionId)).toEqual([b2.id])
    costPrompts.answer(rebuilt!.id, { run: true })
    await expect(rs).resolves.toMatchObject({ status: 'executed' })
    await expect(rc).resolves.toMatchObject({ status: 'executed' })

    costPrompts.dispose()
    multiExecutePrompts.dispose()
  })

  it('R3 Finding 4: validates targets and SQL immediately after refreshBigQueryOptOut and after dry-runs before opening prompts', async () => {
    const s1 = sqlConnection(1)
    const b1 = bqConnection(1)
    const b2 = bqConnection(2)
    const liveIds = new Set([s1.id, b1.id, b2.id])
    const h = createHarness({
      connections: [s1, b1, b2],
      dryRuns: {
        [b1.id]: { ok: true, value: { bytesProcessed: 20 * GiB } },
        [b2.id]: { ok: true, value: { bytesProcessed: 20 * GiB } }
      }
    })
    let onRefresh: (() => void) | undefined
    let onDryRun: (() => void) | undefined
    const deps: MultiExecuteDeps = {
      ...h.deps,
      connections: { get: id => h.deps.connections.get(id), isLive: id => liveIds.has(id) },
      optOut: {
        ...h.deps.optOut,
        refresh: async conn => {
          await h.deps.optOut.refresh(conn)
          const cb = onRefresh
          onRefresh = undefined
          cb?.()
        }
      },
      api: {
        bigQueryDryRun: vi.fn<VariaApi['bigQueryDryRun']>(async req => {
          const res = await h.deps.api.bigQueryDryRun(req)
          const cb = onDryRun
          onDryRun = undefined
          cb?.()
          return res
        })
      }
    }

    // 1. Same-engine BigQuery: target drops during refreshBigQueryOptOut (2 -> 1) must refuse with targetsChanged instead of silently bypassing MultiExecuteDialog!
    const sameTwo = h.docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      sql: 'SELECT 1;',
      targets: [
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' },
        { targetId: b2.targetId, connectionId: b2.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })
    onRefresh = () => { liveIds.delete(b2.id) }
    expect(await executeMultiTab(sameTwo.id, deps)).toEqual({ status: 'refused', reason: 'targetsChanged' })
    expect(h.dialogAskSpy).not.toHaveBeenCalled()
    expect(h.singleAskSpy).not.toHaveBeenCalled()
    expect(h.executeMultiCalls).toHaveLength(0)

    // 2. Same-engine BigQuery: new target attached during refreshBigQueryOptOut (1 -> 2) must refuse with targetsChanged (never enter unrefreshed)!
    liveIds.add(b2.id)
    const sameOne = h.docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      sql: 'SELECT 1;',
      targets: [{ targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }]
    })
    onRefresh = () => {
      h.docs.documents.setMultiTargets(sameOne.id, [
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' },
        { targetId: b2.targetId, connectionId: b2.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ])
    }
    expect(await executeMultiTab(sameOne.id, deps)).toEqual({ status: 'refused', reason: 'targetsChanged' })
    expect(h.dialogAskSpy).not.toHaveBeenCalled()
    expect(h.singleAskSpy).not.toHaveBeenCalled()

    // 3. Same-engine 1-target BigQuery: SQL changes during dryRunTarget -> refuses BEFORE opening BigQueryCostPrompt!
    h.docs.documents.setMultiTargets(sameOne.id, [
      { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
    ])
    onDryRun = () => { h.docs.model(sameOne.id).edit('SELECT 999;') }
    expect(await executeMultiTab(sameOne.id, deps)).toEqual({ status: 'refused', reason: 'sqlChanged' })
    expect(h.singleAskSpy).not.toHaveBeenCalled()
    expect(h.executeMultiCalls).toHaveLength(0)

    // 4. Cross-Engine: target added during refreshBigQueryOptOut -> refuses BEFORE dry runs!
    const crossDoc = h.docs.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1;',
      bigQuerySql: 'SELECT 2;',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })
    const dryRunsBefore = h.dryRunCalls.length
    onRefresh = () => {
      h.docs.documents.setMultiTargets(crossDoc.id, [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' },
        { targetId: b2.targetId, connectionId: b2.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ])
    }
    expect(await executeMultiTab(crossDoc.id, deps)).toEqual({ status: 'refused', reason: 'targetsChanged' })
    expect(h.dryRunCalls.length).toBe(dryRunsBefore)
    expect(h.multiAskSpy).not.toHaveBeenCalled()

    // 5. Cross-Engine: target changes during runBoundedPool dry runs -> refuses BEFORE opening askMulti!
    h.docs.documents.setMultiTargets(crossDoc.id, [
      { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
      { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
    ])
    onDryRun = () => { liveIds.delete(s1.id) }
    expect(await executeMultiTab(crossDoc.id, deps)).toEqual({ status: 'refused', reason: 'targetsChanged' })
    expect(h.multiAskSpy).not.toHaveBeenCalled()
    expect(h.executeMultiCalls).toHaveLength(0)
  })

  it('R3 Finding 6: executeCrossEngine askMulti stillAsks recomputes buildFlagged so threshold changes moot or rebuild queued prompts', async () => {
    const s1 = sqlConnection(1)
    const b1 = bqConnection(1)
    const b2 = bqConnection(2)
    const docs = documentFixture()
    const conns = new Map<string, LiveConnection>([[s1.id, s1], [b1.id, b1], [b2.id, b2]])
    let settingValues: SettingsValues = { ...defaultSettings, 'queryExecution.bigQuery.costThreshold': 10 }
    const costPrompts = new CostPromptService()
    const multiExecutePrompts = new MultiExecutePromptService()
    const executeMulti = vi.fn(async () => {})
    const deps: MultiExecuteDeps = {
      documents: docs.documents,
      connections: { get: id => conns.get(id), isLive: id => conns.has(id) },
      queries: { isRunning: () => false, executeMulti, refuseReadOnly: vi.fn() },
      settings: { get: <K extends SettingKey>(key: K) => settingValues[key] },
      api: {
        bigQueryDryRun: vi.fn(async req => {
          const cid = 'connectionId' in req ? req.connectionId : ''
          return { ok: true as const, value: { bytesProcessed: cid === b1.id ? 15 * GiB : 8 * GiB } }
        })
      },
      optOut: { asks: () => true, refresh: async () => {}, dontAsk: async () => {}, threshold: () => undefined },
      costPrompts,
      multiExecutePrompts,
      notify: vi.fn()
    }

    const crossDoc = docs.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' },
        { targetId: b2.targetId, connectionId: b2.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })

    // Case 1: Raising global costThreshold from 10 GiB -> 20 GiB while queued moots the multi-project prompt completely!
    const blocker1 = costPrompts.ask({ prompt: { kind: 'threshold', bytes: 30 * GiB }, connection: 'other', thresholdBytes: 10 * GiB, prices: true })
    const run1 = executeMultiTab(crossDoc.id, deps)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const blockerPrompt1 = costPrompts.getSnapshot().pending!
    settingValues = { ...settingValues, 'queryExecution.bigQuery.costThreshold': 20 }
    costPrompts.answer(blockerPrompt1.id, { run: true })
    await blocker1
    expect(costPrompts.getSnapshot().pendingMulti).toBeUndefined()
    await expect(run1).resolves.toMatchObject({ status: 'executed', mode: 'crossEngineReadOnly' })

    // Case 2: Lowering global costThreshold from 10 GiB -> 5 GiB while queued moots the stale [b1 @ 10 GiB] prompt and rebuilds [b1, b2 @ 5 GiB]!
    settingValues = { ...settingValues, 'queryExecution.bigQuery.costThreshold': 10 }
    const blocker2 = costPrompts.ask({ prompt: { kind: 'threshold', bytes: 30 * GiB }, connection: 'other', thresholdBytes: 10 * GiB, prices: true })
    const run2 = executeMultiTab(crossDoc.id, deps)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const blockerPrompt2 = costPrompts.getSnapshot().pending!
    settingValues = { ...settingValues, 'queryExecution.bigQuery.costThreshold': 5 }
    costPrompts.answer(blockerPrompt2.id, { run: true })
    await blocker2
    await new Promise(resolve => { setTimeout(resolve, 0) })

    const rebuilt = costPrompts.getSnapshot().pendingMulti!
    expect(rebuilt).toBeDefined()
    expect(rebuilt.request.projects.map(p => p.connectionId)).toEqual([b1.id, b2.id])
    expect(rebuilt.request.projects.every(p => p.thresholdBytes === 5 * GiB)).toBe(true)
    costPrompts.answer(rebuilt.id, { run: true })
    await expect(run2).resolves.toMatchObject({ status: 'executed', mode: 'crossEngineReadOnly' })

    costPrompts.dispose()
    multiExecutePrompts.dispose()
  })

  it('R3 Finding 8: executeSameEngine forwards selection startLine (> 1) to MultiExecuteDialogRequest', async () => {
    const s1 = sqlConnection(1)
    const s2 = sqlConnection(2)
    const h = createHarness({ connections: [s1, s2] })
    const doc = h.docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'sqlserver',
      sql: 'SELECT 1;\nSELECT 2;\nSELECT 3;\nBACKUP DATABASE Sales TO DISK = \'NUL\';',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: s2.targetId, connectionId: s2.id, database: 'Sales', enabled: true, provider: 'sqlserver' }
      ]
    })

    const selectionDeps: MultiExecuteDeps = {
      ...h.deps,
      documents: {
        get: id => h.docs.documents.get(id),
        getSnapshot: () => h.docs.documents.getSnapshot(),
        getCrossEngineScripts: id => h.docs.documents.getCrossEngineScripts(id),
        revision: id => h.docs.documents.revision(id),
        getExecuteText: () => ({ sql: 'BACKUP DATABASE Sales TO DISK = \'NUL\';', startLine: 4, startColumn: 1 })
      }
    }
    const outcome = await executeMultiTab(doc.id, selectionDeps)
    expect(outcome).toEqual({ status: 'executed', mode: 'transaction', targetCount: 2 })
    expect(h.dialogRequests[0]?.startLine).toBe(4)

    // When startLine === 1, startLine is omitted.
    await executeMultiTab(doc.id, h.deps)
    expect(h.dialogRequests[1]?.startLine).toBeUndefined()
  })

  it('R4 D3 #2: refuses upfront with tooManyTargets (> 32 enabled live targets) before opt-out refresh, dry runs, or modals in both Same-Engine and Cross-Engine', async () => {
    const bqs = Array.from({ length: 33 }, (_, i) => bqConnection(i + 1))
    const sqls = Array.from({ length: 20 }, (_, i) => sqlConnection(i + 1))
    const h = createHarness({ connections: [...sqls, ...bqs] })

    // 1. Same-Engine BigQuery with 33 enabled live targets: refused before refreshBigQueryOptOut, dryRun, or MultiExecuteDialog.
    const sameOver = h.docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      sql: 'SELECT 1;',
      targets: bqs.map(c => ({ targetId: c.targetId, connectionId: c.id, database: 'analytics', enabled: true, provider: 'bigquery' as const }))
    })
    expect(await executeMultiTab(sameOver.id, h.deps)).toEqual({ status: 'refused', reason: 'tooManyTargets' })
    expect(h.notifications.at(-1)?.severity).toBe('warning')
    expect(h.notifications.at(-1)?.message).toContain('32')
    expect(h.refreshCalls).toHaveLength(0)
    expect(h.dryRunCalls).toHaveLength(0)
    expect(h.dialogAskSpy).not.toHaveBeenCalled()
    expect(h.executeMultiCalls).toHaveLength(0)

    // 2. Cross-Engine with 20 SQL Server + 13 BigQuery (= 33 enabled live targets): refused upfront before refresh/dryRun/costPrompt.
    const crossOver = h.docs.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1;',
      bigQuerySql: 'SELECT 2;',
      targets: [
        ...sqls.map(c => ({ targetId: c.targetId, connectionId: c.id, database: 'Sales', enabled: true, provider: 'sqlserver' as const })),
        ...bqs.slice(0, 13).map(c => ({ targetId: c.targetId, connectionId: c.id, database: 'analytics', enabled: true, provider: 'bigquery' as const }))
      ]
    })
    expect(await executeMultiTab(crossOver.id, h.deps)).toEqual({ status: 'refused', reason: 'tooManyTargets' })
    expect(h.notifications.at(-1)?.severity).toBe('warning')
    expect(h.notifications.at(-1)?.message).toContain('32')
    expect(h.refreshCalls).toHaveLength(0)
    expect(h.dryRunCalls).toHaveLength(0)
    expect(h.multiAskSpy).not.toHaveBeenCalled()
    expect(h.executeMultiCalls).toHaveLength(0)
  })

  it('R4 D3 #1: fails closed ({ status: "cancelled" }) when the 16-turn BigQuery cost-prompt moot loop exhausts turns in 1-target Same-Engine and Cross-Engine', async () => {
    const s1 = sqlConnection(1)
    const b1 = bqConnection(1)
    const h = createHarness({
      connections: [s1, b1],
      dryRuns: { [b1.id]: { ok: true, value: { bytesProcessed: 25 * GiB } } }
    })

    // Always answer moot while threshold remains exceeded -> loop hits 16 turns and MUST fail closed!
    h.singleAskSpy.mockImplementation(async () => ({ run: false, moot: true }))
    h.multiAskSpy.mockImplementation(async () => ({ run: false, moot: true }))

    const sameSingle = h.docs.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      sql: 'SELECT * FROM analytics.events;',
      targets: [{ targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }]
    })
    expect(await executeMultiTab(sameSingle.id, h.deps)).toEqual({ status: 'cancelled' })
    expect(h.singleAskSpy).toHaveBeenCalledTimes(16)
    expect(h.executeMultiCalls).toHaveLength(0)

    const crossTab = h.docs.documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1;',
      bigQuerySql: 'SELECT * FROM analytics.events;',
      targets: [
        { targetId: s1.targetId, connectionId: s1.id, database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: b1.targetId, connectionId: b1.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })
    expect(await executeMultiTab(crossTab.id, h.deps)).toEqual({ status: 'cancelled' })
    expect(h.multiAskSpy).toHaveBeenCalledTimes(16)
    expect(h.executeMultiCalls).toHaveLength(0)
  })
})
