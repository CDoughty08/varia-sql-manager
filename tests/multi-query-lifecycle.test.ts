import { describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import type { BigQueryDryRunResult } from '../src/shared/bigquery/dry-run'
import type { MultiQueryOptions, QueryEvent, QueryMultiResult } from '../src/shared/contracts'
import { bigQueryTargetOptions, connectionTargetOptions } from '../src/shared/connection-targets'
import { serializeCrossEngineSql } from '../src/shared/multi-query'
import { defaultSettings } from '../src/shared/settings/catalog'
import { sessionWriteSchema } from '../src/main/session-store'
import { recoveryWriteSchema } from '../src/main/recovery-store'
import { EventBus } from '../src/renderer/src/core/events'
import { SnapshotStore } from '../src/renderer/src/core/store'
import { CommandService } from '../src/renderer/src/core/commands'
import { computeContextKeys, ContextKeyService, focusFacts, type FocusEditor } from '../src/renderer/src/core/contextkeys'
import { documentProvider, isCrossEngineDocument, isMultiServerDocument } from '../src/renderer/src/documents'
import { ConnectionTargetService } from '../src/renderer/src/services/connection-targets'
import { bindConnectionPruning } from '../src/renderer/src/services/connection-pruning'
import { TargetService } from '../src/renderer/src/services/targets'
import { QueryService } from '../src/renderer/src/services/queries'
import { FileService } from '../src/renderer/src/services/files'
import { keptSession } from '../src/renderer/src/services/session'
import { RecoveryService } from '../src/renderer/src/services/recovery'
import { BigQueryCostService, costOptOut } from '../src/renderer/src/services/bigquery-cost'
import { createDisconnectCoordinator } from '../src/renderer/src/services/disconnect-workbench'
import { databaseRenameHooks } from '../src/renderer/src/actions/database-rename'
import { MenuTargetService } from '../src/renderer/src/menus/targets'
import { MenuService } from '../src/renderer/src/menus/MenuService'
import { queryStatusModel, multiTargetSummaryText } from '../src/renderer/src/results/query-status'
import type { BeginRunOptions, MultiResultsSink, MultiRunEnd } from '../src/renderer/src/results/multi-results-contract'
import { SqlLanguageService } from '../src/renderer/src/languages/SqlLanguageService'
import { SqlDiagnosticsService } from '../src/renderer/src/languages/SqlDiagnosticsService'
import { IndexCompletionService } from '../src/renderer/src/languages/IndexCompletionService'
import { documentFixture, deferred, TestEditor, TestModel } from './fixtures/documents'
import { fakeDocument, FakeElement } from './fixtures/elements'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const statusSettings = {
  'textEditor.statusBar.executionTime': 'elapsed' as const,
  'textEditor.statusBar.showServer': true,
  'textEditor.statusBar.showLogin': true,
  'textEditor.statusBar.showDatabase': true,
  'textEditor.statusBar.showRowCount': true
}

class DomEditor extends TestEditor {
  readonly id: string
  readonly container: FakeElement
  textFocused = false
  constructor(id: string, container: FakeElement) {
    super()
    this.id = id
    this.container = container
  }
  getId() { return this.id }
  getContainerDomNode() { return this.container.dom }
  hasTextFocus() { return this.textFocused }
  asFocusEditor(): FocusEditor<Element> { return this as unknown as FocusEditor<Element> }
}

describe('Wave 2a: Dual-model DocumentService & Cross-Engine lifecycle', () => {
  it('tracks dual-model dirty, monotonic revision across Split <-> File, canonical save, and skips session.close on multiMode', async () => {
    const f = documentFixture()
    const doc = f.documents.openMultiQuery({
      mode: 'cross',
      targets: [
        { targetId: uuid(1), connectionId: uuid(10), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: uuid(2), connectionId: uuid(11), database: 'analytics', enabled: true, provider: 'bigquery', attachWanted: true }
      ],
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2',
      unsaved: false
    })
    expect(isMultiServerDocument(doc)).toBe(true)
    expect(isCrossEngineDocument(doc)).toBe(true)
    expect(documentProvider(doc)).toBe('sqlserver')
    expect(doc.dirty).toBe(false)

    const primary = f.documents.getModel(doc.id)!
    const secondary = f.documents.getSecondaryModel(doc.id)!
    expect(f.documents.ownsModel(doc.id, primary)).toBe(true)
    expect(f.documents.ownsModel(doc.id, secondary)).toBe(true)
    expect(f.documents.modelFor(doc.id, 'sqlserver')).toBe(primary)
    expect(f.documents.modelFor(doc.id, 'bigquery')).toBe(secondary)

    const initialRev = f.documents.revision(doc.id)
    const initialEdits = f.documents.editRevision(doc.id)
    const contentEvents = vi.fn()
    const stopContent = f.documents.onDidChangeContent(doc.id, contentEvents)

    // Edit secondary pane: marks dirty, bumps revision and editRevision, notifies tab-level content listener.
    const secModel = secondary as unknown as TestModel
    secModel.edit('SELECT 20')
    expect(f.documents.get(doc.id)?.dirty).toBe(true)
    const afterSecEditRev = f.documents.revision(doc.id)
    expect(afterSecEditRev).toBeGreaterThan(initialRev)
    expect(f.documents.editRevision(doc.id)).toBe(initialEdits + 1)
    expect(contentEvents).toHaveBeenCalledTimes(1)

    // Save writes canonical -- #Dialect text and clears dirty.
    expect(await f.documents.save(doc.id)).toBe(true)
    expect(f.api.saveSqlFile).toHaveBeenCalledWith(expect.objectContaining({
      content: serializeCrossEngineSql('SELECT 1', 'SELECT 20')
    }))
    expect(f.documents.get(doc.id)?.dirty).toBe(false)

    // Split -> File uses pushEditOperations + undo stops (TestModel has no setValue), accumulates retiredSecondaryVersions, keeps revision strictly monotonic.
    const pushEditsSpy = vi.spyOn(primary as unknown as TestModel, 'pushEditOperations')
    const pushStackSpy = vi.spyOn(primary as unknown as TestModel, 'pushStackElement')
    expect(f.documents.setCrossView(doc.id, 'file')).toEqual({ ok: true })
    expect(pushEditsSpy).toHaveBeenCalledTimes(1)
    expect(pushStackSpy).toHaveBeenCalledTimes(2)
    expect(f.documents.get(doc.id)?.crossView).toBe('file')
    expect(f.documents.getSecondaryModel(doc.id)).toBeUndefined()
    const afterFileRev = f.documents.revision(doc.id)
    expect(afterFileRev).toBeGreaterThan(afterSecEditRev)
    expect(primary.getValue()).toBe(serializeCrossEngineSql('SELECT 1', 'SELECT 20'))

    // File -> Split recreates secondary model; existing onDidChangeContent listener still fires on secondary edits!
    expect(f.documents.setCrossView(doc.id, 'split')).toEqual({ ok: true })
    const newSecondary = f.documents.getSecondaryModel(doc.id) as unknown as TestModel
    expect(newSecondary.getValue()).toBe('SELECT 20')
    const afterSplitRev = f.documents.revision(doc.id)
    expect(afterSplitRev).toBeGreaterThan(afterFileRev)

    contentEvents.mockClear()
    newSecondary.edit('SELECT 30')
    expect(contentEvents).toHaveBeenCalledTimes(1)
    expect(f.documents.get(doc.id)?.dirty).toBe(true)
    stopContent.dispose()

    // Close skips query.session.close for multiMode tabs and round-trips via reopenClosed() as hint-only targets.
    await f.documents.close(doc.id)
    expect(f.api.closeQuerySession).not.toHaveBeenCalled()
    const reopened = f.documents.reopenClosed()!
    expect(reopened.multiMode).toBe('cross')
    expect(reopened.crossView).toBe('split')
    expect(reopened.multiTargets).toEqual([
      { provider: 'sqlserver', database: 'Sales', enabled: true },
      { provider: 'bigquery', database: 'analytics', enabled: true }
    ])
    expect(f.documents.getModel(reopened.id)?.getValue()).toBe('SELECT 1')
    expect(f.documents.getSecondaryModel(reopened.id)?.getValue()).toBe('SELECT 30')
  })

  it('transitions malformed Cross-Engine files cleanly to File mode on reload and rejects malformed File -> Split', () => {
    const f = documentFixture()
    const file = { id: uuid(99), name: 'cross.sql', path: 'cross.sql', encoding: 'utf8' as const, readOnly: false }
    const doc = f.documents.openMultiQuery({
      mode: 'cross',
      targets: [],
      name: 'cross.sql',
      sql: serializeCrossEngineSql('SELECT 1', 'SELECT 2'),
      file
    })
    expect(f.documents.get(doc.id)?.crossView).toBe('split')
    expect(f.documents.getSecondaryModel(doc.id)).toBeDefined()

    // External edit breaks -- #Dialect headers: reload transitions to File view and disposes secondaryModel.
    f.documents.reload(doc.id, 'SELECT 42 -- headers removed', 'lf', file)
    expect(f.documents.get(doc.id)?.crossView).toBe('file')
    expect(f.documents.get(doc.id)?.dirty).toBe(false)
    expect(f.documents.getSecondaryModel(doc.id)).toBeUndefined()
    expect(f.documents.getModel(doc.id)?.getValue()).toBe('SELECT 42 -- headers removed')

    const switched = f.documents.setCrossView(doc.id, 'split')
    expect(switched.ok).toBe(false)
  })

  it('defers dialect-targeted revealLine and pendingFocus until the sibling dialect editor mounts', () => {
    const f = documentFixture()
    const doc = f.documents.openMultiQuery({
      mode: 'cross',
      targets: [],
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT\n  1\n  + 2\n  + 3'
    })
    const other = f.documents.create('other.sql', 'SELECT 0', 'master')
    const primaryEditor = new TestEditor()
    const secondaryEditor = new TestEditor()
    f.documents.showIn(primaryEditor.asEditor(), other.id, 'primary')

    // Reveal line 4 in BigQuery pane while other.sql is active and secondary editor has not mounted yet.
    const rev = f.documents.revision(doc.id)
    expect(f.documents.revealLine(doc.id, 4, rev, 'bigquery')).toBe(true)
    expect(f.documents.get(doc.id)?.activePane).toBe('secondary')
    expect(f.documents.active?.id).toBe(doc.id)
    // editorOf(doc.id) returns undefined rather than falling back to primary editor.
    expect(f.documents.editorOf(doc.id)).toBeUndefined()

    // Mounting primary editor first must NOT clear pendingReveal or pendingFocus.
    f.documents.showIn(primaryEditor.asEditor(), doc.id, 'primary')
    expect(primaryEditor.revealedLine).toBeUndefined()
    expect(primaryEditor.focused).toBe(0)

    // Mounting secondary editor applies pending reveal and focuses it!
    f.documents.showIn(secondaryEditor.asEditor(), doc.id, 'secondary')
    expect(secondaryEditor.position).toEqual({ lineNumber: 4, column: 1 })
    expect(secondaryEditor.revealedLine).toBe(4)
    expect(secondaryEditor.focused).toBe(1)
    expect(f.documents.boundEditor).toBe(secondaryEditor.asEditor())
  })

  it('updates activeDocumentProvider synchronously on setActivePane and recognizes focus inside secondary Find widget', () => {
    const f = documentFixture()
    const doc = f.documents.openMultiQuery({
      mode: 'cross',
      targets: [
        { targetId: uuid(1), connectionId: uuid(10), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: uuid(2), connectionId: uuid(11), database: 'ds', enabled: true, provider: 'bigquery', attachWanted: true }
      ],
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2'
    })
    const domDoc = fakeDocument()
    const primaryHost = new FakeElement(domDoc, 'div')
    const secondaryHost = new FakeElement(domDoc, 'div')
    const findInput = new FakeElement(domDoc, 'input')
    const findHost = new FakeElement(domDoc, 'div', { attributes: { 'data-query-editor-id': 'ed-sec' } }).append(findInput)
    new FakeElement(domDoc, 'body').append(primaryHost, secondaryHost, findHost)

    const primaryEd = new DomEditor('ed-pri', primaryHost)
    const secondaryEd = new DomEditor('ed-sec', secondaryHost)
    f.documents.showIn(primaryEd.asEditor(), doc.id, 'primary')
    f.documents.showIn(secondaryEd.asEditor(), doc.id, 'secondary')

    const connections = new SnapshotStore([
      { id: uuid(10), server: 'sql-1', database: 'Sales', serverVersion: '16.0', generation: 1, providerId: 'sqlserver' as const, targetId: uuid(1), options: { server: 'sql-1', database: 'Sales', authentication: 'sql' as const, trustServerCertificate: false } },
      { id: uuid(11), server: 'bq-1', database: 'ds', serverVersion: '', generation: 1, providerId: 'bigquery' as const, targetId: uuid(2), options: { provider: 'bigquery' as const, project: 'bq-1', authentication: 'gcloud' as const } }
    ])
    const ctx = new ContextKeyService({
      platform: 'win32',
      documents: f.documents,
      queries: new SnapshotStore({}),
      connections,
      backend: new SnapshotStore({ state: { status: 'ready' as const, generation: 1, pid: 1, runtime: 'net11', platform: 'win32' } }),
      editorOptions: new SnapshotStore({ wordWrap: false, whitespace: false, lineNumbers: true, fontSize: 13, fontFamily: 'monospace', dragAndDrop: true, highlightCurrentLine: true, multiCursorModifier: 'alt' as const }),
      editors: () => f.documents.activeEditors() as unknown as readonly FocusEditor<Element>[]
    })

    expect(ctx.getState().activeDocumentIsMultiServer).toBe(true)
    expect(ctx.getState().activeDocumentCrossFile).toBe(false)
    expect(ctx.getState().activeDocumentProvider).toBe('sqlserver')
    expect(ctx.getState().activeDocumentConnected).toBe(true)
    expect(ctx.getState().anyDocumentConnected).toBe(true)

    // Synchronous pane switch updates ContextKeyService.getState() immediately.
    f.documents.setActivePane(doc.id, 'secondary')
    expect(ctx.getState().activeDocumentProvider).toBe('bigquery')

    // Focus inside secondary Find widget (hosted outside container via data-query-editor-id) preserves editorFocus = true.
    const facts = focusFacts(findInput.dom, f.documents.activeEditors() as unknown as readonly FocusEditor<Element>[])
    expect(facts.editorFocus).toBe(true)
    expect(facts.inputFocus).toBe(true)
    expect(f.documents.editorContaining(findInput.dom)?.pane).toBe('secondary')

    // Switching to File view sets activeDocumentCrossFile = true.
    f.documents.setCrossView(doc.id, 'file')
    expect(ctx.getState().activeDocumentCrossFile).toBe(true)

    // Cross-Engine activeDocumentConnected requires >= 1 live enabled target per engine.
    f.documents.updateMultiTarget(doc.id, target => target.provider === 'bigquery', { enabled: false })
    expect(ctx.getState().activeDocumentConnected).toBe(false)
    expect(ctx.getState().anyDocumentConnected).toBe(false)

    ctx.dispose()
  })
})

describe('Wave 2a: Pure MenuTargetService + MenuService.openFor onFocus before resolve', () => {
  it('keeps targetFor pure and invokes hit.onFocus before resolve so activeDocumentProvider matches the right-clicked pane', () => {
    const f = documentFixture()
    const doc = f.documents.openMultiQuery({
      mode: 'cross',
      targets: [],
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2'
    })
    const domDoc = fakeDocument()
    const secLine = new FakeElement(domDoc, 'span')
    const secHost = new FakeElement(domDoc, 'div').append(secLine)
    new FakeElement(domDoc, 'body').append(secHost)
    const secEd = new DomEditor('ed-sec', secHost)
    f.documents.showIn(secEd.asEditor(), doc.id, 'secondary')

    const onFocusSpy = vi.fn(() => { f.documents.setActivePane(doc.id, 'secondary') })
    const targets = new MenuTargetService({
      editor: element => {
        const hit = f.documents.editorContaining(element ?? null)
        return hit ? { container: hit.editor.getContainerDomNode(), tabId: hit.tabId, focus: onFocusSpy } : undefined
      }
    })

    // targetFor must be completely pure (never invokes onFocus).
    const hit = targets.targetFor(secLine.dom)
    expect(hit?.target).toEqual({ kind: 'editor', tabId: doc.id })
    expect(onFocusSpy).not.toHaveBeenCalled()
    expect(f.documents.get(doc.id)?.activePane).toBe('primary')

    // MenuService.openFromEvent invokes hit.onFocus BEFORE resolve().
    let providerDuringResolve = ''
    const getState = vi.fn(() => {
      const state = computeContextKeys({
        platform: 'win32',
        documents: f.documents.getSnapshot(),
        queries: {},
        connections: [],
        quickInputVisible: false,
        wordWrap: false,
        backendStatus: 'ready'
      })
      providerDuringResolve = state.activeDocumentProvider
      return state
    })
    const commands = new CommandService({ state: getState, modalOpen: () => false })
    const menus = new MenuService({
      platform: 'win32',
      commands,
      context: { getState },
      keybindings: { lookup: () => undefined },
      theme: { state: { preference: { version: 1, mode: 'dark', darkTheme: 'dark', lightTheme: 'light' }, themes: [] } },
      focus: { capture: () => undefined, restore: () => {} },
      modalOpen: () => false,
      targets
    })
    menus.openFromEvent({ target: secLine.dom, clientX: 10, clientY: 10, preventDefault: () => {} })
    expect(onFocusSpy).toHaveBeenCalledTimes(1)
    expect(providerDuringResolve).toBe('bigquery')
    menus.dispose()
  })
})

describe('Wave 2a: TargetService, connection-pruning & database-rename', () => {
  it('prunes only targets not referenced by single-server OR multiTargets[]', async () => {
    const f = documentFixture()
    const registry = new ConnectionTargetService()
    registry.add({ id: uuid(1), options: connectionTargetOptions({ server: 's1', database: 'master', authentication: 'sql', username: 'u', trustServerCertificate: false }), details: { autoReconnect: 'inherit' }, inExplorer: false, resumeWanted: false })
    registry.add({ id: uuid(2), options: connectionTargetOptions({ server: 's2', database: 'master', authentication: 'sql', username: 'u', trustServerCertificate: false }), details: { autoReconnect: 'inherit' }, inExplorer: false, resumeWanted: false })
    registry.add({ id: uuid(3), options: connectionTargetOptions({ server: 's3', database: 'master', authentication: 'sql', username: 'u', trustServerCertificate: false }), details: { autoReconnect: 'inherit' }, inExplorer: false, resumeWanted: false })
    f.documents.openMultiQuery({
      mode: 'same',
      targets: [
        { targetId: uuid(1), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true },
        { database: 'HintOnly', enabled: true, provider: 'sqlserver', lastServer: 'offline-hint' }
      ]
    })
    const pruneConnectionTargets = vi.fn(async (ids: readonly string[]) => ({ ok: true as const, value: { pruned: ids.length } }))
    const pruning = bindConnectionPruning({ registry, documents: f.documents, api: { pruneConnectionTargets }, ready: Promise.resolve() })
    await Promise.resolve()
    expect(pruneConnectionTargets).toHaveBeenCalledWith([uuid(2), uuid(3)])
    expect(registry.get(uuid(1))).toBeDefined()
    pruning.dispose()
  })

  it('updates multiTargets across attachTarget, coalesceTarget (deduping by targetId), detached, retarget, and disconnectAll', async () => {
    const f = documentFixture()
    const registry = new ConnectionTargetService()
    registry.markLostBefore(1)
    registry.add({ id: uuid(1), options: connectionTargetOptions({ server: 's1', database: 'master', authentication: 'sql', username: 'u', trustServerCertificate: false }), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true })
    registry.add({ id: uuid(2), options: connectionTargetOptions({ server: 's2', database: 'master', authentication: 'sql', username: 'u', trustServerCertificate: false }), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true })
    registry.completeConnect(registry.beginConnect(uuid(2), 1, uuid(20))!, { id: uuid(12), generation: 1 }, { principal: { provider: 'sqlserver', authentication: 'sql', id: 'u' } })

    const liveConnections = new Map<string, { id: string; server: string; database: string; generation: number; targetId: string }>([
      [uuid(12), { id: uuid(12), server: 's2', database: 'master', generation: 1, targetId: uuid(2) }]
    ])
    const targets = new TargetService(
      f.documents,
      { isRunning: () => false, mayHaveTransaction: async () => false, confirmSessions: async () => new Map() },
      { get: id => liveConnections.get(id) as never },
      { clearError: () => {}, reportError: () => {} },
      registry
    )

    const doc = f.documents.openMultiQuery({
      mode: 'same',
      targets: [
        { targetId: uuid(1), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: uuid(2), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: false }
      ]
    })

    // attachTarget respects attachWanted: false on target 2 (must stay disconnected).
    targets.attachTarget(uuid(2), uuid(12))
    expect(f.documents.get(doc.id)?.multiTargets?.[1]?.connectionId).toBeUndefined()

    // coalesceTarget migrates target 1 -> target 2 AND deduplicates multiTargets by targetId!
    targets.coalesceTarget(uuid(1), uuid(2), uuid(12))
    expect(f.documents.get(doc.id)?.multiTargets).toHaveLength(1)
    expect(f.documents.get(doc.id)?.multiTargets?.[0]).toMatchObject({ targetId: uuid(2), connectionId: uuid(12), attachWanted: true })

    // retarget updates matching connectionId once the target holds the new live handle.
    registry.markLostBefore(2)
    registry.completeConnect(registry.beginConnect(uuid(2), 2, uuid(21))!, { id: uuid(13), generation: 2 }, { principal: { provider: 'sqlserver', authentication: 'sql', id: 'u' } })
    liveConnections.set(uuid(13), { id: uuid(13), server: 's2', database: 'master', generation: 2, targetId: uuid(2) })
    targets.retarget(uuid(12), uuid(13))
    expect(f.documents.get(doc.id)?.multiTargets?.[0]?.connectionId).toBe(uuid(13))

    // disconnectAll disconnects idle multi-target tabs without calling endSession.
    await targets.disconnectAll()
    expect(f.api.closeQuerySession).not.toHaveBeenCalled()
    expect(f.documents.get(doc.id)?.multiTargets?.[0]).toMatchObject({ connectionId: undefined, attachWanted: false, lastServer: 's2' })
  })

  it('databaseRenameHooks treats running multi-server tabs as active transactions without calling transactionState and renames multiTargets[].database', async () => {
    const f = documentFixture()
    const doc = f.documents.openMultiQuery({
      mode: 'same',
      name: 'MultiRename.sql',
      targets: [
        { targetId: uuid(1), connectionId: uuid(10), database: 'OldDb', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: uuid(2), connectionId: uuid(11), database: 'OtherDb', enabled: true, provider: 'sqlserver', attachWanted: true }
      ]
    })
    const transactionState = vi.fn(async () => ({ transactions: 0 }))
    const connections = new SnapshotStore([
      { id: uuid(10), server: 'srv-a', database: 'OldDb', serverVersion: '16.0', generation: 1, options: { server: 'srv-a', database: 'OldDb', authentication: 'sql' as const, trustServerCertificate: false } }
    ])
    const rehome = vi.fn()
    const hooks = databaseRenameHooks({
      documents: f.documents,
      queries: {
        getSnapshot: () => ({ [doc.id]: { running: { queryId: 'q1', connectionId: uuid(10), connectionIds: [uuid(10), uuid(11)], multi: true, startedAt: 1 } } }),
        transactionState
      },
      connections: Object.assign(connections, { rehome }),
      targets: { changeDatabase: vi.fn() },
      properties: { databaseRenamed: vi.fn() }
    })

    const own = await hooks.tabs(uuid(10), 'OldDb')
    expect(own).toEqual({ count: 1, withTransactions: ['MultiRename.sql'] })
    expect(transactionState).not.toHaveBeenCalled()

    hooks.renamed(uuid(10), 'OldDb', 'NewDb')
    expect(f.documents.get(doc.id)?.multiTargets?.[0]?.database).toBe('NewDb')
    expect(f.documents.get(doc.id)?.multiTargets?.[1]?.database).toBe('OtherDb')
  })
})

describe('Wave 2a: QueryService multi-execution, read-only refusal, PreparedSessions, and query-status', () => {
  it('runs executeMulti with ephemeral jobKey, updates targetState/resultSet.meta, refuses read-only locally with zero IPC, and validates PreparedSessions', async () => {
    const f = documentFixture()
    const events = new EventBus()
    const doc = f.documents.openMultiQuery({
      mode: 'cross',
      targets: [
        { targetId: uuid(1), connectionId: uuid(10), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: uuid(2), connectionId: uuid(11), database: 'analytics', enabled: true, provider: 'bigquery', attachWanted: true }
      ],
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT\n  1\n  + 2\n  + 3'
    })
    const conns = new Map([
      [uuid(10), { id: uuid(10), server: 'sql-1', database: 'Sales', serverVersion: '16.0', generation: 1, providerId: 'sqlserver' as const, targetId: uuid(1), environment: 'Production' }],
      [uuid(11), { id: uuid(11), server: 'bq-1', database: 'analytics', serverVersion: '', generation: 1, providerId: 'bigquery' as const, targetId: uuid(2) }]
    ])

    let beginOpts: BeginRunOptions | undefined
    let finishedEnd: MultiRunEnd | undefined
    const results: MultiResultsSink = {
      begin: vi.fn((_tabId, _queryId, _onSession, opts) => { beginOpts = opts }),
      finish: vi.fn((_tabId, _queryId, end) => { finishedEnd = end }),
      updateMultiTargetState: vi.fn(),
      updateResultMeta: vi.fn()
    }

    let resolveExec!: (value: { ok: true; value: QueryMultiResult }) => void
    const executeMulti = vi.fn((_opts: MultiQueryOptions) => new Promise<{ ok: true; value: QueryMultiResult }>(resolve => { resolveExec = resolve }))
    const confirmSessions = vi.fn(async () => ({ ok: true as const, value: 'proceed' as const }))
    const queries = new QueryService(
      f.documents,
      {
        execute: vi.fn(),
        executeMulti,
        cancel: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } })),
        confirmSessions,
        querySessionState: vi.fn(async () => ({ ok: true as const, value: { transactionCount: 0, checked: true } }))
      },
      id => conns.get(id),
      events,
      results
    )

    // 1. Pre-execute read-only refusal sends ZERO IPC, logs clickable message with line+dialect, and supports dialect-aware sourceLine even when unfocused pane is longer!
    queries.refuseReadOnly(doc.id, [{ line: 4, message: 'DELETE is not allowed.', dialect: 'bigquery' }])
    expect(executeMulti).not.toHaveBeenCalled()
    expect(finishedEnd?.code).toBe('READ_ONLY_VIOLATION')
    expect(finishedEnd?.messages?.[0]).toMatchObject({ kind: 'error', line: 4, dialect: 'bigquery' })
    const refusalQueryId = (results.begin as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string
    expect(queries.sourceLine(doc.id, refusalQueryId, 4, 'bigquery')).toBe(4)
    expect(queries.sourceLine(doc.id, refusalQueryId, 4, 'sqlserver')).toBeUndefined()

    // 2. executeMulti bumps executionVersion, sends ephemeral jobKey (never persisted on document), tracks connectionIds & holdsJob=false.
    expect(queries.executionVersion(doc.id)).toBe(0)
    const runPromise = queries.executeMulti(doc.id, { mode: 'crossEngineReadOnly' })
    expect(queries.executionVersion(doc.id)).toBe(1)
    expect(queries.isConnectionRunning(uuid(10))).toBe(true)
    expect(queries.isConnectionRunning(uuid(11))).toBe(true)
    expect(await queries.holdsJob(doc.id)).toBe(false)
    expect(queries.canCloseRunningJob(doc.id)).toBe(false)
    expect(f.documents.get(doc.id)?.jobKey).toBeUndefined()
    expect(executeMulti).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'crossEngineReadOnly',
      jobKey: expect.any(String),
      scripts: { sqlserver: 'SELECT 1', bigquery: 'SELECT\n  1\n  + 2\n  + 3' }
    }))

    // Live targetState updates QueryService snapshot without redundantly re-calling ResultsService; ResultsService.begin owns both state updates directly.
    const targetEvent: Extract<QueryEvent, { type: 'multiQuery.targetState' }> = {
      type: 'multiQuery.targetState', targetKey: uuid(1), phase: 'running', batchesCompleted: 0, batchesTotal: 1, rowsAffected: 0, resultSetCount: 0, elapsedMs: 12
    }
    beginOpts?.onTargetState?.(targetEvent)
    expect(queries.getSnapshot()[doc.id]?.multiTargets?.[0]?.phase).toBe('running')
    expect(results.updateMultiTargetState).not.toHaveBeenCalled()
    expect(beginOpts?.onResultMeta).toBeUndefined()

    // PreparedSessions includes running multi-target tab in stopping, excludes it from plan, and validates target handle generations!
    const prepared = await queries.prepareSessions('disconnect', [doc.id])
    expect(prepared?.stopping).toHaveLength(1)
    expect(prepared?.plan.size).toBe(0)
    expect(prepared?.current()).toBe(true)
    conns.set(uuid(11), { ...conns.get(uuid(11))!, generation: 2 })
    expect(prepared?.current()).toBe(false)
    conns.set(uuid(11), { ...conns.get(uuid(11))!, generation: 1 })
    expect(prepared?.current()).toBe(true)

    resolveExec({
      ok: true,
      value: {
        status: 'completed',
        mode: 'crossEngineReadOnly',
        targets: [
          { targetKey: uuid(1), provider: 'sqlserver', label: 'sql-1', environment: 'Production', status: 'succeeded', batchesCompleted: 1, batchesTotal: 1, rowsAffected: 1, elapsedMs: 15, resultSetIds: [1] },
          { targetKey: uuid(2), provider: 'bigquery', label: 'bq-1', status: 'succeeded', batchesCompleted: 1, batchesTotal: 1, rowsAffected: 1, elapsedMs: 25, resultSetIds: [2] }
        ],
        resultSets: [],
        discardedResultSets: 0,
        messages: [],
        messagesTruncated: false,
        elapsedMs: 25,
        budget: { usedBytes: 0, globalBytes: 1024, queryBytes: 1024, generation: 1, seq: 1 },
        completedAt: '2026-11-26T00:00:00.0000000Z'
      }
    })
    await runPromise
    // executionVersion stays constant across completion.
    expect(queries.executionVersion(doc.id)).toBe(1)
    expect(queries.getSnapshot()[doc.id]?.multiSummary?.status).toBe('completed')
    queries.dispose()
  })

  it('formats multi-server and cross-engine status strings cleanly', () => {
    expect(multiTargetSummaryText('same', [
      { provider: 'sqlserver', connected: true, enabled: true, environment: 'Production' },
      { provider: 'sqlserver', connected: true, enabled: true, environment: 'Staging' },
      { provider: 'sqlserver', connected: true, enabled: true }
    ]).label).toBe('3 SQL Servers (1 PROD) · Ready')

    expect(multiTargetSummaryText('same', [
      { provider: 'sqlserver', connected: true, enabled: true },
      { provider: 'sqlserver', connected: true, enabled: true },
      { provider: 'sqlserver', connected: false, enabled: true }
    ]).label).toBe('3 SQL Servers · 2 of 3 connected')

    expect(multiTargetSummaryText('cross', [
      { provider: 'sqlserver', connected: true, enabled: true },
      { provider: 'bigquery', connected: true, enabled: true }
    ]).label).toBe('1 SQL Server + 1 BigQuery · Read-only')

    const rolledBack = queryStatusModel({
      database: '',
      running: false,
      multiMode: 'same',
      multiTargets: [{ provider: 'sqlserver', connected: true, enabled: true }],
      multiStatus: 'rolledBack',
      now: 1000,
      settings: statusSettings
    })
    expect(rolledBack.tone).toBe('error')
    expect(rolledBack.text).toContain('rolled back')
  })
})

describe('Wave 2a: Hot Exit v4, AutoRecover v3, FileService & BigQueryCostService', () => {
  it('round-trips AutoRecover v3 hint-only targets through Hot Exit v4 schema validation cleanly', async () => {
    const f = documentFixture()
    const registry = new ConnectionTargetService()
    registry.add({ id: uuid(1), options: connectionTargetOptions({ server: 'sql-1', database: 'Sales', authentication: 'sql', username: 'u', trustServerCertificate: false }), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true })
    registry.add({ id: uuid(2), options: bigQueryTargetOptions({ provider: 'bigquery', project: 'bq-proj-1', authentication: 'gcloud' }), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true })

    const doc = f.documents.openMultiQuery({
      mode: 'cross',
      targets: [
        { targetId: uuid(1), connectionId: uuid(10), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: uuid(2), connectionId: uuid(11), database: 'analytics', enabled: true, provider: 'bigquery', attachWanted: true }
      ],
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2',
      unsaved: true
    })

    // 1. Hot Exit v4 passes real sessionWriteSchema with canonical -- #Dialect text and no connectionId.
    const kept = keptSession(f.documents, id => id === uuid(10) ? 'sql-1' : 'bq-1', { connectionTargets: registry })
    expect(() => sessionWriteSchema.parse(kept.session)).not.toThrow()
    expect(kept.session.documents[0]).toMatchObject({
      multiMode: 'cross',
      crossView: 'split',
      text: serializeCrossEngineSql('SELECT 1', 'SELECT 2'),
      multiTargets: [
        { targetId: uuid(1), attachWanted: true, provider: 'sqlserver', database: 'Sales', enabled: true, lastServer: 'sql-1' },
        { targetId: uuid(2), attachWanted: true, provider: 'bigquery', database: 'analytics', enabled: true, lastServer: 'bq-1' }
      ]
    })
    expect(kept.checkpointCurrent()).toBe(true)
    // Changing multiTargets invalidates checkpointCurrent.
    f.documents.updateMultiTarget(doc.id, 0, { enabled: false })
    expect(kept.checkpointCurrent()).toBe(false)

    // 2. AutoRecover v3 writes hint-only targets (no targetId/attachWanted/connectionId) and passes recoveryWriteSchema!
    const writes: unknown[] = []
    const recovery = new RecoveryService({
      api: {
        writeRecovery: vi.fn(async record => { writes.push(record); return { ok: true as const, value: undefined } }),
        discardRecovery: vi.fn(async () => ({ ok: true as const, value: undefined })),
        listRecovery: vi.fn(async () => ({ ok: true as const, value: [] })),
        takeRecovery: vi.fn(async () => ({
          ok: true as const,
          value: {
            name: 'RecoveredCross.sql',
            kind: 'sql' as const,
            eol: 'lf' as const,
            text: serializeCrossEngineSql('SELECT 1', 'SELECT 2'),
            multiMode: 'cross' as const,
            crossView: 'split' as const,
            multiTargets: [
              { provider: 'sqlserver' as const, database: 'Sales', enabled: false, lastServer: 'sql-1' },
              { provider: 'bigquery' as const, database: 'analytics', enabled: true, lastServer: 'bq-1' }
            ]
          }
        }))
      },
      documents: f.documents,
      files: { later: async action => { await action(undefined) }, release: async () => {}, exiting: false },
      settings: new SnapshotStore({ values: { ...defaultSettings, 'environment.autoRecover.enabled': true } }),
      server: id => id === uuid(10) ? 'sql-1' : 'bq-1',
      warn: vi.fn(),
      newId: () => uuid(77)
    })
    await recovery.flush()
    expect(writes).toHaveLength(1)
    expect(() => recoveryWriteSchema.parse(writes[0])).not.toThrow()
    expect(writes[0]).toMatchObject({
      multiMode: 'cross',
      crossView: 'split',
      text: serializeCrossEngineSql('SELECT 1', 'SELECT 2'),
      multiTargets: [
        { provider: 'sqlserver', database: 'Sales', enabled: false, lastServer: 'sql-1' },
        { provider: 'bigquery', database: 'analytics', enabled: true, lastServer: 'bq-1' }
      ]
    })

    // Toggling multiTargets or editing secondary model triggers a new AutoRecover write!
    ;(f.documents.getSecondaryModel(doc.id) as unknown as TestModel).edit('SELECT 200')
    await recovery.flush()
    expect(writes).toHaveLength(2)

    // 3. Recovering hint-only targets and then running Hot Exit passes sessionWriteSchema (targetsPresent passes!).
    await recovery.recover([uuid(88)])
    const recoveredDoc = f.documents.getSnapshot().documents.find(d => d.name === 'RecoveredCross.sql')!
    expect(recoveredDoc.multiMode).toBe('cross')
    expect(recoveredDoc.multiTargets?.every(t => t.targetId === undefined && t.attachWanted === undefined)).toBe(true)
    const afterRecoverHotExit = keptSession(f.documents, () => undefined, { connectionTargets: registry })
    expect(() => sessionWriteSchema.parse(afterRecoverHotExit.session)).not.toThrow()
    recovery.dispose()
  })

  it('FileService.openFiles auto-activates Cross-Engine Split only for canonical -- #Dialect files without inheriting single-server connection', async () => {
    const f = documentFixture()
    f.documents.create('active.sql', 'SELECT 1', 'Sales', uuid(10))
    const files = new FileService(
      f.documents,
      { isRunning: () => false, mayHaveTransaction: async () => false, confirmSessions: async () => new Map() },
      {
        openSqlFiles: vi.fn(async () => ({
          ok: true as const,
          value: {
            files: [
              { id: uuid(30), name: 'cross.sql', path: 'cross.sql', encoding: 'utf8' as const, readOnly: false, content: serializeCrossEngineSql('SELECT 1', 'SELECT 2'), eol: 'lf' as const, mixedEol: false },
              { id: uuid(31), name: 'plain.sql', path: 'plain.sql', encoding: 'utf8' as const, readOnly: false, content: 'SELECT 99', eol: 'lf' as const, mixedEol: false }
            ],
            errors: []
          }
        })),
        saveSqlFile: f.api.saveSqlFile,
        releaseSqlFile: vi.fn(async () => ({ ok: true as const, value: undefined })),
        confirmClose: vi.fn(async () => ({ ok: true as const, value: 'discard' as const })),
        closeWindow: vi.fn(async () => {}),
        closeWindowCancelled: vi.fn()
      }
    )
    await files.open()
    const crossDoc = f.documents.getSnapshot().documents.find(d => d.name === 'cross.sql')!
    const plainDoc = f.documents.getSnapshot().documents.find(d => d.name === 'plain.sql')!
    expect(crossDoc.multiMode).toBe('cross')
    expect(crossDoc.crossView).toBe('split')
    expect(crossDoc.connectionId).toBeUndefined()
    expect(crossDoc.targetId).toBeUndefined()
    expect(plainDoc.multiMode).toBeUndefined()
    expect(plainDoc.connectionId).toBe(uuid(10))
    files.dispose()
  })

  it('FileService.closeWindow excludes multi-target BigQuery tabs from keptQueries so Quit always prompts to cancel them', async () => {
    const f = documentFixture()
    const doc = f.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      targets: [
        { targetId: uuid(1), connectionId: uuid(10), database: 'ds1', enabled: true, provider: 'bigquery', attachWanted: true },
        { targetId: uuid(2), connectionId: uuid(11), database: 'ds2', enabled: true, provider: 'bigquery', attachWanted: true }
      ],
      sql: 'SELECT 1'
    })
    const confirmSessions = vi.fn(async () => new Map())
    const keepJobsAtQuit = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const files = new FileService(
      f.documents,
      { isRunning: () => true, mayHaveTransaction: async () => false, confirmSessions, holdsJob: async () => true },
      {
        openSqlFiles: vi.fn(),
        saveSqlFile: f.api.saveSqlFile,
        releaseSqlFile: vi.fn(async () => ({ ok: true as const, value: undefined })),
        confirmClose: vi.fn(async () => ({ ok: true as const, value: 'discard' as const })),
        closeWindow: vi.fn(async () => {}),
        closeWindowCancelled: vi.fn(),
        keepSession: vi.fn(async () => ({ ok: true as const, value: undefined })),
        keepJobsAtQuit
      },
      {
        hotExit: () => ({
          session: { documents: [], activeIndex: -1 },
          kept: new Set([doc.id]),
          checkpointCurrent: () => true
        })
      }
    )
    await files.closeWindow(async () => {})
    expect(keepJobsAtQuit).not.toHaveBeenCalled()
    expect(confirmSessions).toHaveBeenCalledWith('exit', [doc.id])
    files.dispose()
  })

  it('BigQueryCostService resolves per-result connection via connectionForResult on beforeRemote and estimateRemote', async () => {
    const f = documentFixture()
    const doc = f.documents.openMultiQuery({
      mode: 'same',
      provider: 'bigquery',
      targets: [
        { targetId: uuid(1), connectionId: uuid(10), database: 'ds1', enabled: true, provider: 'bigquery', attachWanted: true },
        { targetId: uuid(2), connectionId: uuid(11), database: 'ds2', enabled: true, provider: 'bigquery', attachWanted: true }
      ]
    })
    const bqConn2 = { id: uuid(11), server: 'proj-2', database: 'ds2', serverVersion: '', generation: 1, providerId: 'bigquery' as const, options: { provider: 'bigquery' as const, project: 'proj-2', authentication: 'gcloud' as const } }
    const dryRun = vi.fn(async () => ({ ok: true as const, value: { bytesProcessed: 1024 } as BigQueryDryRunResult }))
    const cost = new BigQueryCostService({
      api: { bigQueryDryRun: dryRun },
      documents: f.documents,
      connections: {
        get: id => id === uuid(11) ? bqConn2 : undefined,
        isLive: id => id === uuid(11),
        subscribe: () => () => {}
      },
      settings: {
        get: key => defaultSettings[key],
        subscribe: () => () => {},
        choose: async () => {}
      },
      events: { subscribe: () => ({ dispose() {} }) },
      monaco: { MarkerSeverity: { Error: 8 } as typeof Monaco.MarkerSeverity, editor: { setModelMarkers: vi.fn() } },
      ask: vi.fn(async () => ({ run: true })),
      optOut: costOptOut({ loadConnectionLibrary: async () => ({ ok: false, error: 'none' }), setBigQueryCostPrompt: async () => ({ ok: true, value: true }) }),
      connectionForResult: (_tabId, resultId) => resultId === 42 ? uuid(11) : undefined
    })

    const estimated = await cost.estimateRemote(doc.id, { resultId: 42, generation: 1, kind: 'sample', rows: 100, method: 'first' })
    expect(estimated?.bytesProcessed).toBe(1024)
    expect(dryRun).toHaveBeenCalledWith(expect.objectContaining({ connectionId: uuid(11) }))

    const approved = await cost.beforeRemote(doc.id, { resultId: 42, generation: 1, kind: 'view', sort: [] })
    expect(approved?.bytesProcessed).toBe(1024)
    cost.dispose()
  })
})

describe('Wave 2a: Language services via languageContext & Cross-Engine File diagnostics suspension', () => {
  it('resolves multiTargets via languageContext in SqlLanguageService, IndexCompletionService, and suspends SqlDiagnosticsService in File mode', () => {
    const f = documentFixture()
    const doc = f.documents.openMultiQuery({
      mode: 'cross',
      targets: [
        { targetId: uuid(1), connectionId: uuid(10), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: uuid(2), connectionId: uuid(11), database: 'analytics', enabled: true, provider: 'bigquery', attachWanted: true }
      ],
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2'
    })
    const primary = f.documents.getModel(doc.id)!
    const secondary = f.documents.getSecondaryModel(doc.id)!
    expect(f.documents.languageContext(primary, () => true)).toEqual({
      documentId: doc.id, provider: 'sqlserver', connectionId: uuid(10), database: 'Sales'
    })
    expect(f.documents.languageContext(secondary, () => true)).toEqual({
      documentId: doc.id, provider: 'bigquery', connectionId: uuid(11), database: 'analytics'
    })

    const conns = [
      { id: uuid(10), server: 'sql-1', database: 'Sales', serverVersion: '16.0', generation: 1, providerId: 'sqlserver' as const, options: { server: 'sql-1', database: 'Sales', authentication: 'sql' as const, trustServerCertificate: false } },
      { id: uuid(11), server: 'bq-1', database: 'analytics', serverVersion: '', generation: 1, providerId: 'bigquery' as const, options: { provider: 'bigquery' as const, project: 'bq-1', authentication: 'gcloud' as const } }
    ]
    const connStore = Object.assign(new SnapshotStore(conns), {
      get: (id: string) => conns.find(c => c.id === id),
      isLive: (id: string) => conns.some(c => c.id === id)
    })
    const monacoMock = {
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
      editor: { setModelMarkers: vi.fn() },
      languages: {
        registerCompletionItemProvider: vi.fn(() => ({ dispose() {} })),
        registerHoverProvider: vi.fn(() => ({ dispose() {} })),
        registerDefinitionProvider: vi.fn(() => ({ dispose() {} }))
      }
    } as unknown as typeof Monaco
    const sqlLang = new SqlLanguageService(
      monacoMock,
      {
        languageStatus: vi.fn(async () => ({ ok: true as const, value: { providers: [{ id: 'sqlserver' as const, configured: true, completion: true, hover: true, refresh: true, diagnostics: true }] } })),
        languageComplete: vi.fn(async () => ({ ok: true as const, value: { isIncomplete: false, items: [] } })),
        languageHover: vi.fn(async () => ({ ok: true as const, value: null })),
        languageClose: vi.fn(async () => ({ ok: true as const, value: { closed: true } })),
        languageRefresh: vi.fn(async () => ({ ok: true as const, value: { refreshed: true } })),
        languageDiagnostics: vi.fn(async () => ({ ok: true as const, value: { version: 1, isIncomplete: false, items: [] } }))
      },
      f.documents,
      connStore as never
    )
    const diag = new SqlDiagnosticsService(
      monacoMock,
      sqlLang,
      f.documents,
      connStore as never,
      { enabled: () => true, subscribe: () => () => {} }
    )
    const idxComp = new IndexCompletionService(
      monacoMock,
      { languageLookup: vi.fn(async () => ({ ok: true as const, value: { index: 'ready' as const, answers: [] } })) },
      f.documents,
      connStore as never,
      { ensureIndex: vi.fn() }
    )

    // In Cross-Engine Split mode with secondary pane active, IndexCompletionService reports live BigQuery availability.
    f.documents.setActivePane(doc.id, 'secondary')
    expect(idxComp.availability(doc.id)?.label).toBe('IntelliSense')

    // Switching to Cross-Engine File mode suspends SqlDiagnosticsService with a calm message.
    f.documents.setCrossView(doc.id, 'file')
    expect(diag.getSnapshot().documents.get(doc.id)?.phase).toBe('paused')
    expect(diag.getSnapshot().documents.get(doc.id)?.detail).toContain('Split view')
    expect(sqlLang.availability(doc.id).label).toBe('IntelliSense paused')

    idxComp.dispose()
    diag.dispose()
    sqlLang.dispose()
  })

  it('disconnect-workbench wires multiMode, multiTargets, and executionVersion into DisconnectCoordinator', async () => {
    const f = documentFixture()
    const registry = new ConnectionTargetService()
    registry.markLostBefore(1)
    registry.add({ id: uuid(1), options: connectionTargetOptions({ server: 'sql-1', database: 'Sales', authentication: 'sql', username: 'u', trustServerCertificate: false }), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true })
    registry.completeConnect(registry.beginConnect(uuid(1), 1, uuid(50))!, { id: uuid(10), generation: 1 }, { principal: { provider: 'sqlserver', authentication: 'sql', id: 'u' } })
    const doc = f.documents.openMultiQuery({
      mode: 'same',
      targets: [{ targetId: uuid(1), connectionId: uuid(10), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true }]
    })
    let execVersion = 0
    const coordinator = createDisconnectCoordinator({
      connectionTargets: registry,
      documents: f.documents,
      queries: {
        getSnapshot: () => ({}),
        isRunning: () => false,
        executionVersion: () => execVersion,
        prepareSessions: vi.fn(async () => ({ plan: new Map(), stopping: [], current: () => true })),
        cancelPreparedSessions: vi.fn(async () => {}),
        sessionNote: vi.fn()
      },
      files: { prepareQueryClose: vi.fn(), validateQueryClose: vi.fn() },
      longRuns: { disconnectRefusal: () => undefined },
      prompts: { request: vi.fn(async () => 'keep-tabs' as const) } as never,
      api: { disconnect: vi.fn(async () => ({ ok: true as const, value: { disconnected: true } })) },
      detached: vi.fn(),
      closeQueries: vi.fn()
    })
    expect(doc.multiMode).toBe('same')
    expect(await coordinator.disconnect(uuid(1))).toEqual({ status: 'disconnected', closed: [], removed: false })
    expect(execVersion).toBe(0)
  })
})

describe('Wave 2 Domain 1 Round 1 adversarial regression checks', () => {
  it('Finding 1: PreparedSessions.current() tracks only participating operation handles and rejects undefined generation', async () => {
    const f = documentFixture()
    const events = new EventBus()
    const doc = f.documents.openMultiQuery({
      mode: 'same',
      targets: [
        { targetId: uuid(1), connectionId: uuid(10), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: uuid(2), connectionId: uuid(11), database: 'Sales', enabled: false, provider: 'sqlserver', attachWanted: true }
      ],
      sql: 'SELECT 1'
    })
    const conns = new Map<string, { id: string; server: string; database: string; serverVersion: string; generation: number; providerId: 'sqlserver'; targetId: string; lost?: true }>([
      [uuid(10), { id: uuid(10), server: 'sql-1', database: 'Sales', serverVersion: '16.0', generation: 1, providerId: 'sqlserver', targetId: uuid(1) }],
      [uuid(11), { id: uuid(11), server: 'sql-2', database: 'Sales', serverVersion: '16.0', generation: 1, providerId: 'sqlserver', targetId: uuid(2), lost: true }]
    ])
    const execDeferred = deferred<{ ok: true; value: QueryMultiResult }>()
    const queries = new QueryService(
      f.documents,
      {
        execute: vi.fn(),
        executeMulti: vi.fn(() => execDeferred.promise),
        cancel: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } })),
        confirmSessions: vi.fn(async () => ({ ok: true as const, value: 'proceed' as const })),
        querySessionState: vi.fn(async () => ({ ok: true as const, value: { transactionCount: 0, checked: true } }))
      },
      id => conns.get(id),
      events,
      { begin: vi.fn(), finish: vi.fn() }
    )

    const runPromise = queries.executeMulti(doc.id, { mode: 'fireAndForget' })
    // Non-participating target uuid(11) is lost, yet prepared.current() must stay true.
    const prepared = await queries.prepareSessions('disconnect', [doc.id])
    expect(prepared?.current()).toBe(true)
    conns.set(uuid(11), { ...conns.get(uuid(11))!, generation: 99, lost: true })
    expect(prepared?.current()).toBe(true)

    // Participating target uuid(10) lost or deleted must invalidate current().
    conns.set(uuid(10), { ...conns.get(uuid(10))!, lost: true })
    expect(prepared?.current()).toBe(false)
    conns.delete(uuid(10))
    expect(prepared?.current()).toBe(false)

    // If participating handle was already missing at prepare time (generation === undefined), current() must never be vacuously true.
    const stalePrepared = await queries.prepareSessions('disconnect', [doc.id])
    expect(stalePrepared?.current()).toBe(false)

    execDeferred.resolve({
      ok: true,
      value: {
        status: 'cancelled', mode: 'fireAndForget', targets: [], resultSets: [], discardedResultSets: 0,
        messages: [], messagesTruncated: false, elapsedMs: 1,
        budget: { usedBytes: 0, globalBytes: 1024, queryBytes: 1024, generation: 1, seq: 1 },
        completedAt: '2026-11-26T00:00:00.0000000Z'
      }
    })
    await runPromise
    queries.dispose()
  })

  it('Finding 2: disconnect-workbench populates runningConnectionIds from queries.getSnapshot()', async () => {
    const f = documentFixture()
    const registry = new ConnectionTargetService()
    registry.markLostBefore(1)
    registry.add({ id: uuid(1), options: connectionTargetOptions({ server: 'sql-1', database: 'Sales', authentication: 'sql', username: 'u', trustServerCertificate: false }), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true })
    registry.completeConnect(registry.beginConnect(uuid(1), 1, uuid(50))!, { id: uuid(10), generation: 1 }, { principal: { provider: 'sqlserver', authentication: 'sql', id: 'u' } })
    const doc = f.documents.openMultiQuery({
      mode: 'same',
      // Target 1 was already removed from multiTargets while the query is still running on uuid(10).
      targets: [{ targetId: uuid(2), connectionId: uuid(11), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true }]
    })
    let running = true
    const prepareSessions = vi.fn(async () => ({ plan: new Map(), stopping: [{ id: doc.id, queryId: 'q1' }], current: () => true }))
    const cancelPreparedSessions = vi.fn(async () => { running = false })
    const coordinator = createDisconnectCoordinator({
      connectionTargets: registry,
      documents: f.documents,
      queries: {
        getSnapshot: () => running ? { [doc.id]: { running: { queryId: 'q1', connectionId: uuid(10), connectionIds: [uuid(10), uuid(11)], multi: true, startedAt: 1 } } } : {},
        isRunning: () => running,
        executionVersion: () => 1,
        prepareSessions,
        cancelPreparedSessions,
        sessionNote: vi.fn()
      },
      files: { prepareQueryClose: vi.fn(), validateQueryClose: vi.fn() },
      longRuns: { disconnectRefusal: () => undefined },
      prompts: { request: vi.fn(async () => 'keep-tabs' as const) } as never,
      api: { disconnect: vi.fn(async () => ({ ok: true as const, value: { disconnected: true } })) },
      detached: vi.fn(),
      closeQueries: vi.fn()
    })
    expect(await coordinator.disconnect(uuid(1))).toEqual({ status: 'disconnected', closed: [], removed: false })
    expect(prepareSessions).toHaveBeenCalledWith('disconnect', [doc.id])
    expect(cancelPreparedSessions).toHaveBeenCalledTimes(1)
  })

  it('Finding 3: guards setCrossView while busy and keeps document dirty if view changes during save()', async () => {
    const f = documentFixture()
    const doc = f.documents.openMultiQuery({
      mode: 'cross',
      targets: [],
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2',
      unsaved: true
    })

    // 1. setCrossView refuses while busy.
    await f.documents.runTask(async () => {
      expect(f.documents.setCrossView(doc.id, 'file')).toEqual({
        ok: false,
        reason: 'Wait for the current document operation to finish before switching views.'
      })
    })
    expect(f.documents.get(doc.id)?.crossView).toBe('split')

    // 2. If view changes while saveSqlFile is in flight (e.g. Split -> File -> Split), save() leaves savedVersionId null and dirty true.
    const saveGate = deferred<{ ok: true; value: { id: string; name: string; path: string; encoding: 'utf8'; readOnly: false } }>()
    f.api.saveSqlFile.mockReturnValueOnce(saveGate.promise)
    const saving = f.documents.save(doc.id)
    expect(f.documents.setCrossView(doc.id, 'file')).toEqual({ ok: true })
    expect(f.documents.setCrossView(doc.id, 'split')).toEqual({ ok: true })
    saveGate.resolve({ ok: true, value: { id: uuid(90), name: 'cross.sql', path: 'cross.sql', encoding: 'utf8', readOnly: false } })
    expect(await saving).toBe(true)
    expect(f.documents.get(doc.id)?.savedVersionId).toBeNull()
    expect(f.documents.get(doc.id)?.dirty).toBe(true)
    // Secondary model must also remain dirty even if edited back.
    const sec = f.documents.getSecondaryModel(doc.id) as unknown as TestModel
    sec.edit('SELECT 20')
    expect(f.documents.get(doc.id)?.dirty).toBe(true)
  })

  it('Finding 4: QueryService.execute() and estimate() return cleanly on multiMode tabs without crashing', async () => {
    const f = documentFixture()
    const events = new EventBus()
    const doc = f.documents.openMultiQuery({
      mode: 'same',
      targets: [{ targetId: uuid(1), connectionId: uuid(10), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true }],
      sql: 'SELECT 1'
    })
    const execute = vi.fn()
    const estimatePlan = vi.fn()
    const queries = new QueryService(
      f.documents,
      {
        execute,
        estimatePlan,
        cancel: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } })),
        confirmSessions: vi.fn(async () => ({ ok: true as const, value: 'proceed' as const })),
        querySessionState: vi.fn(async () => ({ ok: true as const, value: { transactionCount: 0, checked: true } }))
      },
      id => id === uuid(10) ? { id: uuid(10), server: 'sql-1', database: 'Sales', serverVersion: '16.0', generation: 1, providerId: 'sqlserver' as const } : undefined,
      events,
      { begin: vi.fn(), finish: vi.fn() }
    )
    expect(queries.canExecute(doc.id)).toBe(true)
    await expect(queries.execute(doc.id)).resolves.toBeUndefined()
    await expect(queries.estimate(doc.id)).resolves.toBeUndefined()
    expect(execute).not.toHaveBeenCalled()
    expect(estimatePlan).not.toHaveBeenCalled()
    expect(queries.executionVersion(doc.id)).toBe(0)
    queries.dispose()
  })

  it('Finding 5: runMulti sanitizes labels and SQL Server databases, rejects >32 targets, and reports stale request.targets explicitly', async () => {
    const f = documentFixture()
    const events = new EventBus()
    const executeMulti = vi.fn(async (_opts: MultiQueryOptions) => ({
      ok: true as const,
      value: {
        status: 'completed' as const, mode: 'fireAndForget' as const, targets: [], resultSets: [], discardedResultSets: 0,
        messages: [], messagesTruncated: false, elapsedMs: 1,
        budget: { usedBytes: 0, globalBytes: 1024, queryBytes: 1024, generation: 1, seq: 1 },
        completedAt: '2026-11-26T00:00:00.0000000Z'
      }
    }))
    const finishes: MultiRunEnd[] = []
    const results: MultiResultsSink = {
      begin: vi.fn(),
      finish: vi.fn((_tabId, _queryId, end) => { finishes.push(end) })
    }
    const conns = new Map<string, { id: string; server: string; displayName?: string; database: string; serverVersion: string; generation: number; providerId: 'sqlserver' }>()
    for (let i = 1; i <= 33; i++) {
      conns.set(uuid(100 + i), { id: uuid(100 + i), server: `srv-${i}`, database: 'master', serverVersion: '16.0', generation: 1, providerId: 'sqlserver' })
    }
    conns.set(uuid(201), { id: uuid(201), server: '\u0000\u200B  \t\u2028', displayName: '\u200B\r\n   ', database: '   ', serverVersion: '16.0', generation: 1, providerId: 'sqlserver' })
    conns.set(uuid(202), { id: uuid(202), server: 'A'.repeat(150), database: `  ${'D'.repeat(150)}  `, serverVersion: '16.0', generation: 1, providerId: 'sqlserver' })

    const queries = new QueryService(
      f.documents,
      {
        execute: vi.fn(),
        executeMulti,
        cancel: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } })),
        confirmSessions: vi.fn(async () => ({ ok: true as const, value: 'proceed' as const })),
        querySessionState: vi.fn(async () => ({ ok: true as const, value: { transactionCount: 0, checked: true } }))
      },
      id => conns.get(id),
      events,
      results
    )

    // 1. Label sanitization (control chars stripped, fallback to 'Server', capped at 128) & SQL Server database sanitization (preserves leading/trailing spaces verbatim up to 128, whitespace-only falls back to 'master').
    const doc = f.documents.openMultiQuery({
      mode: 'same',
      targets: [
        { targetId: uuid(1), connectionId: uuid(201), database: '   ', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: uuid(2), connectionId: uuid(202), database: `  ${'D'.repeat(150)}  `, enabled: true, provider: 'sqlserver', attachWanted: true }
      ],
      sql: 'SELECT 1'
    })
    await queries.executeMulti(doc.id, { mode: 'fireAndForget' })
    expect(executeMulti).toHaveBeenCalledTimes(1)
    const sentTargets = executeMulti.mock.calls[0]![0].targets
    expect(sentTargets[0]).toMatchObject({ label: 'Server', database: 'master' })
    expect(sentTargets[1]).toMatchObject({ label: 'A'.repeat(128), database: `  ${'D'.repeat(126)}` })

    // 2. Reject > 32 targets locally with an explicit error and zero IPC.
    executeMulti.mockClear()
    finishes.length = 0
    const tooManyDoc = f.documents.openMultiQuery({
      mode: 'same',
      targets: Array.from({ length: 33 }, (_, i) => ({
        targetId: uuid(100 + i + 1), connectionId: uuid(100 + i + 1), database: 'master', enabled: true, provider: 'sqlserver' as const, attachWanted: true
      })),
      sql: 'SELECT 1'
    })
    await queries.executeMulti(tooManyDoc.id, { mode: 'fireAndForget' })
    expect(executeMulti).not.toHaveBeenCalled()
    expect(finishes[0]).toMatchObject({ code: 'INVALID_PARAMS', error: expect.stringContaining('32') })
    expect(queries.getSnapshot()[tooManyDoc.id]?.error).toContain('32')

    // 3. Stale target in request.targets reports explicit NOT_CONNECTED error instead of silent undefined.
    finishes.length = 0
    await queries.executeMulti(doc.id, {
      mode: 'fireAndForget',
      targets: [{ targetKey: uuid(99), connectionId: uuid(999), label: 'OfflineSrv', database: 'Sales' }]
    })
    expect(executeMulti).not.toHaveBeenCalled()
    expect(finishes[0]).toMatchObject({ code: 'NOT_CONNECTED', error: expect.stringContaining('OfflineSrv') })
    expect(queries.getSnapshot()[doc.id]?.error).toContain('OfflineSrv')
    queries.dispose()
  })

  it('Finding 6: transitions non-terminal targets to failed on IPC error without multiSummary and falls back to endedStatus in query-status', async () => {
    const f = documentFixture()
    const events = new EventBus()
    const doc = f.documents.openMultiQuery({
      mode: 'same',
      targets: [
        { targetId: uuid(1), connectionId: uuid(10), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: uuid(2), connectionId: uuid(11), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true }
      ],
      sql: 'SELECT 1'
    })
    const conns = new Map([
      [uuid(10), { id: uuid(10), server: 'sql-1', database: 'Sales', serverVersion: '16.0', generation: 1, providerId: 'sqlserver' as const, targetId: uuid(1) }],
      [uuid(11), { id: uuid(11), server: 'sql-2', database: 'Sales', serverVersion: '16.0', generation: 1, providerId: 'sqlserver' as const, targetId: uuid(2) }]
    ])
    let beginOpts: BeginRunOptions | undefined
    const execDeferred = deferred<{ ok: false; error: string; code: 'BACKEND_LOST' }>()
    const queries = new QueryService(
      f.documents,
      {
        execute: vi.fn(),
        executeMulti: vi.fn(() => execDeferred.promise),
        cancel: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } })),
        confirmSessions: vi.fn(async () => ({ ok: true as const, value: 'proceed' as const })),
        querySessionState: vi.fn(async () => ({ ok: true as const, value: { transactionCount: 0, checked: true } }))
      },
      id => conns.get(id),
      events,
      { begin: vi.fn((_t, _q, _s, opts) => { beginOpts = opts }), finish: vi.fn() }
    )

    const runPromise = queries.executeMulti(doc.id, { mode: 'fireAndForget' })
    beginOpts?.onTargetState?.({ type: 'multiQuery.targetState', targetKey: uuid(1), phase: 'succeeded', batchesCompleted: 1, batchesTotal: 1, rowsAffected: 1, resultSetCount: 1, elapsedMs: 10 })
    beginOpts?.onTargetState?.({ type: 'multiQuery.targetState', targetKey: uuid(2), phase: 'running', batchesCompleted: 0, batchesTotal: 1, rowsAffected: 0, resultSetCount: 0, elapsedMs: 12 })
    execDeferred.resolve({ ok: false, error: 'Backend disconnected unexpectedly.', code: 'BACKEND_LOST' })
    await runPromise

    const targets = queries.getSnapshot()[doc.id]?.multiTargets
    expect(targets?.[0]).toMatchObject({ targetKey: uuid(1), phase: 'succeeded' })
    expect(targets?.[1]).toMatchObject({ targetKey: uuid(2), phase: 'failed', errorCode: 'BACKEND_LOST', errorMessage: 'Backend disconnected unexpectedly.' })

    // queryStatusModel uses endedStatus when multiStatus is absent and run ended (instead of showing multi.ready).
    const failedStatus = queryStatusModel({
      database: '',
      running: false,
      multiMode: 'same',
      multiTargets: [{ provider: 'sqlserver', connected: true, enabled: true }],
      run: { status: 'failed', startedAt: 100, endedAt: 200, rowsRead: 0 },
      now: 500,
      settings: statusSettings
    })
    expect(failedStatus.tone).toBe('error')
    expect(failedStatus.icon).toBe('error')
    expect(failedStatus.text).not.toContain('Ready')

    const closedCancelled = queryStatusModel({
      database: '',
      running: false,
      multiMode: 'same',
      multiTargets: [{ provider: 'sqlserver', connected: true, enabled: true }],
      run: { status: 'closed', closedFrom: 'cancelled', startedAt: 100, endedAt: 200, rowsRead: 0 },
      now: 500,
      settings: statusSettings
    })
    expect(closedCancelled.tone).toBe('error')
    expect(closedCancelled.icon).toBe('debug-stop')
    queries.dispose()
  })

  it('Finding 7: refuseReadOnly is ignored while running or while documents are busy', async () => {
    const f = documentFixture()
    const events = new EventBus()
    const doc = f.documents.openMultiQuery({
      mode: 'cross',
      targets: [
        { targetId: uuid(1), connectionId: uuid(10), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: uuid(2), connectionId: uuid(11), database: 'ds', enabled: true, provider: 'bigquery', attachWanted: true }
      ],
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2'
    })
    const conns = new Map([
      [uuid(10), { id: uuid(10), server: 'sql-1', database: 'Sales', serverVersion: '16.0', generation: 1, providerId: 'sqlserver' as const }],
      [uuid(11), { id: uuid(11), server: 'bq-1', database: 'ds', serverVersion: '', generation: 1, providerId: 'bigquery' as const }]
    ])
    const begin = vi.fn()
    const finish = vi.fn()
    const execDeferred = deferred<{ ok: true; value: QueryMultiResult }>()
    const queries = new QueryService(
      f.documents,
      {
        execute: vi.fn(),
        executeMulti: vi.fn(() => execDeferred.promise),
        cancel: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } })),
        confirmSessions: vi.fn(async () => ({ ok: true as const, value: 'proceed' as const })),
        querySessionState: vi.fn(async () => ({ ok: true as const, value: { transactionCount: 0, checked: true } }))
      },
      id => conns.get(id),
      events,
      { begin, finish }
    )

    // 1. Busy document task guards refuseReadOnly.
    await f.documents.runTask(async () => {
      queries.refuseReadOnly(doc.id, [{ line: 1, message: 'DELETE blocked', dialect: 'sqlserver' }])
    })
    expect(begin).not.toHaveBeenCalled()

    // 2. Running query guards refuseReadOnly.
    const runPromise = queries.executeMulti(doc.id, { mode: 'crossEngineReadOnly' })
    expect(begin).toHaveBeenCalledTimes(1)
    queries.refuseReadOnly(doc.id, [{ line: 1, message: 'DELETE blocked', dialect: 'sqlserver' }])
    expect(begin).toHaveBeenCalledTimes(1)
    expect(finish).not.toHaveBeenCalled()

    execDeferred.resolve({
      ok: true,
      value: {
        status: 'completed', mode: 'crossEngineReadOnly', targets: [], resultSets: [], discardedResultSets: 0,
        messages: [], messagesTruncated: false, elapsedMs: 1,
        budget: { usedBytes: 0, globalBytes: 1024, queryBytes: 1024, generation: 1, seq: 1 },
        completedAt: '2026-11-26T00:00:00.0000000Z'
      }
    })
    await runPromise
    queries.dispose()
  })

  it('Finding 8: openMultiQuery preserves bigQuerySql when crossView is file and sql is non-empty', () => {
    const f = documentFixture()
    const doc = f.documents.openMultiQuery({
      mode: 'cross',
      crossView: 'file',
      targets: [],
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2',
      eol: 'crlf'
    })
    expect(doc.crossView).toBe('file')
    expect(f.documents.getSecondaryModel(doc.id)).toBeUndefined()
    expect(f.documents.getModel(doc.id)?.getValue()).toBe(serializeCrossEngineSql('SELECT 1', 'SELECT 2', '\r\n'))
  })

  it('Finding 9: TargetService single-server mutators return early on multiMode tabs', async () => {
    const f = documentFixture()
    const confirmSessions = vi.fn(async () => new Map())
    const reportError = vi.fn()
    const targets = new TargetService(
      f.documents,
      { isRunning: () => false, mayHaveTransaction: async () => false, confirmSessions },
      { get: id => id === uuid(10) ? { id: uuid(10), server: 'sql-1', database: 'Sales', generation: 1 } as never : undefined },
      { clearError: () => {}, reportError }
    )
    const doc = f.documents.openMultiQuery({
      mode: 'same',
      targets: [{ targetId: uuid(1), connectionId: uuid(10), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true }]
    })

    targets.update(doc.id, { connectionId: uuid(10), database: 'OtherDb', targetId: uuid(1), attachWanted: true })
    await targets.changeConnection(doc.id, uuid(10))
    targets.changeDatabase(doc.id, 'OtherDb')

    const after = f.documents.get(doc.id)!
    expect(after.connectionId).toBeUndefined()
    expect(after.targetId).toBeUndefined()
    expect(after.database).toBe('')
    expect(after.attachWanted).toBeUndefined()
    expect(confirmSessions).not.toHaveBeenCalled()
    expect(reportError).not.toHaveBeenCalled()
    expect(f.api.closeQuerySession).not.toHaveBeenCalled()
  })
})

describe('Wave 2 Domain 1 Round 2 adversarial regression checks', () => {
  it('R2 Finding 2 & 10: refuseReadOnly clears stale multiSummary/multiTargets and consumes an active pre-dispatch multi gate', async () => {
    const f = documentFixture()
    const events = new EventBus()
    const doc = f.documents.openMultiQuery({
      mode: 'cross',
      targets: [
        { targetId: uuid(1), connectionId: uuid(10), database: 'Sales', enabled: true, provider: 'sqlserver', attachWanted: true },
        { targetId: uuid(2), connectionId: uuid(11), database: 'ds', enabled: true, provider: 'bigquery', attachWanted: true }
      ],
      sql: 'SELECT 1',
      bigQuerySql: 'SELECT 2'
    })
    const conns = new Map([
      [uuid(10), { id: uuid(10), server: 'sql-1', database: 'Sales', serverVersion: '16.0', generation: 1, providerId: 'sqlserver' as const }],
      [uuid(11), { id: uuid(11), server: 'bq-1', database: 'ds', serverVersion: '', generation: 1, providerId: 'bigquery' as const }]
    ])
    const queries = new QueryService(
      f.documents,
      {
        execute: vi.fn(),
        executeMulti: vi.fn(async () => ({
          ok: true as const,
          value: {
            status: 'completed' as const, mode: 'crossEngineReadOnly' as const,
            targets: [
              { targetKey: uuid(1), provider: 'sqlserver' as const, label: 'sql-1', status: 'succeeded' as const, batchesCompleted: 1, batchesTotal: 1, rowsAffected: 1, elapsedMs: 5, resultSetIds: [] },
              { targetKey: uuid(2), provider: 'bigquery' as const, label: 'bq-1', status: 'succeeded' as const, batchesCompleted: 1, batchesTotal: 1, rowsAffected: 1, elapsedMs: 5, resultSetIds: [] }
            ],
            resultSets: [], discardedResultSets: 0, messages: [], messagesTruncated: false, elapsedMs: 10,
            budget: { usedBytes: 0, globalBytes: 1024, queryBytes: 1024, generation: 1, seq: 1 },
            completedAt: '2026-11-26T00:00:00.0000000Z'
          }
        })),
        cancel: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } })),
        confirmSessions: vi.fn(async () => ({ ok: true as const, value: 'proceed' as const })),
        querySessionState: vi.fn(async () => ({ ok: true as const, value: { transactionCount: 0, checked: true } }))
      },
      id => conns.get(id),
      events,
      { begin: vi.fn(), finish: vi.fn() }
    )

    await queries.executeMulti(doc.id, { mode: 'crossEngineReadOnly' })
    expect(queries.getSnapshot()[doc.id]?.multiSummary?.status).toBe('completed')
    expect(queries.getSnapshot()[doc.id]?.multiTargets).toHaveLength(2)

    // Begin pre-dispatch gate (does NOT bump executionVersion), then refuseReadOnly consumes it and clears stale completed state.
    const versionBefore = queries.executionVersion(doc.id)
    const signal = queries.beginMultiGate(doc.id)
    expect(signal).toBeDefined()
    expect(queries.isRunning(doc.id)).toBe(true)
    expect(queries.isGated(doc.id)).toBe(true)
    expect(queries.executionVersion(doc.id)).toBe(versionBefore)

    queries.refuseReadOnly(doc.id, [{ line: 1, message: 'DELETE blocked', dialect: 'sqlserver' }])
    // Ending the gate in a finally block must NOT overwrite the refusal error with the pre-gate completed state.
    queries.endMultiGate(doc.id, true, signal)

    const after = queries.getSnapshot()[doc.id]
    expect(after?.running).toBeUndefined()
    expect(after?.multiSummary).toBeUndefined()
    expect(after?.multiTargets).toBeUndefined()
    expect(after?.error).toContain('READ_ONLY_VIOLATION')
    queries.dispose()
  })

  it('R2 Finding 3: runMulti resolves each target timeout against global default and preserves 0 (no timeout)', async () => {
    const f = documentFixture()
    const events = new EventBus()
    const executeMulti = vi.fn(async (_opts: MultiQueryOptions) => ({
      ok: true as const,
      value: {
        status: 'completed' as const, mode: 'fireAndForget' as const, targets: [], resultSets: [], discardedResultSets: 0,
        messages: [], messagesTruncated: false, elapsedMs: 1,
        budget: { usedBytes: 0, globalBytes: 1024, queryBytes: 1024, generation: 1, seq: 1 },
        completedAt: '2026-11-26T00:00:00.0000000Z'
      }
    }))
    const conns = new Map([
      [uuid(10), { id: uuid(10), server: 'sql-1', database: 'Sales', serverVersion: '16.0', generation: 1, providerId: 'sqlserver' as const, options: { advanced: { commandTimeout: 10 } } }],
      [uuid(11), { id: uuid(11), server: 'sql-2', database: 'Sales', serverVersion: '16.0', generation: 1, providerId: 'sqlserver' as const }],
      [uuid(12), { id: uuid(12), server: 'sql-3', database: 'Sales', serverVersion: '16.0', generation: 1, providerId: 'sqlserver' as const, options: { advanced: { commandTimeout: 0 } } }]
    ])
    const queries = new QueryService(
      f.documents,
      { execute: vi.fn(), executeMulti, cancel: vi.fn(), confirmSessions: vi.fn(), querySessionState: vi.fn() },
      id => conns.get(id),
      events,
      { begin: vi.fn(), finish: vi.fn() },
      () => 1000,
      async () => {},
      () => ({ ...defaultSettings, 'queryExecution.executionTimeout': 45 })
    )

    // Case 1: Target 1 has explicit 10s, Target 2 inherits global 45s -> effective max is 45s (not shrunk to 10s).
    const doc1 = f.documents.openMultiQuery({
      mode: 'same',
      sql: 'SELECT 1',
      targets: [
        { targetId: uuid(1), connectionId: uuid(10), database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: uuid(2), connectionId: uuid(11), database: 'Sales', enabled: true, provider: 'sqlserver' }
      ]
    })
    await queries.executeMulti(doc1.id, { mode: 'fireAndForget' })
    expect(executeMulti.mock.calls[0]![0].timeoutSeconds).toBe(45)

    // Case 2: Target 3 has 0 (no timeout) alongside Target 2 (45s) -> combined timeoutSeconds is 0.
    const doc2 = f.documents.openMultiQuery({
      mode: 'same',
      sql: 'SELECT 1',
      targets: [
        { targetId: uuid(2), connectionId: uuid(11), database: 'Sales', enabled: true, provider: 'sqlserver' },
        { targetId: uuid(3), connectionId: uuid(12), database: 'Sales', enabled: true, provider: 'sqlserver' }
      ]
    })
    await queries.executeMulti(doc2.id, { mode: 'fireAndForget' })
    expect(executeMulti.mock.calls[1]![0].timeoutSeconds).toBe(0)

    // Case 3: Explicit request.targets path also respects 0 (no timeout).
    await queries.executeMulti(doc2.id, {
      mode: 'fireAndForget',
      targets: [
        { targetKey: uuid(3), connectionId: uuid(12), label: 'sql-3', database: 'Sales' },
        { targetKey: uuid(1), connectionId: uuid(10), label: 'sql-1', database: 'Sales' }
      ]
    })
    expect(executeMulti.mock.calls[2]![0].timeoutSeconds).toBe(0)
    queries.dispose()
  })

  it('R2 Finding 4: setCrossView clears dirty on an emptied untitled Cross-Engine tab instead of keeping it falsely dirty', () => {
    const f = documentFixture()
    const doc = f.documents.openMultiQuery({
      mode: 'cross',
      crossView: 'file',
      targets: [],
      sql: serializeCrossEngineSql('SELECT 1', 'SELECT 2'),
      unsaved: true
    })
    expect(f.documents.get(doc.id)?.dirty).toBe(true)

    // Empty both sections in File view, then switch to Split view: both panes are empty in an untitled tab -> clean!
    f.model(doc.id).edit(serializeCrossEngineSql('', ''))
    expect(f.documents.setCrossView(doc.id, 'split')).toEqual({ ok: true })
    expect(f.documents.getModel(doc.id)?.getValue()).toBe('')
    expect(f.documents.getSecondaryModel(doc.id)?.getValue()).toBe('')
    expect(f.documents.get(doc.id)?.dirty).toBe(false)
  })

  it('R2 Finding 7: cleanSqlServerDatabase preserves valid leading/trailing spaces on SQL Server database names', async () => {
    const f = documentFixture()
    const events = new EventBus()
    const executeMulti = vi.fn(async (_opts: MultiQueryOptions) => ({
      ok: true as const,
      value: {
        status: 'completed' as const, mode: 'fireAndForget' as const, targets: [], resultSets: [], discardedResultSets: 0,
        messages: [], messagesTruncated: false, elapsedMs: 1,
        budget: { usedBytes: 0, globalBytes: 1024, queryBytes: 1024, generation: 1, seq: 1 },
        completedAt: '2026-11-26T00:00:00.0000000Z'
      }
    }))
    const queries = new QueryService(
      f.documents,
      { execute: vi.fn(), executeMulti, cancel: vi.fn(), confirmSessions: vi.fn(), querySessionState: vi.fn() },
      id => id === uuid(10) ? { id: uuid(10), server: 'sql-1', database: ' LeadingDb ', serverVersion: '16.0', generation: 1, providerId: 'sqlserver' as const } : undefined,
      events,
      { begin: vi.fn(), finish: vi.fn() }
    )
    const doc = f.documents.openMultiQuery({
      mode: 'same',
      sql: 'SELECT 1',
      targets: [{ targetId: uuid(1), connectionId: uuid(10), database: ' LeadingDb ', enabled: true, provider: 'sqlserver' }]
    })
    await queries.executeMulti(doc.id, { mode: 'fireAndForget' })
    expect(executeMulti.mock.calls[0]![0].targets[0]?.database).toBe(' LeadingDb ')

    await queries.executeMulti(doc.id, {
      mode: 'fireAndForget',
      targets: [{ targetKey: uuid(1), connectionId: uuid(10), label: 'sql-1', database: ' Spaced ' }]
    })
    expect(executeMulti.mock.calls[1]![0].targets[0]?.database).toBe(' Spaced ')
    queries.dispose()
  })
})
