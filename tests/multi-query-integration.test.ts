import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type * as Monaco from 'monaco-editor'
import type { ConnectionInfo, ConnectionOptions, MultiQueryOptions, MultiTargetOutcome, ProviderConnectionOptions, QueryMultiResult, ResultDescriptor } from '../src/shared/contracts'
import { defaultSettings, type SettingKey, type SettingValue } from '../src/shared/settings/catalog'
import { connectionAccent } from '../src/shared/theme/connection-colors'
import { resolveTheme } from '../src/shared/theme/resolve'
import { SnapshotStore } from '../src/renderer/src/core/store'
import { CommandService } from '../src/renderer/src/core/commands'
import { NotificationService } from '../src/renderer/src/core/notifications'
import { QueryService } from '../src/renderer/src/services/queries'
import { MultiExecutePromptService } from '../src/renderer/src/services/multi-execute'
import { CostPromptService } from '../src/renderer/src/services/bigquery-cost-prompt'
import { costOptOut } from '../src/renderer/src/services/bigquery-cost'
import { ResultsService, summaryEntryKey } from '../src/renderer/src/results/ResultsService'
import { CompareService } from '../src/renderer/src/results/CompareService'
import { ResultsSearchService } from '../src/renderer/src/results/search'
import { PaneService } from '../src/renderer/src/services/panes'
import { MenuTargetService } from '../src/renderer/src/menus/targets'
import { googleSqlLanguageId } from '../src/renderer/src/languages/googlesql'
import { queryContribution } from '../src/renderer/src/contributions/query'
import { explorerContribution } from '../src/renderer/src/contributions/explorer'
import { languagesContribution } from '../src/renderer/src/contributions/languages'
import { outputContribution } from '../src/renderer/src/contributions/output'
import { compareContribution } from '../src/renderer/src/contributions/compare'
import { messagesContribution } from '../src/renderer/src/contributions/messages'
import { canReattachTabOnReconnect, statusBarAppearance } from '../src/renderer/src/App'
import type { DisconnectCoordinator } from '../src/renderer/src/services/disconnect'
import { TestEditor } from './fixtures/documents'
import { fakeDocument, FakeElement } from './fixtures/elements'
import { descriptor, fakeResultClient } from './fixtures/results'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function connectSql(wb: ReturnType<typeof workbenchFixture>, server: string, database = 'SalesDB') {
  const options = { ...connectionOptions, server, database } as ConnectionOptions
  const attempt = wb.connections.beginConnect(options, 1)!
  const info: ConnectionInfo = { ...connectionInfo(crypto.randomUUID(), 1), server, database }
  const auth = { principal: { provider: 'sqlserver' as const, authentication: 'sql' as const, id: `sid:${server}` } }
  wb.connections.accept(info, options, attempt.operation.targetId, auth, attempt)
  return { info, targetId: attempt.operation.targetId }
}

function connectBq(wb: ReturnType<typeof workbenchFixture>, project: string, dataset = 'sales_dw') {
  const options: ProviderConnectionOptions = { provider: 'bigquery', project, dataset, authentication: 'gcloud' }
  const attempt = wb.connections.beginConnect(options, 1)!
  const info: ConnectionInfo = { ...connectionInfo(crypto.randomUUID(), 1), server: project, database: dataset, serverVersion: 'BigQuery', providerId: 'bigquery' }
  const auth = { principal: { provider: 'bigquery' as const, project, principal: `bigquery:${project}@example.com` } }
  wb.connections.accept(info, options, attempt.operation.targetId, auth, attempt)
  return { info, targetId: attempt.operation.targetId }
}

function multiOutcome(targetKey: string, provider: 'sqlserver' | 'bigquery', label: string, resultSetIds: number[] = []): MultiTargetOutcome {
  return {
    targetKey, provider, label, status: 'succeeded',
    batchesCompleted: 1, batchesTotal: 1, rowsAffected: 1, elapsedMs: 12, resultSetIds
  }
}

function multiSummary(mode: QueryMultiResult['mode'], targets: MultiTargetOutcome[], resultSets: ResultDescriptor[] = []): QueryMultiResult {
  return {
    status: 'completed',
    mode,
    elapsedMs: 15,
    targets,
    resultSets,
    discardedResultSets: 0,
    messages: [],
    messagesTruncated: false,
    budget: { generation: 1, seq: 1, usedBytes: 0, globalBytes: 1024 * 1024, queryBytes: 1024 * 1024 },
    completedAt: '2026-11-26T00:00:00Z'
  }
}

class MutableSettings extends SnapshotStore<{ readonly values: typeof defaultSettings }> {
  constructor(overrides: Partial<typeof defaultSettings> = {}) {
    super({ values: { ...defaultSettings, ...overrides } })
  }
  get<K extends SettingKey>(key: K): SettingValue<K> { return this.getSnapshot().values[key] }
  async choose<K extends SettingKey>(key: K, value: SettingValue<K>): Promise<void> {
    this.publish({ values: { ...this.getSnapshot().values, [key]: value } })
  }
  async toggle(): Promise<void> {}
}

describe('Wave 2c: End-to-end contribution & wiring integration', () => {
  it('wires Explorer multi-select commands to open Same-Engine, Cross-Engine tabs, and Disconnect Selected', async () => {
    const wb = workbenchFixture()
    wb.api.push(readyBackend())
    wb.api.explorerChildren.mockImplementation(async () => ({ ok: true as const, value: { nodes: [], elapsedMs: 1, total: 0 } }))

    const sql1 = connectSql(wb, 'prod-sql-01', 'SalesDB')
    const sql2 = connectSql(wb, 'stage-sql-01', 'SalesDB')
    const bq1 = connectBq(wb, 'analytics-prod', 'sales_dw')
    wb.explorer.settle()

    const disconnectMany = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, { status: 'disconnected' as const, closed: [], removed: false }])))
    const disconnectCoordinator = { disconnectMany } as unknown as DisconnectCoordinator
    const commands = new CommandService({ state: () => wb.context.getState() })
    const notifications = new NotificationService()

    const contrib = explorerContribution(
      { commands, documents: wb.documents, connections: wb.connections, explorer: wb.explorer, disconnectCoordinator, notifications },
      wb.api
    )

    expect(commands.isEnabled('explorer.selectAllSqlServers')).toBe(true)
    expect(commands.isEnabled('explorer.newMultiServerQuery')).toBe(false)
    await commands.execute('explorer.selectAllSqlServers', undefined, 'menu')
    expect(wb.explorer.multiSelectedTargets()).toHaveLength(2)
    expect(commands.isEnabled('explorer.newMultiServerQuery')).toBe(true)
    expect(commands.isEnabled('explorer.disconnectSelected')).toBe(true)

    await commands.execute('explorer.newMultiServerQuery', undefined, 'menu')
    const sameTab = wb.documents.active!
    expect(sameTab.multiMode).toBe('same')
    expect(sameTab.multiTargets).toHaveLength(2)
    expect(sameTab.multiTargets!.map(t => t.connectionId)).toEqual([sql1.info.id, sql2.info.id])
    expect(sameTab.multiTargets!.every(t => t.enabled && t.attachWanted)).toBe(true)

    await commands.execute('explorer.newCrossEngineQuery', undefined, 'menu')
    const crossTab = wb.documents.active!
    expect(crossTab.multiMode).toBe('cross')
    expect(crossTab.crossView).toBe('split')
    expect(crossTab.multiTargets!.map(t => t.provider)).toEqual(['sqlserver', 'sqlserver', 'bigquery'])
    expect(crossTab.multiTargets!.map(t => t.connectionId)).toEqual([sql1.info.id, sql2.info.id, bq1.info.id])

    await commands.execute('explorer.disconnectSelected', undefined, 'menu')
    expect(disconnectMany).toHaveBeenCalledWith([sql1.targetId, sql2.targetId])

    contrib.dispose()
    wb.dispose()
  })

  it('branches query.execute on tab.multiMode, never triggers single-server connectsFirst, and forwards per-run stopOnError', async () => {
    const wb = workbenchFixture()
    wb.api.push(readyBackend())
    const sql1 = connectSql(wb, 'prod-sql-01', 'SalesDB')
    const sql2 = connectSql(wb, 'stage-sql-01', 'SalesDB')

    const executeMultiCalls: MultiQueryOptions[] = []
    const multiResult = multiSummary('fireAndForget', [
      multiOutcome(sql1.targetId, 'sqlserver', 'prod-sql-01'),
      multiOutcome(sql2.targetId, 'sqlserver', 'stage-sql-01')
    ])
    const queryApi = {
      execute: vi.fn(),
      executeMulti: vi.fn(async (options: MultiQueryOptions) => {
        executeMultiCalls.push(options)
        return { ok: true as const, value: multiResult }
      }),
      cancel: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } })),
      confirmSessions: vi.fn(async () => ({ ok: true as const, value: 'proceed' as const })),
      querySessionState: vi.fn(async () => ({ ok: true as const, value: { checked: true, transactionCount: 0 } }))
    }
    const settings = new MutableSettings({ 'queryExecution.stopOnError': false })
    const resultsSink = { begin: vi.fn(), finish: vi.fn(async () => {}) }
    const queries = new QueryService(wb.documents, queryApi, id => wb.connections.get(id), wb.events, resultsSink, () => 1000, async () => {}, () => settings.getSnapshot().values)
    const multiExecutePrompts = new MultiExecutePromptService()
    const costPrompts = new CostPromptService()
    const optOut = costOptOut({
      loadConnectionLibrary: vi.fn(async () => ({ ok: false as const, error: 'none' })),
      setBigQueryCostPrompt: vi.fn(async () => ({ ok: true as const, value: true }))
    })
    const notifications = new NotificationService()
    const commands = new CommandService({ state: () => wb.context.getState() })

    const connectRequested = vi.fn()
    wb.events.subscribe(event => { if (event.type === 'query.connectRequested') connectRequested() })

    const contrib = queryContribution(
      {
        commands, queries, documents: wb.documents, connections: wb.connections,
        targets: wb.targets, quickInput: wb.quickInput, events: wb.events,
        backend: wb.backend, settings: settings as never,
        costOptOut: optOut, costPrompts, multiExecutePrompts, notifications
      },
      wb.api
    )

    const tab = wb.documents.openMultiQuery({
      mode: 'same',
      provider: 'sqlserver',
      sql: 'SELECT 1;',
      targets: [
        { targetId: sql1.targetId, connectionId: sql1.info.id, database: 'SalesDB', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: sql2.targetId, connectionId: sql2.info.id, database: 'SalesDB', enabled: true, provider: 'sqlserver', attachWanted: true }
      ]
    })

    const runPromise = commands.execute('query.execute', { tabId: tab.id }, 'toolbar')
    await Promise.resolve()
    const pending = multiExecutePrompts.getSnapshot().pending
    expect(pending).toBeDefined()
    expect(connectRequested).not.toHaveBeenCalled()

    multiExecutePrompts.answer(pending!.id, {
      mode: 'fireAndForget',
      sequential: false,
      preflightDryRun: false,
      stopOnError: true,
      autoCombine: true
    })
    await runPromise

    expect(executeMultiCalls).toHaveLength(1)
    expect(executeMultiCalls[0]!.stopOnError).toBe(true)
    expect(connectRequested).not.toHaveBeenCalled()

    wb.documents.updateMultiTarget(tab.id, 0, { enabled: false })
    wb.documents.updateMultiTarget(tab.id, 1, { enabled: false })
    await commands.execute('query.execute', { tabId: tab.id }, 'toolbar')
    expect(connectRequested).not.toHaveBeenCalled()
    expect(executeMultiCalls).toHaveLength(1)
    expect(notifications.getSnapshot().visible.length).toBeGreaterThan(0)

    contrib.dispose()
    multiExecutePrompts.dispose()
    costPrompts.dispose()
    queries.dispose()
    wb.dispose()
  })

  it('wires output.compare from Summary, pure-DDL Summary commands, and dialect-aware output.revealError', async () => {
    const wb = workbenchFixture()
    wb.api.push(readyBackend())
    const commands = new CommandService({ state: () => wb.context.getState() })
    const settings = new MutableSettings({ 'queryResults.grid.layout': 'tabs' })
    const client = fakeResultClient()
    const panes = new PaneService()
    panes.set({ explorer: true, editor: true, results: true, messages: false, plan: false, statistics: false })
    const results = new ResultsService({ client, api: wb.api, events: wb.events, documents: wb.documents, frame: fn => fn() })
    const compare = new CompareService(results)
    const resultsSearch = new ResultsSearchService({ results })
    const menuTargets = new MenuTargetService()

    const doc = wb.documents.openMultiQuery({
      mode: 'cross',
      targets: [
        { targetId: uuid(201), connectionId: uuid(211), database: 'SalesDB', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: uuid(202), connectionId: uuid(212), database: 'sales_dw', enabled: true, provider: 'bigquery', attachWanted: true }
      ],
      sql: 'SELECT 1 AS Id;',
      bigQuerySql: 'SELECT 1 AS Id\nUNION ALL\nSELECT 2 AS Id;'
    })
    const queries = new QueryService(
      wb.documents,
      { execute: vi.fn(), cancel: vi.fn(), confirmSessions: vi.fn(), querySessionState: vi.fn() } as never,
      () => undefined,
      wb.events,
      results
    )

    const outContrib = outputContribution({ commands, results, queries, menuTargets, documents: wb.documents, settings: settings as never, resultsSearch, panes }, { writeClipboardText: vi.fn(async () => ({ ok: true as const, value: undefined })) })
    const cmpContrib = compareContribution({ commands, compare, results, documents: wb.documents, menuTargets, panes })
    const msgContrib = messagesContribution({ commands, documents: wb.documents, queries, results })

    // 1. Pure-DDL multi-server run (0 result sets, hasMultiSummary === true): output.closeResults enabled, output.closeResult disabled on Summary
    const q1 = uuid(301)
    results.begin(doc.id, q1, undefined, {
      multi: {
        mode: 'fireAndForget',
        targets: [
          { targetKey: 'sql1', connectionId: uuid(211), provider: 'sqlserver', label: 'prod-sql-01', database: 'SalesDB' },
          { targetKey: 'bq1', connectionId: uuid(212), provider: 'bigquery', label: 'analytics-prod', database: 'sales_dw' }
        ]
      }
    })
    await results.finish(doc.id, q1, {
      multiSummary: multiSummary('fireAndForget', [
        multiOutcome('sql1', 'sqlserver', 'prod-sql-01'),
        multiOutcome('bq1', 'bigquery', 'analytics-prod')
      ])
    })
    expect(commands.isEnabled('output.closeResults', { tabId: doc.id })).toBe(true)
    expect(commands.isEnabled('output.closeResult', { tabId: doc.id })).toBe(false)

    // 2. Multi-server SELECT run with two server tables: output.compare opens from Summary auto-selecting SQL Server -> BigQuery
    const q2 = uuid(302)
    const sqlDesc: ResultDescriptor = descriptor(1, { index: 0, targetKey: 'sql1', statementSlot: 0 })
    const bqDesc: ResultDescriptor = descriptor(2, { index: 1, targetKey: 'bq1', statementSlot: 0 })
    results.begin(doc.id, q2, undefined, {
      multi: {
        mode: 'crossEngineReadOnly',
        targets: [
          { targetKey: 'sql1', connectionId: uuid(211), provider: 'sqlserver', label: 'prod-sql-01', database: 'SalesDB' },
          { targetKey: 'bq1', connectionId: uuid(212), provider: 'bigquery', label: 'analytics-prod', database: 'sales_dw' }
        ]
      }
    })
    client.emit(q2, { type: 'resultSet.opened', descriptor: sqlDesc })
    client.emit(q2, { type: 'resultSet.closed', descriptor: sqlDesc })
    client.emit(q2, { type: 'resultSet.opened', descriptor: bqDesc })
    client.emit(q2, { type: 'resultSet.closed', descriptor: bqDesc })
    await results.finish(doc.id, q2, {
      multiSummary: multiSummary('crossEngineReadOnly', [
        multiOutcome('sql1', 'sqlserver', 'prod-sql-01', [1]),
        multiOutcome('bq1', 'bigquery', 'analytics-prod', [2])
      ], [sqlDesc, bqDesc])
    })
    results.focusEntry(doc.id, summaryEntryKey)
    expect(commands.isEnabled('output.compare', { tabId: doc.id })).toBe(true)
    await commands.execute('output.compare', { tabId: doc.id }, 'toolbar')
    const picker = compare.getSnapshot().pickers[doc.id]
    expect(picker).toBeDefined()
    expect(picker!.exact).toBe(true)

    // 3. output.revealError threads entry.dialect ('bigquery') into sourceLine + revealLine, switching activePane to 'secondary'
    queries.refuseReadOnly(doc.id, [{ line: 3, column: 1, message: 'BigQuery violation', dialect: 'bigquery' }])
    await Promise.resolve()
    const run = results.getSnapshot()[doc.id]!
    expect(run.messages[0]?.dialect).toBe('bigquery')
    wb.documents.setActivePane(doc.id, 'primary')
    expect(wb.documents.get(doc.id)?.activePane).toBe('primary')
    const msgArgs = { tabId: doc.id, message: { queryId: run.queryId, index: 0, line: 3 } }
    expect(commands.isEnabled('output.revealError', msgArgs)).toBe(true)
    await commands.execute('output.revealError', msgArgs, 'menu')
    expect(wb.documents.get(doc.id)?.activePane).toBe('secondary')

    outContrib.dispose()
    cmpContrib.dispose()
    msgContrib.dispose()
    compare.dispose()
    results.dispose()
    queries.dispose()
    wb.dispose()
  })

  it('enables Go To Definition and editor context menu on the secondary GoogleSQL pane via ownsModel and editorContaining', () => {
    const wb = workbenchFixture()
    wb.api.push(readyBackend())
    const commands = new CommandService({ state: () => wb.context.getState() })
    const doc = wb.documents.openMultiQuery({
      mode: 'cross',
      targets: [
        { targetId: uuid(401), connectionId: uuid(411), database: 'SalesDB', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: uuid(402), connectionId: uuid(412), database: 'sales_dw', enabled: true, provider: 'bigquery', attachWanted: true }
      ],
      sql: 'SELECT 1;',
      bigQuerySql: 'SELECT * FROM sales_dw.orders;'
    })
    const secondaryModel = wb.documents.getSecondaryModel(doc.id)!
    expect(secondaryModel.getLanguageId()).toBe(googleSqlLanguageId)

    const fakeDoc = fakeDocument()
    const secContainer = new FakeElement(fakeDoc, 'div')
    const secChild = new FakeElement(fakeDoc, 'div')
    secContainer.append(secChild)
    const secEditor = new TestEditor()
    const focusSpy = vi.fn()
    Object.assign(secEditor, {
      getId: () => 'sec-editor',
      getContainerDomNode: () => secContainer.dom,
      hasWidgetFocus: () => true,
      hasTextFocus: () => true,
      getPosition: () => ({ lineNumber: 1, column: 20 }),
      focus: focusSpy
    })
    const bindSec = wb.documents.bindSecondaryEditor(secEditor as unknown as Monaco.editor.IStandaloneCodeEditor, doc.id)

    const langContrib = languagesContribution({
      commands,
      documents: wb.documents,
      connections: wb.connections,
      sqlLanguage: { refreshCache: vi.fn(async () => true) },
      monaco: { editor: { getEditors: () => [secEditor as unknown as Monaco.editor.IStandaloneCodeEditor] } }
    })
    expect(commands.isEnabled('edit.goToDefinition')).toBe(true)
    expect(commands.isEnabled('edit.peekDefinition')).toBe(true)

    const menuTargets = new MenuTargetService({
      editor: element => {
        const hit = element ? wb.documents.editorContaining(element) : undefined
        const editor = hit?.editor ?? wb.documents.boundEditor
        const tabId = hit?.tabId ?? wb.documents.getSnapshot().activeId
        return editor && tabId ? { container: editor.getContainerDomNode(), tabId, focus: () => editor.focus() } : undefined
      }
    })
    const hit = menuTargets.targetFor(secChild.dom)
    expect(hit?.target).toEqual({ kind: 'editor', tabId: doc.id })
    hit?.onFocus?.()
    expect(focusSpy).toHaveBeenCalledTimes(1)

    langContrib.dispose()
    bindSec.dispose()
    wb.dispose()
  })

  it('tracks in-flight multi execution in queryContribution (blocks double-F5, aborts on cancel, close, and dispose) and guards single-server plan/stats commands on multi tabs', async () => {
    const wb = workbenchFixture()
    wb.api.push(readyBackend())
    const sql1 = connectSql(wb, 'prod-sql-01', 'SalesDB')
    const sql2 = connectSql(wb, 'stage-sql-01', 'SalesDB')

    const estimateMock = vi.fn(async () => ({ ok: true as const, value: { plans: [], database: 'SalesDB' } }))
    const queryApi = {
      execute: vi.fn(),
      executeMulti: vi.fn(async () => ({
        ok: true as const,
        value: multiSummary('fireAndForget', [
          multiOutcome(sql1.targetId, 'sqlserver', 'prod-sql-01'),
          multiOutcome(sql2.targetId, 'sqlserver', 'stage-sql-01')
        ])
      })),
      estimatePlan: estimateMock,
      cancel: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } })),
      confirmSessions: vi.fn(async () => ({ ok: true as const, value: 'proceed' as const })),
      querySessionState: vi.fn(async () => ({ ok: true as const, value: { checked: true, transactionCount: 0 } }))
    }
    const settings = new MutableSettings()
    const resultsSink = { begin: vi.fn(), finish: vi.fn(async () => {}) }
    const queries = new QueryService(wb.documents, queryApi, id => wb.connections.get(id), wb.events, resultsSink, () => 1000, async () => {}, () => settings.getSnapshot().values)
    const multiExecutePrompts = new MultiExecutePromptService()
    const costPrompts = new CostPromptService()
    const optOut = costOptOut({
      loadConnectionLibrary: vi.fn(async () => ({ ok: false as const, error: 'none' })),
      setBigQueryCostPrompt: vi.fn(async () => ({ ok: true as const, value: true }))
    })
    const notifications = new NotificationService()
    const commands = new CommandService({ state: () => wb.context.getState() })

    const contrib = queryContribution(
      {
        commands, queries, documents: wb.documents, connections: wb.connections,
        targets: wb.targets, quickInput: wb.quickInput, events: wb.events,
        backend: wb.backend, settings: settings as never,
        costOptOut: optOut, costPrompts, multiExecutePrompts, notifications
      },
      wb.api
    )

    // Connected single-server tab is active so catalog active-tab preconditions pass;
    // split-group or API calls targeting multiTab by tabId must still be rejected.
    const multiTab = wb.documents.openMultiQuery({
      mode: 'same',
      provider: 'sqlserver',
      sql: 'SELECT 1;',
      targets: [
        { targetId: sql1.targetId, connectionId: sql1.info.id, database: 'SalesDB', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: sql2.targetId, connectionId: sql2.info.id, database: 'SalesDB', enabled: true, provider: 'sqlserver', attachWanted: true }
      ]
    })
    const singleTab = wb.documents.newQuery('SELECT 1;', undefined, sql1.info.id, 'SalesDB')
    expect(wb.documents.active?.id).toBe(singleTab.id)

    for (const id of ['query.estimatePlan', 'query.estimateSessionPlan', 'query.includeActualPlan', 'query.includeLivePlan', 'query.includeClientStatistics'] as const) {
      expect(commands.isEnabled(id, { tabId: multiTab.id }), id).toBe(false)
      await commands.execute(id, { tabId: multiTab.id }, 'toolbar')
    }
    expect(estimateMock).not.toHaveBeenCalled()
    expect(wb.documents.get(multiTab.id)?.includeActualPlan).toBeFalsy()
    expect(wb.documents.get(multiTab.id)?.includeLivePlan).toBeFalsy()
    expect(wb.documents.get(multiTab.id)?.includeClientStatistics).toBeFalsy()

    // In-flight multi-execute blocks re-entry until cancelled or settled.
    wb.documents.activate(multiTab.id)
    expect(commands.isEnabled('query.execute', { tabId: multiTab.id })).toBe(true)
    const run1 = commands.execute('query.execute', { tabId: multiTab.id }, 'toolbar')
    await Promise.resolve()
    expect(multiExecutePrompts.getSnapshot().pending).toBeDefined()
    expect(commands.isEnabled('query.execute', { tabId: multiTab.id })).toBe(false)

    // Second F5 while in-flight is blocked (no second prompt queued).
    await commands.execute('query.execute', { tabId: multiTab.id }, 'toolbar')
    const firstPendingId = multiExecutePrompts.getSnapshot().pending!.id

    // query.cancel aborts the in-flight AbortController and dismisses the pending prompt.
    await commands.run('query.cancel', { tabId: multiTab.id })
    await run1
    expect(multiExecutePrompts.getSnapshot().pending).toBeUndefined()
    expect(commands.isEnabled('query.execute', { tabId: multiTab.id })).toBe(true)

    // Closing the tab aborts an in-flight multi-execute prompt.
    const run2 = commands.execute('query.execute', { tabId: multiTab.id }, 'toolbar')
    await Promise.resolve()
    expect(multiExecutePrompts.getSnapshot().pending?.id).not.toBe(firstPendingId)
    wb.events.emit({ type: 'documents.closed', tabId: multiTab.id })
    await run2
    expect(multiExecutePrompts.getSnapshot().pending).toBeUndefined()

    // Disposing queryContribution aborts any remaining in-flight prompt.
    const run3 = commands.execute('query.execute', { tabId: multiTab.id }, 'toolbar')
    await Promise.resolve()
    expect(multiExecutePrompts.getSnapshot().pending).toBeDefined()
    contrib.dispose()
    await run3
    expect(multiExecutePrompts.getSnapshot().pending).toBeUndefined()

    multiExecutePrompts.dispose()
    costPrompts.dispose()
    queries.dispose()
    wb.dispose()
  })

  it('caps Cross-Engine seeding at 31 primary-engine servers when opposite engine is live, and gates explorer.disconnectSelected on >= 2 targets', async () => {
    const wb = workbenchFixture()
    wb.api.push(readyBackend())
    wb.api.explorerChildren.mockImplementation(async () => ({ ok: true as const, value: { nodes: [], elapsedMs: 1, total: 0 } }))

    for (let i = 1; i <= 32; i++) connectSql(wb, `sql-node-${String(i).padStart(2, '0')}`, 'SalesDB')
    const bq1 = connectBq(wb, 'bq-proj-01', 'sales_dw')
    const bq2 = connectBq(wb, 'bq-proj-02', 'sales_dw')
    wb.explorer.settle()

    const disconnectMany = vi.fn(async () => new Map())
    const disconnectCoordinator = { disconnectMany } as unknown as DisconnectCoordinator
    const commands = new CommandService({ state: () => wb.context.getState() })
    const contrib = explorerContribution(
      { commands, documents: wb.documents, connections: wb.connections, explorer: wb.explorer, disconnectCoordinator },
      wb.api
    )

    // Single multi-selected server: disconnectSelected must be disabled (< 2).
    const firstSqlRoot = wb.explorer.rootIds.find(id => wb.explorer.serverProvider(id) === 'sqlserver')!
    wb.explorer.toggleMultiSelect(firstSqlRoot)
    expect(wb.explorer.multiSelectedTargets()).toHaveLength(1)
    expect(commands.isEnabled('explorer.disconnectSelected')).toBe(false)

    // Select all 32 SQL Servers: disconnectSelected enabled, and newCrossEngineQuery reserves room for BigQuery.
    await commands.execute('explorer.selectAllSqlServers', undefined, 'menu')
    expect(wb.explorer.multiSelectedTargets()).toHaveLength(32)
    expect(commands.isEnabled('explorer.disconnectSelected')).toBe(true)

    await commands.execute('explorer.newCrossEngineQuery', undefined, 'menu')
    const crossTab = wb.documents.active!
    expect(crossTab.multiMode).toBe('cross')
    expect(crossTab.multiTargets).toHaveLength(32)
    expect(crossTab.multiTargets!.filter(t => t.provider === 'sqlserver')).toHaveLength(31)
    const bqTargets = crossTab.multiTargets!.filter(t => t.provider === 'bigquery')
    expect(bqTargets).toHaveLength(1)
    expect([bq1.info.id, bq2.info.id]).toContain(bqTargets[0]!.connectionId)

    contrib.dispose()
    wb.dispose()
  })

  it('gates output.saveResultsAs while Summary is focused, defaults Cross-Engine output.compareWithPrevious to exact text, and emits query.outputSelected on refuseReadOnly', async () => {
    const wb = workbenchFixture()
    wb.api.push(readyBackend())
    const commands = new CommandService({ state: () => wb.context.getState() })
    const settings = new MutableSettings({ 'queryResults.grid.layout': 'tabs' })
    const client = fakeResultClient()
    const panes = new PaneService()
    panes.set({ explorer: true, editor: true, results: true, messages: false, plan: false, statistics: false })
    const results = new ResultsService({ client, api: wb.api, events: wb.events, documents: wb.documents, frame: fn => fn() })
    const compare = new CompareService(results)
    const resultsSearch = new ResultsSearchService({ results })
    const menuTargets = new MenuTargetService()

    const doc = wb.documents.openMultiQuery({
      mode: 'cross',
      targets: [
        { targetId: uuid(501), connectionId: uuid(511), database: 'SalesDB', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: uuid(502), connectionId: uuid(512), database: 'sales_dw', enabled: true, provider: 'bigquery', attachWanted: true }
      ],
      sql: 'SELECT 1 AS Id;',
      bigQuerySql: 'SELECT 1 AS Id;'
    })
    const queries = new QueryService(
      wb.documents,
      { execute: vi.fn(), cancel: vi.fn(), confirmSessions: vi.fn(), querySessionState: vi.fn() } as never,
      () => undefined,
      wb.events,
      results
    )

    const outContrib = outputContribution({ commands, results, queries, menuTargets, documents: wb.documents, settings: settings as never, resultsSearch, panes }, { writeClipboardText: vi.fn(async () => ({ ok: true as const, value: undefined })) })
    const cmpContrib = compareContribution({ commands, compare, results, documents: wb.documents, menuTargets, panes })

    const q1 = uuid(601)
    const sqlDesc: ResultDescriptor = descriptor(1, { index: 0, targetKey: 'sql1', statementSlot: 0 })
    const bqDesc: ResultDescriptor = descriptor(2, { index: 1, targetKey: 'bq1', statementSlot: 0 })
    results.begin(doc.id, q1, undefined, {
      multi: {
        mode: 'crossEngineReadOnly',
        targets: [
          { targetKey: 'sql1', connectionId: uuid(511), provider: 'sqlserver', label: 'prod-sql-01', database: 'SalesDB' },
          { targetKey: 'bq1', connectionId: uuid(512), provider: 'bigquery', label: 'analytics-prod', database: 'sales_dw' }
        ]
      }
    })
    client.emit(q1, { type: 'resultSet.opened', descriptor: sqlDesc })
    client.emit(q1, { type: 'resultSet.closed', descriptor: sqlDesc })
    client.emit(q1, { type: 'resultSet.opened', descriptor: bqDesc })
    client.emit(q1, { type: 'resultSet.closed', descriptor: bqDesc })
    await results.finish(doc.id, q1, {
      multiSummary: multiSummary('crossEngineReadOnly', [
        multiOutcome('sql1', 'sqlserver', 'prod-sql-01', [1]),
        multiOutcome('bq1', 'bigquery', 'analytics-prod', [2])
      ], [sqlDesc, bqDesc])
    })

    const sets = results.getSnapshot()[doc.id]!.sets
    const sqlKey = sets[0]!.key
    const bqKey = sets[1]!.key

    // Finding 6: while Summary is focused, non-grid output.saveResultsAs is disabled, but explicit grid target remains enabled.
    results.focusEntry(doc.id, summaryEntryKey)
    expect(commands.isEnabled('output.saveResultsAs', { tabId: doc.id })).toBe(false)
    expect(commands.isEnabled('output.saveResultsAs')).toBe(false)
    expect(commands.isEnabled('output.saveResultsAs', { target: { kind: 'output', view: 'grid', tabId: doc.id, entry: sqlKey, element: new FakeElement(fakeDocument(), 'div').dom, selectedText: '' } })).toBe(true)

    // Focusing a real result grid enables output.saveResultsAs again.
    results.focusEntry(doc.id, bqKey)
    expect(commands.isEnabled('output.saveResultsAs', { tabId: doc.id })).toBe(true)

    // Finding 10: output.compareWithPrevious omits explicit exact: false so Cross-Engine pairs default to exact: true.
    const compareSpy = vi.spyOn(compare, 'compare')
    expect(commands.isEnabled('output.compareWithPrevious', { tabId: doc.id })).toBe(true)
    await commands.execute('output.compareWithPrevious', { tabId: doc.id }, 'toolbar')
    expect(compareSpy).toHaveBeenCalledWith(doc.id, bqKey, {})

    // Finding 2: refuseReadOnly emits query.outputSelected for 'messages' so App reveals Messages even if Ctrl+R hid output.
    const selectedViews: { tabId: string; view: string }[] = []
    const sub = wb.events.subscribe(event => {
      if (event.type === 'query.outputSelected') selectedViews.push({ tabId: event.tabId, view: event.view })
    })
    queries.refuseReadOnly(doc.id, [{ line: 1, column: 1, message: 'Write blocked', dialect: 'sqlserver' }])
    expect(selectedViews).toContainEqual({ tabId: doc.id, view: 'messages' })
    sub.dispose()

    outContrib.dispose()
    cmpContrib.dispose()
    compare.dispose()
    results.dispose()
    queries.dispose()
    wb.dispose()
  })

  it('computes App default status bar multi-target accent & PROD tag and guards reconnect against multi-mode or undefined targetId', () => {
    const wb = workbenchFixture()
    const prodSql = connectSql(wb, 'prod-sql-01', 'SalesDB')
    const stageSql = connectSql(wb, 'stage-sql-01', 'SalesDB')
    const bq = connectBq(wb, 'analytics-bq', 'sales_dw')

    wb.connections.setDetails(prodSql.info.id, { environment: 'Production', color: '#d97706', autoReconnect: 'inherit' })
    wb.connections.setDetails(stageSql.info.id, { environment: 'Staging', color: '#2563eb', autoReconnect: 'inherit' })
    const allConns = wb.connections.getSnapshot()
    const allTargets = wb.targets.getSnapshot()

    // Finding 5: PROD target wins (uses its color, or 'red' fallback) + renders Production status tag.
    const prodMulti = statusBarAppearance(
      {
        multiMode: 'same',
        multiTargets: [
          { targetId: stageSql.targetId, connectionId: stageSql.info.id, database: 'SalesDB', enabled: true, provider: 'sqlserver' },
          { targetId: prodSql.targetId, connectionId: prodSql.info.id, database: 'SalesDB', enabled: true, provider: 'sqlserver' }
        ]
      },
      undefined,
      allConns,
      allTargets
    )
    expect(prodMulti).toEqual({ accentColor: '#d97706', environment: 'Production', environmentAbout: '1 Production target' })

    const darkTheme = resolveTheme([], 'dark').theme

    // PROD without explicit color falls back to stored red preset hex ('#e66b73') so connectionAccent resolves it.
    wb.connections.setDetails(prodSql.info.id, { environment: 'Production', autoReconnect: 'inherit' })
    const prodDefaultRed = statusBarAppearance(
      {
        multiMode: 'cross',
        multiTargets: [
          { targetId: prodSql.targetId, connectionId: prodSql.info.id, database: 'SalesDB', enabled: true, provider: 'sqlserver' },
          { targetId: bq.targetId, connectionId: bq.info.id, database: 'sales_dw', enabled: true, provider: 'bigquery' }
        ]
      },
      undefined,
      wb.connections.getSnapshot(),
      wb.targets.getSnapshot()
    )
    expect(prodDefaultRed).toEqual({ accentColor: '#e66b73', environment: 'Production', environmentAbout: '1 Production target' })
    expect(connectionAccent(prodDefaultRed.accentColor, darkTheme)).toBe('var(--varia-connection-red)')

    // Cross-Engine without enabled PROD target gets stored purple preset hex ('#ad8bd8') and no environment tag (disabled PROD is ignored).
    const crossNoProd = statusBarAppearance(
      {
        multiMode: 'cross',
        multiTargets: [
          { targetId: prodSql.targetId, connectionId: prodSql.info.id, database: 'SalesDB', enabled: false, provider: 'sqlserver' },
          { targetId: stageSql.targetId, connectionId: stageSql.info.id, database: 'SalesDB', enabled: true, provider: 'sqlserver' },
          { targetId: bq.targetId, connectionId: bq.info.id, database: 'sales_dw', enabled: true, provider: 'bigquery' }
        ]
      },
      undefined,
      wb.connections.getSnapshot(),
      wb.targets.getSnapshot()
    )
    expect(crossNoProd).toEqual({ accentColor: '#ad8bd8', environment: undefined, environmentAbout: undefined })
    expect(connectionAccent(crossNoProd.accentColor, darkTheme)).toBe('var(--varia-connection-purple)')

    // Same-Engine without PROD falls back to first colored enabled target.
    const sameColored = statusBarAppearance(
      {
        multiMode: 'same',
        multiTargets: [
          { targetId: stageSql.targetId, connectionId: stageSql.info.id, database: 'SalesDB', enabled: true, provider: 'sqlserver' }
        ]
      },
      undefined,
      wb.connections.getSnapshot(),
      wb.targets.getSnapshot()
    )
    expect(sameColored).toEqual({ accentColor: '#2563eb', environment: undefined, environmentAbout: undefined })

    // Finding 9: reconnect guard rejects multi-server tabs and undefined targetIds.
    expect(canReattachTabOnReconnect({ targetId: prodSql.targetId }, { targetId: prodSql.targetId })).toBe(true)
    expect(canReattachTabOnReconnect({ multiMode: 'same', targetId: prodSql.targetId }, { targetId: prodSql.targetId })).toBe(false)
    expect(canReattachTabOnReconnect({ multiMode: 'cross', targetId: undefined }, { targetId: undefined })).toBe(false)
    expect(canReattachTabOnReconnect({ targetId: undefined }, { targetId: undefined })).toBe(false)
    expect(canReattachTabOnReconnect({ targetId: prodSql.targetId, kind: 'activityMonitor' }, { targetId: prodSql.targetId })).toBe(false)

    wb.dispose()
  })

  it('R2 Finding 10: query.execute on multi tabs activates reactive pre-dispatch gate (queryRunning=true without bumping executionVersion) and hands off cleanly to executeMulti or cancels cleanly', async () => {
    const wb = workbenchFixture()
    wb.api.push(readyBackend())
    const bq1 = connectBq(wb, 'bq-proj-1', 'sales_dw')

    let resolveDryRun!: (value: { ok: true; value: { bytesProcessed: number } }) => void
    const dryRunPromise = new Promise<{ ok: true; value: { bytesProcessed: number } }>(resolve => { resolveDryRun = resolve })
    const bigQueryDryRun = vi.fn(() => dryRunPromise)
    const executeMulti = vi.fn(async () => ({
      ok: true as const,
      value: multiSummary('fireAndForget', [multiOutcome(bq1.targetId, 'bigquery', 'bq-proj-1')])
    }))
    const queryApi = {
      execute: vi.fn(),
      executeMulti,
      cancel: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } })),
      confirmSessions: vi.fn(async () => ({ ok: true as const, value: 'proceed' as const })),
      querySessionState: vi.fn(async () => ({ ok: true as const, value: { checked: true, transactionCount: 0 } }))
    }
    const settings = new MutableSettings()
    const resultsSink = { begin: vi.fn(), finish: vi.fn(async () => {}) }
    const queries = new QueryService(wb.documents, queryApi, id => wb.connections.get(id), wb.events, resultsSink, () => 1000, async () => {}, () => settings.getSnapshot().values)
    const multiExecutePrompts = new MultiExecutePromptService()
    const costPrompts = new CostPromptService()
    const optOut = costOptOut({
      loadConnectionLibrary: vi.fn(async () => ({ ok: false as const, error: 'none' })),
      setBigQueryCostPrompt: vi.fn(async () => ({ ok: true as const, value: true }))
    })
    const notifications = new NotificationService()
    const commands = new CommandService({ state: () => ({ ...wb.context.getState(), queryRunning: !!wb.documents.active && queries.isRunning(wb.documents.active.id) }) })

    const contrib = queryContribution(
      {
        commands, queries, documents: wb.documents, connections: wb.connections,
        targets: wb.targets, quickInput: wb.quickInput, events: wb.events,
        backend: wb.backend, settings: settings as never,
        costOptOut: optOut, costPrompts, multiExecutePrompts, notifications
      },
      { ...wb.api, bigQueryDryRun }
    )

    const tab = wb.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      sql: 'SELECT 1;',
      targets: [{ targetId: bq1.targetId, connectionId: bq1.info.id, database: 'sales_dw', enabled: true, provider: 'bigquery', attachWanted: true }]
    })

    // Start 1-target BigQuery execution: while dry-run is pending, reactive gate sets isRunning + isGated without bumping executionVersion!
    const run1 = commands.execute('query.execute', { tabId: tab.id }, 'toolbar')
    expect(queries.isRunning(tab.id)).toBe(true)
    expect(queries.isGated(tab.id)).toBe(true)
    expect(queries.getSnapshot()[tab.id]?.running?.gated).toBe(true)
    expect(queries.executionVersion(tab.id)).toBe(0)

    // Cancelling via query.cancel stops the gate locally (zero backend cancel IPC) and aborts pre-dispatch dry-run.
    await commands.run('query.cancel', { tabId: tab.id })
    expect(queries.isRunning(tab.id)).toBe(false)
    expect(queries.isGated(tab.id)).toBe(false)
    expect(queryApi.cancel).not.toHaveBeenCalled()
    resolveDryRun({ ok: true, value: { bytesProcessed: 128 } })
    await run1
    expect(executeMulti).not.toHaveBeenCalled()

    // Second run completes dry-run and hands off seamlessly from gate to real executeMulti!
    bigQueryDryRun.mockImplementationOnce(async () => ({ ok: true, value: { bytesProcessed: 128 } }))
    await commands.execute('query.execute', { tabId: tab.id }, 'toolbar')
    expect(executeMulti).toHaveBeenCalledTimes(1)
    expect(queries.executionVersion(tab.id)).toBe(1)
    expect(queries.isRunning(tab.id)).toBe(false)

    contrib.dispose()
    multiExecutePrompts.dispose()
    costPrompts.dispose()
    queries.dispose()
    wb.dispose()
  })

  it('R2 Finding 14: disconnectSelected prioritizes error over warning, and multi-select commands emit keyed engineLock / cap notices', async () => {
    const wb = workbenchFixture()
    wb.api.push(readyBackend())
    wb.api.explorerChildren.mockImplementation(async () => ({ ok: true as const, value: { nodes: [], elapsedMs: 1, total: 0 } }))

    for (let i = 1; i <= 33; i++) connectSql(wb, `sql-cap-${String(i).padStart(2, '0')}`, 'SalesDB')
    const bq1 = connectBq(wb, 'bq-cap-01', 'sales_dw')
    wb.explorer.settle()

    const outcomes = new Map<string, { status: 'disconnected'; warning?: string } | { status: 'failed'; error: string }>([
      ['t1', { status: 'disconnected', warning: 'A session note warning.' }],
      ['t2', { status: 'failed', error: 'Disconnect failed fatally.' }]
    ])
    const disconnectCoordinator = { disconnectMany: vi.fn(async () => outcomes) } as unknown as DisconnectCoordinator
    const commands = new CommandService({ state: () => wb.context.getState() })
    const notifications = new NotificationService()
    const reportError = vi.spyOn(commands, 'reportError')
    const reportWarning = vi.spyOn(commands, 'reportWarning')

    const contrib = explorerContribution(
      { commands, documents: wb.documents, connections: wb.connections, explorer: wb.explorer, disconnectCoordinator, notifications },
      wb.api
    )

    // 1. selectAllSqlServers with 33 servers surfaces the 32-server cap notice as a keyed toast!
    await commands.execute('explorer.selectAllSqlServers', undefined, 'menu')
    expect(wb.explorer.multiSelectedTargets()).toHaveLength(32)
    expect(notifications.getSnapshot().visible).toEqual([
      expect.objectContaining({ severity: 'info', key: 'explorer.multiSelect.engineLock', message: expect.stringContaining('32') })
    ])

    // 2. toggleMultiSelect on incompatible BigQuery node replaces the keyed toast instead of stacking.
    const bqRootId = wb.explorer.rootIds.find(id => wb.explorer.node(id)?.connectionId === bq1.info.id)!
    const bqMenuNode = wb.explorer.menuNode(bqRootId)!
    await commands.execute('explorer.toggleMultiSelect', { target: { kind: 'explorer', node: bqMenuNode } }, 'menu')
    expect(notifications.getSnapshot().visible).toHaveLength(1)
    expect(notifications.getSnapshot().visible[0]).toMatchObject({ key: 'explorer.multiSelect.engineLock' })

    // 3. disconnectSelected scans all outcomes and reports error via reportError even when a warning appeared earlier.
    await commands.execute('explorer.disconnectSelected', undefined, 'menu')
    expect(reportError).toHaveBeenCalledWith('Disconnect failed fatally.')
    expect(reportWarning).not.toHaveBeenCalled()

    // 4. When only warnings exist, disconnectSelected falls back to reportWarning.
    reportError.mockClear()
    outcomes.delete('t2')
    await commands.execute('explorer.disconnectSelected', undefined, 'menu')
    expect(reportError).not.toHaveBeenCalled()
    expect(reportWarning).toHaveBeenCalledWith('A session note warning.')

    contrib.dispose()
    wb.dispose()
  })

  it('R4 D3 #2: explorer.newMultiServerQuery caps > 32 selected targets to 32 and emits an info notification', async () => {
    const wb = workbenchFixture()
    wb.api.push(readyBackend())
    wb.api.explorerChildren.mockImplementation(async () => ({ ok: true as const, value: { nodes: [], elapsedMs: 1, total: 0 } }))
    connectSql(wb, 'sql-seed-01', 'SalesDB')
    connectSql(wb, 'sql-seed-02', 'SalesDB')
    wb.explorer.settle()
    wb.explorer.selectAllServersByProvider('sqlserver')

    const fakeTargets = Array.from({ length: 35 }, (_, i) => ({
      rowId: i + 1,
      targetId: uuid(1000 + i),
      connectionId: uuid(2000 + i),
      database: 'SalesDB',
      provider: 'sqlserver' as const,
      label: `sql-over-${String(i + 1).padStart(2, '0')}`
    }))
    vi.spyOn(wb.explorer, 'multiSelectedTargets').mockReturnValue(fakeTargets)

    const commands = new CommandService({ state: () => wb.context.getState() })
    const notifications = new NotificationService()
    const contrib = explorerContribution(
      { commands, documents: wb.documents, connections: wb.connections, explorer: wb.explorer, notifications },
      wb.api
    )

    await commands.execute('explorer.newMultiServerQuery', undefined, 'menu')
    const opened = wb.documents.active!
    expect(opened.multiMode).toBe('same')
    expect(opened.multiTargets).toHaveLength(32)
    expect(opened.multiTargets!.map(t => t.connectionId)).toEqual(fakeTargets.slice(0, 32).map(t => t.connectionId))
    expect(notifications.getSnapshot().visible).toEqual([
      expect.objectContaining({ severity: 'info', message: expect.stringContaining('32') })
    ])

    contrib.dispose()
    wb.dispose()
  })

  it('R6 #3 & #4 & #7: output.find is disabled while Summary is active in Tabs layout, workbench wires DocumentService.isLive and ResultsService.layout', async () => {
    const wb = workbenchFixture()
    const sql1 = connectSql(wb, 'prod-sql-01', 'SalesDB')
    const sql2 = connectSql(wb, 'prod-sql-02', 'SalesDB')
    const doc = wb.documents.openMultiQuery({
      mode: 'same',
      name: 'R6Find.sql',
      targets: [
        { targetId: sql1.targetId, connectionId: sql1.info.id, database: 'SalesDB', enabled: true, provider: 'sqlserver' },
        { targetId: sql2.targetId, connectionId: sql2.info.id, database: 'SalesDB', enabled: true, provider: 'sqlserver' }
      ]
    })
    wb.documents.activate(doc.id)

    const client = fakeResultClient()
    const settingsStore = new SnapshotStore({
      values: { ...defaultSettings, 'queryResults.grid.layout': 'tabs' as 'stacked' | 'tabs' }
    })
    const results = new ResultsService({
      client,
      api: wb.api,
      events: wb.events,
      documents: wb.documents,
      frame: cb => cb(),
      layout: () => settingsStore.getSnapshot().values['queryResults.grid.layout'],
      onLayoutChange: listener => settingsStore.subscribe(listener)
    })
    const queries = new QueryService(wb.documents, wb.api, id => wb.connections.get(id), wb.events, results)
    const resultsSearch = new ResultsSearchService({ results })
    const focusSpy = vi.spyOn(resultsSearch, 'focus')
    const panes = new PaneService()
    const menuTargets = new MenuTargetService()
    const commands = new CommandService({ state: () => wb.context.getState() })
    const settings = {
      getSnapshot: () => settingsStore.getSnapshot(),
      subscribe: (l: () => void) => settingsStore.subscribe(l),
      choose: vi.fn(async () => true),
      toggle: vi.fn(async () => true)
    }
    const outContrib = outputContribution(
      { commands, results, queries, menuTargets, documents: wb.documents, settings: settings as unknown as typeof wb.settings, resultsSearch, panes },
      wb.api
    )

    const q1 = uuid(901)
    const sqlDesc = descriptor(1, { targetKey: 'sql1', statementSlot: 0 })
    results.begin(doc.id, q1, undefined, {
      multi: {
        mode: 'fireAndForget',
        targets: [
          { targetKey: 'sql1', connectionId: sql1.info.id, provider: 'sqlserver', label: 'prod-sql-01', database: 'SalesDB' },
          { targetKey: 'sql2', connectionId: sql2.info.id, provider: 'sqlserver', label: 'prod-sql-02', database: 'SalesDB' }
        ]
      }
    })
    client.emit(q1, { type: 'resultSet.opened', descriptor: sqlDesc })
    client.emit(q1, { type: 'resultSet.closed', descriptor: sqlDesc })
    await results.finish(doc.id, q1, {
      multiSummary: multiSummary('fireAndForget', [
        multiOutcome('sql1', 'sqlserver', 'prod-sql-01', [1]),
        multiOutcome('sql2', 'sqlserver', 'prod-sql-02', [])
      ], [sqlDesc])
    })

    const sqlKey = results.getSnapshot()[doc.id]!.sets[0]!.key

    // R6 #3: While Summary is active in Tabs layout, output.find is disabled and running it does not focus search.
    results.focusEntry(doc.id, summaryEntryKey)
    expect(commands.isEnabled('output.find', { tabId: doc.id })).toBe(false)
    await commands.execute('output.find', { tabId: doc.id }, 'toolbar')
    expect(focusSpy).not.toHaveBeenCalled()

    // Focusing a real grid enables output.find and focuses resultsSearch.
    results.focusEntry(doc.id, sqlKey)
    expect(commands.isEnabled('output.find', { tabId: doc.id })).toBe(true)
    await commands.execute('output.find', { tabId: doc.id }, 'toolbar')
    expect(focusSpy).toHaveBeenCalledWith(doc.id)

    // In Stacked layout, Summary is a collapsible band above grids, so output.find stays enabled even if activeSummary was true,
    // AND R6 #7: 1-set multi-server run is steppable in Tabs (Summary + Server 1) but NOT in Stacked (only 1 grid).
    expect(results.steppable.getSnapshot()[doc.id]).toBe(true)
    results.focusEntry(doc.id, summaryEntryKey)
    settingsStore['publish']({ values: { ...defaultSettings, 'queryResults.grid.layout': 'stacked' } })
    expect(results.steppable.getSnapshot()[doc.id]).toBeUndefined()
    expect(commands.isEnabled('output.find', { tabId: doc.id })).toBe(true)

    // R6 #4: workbench.ts wires `isLive: id => connections.isLive(id)` on DocumentService and `layout` + `onLayoutChange` on ResultsService.
    const workbenchSrc = readFileSync('src/renderer/src/core/workbench.ts', 'utf8')
    expect(workbenchSrc).toContain('isLive: id => connections.isLive(id)')
    expect(workbenchSrc).toContain("layout: () => settings.get('queryResults.grid.layout')")
    expect(workbenchSrc).toContain('onLayoutChange: listener => settings.subscribe(listener)')

    // Verify DocumentService.languageContext skips a disconnected first target when isLive is wired.
    wb.connections.disconnected(sql1.info.id)
    const model = wb.documents.getModel(doc.id)!
    expect(wb.documents.languageContext(model, id => wb.connections.isLive(id))?.connectionId).toBe(sql2.info.id)

    outContrib.dispose()
    results.dispose()
    queries.dispose()
    wb.dispose()
  })

  it('R7 #1: output.saveResultsAs works immediately in Stacked layout via saveEntry and unavailableReason distinguishes Summary vs no results for find and saveResultsAs', async () => {
    const wb = workbenchFixture()
    const sql1 = connectSql(wb, 'prod-sql-01', 'SalesDB')
    const sql2 = connectSql(wb, 'prod-sql-02', 'SalesDB')
    const doc = wb.documents.openMultiQuery({
      mode: 'same',
      name: 'R7Save.sql',
      targets: [
        { targetId: sql1.targetId, connectionId: sql1.info.id, database: 'SalesDB', enabled: true, provider: 'sqlserver' },
        { targetId: sql2.targetId, connectionId: sql2.info.id, database: 'SalesDB', enabled: true, provider: 'sqlserver' }
      ]
    })
    wb.documents.activate(doc.id)

    const client = fakeResultClient()
    const settingsStore = new SnapshotStore({
      values: { ...defaultSettings, 'queryResults.grid.layout': 'tabs' as 'stacked' | 'tabs' }
    })
    const results = new ResultsService({
      client,
      api: wb.api,
      events: wb.events,
      documents: wb.documents,
      frame: cb => cb(),
      layout: () => settingsStore.getSnapshot().values['queryResults.grid.layout'],
      onLayoutChange: listener => settingsStore.subscribe(listener)
    })
    const saveAsSpy = vi.spyOn(results, 'saveAs').mockResolvedValue(undefined)
    const queries = new QueryService(wb.documents, wb.api, id => wb.connections.get(id), wb.events, results)
    const resultsSearch = new ResultsSearchService({ results })
    const panes = new PaneService()
    const menuTargets = new MenuTargetService()
    const commands = new CommandService({ state: () => wb.context.getState() })
    const settings = {
      getSnapshot: () => settingsStore.getSnapshot(),
      subscribe: (l: () => void) => settingsStore.subscribe(l),
      choose: vi.fn(async () => true),
      toggle: vi.fn(async () => true)
    }
    const outContrib = outputContribution(
      { commands, results, queries, menuTargets, documents: wb.documents, settings: settings as unknown as typeof wb.settings, resultsSearch, panes },
      wb.api
    )

    // Before any results exist: both commands report the no-results reason.
    expect(commands.isEnabled('output.find', { tabId: doc.id })).toBe(false)
    expect(commands.isEnabled('output.saveResultsAs', { tabId: doc.id })).toBe(false)
    expect(commands.unavailableReason('output.find', { tabId: doc.id })).toBe('Execute a query that returns results first.')
    expect(commands.unavailableReason('output.saveResultsAs', { tabId: doc.id })).toBe('Execute a query that returns results first.')

    const q1 = uuid(907)
    const sqlDesc = descriptor(1, { targetKey: 'sql1', statementSlot: 0 })
    results.begin(doc.id, q1, undefined, {
      multi: {
        mode: 'fireAndForget',
        targets: [
          { targetKey: 'sql1', connectionId: sql1.info.id, provider: 'sqlserver', label: 'prod-sql-01', database: 'SalesDB' },
          { targetKey: 'sql2', connectionId: sql2.info.id, provider: 'sqlserver', label: 'prod-sql-02', database: 'SalesDB' }
        ]
      }
    })
    client.emit(q1, { type: 'resultSet.opened', descriptor: sqlDesc })
    client.emit(q1, { type: 'resultSet.closed', descriptor: sqlDesc })
    await results.finish(doc.id, q1, {
      multiSummary: multiSummary('fireAndForget', [
        multiOutcome('sql1', 'sqlserver', 'prod-sql-01', [1]),
        multiOutcome('sql2', 'sqlserver', 'prod-sql-02', [])
      ], [sqlDesc])
    })

    const firstKey = results.getSnapshot()[doc.id]!.sets[0]!.key

    // Tabs layout with Summary active: hasResultSets is true, so both disabled commands say 'Select a result grid first.'
    results.focusEntry(doc.id, summaryEntryKey)
    expect(commands.isEnabled('output.find', { tabId: doc.id })).toBe(false)
    expect(commands.isEnabled('output.saveResultsAs', { tabId: doc.id })).toBe(false)
    expect(commands.unavailableReason('output.find', { tabId: doc.id })).toBe('Select a result grid first.')
    expect(commands.unavailableReason('output.saveResultsAs', { tabId: doc.id })).toBe('Select a result grid first.')

    // Stacked layout with activeSummary still set (before ResultsStack focuses a grid): saveResultsAs falls back to sets[0] and saves immediately!
    settingsStore['publish']({ values: { ...defaultSettings, 'queryResults.grid.layout': 'stacked' } })
    expect(results.focusedEntry(doc.id)).toBeUndefined()
    expect(commands.isEnabled('output.saveResultsAs', { tabId: doc.id })).toBe(true)
    await commands.execute('output.saveResultsAs', { tabId: doc.id }, 'palette')
    expect(saveAsSpy).toHaveBeenCalledWith(doc.id, firstKey, 'R7Save')

    outContrib.dispose()
    results.dispose()
    queries.dispose()
    wb.dispose()
  })

  it('R7 #4: edit.refreshIntelliSense unavailableReason explains suspended Cross-Engine File view vs disconnected query', () => {
    const wb = workbenchFixture()
    const sql1 = connectSql(wb, 'prod-sql-01', 'SalesDB')
    const bq1 = connectBq(wb, 'prod-bq-01', 'analytics')
    const crossDoc = wb.documents.openMultiQuery({
      mode: 'cross',
      name: 'CrossSuspended.sql',
      sql: 'SELECT 1;',
      bigQuerySql: 'SELECT 2;',
      targets: [
        { targetId: sql1.targetId, connectionId: sql1.info.id, database: 'SalesDB', enabled: true, provider: 'sqlserver' },
        { targetId: bq1.targetId, connectionId: bq1.info.id, database: 'analytics', enabled: true, provider: 'bigquery' }
      ]
    })
    expect(wb.documents.setCrossView(crossDoc.id, 'file')).toEqual({ ok: true })
    wb.documents.activate(crossDoc.id)

    const disconnectedDoc = wb.documents.create('Disconnected.sql', 'SELECT 1;', 'master')

    const commands = new CommandService({ state: () => wb.context.getState() })
    const contrib = languagesContribution({
      commands,
      documents: wb.documents,
      connections: wb.connections,
      sqlLanguage: { refreshCache: vi.fn(async () => true) }
    })

    expect(commands.isEnabled('edit.refreshIntelliSense', { tabId: crossDoc.id })).toBe(false)
    expect(commands.unavailableReason('edit.refreshIntelliSense', { tabId: crossDoc.id }))
      .toBe('Switch to Split view for per-dialect IntelliSense and syntax checking.')

    expect(commands.isEnabled('edit.refreshIntelliSense', { tabId: disconnectedDoc.id })).toBe(false)
    expect(commands.unavailableReason('edit.refreshIntelliSense', { tabId: disconnectedDoc.id }))
      .toBe('Connect this query before refreshing its IntelliSense cache.')

    contrib.dispose()
    wb.dispose()
  })
})
