import { describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import type { ConnectionInfo, ConnectionOptions, MultiQueryOptions, MultiTargetOutcome, ProviderConnectionOptions, QueryMultiResult, ResultDescriptor } from '../src/shared/contracts'
import { defaultSettings, type SettingKey, type SettingValue } from '../src/shared/settings/catalog'
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
})
