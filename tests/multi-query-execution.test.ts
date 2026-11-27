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
