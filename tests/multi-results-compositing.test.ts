// @vitest-environment happy-dom
// Multi-server & cross-engine results compositing: ResultsService (MultiResultsSink), MultiRunSummary,
// OutputPane + ResultsToolbar (Summary disabling & dynamic roving tabIndex), ResultsTabs, ResultsStack,
// ResultsPicker / result-picker, PivotService on Combined, CompareService & ComparePopover, and MessagesView.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BigQueryJobSummary, MessageEntry, MultiTargetOutcome, QueryMultiResult, ResultColumn, ResultDescriptor, ResultsCombineResult, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { ResultGridProps } from '../src/renderer/src/grid/ResultGrid'
import { gridLimits as g } from '../src/renderer/src/grid/constants'
import ResultsTabs, { tabsFold, tabsNeed } from '../src/renderer/src/grid/ResultsTabs'
import ResultsStack, { entryNoticesHeight, multiNoticeHeight, multiStackHeaderHeight, multiSummaryMinHeight, scrollbarSize, settledContent, stackNeed } from '../src/renderer/src/grid/ResultsStack'
import { comparisonTabLabel, jumpResult, pickerRows, shortenDistinct, stepResult, topItems } from '../src/renderer/src/grid/result-picker'
import { CompareService } from '../src/renderer/src/results/CompareService'
import ComparePopover from '../src/renderer/src/results/ComparePopover'
import MessagesView from '../src/renderer/src/results/MessagesView'
import MultiRunSummary from '../src/renderer/src/results/MultiRunSummary'
import OutputPane, { hasResultsView, outputViewOf } from '../src/renderer/src/results/OutputPane'
import { PivotService, pivotable, pivotGroup } from '../src/renderer/src/results/PivotService'
import ResultsToolbar, { resolveMoreTabIndex } from '../src/renderer/src/results/ResultsToolbar'
import { isSummaryActive, ResultsService, summaryEntryKey, turnableKinds } from '../src/renderer/src/results/ResultsService'
import type { MultiTargetIdentity } from '../src/renderer/src/results/multi-results-contract'
import { descriptor, fakeResultClient } from './fixtures/results'
import { workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../src/renderer/src/grid/ResultGrid', async () => {
  const { createElement } = await import('react')
  return {
    focusResultGrid: () => {},
    default: (props: ResultGridProps) => createElement('div', {
      'data-grid': props.entry.key,
      'data-result-grid': '',
      'data-result-entry': props.entry.key,
      'data-tab-id': props.tabId,
      'data-pane-focus': props.focused ? 'selected' : undefined,
      tabIndex: 0,
      onClick: () => props.onFocus(props.entry.key)
    })
  }
})

const cleanups = new Set<() => void>()
afterEach(() => {
  for (const cleanup of [...cleanups].reverse()) cleanup()
  cleanups.clear()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function mount(element: ReturnType<typeof createElement>): HTMLElement {
  const host = document.body.appendChild(document.createElement('div'))
  const root: Root = createRoot(host)
  cleanups.add(() => { act(() => root.unmount()); host.remove() })
  act(() => { root.render(element) })
  return host
}

const sqlTargets: MultiTargetIdentity[] = [
  { targetKey: 'prod-east', connectionId: 'conn-1', provider: 'sqlserver', label: 'prod-sql-east-01', environment: 'PROD', database: 'SalesDB' },
  { targetKey: 'prod-west', connectionId: 'conn-2', provider: 'sqlserver', label: 'prod-sql-west-01', environment: 'STAGING', database: 'SalesDB' },
  { targetKey: 'dev-01', connectionId: 'conn-3', provider: 'sqlserver', label: 'dev-sql-01', environment: 'DEV', database: 'SalesDB' }
]

const crossTargets: MultiTargetIdentity[] = [
  { targetKey: 'sql-1', connectionId: 'conn-sql', provider: 'sqlserver', label: 'prod-sql-01', environment: 'PROD', database: 'SalesDB' },
  { targetKey: 'bq-1', connectionId: 'conn-bq', provider: 'bigquery', label: 'analytics-prod', environment: 'PROD', database: 'sales_dw' }
]

function multiOutcome(target: MultiTargetIdentity, patch: Partial<MultiTargetOutcome> = {}): MultiTargetOutcome {
  return {
    targetKey: target.targetKey,
    provider: target.provider,
    label: target.label,
    ...target.environment ? { environment: target.environment } : {},
    status: 'succeeded',
    batchesCompleted: 1,
    batchesTotal: 1,
    rowsAffected: 10,
    elapsedMs: 120,
    resultSetIds: [],
    ...patch
  }
}

function multiSummaryOf(targets: MultiTargetOutcome[], resultSets: ResultDescriptor[], patch: Partial<QueryMultiResult> = {}): QueryMultiResult {
  return {
    status: 'completed',
    mode: 'fireAndForget',
    targets,
    resultSets,
    discardedResultSets: 0,
    messages: [],
    messagesTruncated: false,
    elapsedMs: 185,
    budget: { usedBytes: 1024, globalBytes: 256 * 1048576, queryBytes: 128 * 1048576, generation: 1, seq: 1 },
    completedAt: '2026-11-26T18:30:00.0000000+00:00',
    ...patch
  }
}

function serviceFixture() {
  const baseClient = fakeResultClient()
  const combine = vi.fn<(...args: unknown[]) => Promise<ResultsCombineResult>>(async () => ({
    descriptor: descriptor(999, { kind: 'combined', index: 0, statementSlot: 0, rowsRead: 4, rowsStored: 4, rowsAvailable: 4 })
  }))
  const client = Object.assign(baseClient, { combine })
  const events = new EventBus()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(),
    saveResults: vi.fn<VariaApi['saveResults']>(),
    cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {})
  }
  const results = new ResultsService({ client, api, events, frame: callback => callback() })
  cleanups.add(() => results.dispose())
  return { client, combine, results, events }
}

describe('ResultsService MultiResultsSink, Summary, Combined rebuild, and Pivot/Transpose', () => {
  it('defaults live and pure-DDL/DML multi-server runs to Summary in Results view and sets context keys accurately', () => {
    const { results, client } = serviceFixture()
    const targetEvents: string[] = []
    const metaEvents: boolean[] = []

    results.begin('t1', 'q1', undefined, {
      multi: { mode: 'transaction', targets: sqlTargets },
      onTargetState: event => targetEvents.push(`${event.targetKey}:${event.phase}`),
      onResultMeta: event => metaEvents.push(event.rolledBackPreview)
    })

    let tab = results.getSnapshot().t1
    expect(tab.view).toBe('results')
    expect(isSummaryActive(tab)).toBe(true)
    expect(tab.focused).toBe(summaryEntryKey)
    expect(tab.multi?.targets.map(t => t.phase)).toEqual(['pending', 'pending', 'pending'])
    // Context keys: hasResults is true (Close Results works), hasResultSets is false (Find/Save disabled), steppable false (only Summary).
    expect(results.context.getSnapshot().t1).toBe(true)
    expect(results.resultSets.getSnapshot().t1).toBeUndefined()
    expect(results.steppable.getSnapshot().t1).toBeUndefined()

    // Live targetState streaming updates summary cards and invokes callback.
    client.emit('q1', {
      type: 'multiQuery.targetState',
      targetKey: 'prod-east',
      phase: 'atBarrier',
      batchesCompleted: 2,
      batchesTotal: 2,
      rowsAffected: 42,
      resultSetCount: 0,
      elapsedMs: 110
    })
    expect(targetEvents).toEqual(['prod-east:atBarrier'])
    expect(results.getSnapshot().t1.multi?.targets[0]).toMatchObject({ phase: 'atBarrier', batchesCompleted: 2, rowsAffected: 42 })

    // Pure-DDL/DML completion (0 sets) stays on Results / Summary.
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        sqlTargets.map(target => multiOutcome(target, { status: 'committed' })),
        [],
        { mode: 'transaction', status: 'completed' }
      )
    })
    tab = results.getSnapshot().t1
    expect(tab.view).toBe('results')
    expect(isSummaryActive(tab)).toBe(true)
    expect(hasResultsView(tab)).toBe(true)
    expect(outputViewOf(tab)).toBe('results')
    expect(results.context.getSnapshot().t1).toBe(true)
    expect(results.resultSets.getSnapshot().t1).toBeUndefined()

    // addMessage does not kick a multi-server Summary run off Results back to Messages.
    results.addMessage('t1', 'Session notice', 'info')
    expect(results.getSnapshot().t1.view).toBe('results')

    // Local READ_ONLY_VIOLATION refusal preserves structured messages with line + dialect.
    results.begin('t2', 'q2')
    void results.finish('t2', 'q2', {
      error: 'READ_ONLY_VIOLATION (Line 4): DELETE is not allowed.',
      code: 'READ_ONLY_VIOLATION',
      messages: [{ text: 'READ_ONLY_VIOLATION (Line 4): DELETE is not allowed.', kind: 'error', line: 4, dialect: 'sqlserver' }]
    })
    expect(results.getSnapshot().t2.messages).toEqual([{ text: 'READ_ONLY_VIOLATION (Line 4): DELETE is not allowed.', kind: 'error', line: 4, dialect: 'sqlserver' }])
    expect(metaEvents).toEqual([])
  })

  it('tracks rolledBackPreview live via resultSet.meta, resolves connectionForResult, and supports stale Combined rebuild & Pivot/Transpose', async () => {
    const { results, client, combine } = serviceFixture()
    const pivot = new PivotService(results)
    cleanups.add(() => pivot.dispose())

    results.begin('t1', 'q1', undefined, { multi: { mode: 'transaction', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, name: 'Orders' })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0, name: 'Orders' })
    const s3 = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0, name: 'Orders' })
    const comb = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0, name: 'Orders', rowsRead: 6, rowsStored: 6, rowsAvailable: 6 })

    client.emit('q1', { type: 'resultSet.opened', descriptor: s1 })
    client.emit('q1', { type: 'resultSet.meta', generation: 1, resultId: 1, rolledBackPreview: true })
    expect(results.getSnapshot().t1.sets[0].descriptor.rolledBackPreview).toBe(true)

    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { status: 'rolledBack', resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { status: 'rolledBack', resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { status: 'failed', resultSetIds: [3], error: { code: 'SQL_ERROR', message: 'Duplicate index', line: 2 } })
        ],
        [
          { ...s1, rolledBackPreview: true },
          { ...s2, rolledBackPreview: true },
          { ...s3, rolledBackPreview: true },
          { ...comb, rolledBackPreview: true }
        ],
        { mode: 'transaction', status: 'rolledBack' }
      )
    })

    // connectionForResult resolves targetKey -> connectionId for BigQueryCostService.
    expect(results.connectionForResult('t1', 1)).toBe('conn-1')
    expect(results.connectionForResult('t1', 2)).toBe('conn-2')
    expect(results.connectionForResult('t1', 3)).toBe('conn-3')
    expect(results.connectionForResult('t1', 10)).toBeUndefined()

    // steppable includes Summary + Combined + 3 server tabs.
    expect(results.steppable.getSnapshot().t1).toBe(true)

    // Combined supports Transpose and Pivot.
    const tab = results.getSnapshot().t1
    const combinedEntry = tab.sets.find(entry => entry.descriptor.kind === 'combined')!
    expect(turnableKinds.has('combined')).toBe(true)
    expect(results.canTranspose('t1', combinedEntry.key)).toBe(true)
    expect(pivotable(combinedEntry)).toBe(true)
    expect(pivotGroup(tab, combinedEntry.key)).toBeDefined()
    expect(pivot.canPivot('t1', combinedEntry.key)).toBe(true)
    const pivotKey = results.addSet('t1', descriptor(810, { kind: 'pivot', index: 3 }), 'Pivot of Combined', ['1:10'])
    expect(pivotKey).toBeDefined()

    // Closing a server's result sets marks Combined stale and allows Rebuild via ResultClient.combine.
    expect(results.removeTargetEntries('t1', 'dev-01')).toBe(true)
    expect(results.getSnapshot().t1.staleCombined?.has(combinedEntry.key)).toBe(true)
    expect(results.canRebuildCombined('t1', combinedEntry.key)).toBe(true)

    const rebuiltKey = await results.rebuildCombined('t1', combinedEntry.key)
    expect(rebuiltKey).toBe(combinedEntry.key)
    expect(combine).toHaveBeenCalledTimes(1)
    expect(results.getSnapshot().t1.staleCombined?.has(combinedEntry.key) ?? false).toBe(false)
    expect(results.getSnapshot().t1.sets.find(entry => entry.key === combinedEntry.key)?.descriptor.resultId).toBe(999)

    // Closing Combined alone leaves per-server results intact.
    expect(results.removeEntry('t1', combinedEntry.key)).toBe(true)
    const remaining = results.getSnapshot().t1.sets
    expect(remaining.some(entry => entry.descriptor.kind === 'combined')).toBe(false)
    expect(remaining.map(entry => entry.descriptor.targetKey)).toEqual(['prod-east', 'prod-west'])
  })
})

describe('MultiRunSummary, OutputPane, and ResultsToolbar', () => {
  it('renders Calm Pro summary cards, rolled-back preview & warnings, F6 data-pane-focus, and jump actions', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('deploy.sql', 'SELECT 1\nCREATE INDEX ix ON dbo.T(Id)', 'SalesDB')
    const setView = vi.spyOn(f.results, 'setView')
    const selectPane = vi.spyOn(f.panes, 'select')
    const onSelectTarget = vi.fn()

    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'transaction', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, rolledBackPreview: true })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { status: 'rolledBack', resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { status: 'rolledBack' }),
          multiOutcome(sqlTargets[2], { status: 'failed', error: { code: '1913', message: 'Index exists', line: 2 } })
        ],
        [s1],
        { mode: 'transaction', status: 'rolledBack', combineWarnings: ['Schema drift on dev-sql-01: extra column LegacyNote.'] }
      )
    })

    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(MultiRunSummary, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id], active: true, onSelectTarget })
    }))

    const root = host.querySelector<HTMLElement>('[data-multi-summary]')!
    expect(root.dataset.paneFocus).toBe('selected')
    expect(host.textContent).toContain('Transaction')
    expect(host.textContent).toContain('Rolled back')
    expect(host.textContent).toContain('Rolled back — preview only (not committed)')
    expect(host.textContent).toContain('Schema drift on dev-sql-01')
    expect(host.textContent).toContain('PROD')
    expect(host.textContent).toContain('STAGING')
    expect(host.textContent).toContain('Index exists')

    const jumpBtn = host.querySelector<HTMLButtonElement>('.multi-target-jump')!
    act(() => { jumpBtn.click() })
    expect(onSelectTarget).toHaveBeenCalledWith('prod-east')

    const msgBtn = [...host.querySelectorAll<HTMLButtonElement>('.multi-target-link')].find(btn => btn.textContent?.includes('Messages'))!
    act(() => { msgBtn.click() })
    expect(setView).toHaveBeenCalledWith(doc.id, 'messages')
    expect(selectPane).toHaveBeenCalledWith('messages')
  })

  it('disables grid-only controls, dismisses open menus, and moves tabIndex=0 to .results-more when switching to Summary', async () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    await f.settings.choose('queryResults.grid.layout', 'tabs')
    const doc = f.documents.create('multi.sql', 'SELECT 1', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf([multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1], { resultSetIds: [2] })], [s1, s2])
    })
    const firstKey = f.results.getSnapshot()[doc.id].sets[0].key
    // Focus grid first so grid tools are enabled and White space holds tabIndex=0.
    f.results.focusEntry(doc.id, firstKey)

    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement('div', { className: 'output-toolbar' }, createElement(ResultsToolbar, { tabId: doc.id }))
    }))

    const ws = host.querySelector<HTMLButtonElement>('button[aria-label^="White space:"]')!
    const sortBtn = host.querySelector<HTMLButtonElement>('button[aria-label^="Sort text by:"]')!
    const profileBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Profile"]')!
    const rowSizeBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Row size"]')!
    const moreBtn = host.querySelector<HTMLButtonElement>('.results-more')!
    const searchInput = host.querySelector<HTMLInputElement>('.results-search input')!

    expect(ws.disabled).toBe(false)
    expect(ws.tabIndex).toBe(0)
    expect(moreBtn.tabIndex).toBe(-1)

    // Open White space menu while on grid.
    act(() => { ws.click() })
    expect(document.querySelector('[role="menu"][aria-label="White space"]')).not.toBeNull()

    // Switch to Summary without resizing: menu dismisses, grid controls disable, MutationObserver moves tabIndex=0 to .results-more.
    await act(async () => {
      f.results.focusEntry(doc.id, summaryEntryKey)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.querySelector('[role="menu"][aria-label="White space"]')).toBeNull()
    expect(searchInput.disabled).toBe(true)
    expect(ws.disabled).toBe(true)
    expect(sortBtn.disabled).toBe(true)
    expect(profileBtn.disabled).toBe(true)
    expect(rowSizeBtn.disabled).toBe(true)
    expect(resolveMoreTabIndex(host.querySelector('.results-toolbar')!, 0)).toBe(0)
    expect(moreBtn.tabIndex).toBe(0)

    // OutputPane guards ColumnProfilePanel on Summary and renders pure-DDL multi-server Summary.
    await act(async () => { await f.settings.choose('queryResults.grid.columnProfile', true) })
    const emptyRetained = { entries: [] }
    const emptyQueryPlans = {}
    const paneWorkbench = {
      ...f,
      retainedPlans: { subscribe: () => () => {}, getSnapshot: () => emptyRetained },
      queryPlans: { subscribe: () => () => {}, getSnapshot: () => emptyQueryPlans }
    } as unknown as Workbench
    const paneHost = mount(createElement(WorkbenchProvider, {
      workbench: paneWorkbench,
      children: createElement(OutputPane, { pane: 'results', tabId: doc.id, query: true, connected: true })
    }))
    expect(paneHost.querySelector('[data-multi-summary]')).not.toBeNull()
    expect(paneHost.querySelector('.column-profile')).toBeNull()
  })
})

describe('ResultsTabs, ResultsStack, and result-picker', () => {
  it('renders Summary → Combined (k/N) → per-server tabs, collapses >3 statements to <select>, and accounts for notice heights', async () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('audit.sql', 'SELECT 1', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'transaction', targets: sqlTargets } })

    // 4 statements on prod-east so statement sub-tabs collapse into <select>.
    const sets: ResultDescriptor[] = [
      descriptor(10, { index: 0, kind: 'combined', statementSlot: 0, name: 'S1', rolledBackPreview: true }),
      descriptor(1, { index: 1, targetKey: 'prod-east', statementSlot: 0, name: 'S1', rolledBackPreview: true }),
      descriptor(2, { index: 2, targetKey: 'prod-east', statementSlot: 1, name: 'S2' }),
      descriptor(3, { index: 3, targetKey: 'prod-east', statementSlot: 2, name: 'S3' }),
      descriptor(4, { index: 4, targetKey: 'prod-east', statementSlot: 3, name: 'S4' }),
      descriptor(5, { index: 5, targetKey: 'prod-west', statementSlot: 0, name: 'S1', rolledBackPreview: true })
    ]
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { status: 'rolledBack', resultSetIds: [1, 2, 3, 4] }),
          multiOutcome(sqlTargets[1], { status: 'rolledBack', resultSetIds: [5] }),
          multiOutcome(sqlTargets[2], { status: 'failed' })
        ],
        sets,
        { mode: 'transaction', status: 'rolledBack', combineWarnings: ['dev-sql-01 failed before returning rows.'] }
      )
    })

    const tab = f.results.getSnapshot()[doc.id]
    const items = topItems(tab)
    expect(items.map(item => item.name)).toEqual(['Summary', 'Combined (2/3)', 'prod-sql-east-01', 'prod-sql-west-01'])

    // Next/Previous Result and ResultsPicker include Summary.
    expect(stepResult(tab, 1)).toBe(items[1].key)
    expect(jumpResult(tab, 1)).toBe(summaryEntryKey)
    expect(pickerRows(tab)[0]).toMatchObject({ key: summaryEntryKey, name: 'Summary', kind: 'summary' })

    // Notice heights are factored into tabsFold, tabsNeed, stackNeed, and settledContent.
    const combinedEntry = tab.sets.find(entry => entry.descriptor.kind === 'combined')!
    const noticeHeight = entryNoticesHeight(tab, combinedEntry)
    expect(noticeHeight).toBe(2 * multiNoticeHeight) // rolledBack + combineWarning
    const shortHeight = g.headerHeight + 2 * g.rowHeight + scrollbarSize() + g.stackBorder + g.resultTabsHeight + g.viewTabsHeight + multiNoticeHeight
    expect(tabsFold(shortHeight, scrollbarSize(), true, 0)).toBeUndefined()
    expect(tabsFold(shortHeight, scrollbarSize(), true, noticeHeight)).toBe('one')

    f.results.focusEntry(doc.id, combinedEntry.key)
    const tabOnCombined = f.results.getSnapshot()[doc.id]
    const settled = settledContent(tabOnCombined)
    expect(settled[0]! - settled[2]!).toBeGreaterThanOrEqual(noticeHeight)
    expect(tabsNeed(tabOnCombined)).toBeGreaterThan(g.resultTabsHeight + noticeHeight)
    expect(stackNeed(tabOnCombined, new Set())).toBeGreaterThan(multiStackHeaderHeight + noticeHeight)

    // Render ResultsTabs on prod-east (4 statements -> collapses to <select>).
    const eastEntry = tab.sets.find(entry => entry.descriptor.targetKey === 'prod-east')!
    f.results.focusEntry(doc.id, eastEntry.key)
    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsTabs, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
    }))
    const stmtSelect = host.querySelector<HTMLSelectElement>('select.rt-stmt-select')
    expect(stmtSelect).not.toBeNull()
    expect([...stmtSelect!.options].map(option => option.textContent)).toEqual(['S1', 'S2', 'S3', 'S4'])
    // Per-server tab has spoken aria-label including status and statement count.
    const eastTab = host.querySelector<HTMLButtonElement>('[data-target-key="prod-east"] [role="tab"]')!
    expect(eastTab.getAttribute('aria-label')).toBe('prod-sql-east-01, Rolled back, 4 result sets')

    // ResultsStack renders full MultiRunSummary on pure-DDL/DML (never blank!) and collapsible summary + statement strip with sets.
    const stackHost = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsStack, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
    }))
    expect(stackHost.querySelector('.rs-multi-summary-toggle')).not.toBeNull()
    expect(stackHost.querySelector('.rs-stmt-strip')).not.toBeNull()

    // Pure-DDL/DML stack: sets.length === 0 renders full MultiRunSummary.
    f.results.begin('ddl-tab', 'q-ddl', undefined, { multi: { mode: 'transaction', targets: sqlTargets } })
    void f.results.finish('ddl-tab', 'q-ddl', {
      multiSummary: multiSummaryOf(sqlTargets.map(target => multiOutcome(target, { status: 'committed' })), [], { mode: 'transaction', status: 'completed' })
    })
    const ddlTab = f.results.getSnapshot()['ddl-tab']
    expect(stackNeed(ddlTab, new Set())).toBe(multiSummaryMinHeight)
    const ddlStack = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsStack, { tabId: 'ddl-tab', tab: ddlTab })
    }))
    expect(ddlStack.querySelector('[data-multi-summary]')).not.toBeNull()
    const ddlTabs = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsTabs, { tabId: 'ddl-tab', tab: ddlTab })
    }))
    expect(ddlTabs.querySelector('[data-multi-summary]')).not.toBeNull()
  })

  it('preserves distinct server prefixes in comparisonTabLabel so east/west servers never truncate identically', () => {
    const [left, right] = shortenDistinct('prod-sql-east-01-primary', 'prod-sql-west-01-primary', 16)
    expect(left).not.toBe(right)
    expect(left).toContain('east')
    expect(right).toContain('west')

    const label = comparisonTabLabel({
      entry: { key: 'c1', number: 5, descriptor: descriptor(50, { kind: 'diff' }), label: 'Differences: prod-sql-east-01 · Orders → prod-sql-west-01 · Orders' } as never,
      sources: [
        { key: 'e1', set: '1:1', number: 1, name: 'prod-sql-east-01 · Orders' },
        { key: 'e2', set: '1:2', number: 2, name: 'prod-sql-west-01 · Orders' }
      ]
    })
    const [sideA, sideB] = label.split(' → ')
    expect(sideA).not.toBe(sideB)
    expect(sideA).toContain('east')
    expect(sideB).toContain('west')
  })
})

describe('CompareService & ComparePopover for multi-server & cross-engine runs', () => {
  it('opens cleanly from Summary or Combined, defaults exact: true on cross-engine diffs, and shows quick search when candidates > 8', () => {
    const { results } = serviceFixture()
    const compare = new CompareService(results)
    cleanups.add(() => compare.dispose())

    // Cross-engine run: opening from Summary auto-selects SQL Server (−) → BigQuery (+) with exact: true.
    results.begin('cx', 'q-cx', undefined, { multi: { mode: 'crossEngineReadOnly', targets: crossTargets } })
    const cols: ResultColumn[] = [{ name: 'Id', dataType: 'int', wire: 'text', nullable: false }]
    const sqlSet = descriptor(1, { index: 0, targetKey: 'sql-1', statementSlot: 0, columns: cols })
    const bqSet = descriptor(2, { index: 1, targetKey: 'bq-1', statementSlot: 0, columns: cols })
    const combined = descriptor(3, { index: 2, kind: 'combined', statementSlot: 0, columns: cols })
    void results.finish('cx', 'q-cx', {
      multiSummary: multiSummaryOf(
        [multiOutcome(crossTargets[0], { resultSetIds: [1] }), multiOutcome(crossTargets[1], { resultSetIds: [2] })],
        [sqlSet, bqSet, combined],
        { mode: 'crossEngineReadOnly', status: 'completed' }
      )
    })

    expect(compare.canPick('cx', summaryEntryKey)).toBe(true)
    const combinedKey = results.getSnapshot().cx.sets.find(entry => entry.descriptor.kind === 'combined')!.key
    expect(compare.canPick('cx', combinedKey)).toBe(true)

    compare.open('cx', summaryEntryKey, 'toolbar')
    const sides = compare.sidesOf('cx')!
    expect(sides.old.descriptor.targetKey).toBe('sql-1')
    expect(sides.neu.descriptor.targetKey).toBe('bq-1')
    expect(compare.getSnapshot().pickers.cx.exact).toBe(true)

    // Popover shows cross-engine collation notice.
    const cxWorkbench = { results, compare } as unknown as Workbench
    mount(createElement(WorkbenchProvider, {
      workbench: cxWorkbench,
      children: createElement('div', { 'data-pane': 'results' }, createElement(ComparePopover, { tabId: 'cx', tab: results.getSnapshot().cx }))
    }))
    expect(document.querySelector('.compare-cross-collation')?.textContent).toContain('Cross-engine comparison defaults to Exact text')

    // >8 candidates renders quick search input and filters candidates cleanly.
    const manyTargets: MultiTargetIdentity[] = Array.from({ length: 10 }, (_, index) => ({
      targetKey: `srv-${index + 1}`,
      connectionId: `c-${index + 1}`,
      provider: 'sqlserver',
      label: index === 7 ? 'west-canary-08' : `east-node-${index + 1}`
    }))
    act(() => {
      results.begin('many', 'q-many', undefined, { multi: { mode: 'fireAndForget', targets: manyTargets } })
      const manySets = manyTargets.map((target, index) => descriptor(index + 1, { index, targetKey: target.targetKey, statementSlot: 0, columns: cols }))
      void results.finish('many', 'q-many', {
        multiSummary: multiSummaryOf(manyTargets.map((target, index) => multiOutcome(target, { resultSetIds: [index + 1] })), manySets)
      })
      compare.open('many', summaryEntryKey, 'toolbar')
    })
    mount(createElement(WorkbenchProvider, {
      workbench: cxWorkbench,
      children: createElement('div', { 'data-pane': 'results' }, createElement(ComparePopover, { tabId: 'many', tab: results.getSnapshot().many }))
    }))
    const search = document.querySelector<HTMLInputElement>('input.compare-search')!
    expect(search).not.toBeNull()
    expect(document.querySelectorAll('.compare-target')).toHaveLength(9)
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'canary')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.querySelectorAll('.compare-target')).toHaveLength(1)
    expect(document.querySelector('.compare-target-name')?.textContent).toContain('west-canary-08')
  })
})

describe('MessagesView multi-server filtering, Ctrl+A boundary, dialect line reveal, and BigQuery JobLine', () => {
  it('mounts filter bar outside [data-output-view="messages"], preserves unfiltered index, threads dialect, and uses <select> when >6 targets or firstError', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('cross.sql', 'SELECT 1\nSELECT 2', 'SalesDB')
    const onDidChange = vi.spyOn(f.documents, 'onDidChangeContent')
    const sourceLine = vi.spyOn(f.queries, 'sourceLine').mockImplementation((_tabId, _queryId, line, dialect) => (line === 2 && dialect === 'bigquery' ? 2 : undefined))
    const execute = vi.spyOn(f.commands, 'execute').mockResolvedValue(true)

    const bqJob: BigQueryJobSummary = { project: 'proj-prod', jobId: 'job-123', location: 'US' }
    f.results.begin(doc.id, 'q-msg', undefined, { multi: { mode: 'crossEngineReadOnly', targets: crossTargets } })
    const messages: MessageEntry[] = [
      { text: 'Coordinator started', kind: 'info' },
      { text: '(1 row affected)', kind: 'info', targetKey: 'sql-1' },
      { text: 'Syntax error on BQ', kind: 'error', line: 2, dialect: 'bigquery', targetKey: 'bq-1' }
    ]
    void f.results.finish(doc.id, 'q-msg', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(crossTargets[0]),
          multiOutcome(crossTargets[1], { job: bqJob })
        ],
        [],
        { mode: 'crossEngineReadOnly', status: 'partialFailure', messages }
      )
    })

    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(MessagesView, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
    }))

    expect(onDidChange).toHaveBeenCalledWith(doc.id, expect.any(Function))
    expect(sourceLine).toHaveBeenCalledWith(doc.id, 'q-msg', 2, 'bigquery')

    // Filter bar is a sibling OUTSIDE [data-output-view="messages"] so Ctrl+A copies only messages.
    const log = host.querySelector<HTMLElement>('[data-output-view="messages"]')!
    const filterBar = host.querySelector<HTMLElement>('.messages-filter-bar')!
    expect(filterBar).not.toBeNull()
    expect(log.contains(filterBar)).toBe(false)

    // Filter to analytics-prod: Message keeps unfiltered index=2 when dispatching output.revealError!
    const bqPill = [...filterBar.querySelectorAll<HTMLButtonElement>('.messages-filter-pill')].find(btn => btn.textContent?.includes('analytics-prod'))!
    act(() => { bqPill.click() })
    const revealBtn = log.querySelector<HTMLButtonElement>('.message-source-link')!
    expect(revealBtn.disabled).toBe(false)
    act(() => { revealBtn.click() })
    expect(execute).toHaveBeenCalledWith('output.revealError', { tabId: doc.id, message: { queryId: 'q-msg', index: 2, line: 2 } }, 'toolbar')

    // BigQuery JobLine is rendered for analytics-prod.
    expect(log.textContent).toContain('Job ID: proj-prod:US.job-123')

    // Inside MessagesStrip (firstError=true), renders compact <select> instead of pills.
    const stripHost = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(MessagesView, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id], firstError: true })
    }))
    expect(stripHost.querySelector('select.messages-filter-select')).not.toBeNull()
    expect(stripHost.querySelector('.messages-filter-pills')).toBeNull()

    // >6 targets also collapses to compact <select>.
    const sevenTargets: MultiTargetIdentity[] = Array.from({ length: 7 }, (_, index) => ({
      targetKey: `s-${index}`, connectionId: `c-${index}`, provider: 'sqlserver', label: `sql-${index}`
    }))
    f.results.begin('seven', 'q-7', undefined, { multi: { mode: 'fireAndForget', targets: sevenTargets } })
    void f.results.finish('seven', 'q-7', { multiSummary: multiSummaryOf(sevenTargets.map(target => multiOutcome(target)), []) })
    const sevenHost = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(MessagesView, { tabId: 'seven', tab: f.results.getSnapshot().seven })
    }))
    expect(sevenHost.querySelector('select.messages-filter-select')).not.toBeNull()
  })
})
