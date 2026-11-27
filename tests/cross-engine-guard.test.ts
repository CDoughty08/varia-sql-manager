// @vitest-environment happy-dom
import { act, createElement, createRef, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { IDockviewPanelHeaderProps } from 'dockview-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseInfo } from '../src/shared/contracts'
import { serializeCrossEngineSql } from '../src/shared/multi-query'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import { SnapshotStore } from '../src/renderer/src/core/store'
import CrossEngineEditor, {
  crossEngineGuardDebounceMs,
  crossEngineGuardOwner,
  evaluateCrossEngineGuard,
  formatGuardSummary,
  toGuardMarkers
} from '../src/renderer/src/CrossEngineEditor'
import MultiTargetPopover, {
  canonicalDatabaseName,
  findSharedSqlDatabases,
  loadDatabaseListsBounded,
  maxMultiTargets,
  multiTargetTriggerSummary,
  requestMultiTargetPopover,
  resolveMultiTargets
} from '../src/renderer/src/MultiTargetPopover'
import QueryBar from '../src/renderer/src/QueryBar'
import StandardToolbar from '../src/renderer/src/ShellToolbar'
import QueryStatusBar from '../src/renderer/src/QueryStatusBar'
import GoToLineDialog from '../src/renderer/src/editor/GoToLineDialog'
import { BookmarkService, type BookmarkEditor, type BookmarkModel } from '../src/renderer/src/editor/bookmarks'
import { AreaContext, DocumentTab } from '../src/renderer/src/editor-groups/EditorArea'
import { dropVerdict, ServerDropService, verdicts, type ServerDrag } from '../src/renderer/src/editor-groups/server-drop'
import { placeOf } from '../src/renderer/src/editor-groups/ServerDropLayer'
import { EventBus } from '../src/renderer/src/core/events'
import { EditorDialogs } from '../src/renderer/src/editor/go-to-line'
import { EditorStatusService } from '../src/renderer/src/services/editor-status'
import { ConnectionTargetService } from '../src/renderer/src/services/connection-targets'
import { TargetService } from '../src/renderer/src/services/targets'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(clean => clean())
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function makeFakeEditor(container: HTMLElement) {
  let model: unknown = null
  let pos = { lineNumber: 1, column: 1 }
  let revealedLine: number | undefined
  let focused = 0
  const modelListeners = new Set<() => void>()
  const focusListeners = new Set<() => void>()
  const id = `fake-ed-${Math.random().toString(36).slice(2, 8)}`
  const instance = {
    getId: () => id,
    getModel: () => model,
    setModel: (next: unknown) => { model = next; modelListeners.forEach(fn => fn()) },
    getDomNode: () => container,
    getContainerDomNode: () => container,
    getPosition: () => pos,
    setPosition: vi.fn((next: { lineNumber: number; column: number }) => { pos = next }),
    revealLineInCenter: vi.fn((line: number) => { revealedLine = line }),
    revealLineInCenterIfOutsideViewport: vi.fn((line: number) => { revealedLine = line }),
    focus: vi.fn(() => { focused++ }),
    hasTextFocus: () => false,
    updateOptions: vi.fn(),
    saveViewState: () => null,
    restoreViewState: vi.fn(),
    getSelection: () => null,
    getContribution: () => undefined,
    onDidChangeModel: (fn: () => void) => { modelListeners.add(fn); return { dispose: () => modelListeners.delete(fn) } },
    onDidFocusEditorWidget: (fn: () => void) => { focusListeners.add(fn); return { dispose: () => focusListeners.delete(fn) } },
    onMouseUp: () => ({ dispose: () => {} }),
    onMouseMove: () => ({ dispose: () => {} }),
    onMouseLeave: () => ({ dispose: () => {} }),
    dispose: vi.fn()
  }
  return {
    instance,
    triggerFocusWidget: () => focusListeners.forEach(fn => fn()),
    getRevealed: () => revealedLine,
    getFocused: () => focused
  }
}

function uiFixture() {
  const value = workbenchFixture({ platform: 'win32' })
  const registry = new ConnectionTargetService()
  const targets = new TargetService(value.documents, value.queries, value.connections, value.files, registry)
  const theme = { subscribe: () => () => {}, getSnapshot: () => 0, accent: (color: string | undefined) => color ? `var(--varia-connection-${color})` : undefined }
  const editorStatus = new EditorStatusService(callback => callback())
  const editorDialogs = new EditorDialogs()
  const tabRename = new SnapshotStore({ id: '' })
  const menuTargets = { register: () => ({ dispose: () => {} }) }
  const gestures = { matches: () => false, modifiers: () => '', phrase: () => '' }
  const emptyEstimates = new Map()
  const bigQueryCost = { getSnapshot: () => emptyEstimates, subscribe: () => () => {}, status: () => undefined, asksAboveThreshold: () => true, thresholdFor: () => 1 }
  const panes = new SnapshotStore({ editor: true, explorer: true, results: true, messages: false, plan: false, statistics: false })
  const editorOptions = {
    monacoOptions: () => ({}),
    bindEditor: () => ({ dispose: () => {} }),
    getSnapshot: () => ({ wordWrap: false, whitespace: false, lineNumbers: true }),
    subscribe: () => () => {}
  }

  const createdEditors: ReturnType<typeof makeFakeEditor>[] = []
  const markerCalls: { model: unknown; owner: string; markers: unknown[] }[] = []
  const monaco = {
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    editor: {
      create: vi.fn((container: HTMLElement) => {
        const fake = makeFakeEditor(container)
        createdEditors.push(fake)
        return fake.instance
      }),
      setModelMarkers: vi.fn((model: unknown, owner: string, markers: unknown[]) => {
        markerCalls.push({ model, owner, markers })
      })
    }
  }

  cleanups.push(value.dispose, () => editorStatus.dispose(), () => editorDialogs.dispose())
  value.api.push(readyBackend())
  const workbench = {
    ...value,
    targets,
    theme,
    editorStatus,
    editorDialogs,
    tabRename,
    menuTargets,
    gestures,
    bigQueryCost,
    panes,
    editorOptions,
    monaco
  } as unknown as Workbench

  const mount = async (element: ReactElement) => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    cleanups.push(() => { act(() => { root.unmount() }); host.remove() })
    await act(async () => { root.render(createElement(WorkbenchProvider, { workbench, children: element })) })
    return {
      host,
      rerender: async (next: ReactElement) => { await act(async () => { root.render(createElement(WorkbenchProvider, { workbench, children: next })) }) }
    }
  }

  return { ...value, targets, registry, editorStatus, editorDialogs, workbench, monaco, createdEditors, markerCalls, mount }
}

function addSqlConnection(connections: ReturnType<typeof uiFixture>['connections'], id: string, displayName: string, extra: Partial<{ color: string; environment: string; database: string }> = {}) {
  connections.add(
    { ...connectionInfo(id), displayName, server: `${id}.corp.local`, database: extra.database ?? 'SalesDB', color: extra.color },
    { ...connectionOptions, server: `${id}.corp.local`, database: extra.database ?? 'SalesDB', displayName, color: extra.color, environment: extra.environment }
  )
}

function addBqConnection(connections: ReturnType<typeof uiFixture>['connections'], id: string, displayName: string, extra: Partial<{ color: string; environment: string; database: string }> = {}) {
  connections.add(
    { ...connectionInfo(id), providerId: 'bigquery', displayName, server: id, database: extra.database ?? 'sales_dw', color: extra.color },
    { provider: 'bigquery', projectId: id, displayName, defaultDataset: extra.database ?? 'sales_dw', color: extra.color, environment: extra.environment } as never
  )
}

describe('Cross-Engine read-only guard evaluation', () => {
  it('allows clean SELECT and WITH queries in both dialects and flags DML/DDL/multi-statement violations with exact lines', () => {
    const clean = evaluateCrossEngineGuard({
      crossView: 'split',
      primaryText: 'SELECT TOP 10 id FROM dbo.Orders;',
      secondaryText: 'WITH cte AS (SELECT id FROM `sales_dw.orders`) SELECT * FROM cte;'
    })
    expect(clean.sqlViolations).toEqual([])
    expect(clean.bqViolations).toEqual([])

    const blocked = evaluateCrossEngineGuard({
      crossView: 'split',
      primaryText: 'SELECT 1;\nUPDATE dbo.Orders SET Status = 1;\nDELETE FROM dbo.Orders;',
      secondaryText: 'SELECT 1;\nSELECT 2;'
    })
    expect(blocked.sqlViolations).toHaveLength(2)
    expect(blocked.sqlViolations[0]).toMatchObject({ line: 2, keyword: 'UPDATE', dialect: 'sqlserver' })
    expect(blocked.sqlViolations[1]).toMatchObject({ line: 3, keyword: 'DELETE', dialect: 'sqlserver' })
    expect(blocked.bqViolations).toHaveLength(1)
    expect(blocked.bqViolations[0]).toMatchObject({ line: 2, keyword: 'MULTI_STATEMENT', dialect: 'bigquery' })
    expect(formatGuardSummary(blocked.sqlViolations)).toContain('Read-only guard (2 blocked, first on Line 2)')

    const markers = toGuardMarkers(blocked.sqlViolations, 8)
    expect(markers).toHaveLength(2)
    expect(markers[0]).toMatchObject({ severity: 8, startLineNumber: 2, code: 'READ_ONLY_VIOLATION', source: 'Cross-Engine Read-Only Guard' })
  })

  it('maps violations across both sections to exact file line numbers in Cross-Engine File mode', () => {
    const fileSql = serializeCrossEngineSql(
      'SELECT 1;\nINSERT INTO dbo.Audit VALUES (1);',
      'SELECT 1;\nDROP TABLE sales_dw.orders;'
    )
    // Line 1: -- #Dialect="sqlserver"
    // Line 2: SELECT 1;
    // Line 3: INSERT INTO dbo.Audit VALUES (1);
    // Line 4: -- #Dialect="bigquery"
    // Line 5: SELECT 1;
    // Line 6: DROP TABLE sales_dw.orders;
    const result = evaluateCrossEngineGuard({ crossView: 'file', primaryText: fileSql })
    expect(result.parseError).toBeUndefined()
    expect(result.sqlViolations[0]).toMatchObject({ line: 3, dialect: 'sqlserver' })
    expect(result.bqViolations[0]).toMatchObject({ line: 6, dialect: 'bigquery' })

    const malformed = evaluateCrossEngineGuard({ crossView: 'file', primaryText: 'SELECT 1;' })
    expect(malformed.parseError).toBeTruthy()
  })
})

describe('CrossEngineEditor surface', () => {
  it('renders Dual-Dialect Split, binds secondary editor, tracks onFocusCapture synchronously, auto-stacks <= 680px, and debounces guard markers', async () => {
    const resizeCallbacks: (() => void)[] = []
    let width = 900
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { resizeCallbacks.push(cb) }
      observe() {}
      disconnect() {}
    })

    const { connections, documents, createdEditors, markerCalls, mount } = uiFixture()
    addSqlConnection(connections, 'sql-prod', 'prod-sql-01', { color: 'red', environment: 'Production', database: 'SalesDB' })
    addBqConnection(connections, 'bq-prod', 'analytics-prod', { color: 'orange', environment: 'Production', database: 'sales_dw' })

    const tab = documents.openMultiQuery({
      mode: 'cross',
      name: 'CrossCompare.sql',
      sql: 'SELECT 1;\nUPDATE dbo.Orders SET A = 1;\nDELETE FROM dbo.Orders;',
      bigQuerySql: 'SELECT 1;',
      targets: [
        { connectionId: 'sql-prod', provider: 'sqlserver', database: 'SalesDB', enabled: true },
        { connectionId: 'bq-prod', provider: 'bigquery', database: 'sales_dw', enabled: true }
      ]
    })

    const primarySlot = createRef<HTMLDivElement>()
    const onActivate = vi.fn()
    const onOpenSingle = vi.fn()
    const primaryFake = makeFakeEditor(document.createElement('div'))
    documents.showIn(primaryFake.instance as never, tab.id, 'primary')

    vi.useFakeTimers()
    const { host } = await mount(createElement(CrossEngineEditor, {
      tabId: tab.id,
      visible: true,
      primarySlotRef: primarySlot,
      onActivate,
      onOpenInSingleEngine: onOpenSingle
    }))

    // Pane headers with dialect labels, target chips, and drag-and-drop data-cross-dialect attributes.
    const sqlPane = host.querySelector<HTMLElement>('.cross-engine-pane[data-cross-dialect="sqlserver"]')!
    const bqPane = host.querySelector<HTMLElement>('.cross-engine-pane[data-cross-dialect="bigquery"]')!
    expect(sqlPane).not.toBeNull()
    expect(bqPane).not.toBeNull()
    expect(sqlPane.textContent).toContain('Transact-SQL')
    expect(sqlPane.textContent).toContain('prod-sql-01')
    expect(bqPane.textContent).toContain('GoogleSQL')
    expect(bqPane.textContent).toContain('analytics-prod')

    // Secondary Monaco editor was created and bound to secondary model.
    expect(createdEditors).toHaveLength(1)
    expect(documents.editorOf(tab.id, 'secondary')).toBe(createdEditors[0]!.instance)

    // Synchronous activePane update via onFocusCapture.
    const bqBtn = bqPane.querySelector<HTMLButtonElement>('button')!
    await act(async () => { bqBtn.focus() })
    expect(documents.get(tab.id)?.activePane).toBe('secondary')
    expect(onActivate).toHaveBeenCalled()

    const sqlBtn = sqlPane.querySelector<HTMLButtonElement>('button')!
    await act(async () => { sqlBtn.focus() })
    expect(documents.get(tab.id)?.activePane).toBe('primary')

    // Initial read-only guard ran: markers set under varia-cross-engine-guard, collapsed into ONE summary strip.
    const sqlStrip = sqlPane.querySelector<HTMLElement>('.cross-engine-guard-strip')!
    expect(sqlStrip).not.toBeNull()
    expect(sqlStrip.textContent).toContain('Read-only guard (2 blocked, first on Line 2)')
    expect(bqPane.querySelector('.cross-engine-guard-strip')).toBeNull()
    expect(markerCalls.some(call => call.owner === crossEngineGuardOwner && call.markers.length === 2)).toBe(true)

    // Next blocked cycles through lines 2 -> 3 -> 2 in the primary editor.
    const nextBtn = sqlStrip.querySelector<HTMLButtonElement>('.cross-engine-guard-next')!
    await act(async () => { nextBtn.click() })
    expect(primaryFake.instance.setPosition).toHaveBeenLastCalledWith({ lineNumber: 2, column: 1 })
    await act(async () => { nextBtn.click() })
    expect(primaryFake.instance.setPosition).toHaveBeenLastCalledWith({ lineNumber: 3, column: 1 })

    // Open in SQL Server tab invokes callback with T-SQL content.
    const openBtn = sqlStrip.querySelector<HTMLButtonElement>('.cross-engine-guard-open')!
    await act(async () => { openBtn.click() })
    expect(onOpenSingle).toHaveBeenCalledWith('sqlserver', expect.stringContaining('UPDATE dbo.Orders'))

    // Typing in secondary model debounces guard evaluation by 150 ms.
    markerCalls.length = 0
    const secondaryModel = documents.getSecondaryModel(tab.id)! as unknown as { edit(text: string): void }
    await act(async () => { secondaryModel.edit('DROP TABLE sales_dw.orders;') })
    expect(bqPane.querySelector('.cross-engine-guard-strip')).toBeNull()
    await act(async () => { vi.advanceTimersByTime(crossEngineGuardDebounceMs - 10) })
    expect(bqPane.querySelector('.cross-engine-guard-strip')).toBeNull()
    await act(async () => { vi.advanceTimersByTime(20) })
    expect(bqPane.querySelector('.cross-engine-guard-strip')?.textContent).toContain('Read-only guard (1 blocked, first on Line 1)')

    // Auto-stacking when container width <= 680 px.
    const rootEl = host.querySelector<HTMLElement>('.cross-engine-editor')!
    Object.defineProperty(rootEl, 'clientWidth', { configurable: true, get: () => width })
    const panes = () => host.querySelector<HTMLElement>('.cross-engine-panes')!
    width = 640
    await act(async () => { resizeCallbacks.forEach(cb => cb()) })
    expect(panes().dataset.layout).toBe('vertical')
    // Manual toggle overrides back to horizontal.
    const stackBtn = host.querySelector<HTMLButtonElement>('.cross-engine-stack-btn')!
    await act(async () => { stackBtn.click() })
    expect(panes().dataset.layout).toBe('horizontal')

    // Switch to Cross-Engine File mode: secondary editor unmounts, calm info strip shows, guard remains active across both sections.
    const fileBtn = [...host.querySelectorAll<HTMLButtonElement>('.cross-engine-view-btn')].find(b => b.textContent?.includes('#Dialect File'))!
    await act(async () => { fileBtn.click() })
    expect(documents.get(tab.id)?.crossView).toBe('file')
    expect(documents.editorOf(tab.id, 'secondary')).toBeUndefined()
    expect(host.textContent).toContain('Switch to Split view for per-dialect IntelliSense and syntax checking.')
    const fileGuardStrip = host.querySelector<HTMLElement>('.cross-engine-guard-strip[data-guard-scope="file"]')!
    expect(fileGuardStrip).not.toBeNull()
    expect(fileGuardStrip.textContent).toContain('3 blocked')
  })
})

describe('MultiTargetPopover', () => {
  it('portals to body, lists grouped servers + disconnected Reconnect, filters > 8 targets, applies shared SQL database to all, and locks while executing', async () => {
    const { connections, documents, databaseList, queries, commands, mount } = uiFixture()
    addSqlConnection(connections, 'sql-1', 'prod-sql-01', { color: 'red', environment: 'Production', database: 'SalesDB' })
    addSqlConnection(connections, 'sql-2', 'stage-sql-01', { color: 'blue', environment: 'Staging', database: 'master' })
    addBqConnection(connections, 'bq-1', 'analytics-prod', { color: 'orange', environment: 'Production', database: 'sales_dw' })

    const dbMap = new Map<string, readonly DatabaseInfo[]>([
      ['sql-1', [{ name: 'SalesDB', isSystem: false, isSnapshot: false }, { name: 'Reporting', isSystem: false, isSnapshot: false }, { name: 'master', isSystem: true, isSnapshot: false }]],
      ['sql-2', [{ name: 'SalesDB', isSystem: false, isSnapshot: false }, { name: 'master', isSystem: true, isSnapshot: false }]],
      ['bq-1', [{ name: 'sales_dw', isSystem: false, isSnapshot: false }]]
    ])
    vi.spyOn(databaseList, 'getSnapshot').mockReturnValue(dbMap)
    vi.spyOn(databaseList, 'get').mockImplementation(id => dbMap.get(id) ?? [])
    vi.spyOn(databaseList, 'reload').mockResolvedValue()

    const tab = documents.openMultiQuery({
      mode: 'cross',
      name: 'Cross.sql',
      targets: [
        { connectionId: 'sql-1', provider: 'sqlserver', database: 'SalesDB', enabled: true },
        { connectionId: 'sql-2', provider: 'sqlserver', database: 'master', enabled: true },
        { connectionId: 'bq-1', provider: 'bigquery', database: 'sales_dw', enabled: true },
        { provider: 'sqlserver', database: 'SalesDB', enabled: true, lastServer: 'offline-sql-03' }
      ]
    })

    const onReconnect = vi.fn()
    const { host, rerender } = await mount(createElement(MultiTargetPopover, { tabId: tab.id, onReconnectTarget: onReconnect }))
    const trigger = host.querySelector<HTMLButtonElement>('.multi-target-trigger')!
    expect(trigger.getAttribute('aria-label')).toContain('3 SQL Servers + 1 BigQuery (2 PROD)')

    // Open popover -> portaled into document.body with grouped SQL Server & BigQuery sections + disconnected target.
    await act(async () => { trigger.click() })
    const dialog = document.body.querySelector<HTMLElement>('.multi-target-popover[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('SQL Server (Transact-SQL)')
    expect(dialog.textContent).toContain('BigQuery (GoogleSQL)')
    expect(dialog.textContent).toContain('offline-sql-03')
    expect(dialog.textContent).toContain('Disconnected')

    // Shared SQL databases include SalesDB and master -> "Apply database to all" updates both enabled SQL Server targets.
    expect(findSharedSqlDatabases(tab.multiTargets!, connections.getSnapshot(), dbMap)).toEqual(['SalesDB', 'master'])
    const applyBtn = dialog.querySelector<HTMLButtonElement>('.multi-target-apply-btn')!
    expect(applyBtn).not.toBeNull()
    await act(async () => { applyBtn.click() })
    const updated = documents.get(tab.id)!.multiTargets!
    expect(updated.filter(t => t.enabled && t.provider === 'sqlserver').map(t => t.database)).toEqual(['SalesDB', 'SalesDB', 'SalesDB'])

    // One-click Reconnect invokes handler for disconnected target.
    const reconnectBtn = dialog.querySelector<HTMLButtonElement>('.multi-target-reconnect')!
    await act(async () => { reconnectBtn.click() })
    expect(onReconnect).toHaveBeenCalledTimes(1)

    // Add > 8 connections -> quick filter input appears and filters rows.
    await act(async () => {
      for (let i = 3; i <= 10; i++) {
        addSqlConnection(connections, `sql-${i}`, `extra-sql-${i}`, { database: 'master' })
      }
    })
    await rerender(createElement(MultiTargetPopover, { tabId: tab.id }))
    await act(async () => { host.querySelector<HTMLButtonElement>('.multi-target-trigger')!.click() })
    const filterInput = document.body.querySelector<HTMLInputElement>('.multi-target-filter-input')!
    expect(filterInput).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(filterInput, 'extra-sql-10')
      filterInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.body.querySelectorAll('.multi-target-row')).toHaveLength(1)

    // While executing, interactive controls are disabled.
    vi.spyOn(queries, 'getSnapshot').mockReturnValue({ [tab.id]: { running: { queryId: 'r1', connectionId: 'sql-1', startedAt: 100 } } } as never)
    await rerender(createElement(MultiTargetPopover, { tabId: tab.id }))
    const openDialog = document.body.querySelector<HTMLElement>('.multi-target-popover')!
    expect(openDialog.textContent).toContain('locked while this query is executing')
    for (const cb of openDialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      expect(cb.disabled).toBe(true)
    }
    expect(commands).toBeDefined()
  })

  it('bounds lazy database-list loads to configured concurrency', async () => {
    let active = 0
    let peak = 0
    const resolvers: (() => void)[] = []
    const task = loadDatabaseListsBounded(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'], () => {
      active++
      peak = Math.max(peak, active)
      return new Promise<void>(resolve => {
        resolvers.push(() => { active--; resolve() })
      })
    }, 3)
    expect(peak).toBe(3)
    expect(active).toBe(3)
    while (resolvers.length) {
      resolvers.shift()!()
      await Promise.resolve()
    }
    await task.promise
    expect(peak).toBe(3)
    expect(active).toBe(0)
  })
})

describe('Multi-server QueryBar, Classic Toolbar, DocumentTab & QueryStatusBar', () => {
  it('renders multi-server QueryBar & Classic Toolbar with Both dialects, SELECT-only pill, MultiTargetPopover, and hides/disables single-server plan controls', async () => {
    const { connections, documents, mount } = uiFixture()
    addSqlConnection(connections, 'sql-1', 'prod-sql-01', { color: 'red', environment: 'Production', database: 'SalesDB' })
    addBqConnection(connections, 'bq-1', 'analytics-prod', { color: 'orange', environment: 'Production', database: 'sales_dw' })

    const crossTab = documents.openMultiQuery({
      mode: 'cross',
      name: 'Cross.sql',
      targets: [
        { connectionId: 'sql-1', provider: 'sqlserver', database: 'SalesDB', enabled: true },
        { connectionId: 'bq-1', provider: 'bigquery', database: 'sales_dw', enabled: true }
      ]
    })

    const barView = await mount(createElement(QueryBar, { tabId: crossTab.id }))
    expect(barView.host.querySelector('.query-scope')?.textContent).toBe('Both dialects')
    expect(barView.host.querySelector('.query-readonly-pill')?.textContent).toContain('SELECT-only')
    expect(barView.host.querySelector('.plan-menu-trigger')).toBeNull()
    expect(barView.host.querySelector('.multi-target-trigger')?.textContent).toContain('1 SQL Server + 1 BigQuery')
    expect(barView.host.querySelector<HTMLButtonElement>('button[aria-label="Execute"]')?.disabled).toBe(false)

    // Classic Toolbar renders MultiTargetPopover and disables single-server Plan/Client Statistics controls.
    const classicView = await mount(createElement(StandardToolbar, { variant: 'classic' }))
    expect(classicView.host.querySelector('.multi-target-trigger')).not.toBeNull()
    expect(classicView.host.querySelector('.query-readonly-pill')?.textContent).toContain('SELECT-only')
    expect(classicView.host.querySelector<HTMLButtonElement>('button[aria-label="Include Actual Execution Plan"]')?.disabled).toBe(true)
    expect(classicView.host.querySelector<HTMLButtonElement>('button[aria-label="Include Client Statistics"]')?.disabled).toBe(true)
  })

  it('renders DocumentTab with stacked 8px swatches, --tab-accent + data-tab-accent (no inline borderTopColor), and PROD badge', async () => {
    const { connections, documents, mount } = uiFixture()
    addSqlConnection(connections, 'sql-1', 'prod-sql-01', { color: 'red', environment: 'Production' })
    addSqlConnection(connections, 'sql-2', 'stage-sql-01', { color: 'blue', environment: 'Staging' })
    addSqlConnection(connections, 'sql-3', 'dev-sql-01', { color: 'green', environment: 'Development' })

    const tab = documents.openMultiQuery({
      mode: 'same',
      name: 'SchemaAudit.sql',
      targets: [
        { connectionId: 'sql-1', provider: 'sqlserver', database: 'SalesDB', enabled: true },
        { connectionId: 'sql-2', provider: 'sqlserver', database: 'SalesDB', enabled: true },
        { connectionId: 'sql-3', provider: 'sqlserver', database: 'SalesDB', enabled: true }
      ]
    })

    const props = {
      api: { id: tab.id, isVisible: true, location: { type: 'grid' }, onDidVisibilityChange: () => ({ dispose: () => {} }) },
      containerApi: { onDidLayoutChange: () => ({ dispose: () => {} }) }
    } as unknown as IDockviewPanelHeaderProps

    const view = await mount(createElement(DocumentTab, props))
    const tabEl = view.host.querySelector<HTMLElement>('.query-tab')!
    expect(tabEl.hasAttribute('data-tab-accent')).toBe(true)
    expect(tabEl.style.getPropertyValue('--tab-accent')).toBe('var(--varia-connection-red)')
    expect(tabEl.style.borderTopColor).toBe('')
    expect(view.host.querySelectorAll('.tab-swatch')).toHaveLength(3)
    expect(view.host.querySelector('.environment-tag')?.textContent).toContain('PROD')
    expect(view.host.querySelector('.tab-multi-summary')?.textContent).toContain('3 SQL Servers')
  })

  it('renders multi-server status in QueryStatusBar ("3 SQL Servers (1 PROD) · Ready", "2 of 3 connected", "1 SQL Server + 1 BigQuery · Read-only")', async () => {
    const { connections, documents, mount } = uiFixture()
    addSqlConnection(connections, 'sql-1', 'prod-sql-01', { color: 'red', environment: 'Production' })
    addSqlConnection(connections, 'sql-2', 'stage-sql-01', { color: 'blue', environment: 'Staging' })
    addSqlConnection(connections, 'sql-3', 'dev-sql-01', { color: 'green', environment: 'Development' })
    addBqConnection(connections, 'bq-1', 'analytics-prod', { color: 'orange', environment: 'Production' })

    const sameTab = documents.openMultiQuery({
      mode: 'same',
      targets: [
        { connectionId: 'sql-1', provider: 'sqlserver', database: 'SalesDB', enabled: true },
        { connectionId: 'sql-2', provider: 'sqlserver', database: 'SalesDB', enabled: true },
        { connectionId: 'sql-3', provider: 'sqlserver', database: 'SalesDB', enabled: true }
      ]
    })
    const readyView = await mount(createElement(QueryStatusBar, { tab: sameTab, variant: 'bar' }))
    expect(readyView.host.textContent).toContain('3 SQL Servers (1 PROD) · Ready')
    expect(readyView.host.querySelector('.query-status-environment')?.textContent).toContain('PROD')

    const partialTab = documents.openMultiQuery({
      mode: 'same',
      targets: [
        { connectionId: 'sql-1', provider: 'sqlserver', database: 'SalesDB', enabled: true },
        { connectionId: 'sql-2', provider: 'sqlserver', database: 'SalesDB', enabled: true },
        { provider: 'sqlserver', database: 'SalesDB', enabled: true, lastServer: 'offline-sql-03' }
      ]
    })
    const partialView = await mount(createElement(QueryStatusBar, { tab: partialTab, variant: 'segment' }))
    expect(partialView.host.textContent).toContain('2 of 3 connected')

    const crossTab = documents.openMultiQuery({
      mode: 'cross',
      targets: [
        { connectionId: 'sql-1', provider: 'sqlserver', database: 'SalesDB', enabled: true },
        { connectionId: 'bq-1', provider: 'bigquery', database: 'sales_dw', enabled: true }
      ]
    })
    const crossView = await mount(createElement(QueryStatusBar, { tab: crossTab, variant: 'segment' }))
    expect(crossView.host.textContent).toContain('1 SQL Server + 1 BigQuery (2 PROD) · Read-only')

    expect(multiTargetTriggerSummary(crossTab, connections.getSnapshot(), []).ready).toBe(true)
  })
})

describe('Dual-pane GoToLineDialog, BookmarkService & ServerDropLayer', () => {
  it('jumps GoToLineDialog inside the focused secondary GoogleSQL pane', async () => {
    const { documents, mount } = uiFixture()
    const tab = documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1;\nSELECT 2;',
      bigQuerySql: 'SELECT 10;\nSELECT 20;\nSELECT 30;\nSELECT 40;',
      targets: []
    })
    const secondaryFake = makeFakeEditor(document.createElement('div'))
    documents.bindSecondaryEditor(secondaryFake.instance as never, tab.id)
    documents.setActivePane(tab.id, 'secondary')

    const { host } = await mount(createElement(GoToLineDialog, { request: { tabId: tab.id, lineCount: 4, line: 1 } }))
    const input = host.querySelector<HTMLInputElement>('#go-to-line-input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '3')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const form = host.querySelector<HTMLFormElement>('form')!
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(secondaryFake.instance.setPosition).toHaveBeenCalledWith({ lineNumber: 3, column: 1 })
    expect(secondaryFake.instance.focus).toHaveBeenCalled()
  })

  it('tracks bookmarks independently per pane on Cross-Engine Split tabs and clears cleanly on Split ↔ File toggle', () => {
    class FakeBmModel implements BookmarkModel {
      readonly decorations = new Map<string, { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }>()
      private seq = 0
      constructor(public lineCount = 20) {}
      deltaDecorations(old: string[], added: { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } }[]) {
        for (const id of old) this.decorations.delete(id)
        return added.map(item => { const id = `d${++this.seq}`; this.decorations.set(id, item.range); return id })
      }
      getDecorationRange(id: string) { return this.decorations.get(id) ?? null }
      getLineCount() { return this.lineCount }
    }
    const primaryModel = new FakeBmModel(20)
    const secondaryModel = new FakeBmModel(20)
    const events = new EventBus()
    let crossView: 'split' | 'file' = 'split'
    let activePane: 'primary' | 'secondary' = 'primary'
    let primaryLine = 1
    let secondaryLine = 1
    const primaryEditor: BookmarkEditor = {
      getModel: () => primaryModel,
      getPosition: () => ({ lineNumber: primaryLine, column: 1 }),
      setPosition: p => { primaryLine = p.lineNumber },
      revealLineInCenterIfOutsideViewport: () => {},
      focus: () => {}
    }
    const secondaryEditor: BookmarkEditor = {
      getModel: () => secondaryModel,
      getPosition: () => ({ lineNumber: secondaryLine, column: 1 }),
      setPosition: p => { secondaryLine = p.lineNumber },
      revealLineInCenterIfOutsideViewport: () => {},
      focus: () => {}
    }
    const docs = {
      getSnapshot: () => ({ documents: [{ id: 'x', multiMode: 'cross' as const, crossView, activePane }], activeId: 'x' }),
      getModel: () => primaryModel,
      getSecondaryModel: () => crossView === 'split' ? secondaryModel : undefined,
      activeModel: () => crossView === 'split' && activePane === 'secondary' ? secondaryModel : primaryModel,
      editorOf: (_id: string, pane?: 'primary' | 'secondary') => pane === 'secondary' ? secondaryEditor : primaryEditor,
      setActivePane: (_id: string, pane: 'primary' | 'secondary') => { activePane = pane },
      activate: () => {},
      get boundEditor() { return crossView === 'split' && activePane === 'secondary' ? secondaryEditor : primaryEditor }
    }
    const service = new BookmarkService(docs, events)
    primaryLine = 4; service.toggle()
    activePane = 'secondary'; secondaryLine = 7; service.toggle()
    expect(service.lines('x', 'primary')).toEqual([4])
    expect(service.lines('x', 'secondary')).toEqual([7])
    expect(service.getSnapshot().counts).toEqual({ x: 2 })

    // Next Bookmark from primary line 4 jumps into secondary line 7, then wraps back to primary line 4.
    activePane = 'primary'; primaryLine = 4
    service.go(1, 'document')
    expect(activePane).toBe('secondary')
    expect(secondaryLine).toBe(7)
    service.go(1, 'document')
    expect(activePane).toBe('primary')
    expect(primaryLine).toBe(4)

    // Toggling Split -> File clears decorations cleanly and zeros counts.
    crossView = 'file'
    events.emit({ type: 'documents.changed' })
    expect(primaryModel.decorations.size).toBe(0)
    expect(service.getSnapshot().counts).toEqual({})
    service.dispose()
  })

  it('recognizes [data-cross-dialect] panes in placeOf and handles additive / wrong-dialect drops cleanly', async () => {
    document.body.innerHTML = `<div id="root">
      <div class="cross-engine-pane" data-cross-dialect="sqlserver" data-document-id="cross-1"><div id="sql-code"></div></div>
      <div class="cross-engine-pane" data-cross-dialect="bigquery" data-document-id="cross-1"><div id="bq-code"></div></div>
    </div>`
    const root = document.getElementById('root')!
    expect(placeOf(root, document.getElementById('sql-code'))).toMatchObject({ place: 'editor', tabId: 'cross-1', dialect: 'sqlserver' })
    expect(placeOf(root, document.getElementById('bq-code'))).toMatchObject({ place: 'editor', tabId: 'cross-1', dialect: 'bigquery' })

    const sqlDrag: ServerDrag = { connectionId: 'sql-2', label: 'stage-sql-01', server: 'stage-sql-01' }
    const bqDrag: ServerDrag = { connectionId: 'bq-1', label: 'analytics-prod', server: 'analytics-prod' }
    const idle = { running: false, live: true, busy: false }

    const sameDoc = {
      database: '',
      multiMode: 'same' as const,
      multiTargets: [{ connectionId: 'sql-1', provider: 'sqlserver' as const, database: 'SalesDB', enabled: true }]
    }
    expect(dropVerdict(sameDoc, sqlDrag, idle, { dragProvider: 'sqlserver' })).toBe(verdicts.addTarget)
    expect(dropVerdict(sameDoc, bqDrag, idle, { dragProvider: 'bigquery' })).toBe(verdicts.wrongEngine)

    const crossDoc = {
      database: '',
      multiMode: 'cross' as const,
      multiTargets: [{ connectionId: 'sql-1', provider: 'sqlserver' as const, database: 'SalesDB', enabled: true }]
    }
    expect(dropVerdict(crossDoc, bqDrag, idle, { dragProvider: 'bigquery', dropDialect: 'bigquery' })).toBe(verdicts.addTarget)
    expect(dropVerdict(crossDoc, bqDrag, idle, { dragProvider: 'bigquery', dropDialect: 'sqlserver' })).toBe(verdicts.wrongDialectPane)

    // ServerDropService additively adds target onto multi-server tab.
    const { connections, documents, targets, queries } = uiFixture()
    addSqlConnection(connections, 'sql-1', 'prod-sql-01', { database: 'SalesDB' })
    addSqlConnection(connections, 'sql-2', 'stage-sql-01', { database: 'Reporting' })
    const multiTab = documents.openMultiQuery({
      mode: 'same',
      targets: [{ connectionId: 'sql-1', provider: 'sqlserver', database: 'SalesDB', enabled: true }]
    })
    const dropService = new ServerDropService({ documents, queries, targets, connections })
    dropService.start(sqlDrag)
    expect(await dropService.moveQuery(multiTab.id, { left: 0, top: 0, width: 100, height: 24 })).toBe(true)
    expect(documents.get(multiTab.id)?.multiTargets?.map(t => [t.connectionId, t.database])).toEqual([
      ['sql-1', 'SalesDB'],
      ['sql-2', 'Reporting']
    ])
  })
})

describe('Round 1 Editor Surfaces regressions', () => {
  it('Finding 1: resolves live strictly from attached handle and re-attaches detached targetId in-place when checked', async () => {
    const { connections, documents, databaseList, mount } = uiFixture()
    addSqlConnection(connections, 'sql-live', 'Prod Primary', { color: 'red', environment: 'Production', database: 'SalesDB' })
    const liveConn = connections.get('sql-live')!
    const sharedTargetId = liveConn.targetId!
    vi.spyOn(databaseList, 'getSnapshot').mockReturnValue(new Map([['sql-live', [{ name: 'SalesDB', isSystem: false, isSnapshot: false }]]]))
    vi.spyOn(databaseList, 'reload').mockResolvedValue()

    const tab = documents.openMultiQuery({
      mode: 'same',
      targets: [{ targetId: sharedTargetId, provider: 'sqlserver', database: 'SalesDB', enabled: true, attachWanted: false }]
    })

    // Detached target must NOT resolve as live even though a live connection shares its targetId, while still inheriting metadata.
    const resolved = resolveMultiTargets(tab, connections.getSnapshot(), [])
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ live: false, connection: undefined, name: 'Prod Primary', color: 'red', environment: 'Production' })
    expect(multiTargetTriggerSummary(tab, connections.getSnapshot(), [])).toMatchObject({ enabledCount: 1, connectedCount: 0, ready: false })

    // In MultiTargetPopover, the live row is unchecked until clicked, and clicking re-attaches in-place without duplicating.
    const { host } = await mount(createElement(MultiTargetPopover, { tabId: tab.id }))
    await act(async () => { host.querySelector<HTMLButtonElement>('.multi-target-trigger')!.click() })
    const checkbox = document.body.querySelector<HTMLInputElement>('.multi-target-popover input[type="checkbox"]')!
    expect(checkbox.checked).toBe(false)
    await act(async () => { checkbox.click() })
    const updated = documents.get(tab.id)!.multiTargets!
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ targetId: sharedTargetId, connectionId: 'sql-live', attachWanted: true, enabled: true })
  })

  it('Finding 2: reconnectRow checks commands.isEnabled and inExplorer before connection.reconnect, otherwise falls back to connection.connect', async () => {
    const { connections, documents, commands, mount } = uiFixture()
    // Connection 1: lost + in explorer -> reconnect enabled -> runs connection.reconnect.
    addSqlConnection(connections, 'sql-lost-in', 'Lost In Explorer')
    // Connection 2: lost + removed from explorer (inExplorer: false) -> falls back to connection.connect.
    addSqlConnection(connections, 'sql-lost-out', 'Lost Hidden')
    // Mark connections lost via snapshot mock so inExplorer flags are exact.
    const baseConns = connections.getSnapshot()
    const mockedConns = [
      { ...baseConns[0]!, lost: true as const, inExplorer: true },
      { ...baseConns[1]!, lost: true as const, inExplorer: false }
    ]
    vi.spyOn(connections, 'getSnapshot').mockReturnValue(mockedConns)

    const tab = documents.openMultiQuery({
      mode: 'same',
      targets: [
        { connectionId: 'sql-lost-in', provider: 'sqlserver', database: 'master', enabled: true, lastServer: 'Lost In Explorer' },
        { connectionId: 'sql-lost-out', provider: 'sqlserver', database: 'master', enabled: true, lastServer: 'Lost Hidden' },
        { provider: 'sqlserver', database: 'master', enabled: true, lastServer: 'Restored Target' }
      ]
    })

    const isEnabled = vi.spyOn(commands, 'isEnabled').mockReturnValue(true)
    const execute = vi.spyOn(commands, 'execute').mockResolvedValue(true)

    const { host } = await mount(createElement(MultiTargetPopover, { tabId: tab.id }))
    const open = async () => { await act(async () => { host.querySelector<HTMLButtonElement>('.multi-target-trigger')!.click() }) }

    // 1. Lost + inExplorer + command enabled -> connection.reconnect.
    await open()
    let buttons = [...document.body.querySelectorAll<HTMLButtonElement>('.multi-target-reconnect')]
    expect(buttons).toHaveLength(3)
    await act(async () => { buttons[0]!.click() })
    expect(isEnabled).toHaveBeenCalledWith('connection.reconnect', expect.objectContaining({ target: expect.objectContaining({ kind: 'explorer' }) }))
    expect(execute).toHaveBeenLastCalledWith('connection.reconnect', expect.any(Object), 'toolbar')

    // 2. Lost + inExplorer, but command disabled -> falls back to connection.connect.
    isEnabled.mockReturnValue(false)
    await open()
    buttons = [...document.body.querySelectorAll<HTMLButtonElement>('.multi-target-reconnect')]
    await act(async () => { buttons[0]!.click() })
    expect(execute).toHaveBeenLastCalledWith('connection.connect', undefined, 'toolbar')

    // 3. Lost + inExplorer === false -> skips connection.reconnect and falls back to connection.connect.
    isEnabled.mockReturnValue(true)
    execute.mockClear()
    await open()
    buttons = [...document.body.querySelectorAll<HTMLButtonElement>('.multi-target-reconnect')]
    await act(async () => { buttons[1]!.click() })
    expect(execute).toHaveBeenCalledWith('connection.connect', undefined, 'toolbar')

    // 4. Restored target without connection -> falls back to connection.connect.
    execute.mockClear()
    await open()
    buttons = [...document.body.querySelectorAll<HTMLButtonElement>('.multi-target-reconnect')]
    await act(async () => { buttons[2]!.click() })
    expect(execute).toHaveBeenCalledWith('connection.connect', undefined, 'toolbar')
  })

  it('Finding 3: Open in BigQuery / SQL Server tab never opens a multi-server tab for single-engine opening and skips non-live handles', async () => {
    const { connections, documents, mount } = uiFixture()
    addSqlConnection(connections, 'sql-live', 'prod-sql', { database: 'SalesDB' })
    addBqConnection(connections, 'bq-dead', 'dead-bq', { database: 'sales_dw' })
    vi.spyOn(connections, 'isLive').mockImplementation(id => id === 'sql-live')

    const tab = documents.openMultiQuery({
      mode: 'cross',
      name: 'Audit.sql',
      sql: 'UPDATE dbo.Orders SET A = 1;',
      bigQuerySql: 'DROP TABLE sales_dw.orders;',
      targets: [
        { connectionId: 'sql-live', provider: 'sqlserver', database: 'SalesDB', enabled: true },
        { connectionId: 'bq-dead', provider: 'bigquery', database: 'sales_dw', enabled: true }
      ]
    })

    const primarySlot = createRef<HTMLDivElement>()
    const openMultiSpy = vi.spyOn(documents, 'openMultiQuery')
    const { host } = await mount(createElement(CrossEngineEditor, { tabId: tab.id, visible: true, primarySlotRef: primarySlot }))

    // BigQuery target is NOT live -> opens single-server BigQuery tab via reopen (no multiMode, no dead connectionId).
    const bqOpenBtn = host.querySelector<HTMLButtonElement>('.cross-engine-pane[data-cross-dialect="bigquery"] .cross-engine-guard-open')!
    await act(async () => { bqOpenBtn.click() })
    expect(openMultiSpy).not.toHaveBeenCalled()
    const openedBq = documents.active!
    expect(openedBq.name).toBe('Audit_BigQuery.sql')
    expect(openedBq.multiMode).toBeUndefined()
    expect(openedBq.provider).toBe('bigquery')
    expect(openedBq.connectionId).toBeUndefined()
    expect(documents.getText(openedBq.id)).toContain('DROP TABLE sales_dw.orders')

    // Zero BigQuery targets case also opens a single-server BigQuery tab via reopen.
    await act(async () => {
      documents.setMultiTargets(tab.id, [{ connectionId: 'sql-live', provider: 'sqlserver', database: 'SalesDB', enabled: true }])
      documents.activate(tab.id)
    })
    await act(async () => { bqOpenBtn.click() })
    expect(openMultiSpy).not.toHaveBeenCalled()
    const openedEmptyBq = documents.active!
    expect(openedEmptyBq.multiMode).toBeUndefined()
    expect(openedEmptyBq.provider).toBe('bigquery')
    expect(openedEmptyBq.database).toBe('')
    expect(openedEmptyBq.connectionId).toBeUndefined()

    // Live SQL Server target opens single-server SQL Server tab attached to the live handle.
    documents.activate(tab.id)
    const sqlOpenBtn = host.querySelector<HTMLButtonElement>('.cross-engine-pane[data-cross-dialect="sqlserver"] .cross-engine-guard-open')!
    await act(async () => { sqlOpenBtn.click() })
    expect(openMultiSpy).not.toHaveBeenCalled()
    const openedSql = documents.active!
    expect(openedSql.name).toBe('Audit_SqlServer.sql')
    expect(openedSql.multiMode).toBeUndefined()
    expect(openedSql.connectionId).toBe('sql-live')
    expect(openedSql.database).toBe('SalesDB')
  })

  it('Finding 4: CrossEngineEditor calls AreaContext.syncStatus on secondary editor bind, focus, and unbind', async () => {
    const { documents, createdEditors, mount } = uiFixture()
    const tab = documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1;',
      bigQuerySql: 'SELECT 2;',
      targets: []
    })
    const syncStatus = vi.fn()
    const area = { mount: vi.fn(), unmount: vi.fn(), syncStatus }
    const primarySlot = createRef<HTMLDivElement>()

    const { host } = await mount(
      createElement(AreaContext.Provider, {
        value: area,
        children: createElement(CrossEngineEditor, { tabId: tab.id, visible: true, primarySlotRef: primarySlot })
      })
    )
    expect(syncStatus).toHaveBeenCalledTimes(1)

    await act(async () => { createdEditors[0]!.triggerFocusWidget() })
    expect(syncStatus).toHaveBeenCalledTimes(2)
    expect(documents.get(tab.id)?.activePane).toBe('secondary')

    // Switching Split -> File unbinds secondary editor and calls syncStatus again.
    const fileBtn = [...host.querySelectorAll<HTMLButtonElement>('.cross-engine-view-btn')].find(b => b.textContent?.includes('#Dialect File'))!
    await act(async () => { fileBtn.click() })
    expect(syncStatus).toHaveBeenCalledTimes(3)
  })

  it('Finding 6: MultiTargetPopover skips already-loaded empty BigQuery projects, keys effect on liveIds, and deduplicates in-flight reloads on focus', async () => {
    const { connections, documents, databaseList, mount } = uiFixture()
    addBqConnection(connections, 'bq-empty', 'Empty Project', { database: '' })
    addSqlConnection(connections, 'sql-pending', 'Pending SQL', { database: 'master' })

    let resolvePending!: () => void
    const dbMap = new Map<string, readonly DatabaseInfo[]>([
      ['bq-empty', []]
    ])
    vi.spyOn(databaseList, 'getSnapshot').mockReturnValue(dbMap)
    vi.spyOn(databaseList, 'get').mockImplementation(id => dbMap.get(id) ?? [])
    const reload = vi.spyOn(databaseList, 'reload').mockImplementation(id => {
      if (id === 'sql-pending') return new Promise<void>(resolve => { resolvePending = resolve })
      return Promise.resolve()
    })

    const tab = documents.openMultiQuery({
      mode: 'cross',
      targets: [
        { connectionId: 'bq-empty', provider: 'bigquery', database: '', enabled: true },
        { connectionId: 'sql-pending', provider: 'sqlserver', database: 'master', enabled: true }
      ]
    })

    const { host, rerender } = await mount(createElement(MultiTargetPopover, { tabId: tab.id }))
    await act(async () => { host.querySelector<HTMLButtonElement>('.multi-target-trigger')!.click() })

    // bq-empty is already in snapshot (with 0 datasets) -> must NOT reload; sql-pending reloads once.
    expect(reload).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledWith('sql-pending')

    // Focusing sql-pending's <select> while reload is in flight must NOT fire a duplicate reload and keeps loading state.
    const sqlSelect = document.body.querySelector<HTMLSelectElement>('select[aria-label="Pending SQL database"]')!
    expect(sqlSelect.title).toBe('Loading…')
    await act(async () => { sqlSelect.dispatchEvent(new FocusEvent('focus', { bubbles: true })) })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sqlSelect.title).toBe('Loading…')

    // Settle sql-pending reload.
    await act(async () => { resolvePending(); await Promise.resolve() })
    expect(sqlSelect.title).toBe('Database: master')

    // Swap sql-pending out and add sql-new (same live row count!) -> liveIdsKey changes and triggers reload for sql-new.
    await act(async () => {
      connections.remove('sql-pending')
      addSqlConnection(connections, 'sql-new', 'New SQL', { database: 'master' })
    })
    await rerender(createElement(MultiTargetPopover, { tabId: tab.id }))
    expect(reload).toHaveBeenCalledWith('sql-new')
  })

  it('Finding 7: traps Tab and Shift+Tab inside the open MultiTargetPopover dialog', async () => {
    const { connections, documents, databaseList, mount } = uiFixture()
    addSqlConnection(connections, 'sql-1', 'prod-sql-01', { database: 'master' })
    vi.spyOn(databaseList, 'getSnapshot').mockReturnValue(new Map([['sql-1', [{ name: 'master', isSystem: true, isSnapshot: false }]]]))
    vi.spyOn(databaseList, 'reload').mockResolvedValue()

    const tab = documents.openMultiQuery({
      mode: 'same',
      targets: [{ connectionId: 'sql-1', provider: 'sqlserver', database: 'master', enabled: true }]
    })

    const { host } = await mount(createElement(MultiTargetPopover, { tabId: tab.id }))
    await act(async () => { host.querySelector<HTMLButtonElement>('.multi-target-trigger')!.click() })
    const dialog = document.body.querySelector<HTMLElement>('.multi-target-popover[role="dialog"]')!
    const focusables = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')]
    for (const el of focusables) {
      vi.spyOn(el, 'getClientRects').mockReturnValue([{ width: 10, height: 10 }] as unknown as DOMRectList)
    }
    const first = focusables[0]!
    const last = focusables.at(-1)!

    // Tab on last control wraps to first.
    last.focus()
    expect(document.activeElement).toBe(last)
    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    await act(async () => { last.dispatchEvent(tabEvent) })
    expect(tabEvent.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)

    // Shift+Tab on first control wraps to last.
    const shiftTabEvent = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    await act(async () => { first.dispatchEvent(shiftTabEvent) })
    expect(shiftTabEvent.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)
  })

  it('Finding 9: Apply database to all only updates live enabled SQL Server targets using each server\'s canonical casing', async () => {
    const { connections, documents, databaseList, mount } = uiFixture()
    addSqlConnection(connections, 'sql-1', 'SQL One', { database: 'master' })
    addSqlConnection(connections, 'sql-2', 'SQL Two', { database: 'master' })
    const dbMap = new Map<string, readonly DatabaseInfo[]>([
      ['sql-1', [{ name: 'SalesDB', isSystem: false, isSnapshot: false }, { name: 'master', isSystem: true, isSnapshot: false }]],
      ['sql-2', [{ name: 'salesdb', isSystem: false, isSnapshot: false }, { name: 'master', isSystem: true, isSnapshot: false }]]
    ])
    vi.spyOn(databaseList, 'getSnapshot').mockReturnValue(dbMap)
    vi.spyOn(databaseList, 'get').mockImplementation(id => dbMap.get(id) ?? [])
    vi.spyOn(databaseList, 'reload').mockResolvedValue()

    expect(canonicalDatabaseName('sql-2', 'SalesDB', dbMap)).toBe('salesdb')

    const tab = documents.openMultiQuery({
      mode: 'same',
      targets: [
        { connectionId: 'sql-1', provider: 'sqlserver', database: 'master', enabled: true },
        { connectionId: 'sql-2', provider: 'sqlserver', database: 'master', enabled: true },
        { provider: 'sqlserver', database: 'ArchiveDB', enabled: true, lastServer: 'offline-sql' }
      ]
    })

    const { host } = await mount(createElement(MultiTargetPopover, { tabId: tab.id }))
    await act(async () => { host.querySelector<HTMLButtonElement>('.multi-target-trigger')!.click() })
    const sharedSelect = document.body.querySelector<HTMLSelectElement>('.multi-target-shared-select')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(sharedSelect, 'SalesDB')
      sharedSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { document.body.querySelector<HTMLButtonElement>('.multi-target-apply-btn')!.click() })

    const updated = documents.get(tab.id)!.multiTargets!
    expect(updated.map(t => t.database)).toEqual(['SalesDB', 'salesdb', 'ArchiveDB'])
  })

  it('Finding 10: GoToLineDialog captures expectedModel on mount and refuses to jump if active pane changes before OK', async () => {
    const { documents, mount } = uiFixture()
    const tab = documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1;\nSELECT 2;',
      bigQuerySql: 'SELECT 10;\nSELECT 20;\nSELECT 30;\nSELECT 40;',
      targets: []
    })
    const primaryFake = makeFakeEditor(document.createElement('div'))
    const secondaryFake = makeFakeEditor(document.createElement('div'))
    documents.showIn(primaryFake.instance as never, tab.id, 'primary')
    documents.bindSecondaryEditor(secondaryFake.instance as never, tab.id)
    documents.setActivePane(tab.id, 'secondary')

    const { host } = await mount(createElement(GoToLineDialog, { request: { tabId: tab.id, lineCount: 4, line: 1 } }))
    // Switch activePane to primary while Go To Line is still open.
    await act(async () => { documents.setActivePane(tab.id, 'primary') })

    const input = host.querySelector<HTMLInputElement>('#go-to-line-input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '2')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const form = host.querySelector<HTMLFormElement>('form')!
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(primaryFake.instance.setPosition).not.toHaveBeenCalled()
    expect(secondaryFake.instance.setPosition).not.toHaveBeenCalled()
  })

  it('Finding 11: MultiTargetPopover enforces 32-target cap against enabled targets, prunes disabled entries on add, and CrossEngineEditor chip remove deletes target', async () => {
    const { connections, documents, databaseList, mount } = uiFixture()
    const dbMap = new Map<string, readonly DatabaseInfo[]>()
    for (let i = 1; i <= maxMultiTargets + 1; i++) {
      addSqlConnection(connections, `sql-${i}`, `Server ${i}`, { database: 'master' })
      dbMap.set(`sql-${i}`, [{ name: 'master', isSystem: true, isSnapshot: false }])
    }
    vi.spyOn(databaseList, 'getSnapshot').mockReturnValue(dbMap)
    vi.spyOn(databaseList, 'reload').mockResolvedValue()

    const initialTargets = [
      ...Array.from({ length: maxMultiTargets - 1 }, (_, i) => ({
        connectionId: `sql-${i + 1}`, provider: 'sqlserver' as const, database: 'master', enabled: true
      })),
      { connectionId: `sql-${maxMultiTargets}`, provider: 'sqlserver' as const, database: 'master', enabled: false }
    ]
    const tab = documents.openMultiQuery({ mode: 'same', targets: initialTargets })

    // 31 enabled + 1 disabled (= 32 stored): adding sql-33 is allowed and prunes the disabled sql-32 entry.
    const { host } = await mount(createElement(MultiTargetPopover, { tabId: tab.id }))
    await act(async () => { host.querySelector<HTMLButtonElement>('.multi-target-trigger')!.click() })
    const cb33 = document.body.querySelector<HTMLInputElement>('input[aria-label="Enable Server 33"]')!
    expect(cb33.disabled).toBe(false)
    await act(async () => { cb33.click() })
    const afterAdd = documents.get(tab.id)!.multiTargets!
    expect(afterAdd).toHaveLength(maxMultiTargets)
    expect(afterAdd.filter(t => t.enabled)).toHaveLength(maxMultiTargets)
    expect(afterAdd.some(t => t.connectionId === 'sql-33')).toBe(true)
    expect(afterAdd.some(t => t.connectionId === `sql-${maxMultiTargets}`)).toBe(false)

    // At 32 enabled targets, unchecked sql-32 is now disabled.
    const cb32 = document.body.querySelector<HTMLInputElement>('input[aria-label="Enable Server 32"]')!
    expect(cb32.disabled).toBe(true)

    // CrossEngineEditor chip remove deletes the target entry cleanly instead of leaving a disabled slot.
    let crossTab!: ReturnType<typeof documents.openMultiQuery>
    await act(async () => {
      crossTab = documents.openMultiQuery({
        mode: 'cross',
        targets: [
          { connectionId: 'sql-1', provider: 'sqlserver', database: 'master', enabled: true },
          { connectionId: 'sql-2', provider: 'sqlserver', database: 'master', enabled: true }
        ]
      })
    })
    const primarySlot = createRef<HTMLDivElement>()
    const crossView = await mount(createElement(CrossEngineEditor, { tabId: crossTab.id, visible: true, primarySlotRef: primarySlot }))
    await act(async () => { crossView.host.querySelector<HTMLButtonElement>('button[aria-label="Remove Server 1"]')!.click() })
    expect(documents.get(crossTab.id)!.multiTargets!.map(t => t.connectionId)).toEqual(['sql-2'])
  })

  it('Finding 12: MultiTargetPopover closes on tabId change and StandardToolbar resets popover when active tab switches', async () => {
    const { connections, documents, databaseList, mount } = uiFixture()
    addSqlConnection(connections, 'sql-1', 'Server 1', { database: 'master' })
    vi.spyOn(databaseList, 'getSnapshot').mockReturnValue(new Map([['sql-1', [{ name: 'master', isSystem: true, isSnapshot: false }]]]))
    vi.spyOn(databaseList, 'reload').mockResolvedValue()

    const tabA = documents.openMultiQuery({
      mode: 'same',
      name: 'TabA.sql',
      targets: [{ connectionId: 'sql-1', provider: 'sqlserver', database: 'master', enabled: true }]
    })
    const tabB = documents.openMultiQuery({
      mode: 'same',
      name: 'TabB.sql',
      targets: [{ connectionId: 'sql-1', provider: 'sqlserver', database: 'master', enabled: true }]
    })

    // Direct tabId prop change closes open popover.
    const direct = await mount(createElement(MultiTargetPopover, { tabId: tabA.id }))
    await act(async () => { direct.host.querySelector<HTMLButtonElement>('.multi-target-trigger')!.click() })
    expect(document.body.querySelector('.multi-target-popover')).not.toBeNull()
    await direct.rerender(createElement(MultiTargetPopover, { tabId: tabB.id }))
    expect(document.body.querySelector('.multi-target-popover')).toBeNull()

    // Classic toolbar switches active tab -> popover closes via key={tab.id}.
    await act(async () => { documents.activate(tabA.id) })
    const classic = await mount(createElement(StandardToolbar, { variant: 'classic' }))
    await act(async () => { classic.host.querySelector<HTMLButtonElement>('.multi-target-trigger')!.click() })
    expect(document.body.querySelector('.multi-target-popover')).not.toBeNull()
    await act(async () => { documents.activate(tabB.id) })
    expect(document.body.querySelector('.multi-target-popover')).toBeNull()
  })
})

describe('Round 2 Editor Surfaces regressions', () => {
  it('Finding 1: toggleRow never writes dead/lost connectionId or flips attachWanted when unchecking or toggling an offline row', async () => {
    const { connections, documents, databaseList, mount } = uiFixture()
    addSqlConnection(connections, 'sql-live', 'Live SQL', { database: 'SalesDB' })
    addSqlConnection(connections, 'sql-lost', 'Lost SQL', { database: 'SalesDB' })
    const liveConn = connections.get('sql-live')!
    const lostConn = connections.get('sql-lost')!
    const mockedConns = [
      liveConn,
      { ...lostConn, lost: true as const }
    ]
    vi.spyOn(connections, 'getSnapshot').mockReturnValue(mockedConns)
    vi.spyOn(databaseList, 'getSnapshot').mockReturnValue(new Map([['sql-live', [{ name: 'SalesDB', isSystem: false, isSnapshot: false }]]]))
    vi.spyOn(databaseList, 'reload').mockResolvedValue()

    const tab = documents.openMultiQuery({
      mode: 'same',
      targets: [
        { connectionId: 'sql-live', targetId: liveConn.targetId, provider: 'sqlserver', database: 'SalesDB', enabled: true, attachWanted: false },
        { targetId: lostConn.targetId, provider: 'sqlserver', database: 'SalesDB', enabled: true, attachWanted: false, lastServer: 'Lost SQL' }
      ]
    })

    const { host } = await mount(createElement(MultiTargetPopover, { tabId: tab.id }))
    await act(async () => { host.querySelector<HTMLButtonElement>('.multi-target-trigger')!.click() })

    // Unchecking a live row must NOT flip attachWanted to true.
    const liveCb = document.body.querySelector<HTMLInputElement>('input[aria-label="Disable Live SQL"]')!
    await act(async () => { liveCb.click() })
    expect(documents.get(tab.id)!.multiTargets![0]).toMatchObject({
      connectionId: 'sql-live',
      enabled: false,
      attachWanted: false
    })

    // Unchecking and re-checking an offline row matching a lost connection must NEVER write dead connectionId or flip attachWanted.
    const offlineDisable = document.body.querySelector<HTMLInputElement>('input[aria-label="Disable Lost SQL"]')!
    await act(async () => { offlineDisable.click() })
    expect(documents.get(tab.id)!.multiTargets![1]).toMatchObject({
      targetId: lostConn.targetId,
      enabled: false,
      attachWanted: false
    })
    expect(documents.get(tab.id)!.multiTargets![1]!.connectionId).toBeUndefined()

    const offlineEnable = document.body.querySelector<HTMLInputElement>('input[aria-label="Enable Lost SQL"]')!
    await act(async () => { offlineEnable.click() })
    expect(documents.get(tab.id)!.multiTargets![1]).toMatchObject({
      targetId: lostConn.targetId,
      enabled: true,
      attachWanted: false
    })
    expect(documents.get(tab.id)!.multiTargets![1]!.connectionId).toBeUndefined()
  })

  it('Finding 2: marks detached live rows with Detached badge and Remove button, reflects detached counts in summaries & 32-target cap, and allows clearing without re-attaching', async () => {
    const { connections, documents, databaseList, mount } = uiFixture()
    const dbMap = new Map<string, readonly DatabaseInfo[]>()
    for (let i = 1; i <= maxMultiTargets + 1; i++) {
      addSqlConnection(connections, `sql-${i}`, `Server ${i}`, { database: 'master' })
      dbMap.set(`sql-${i}`, [{ name: 'master', isSystem: true, isSnapshot: false }])
    }
    vi.spyOn(databaseList, 'getSnapshot').mockReturnValue(dbMap)
    vi.spyOn(databaseList, 'reload').mockResolvedValue()

    const detachedTargetId = connections.get('sql-1')!.targetId!
    const targets = [
      { targetId: detachedTargetId, provider: 'sqlserver' as const, database: 'master', enabled: true, attachWanted: false },
      ...Array.from({ length: maxMultiTargets - 1 }, (_, i) => ({
        connectionId: `sql-${i + 2}`, provider: 'sqlserver' as const, database: 'master', enabled: true
      }))
    ]
    const tab = documents.openMultiQuery({ mode: 'same', targets })

    const { host } = await mount(createElement(MultiTargetPopover, { tabId: tab.id }))
    await act(async () => { host.querySelector<HTMLButtonElement>('.multi-target-trigger')!.click() })

    const dialog = document.body.querySelector<HTMLElement>('.multi-target-popover')!
    const detachedRow = dialog.querySelector<HTMLElement>('.multi-target-row[data-detached="true"]')!
    expect(detachedRow).not.toBeNull()
    expect(detachedRow.querySelector('.multi-target-detached-badge')?.textContent).toBe('Detached')

    // Summaries & cap hint accurately report the detached slot.
    expect(dialog.querySelector('.multi-target-popover-title')?.textContent).toContain('32 active, 1 detached')
    expect(dialog.querySelector('.multi-target-section-count')?.textContent).toContain('32 of 33 selected (1 detached)')
    expect(dialog.querySelector('.multi-target-popover-hint')?.textContent).toContain('Maximum 32 targets reached (1 detached)')

    // At 32/32 cap: unselected Server 33 is disabled, while detached Server 1's checkbox (re-attach) and Remove button remain usable.
    const cb33 = dialog.querySelector<HTMLInputElement>('input[aria-label="Enable Server 33"]')!
    const cbDetached = detachedRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    const clearBtn = detachedRow.querySelector<HTMLButtonElement>('button[aria-label="Remove Server 1"]')!
    expect(cb33.disabled).toBe(true)
    expect(cbDetached.checked).toBe(false)
    expect(cbDetached.disabled).toBe(false)
    expect(clearBtn.disabled).toBe(false)

    // Clicking Remove clears the detached slot (enabled: false) WITHOUT attaching connectionId or attachWanted.
    await act(async () => { clearBtn.click() })
    const afterClear = documents.get(tab.id)!.multiTargets!
    expect(afterClear[0]).toMatchObject({ targetId: detachedTargetId, enabled: false, attachWanted: false })
    expect(afterClear[0]!.connectionId).toBeUndefined()
    // Cap is now 31/32 so Server 33 is immediately enabled.
    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Enable Server 33"]')!.disabled).toBe(false)
  })

  it('Finding 3: computes naturalHeight from chrome + body scrollHeight to flip above when filter clears, and ignores internal panel scroll events', async () => {
    const { connections, documents, databaseList, mount } = uiFixture()
    const dbMap = new Map<string, readonly DatabaseInfo[]>()
    for (let i = 1; i <= 10; i++) {
      addSqlConnection(connections, `sql-${i}`, `Server ${i}`, { database: 'master' })
      dbMap.set(`sql-${i}`, [{ name: 'master', isSystem: true, isSnapshot: false }])
    }
    vi.spyOn(databaseList, 'getSnapshot').mockReturnValue(dbMap)
    vi.spyOn(databaseList, 'reload').mockResolvedValue()

    const tab = documents.openMultiQuery({
      mode: 'same',
      targets: [{ connectionId: 'sql-1', provider: 'sqlserver', database: 'master', enabled: true }]
    })

    const originalInnerHeight = window.innerHeight
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
    cleanups.push(() => {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
    })

    const { host } = await mount(createElement(MultiTargetPopover, { tabId: tab.id }))
    const trigger = host.querySelector<HTMLButtonElement>('.multi-target-trigger')!
    const rectSpy = vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: 380, bottom: 406, left: 200, right: 500, width: 300, height: 26, x: 200, y: 380, toJSON: () => ({})
    })

    await act(async () => { trigger.click() })
    const dialog = document.body.querySelector<HTMLElement>('.multi-target-popover')!
    const body = dialog.querySelector<HTMLElement>('.multi-target-popover-body')!
    const filterInput = dialog.querySelector<HTMLInputElement>('.multi-target-filter-input')!

    // Simulate a popover currently clamped at offsetHeight/scrollHeight=160 while body scrollHeight reflects actual rows.
    let bodyScrollHeight = 80
    Object.defineProperty(dialog, 'offsetWidth', { configurable: true, get: () => 380 })
    Object.defineProperty(dialog, 'offsetHeight', { configurable: true, get: () => 160 })
    Object.defineProperty(dialog, 'scrollHeight', { configurable: true, get: () => 160 })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 70 })
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => bodyScrollHeight })

    // Filter down to 1 row: naturalHeight = 160 - 70 + 80 = 170 <= below (182) -> stays below trigger (top = 410).
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(filterInput, 'Server 10')
      filterInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(dialog.style.top).toBe('410px')
    expect(dialog.style.maxHeight).toBe('182px')

    // Clear filter: panel.scrollHeight stays crushed at 160, but body.scrollHeight expands to 420 -> naturalHeight = 510 -> flips ABOVE trigger!
    bodyScrollHeight = 420
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(filterInput, '')
      filterInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(parseFloat(dialog.style.top)).toBeLessThan(380)
    expect(dialog.style.maxHeight).toBe('368px')

    // Internal scroll inside .multi-target-popover-body must NOT call place(); external scroll DOES call place().
    const callsBefore = rectSpy.mock.calls.length
    await act(async () => { body.dispatchEvent(new Event('scroll')) })
    expect(rectSpy.mock.calls.length).toBe(callsBefore)
    await act(async () => { document.body.dispatchEvent(new Event('scroll')) })
    expect(rectSpy.mock.calls.length).toBe(callsBefore + 1)
  })

  it('Finding 4: focuses the first control inside .multi-target-popover-body when <= 8 servers, never the close button', async () => {
    const { connections, documents, databaseList, queries, mount } = uiFixture()
    addSqlConnection(connections, 'sql-1', 'Alpha SQL', { database: 'master' })
    addSqlConnection(connections, 'sql-2', 'Beta SQL', { database: 'master' })
    vi.spyOn(databaseList, 'getSnapshot').mockReturnValue(new Map([
      ['sql-1', [{ name: 'master', isSystem: true, isSnapshot: false }]],
      ['sql-2', [{ name: 'master', isSystem: true, isSnapshot: false }]]
    ]))
    vi.spyOn(databaseList, 'reload').mockResolvedValue()

    const tab = documents.openMultiQuery({
      mode: 'same',
      targets: [{ connectionId: 'sql-1', provider: 'sqlserver', database: 'master', enabled: true }]
    })

    const { host, rerender } = await mount(createElement(MultiTargetPopover, { tabId: tab.id }))
    await act(async () => { host.querySelector<HTMLButtonElement>('.multi-target-trigger')!.click() })
    const closeBtn = document.body.querySelector<HTMLButtonElement>('.multi-target-popover-close')!
    const firstBodyCheckbox = document.body.querySelector<HTMLInputElement>('.multi-target-popover-body input[type="checkbox"]')!
    expect(document.activeElement).toBe(firstBodyCheckbox)
    expect(document.activeElement).not.toBe(closeBtn)

    // Close, lock via running query (disabling all body controls), and re-open -> still must NOT focus close button.
    await act(async () => { closeBtn.click() })
    vi.spyOn(queries, 'getSnapshot').mockReturnValue({ [tab.id]: { running: { queryId: 'r1', connectionId: 'sql-1', startedAt: 1 } } } as never)
    await rerender(createElement(MultiTargetPopover, { tabId: tab.id }))
    await act(async () => { host.querySelector<HTMLButtonElement>('.multi-target-trigger')!.click() })
    const lockedCloseBtn = document.body.querySelector<HTMLButtonElement>('.multi-target-popover-close')!
    expect(document.activeElement).not.toBe(lockedCloseBtn)
  })

  it('Finding 5: CrossEngineEditor activates inactive tab before requesting popover, and pending open survives Classic Toolbar mount until consumed or next frame', async () => {
    const { connections, documents, databaseList, mount } = uiFixture()
    addSqlConnection(connections, 'sql-1', 'SQL One', { database: 'master' })
    addBqConnection(connections, 'bq-1', 'BQ One', { database: 'sales_dw' })
    vi.spyOn(databaseList, 'getSnapshot').mockReturnValue(new Map([
      ['sql-1', [{ name: 'master', isSystem: true, isSnapshot: false }]],
      ['bq-1', [{ name: 'sales_dw', isSystem: false, isSnapshot: false }]]
    ]))
    vi.spyOn(databaseList, 'reload').mockResolvedValue()

    const tabA = documents.openMultiQuery({
      mode: 'same',
      name: 'TabA.sql',
      targets: [{ connectionId: 'sql-1', provider: 'sqlserver', database: 'master', enabled: true }]
    })
    const tabB = documents.openMultiQuery({
      mode: 'cross',
      name: 'TabB.sql',
      targets: [
        { connectionId: 'sql-1', provider: 'sqlserver', database: 'master', enabled: true },
        { connectionId: 'bq-1', provider: 'bigquery', database: 'sales_dw', enabled: true }
      ]
    })

    // Tab A is active so Classic Toolbar mounts MultiTargetPopover only for Tab A.
    documents.activate(tabA.id)
    const primarySlot = createRef<HTMLDivElement>()
    const onActivate = vi.fn(() => { documents.activate(tabB.id) })
    await mount(createElement(StandardToolbar, { variant: 'classic' }))
    const editorView = await mount(createElement(CrossEngineEditor, {
      tabId: tabB.id,
      visible: true,
      primarySlotRef: primarySlot,
      onActivate
    }))

    // Clicking "+ Add / Change" on inactive Tab B activates Tab B and opens Tab B's Classic Toolbar popover after mount.
    const addBtn = editorView.host.querySelector<HTMLButtonElement>('.cross-engine-add-btn')!
    await act(async () => { addBtn.click() })
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(documents.active?.id).toBe(tabB.id)
    const dialog = document.body.querySelector<HTMLElement>('.multi-target-popover[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('aria-label')).toBe('Cross-Engine Targets')

    // Unmatched pending open request expires cleanly on the next animation frame.
    vi.useFakeTimers()
    let tabC!: ReturnType<typeof documents.openMultiQuery>
    await act(async () => {
      tabC = documents.openMultiQuery({
        mode: 'same',
        name: 'TabC.sql',
        targets: [{ connectionId: 'sql-1', provider: 'sqlserver', database: 'master', enabled: true }]
      })
      documents.activate(tabA.id)
    })
    requestMultiTargetPopover(tabC.id, 'sqlserver')
    await act(async () => { vi.advanceTimersByTime(32) })
    await mount(createElement(MultiTargetPopover, { tabId: tabC.id }))
    expect(document.body.querySelector('.multi-target-popover')).toBeNull()
  })

  it('Finding 6: QueryStatusBar matches live states by connectionId when attached and strictly by targetKey === targetId when detached (never by display label)', async () => {
    const { connections, documents, queries, mount } = uiFixture()
    addSqlConnection(connections, 'sql-1', 'Shared Name', { database: 'SalesDB' })

    const tab = documents.openMultiQuery({
      mode: 'same',
      targets: [
        { connectionId: 'sql-1', provider: 'sqlserver', database: 'SalesDB', enabled: true },
        { targetId: 'tgt-detached', provider: 'sqlserver', database: 'SalesDB', enabled: true, lastServer: 'Shared Name' },
        { provider: 'sqlserver', database: 'SalesDB', enabled: true, lastServer: 'Shared Name' }
      ]
    })

    vi.spyOn(queries, 'getSnapshot').mockReturnValue({
      [tab.id]: {
        running: { queryId: 'q1', connectionId: 'sql-1', startedAt: 100, multi: true },
        multiTargets: [
          {
            targetKey: 'sql-1', connectionId: 'sql-1', provider: 'sqlserver', label: 'Shared Name',
            phase: 'succeeded', batchesCompleted: 1, batchesTotal: 1, rowsAffected: 1, resultSetCount: 1, elapsedMs: 10, resultSetIds: [0]
          },
          {
            targetKey: 'tgt-detached', connectionId: '', provider: 'sqlserver', label: 'Unrelated Label',
            phase: 'running', batchesCompleted: 0, batchesTotal: 1, rowsAffected: 0, resultSetCount: 0, elapsedMs: 5, resultSetIds: []
          }
        ]
      }
    } as never)

    const { host } = await mount(createElement(QueryStatusBar, { tab, variant: 'bar' }))
    // Target 1 matches by connectionId (succeeded), Target 2 matches strictly by targetKey === targetId (running),
    // and Target 3 (no connectionId, no targetId, same display label "Shared Name") MUST NOT match by label -> 2 targets, 1/2 settled.
    expect(host.textContent).toContain('Executing on 2 targets (1/2 settled)…')
  })

  it('Finding 7: CrossEngineEditor secondary editor onDidFocusEditorWidget always invokes the latest onActivate via ref without recreating Monaco', async () => {
    const { documents, createdEditors, mount } = uiFixture()
    const tab = documents.openMultiQuery({
      mode: 'cross',
      sql: 'SELECT 1;',
      bigQuerySql: 'SELECT 2;',
      targets: []
    })
    const primarySlot = createRef<HTMLDivElement>()
    const firstActivate = vi.fn()
    const secondActivate = vi.fn()

    const { rerender } = await mount(createElement(CrossEngineEditor, {
      tabId: tab.id,
      visible: true,
      primarySlotRef: primarySlot,
      onActivate: firstActivate
    }))
    expect(createdEditors).toHaveLength(1)

    await rerender(createElement(CrossEngineEditor, {
      tabId: tab.id,
      visible: true,
      primarySlotRef: primarySlot,
      onActivate: secondActivate
    }))
    expect(createdEditors).toHaveLength(1)

    await act(async () => { createdEditors[0]!.triggerFocusWidget() })
    expect(firstActivate).not.toHaveBeenCalled()
    expect(secondActivate).toHaveBeenCalledTimes(1)
  })

  it('Finding 8: changeRowDatabase sets sharedChoice to the canonical entry from sharedSqlDatabases so case-differing servers do not snap back to master', async () => {
    const { connections, documents, databaseList, mount } = uiFixture()
    addSqlConnection(connections, 'sql-1', 'SQL Upper', { database: 'master' })
    addSqlConnection(connections, 'sql-2', 'SQL Lower', { database: 'master' })
    const dbMap = new Map<string, readonly DatabaseInfo[]>([
      ['sql-1', [{ name: 'SalesDB', isSystem: false, isSnapshot: false }, { name: 'master', isSystem: true, isSnapshot: false }]],
      ['sql-2', [{ name: 'salesdb', isSystem: false, isSnapshot: false }, { name: 'master', isSystem: true, isSnapshot: false }]]
    ])
    vi.spyOn(databaseList, 'getSnapshot').mockReturnValue(dbMap)
    vi.spyOn(databaseList, 'get').mockImplementation(id => dbMap.get(id) ?? [])
    vi.spyOn(databaseList, 'reload').mockResolvedValue()

    const tab = documents.openMultiQuery({
      mode: 'same',
      targets: [
        { connectionId: 'sql-1', provider: 'sqlserver', database: 'master', enabled: true },
        { connectionId: 'sql-2', provider: 'sqlserver', database: 'master', enabled: true }
      ]
    })

    const { host } = await mount(createElement(MultiTargetPopover, { tabId: tab.id }))
    await act(async () => { host.querySelector<HTMLButtonElement>('.multi-target-trigger')!.click() })

    const sharedSelect = document.body.querySelector<HTMLSelectElement>('.multi-target-shared-select')!
    expect(sharedSelect.value).toBe('master')

    // Change SQL Lower's database dropdown to lowercase "salesdb" -> sharedChoice must update to canonical "SalesDB", NOT snap back to "master".
    const lowerSelect = document.body.querySelector<HTMLSelectElement>('select[aria-label="SQL Lower database"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(lowerSelect, 'salesdb')
      lowerSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(sharedSelect.value).toBe('SalesDB')
  })

  it('Finding 9: toGuardMarkers clamps endColumn to column + 1 only on single-line spans and uses Math.max(endColumn, 1) on multi-line spans', () => {
    const markers = toGuardMarkers([
      { line: 2, column: 10, endLine: 2, endColumn: 10, keyword: 'UPDATE', message: 'Single-line blocked' },
      { line: 2, column: 40, endLine: 4, endColumn: 8, keyword: 'DELETE', message: 'Multi-line blocked' },
      { line: 5, column: 15, endLine: 6, endColumn: 0, keyword: 'DROP', message: 'Multi-line zero endColumn' }
    ], 8)
    expect(markers[0]).toMatchObject({ startLineNumber: 2, startColumn: 10, endLineNumber: 2, endColumn: 11 })
    expect(markers[1]).toMatchObject({ startLineNumber: 2, startColumn: 40, endLineNumber: 4, endColumn: 8 })
    expect(markers[2]).toMatchObject({ startLineNumber: 5, startColumn: 15, endLineNumber: 6, endColumn: 1 })
  })
})
