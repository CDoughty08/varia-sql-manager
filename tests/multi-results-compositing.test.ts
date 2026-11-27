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
import { minGridHeight, setFloors, stackLayout } from '../src/renderer/src/grid/stack'
import ResultsTabs, { tabsFold, tabsNeed } from '../src/renderer/src/grid/ResultsTabs'
import ResultsStack, { EntryNoticeBars, entryNotices, entryNoticesHeight, entryTotalBatches, multiNoticeHeight, multiStackHeaderHeight, multiSummaryMinHeight, scrollbarSize, settledContent, stackNeed } from '../src/renderer/src/grid/ResultsStack'
import { combinedTargetCount, comparisonTabLabel, jumpResult, pickerRequests, pickerRows, shortenDistinct, stackReveals, stepResult, topItems } from '../src/renderer/src/grid/result-picker'
import { CompareService, isCrossEnginePair } from '../src/renderer/src/results/CompareService'
import ComparePopover from '../src/renderer/src/results/ComparePopover'
import MessagesView from '../src/renderer/src/results/MessagesView'
import MultiRunSummary, { normalizeMultiEnvironment } from '../src/renderer/src/results/MultiRunSummary'
import OutputPane, { discardNotice, hasResultsView, outputViewOf, useLayoutFocus } from '../src/renderer/src/results/OutputPane'
import { PivotService, pivotable, pivotGroup } from '../src/renderer/src/results/PivotService'
import ResultsToolbar, { resolveMoreTabIndex } from '../src/renderer/src/results/ResultsToolbar'
import { entrySecondary, isSummaryActive, numberedName, pivotOutOfDate, ResultsService, resultTitle, slotNamed, summaryEntryKey, turnableKinds, type TabResults } from '../src/renderer/src/results/ResultsService'
import type { RemoteViews } from '../src/renderer/src/results/remote-views'
import type { MultiTargetIdentity } from '../src/renderer/src/results/multi-results-contract'
import { stylesheetRules } from './fixtures/css-rules'
import { descriptor, fakeResultClient, type FakeHandle } from './fixtures/results'
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
    expect(noticeHeight).toBe(3 * multiNoticeHeight) // rolledBack + combineWarning + partialCombine
    const shortHeight = g.headerHeight + 2 * g.rowHeight + scrollbarSize() + g.stackBorder + g.resultTabsHeight + noticeHeight
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

describe('Round 1 adversarial regression checks (Domain 4: Results & CSS)', () => {
  it('R1-1: places multi summary band and statement strip outside .rs-stack, defaults collapsed once sets exist, and enforces extraMin floors', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('stack-layout.sql', 'SELECT 1; SELECT 2', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'transaction', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, name: 'S1', rolledBackPreview: true, rowsRead: 200, rowsStored: 200, rowsAvailable: 200 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-east', statementSlot: 1, name: 'S2', rowsRead: 200, rowsStored: 200, rowsAvailable: 200 })
    const comb = descriptor(10, { index: 2, kind: 'combined', statementSlot: 0, name: 'S1', rolledBackPreview: true, rowsRead: 200, rowsStored: 200, rowsAvailable: 200 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { status: 'rolledBack', resultSetIds: [1, 2] }),
          multiOutcome(sqlTargets[1], { status: 'failed' }),
          multiOutcome(sqlTargets[2], { status: 'skipped' })
        ],
        [comb, s1, s2],
        { mode: 'transaction', status: 'rolledBack', combineWarnings: ['Schema drift detected.'] }
      )
    })

    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsStack, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
    }))
    const multiRoot = host.querySelector<HTMLElement>('.rs-multi-root')!
    const summaryBand = multiRoot.querySelector<HTMLElement>('.rs-multi-summary-band')!
    const stmtStrip = multiRoot.querySelector<HTMLElement>('.rs-stmt-strip')!
    const stack = multiRoot.querySelector<HTMLElement>('.rs-stack')!
    const content = stack.querySelector<HTMLElement>('.rs-content')!
    expect(multiRoot).not.toBeNull()
    expect(stack.contains(summaryBand)).toBe(false)
    expect(stack.contains(stmtStrip)).toBe(false)
    expect([...stack.children]).toEqual([content])
    // Even with failed/rolled-back targets, summary band defaults collapsed once sets exist.
    expect(summaryBand.querySelector('.rs-multi-summary-toggle')?.getAttribute('aria-expanded')).toBe('false')
    expect(summaryBand.querySelector('[data-multi-summary]')).toBeNull()

    // setFloors / stackLayout enforce per-item extraMin so short panes (140-200px) never starve grids under notice strips.
    const min = minGridHeight(15)
    const extra = 2 * multiNoticeHeight
    expect(setFloors(2, min, { extraMin: [extra, 0] })).toEqual([min + extra, min])
    expect(setFloors(2, min, { extraMin: [extra, 0], content: [min + 10, min + 500] })).toEqual([min + 10, min])
    const singleShort = stackLayout(150, 1, undefined, min, { extraMin: [extra] })
    expect(singleShort.heights[0]).toBe(min + extra)
    expect(singleShort.total).toBe(min + extra)
    const pairShort = stackLayout(180, 2, undefined, min, { extraMin: [extra, 0] })
    expect(pairShort.heights).toEqual([min + extra, min])
    expect(pairShort.total).toBe(min + extra + g.splitter + min)

    // CSS bounds .multi-summary-compact with scrollable max-height.
    const compactRule = stylesheetRules().find(rule => rule.selector === '.multi-summary-compact')
    expect(compactRule?.declarations.some(d => d.property === 'max-height')).toBe(true)
    expect(compactRule?.declarations.some(d => d.property === 'overflow-y' && d.value === 'auto')).toBe(true)
  })

  it('R1-2: never double-counts derived combined sets in tab.rowsRead during streaming or finish', () => {
    const { results, client } = serviceFixture()
    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, rowsRead: 10, rowsStored: 10, rowsAvailable: 10 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0, rowsRead: 15, rowsStored: 15, rowsAvailable: 15 })
    const comb = descriptor(10, { index: 2, kind: 'combined', statementSlot: 0, rowsRead: 25, rowsStored: 25, rowsAvailable: 25 })

    client.emit('q1', { type: 'resultSet.opened', descriptor: s1 })
    client.emit('q1', { type: 'resultSet.opened', descriptor: s2 })
    client.emit('q1', { type: 'resultSet.opened', descriptor: comb })
    expect(results.getSnapshot().t1.rowsRead).toBe(25)

    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1], { resultSetIds: [2] })],
        [s1, s2, comb]
      )
    })
    expect(results.getSnapshot().t1.rowsRead).toBe(25)
  })

  it('R1-3: dedupes concurrent rebuildCombined, passes abort signal, discards stale/mismatched results, and applies warnings', async () => {
    const { results, client, combine } = serviceFixture()
    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const s3 = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0 })
    const comb = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0, name: 'Orders' })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { resultSetIds: [3] })
        ],
        [s1, s2, s3, comb],
        { combineWarnings: ['Old warning'] }
      )
    })
    const combinedKey = results.getSnapshot().t1.sets.find(entry => entry.descriptor.kind === 'combined')!.key
    results.removeTargetEntries('t1', 'dev-01')

    // 1. Dedupe concurrent rebuilds + pass signal + apply warnings.
    let resolveFirst!: (res: ResultsCombineResult & { warnings?: string[] }) => void
    let capturedSignal: AbortSignal | undefined
    combine.mockImplementationOnce((_handles, opts) => {
      capturedSignal = (opts as { signal?: AbortSignal } | undefined)?.signal
      return new Promise(resolve => { resolveFirst = resolve })
    })
    const p1 = results.rebuildCombined('t1', combinedKey)
    const p2 = results.rebuildCombined('t1', combinedKey)
    expect(combine).toHaveBeenCalledTimes(1)
    expect(capturedSignal).toBeInstanceOf(AbortSignal)
    expect(results.canRebuildCombined('t1', combinedKey)).toBe(false)
    expect(await p2).toBeUndefined()
    resolveFirst({
      descriptor: descriptor(501, { kind: 'combined', index: 3, statementSlot: 0, rowsRead: 4, rowsStored: 4, rowsAvailable: 4 }),
      warnings: ['Updated schema drift warning.']
    })
    expect(await p1).toBe(combinedKey)
    expect(results.getSnapshot().t1.multi?.combineWarnings).toEqual(['Updated schema drift warning.'])

    // 2. Generation mismatch discards returned descriptor and returns undefined.
    combine.mockResolvedValueOnce({
      descriptor: descriptor(502, { generation: 99, kind: 'combined', index: 3, statementSlot: 0 })
    })
    expect(await results.rebuildCombined('t1', combinedKey)).toBeUndefined()
    expect(client.release).toHaveBeenCalledWith([{ generation: 99, resultId: 502 }])

    // 3. Dropping a source while combine is in flight aborts signal and discards late response.
    let resolveDropped!: (res: ResultsCombineResult) => void
    let droppedSignal: AbortSignal | undefined
    combine.mockImplementationOnce((_handles, opts) => {
      droppedSignal = (opts as { signal?: AbortSignal } | undefined)?.signal
      return new Promise(resolve => { resolveDropped = resolve })
    })
    const p3 = results.rebuildCombined('t1', combinedKey)
    expect(droppedSignal?.aborted).toBe(false)
    results.removeTargetEntries('t1', 'prod-west')
    expect(droppedSignal?.aborted).toBe(true)
    resolveDropped({ descriptor: descriptor(503, { kind: 'combined', index: 3, statementSlot: 0 }) })
    expect(await p3).toBeUndefined()
    expect(client.release).toHaveBeenCalledWith([{ generation: 1, resultId: 503 }])
  })

  it('R1-4: guards connectionForResult by run/handle state and preserves targetKey + statementSlot in rerunInPlace', async () => {
    const baseClient = fakeResultClient()
    const events = new EventBus()
    const api = {
      copyResults: vi.fn<VariaApi['copyResults']>(),
      saveResults: vi.fn<VariaApi['saveResults']>(),
      cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
      onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}),
      remoteQuery: vi.fn<VariaApi['remoteQuery']>()
    }
    const rerun = vi.fn(async () => descriptor(77, { index: 1, residence: 'remote', rowsAvailable: 5, rowsStored: 0, rowsRead: 5 }))
    const results = new ResultsService({ client: baseClient, api, events, remote: { rerun } as unknown as RemoteViews, frame: callback => callback() })
    cleanups.add(() => results.dispose())

    results.begin('t1', 'q1', undefined, { multi: { mode: 'crossEngineReadOnly', targets: crossTargets } })
    const sqlSet = descriptor(1, { index: 0, targetKey: 'sql-1', statementSlot: 0 })
    const bqSet = descriptor(2, { index: 1, targetKey: 'bq-1', statementSlot: 2, name: 'Warehouse', residence: 'remote' })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(crossTargets[0], { resultSetIds: [1] }), multiOutcome(crossTargets[1], { resultSetIds: [2] })],
        [sqlSet, bqSet],
        { mode: 'crossEngineReadOnly', status: 'completed' }
      )
    })

    // rerunInPlace preserves targetKey, statementSlot, and name from old.descriptor.
    const bqKey = results.getSnapshot().t1.sets.find(entry => entry.descriptor.resultId === 2)!.key
    expect(await results.rerun('t1', bqKey)).toBeUndefined()
    const rerunEntry = results.getSnapshot().t1.sets.find(entry => entry.key === bqKey)!
    expect(rerunEntry.descriptor.resultId).toBe(77)
    expect(rerunEntry.descriptor.targetKey).toBe('bq-1')
    expect(rerunEntry.descriptor.statementSlot).toBe(2)
    expect(rerunEntry.descriptor.name).toBe('Warehouse')
    expect(results.connectionForResult('t1', 77)).toBe('conn-bq')

    // Removed result on a completed run does NOT fall back to stale resultSetIds.
    const sqlKey = results.getSnapshot().t1.sets.find(entry => entry.descriptor.resultId === 1)!.key
    results.removeEntry('t1', sqlKey)
    expect(results.connectionForResult('t1', 1)).toBeUndefined()

    // Lost/released handle returns undefined.
    baseClient.handle(77)!.snapshot = { ...baseClient.handle(77)!.snapshot, state: 'lost' }
    expect(results.connectionForResult('t1', 77)).toBeUndefined()

    // Closed run returns undefined.
    results.closeResults('t1')
    expect(results.connectionForResult('t1', 77)).toBeUndefined()
  })

  it('R1-5 & R1-12: ComparePopover blocks Enter submit in .compare-search and falls back to Summary/active grid on dismiss', () => {
    const { results } = serviceFixture()
    const compare = new CompareService(results)
    cleanups.add(() => compare.dispose())
    const cols: ResultColumn[] = [{ name: 'Id', dataType: 'int', wire: 'text', nullable: false }]
    const manyTargets: MultiTargetIdentity[] = Array.from({ length: 10 }, (_, index) => ({
      targetKey: `srv-${index + 1}`, connectionId: `c-${index + 1}`, provider: 'sqlserver', label: `node-${index + 1}`
    }))
    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: manyTargets } })
    const manySets = manyTargets.map((target, index) => descriptor(index + 1, { index, targetKey: target.targetKey, statementSlot: 0, columns: cols }))
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(manyTargets.map((target, index) => multiOutcome(target, { resultSetIds: [index + 1] })), manySets)
    })

    const runSpy = vi.spyOn(compare, 'run')
    compare.open('t1', summaryEntryKey, 'grid')
    const workbench = { results, compare } as unknown as Workbench
    const host = mount(createElement(WorkbenchProvider, {
      workbench,
      children: createElement('div', { 'data-pane': 'results' },
        createElement('div', { 'data-multi-summary': '', 'data-tab-id': 't1', 'data-pane-focus': 'selected', tabIndex: 0 }),
        createElement(ComparePopover, { tabId: 't1', tab: results.getSnapshot().t1 })
      )
    }))

    // R1-5: Enter in .compare-search prevents submit and moves focus to first visible radio.
    const search = document.querySelector<HTMLInputElement>('input.compare-search')!
    search.focus()
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => { search.dispatchEvent(enterEvent) })
    expect(enterEvent.defaultPrevented).toBe(true)
    expect(runSpy).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(document.querySelector('.compare-targets input[type="radio"]'))

    // R1-12: Dismissing when picker.active grid is not mounted falls back to [data-multi-summary].
    const summaryEl = host.querySelector<HTMLElement>('[data-multi-summary]')!
    act(() => { document.querySelector<HTMLFormElement>('.compare-popover')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(compare.getSnapshot().pickers.t1).toBeUndefined()
    expect(document.activeElement).toBe(summaryEl)
  })

  it('R1-6: MessagesView requires hasCoordinatorLines for coordinatorFilter and resets filter on queryId/tabId change', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('msg.sql', 'SELECT 1', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0]), multiOutcome(sqlTargets[1])],
        [],
        { messages: [{ text: 'Coordinator note', kind: 'info' }, { text: 'East output', kind: 'info', targetKey: 'prod-east' }] }
      )
    })

    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.add(() => { act(() => root.unmount()); host.remove() })
    const renderView = (tabId: string) => act(() => {
      root.render(createElement(WorkbenchProvider, {
        workbench: f as unknown as Workbench,
        children: createElement(MessagesView, { tabId, tab: f.results.getSnapshot()[tabId], firstError: false })
      }))
    })
    renderView(doc.id)

    // Pick Coordinator filter.
    const coordPill = [...host.querySelectorAll<HTMLButtonElement>('.messages-filter-pill')].find(btn => btn.textContent === 'Coordinator')!
    act(() => { coordPill.click() })
    expect(host.querySelector('[data-output-view="messages"]')?.textContent).toContain('Coordinator note')
    expect(host.querySelector('[data-output-view="messages"]')?.textContent).not.toContain('East output')

    // Re-render same queryId without coordinator lines: falls back to 'all'.
    const withoutCoord = { ...f.results.getSnapshot()[doc.id], messages: [{ text: 'East output', kind: 'info' as const, targetKey: 'prod-east' }] }
    act(() => {
      root.render(createElement(WorkbenchProvider, {
        workbench: f as unknown as Workbench,
        children: createElement(MessagesView, { tabId: doc.id, tab: withoutCoord })
      }))
    })
    expect(host.querySelector('[data-output-view="messages"]')?.textContent).toContain('East output')

    // Pick prod-east filter, then start a new run (new queryId): filter resets to 'all'.
    renderView(doc.id)
    const eastPill = [...host.querySelectorAll<HTMLButtonElement>('.messages-filter-pill')].find(btn => btn.textContent?.includes('prod-sql-east-01'))!
    act(() => { eastPill.click() })
    expect(eastPill.getAttribute('aria-pressed')).toBe('true')

    f.results.begin(doc.id, 'q2', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    void f.results.finish(doc.id, 'q2', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0]), multiOutcome(sqlTargets[1])],
        [],
        { messages: [{ text: 'West output', kind: 'info', targetKey: 'prod-west' }] }
      )
    })
    renderView(doc.id)
    const allPill = [...host.querySelectorAll<HTMLButtonElement>('.messages-filter-pill')].find(btn => btn.textContent === 'All')!
    expect(allPill.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('[data-output-view="messages"]')?.textContent).toContain('West output')
  })

  it('R1-7: ResultsStack clears activeSummary when sets exist so Transpose/Save act on sets[0], while Tabs starts on Summary', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('stacked.sql', 'SELECT 1', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf([multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1], { resultSetIds: [2] })], [s1, s2])
    })

    // Before ResultsStack mounts (Tabs layout default), Summary is active.
    expect(isSummaryActive(f.results.getSnapshot()[doc.id])).toBe(true)
    expect(f.results.focusedEntry(doc.id)).toBeUndefined()

    // Mounting ResultsStack with sets moves focus to the first displayed set immediately.
    mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsStack, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
    }))
    const focused = f.results.focusedEntry(doc.id)
    expect(focused).toBeDefined()
    expect(focused!.key).toBe(f.results.getSnapshot()[doc.id].sets[0].key)
    expect(isSummaryActive(f.results.getSnapshot()[doc.id])).toBe(false)
    expect(f.results.canTranspose(doc.id, focused!.key)).toBe(true)
  })

  it('R1-8: MultiRunSummary disables Line N error button immediately when the editor text changes', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('edit.sql', 'SELECT 1\nSELECT 2', 'SalesDB')
    let valid = true
    vi.spyOn(f.queries, 'sourceLine').mockImplementation(() => valid ? 2 : undefined)
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 1) } })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { status: 'failed', error: { code: '102', message: 'Syntax error', line: 2 } })],
        [],
        { status: 'failed' }
      )
    })

    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(MultiRunSummary, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id], active: true })
    }))
    const lineBtn = [...host.querySelectorAll<HTMLButtonElement>('.multi-target-link')].find(btn => btn.textContent?.includes('Line 2'))!
    expect(lineBtn.disabled).toBe(false)

    // Edit document: revision bumps and MultiRunSummary re-renders immediately, disabling Line 2.
    act(() => {
      valid = false
      f.documents.getModel(doc.id)!.pushEditOperations([], [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: 'X' }], () => null)
    })
    expect(lineBtn.disabled).toBe(true)
  })

  it('R1-9: transitions non-terminal multi-server targets to failed when finish() fails without multiSummary', () => {
    const { results, client } = serviceFixture()
    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    client.emit('q1', {
      type: 'multiQuery.targetState', targetKey: 'prod-east', phase: 'succeeded',
      batchesCompleted: 1, batchesTotal: 1, rowsAffected: 1, resultSetCount: 0, elapsedMs: 10
    })
    client.emit('q1', {
      type: 'multiQuery.targetState', targetKey: 'prod-west', phase: 'running',
      batchesCompleted: 0, batchesTotal: 1, rowsAffected: 0, resultSetCount: 0, elapsedMs: 12
    })
    void results.finish('t1', 'q1', { error: 'IPC transport failed.' })
    const multi = results.getSnapshot().t1.multi!
    expect(multi.status).toBe('failed')
    expect(multi.targets.map(t => t.phase)).toEqual(['succeeded', 'failed', 'failed'])
  })

  it('R1-10: CompareService recalculates exact on pick() until user explicitly sets exact or runs a comparison', () => {
    const { results } = serviceFixture()
    const compare = new CompareService(results)
    cleanups.add(() => compare.dispose())
    const cols: ResultColumn[] = [{ name: 'Id', dataType: 'int', wire: 'text', nullable: false }]
    const targets: MultiTargetIdentity[] = [
      { targetKey: 'sql-1', connectionId: 'c1', provider: 'sqlserver', label: 'sql-1' },
      { targetKey: 'sql-2', connectionId: 'c2', provider: 'sqlserver', label: 'sql-2' },
      { targetKey: 'bq-1', connectionId: 'c3', provider: 'bigquery', label: 'bq-1' }
    ]
    results.begin('t1', 'q1', undefined, { multi: { mode: 'crossEngineReadOnly', targets } })
    const sets = targets.map((target, index) => descriptor(index + 1, { index, targetKey: target.targetKey, statementSlot: 0, columns: cols }))
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(targets.map((target, index) => multiOutcome(target, { resultSetIds: [index + 1] })), sets, { mode: 'crossEngineReadOnly' })
    })
    const [sql1Key, sql2Key, bqKey] = results.getSnapshot().t1.sets.map(entry => entry.key)

    // Open on sql-2 (previous target sql-1 -> same engine -> exact: false).
    compare.open('t1', sql2Key)
    expect(compare.getSnapshot().pickers.t1.exact).toBe(false)

    // Pick BigQuery target: recalculates exact -> true without locking memory.exact.
    compare.pick('t1', bqKey)
    expect(compare.getSnapshot().pickers.t1.exact).toBe(true)

    // Swap does not lock memory.exact; picking sql-1 again recalculates exact -> false.
    compare.swap('t1')
    compare.pick('t1', sql1Key)
    expect(compare.getSnapshot().pickers.t1.exact).toBe(false)

    // Explicit setExact(false) persists memory.exact so picking BigQuery stays false.
    compare.setExact('t1', false)
    compare.pick('t1', bqKey)
    expect(compare.getSnapshot().pickers.t1.exact).toBe(false)
  })

  it('R1-11 & R1-13: styles.css includes forced-colors selected tab indicators and vertical-wrapping compare targets', () => {
    const rules = stylesheetRules()
    const forcedStatus = rules.find(rule => rule.at.includes('@media (forced-colors: active)') && rule.selector === '.rt-tab[data-selected] .rt-server-status')
    const forcedCount = rules.find(rule => rule.at.includes('@media (forced-colors: active)') && rule.selector === '.rt-tab[data-selected] .rt-stmt-count')
    expect(forcedStatus?.declarations).toContainEqual({ property: 'color', value: 'HighlightText' })
    expect(forcedCount?.declarations).toEqual(expect.arrayContaining([
      { property: 'background', value: 'HighlightText' },
      { property: 'color', value: 'Highlight' }
    ]))

    const targetRule = rules.find(rule => rule.selector === '.compare-target')
    const bodyRule = rules.find(rule => rule.selector === '.compare-target-body')
    expect(targetRule?.declarations).toContainEqual({ property: 'min-height', value: 'var(--varia-row)' })
    expect(bodyRule?.declarations).toEqual(expect.arrayContaining([
      { property: 'flex-direction', value: 'column' },
      { property: 'align-items', value: 'stretch' },
      { property: 'gap', value: '1px' }
    ]))
  })
})

describe('Round 2 adversarial regression checks (Domain 4: Results & CSS)', () => {
  it('R2-1: Previous/Next/Go to Result skip virtual Summary in Stacked layout with >=1 sets while keeping Summary navigable in Tabs and 0-set DDL runs', async () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)

    const doc = f.documents.create('stacked-nav.sql', 'SELECT 1', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const comb = descriptor(10, { index: 2, kind: 'combined', statementSlot: 0 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1], { resultSetIds: [2] })],
        [comb, s1, s2]
      )
    })
    const tabSets = f.results.getSnapshot()[doc.id].sets
    const combKey = tabSets.find(entry => entry.descriptor.kind === 'combined')!.key
    const eastKey = tabSets.find(entry => entry.descriptor.targetKey === 'prod-east')!.key
    const westKey = tabSets.find(entry => entry.descriptor.targetKey === 'prod-west')!.key

    // Stacked layout: mount ResultsStack so activeSummary clears to sets[0] (Combined).
    await f.settings.choose('queryResults.grid.layout', 'stacked')
    mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsStack, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
    }))
    expect(f.results.getSnapshot()[doc.id].focused).toBe(combKey)

    // Previous Result wraps backwards from sets[0] to last real grid instead of getting trapped on Summary.
    await act(async () => { await f.commands.execute('output.previousResult', undefined, 'keybinding') })
    expect(f.results.getSnapshot()[doc.id].focused).toBe(westKey)
    await act(async () => { await f.commands.execute('output.nextResult', undefined, 'keybinding') })
    expect(f.results.getSnapshot()[doc.id].focused).toBe(combKey)
    await act(async () => { await f.commands.execute('output.nextResult', undefined, 'keybinding') })
    expect(f.results.getSnapshot()[doc.id].focused).toBe(eastKey)
    await act(async () => { await f.commands.execute('output.goToResult1', undefined, 'keybinding') })
    expect(f.results.getSnapshot()[doc.id].focused).toBe(combKey)
    await act(async () => { await f.commands.execute('output.goToLastResult', undefined, 'keybinding') })
    expect(f.results.getSnapshot()[doc.id].focused).toBe(westKey)

    // Direct picker helper: includeSummary=false with 1 real grid returns undefined (cannot step).
    f.results.begin('one-set', 'q-one', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    void f.results.finish('one-set', 'q-one', {
      multiSummary: multiSummaryOf([multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1])], [s1])
    })
    const oneTab = f.results.getSnapshot()['one-set']
    expect(stepResult(oneTab, -1, false)).toBeUndefined()
    expect(stepResult(oneTab, -1, true)).toBe(oneTab.sets[0].key)

    // Tabs layout: Summary remains item 1 and Previous Result from Combined reaches Summary.
    await f.settings.choose('queryResults.grid.layout', 'tabs')
    f.results.focusEntry(doc.id, combKey)
    await act(async () => { await f.commands.execute('output.previousResult', undefined, 'keybinding') })
    expect(f.results.getSnapshot()[doc.id].focused).toBe(summaryEntryKey)
    await act(async () => { await f.commands.execute('output.nextResult', undefined, 'keybinding') })
    expect(f.results.getSnapshot()[doc.id].focused).toBe(combKey)
    await act(async () => { await f.commands.execute('output.goToResult1', undefined, 'keybinding') })
    expect(f.results.getSnapshot()[doc.id].focused).toBe(summaryEntryKey)

    // 0-set pure-DDL run in Stacked layout keeps Summary navigable via Go to Result 1.
    await f.settings.choose('queryResults.grid.layout', 'stacked')
    const ddlDoc = f.documents.create('ddl-nav.sql', 'CREATE TABLE #t (id int)', 'SalesDB')
    f.documents.activate(ddlDoc.id)
    f.results.begin(ddlDoc.id, 'q-ddl', undefined, { multi: { mode: 'transaction', targets: sqlTargets.slice(0, 2) } })
    void f.results.finish(ddlDoc.id, 'q-ddl', {
      multiSummary: multiSummaryOf(sqlTargets.slice(0, 2).map(target => multiOutcome(target, { status: 'committed' })), [], { mode: 'transaction' })
    })
    expect(jumpResult(f.results.getSnapshot()[ddlDoc.id], 1, true)).toBe(summaryEntryKey)
    await act(async () => { await f.commands.execute('output.goToResult1', undefined, 'keybinding') })
    expect(f.results.getSnapshot()[ddlDoc.id].focused).toBe(summaryEntryKey)
  })

  it('R2-2: CompareService.run() does not persist memory.exact so mixed Cross-Engine tabs keep exact defaults until setExact() is toggled', async () => {
    const { results } = serviceFixture()
    const compare = new CompareService(results)
    cleanups.add(() => compare.dispose())
    const cols: ResultColumn[] = [{ name: 'Id', dataType: 'int', wire: 'text', nullable: false }]
    const targets: MultiTargetIdentity[] = [
      { targetKey: 'sql-1', connectionId: 'c1', provider: 'sqlserver', label: 'sql-1' },
      { targetKey: 'sql-2', connectionId: 'c2', provider: 'sqlserver', label: 'sql-2' },
      { targetKey: 'bq-1', connectionId: 'c3', provider: 'bigquery', label: 'bq-1' }
    ]
    results.begin('t1', 'q1', undefined, { multi: { mode: 'crossEngineReadOnly', targets } })
    const sets = targets.map((target, index) => descriptor(index + 1, { index, targetKey: target.targetKey, statementSlot: 0, columns: cols }))
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(targets.map((target, index) => multiOutcome(target, { resultSetIds: [index + 1] })), sets, { mode: 'crossEngineReadOnly' })
    })
    const [sql1Key, sql2Key, bqKey] = results.getSnapshot().t1.sets.map(entry => entry.key)

    // 1. Run a cross-engine diff (sql-2 -> bq-1): defaults exact: true, does NOT lock memory.exact.
    compare.open('t1', bqKey)
    expect(compare.getSnapshot().pickers.t1.exact).toBe(true)
    expect(await compare.run('t1')).toBeDefined()

    // 2. Re-open on same-engine pair (sql-2 -> sql-1): still defaults exact: false!
    compare.open('t1', sql2Key)
    expect(compare.getSnapshot().pickers.t1.target).toBe(sql1Key)
    expect(compare.getSnapshot().pickers.t1.exact).toBe(false)
    expect(await compare.run('t1')).toBeDefined()

    // 3. Re-open same-engine pair and hit Show It (existing comparison branch): still does not lock memory.exact.
    compare.open('t1', sql2Key)
    expect(compare.getSnapshot().pickers.t1.exact).toBe(false)
    expect(await compare.run('t1')).toBeDefined()

    // 4. Re-open cross-engine pair (bq-1): still defaults exact: true!
    compare.open('t1', bqKey)
    expect(compare.getSnapshot().pickers.t1.exact).toBe(true)

    // 5. Explicit setExact(false) persists memory.exact across subsequent opens.
    compare.setExact('t1', false)
    compare.close('t1')
    compare.open('t1', bqKey)
    expect(compare.getSnapshot().pickers.t1.exact).toBe(false)
  })

  it('R2-3: BigQuery samples are excluded from combinedTargetCount, markCombinedStaleFor, and combinedSourcesOf', async () => {
    const baseClient = fakeResultClient()
    const combine = vi.fn<(...args: unknown[]) => Promise<ResultsCombineResult>>(async () => ({
      descriptor: descriptor(999, { kind: 'combined', index: 0, statementSlot: 0, rowsRead: 2, rowsStored: 2, rowsAvailable: 2 })
    }))
    const client = Object.assign(baseClient, { combine })
    const events = new EventBus()
    const api = {
      copyResults: vi.fn<VariaApi['copyResults']>(),
      saveResults: vi.fn<VariaApi['saveResults']>(),
      cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
      onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}),
      remoteQuery: vi.fn<VariaApi['remoteQuery']>()
    }
    const sample = vi.fn(async () => descriptor(88, { index: 5, kind: 'rows', targetKey: 'bq-1', statementSlot: 0, residence: 'memory', rowsRead: 100, rowsStored: 100, rowsAvailable: 100 }))
    const results = new ResultsService({ client, api, events, remote: { sample } as unknown as RemoteViews, frame: callback => callback() })
    cleanups.add(() => results.dispose())

    const targets: MultiTargetIdentity[] = [
      { targetKey: 'sql-1', connectionId: 'c1', provider: 'sqlserver', label: 'sql-1' },
      { targetKey: 'sql-2', connectionId: 'c2', provider: 'sqlserver', label: 'sql-2' },
      { targetKey: 'sql-3', connectionId: 'c3', provider: 'sqlserver', label: 'sql-3' },
      { targetKey: 'bq-1', connectionId: 'c4', provider: 'bigquery', label: 'bq-1' }
    ]
    results.begin('t1', 'q1', undefined, { multi: { mode: 'crossEngineReadOnly', targets } })
    const sql1 = descriptor(1, { index: 0, targetKey: 'sql-1', statementSlot: 0 })
    const sql2 = descriptor(2, { index: 1, targetKey: 'sql-2', statementSlot: 0 })
    const sql3 = descriptor(3, { index: 2, targetKey: 'sql-3', statementSlot: 0 })
    const bqRemote = descriptor(4, { index: 3, targetKey: 'bq-1', statementSlot: 0, residence: 'remote', rowsRead: 50000, rowsStored: 0, rowsAvailable: 50000 })
    const comb = descriptor(10, { index: 4, kind: 'combined', statementSlot: 0 })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(targets[0], { resultSetIds: [1] }),
          multiOutcome(targets[1], { resultSetIds: [2] }),
          multiOutcome(targets[2], { resultSetIds: [3] }),
          multiOutcome(targets[3], { resultSetIds: [4] })
        ],
        [sql1, sql2, sql3, bqRemote, comb],
        { mode: 'crossEngineReadOnly' }
      )
    })
    const bqKey = results.getSnapshot().t1.sets.find(entry => entry.descriptor.resultId === 4)!.key
    const combinedKey = results.getSnapshot().t1.sets.find(entry => entry.descriptor.kind === 'combined')!.key

    // Before loading sample: Combined counts 3/4 in-memory servers.
    expect(combinedTargetCount(results.getSnapshot().t1, 0)).toBe(3)

    // Load a BigQuery sample: sample does NOT inflate Combined (k/N) to 4/4.
    expect(await results.loadSample('t1', bqKey, 100, 'first')).toBeUndefined()
    const sampleEntry = results.getSnapshot().t1.sets.find(entry => entry.sample)
    expect(sampleEntry).toBeDefined()
    expect(combinedTargetCount(results.getSnapshot().t1, 0)).toBe(3)

    // Closing the sample does NOT mark Combined stale.
    expect(results.removeEntry('t1', sampleEntry!.key)).toBe(true)
    expect(results.getSnapshot().t1.staleCombined?.has(combinedKey) ?? false).toBe(false)

    // Re-load sample, drop sql-3 (marks Combined stale), and rebuild Combined: sample is NOT fed into results.combine!
    expect(await results.loadSample('t1', bqKey, 100, 'first')).toBeUndefined()
    expect(results.getSnapshot().t1.sets.some(entry => entry.sample)).toBe(true)
    expect(results.removeTargetEntries('t1', 'sql-3')).toBe(true)
    expect(results.getSnapshot().t1.staleCombined?.has(combinedKey)).toBe(true)
    await results.rebuildCombined('t1', combinedKey)
    expect(combine).toHaveBeenCalledTimes(1)
    expect(combine.mock.calls[0][0]).toEqual([baseClient.handle(1), baseClient.handle(2)])

    // Dropping sql-2 leaves only 1 real server + 1 sample: sample cannot satisfy the >=2 source requirement.
    expect(results.removeTargetEntries('t1', 'sql-2')).toBe(true)
    expect(results.canRebuildCombined('t1', combinedKey)).toBe(false)
  })

  it('R2-4: styles.css caps expanded Stacked summary band at min(210px, 45%) so short panes never starve grids', () => {
    const rules = stylesheetRules()
    const bandRule = rules.find(rule => rule.selector === '.rs-multi-summary-band')
    const openBandRule = rules.find(rule => rule.selector === '.rs-multi-summary-band[data-open]')
    const compactRule = rules.find(rule => rule.selector === '.multi-summary-compact')
    expect(bandRule?.declarations).toEqual(expect.arrayContaining([
      { property: 'display', value: 'flex' },
      { property: 'flex-direction', value: 'column' }
    ]))
    expect(openBandRule?.declarations).toEqual(expect.arrayContaining([
      { property: 'max-height', value: 'min(210px, 45%)' },
      { property: 'overflow', value: 'hidden' }
    ]))
    expect(compactRule?.declarations).toEqual(expect.arrayContaining([
      { property: 'flex', value: '1 1 auto' },
      { property: 'min-height', value: '0' },
      { property: 'max-height', value: 'none' },
      { property: 'overflow-y', value: 'auto' }
    ]))
  })

  it('R2-5: settledContent accepts entries slice with full tab.sets so tabsNeed never adds phantom +28px partialCombine height on complete Combined (N/N)', () => {
    const { results } = serviceFixture()
    const targets = sqlTargets.slice(0, 2)
    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, rowsRead: 1, rowsStored: 1, rowsAvailable: 1 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0, rowsRead: 1, rowsStored: 1, rowsAvailable: 1 })
    const comb = descriptor(10, { index: 2, kind: 'combined', statementSlot: 0, rowsRead: 1, rowsStored: 1, rowsAvailable: 1 })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(targets[0], { resultSetIds: [1] }), multiOutcome(targets[1], { resultSetIds: [2] })],
        [comb, s1, s2]
      )
    })
    const tab = results.getSnapshot().t1
    const combEntry = tab.sets.find(entry => entry.descriptor.kind === 'combined')!
    const eastEntry = tab.sets.find(entry => entry.descriptor.targetKey === 'prod-east')!

    expect(entryNoticesHeight(tab, combEntry)).toBe(0)
    const combSettled = settledContent(tab, undefined, undefined, [combEntry])[0]
    const eastSettled = settledContent(tab, undefined, undefined, [eastEntry])[0]
    expect(combSettled).toBeDefined()
    expect(combSettled).toBe(eastSettled)

    results.focusEntry('t1', combEntry.key)
    const combinedNeed = tabsNeed(results.getSnapshot().t1)
    results.focusEntry('t1', eastEntry.key)
    const eastNeed = tabsNeed(results.getSnapshot().t1)
    expect(combinedNeed).toBe(eastNeed)
  })

  it('R2-6: pivotOutOfDate immediately flags a Pivot on Combined after Combined is rebuilt in place', async () => {
    const { results } = serviceFixture()
    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const s3 = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0 })
    const comb = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0 })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1], { resultSetIds: [2] }), multiOutcome(sqlTargets[2], { resultSetIds: [3] })],
        [s1, s2, s3, comb]
      )
    })
    const combinedKey = results.getSnapshot().t1.sets.find(entry => entry.descriptor.kind === 'combined')!.key
    const provenance = { recipe: { rows: [0], values: [{ aggregate: 'count' }] }, filters: [], inputRows: 4, truncated: false, incomplete: false, approximate: false }
    results.addSet('t1', descriptor(810, { kind: 'pivot', index: 3 }), 'Pivot of Combined', ['1:10'], { pivot: provenance })

    const groupBefore = results.getSnapshot().t1.groups.find(group => group.table.key === combinedKey)!
    expect(pivotOutOfDate(results.getSnapshot().t1, groupBefore)).toBe(false)

    // Drop a server and rebuild Combined in place (new resultId = 999): Pivot immediately becomes out of date.
    results.removeTargetEntries('t1', 'dev-01')
    await results.rebuildCombined('t1', combinedKey)
    const tabAfter = results.getSnapshot().t1
    const groupAfter = tabAfter.groups.find(group => group.table.key === combinedKey)!
    expect(groupAfter.table.entry.descriptor.resultId).toBe(999)
    expect(pivotOutOfDate(tabAfter, groupAfter)).toBe(true)

    // Updating the Pivot from the rebuilt Combined clears out-of-date.
    results.addSet('t1', descriptor(811, { kind: 'pivot', index: 3 }), 'Pivot of Combined', ['1:999'], { pivot: provenance })
    const tabUpdated = results.getSnapshot().t1
    expect(pivotOutOfDate(tabUpdated, tabUpdated.groups.find(group => group.table.key === combinedKey)!)).toBe(false)
  })

  it('R2-7: ComparePopover resets filter on picker.active change, focuses checked radio first on search Enter, and selects unchecked radio on Enter instead of submitting hidden target', () => {
    const { results } = serviceFixture()
    const compare = new CompareService(results)
    cleanups.add(() => compare.dispose())
    const cols: ResultColumn[] = [{ name: 'Id', dataType: 'int', wire: 'text', nullable: false }]
    const manyTargets: MultiTargetIdentity[] = Array.from({ length: 10 }, (_, index) => ({
      targetKey: `srv-${index + 1}`, connectionId: `c-${index + 1}`, provider: 'sqlserver', label: `node-${index + 1}`
    }))
    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: manyTargets } })
    const manySets = manyTargets.map((target, index) => descriptor(index + 1, { index, targetKey: target.targetKey, statementSlot: 0, columns: cols }))
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(manyTargets.map((target, index) => multiOutcome(target, { resultSetIds: [index + 1] })), manySets)
    })
    const keys = results.getSnapshot().t1.sets.map(entry => entry.key)
    const runSpy = vi.spyOn(compare, 'run').mockResolvedValue(undefined)

    compare.open('t1', keys[0], 'grid')
    compare.pick('t1', keys[4]) // node-5 is checked (not first visible radio)
    const workbench = { results, compare } as unknown as Workbench
    mount(createElement(WorkbenchProvider, {
      workbench,
      children: createElement('div', { 'data-pane': 'results' }, createElement(ComparePopover, { tabId: 't1', tab: results.getSnapshot().t1 }))
    }))

    // 1. Enter in .compare-search focuses the checked radio first when visible.
    const search = document.querySelector<HTMLInputElement>('input.compare-search')!
    search.focus()
    act(() => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    const checkedRadio = document.querySelector<HTMLInputElement>('.compare-targets input[type="radio"]:checked')!
    expect(document.activeElement).toBe(checkedRadio)
    expect(runSpy).not.toHaveBeenCalled()

    // 2. Filter out checked node-5 so only unchecked node-9 is visible; Enter in search focuses node-9.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(search, 'node-9')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    search.focus()
    act(() => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    const visibleRadio = document.querySelector<HTMLInputElement>('.compare-targets input[type="radio"]')!
    expect(visibleRadio.checked).toBe(false)
    expect(document.activeElement).toBe(visibleRadio)

    // 3. Enter on unchecked visible radio selects it via click/compare.pick instead of submitting hidden node-5.
    act(() => { visibleRadio.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(runSpy).not.toHaveBeenCalled()
    expect(compare.getSnapshot().pickers.t1.target).toBe(keys[8])

    // 4. Enter again on the now-checked radio starts comparison.
    const nowChecked = document.querySelector<HTMLInputElement>('.compare-targets input[type="radio"]:checked')!
    act(() => { nowChecked.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(runSpy).toHaveBeenCalledTimes(1)

    // 5. Switching picker.active while popover stays open resets the quick search filter.
    expect(search.value).toBe('node-9')
    act(() => { compare.open('t1', keys[1], 'grid') })
    expect(document.querySelector<HTMLInputElement>('input.compare-search')!.value).toBe('')
  })

  it('R2-8: ResultsTabs recovers focus inside the statement row (stmt tab -> .rt-stmt-select -> top result tab)', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('stmt-focus.sql', 'SELECT 1; SELECT 2', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, name: 'S1' })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-east', statementSlot: 1, name: 'S2' })
    const w1 = descriptor(3, { index: 2, targetKey: 'prod-west', statementSlot: 0, name: 'S1' })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1, 2] }), multiOutcome(sqlTargets[1], { resultSetIds: [3] })],
        [s1, s2, w1]
      )
    })
    const [s1Key, s2Key, w1Key] = f.results.getSnapshot()[doc.id].sets.map(entry => entry.key)
    f.results.focusEntry(doc.id, s1Key)

    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.add(() => { act(() => root.unmount()); host.remove() })
    const renderTabs = (tab = f.results.getSnapshot()[doc.id]) => act(() => {
      root.render(createElement(WorkbenchProvider, {
        workbench: f as unknown as Workbench,
        children: createElement(ResultsTabs, { tabId: doc.id, tab })
      }))
    })
    renderTabs()

    // Focus Statement 1 tab inside [data-tab-row="stmt"].
    const stmt1Tab = host.querySelector<HTMLButtonElement>(`[data-tab-row="stmt"] [data-tab-entry="${s1Key}"]`)!
    expect(stmt1Tab).not.toBeNull()
    act(() => { stmt1Tab.focus() })
    expect(document.activeElement).toBe(stmt1Tab)

    // External switch to Statement 2 keeps focus on the selected statement tab (not the top-level server tab).
    f.results.focusEntry(doc.id, s2Key)
    renderTabs()
    const stmt2Tab = host.querySelector<HTMLButtonElement>(`[data-tab-row="stmt"] [data-tab-entry="${s2Key}"]`)!
    expect(document.activeElement).toBe(stmt2Tab)

    // Collapsing statement tabs into .rt-stmt-select (>3 statements) recovers focus onto .rt-stmt-select.
    const baseTab = f.results.getSnapshot()[doc.id]
    const extraGroup = (id: number, slot: number) => ({
      ...baseTab.groups[0],
      ordinal: id,
      table: {
        ...baseTab.groups[0].table,
        key: `extra-${id}`,
        entry: { ...baseTab.groups[0].table.entry, key: `extra-${id}`, number: id, descriptor: descriptor(id, { index: id, targetKey: 'prod-east', statementSlot: slot, name: `S${slot + 1}` }) }
      }
    })
    const collapsedTab = { ...baseTab, groups: [...baseTab.groups, extraGroup(4, 2), extraGroup(5, 3)] }
    renderTabs(collapsedTab)
    const stmtSelect = host.querySelector<HTMLSelectElement>('select.rt-stmt-select')!
    expect(stmtSelect).not.toBeNull()
    expect(document.activeElement).toBe(stmtSelect)

    // Switching to prod-west (no statement row) falls back to the selected top-level result tab.
    f.results.focusEntry(doc.id, w1Key)
    renderTabs()
    const westTopTab = host.querySelector<HTMLButtonElement>('[data-tab-row="result"] [data-target-key="prod-west"] [role="tab"]')!
    expect(document.activeElement).toBe(westTopTab)
  })
})

describe('Round 3 adversarial regression fixes (R3-1 through R3-12)', () => {
  it('R3-1: loaded() and rerunInPlace() mark Combined stale when a windowed BigQuery set enters memory', async () => {
    const baseClient = fakeResultClient()
    const combine = vi.fn<(...args: unknown[]) => Promise<ResultsCombineResult>>(async () => ({
      descriptor: descriptor(999, { kind: 'combined', index: 0, statementSlot: 0, rowsRead: 6, rowsStored: 6, rowsAvailable: 6 })
    }))
    const client = Object.assign(baseClient, { combine })
    const events = new EventBus()
    const loadedBq = descriptor(3, { index: 2, targetKey: 'bq-1', statementSlot: 0, residence: 'memory', revision: 1, rowsRead: 2, rowsStored: 2, rowsAvailable: 2 })
    const rerunBq = descriptor(30, { index: 2, targetKey: 'bq-1', statementSlot: 0, residence: 'memory', rowsRead: 2, rowsStored: 2, rowsAvailable: 2 })
    const api = {
      copyResults: vi.fn<VariaApi['copyResults']>(),
      saveResults: vi.fn<VariaApi['saveResults']>(),
      cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
      onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}),
      remoteQuery: vi.fn<NonNullable<VariaApi['remoteQuery']>>(async () => ({
        ok: true,
        value: {
          status: 'completed',
          recordsAffected: 0,
          completedBatches: 1,
          totalBatches: 1,
          database: 'sales_dw',
          resultSets: [loadedBq],
          planSets: [],
          discardedResultSets: 0,
          messages: [],
          messagesTruncated: false,
          elapsedMs: 10,
          budget: { usedBytes: 1024, globalBytes: 256 * 1048576, queryBytes: 128 * 1048576, generation: 1, seq: 1 },
          completedAt: '2026-11-26T18:30:00.0000000+00:00'
        }
      }))
    }
    const remote = {
      sample: vi.fn(),
      rerun: vi.fn(async () => rerunBq)
    } as unknown as RemoteViews
    const results = new ResultsService({ client, api, events, remote, frame: callback => callback() })
    cleanups.add(() => results.dispose())

    const targets: MultiTargetIdentity[] = [
      { targetKey: 'sql-1', connectionId: 'c1', provider: 'sqlserver', label: 'sql-1' },
      { targetKey: 'sql-2', connectionId: 'c2', provider: 'sqlserver', label: 'sql-2' },
      { targetKey: 'bq-1', connectionId: 'c3', provider: 'bigquery', label: 'bq-1' }
    ]
    // Part A: loaded() marks Combined stale when BigQuery set loads into memory.
    results.begin('t1', 'q1', undefined, { multi: { mode: 'crossEngineReadOnly', targets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'sql-1', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'sql-2', statementSlot: 0 })
    const bqRemote = descriptor(3, { index: 2, targetKey: 'bq-1', statementSlot: 0, residence: 'remote', rowsRead: 50000, rowsStored: 0, rowsAvailable: 50000 })
    const comb = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0 })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(targets[0], { resultSetIds: [1] }), multiOutcome(targets[1], { resultSetIds: [2] }), multiOutcome(targets[2], { resultSetIds: [3] })],
        [s1, s2, bqRemote, comb],
        { mode: 'crossEngineReadOnly' }
      )
    })
    const bqKey = results.getSnapshot().t1.sets.find(entry => entry.descriptor.targetKey === 'bq-1')!.key
    const combinedKey = results.getSnapshot().t1.sets.find(entry => entry.descriptor.kind === 'combined')!.key
    expect(results.getSnapshot().t1.staleCombined?.has(combinedKey) ?? false).toBe(false)

    await results.loadIntoMemory('t1', bqKey)
    const afterLoad = results.getSnapshot().t1
    expect(afterLoad.staleCombined?.has(combinedKey)).toBe(true)
    const staleNotice = entryNotices(afterLoad, afterLoad.sets.find(entry => entry.key === combinedKey)!).find(notice => notice.kind === 'staleCombined')
    expect(staleNotice?.text).toContain('Source server results changed')
    expect(staleNotice?.text).not.toContain('was closed')
    expect(results.canRebuildCombined('t1', combinedKey)).toBe(true)

    // Part B: rerunInPlace() marks Combined stale when a windowed BigQuery set re-runs into memory.
    results.begin('t2', 'q2', undefined, { multi: { mode: 'crossEngineReadOnly', targets } })
    const s1b = descriptor(11, { index: 0, targetKey: 'sql-1', statementSlot: 0 })
    const s2b = descriptor(12, { index: 1, targetKey: 'sql-2', statementSlot: 0 })
    const bqRemote2 = descriptor(13, { index: 2, targetKey: 'bq-1', statementSlot: 0, residence: 'remote', rowsRead: 50000, rowsStored: 0, rowsAvailable: 50000 })
    const comb2 = descriptor(20, { index: 3, kind: 'combined', statementSlot: 0 })
    void results.finish('t2', 'q2', {
      multiSummary: multiSummaryOf(
        [multiOutcome(targets[0], { resultSetIds: [11] }), multiOutcome(targets[1], { resultSetIds: [12] }), multiOutcome(targets[2], { resultSetIds: [13] })],
        [s1b, s2b, bqRemote2, comb2],
        { mode: 'crossEngineReadOnly' }
      )
    })
    const bqKey2 = results.getSnapshot().t2.sets.find(entry => entry.descriptor.targetKey === 'bq-1')!.key
    const combinedKey2 = results.getSnapshot().t2.sets.find(entry => entry.descriptor.kind === 'combined')!.key
    expect(results.getSnapshot().t2.staleCombined?.has(combinedKey2) ?? false).toBe(false)

    await results.rerun('t2', bqKey2)
    expect(results.getSnapshot().t2.staleCombined?.has(combinedKey2)).toBe(true)
  })

  it('R3-2: PivotService tracks sourceSet in tried, auto-follows rebuilt Combined with remapped columns, and refuses missing columns cleanly', async () => {
    const colsBefore: ResultColumn[] = [
      { name: 'Server', dataType: 'nvarchar', wire: 'text', nullable: false },
      { name: 'Region', dataType: 'nvarchar', wire: 'text', nullable: false },
      { name: 'Amount', dataType: 'int', wire: 'text', nullable: false }
    ]
    const colsShifted: ResultColumn[] = [
      { name: 'Server', dataType: 'nvarchar', wire: 'text', nullable: false },
      { name: 'ExtraCol', dataType: 'nvarchar', wire: 'text', nullable: true },
      { name: 'Amount', dataType: 'int', wire: 'text', nullable: false },
      { name: 'Region', dataType: 'nvarchar', wire: 'text', nullable: false }
    ]
    const colsMissing: ResultColumn[] = [
      { name: 'Server', dataType: 'nvarchar', wire: 'text', nullable: false },
      { name: 'ExtraCol', dataType: 'nvarchar', wire: 'text', nullable: true }
    ]
    const baseClient = fakeResultClient()
    let rebuildSeq = 0
    const combine = vi.fn<(...args: unknown[]) => Promise<ResultsCombineResult>>(async () => {
      rebuildSeq++
      return {
        descriptor: descriptor(900 + rebuildSeq, {
          kind: 'combined',
          index: 3,
          statementSlot: 0,
          columns: rebuildSeq === 1 ? colsShifted : colsMissing,
          rowsRead: 4,
          rowsStored: 4,
          rowsAvailable: 4
        })
      }
    })
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
    let followNow = 10
    const pivot = new PivotService(results, {
      follow: { layout: () => 'stacked', resultsShowing: () => true, onLayout: () => () => {} },
      now: () => followNow++,
      defer: callback => callback()
    })
    cleanups.add(() => pivot.dispose())

    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, columns: colsBefore })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0, columns: colsBefore })
    const s3 = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0, columns: colsBefore })
    const comb = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0, columns: colsBefore })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1], { resultSetIds: [2] }), multiOutcome(sqlTargets[2], { resultSetIds: [3] })],
        [s1, s2, s3, comb]
      )
    })
    const combinedKey = results.getSnapshot().t1.sets.find(entry => entry.descriptor.kind === 'combined')!.key

    // Build initial Pivot on Combined: rows=[1] (Region), values=[sum of 2 (Amount)].
    pivot.open('t1', combinedKey)
    pivot.setDraft('t1', { rows: [1], values: [{ aggregate: 'sum', column: 2 }] })
    await pivot.run('t1')
    const initialPivot = results.getSnapshot().t1.groups.find(group => group.table.key === combinedKey)!.pivot!
    expect(initialPivot.pivot?.sourceColumns).toEqual(['Server', 'Region', 'Amount'])

    // Rebuild Combined in place with shifted columns: auto-follow must fire (tried tracks sourceSet!) with remapped indices (Region -> 3, Amount -> 2).
    results.removeTargetEntries('t1', 'dev-01')
    await results.rebuildCombined('t1', combinedKey)
    await new Promise(resolve => setTimeout(resolve, 0))

    const rebuiltHandle = baseClient.handle(901)!
    expect(rebuiltHandle.pivot).toHaveBeenCalledTimes(1)
    expect(rebuiltHandle.pivot).toHaveBeenCalledWith(
      { rows: [3], values: [{ aggregate: 'sum', column: 2 }] },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    const followedGroup = results.getSnapshot().t1.groups.find(group => group.table.key === combinedKey)!
    expect(pivotOutOfDate(results.getSnapshot().t1, followedGroup)).toBe(false)
    expect(followedGroup.pivot?.pivot?.sourceColumns).toEqual(['Server', 'ExtraCol', 'Amount', 'Region'])

    // Rebuild Combined again dropping Region and Amount: auto-follow and explicit update() refuse cleanly without calling backend pivot().
    await results.rebuildCombined('t1', combinedKey)
    await new Promise(resolve => setTimeout(resolve, 0))
    const missingHandle = baseClient.handle(902)!
    expect(missingHandle.pivot).not.toHaveBeenCalled()
    expect(pivot.getSnapshot().tabs.t1.error).toContain('Region')
    expect(pivot.getSnapshot().tabs.t1.error).toContain('Amount')

    await pivot.update('t1', combinedKey)
    expect(missingHandle.pivot).not.toHaveBeenCalled()
    expect(results.getSnapshot().t1.jobNotice).toContain('no longer in')
  })

  it('R3-3: Stacked stepResult/jumpResult step over every statement grid in stacked order and ResultsStack resets statement filter on reveal', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('r3-nav.sql', 'SELECT 1; SELECT 2', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const e1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const e2 = descriptor(2, { index: 1, targetKey: 'prod-east', statementSlot: 1 })
    const w1 = descriptor(3, { index: 2, targetKey: 'prod-west', statementSlot: 0 })
    const w2 = descriptor(4, { index: 3, targetKey: 'prod-west', statementSlot: 1 })
    const c1 = descriptor(10, { index: 4, kind: 'combined', statementSlot: 0 })
    const c2 = descriptor(11, { index: 5, kind: 'combined', statementSlot: 1 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1, 2] }), multiOutcome(sqlTargets[1], { resultSetIds: [3, 4] })],
        [e1, e2, w1, w2, c1, c2]
      )
    })
    const keyOf = (id: number) => f.results.getSnapshot()[doc.id].sets.find(entry => entry.descriptor.resultId === id)!.key
    const [e1Key, e2Key, w1Key, w2Key, c1Key, c2Key] = [1, 2, 3, 4, 10, 11].map(keyOf)
    const expectedOrder = [c1Key, c2Key, e1Key, e2Key, w1Key, w2Key]

    // Part A: includeSummary=false visits every statement grid in stacked order.
    f.results.focusEntry(doc.id, c1Key)
    const visited = [c1Key]
    for (let step = 1; step < expectedOrder.length; step++) {
      const next = stepResult(f.results.getSnapshot()[doc.id], 1, false)!
      visited.push(next)
      f.results.focusEntry(doc.id, next)
    }
    expect(visited).toEqual(expectedOrder)
    expect(jumpResult(f.results.getSnapshot()[doc.id], 4, false)).toBe(e2Key)
    expect(jumpResult(f.results.getSnapshot()[doc.id], 'last', false)).toBe(w2Key)
    // Tabs layout (includeSummary=true) keeps Summary as item 1 and collapsed server tabs.
    expect(jumpResult(f.results.getSnapshot()[doc.id], 1, true)).toBe(summaryEntryKey)

    // Part B: ResultsStack resets selectedStmt to 'all' on stackReveals and search reveal when target is in another slot.
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(1600)
    cleanups.add(() => heightSpy.mockRestore())
    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsStack, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
    }))
    const stmt1Btn = [...host.querySelectorAll<HTMLButtonElement>('.rs-stmt-btn')].find(btn => btn.textContent?.includes('Statement 1'))!
    act(() => { stmt1Btn.click() })
    expect(stmt1Btn.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector(`[data-caption-entry="${e2Key}"]`)).toBeNull()

    // Request reveal via stackReveals for a Statement 2 entry -> resets filter to All statements.
    act(() => { stackReveals.request(doc.id, e2Key) })
    const allBtn = [...host.querySelectorAll<HTMLButtonElement>('.rs-stmt-btn')].find(btn => btn.textContent === 'All statements')!
    expect(allBtn.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector(`[data-caption-entry="${e2Key}"]`)).not.toBeNull()

    // Filter back to Statement 1, then trigger search reveal for Statement 2 entry -> resets filter to All statements.
    act(() => { stmt1Btn.click() })
    expect(host.querySelector(`[data-caption-entry="${w2Key}"]`)).toBeNull()
    vi.spyOn(f.resultsSearch, 'pendingReveal').mockImplementation((_tabId, key) => key === w2Key)
    const searchSnap = f.resultsSearch.getSnapshot()
    vi.spyOn(f.resultsSearch, 'getSnapshot').mockReturnValue({
      ...searchSnap,
      [doc.id]: { text: 'foo', mode: 'values', status: 'done', total: 1, current: 0, columns: 0, partial: false, approximate: false, marks: new Map(), reveal: 99, revealEntry: w2Key, revealSelect: false, focus: 0, announcement: '' }
    })
    act(() => { (f.resultsSearch as unknown as { publish(v: unknown): void }).publish(f.resultsSearch.getSnapshot()) })
    expect(allBtn.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector(`[data-caption-entry="${w2Key}"]`)).not.toBeNull()
  })

  it('R3-4: addSample() clears run.activeSummary so loading a BigQuery sample while Summary is active shows the sample', async () => {
    const baseClient = fakeResultClient()
    const client = Object.assign(baseClient, { combine: vi.fn() })
    const events = new EventBus()
    const api = {
      copyResults: vi.fn<VariaApi['copyResults']>(),
      saveResults: vi.fn<VariaApi['saveResults']>(),
      cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
      onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}),
      remoteQuery: vi.fn<NonNullable<VariaApi['remoteQuery']>>()
    }
    const sampleDesc = descriptor(90, { index: 0, targetKey: 'bq-1', statementSlot: 0, rowsRead: 100, rowsStored: 100, rowsAvailable: 100 })
    const remote = { sample: vi.fn(async () => sampleDesc), rerun: vi.fn() } as unknown as RemoteViews
    const results = new ResultsService({ client, api, events, remote, frame: callback => callback() })
    cleanups.add(() => results.dispose())

    results.begin('t1', 'q1', undefined, { multi: { mode: 'crossEngineReadOnly', targets: crossTargets } })
    const sql1 = descriptor(1, { index: 0, targetKey: 'sql-1', statementSlot: 0 })
    const bqRemote = descriptor(2, { index: 1, targetKey: 'bq-1', statementSlot: 0, residence: 'remote', rowsRead: 50000, rowsStored: 0, rowsAvailable: 50000 })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(crossTargets[0], { resultSetIds: [1] }), multiOutcome(crossTargets[1], { resultSetIds: [2] })],
        [sql1, bqRemote],
        { mode: 'crossEngineReadOnly' }
      )
    })
    const bqKey = results.getSnapshot().t1.sets.find(entry => entry.descriptor.targetKey === 'bq-1')!.key
    // Summary is active before loading the sample.
    expect(isSummaryActive(results.getSnapshot().t1)).toBe(true)

    await results.loadSample('t1', bqKey, 100, 'first')
    const after = results.getSnapshot().t1
    const sampleEntry = after.sets.find(entry => entry.sample)!
    expect(sampleEntry).toBeDefined()
    expect(isSummaryActive(after)).toBe(false)
    expect(after.activeSummary).toBeUndefined()
    expect(after.focused).toBe(sampleEntry.key)
  })

  it('R3-5: plain Compare with Previous Result preserves an explicit exact:false choice on Cross-Engine pairs while Exact Text variant upgrades it', async () => {
    const { results } = serviceFixture()
    const compare = new CompareService(results)
    cleanups.add(() => compare.dispose())
    const cols: ResultColumn[] = [{ name: 'Id', dataType: 'int', wire: 'text', nullable: false }]
    results.begin('t1', 'q1', undefined, { multi: { mode: 'crossEngineReadOnly', targets: crossTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'sql-1', statementSlot: 0, columns: cols })
    const bq1 = descriptor(2, { index: 1, targetKey: 'bq-1', statementSlot: 0, columns: cols })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(crossTargets[0], { resultSetIds: [1] }), multiOutcome(crossTargets[1], { resultSetIds: [2] })],
        [s1, bq1],
        { mode: 'crossEngineReadOnly' }
      )
    })
    const [sqlKey, bqKey] = results.getSnapshot().t1.sets.map(entry => entry.key)

    // User explicitly creates a non-exact comparison on the Cross-Engine pair.
    const made = await compare.comparePair('t1', sqlKey, bqKey, { exact: false })
    expect(made && 'key' in made).toBe(true)
    const diffKey = (made as { readonly key: string }).key
    const slotBefore = results.getSnapshot().t1.comparisons.find(slot => slot.key === diffKey)!
    expect(compare.stateOf('t1', slotBefore.entry)?.exact).toBe(false)

    // Plain Compare with Previous Result focuses it without overwriting exact: false.
    results.focusEntry('t1', bqKey)
    await compare.compare('t1', bqKey)
    const slotAfterPlain = results.getSnapshot().t1.comparisons.find(slot => slot.key === diffKey)!
    expect(results.getSnapshot().t1.focused).toBe(diffKey)
    expect(compare.stateOf('t1', slotAfterPlain.entry)?.exact).toBe(false)

    // Explicit Exact Text variant upgrades it to exact: true.
    await compare.compare('t1', bqKey, { exact: true })
    const slotAfterExact = results.getSnapshot().t1.comparisons.find(slot => slot.key === diffKey)!
    expect(compare.stateOf('t1', slotAfterExact.entry)?.exact).toBe(true)

    // First-time plain compare (when no comparison exists) still defaults Cross-Engine to exact: true.
    results.removeEntry('t1', diffKey)
    await compare.compare('t1', bqKey)
    const freshSlot = results.getSnapshot().t1.comparisons[0]
    expect(compare.stateOf('t1', freshSlot.entry)?.exact).toBe(true)
  })

  it('R3-6: combine warnings are tracked per Combined entry so rebuilding Statement 1 never wipes Statement 2 warnings', async () => {
    const baseClient = fakeResultClient()
    const nextWarnings: (readonly string[])[] = [[], ['Stmt 1 drift'], ['Stmt 2 drift'], []]
    let seq = 0
    const combine = vi.fn<(...args: unknown[]) => Promise<ResultsCombineResult>>(async () => {
      const idx = seq++
      const warnings = nextWarnings[idx] ?? []
      return {
        descriptor: descriptor(700 + idx, { kind: 'combined', index: 0, statementSlot: idx === 2 ? 1 : 0, rowsRead: 2, rowsStored: 2, rowsAvailable: 2 }),
        warnings: [...warnings]
      } as ResultsCombineResult
    })
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

    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const sets = [
      descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 }),
      descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 }),
      descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0 }),
      descriptor(4, { index: 3, targetKey: 'prod-east', statementSlot: 1 }),
      descriptor(5, { index: 4, targetKey: 'prod-west', statementSlot: 1 }),
      descriptor(6, { index: 5, targetKey: 'dev-01', statementSlot: 1 }),
      descriptor(10, { index: 6, kind: 'combined', statementSlot: 0 }),
      descriptor(11, { index: 7, kind: 'combined', statementSlot: 1 })
    ]
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1, 4] }), multiOutcome(sqlTargets[1], { resultSetIds: [2, 5] }), multiOutcome(sqlTargets[2], { resultSetIds: [3, 6] })],
        sets,
        { combineWarnings: ['Initial warning'] }
      )
    })
    const c1Key = results.getSnapshot().t1.sets.find(entry => entry.descriptor.kind === 'combined' && entry.descriptor.statementSlot === 0)!.key
    const c2Key = results.getSnapshot().t1.sets.find(entry => entry.descriptor.kind === 'combined' && entry.descriptor.statementSlot === 1)!.key
    results.removeTargetEntries('t1', 'dev-01')

    // Rebuild Stmt 1 cleanly ([]): Stmt 1 clears its warning, Stmt 2 keeps Initial warning.
    await results.rebuildCombined('t1', c1Key)
    let tab = results.getSnapshot().t1
    expect(tab.multi?.combineWarnings).toEqual(['Initial warning'])
    expect(entryNotices(tab, tab.sets.find(e => e.key === c1Key)!).some(n => n.kind === 'combineWarning')).toBe(false)
    expect(entryNotices(tab, tab.sets.find(e => e.key === c2Key)!).find(n => n.kind === 'combineWarning')?.text).toBe('Initial warning')

    // Rebuild Stmt 1 with its own warning, then Stmt 2 with its own warning, then Stmt 1 cleanly again -> Stmt 2's warning survives!
    await results.rebuildCombined('t1', c1Key)
    await results.rebuildCombined('t1', c2Key)
    await results.rebuildCombined('t1', c1Key)
    tab = results.getSnapshot().t1
    expect(tab.multi?.combineWarnings).toEqual(['Stmt 2 drift'])
    expect(entryNotices(tab, tab.sets.find(e => e.key === c1Key)!).some(n => n.kind === 'combineWarning')).toBe(false)
    expect(entryNotices(tab, tab.sets.find(e => e.key === c2Key)!).find(n => n.kind === 'combineWarning')?.text).toBe('Stmt 2 drift')
  })

  it('R3-7: picking Summary from ResultsPicker while fold===none removes data-fold on render and focuses the visible Summary tab', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('r3-fold.sql', 'SELECT 1', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1], { resultSetIds: [2] })],
        [s1, s2]
      )
    })
    const firstKey = f.results.getSnapshot()[doc.id].sets[0].key
    f.results.focusEntry(doc.id, firstKey)

    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.add(() => { act(() => root.unmount()); host.remove() })
    // Simulate a short pane where tabsFold returns 'none' for a grid.
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(80)
    cleanups.add(() => heightSpy.mockRestore())
    const renderTabs = () => act(() => {
      root.render(createElement(WorkbenchProvider, {
        workbench: f as unknown as Workbench,
        children: createElement(ResultsTabs, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
      }))
    })
    renderTabs()
    const rtRoot = host.querySelector<HTMLElement>('.rt-root')!
    expect(rtRoot.getAttribute('data-fold')).toBe('none')

    // Open ResultsPicker and pick Summary while data-fold="none".
    act(() => { pickerRequests.request(doc.id) })
    const summaryOption = [...document.querySelectorAll<HTMLElement>('[data-results-picker] [role="option"]')].find(el => el.textContent?.includes('Summary'))!
    expect(summaryOption).toBeDefined()
    act(() => { summaryOption.click() })
    renderTabs()

    expect(rtRoot.getAttribute('data-fold')).toBeNull()
    const summaryTab = host.querySelector<HTMLButtonElement>(`[data-tab-row="result"] [data-tab-entry="${summaryEntryKey}"] [role="tab"]`)!
    expect(document.activeElement).toBe(summaryTab)
  })

  it('R3-8: StackSizing.keepFloor prevents single-set multi-server stack starvation in short panes', () => {
    const minHeight = minGridHeight(scrollbarSize())
    // Without keepFloor (single-server), a 1-set stack fills pane height directly.
    expect(stackLayout(60, 1, undefined, minHeight).heights).toEqual([60])
    // With keepFloor (multi-server stack sharing space with Summary band), 1-set stack enforces its floor.
    const guarded = stackLayout(60, 1, undefined, minHeight, { keepFloor: true })
    expect(guarded.heights[0]).toBe(minHeight)
    expect(guarded.total).toBe(minHeight)

    // Mounted ResultsStack passes keepFloor: multi so a 1-set multi-server stack in a 60px pane keeps minHeight.
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('r3-floor.sql', 'SELECT 1', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, rowsRead: 50, rowsStored: 50, rowsAvailable: 50 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf([multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1])], [s1])
    })
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(60)
    cleanups.add(() => heightSpy.mockRestore())
    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsStack, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
    }))
    const item = host.querySelector<HTMLElement>('.rs-item')!
    expect(parseInt(item.style.height, 10)).toBeGreaterThanOrEqual(minHeight)
  })

  it('R3-9: OutputPane hides PivotPanel when Summary is active in Tabs layout', async () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    await f.settings.choose('queryResults.grid.layout', 'tabs')
    const doc = f.documents.create('r3-pivot-hide.sql', 'SELECT 1', 'SalesDB')
    f.documents.activate(doc.id)
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1], { resultSetIds: [2] })],
        [s1, s2]
      )
    })
    const firstKey = f.results.getSnapshot()[doc.id].sets[0].key
    f.results.focusEntry(doc.id, firstKey)
    f.pivot.open(doc.id, firstKey)

    const emptyRetained = { entries: [] }
    const emptyQueryPlans = {}
    const paneWorkbench = {
      ...f,
      retainedPlans: { subscribe: () => () => {}, getSnapshot: () => emptyRetained },
      queryPlans: { subscribe: () => () => {}, getSnapshot: () => emptyQueryPlans }
    } as unknown as Workbench
    const host = mount(createElement(WorkbenchProvider, {
      workbench: paneWorkbench,
      children: createElement(OutputPane, { pane: 'results', tabId: doc.id, query: true, connected: true })
    }))
    // Grid active in Tabs layout: PivotPanel renders.
    expect(host.querySelector('.pivot-panel')).not.toBeNull()

    // Switch to Summary in Tabs layout: PivotPanel hides.
    act(() => { f.results.focusEntry(doc.id, summaryEntryKey) })
    expect(host.querySelector('.pivot-panel')).toBeNull()

    // Switch to Stacked layout (grids shown): PivotPanel renders again.
    await act(async () => { await f.settings.choose('queryResults.grid.layout', 'stacked') })
    expect(host.querySelector('.pivot-panel')).not.toBeNull()
  })

  it('R3-10: ResultsTabs statementLabel renders BigQuery sample label instead of duplicate Statement 1', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('r3-sample-label.sql', 'SELECT 1', 'sales_dw')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'crossEngineReadOnly', targets: crossTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'sql-1', statementSlot: 0 })
    const bq1 = descriptor(2, { index: 1, targetKey: 'bq-1', statementSlot: 0, residence: 'remote', rowsRead: 50000, rowsStored: 0, rowsAvailable: 50000 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(crossTargets[0], { resultSetIds: [1] }), multiOutcome(crossTargets[1], { resultSetIds: [2] })],
        [s1, bq1],
        { mode: 'crossEngineReadOnly' }
      )
    })
    const baseTab = f.results.getSnapshot()[doc.id]
    const bqGroup = baseTab.groups.find(group => group.table.entry.descriptor.targetKey === 'bq-1')!
    const sampleEntry = {
      ...bqGroup.table.entry,
      key: 'sample-1',
      ordinal: -1,
      number: 3,
      sample: true as const,
      label: 'Sample: 1,000 of 50,000 rows'
    }
    const sampleGroup = { ...bqGroup, ordinal: -1, table: { ...bqGroup.table, key: 'sample-1', group: -1, entry: sampleEntry } }
    const tabWithSample = { ...baseTab, sets: [...baseTab.sets, sampleEntry], groups: [...baseTab.groups, sampleGroup], focused: bqGroup.table.key, activeSummary: undefined }

    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsTabs, { tabId: doc.id, tab: tabWithSample })
    }))
    const stmtLabels = [...host.querySelectorAll<HTMLButtonElement>('[data-tab-row="stmt"] [role="tab"]')].map(btn => btn.textContent)
    expect(stmtLabels).toEqual(['Statement 1', 'Sample: 1,000 of 50,000 rows'])
  })

  it('R3-11: entrySecondary returns Result N for unnamed multi-server target and combined results', () => {
    const { results } = serviceFixture()
    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const e1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const e2 = descriptor(2, { index: 1, targetKey: 'prod-east', statementSlot: 1 })
    const comb = descriptor(10, { index: 2, kind: 'combined', statementSlot: 0 })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1, 2] }), multiOutcome(sqlTargets[1])],
        [e1, e2, comb]
      )
    })
    const tab = results.getSnapshot().t1
    const [entry1, entry2, entryComb] = tab.sets
    expect(entrySecondary(entry1)).toBe('Result 1')
    expect(entrySecondary(entry2)).toBe('Result 2')
    expect(entrySecondary(entryComb)).toBe('Result 3')
    expect(numberedName(entry1)).toBe('prod-sql-east-01 · Result 1')
    expect(numberedName(entry2)).toBe('prod-sql-east-01 · Result 2')
    expect(numberedName(entryComb)).toBe('Combined · Result 3')
    // Single-server unnamed entry stays undefined.
    expect(entrySecondary({ number: 1, descriptor: { name: undefined, kind: 'rows' } })).toBeUndefined()
    // ResultsPicker rows carry distinct Result N secondary tags for unnamed multi-statement target results.
    const rows = pickerRows(tab).filter(row => row.kind === 'table')
    expect(rows.map(row => row.number)).toEqual(['Result 1', 'Result 2', 'Result 3'])
  })

  it('R3-12: .multi-phase-pill declares transparent borders and CanvasText border-color under forced-colors', () => {
    const rules = stylesheetRules()
    const phasePill = rules.find(rule => rule.at.length === 0 && rule.selector === '.multi-phase-pill')
    expect(phasePill?.declarations).toContainEqual({ property: 'border', value: '1px solid transparent' })
    const forcedBorders = rules.filter(rule =>
      rule.at.includes('@media (forced-colors: active)')
      && rule.declarations.some(decl => decl.property === 'border-color' && decl.value === 'CanvasText')
    )
    expect(forcedBorders.some(rule => rule.selector.includes('.multi-phase-pill'))).toBe(true)
  })
})

describe('Round 4 adversarial regression checks (Domain 4: Results & CSS)', () => {
  it('R4-1: markCombinedStaleFor aborts in-flight combine and rebuildCombined discards stale result if currentSources changed', async () => {
    const baseClient = fakeResultClient()
    const combine = vi.fn<(...args: unknown[]) => Promise<ResultsCombineResult>>()
    const client = Object.assign(baseClient, { combine })
    const events = new EventBus()
    const api = {
      copyResults: vi.fn<VariaApi['copyResults']>(),
      saveResults: vi.fn<VariaApi['saveResults']>(),
      cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
      onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}),
      remoteQuery: vi.fn<NonNullable<VariaApi['remoteQuery']>>()
    }
    const rerun = vi.fn(async () => descriptor(77, { index: 2, targetKey: 'dev-01', statementSlot: 0, residence: 'memory', rowsRead: 5, rowsStored: 5, rowsAvailable: 5 }))
    const results = new ResultsService({ client, api, events, remote: { rerun } as unknown as RemoteViews, frame: callback => callback() })
    cleanups.add(() => results.dispose())

    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const s3Remote = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0, residence: 'remote', rowsRead: 5000, rowsStored: 0, rowsAvailable: 5000 })
    const comb = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0, name: 'Orders' })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { resultSetIds: [3] })
        ],
        [s1, s2, s3Remote, comb]
      )
    })
    const combinedKey = results.getSnapshot().t1.sets.find(entry => entry.descriptor.kind === 'combined')!.key
    const s3Key = results.getSnapshot().t1.sets.find(entry => entry.descriptor.targetKey === 'dev-01')!.key

    // Part A: Re-running a previously-remote source into memory while rebuildCombined is in flight aborts the combine
    // via markCombinedStaleFor and keeps staleCombined set when the late combine response arrives.
    let resolveInFlight!: (res: ResultsCombineResult) => void
    let capturedSignal: AbortSignal | undefined
    combine.mockImplementationOnce((_handles, opts) => {
      capturedSignal = (opts as { signal?: AbortSignal } | undefined)?.signal
      return new Promise(resolve => { resolveInFlight = resolve })
    })
    const rebuildPromise = results.rebuildCombined('t1', combinedKey)
    expect(capturedSignal?.aborted).toBe(false)
    expect(results.canRebuildCombined('t1', combinedKey)).toBe(false)

    // Load s3 into memory via rerun -> calls markCombinedStaleFor(run, [entry]).
    await results.rerun('t1', s3Key)
    expect(capturedSignal?.aborted).toBe(true)
    expect(results.getSnapshot().t1.staleCombined?.has(combinedKey)).toBe(true)
    expect(results.canRebuildCombined('t1', combinedKey)).toBe(true)

    resolveInFlight({ descriptor: descriptor(601, { kind: 'combined', index: 3, statementSlot: 0 }) })
    expect(await rebuildPromise).toBeUndefined()
    expect(client.release).toHaveBeenCalledWith([{ generation: 1, resultId: 601 }])
    expect(results.getSnapshot().t1.staleCombined?.has(combinedKey)).toBe(true)
    expect(results.getSnapshot().t1.sets.find(entry => entry.key === combinedKey)?.descriptor.resultId).toBe(10)

    // Part B: Even if a newly-in-memory source appears without aborting the signal, rebuildCombined checks
    // currentSources vs sources after await and discards the incomplete rebuild while keeping staleCombined.
    const s3Handle = baseClient.handle(77)!
    s3Handle.snapshot = { ...s3Handle.snapshot, residence: 'remote' }
    let resolveUnaborted!: (res: ResultsCombineResult) => void
    combine.mockImplementationOnce(() => new Promise(resolve => { resolveUnaborted = resolve }))
    const p2 = results.rebuildCombined('t1', combinedKey)
    // Flip s3 back to memory before the combine resolves (without calling markCombinedStaleFor).
    s3Handle.snapshot = { ...s3Handle.snapshot, residence: 'memory' }
    resolveUnaborted({ descriptor: descriptor(602, { kind: 'combined', index: 3, statementSlot: 0 }) })
    expect(await p2).toBeUndefined()
    expect(client.release).toHaveBeenCalledWith([{ generation: 1, resultId: 602 }])
    expect(results.getSnapshot().t1.staleCombined?.has(combinedKey)).toBe(true)
  })

  it('R4-2: ResultsTabs transfers keyboard focus cleanly between MultiRunSummary and ResultGrid on Next/Previous Result and Go to Result 1', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('r4-focus.sql', 'SELECT 1', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const comb = descriptor(10, { index: 2, kind: 'combined', statementSlot: 0 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1], { resultSetIds: [2] })],
        [s1, s2, comb]
      )
    })

    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.add(() => { act(() => root.unmount()); host.remove() })
    const renderTabs = () => act(() => {
      root.render(createElement(WorkbenchProvider, {
        workbench: f as unknown as Workbench,
        children: createElement(ResultsTabs, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
      }))
    })
    renderTabs()

    // Focus MultiRunSummary (starts active on Summary).
    const summaryEl = host.querySelector<HTMLElement>('[data-multi-summary]')!
    expect(summaryEl).not.toBeNull()
    act(() => { summaryEl.focus() })
    expect(document.activeElement).toBe(summaryEl)

    // Next Result from Summary -> Combined: focus transfers to [data-result-grid].
    const nextFromSummary = stepResult(f.results.getSnapshot()[doc.id], 1)!
    act(() => { f.results.focusEntry(doc.id, nextFromSummary) })
    renderTabs()
    const gridEl = host.querySelector<HTMLElement>('.rt-panel [data-result-grid]')!
    expect(gridEl).not.toBeNull()
    expect(document.activeElement).toBe(gridEl)

    // Previous Result from Combined -> Summary: focus transfers back to [data-multi-summary].
    const prevToSummary = stepResult(f.results.getSnapshot()[doc.id], -1)!
    expect(prevToSummary).toBe(summaryEntryKey)
    act(() => { f.results.focusEntry(doc.id, prevToSummary) })
    renderTabs()
    expect(document.activeElement).toBe(host.querySelector<HTMLElement>('.rt-panel [data-multi-summary]'))

    // Next Result twice -> prod-east grid, then Go to Result 1 -> Summary: focus lands on [data-multi-summary].
    act(() => { f.results.focusEntry(doc.id, stepResult(f.results.getSnapshot()[doc.id], 1)!) })
    renderTabs()
    act(() => { f.results.focusEntry(doc.id, stepResult(f.results.getSnapshot()[doc.id], 1)!) })
    renderTabs()
    expect(document.activeElement).toBe(host.querySelector<HTMLElement>('.rt-panel [data-result-grid]'))
    const firstResult = jumpResult(f.results.getSnapshot()[doc.id], 1)!
    expect(firstResult).toBe(summaryEntryKey)
    act(() => { f.results.focusEntry(doc.id, firstResult) })
    renderTabs()
    expect(document.activeElement).toBe(host.querySelector<HTMLElement>('.rt-panel [data-multi-summary]'))
  })

  it('R4-3: rebuildCombined clears stale pre-rebuild combineWarnings even when results.combine omits the warnings property', async () => {
    const { results, combine } = serviceFixture()
    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const s3 = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0 })
    const comb = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0 })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { resultSetIds: [3] })
        ],
        [s1, s2, s3, comb],
        { combineWarnings: ['Schema drift on dev-sql-01: column LegacyNote widened to nvarchar.'] }
      )
    })
    const combinedKey = results.getSnapshot().t1.sets.find(entry => entry.descriptor.kind === 'combined')!.key
    expect(results.getSnapshot().t1.multi?.combineWarnings).toHaveLength(1)

    results.removeTargetEntries('t1', 'dev-01')
    // Return { descriptor } with NO warnings property at all (warnings === undefined).
    combine.mockResolvedValueOnce({
      descriptor: descriptor(701, { kind: 'combined', index: 3, statementSlot: 0, rowsRead: 4, rowsStored: 4, rowsAvailable: 4 })
    })
    expect(await results.rebuildCombined('t1', combinedKey)).toBe(combinedKey)

    const after = results.getSnapshot().t1
    expect(after.multi?.combineWarnings).toBeUndefined()
    expect(after.combineWarnings?.get(combinedKey)).toEqual([])
    const rebuiltEntry = after.sets.find(entry => entry.key === combinedKey)!
    expect(entryNotices(after, rebuiltEntry).some(n => n.kind === 'combineWarning')).toBe(false)
  })

  it('R4-4: PivotService.resolveRecipe refuses when a rebuilt Combined column widens to text instead of silently downgrading SUM/AVG to COUNT', async () => {
    const { results, client, combine } = serviceFixture()
    const pivot = new PivotService(results)
    cleanups.add(() => pivot.dispose())

    const numericCols: ResultColumn[] = [
      { name: 'Region', dataType: 'nvarchar(20)', wire: 'text', nullable: true },
      { name: 'Amount', dataType: 'decimal(10,2)', wire: 'text', nullable: true },
      { name: 'Score', dataType: 'int', wire: 'text', nullable: true }
    ]
    const widenedCols: ResultColumn[] = [
      { name: 'Region', dataType: 'nvarchar(20)', wire: 'text', nullable: true },
      { name: 'Amount', dataType: 'nvarchar(max)', wire: 'text', nullable: true },
      { name: 'Score', dataType: 'int', wire: 'text', nullable: true }
    ]

    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, columns: numericCols })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0, columns: numericCols })
    const s3 = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0, columns: numericCols })
    const comb = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0, columns: numericCols })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { resultSetIds: [3] })
        ],
        [s1, s2, s3, comb]
      )
    })
    const combinedKey = results.getSnapshot().t1.sets.find(entry => entry.descriptor.kind === 'combined')!.key

    // Build a Pivot with SUM(Amount) and AVG(Score).
    pivot.open('t1', combinedKey)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'sum', column: 1 }, { aggregate: 'avg', column: 2 }] })
    await pivot.run('t1')
    const pivotKeyBefore = results.getSnapshot().t1.groups.find(group => group.table.key === combinedKey)?.pivot?.key
    expect(pivotKeyBefore).toBeDefined()

    // Rebuild Combined with Amount widened to nvarchar(max).
    results.removeTargetEntries('t1', 'dev-01')
    combine.mockResolvedValueOnce({
      descriptor: descriptor(710, { kind: 'combined', index: 3, statementSlot: 0, columns: widenedCols, rowsRead: 4, rowsStored: 4, rowsAvailable: 4 })
    })
    await results.rebuildCombined('t1', combinedKey)
    const rebuiltHandle = client.handle(710) as FakeHandle
    const notifySpy = vi.spyOn(results, 'notify')

    // Update must refuse and name Amount rather than silently downgrading SUM(Amount) to COUNT(Amount).
    await pivot.update('t1', combinedKey)
    expect(rebuiltHandle.pivot).not.toHaveBeenCalled()
    const error = pivot.getSnapshot().tabs.t1.error
    expect(error).toBeDefined()
    expect(error).toContain('Amount')
    expect(notifySpy).toHaveBeenCalledWith('t1', error)
    // Existing Pivot stays intact.
    expect(results.getSnapshot().t1.groups.find(group => group.table.key === combinedKey)?.pivot?.key).toBe(pivotKeyBefore)
  })

  it('R4-5: isCrossEnginePair infers bigquery for entry.sample so BigQuery sample pairs are not misclassified as cross-engine', () => {
    const { results } = serviceFixture()
    const compare = new CompareService(results)
    cleanups.add(() => compare.dispose())

    const cols: ResultColumn[] = [{ name: 'Id', dataType: 'int', wire: 'text', nullable: false }]
    results.begin('cx', 'q-cx', undefined, { multi: { mode: 'crossEngineReadOnly', targets: crossTargets } })
    const sqlSet = descriptor(1, { index: 0, targetKey: 'sql-1', statementSlot: 0, columns: cols })
    const bqSet = descriptor(2, { index: 1, targetKey: 'bq-1', statementSlot: 0, columns: cols })
    void results.finish('cx', 'q-cx', {
      multiSummary: multiSummaryOf(
        [multiOutcome(crossTargets[0], { resultSetIds: [1] }), multiOutcome(crossTargets[1], { resultSetIds: [2] })],
        [sqlSet, bqSet],
        { mode: 'crossEngineReadOnly', status: 'completed' }
      )
    })
    const tab = results.getSnapshot().cx
    const sqlEntry = tab.sets.find(entry => entry.descriptor.targetKey === 'sql-1')!
    const bqEntry = tab.sets.find(entry => entry.descriptor.targetKey === 'bq-1')!
    // BigQuery samples without targetKey on their descriptor.
    const sampleA = { ...bqEntry, key: 'sample-a', sample: true as const, descriptor: { ...bqEntry.descriptor, resultId: 90, targetKey: undefined } }
    const sampleB = { ...bqEntry, key: 'sample-b', sample: true as const, descriptor: { ...bqEntry.descriptor, resultId: 91, targetKey: undefined } }

    expect(isCrossEnginePair(tab, sampleA, sampleB)).toBe(false)
    expect(isCrossEnginePair(tab, bqEntry, sampleA)).toBe(false)
    expect(isCrossEnginePair(tab, sampleA, bqEntry)).toBe(false)
    expect(isCrossEnginePair(tab, sqlEntry, sampleA)).toBe(true)
    expect(isCrossEnginePair(tab, sampleA, sqlEntry)).toBe(true)
  })

  it('R4-6: in-flight manual Pivot build during rebuildCombined aborts cleanly via Build.sourceSet without reporting "These results were closed"', async () => {
    const { results, client, combine } = serviceFixture()
    const pivot = new PivotService(results)
    cleanups.add(() => pivot.dispose())

    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const s3 = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0 })
    const comb = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0 })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { resultSetIds: [3] })
        ],
        [s1, s2, s3, comb]
      )
    })
    const combinedKey = results.getSnapshot().t1.sets.find(entry => entry.descriptor.kind === 'combined')!.key
    const oldCombinedHandle = client.handle(10) as FakeHandle

    // Start a manual Pivot build on Combined, held on a deferred backend response.
    let resolvePivot!: (res: Awaited<ReturnType<FakeHandle['pivot']>>) => void
    let pivotSignal: AbortSignal | undefined
    vi.mocked(oldCombinedHandle.pivot).mockImplementationOnce((_spec, opts) => {
      pivotSignal = opts?.signal
      return new Promise(resolve => { resolvePivot = resolve })
    })
    pivot.open('t1', combinedKey)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    const buildPromise = pivot.run('t1')
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(pivotSignal?.aborted).toBe(false)

    // While the manual Pivot build is in flight, close one server and rebuild Combined in place.
    const notifySpy = vi.spyOn(results, 'notify')
    results.removeTargetEntries('t1', 'dev-01')
    combine.mockResolvedValueOnce({
      descriptor: descriptor(720, { kind: 'combined', index: 3, statementSlot: 0, rowsRead: 4, rowsStored: 4, rowsAvailable: 4 })
    })
    await results.rebuildCombined('t1', combinedKey)

    // Sync immediately aborts the in-flight manual Pivot because sourceSet changed.
    expect(pivotSignal?.aborted).toBe(true)

    // Late resolution of the aborted Pivot build is discarded cleanly with no "These results were closed" error.
    resolvePivot({ descriptor: descriptor(888, { kind: 'pivot', index: 3 }), rows: 6, rowGroups: 2, columnGroups: 0, approximate: false })
    await buildPromise
    expect(client.release).toHaveBeenCalledWith([{ generation: 1, resultId: 888 }])
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
    expect(notifySpy).not.toHaveBeenCalledWith('t1', expect.stringContaining('These results were closed'))
  })
})

describe('Round 5 adversarial regression checks (Domain 4: Results & CSS)', () => {
  it('R5-D4-1: MultiRunSummary renders a calm error notice banner with Messages jump for coordinator/IPC failures without target errorMessage', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('multi.sql', 'SELECT 1', 'master')
    const setViewSpy = vi.spyOn(f.results, 'setView')
    const selectPaneSpy = vi.spyOn(f.panes, 'select')

    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    void f.results.finish(doc.id, 'q1', { error: 'IPC channel closed before targets responded.' })

    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(MultiRunSummary, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id], active: true })
    }))

    const banner = host.querySelector('.multi-summary-banner')!
    const notice = host.querySelector<HTMLElement>('.multi-notice.multi-notice-err[role="status"]')
    expect(notice).not.toBeNull()
    expect(banner.nextElementSibling).toBe(notice)
    expect(notice!.textContent).toContain('IPC channel closed before targets responded.')
    const messagesBtn = notice!.querySelector<HTMLButtonElement>('button')!
    expect(messagesBtn.textContent).toContain('Messages')
    act(() => { messagesBtn.click() })
    expect(setViewSpy).toHaveBeenCalledWith(doc.id, 'messages')
    expect(selectPaneSpy).toHaveBeenCalledWith('messages')

    // When a target already carries an errorMessage, do not duplicate a run-level error banner.
    const withTargetError = {
      ...f.results.getSnapshot()[doc.id],
      multi: {
        ...f.results.getSnapshot()[doc.id].multi!,
        targets: f.results.getSnapshot()[doc.id].multi!.targets.map((target, idx) => idx === 0 ? { ...target, errorMessage: 'Login failed' } : target)
      }
    }
    const host2 = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(MultiRunSummary, { tabId: doc.id, tab: withTargetError, active: true })
    }))
    expect(host2.querySelector('.multi-notice-err')).toBeNull()
  })

  it('R5-D4-2: MultiRunSummary and ResultsStack use EnvironmentTag (normalizing stage -> Staging), never .multi-env-pill', () => {
    expect(normalizeMultiEnvironment('Production')).toBe('Production')
    expect(normalizeMultiEnvironment('prod')).toBe('Production')
    expect(normalizeMultiEnvironment('Staging')).toBe('Staging')
    expect(normalizeMultiEnvironment('stage')).toBe('Staging')
    expect(normalizeMultiEnvironment('Development')).toBe('Development')
    expect(normalizeMultiEnvironment('dev')).toBe('Development')
    expect(normalizeMultiEnvironment('   ')).toBeUndefined()

    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('env.sql', 'SELECT 1', 'master')
    const envTargets: MultiTargetIdentity[] = [
      { targetKey: 't-prod', connectionId: 'c1', provider: 'sqlserver', label: 'srv-prod', environment: 'Production', database: 'DB' },
      { targetKey: 't-dev', connectionId: 'c2', provider: 'sqlserver', label: 'srv-dev', environment: 'Development', database: 'DB' },
      { targetKey: 't-stage', connectionId: 'c3', provider: 'sqlserver', label: 'srv-stage', environment: 'stage', database: 'DB' },
      { targetKey: 't-blank', connectionId: 'c4', provider: 'sqlserver', label: 'srv-blank', environment: '   ', database: 'DB' }
    ]
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: envTargets } })
    const sets = envTargets.map((target, index) => descriptor(index + 1, { index, targetKey: target.targetKey, statementSlot: 0 }))
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(envTargets.map((target, index) => multiOutcome(target, { resultSetIds: [index + 1] })), sets)
    })
    const tab = f.results.getSnapshot()[doc.id]

    const summaryHost = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(MultiRunSummary, { tabId: doc.id, tab, active: true })
    }))
    expect(summaryHost.querySelectorAll('.multi-env-pill')).toHaveLength(0)
    const tags = [...summaryHost.querySelectorAll<HTMLElement>('.environment-tag')]
    expect(tags).toHaveLength(3)
    expect(tags.map(tag => [tag.dataset.place, tag.dataset.tone, tag.textContent, tag.querySelector('.status-pill')?.getAttribute('title')])).toEqual([
      ['list', 'critical', 'PROD', 'srv-prod: Production environment'],
      ['list', 'neutral', 'DEV', 'srv-dev: Development environment'],
      ['list', 'info', 'STAGING', 'srv-stage: Staging environment']
    ])

    // ResultsStack captions also use EnvironmentTag with no .multi-env-pill and no blank tag for whitespace environment.
    const clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('rs-stack') ? 2000 : 0 } })
    try {
      const stackHost = mount(createElement(WorkbenchProvider, {
        workbench: f as unknown as Workbench,
        children: createElement(ResultsStack, { tabId: doc.id, tab })
      }))
      expect(stackHost.querySelectorAll('.multi-env-pill')).toHaveLength(0)
      const captionTags = [...stackHost.querySelectorAll<HTMLElement>('.rs-caption .environment-tag')]
      expect(captionTags).toHaveLength(3)
      expect(captionTags.map(tag => [tag.dataset.tone, tag.textContent])).toEqual([
        ['critical', 'PROD'],
        ['neutral', 'DEV'],
        ['info', 'STAGING']
      ])
    } finally {
      if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightDesc)
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    }

    // Unused .multi-env-pill rules are removed from styles.css.
    const rules = stylesheetRules()
    expect(rules.some(rule => rule.selector.includes('.multi-env-pill'))).toBe(false)
  })

  it('R5-D4-5: ResultsService records built combinedCounts per Combined entry and topItems uses it until rebuildCombined updates it', async () => {
    const baseClient = fakeResultClient()
    const combine = vi.fn<(...args: unknown[]) => Promise<ResultsCombineResult>>()
    const client = Object.assign(baseClient, { combine })
    const events = new EventBus()
    const api = {
      copyResults: vi.fn<VariaApi['copyResults']>(),
      saveResults: vi.fn<VariaApi['saveResults']>(),
      cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
      onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}),
      remoteQuery: vi.fn<NonNullable<VariaApi['remoteQuery']>>()
    }
    const rerun = vi.fn(async () => descriptor(77, { index: 2, targetKey: 'dev-01', statementSlot: 0, residence: 'memory', rowsRead: 5, rowsStored: 5, rowsAvailable: 5 }))
    const results = new ResultsService({ client, api, events, remote: { rerun } as unknown as RemoteViews, frame: callback => callback() })
    cleanups.add(() => results.dispose())

    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const s3 = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0 })
    const comb = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0 })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { resultSetIds: [3] })
        ],
        [s1, s2, s3, comb]
      )
    })

    const initialTab = results.getSnapshot().t1
    const combinedKey = initialTab.sets.find(entry => entry.descriptor.kind === 'combined')!.key
    const s3Key = initialTab.sets.find(entry => entry.descriptor.targetKey === 'dev-01')!.key
    expect(initialTab.combinedCounts?.get(combinedKey)).toBe(3)
    expect(topItems(initialTab).find(item => item.combined)?.name).toBe('Combined (3/3)')

    // Close dev-01 without rebuilding: live combinedTargetCount drops to 2, but stale Combined still reports its built 3/3!
    expect(results.removeEntry('t1', s3Key)).toBe(true)
    const staleTab = results.getSnapshot().t1
    expect(staleTab.staleCombined?.has(combinedKey)).toBe(true)
    expect(combinedTargetCount(staleTab, 0)).toBe(2)
    expect(staleTab.combinedCounts?.get(combinedKey)).toBe(3)
    expect(topItems(staleTab).find(item => item.combined)?.name).toBe('Combined (3/3)')

    // Rebuilding Combined updates its recorded built count to 2/3.
    combine.mockResolvedValueOnce({ descriptor: descriptor(20, { kind: 'combined', index: 3, statementSlot: 0 }) })
    await results.rebuildCombined('t1', combinedKey)
    const rebuiltTab = results.getSnapshot().t1
    expect(rebuiltTab.staleCombined?.has(combinedKey)).toBeFalsy()
    expect(rebuiltTab.combinedCounts?.get(combinedKey)).toBe(2)
    expect(topItems(rebuiltTab).find(item => item.combined)?.name).toBe('Combined (2/3)')

    // Fallback when combinedCounts is absent uses combinedTargetCount(tab, slot).
    const { combinedCounts: _omitted, ...withoutCounts } = staleTab
    expect(topItems(withoutCounts).find(item => item.combined)?.name).toBe('Combined (2/3)')

    // Also verify loading a remote source into memory keeps built count at 2/3 until rebuilt.
    results.begin('t2', 'q2', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const r1 = descriptor(31, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const r2 = descriptor(32, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const r3Remote = descriptor(33, { index: 2, targetKey: 'dev-01', statementSlot: 0, residence: 'remote', rowsRead: 5000, rowsStored: 0, rowsAvailable: 5000 })
    const rComb = descriptor(40, { index: 3, kind: 'combined', statementSlot: 0 })
    void results.finish('t2', 'q2', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [31] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [32] }),
          multiOutcome(sqlTargets[2], { resultSetIds: [33] })
        ],
        [r1, r2, r3Remote, rComb]
      )
    })
    const t2Initial = results.getSnapshot().t2
    const t2CombKey = t2Initial.sets.find(entry => entry.descriptor.kind === 'combined')!.key
    const t2RemoteKey = t2Initial.sets.find(entry => entry.descriptor.targetKey === 'dev-01')!.key
    expect(topItems(t2Initial).find(item => item.combined)?.name).toBe('Combined (2/3)')
    await results.rerun('t2', t2RemoteKey)
    const t2Stale = results.getSnapshot().t2
    expect(combinedTargetCount(t2Stale, 0)).toBe(3)
    expect(topItems(t2Stale).find(item => item.combined)?.name).toBe('Combined (2/3)')
    combine.mockResolvedValueOnce({ descriptor: descriptor(50, { kind: 'combined', index: 3, statementSlot: 0 }) })
    await results.rebuildCombined('t2', t2CombKey)
    expect(topItems(results.getSnapshot().t2).find(item => item.combined)?.name).toBe('Combined (3/3)')
  })

  it('R5-D4-7: discardNotice reads multiSummary.discardedResultSets and MultiRunSummary renders a discarded-results info notice', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('discard.sql', 'SELECT 1', 'master')
    f.results.begin(doc.id, 'q1', undefined, { discard: true, multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0]), multiOutcome(sqlTargets[1])],
        [],
        { discardedResultSets: 3 }
      )
    })
    const tab = f.results.getSnapshot()[doc.id]
    expect(discardNotice(tab, true)).toMatchObject({
      title: 'Results were not kept',
      action: 'turnOff'
    })
    expect(discardNotice(tab, true)?.detail).toContain('3 result sets were read and not kept.')
    expect(discardNotice(tab, false)).toMatchObject({
      title: 'Results were not kept',
      action: 'execute'
    })

    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(MultiRunSummary, { tabId: doc.id, tab, active: true })
    }))
    const notice = host.querySelector<HTMLElement>('.multi-notice.multi-notice-info[role="status"][data-notice-kind="discarded"]')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('3 result sets were read and not kept')

    // Zero discarded sets renders no discarded notice.
    const zeroTab = { ...tab, multiSummary: { ...tab.multiSummary!, discardedResultSets: 0 } }
    expect(discardNotice(zeroTab, true)).toBeUndefined()
    const host2 = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(MultiRunSummary, { tabId: doc.id, tab: zeroTab, active: true })
    }))
    expect(host2.querySelector('[data-notice-kind="discarded"]')).toBeNull()
  })
})

describe('Round 6 adversarial regression checks (Domain 4: Results & CSS)', () => {
  it('R6 #5: TabResults.combining tracks in-flight rebuildCombined across EntryNoticeBars remounts/tab switches and clears on abort/guard paths', async () => {
    const baseClient = fakeResultClient()
    let resolveCombine!: (value: ResultsCombineResult) => void
    const combine = vi.fn(() => new Promise<ResultsCombineResult>(resolve => { resolveCombine = resolve }))
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

    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1Slot0 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2Slot0 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const s3Slot0 = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0 })
    const comb0 = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0 })
    const s1Slot1 = descriptor(4, { index: 4, targetKey: 'prod-east', statementSlot: 1 })
    const s2Slot1 = descriptor(5, { index: 5, targetKey: 'prod-west', statementSlot: 1 })
    const s3Slot1 = descriptor(6, { index: 6, targetKey: 'dev-01', statementSlot: 1 })
    const comb1 = descriptor(11, { index: 7, kind: 'combined', statementSlot: 1 })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1, 4] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [2, 5] }),
          multiOutcome(sqlTargets[2], { resultSetIds: [3, 6] })
        ],
        [s1Slot0, s2Slot0, s3Slot0, comb0, s1Slot1, s2Slot1, s3Slot1, comb1]
      )
    })

    const initial = results.getSnapshot().t1
    const comb0Key = initial.sets.find(entry => entry.descriptor.resultId === 10)!.key
    const comb1Key = initial.sets.find(entry => entry.descriptor.resultId === 11)!.key
    const devSlot0Key = initial.sets.find(entry => entry.descriptor.resultId === 3)!.key
    const devSlot1Key = initial.sets.find(entry => entry.descriptor.resultId === 6)!.key

    // Mark both Combined statement slots stale by closing dev-01's sets.
    expect(results.removeEntry('t1', devSlot0Key)).toBe(true)
    expect(results.removeEntry('t1', devSlot1Key)).toBe(true)

    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const wb = { ...f, results } as unknown as Workbench

    // Start rebuilding comb0 while comb1 stays idle; focus comb0 in ResultsTabs.
    results.focusEntry('t1', comb0Key)
    const pendingRebuild = results.rebuildCombined('t1', comb0Key)
    expect(results.getSnapshot().t1.combining?.has(comb0Key)).toBe(true)
    expect(results.getSnapshot().t1.combining?.has(comb1Key)).toBe(false)

    const host = mount(createElement(WorkbenchProvider, {
      workbench: wb,
      children: createElement(ResultsTabs, { tabId: 't1', tab: results.getSnapshot().t1 })
    }))
    const rebuildBtn = () => host.querySelector<HTMLButtonElement>('.multi-grid-notice-btn')!
    expect(rebuildBtn().textContent).toContain('Rebuilding…')
    expect(rebuildBtn().disabled).toBe(false)
    expect(rebuildBtn().getAttribute('aria-disabled')).toBe('true')

    // Switch to comb1 in ResultsTabs: comb1 must NOT inherit comb0's rebuilding state!
    results.focusEntry('t1', comb1Key)
    const hostComb1 = mount(createElement(WorkbenchProvider, {
      workbench: wb,
      children: createElement(ResultsTabs, { tabId: 't1', tab: results.getSnapshot().t1 })
    }))
    const comb1Btn = hostComb1.querySelector<HTMLButtonElement>('.multi-grid-notice-btn')!
    expect(comb1Btn.textContent).toContain('Rebuild')
    expect(comb1Btn.textContent).not.toContain('Rebuilding…')
    expect(comb1Btn.disabled).toBe(false)

    // Switch back to comb0 (fresh mount): rebuilding state is preserved from TabResults.combining.
    results.focusEntry('t1', comb0Key)
    const hostBack = mount(createElement(WorkbenchProvider, {
      workbench: wb,
      children: createElement(ResultsTabs, { tabId: 't1', tab: results.getSnapshot().t1 })
    }))
    expect(hostBack.querySelector<HTMLButtonElement>('.multi-grid-notice-btn')!.textContent).toContain('Rebuilding…')

    // Hit the generation-mismatch guard path so rebuildCombined discards and exits via finally: combining must clear and publish.
    resolveCombine({ descriptor: descriptor(99, { generation: 999, kind: 'combined', index: 3, statementSlot: 0 }) })
    expect(await pendingRebuild).toBeUndefined()
    expect(results.getSnapshot().t1.combining).toBeUndefined()
  })

  it('R6 #7: ResultsService.steppable is layout-aware so 1-set multi-server Stacked runs are not steppable while Tabs runs are', () => {
    const client = fakeResultClient(), events = new EventBus()
    const api = {
      copyResults: vi.fn<VariaApi['copyResults']>(),
      saveResults: vi.fn<VariaApi['saveResults']>(),
      cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
      onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {})
    }
    let layout: 'stacked' | 'tabs' = 'stacked'
    const listeners = new Set<() => void>()
    const setLayout = (next: 'stacked' | 'tabs') => { layout = next; for (const listener of listeners) listener() }
    const results = new ResultsService({
      client,
      api,
      events,
      frame: callback => callback(),
      layout: () => layout,
      onLayoutChange: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
    })
    cleanups.add(() => results.dispose())

    // Tab 1: 2-server run where only 1 server returned a result set.
    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const onlySet = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1], { resultSetIds: [] })],
        [onlySet]
      )
    })

    // In Stacked layout, only 1 grid exists (Summary is a collapsible band, not a tab) -> steppable is false.
    expect(results.steppable.getSnapshot().t1).toBeUndefined()
    // Switching to Tabs layout makes Summary + prod-east = 2 top tabs -> steppable becomes true.
    setLayout('tabs')
    expect(results.steppable.getSnapshot().t1).toBe(true)
    // Switching back to Stacked layout clears steppable again.
    setLayout('stacked')
    expect(results.steppable.getSnapshot().t1).toBeUndefined()

    // Tab 2: 1 server returning 2 statement sets in Stacked layout -> 2 held grids -> steppable is true!
    results.begin('t2', 'q2', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const st0 = descriptor(2, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const st1 = descriptor(3, { index: 1, targetKey: 'prod-east', statementSlot: 1 })
    void results.finish('t2', 'q2', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [2, 3] }), multiOutcome(sqlTargets[1], { resultSetIds: [] })],
        [st0, st1]
      )
    })
    expect(results.steppable.getSnapshot().t2).toBe(true)
  })

  it('R6 #8: slotNamed returns true for multi-server target and combined table slots so narrow Stacked captions truncate cleanly', () => {
    const plain = { view: 'table' as const, entry: { key: 'e1', number: 1, descriptor: descriptor(1), handle: {} as never }, sources: [] }
    const target = { view: 'table' as const, entry: { key: 'e2', number: 2, descriptor: descriptor(2, { targetKey: 'prod-east' }), handle: {} as never }, sources: [] }
    const combined = { view: 'table' as const, entry: { key: 'e3', number: 3, descriptor: descriptor(3, { kind: 'combined' }), handle: {} as never }, sources: [] }
    expect(slotNamed(plain)).toBe(false)
    expect(slotNamed(target)).toBe(true)
    expect(slotNamed(combined)).toBe(true)
  })

  it('R6 #9: styles.css bounds .rt-stmt-tabs, .rt-stmt-tab and .rt-stmt-select with --varia-resultTab and ellipsis overflow', () => {
    const rules = stylesheetRules()
    const declsOf = (selector: string) => new Map(
      rules.filter(rule => rule.selector === selector).flatMap(rule => rule.declarations.map(d => [d.property, d.value] as const))
    )
    const stmtTabs = declsOf('.rt-stmt-tabs')
    expect(stmtTabs.get('min-width')).toBe('0')
    expect(stmtTabs.get('overflow')).toBe('hidden')

    const stmtTab = declsOf('.rt-stmt-tab')
    expect(stmtTab.get('max-width')).toBe('var(--varia-resultTab)')
    expect(stmtTab.get('overflow')).toBe('hidden')
    expect(stmtTab.get('text-overflow')).toBe('ellipsis')

    const stmtSelect = declsOf('.rt-stmt-select')
    expect(stmtSelect.get('max-width')).toBe('var(--varia-resultTab)')
    expect(stmtSelect.get('min-width')).toBe('0')
  })

  it('R6 #10: MultiRunSummary shows backend-loss tab.error even when a target already streamed an earlier SQL errorMessage', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('lost.sql', 'SELECT 1', 'master')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    void f.results.finish(doc.id, 'q1', { error: 'The SQL backend restarted while executing.' })

    const baseTab = f.results.getSnapshot()[doc.id]
    const lostWithTargetError = {
      ...baseTab,
      status: 'lost' as const,
      error: 'The SQL backend restarted while executing.',
      multi: {
        ...baseTab.multi!,
        targets: baseTab.multi!.targets.map((target, idx) => idx === 0 ? { ...target, errorMessage: 'Login failed' } : target)
      }
    }
    const hostLost = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(MultiRunSummary, { tabId: doc.id, tab: lostWithTargetError, active: true })
    }))
    const notice = hostLost.querySelector<HTMLElement>('.multi-notice.multi-notice-err[role="status"]')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('The SQL backend restarted while executing.')
  })
})

describe('Round 7 adversarial regression checks (Domain 4: Results & CSS)', () => {
  it('R7 #7: EntryNoticeBars keeps focus on Rebuild via aria-disabled, restores focus via onRebuiltFocus when stale clears, and wires Close through ResultsTabs/ResultsStack focus handoff', async () => {
    const baseClient = fakeResultClient()
    let resolveCombine!: (value: ResultsCombineResult) => void
    const combine = vi.fn(() => new Promise<ResultsCombineResult>(resolve => { resolveCombine = resolve }))
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

    let nextBase = 0
    const setupStaleTab = (tabId: string, queryId: string) => {
      const base = nextBase
      nextBase += 20
      results.begin(tabId, queryId, undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
      const s1 = descriptor(base + 1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
      const s2 = descriptor(base + 2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
      const s3 = descriptor(base + 3, { index: 2, targetKey: 'dev-01', statementSlot: 0 })
      const comb = descriptor(base + 10, { index: 3, kind: 'combined', statementSlot: 0 })
      void results.finish(tabId, queryId, {
        multiSummary: multiSummaryOf(
          [
            multiOutcome(sqlTargets[0], { resultSetIds: [base + 1] }),
            multiOutcome(sqlTargets[1], { resultSetIds: [base + 2] }),
            multiOutcome(sqlTargets[2], { resultSetIds: [base + 3] })
          ],
          [s1, s2, s3, comb]
        )
      })
      const tab = results.getSnapshot()[tabId]
      const combKey = tab.sets.find(entry => entry.descriptor.kind === 'combined')!.key
      const devKey = tab.sets.find(entry => entry.descriptor.targetKey === 'dev-01')!.key
      expect(results.removeEntry(tabId, devKey)).toBe(true)
      results.focusEntry(tabId, combKey)
      return combKey
    }

    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const wb = { ...f, results } as unknown as Workbench

    // 1. ResultsTabs: Rebuild keeps focus via aria-disabled, ignores duplicate clicks, and moves focus to grid when stale clears.
    const tabsCombKey = setupStaleTab('t-tabs', 'q-tabs')
    const hostTabs = document.body.appendChild(document.createElement('div'))
    const rootTabs = createRoot(hostTabs)
    cleanups.add(() => { act(() => rootTabs.unmount()); hostTabs.remove() })
    const renderTabs = () => {
      act(() => {
        rootTabs.render(createElement(WorkbenchProvider, {
          workbench: wb,
          children: createElement(ResultsTabs, { tabId: 't-tabs', tab: results.getSnapshot()['t-tabs'] })
        }))
      })
    }
    renderTabs()
    const tabsRebuildBtn = () => hostTabs.querySelector<HTMLButtonElement>('[data-notice-kind="staleCombined"] .multi-grid-notice-btn')!
    tabsRebuildBtn().focus()
    expect(document.activeElement).toBe(tabsRebuildBtn())

    act(() => { tabsRebuildBtn().click() })
    renderTabs()
    expect(combine).toHaveBeenCalledTimes(1)
    expect(tabsRebuildBtn().disabled).toBe(false)
    expect(tabsRebuildBtn().getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(tabsRebuildBtn())

    // Extra click while aria-disabled is ignored.
    act(() => { tabsRebuildBtn().click() })
    expect(combine).toHaveBeenCalledTimes(1)

    // Resolve combine -> stale clears -> focus moves to the active grid (not document.body).
    await act(async () => {
      resolveCombine({ descriptor: descriptor(101, { kind: 'combined', index: 3, statementSlot: 0 }) })
      await Promise.resolve()
    })
    renderTabs()
    expect(hostTabs.querySelector('[data-notice-kind="staleCombined"]')).toBeNull()
    expect(document.activeElement).toBe(hostTabs.querySelector(`[data-result-grid][data-result-entry="${tabsCombKey}"]`))

    // 2. ResultsTabs: Close button in EntryNoticeBars wires ResultsTabs.close so focus moves to the next selected tab.
    const tabsCloseKey = setupStaleTab('t-tabs-close', 'q-tabs-close')
    const hostTabsClose = document.body.appendChild(document.createElement('div'))
    const rootTabsClose = createRoot(hostTabsClose)
    cleanups.add(() => { act(() => rootTabsClose.unmount()); hostTabsClose.remove() })
    const renderTabsClose = () => {
      act(() => {
        rootTabsClose.render(createElement(WorkbenchProvider, {
          workbench: wb,
          children: createElement(ResultsTabs, { tabId: 't-tabs-close', tab: results.getSnapshot()['t-tabs-close'] })
        }))
      })
    }
    renderTabsClose()
    const tabsCloseBtn = [...hostTabsClose.querySelectorAll<HTMLButtonElement>('[data-notice-kind="staleCombined"] .multi-grid-notice-btn')]
      .find(btn => btn.textContent?.includes('Close'))!
    tabsCloseBtn.focus()
    act(() => { tabsCloseBtn.click() })
    renderTabsClose()
    expect(results.getSnapshot()['t-tabs-close'].sets.some(entry => entry.key === tabsCloseKey)).toBe(false)
    expect(document.activeElement).toBe(hostTabsClose.querySelector('[data-tab-row="result"] [role="tab"][aria-selected="true"]'))

    // 3. ResultsStack: Rebuild restores focus to grid/caption when stale clears; does NOT steal focus if user moved focus away; Close moves focus to next caption.
    const stackCombKey = setupStaleTab('t-stack', 'q-stack')
    const hostStack = document.body.appendChild(document.createElement('div'))
    const rootStack = createRoot(hostStack)
    cleanups.add(() => { act(() => rootStack.unmount()); hostStack.remove() })
    const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 500 })
    cleanups.add(() => {
      if (origClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientHeight)
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    })
    const renderStack = () => {
      act(() => {
        rootStack.render(createElement(WorkbenchProvider, {
          workbench: wb,
          children: createElement(ResultsStack, { tabId: 't-stack', tab: results.getSnapshot()['t-stack'] })
        }))
      })
    }
    renderStack()
    const stackRebuildBtn = () => hostStack.querySelector<HTMLButtonElement>('[data-notice-kind="staleCombined"] .multi-grid-notice-btn')!
    stackRebuildBtn().focus()
    act(() => { stackRebuildBtn().click() })
    renderStack()
    expect(document.activeElement).toBe(stackRebuildBtn())
    await act(async () => {
      resolveCombine({ descriptor: descriptor(102, { kind: 'combined', index: 3, statementSlot: 0 }) })
      await Promise.resolve()
    })
    renderStack()
    const stackGridOrCaption = hostStack.querySelector(`[data-result-grid][data-result-entry="${stackCombKey}"]`)
      ?? hostStack.querySelector(`[data-caption-entry="${stackCombKey}"]`)
    expect(document.activeElement).toBe(stackGridOrCaption)

    // External focus during rebuild must not be stolen when rebuild finishes.
    const stackNoStealKey = setupStaleTab('t-stack-nosteal', 'q-stack-nosteal')
    const outsideBtn = document.body.appendChild(document.createElement('button'))
    outsideBtn.textContent = 'Editor'
    const hostNoSteal = document.body.appendChild(document.createElement('div'))
    const rootNoSteal = createRoot(hostNoSteal)
    cleanups.add(() => { act(() => rootNoSteal.unmount()); hostNoSteal.remove(); outsideBtn.remove() })
    const renderNoSteal = () => {
      act(() => {
        rootNoSteal.render(createElement(WorkbenchProvider, {
          workbench: wb,
          children: createElement(ResultsStack, { tabId: 't-stack-nosteal', tab: results.getSnapshot()['t-stack-nosteal'] })
        }))
      })
    }
    renderNoSteal()
    const noStealBtn = hostNoSteal.querySelector<HTMLButtonElement>('[data-notice-kind="staleCombined"] .multi-grid-notice-btn')!
    noStealBtn.focus()
    act(() => { noStealBtn.click() })
    renderNoSteal()
    outsideBtn.focus()
    expect(document.activeElement).toBe(outsideBtn)
    await act(async () => {
      resolveCombine({ descriptor: descriptor(103, { kind: 'combined', index: 3, statementSlot: 0 }) })
      await Promise.resolve()
    })
    renderNoSteal()
    expect(results.getSnapshot()['t-stack-nosteal'].sets.some(entry => entry.key === stackNoStealKey)).toBe(true)
    expect(document.activeElement).toBe(outsideBtn)

    // ResultsStack Close in EntryNoticeBars moves focus to the next item's caption toggle.
    const stackCloseKey = setupStaleTab('t-stack-close', 'q-stack-close')
    const hostStackClose = document.body.appendChild(document.createElement('div'))
    const rootStackClose = createRoot(hostStackClose)
    cleanups.add(() => { act(() => rootStackClose.unmount()); hostStackClose.remove() })
    const renderStackClose = () => {
      act(() => {
        rootStackClose.render(createElement(WorkbenchProvider, {
          workbench: wb,
          children: createElement(ResultsStack, { tabId: 't-stack-close', tab: results.getSnapshot()['t-stack-close'] })
        }))
      })
    }
    renderStackClose()
    const stackCloseBtn = [...hostStackClose.querySelectorAll<HTMLButtonElement>('[data-notice-kind="staleCombined"] .multi-grid-notice-btn')]
      .find(btn => btn.textContent?.includes('Close'))!
    stackCloseBtn.focus()
    act(() => { stackCloseBtn.click() })
    renderStackClose()
    expect(results.getSnapshot()['t-stack-close'].sets.some(entry => entry.key === stackCloseKey)).toBe(false)
    expect(document.activeElement?.matches('[data-caption-entry]')).toBe(true)
  })

  it('R7 #8: useLayoutFocus detects and restores focus on [data-multi-summary] across Tabs <-> Stacked layout switches', () => {
    function LayoutFocusHarness({ tabs }: { tabs: boolean }) {
      const { mainRef } = useLayoutFocus(tabs, () => undefined)
      return createElement('div', { ref: mainRef },
        createElement('div', { key: tabs ? 'tabs-summary' : 'stack-summary', 'data-multi-summary': '', tabIndex: -1 },
          createElement('button', { type: 'button', className: 'summary-btn' }, 'Target')
        )
      )
    }
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.add(() => { act(() => root.unmount()); host.remove() })

    act(() => { root.render(createElement(LayoutFocusHarness, { tabs: true })) })
    const initialBtn = host.querySelector<HTMLButtonElement>('.summary-btn')!
    initialBtn.focus()
    expect(document.activeElement).toBe(initialBtn)

    // Switch Tabs -> Stacked: old [data-multi-summary] unmounts, new [data-multi-summary] receives focus (not document.body).
    act(() => { root.render(createElement(LayoutFocusHarness, { tabs: false })) })
    const stackedSummary = host.querySelector<HTMLElement>('[data-multi-summary]')!
    expect(document.activeElement).toBe(stackedSummary)

    // Switch Stacked -> Tabs: focus stays on the newly mounted [data-multi-summary].
    act(() => { root.render(createElement(LayoutFocusHarness, { tabs: true })) })
    const tabsSummary = host.querySelector<HTMLElement>('[data-multi-summary]')!
    expect(document.activeElement).toBe(tabsSummary)
  })

  it('R7 #9 & #10 & #11: ResultsTabs speaks multi-statement Combined counts, sets named: true on per-server tabs, and styles .rt-stmt-tab:focus-visible with inset outline', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('r7-tabs.sql', 'SELECT 1; SELECT 2;', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const s1a = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2a = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const combA = descriptor(10, { index: 2, kind: 'combined', statementSlot: 0 })
    const s1b = descriptor(3, { index: 3, targetKey: 'prod-east', statementSlot: 1 })
    const s2b = descriptor(4, { index: 4, targetKey: 'prod-west', statementSlot: 1 })
    const combB = descriptor(11, { index: 5, kind: 'combined', statementSlot: 1 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1, 3] }), multiOutcome(sqlTargets[1], { resultSetIds: [2, 4] })],
        [s1a, s2a, combA, s1b, s2b, combB]
      )
    })
    const tab = f.results.getSnapshot()[doc.id]

    // R7 #10: per-server TopItems carry named: true so long labels truncate at --varia-resultTab.
    const items = topItems(tab)
    const serverItems = items.filter(item => item.targetKey)
    expect(serverItems).toHaveLength(2)
    expect(serverItems.every(item => item.named === true)).toBe(true)

    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsTabs, { tabId: doc.id, tab })
    }))

    // R7 #9: Multi-statement Combined tab gets spoken aria-label including result set count.
    const combinedTabBtn = host.querySelector<HTMLButtonElement>('.rt-tab[data-combined] [role="tab"]')!
    expect(combinedTabBtn.getAttribute('aria-label')).toBe('Combined (2/2), 2 result sets')

    // R7 #10: Per-server .rt-tab elements carry data-named="true".
    const serverTabs = [...host.querySelectorAll<HTMLElement>('.rt-tab[data-target-key]')]
    expect(serverTabs).toHaveLength(2)
    expect(serverTabs.every(el => el.getAttribute('data-named') === 'true')).toBe(true)

    // Single-statement Combined tab does not add redundant aria-label.
    const docSingle = f.documents.create('r7-single-comb.sql', 'SELECT 1;', 'SalesDB')
    f.results.begin(docSingle.id, 'q2', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    void f.results.finish(docSingle.id, 'q2', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1], { resultSetIds: [2] })],
        [s1a, s2a, combA]
      )
    })
    const hostSingle = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsTabs, { tabId: docSingle.id, tab: f.results.getSnapshot()[docSingle.id] })
    }))
    const singleCombinedBtn = hostSingle.querySelector<HTMLButtonElement>('.rt-tab[data-combined] [role="tab"]')!
    expect(singleCombinedBtn.getAttribute('aria-label')).toBeNull()

    // R7 #11: styles.css includes .rt-stmt-tab:focus-visible in the inset focus outline rule.
    const rules = stylesheetRules()
    const stmtFocus = rules.find(rule => rule.selector.split(',').map(part => part.trim()).includes('.rt-stmt-tab:focus-visible'))
    expect(stmtFocus?.declarations).toEqual(expect.arrayContaining([
      { property: 'outline', value: '1px solid var(--varia-focusBorder)' },
      { property: 'outline-offset', value: '-1px' }
    ]))
  })

  it('R8 D4 #3: resolves per-entry batch totals so single-batch 3-server runs never print "Batch 1 of 3" while multi-batch targets still show their own batch total', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 })
    cleanups.add(() => {
      if (origClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientHeight)
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    })

    // 3-server single-batch run (sum of batchesTotal = 3 -> tab.totalBatches === 3, each target batchesTotal === 1).
    const doc = f.documents.create('r8-batch.sql', 'SELECT 1;', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, batchNumber: 1, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, batchNumber: 1, targetKey: 'prod-west', statementSlot: 0 })
    const s3 = descriptor(3, { index: 2, batchNumber: 1, targetKey: 'dev-01', statementSlot: 0 })
    const comb = descriptor(10, { index: 3, batchNumber: 1, kind: 'combined', statementSlot: 0 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { batchesCompleted: 1, batchesTotal: 1, resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { batchesCompleted: 1, batchesTotal: 1, resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { batchesCompleted: 1, batchesTotal: 1, resultSetIds: [3] })
        ],
        [s1, s2, s3, comb]
      )
    })
    const tab = f.results.getSnapshot()[doc.id]
    expect(tab.totalBatches).toBe(3)
    const eastEntry = tab.sets.find(entry => entry.descriptor.targetKey === 'prod-east')!
    const combEntry = tab.sets.find(entry => entry.descriptor.kind === 'combined')!
    expect(entryTotalBatches(tab, eastEntry)).toBe(1)
    expect(entryTotalBatches(tab, combEntry)).toBe(0)

    // ResultsTabs (inline ViewFacts without .rt-views): no "Batch 1 of 3".
    f.results.focusEntry(doc.id, eastEntry.key)
    const tabsHost = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsTabs, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
    }))
    expect(tabsHost.querySelector('.rt-facts')?.textContent).not.toContain('Batch')

    // ResultsTabs (expanded .rt-views ViewFacts with a Pivot): still no "Batch 1 of 3".
    f.results.addSet(doc.id, descriptor(801, { index: 0, kind: 'pivot', rowsRead: 1, rowsStored: 1, rowsAvailable: 1 }), 'Pivot of prod-sql-east-01', [`1:1`])
    f.results.focusEntry(doc.id, eastEntry.key)
    const tabsExpandedHost = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsTabs, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
    }))
    expect(tabsExpandedHost.querySelector('.rt-views .rt-facts')?.textContent).not.toContain('Batch')

    // ResultsStack: no .rs-caption-batch on any single-batch server or Combined.
    const stackHost = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsStack, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
    }))
    expect(stackHost.querySelectorAll('.rs-caption-batch')).toHaveLength(0)

    // Multi-batch per-server target (batchesTotal: 2, batchNumber: 2) DOES display "Batch 2 of 2" in both Tabs and Stacked.
    const docMulti = f.documents.create('r8-multibatch.sql', 'SELECT 1;\nGO\nSELECT 2;', 'SalesDB')
    f.results.begin(docMulti.id, 'q2', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const b1 = descriptor(21, { index: 0, batchNumber: 2, targetKey: 'prod-east', statementSlot: 0 })
    const b2 = descriptor(22, { index: 1, batchNumber: 1, targetKey: 'prod-west', statementSlot: 0 })
    void f.results.finish(docMulti.id, 'q2', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { batchesCompleted: 2, batchesTotal: 2, resultSetIds: [21] }),
          multiOutcome(sqlTargets[1], { batchesCompleted: 1, batchesTotal: 1, resultSetIds: [22] })
        ],
        [b1, b2]
      )
    })
    const multiTab = f.results.getSnapshot()[docMulti.id]
    const b1Key = multiTab.sets.find(entry => entry.descriptor.targetKey === 'prod-east')!.key
    f.results.focusEntry(docMulti.id, b1Key)
    const tabsMultiBatch = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsTabs, { tabId: docMulti.id, tab: f.results.getSnapshot()[docMulti.id] })
    }))
    expect(tabsMultiBatch.querySelector('.rt-facts')?.textContent).toContain('Batch 2 of 2')

    const stackMultiBatch = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsStack, { tabId: docMulti.id, tab: f.results.getSnapshot()[docMulti.id] })
    }))
    const batchLabels = [...stackMultiBatch.querySelectorAll('.rs-caption-batch')].map(el => el.textContent)
    expect(batchLabels).toEqual(['Batch 2 of 2'])
  })

  it('R8 D4 #4: windowed multi-server BigQuery results show "cached result: may expire early" from target.job.cacheHit in both Stacked and Tabs layouts', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 })
    cleanups.add(() => {
      if (origClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientHeight)
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    })

    const bqTargets: MultiTargetIdentity[] = [
      { targetKey: 'bq-cached', connectionId: 'c-bq-1', provider: 'bigquery', label: 'analytics-cached' },
      { targetKey: 'bq-fresh', connectionId: 'c-bq-2', provider: 'bigquery', label: 'analytics-fresh' }
    ]
    const cachedJob: BigQueryJobSummary = { jobId: 'job-cached', location: 'US', project: 'proj-1', bytesProcessed: 0, cacheHit: true }
    const freshJob: BigQueryJobSummary = { jobId: 'job-fresh', location: 'US', project: 'proj-2', bytesProcessed: 1024, cacheHit: false }
    const doc = f.documents.create('r8-bq-cache.sql', 'SELECT * FROM big.table;', 'core')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: bqTargets } })
    const rCached = descriptor(31, { index: 0, targetKey: 'bq-cached', statementSlot: 0, residence: 'remote', rowsRead: 50_000, rowsStored: 0, rowsAvailable: 50_000 })
    const rFresh = descriptor(32, { index: 1, targetKey: 'bq-fresh', statementSlot: 0, residence: 'remote', rowsRead: 50_000, rowsStored: 0, rowsAvailable: 50_000 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(bqTargets[0], { resultSetIds: [31], job: cachedJob }),
          multiOutcome(bqTargets[1], { resultSetIds: [32], job: freshJob })
        ],
        [rCached, rFresh]
      )
    })
    const tab = f.results.getSnapshot()[doc.id]
    expect(tab.summary).toBeUndefined()
    const cachedEntry = tab.sets.find(entry => entry.descriptor.targetKey === 'bq-cached')!
    const freshEntry = tab.sets.find(entry => entry.descriptor.targetKey === 'bq-fresh')!

    // Stacked layout: cached target shows the expiry notice, uncached target does not.
    const stackHost = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsStack, { tabId: doc.id, tab })
    }))
    const captionFacts = [...stackHost.querySelectorAll('.rs-caption-facts')].map(el => el.textContent ?? '')
    expect(captionFacts[0]).toContain('windowed in BigQuery · cached result: may expire early')
    expect(captionFacts[1]).toContain('windowed in BigQuery')
    expect(captionFacts[1]).not.toContain('cached result: may expire early')

    // Tabs layout: selecting cached target shows expiry notice; selecting fresh target omits it.
    f.results.focusEntry(doc.id, cachedEntry.key)
    const tabsHost = document.body.appendChild(document.createElement('div'))
    const tabsRoot = createRoot(tabsHost)
    cleanups.add(() => { act(() => tabsRoot.unmount()); tabsHost.remove() })
    const renderTabs = () => act(() => {
      tabsRoot.render(createElement(WorkbenchProvider, {
        workbench: f as unknown as Workbench,
        children: createElement(ResultsTabs, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
      }))
    })
    renderTabs()
    expect(tabsHost.querySelector('.rt-facts')?.textContent).toContain('windowed in BigQuery · cached result: may expire early')

    f.results.focusEntry(doc.id, freshEntry.key)
    renderTabs()
    expect(tabsHost.querySelector('.rt-facts')?.textContent).toContain('windowed in BigQuery')
    expect(tabsHost.querySelector('.rt-facts')?.textContent).not.toContain('cached result: may expire early')
  })

  it('R8 D4 #5: closing stale Combined from EntryNoticeBars in a short folded Tabs pane (data-fold="none") restores focus to the visible panel grid instead of a hidden tab', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    // 80px forces tabsFold(...) === 'none' even without notice strips.
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 80 })
    cleanups.add(() => {
      if (origClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientHeight)
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    })

    const doc = f.documents.create('r8-fold-close.sql', 'SELECT 1;', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const s3 = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0 })
    const comb = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { resultSetIds: [3] })
        ],
        [s1, s2, s3, comb]
      )
    })
    const initialTab = f.results.getSnapshot()[doc.id]
    const combKey = initialTab.sets.find(entry => entry.descriptor.kind === 'combined')!.key
    const devKey = initialTab.sets.find(entry => entry.descriptor.targetKey === 'dev-01')!.key
    expect(f.results.removeEntry(doc.id, devKey)).toBe(true)
    f.results.focusEntry(doc.id, combKey)

    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.add(() => { act(() => root.unmount()); host.remove() })
    const render = () => act(() => {
      root.render(createElement(WorkbenchProvider, {
        workbench: f as unknown as Workbench,
        children: createElement(ResultsTabs, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
      }))
    })
    render()

    expect(host.querySelector('.rt-root')?.getAttribute('data-fold')).toBe('none')
    const closeBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-notice-kind="staleCombined"] .multi-grid-notice-btn')]
      .find(btn => btn.textContent?.includes('Close'))!
    closeBtn.focus()
    act(() => { closeBtn.click() })
    render()

    expect(f.results.getSnapshot()[doc.id].sets.some(entry => entry.key === combKey)).toBe(false)
    expect(host.querySelector('.rt-root')?.getAttribute('data-fold')).toBe('none')
    expect(document.activeElement).toBe(host.querySelector('.rt-panel [data-result-grid]'))
  })

  it('R8 D4 #6 & #8: styles.css sets GrayText on aria-disabled notice buttons in forced-colors mode, and tabsNeed accepts partial combinedCounts', () => {
    const rules = stylesheetRules()
    const disabledNoticeBtn = rules.find(rule =>
      rule.at.includes('@media (forced-colors: active)') && rule.selector.includes('.multi-grid-notice-btn[aria-disabled="true"]')
    )
    expect(disabledNoticeBtn?.declarations).toEqual(expect.arrayContaining([
      { property: 'color', value: 'GrayText' },
      { property: 'opacity', value: '1' }
    ]))

    // R8 D4 #8: partial TabResults with combinedCounts compiles and accounts for partialCombine notice height.
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('r8-tabsneed.sql', 'SELECT 1;', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const s3 = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0 })
    const comb = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { resultSetIds: [3] })
        ],
        [s1, s2, s3, comb]
      )
    })
    const tab = f.results.getSnapshot()[doc.id]
    const combKey = tab.sets.find(entry => entry.descriptor.kind === 'combined')!.key
    const base = tabsNeed({
      sets: tab.sets,
      settled: tab.settled,
      focused: combKey,
      groups: tab.groups,
      comparisons: tab.comparisons,
      multi: tab.multi,
      combinedCounts: new Map([[combKey, 3]])
    })
    const partial = tabsNeed({
      sets: tab.sets,
      settled: tab.settled,
      focused: combKey,
      groups: tab.groups,
      comparisons: tab.comparisons,
      multi: tab.multi,
      combinedCounts: new Map([[combKey, 2]])
    })
    expect(partial - base).toBe(multiNoticeHeight)
  })

  it('R9 D4 #1: MultiRunSummary rollback banner distinguishes mixed committed/commitInDoubt runs from full rollback', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('r9-mixed-commit.sql', 'UPDATE t SET a = 1; SELECT 1;', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'transaction', targets: sqlTargets.slice(0, 2) } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0, rolledBackPreview: true })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { status: 'committed', resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { status: 'rolledBack', resultSetIds: [2] })
        ],
        [s1, s2],
        { mode: 'transaction', status: 'commitInDoubt' }
      )
    })

    const mixedHost = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(MultiRunSummary, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id], active: true })
    }))
    const mixedBanner = mixedHost.querySelector('.multi-notice-warn')?.textContent ?? ''
    expect(mixedBanner).toContain('Rolled back — preview only (not committed).')
    expect(mixedBanner).not.toContain('every server transaction was rolled back')
    expect(mixedBanner).toContain('one or more server transactions were committed or are in doubt')

    // Contrast with an all-rolled-back transaction run: keeps the full rollback reassurance.
    f.results.begin(doc.id, 'q2', undefined, { multi: { mode: 'transaction', targets: sqlTargets.slice(0, 2) } })
    const r1 = descriptor(3, { index: 0, targetKey: 'prod-east', statementSlot: 0, rolledBackPreview: true })
    void f.results.finish(doc.id, 'q2', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { status: 'rolledBack', resultSetIds: [3] }),
          multiOutcome(sqlTargets[1], { status: 'failed' })
        ],
        [r1],
        { mode: 'transaction', status: 'rolledBack' }
      )
    })
    const allHost = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(MultiRunSummary, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id], active: true })
    }))
    expect(allHost.querySelector('.multi-notice-warn')?.textContent).toContain('every server transaction was rolled back')
  })

  it('R9 D4 #2 & #6: entryNotices shows partialCombine alongside schema-drift warnings and gives disabled Rebuild a tooltip', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('r9-notices.sql', 'SELECT 1;', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const comb = descriptor(10, { index: 2, kind: 'combined', statementSlot: 0 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { status: 'failed' })
        ],
        [s1, s2, comb],
        { combineWarnings: ['Column Amount widened from int to decimal.'] }
      )
    })

    const tab = f.results.getSnapshot()[doc.id]
    const combEntry = tab.sets.find(entry => entry.descriptor.kind === 'combined')!
    const notices = entryNotices(tab, combEntry)
    expect(notices.map(n => n.kind)).toEqual(['combineWarning', 'partialCombine'])
    expect(entryNoticesHeight(tab, combEntry)).toBe(2 * multiNoticeHeight)

    // When a warning already starts with "Skipped ", partialCombine is not duplicated.
    const skippedTab: TabResults = { ...tab, combineWarnings: new Map([[combEntry.key, ['Skipped dev-01: incompatible schema.']]]) }
    expect(entryNotices(skippedTab, combEntry).map(n => n.kind)).toEqual(['combineWarning'])

    // Removing one of the two remaining servers makes Rebuild disabled with an explanatory title.
    const s2Key = tab.sets.find(entry => entry.descriptor.targetKey === 'prod-west')!.key
    expect(f.results.removeEntry(doc.id, s2Key)).toBe(true)
    const staleTab = f.results.getSnapshot()[doc.id]
    const staleComb = staleTab.sets.find(entry => entry.descriptor.kind === 'combined')!
    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(EntryNoticeBars, { tabId: doc.id, tab: staleTab, entry: staleComb, running: false })
    }))
    const rebuildBtn = [...host.querySelectorAll<HTMLButtonElement>('.multi-grid-notice-btn')]
      .find(btn => btn.textContent?.includes('Rebuild'))!
    expect(rebuildBtn.disabled).toBe(true)
    expect(rebuildBtn.title).toContain('At least two complete in-memory server result sets')
  })

  it('R9 D4 #3 & #4: ResultsTabs preserves stable tab DOM element across statement-0 removal and notes Pivots on any statement', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('r9-tabs-stable.sql', 'SELECT 1; SELECT 2;', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const e0 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, name: 'First' })
    const e1 = descriptor(2, { index: 1, targetKey: 'prod-east', statementSlot: 1, name: 'Second' })
    const w0 = descriptor(4, { index: 3, targetKey: 'prod-west', statementSlot: 0, name: 'First' })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1, 2] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [4] })
        ],
        [e0, e1, w0]
      )
    })
    f.results.addSet(doc.id, descriptor(3, { index: 2, kind: 'pivot', targetKey: 'prod-east', statementSlot: 1, name: 'Second Pivot' }), 'Second Pivot', ['1:2'])

    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.add(() => { act(() => root.unmount()); host.remove() })
    const render = () => act(() => {
      root.render(createElement(WorkbenchProvider, {
        workbench: f as unknown as Workbench,
        children: createElement(ResultsTabs, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
      }))
    })
    render()

    const eastTabBefore = host.querySelector<HTMLElement>('.rt-tab[data-target-key="prod-east"]')!
    expect(eastTabBefore).not.toBeNull()
    // R9 D4 #4: Close tooltip mentions Pivot even though the Pivot lives on statement 1, not statement 0.
    const closeBtn = eastTabBefore.querySelector<HTMLButtonElement>('.rt-close')!
    expect(closeBtn.title).toContain('and its Pivot')

    // R9 D4 #3: Removing statement 0 updates data-tab-entry to statement 1 without unmounting the .rt-tab node.
    const e0Key = f.results.getSnapshot()[doc.id].sets.find(entry => entry.descriptor.resultId === 1)!.key
    expect(f.results.removeEntry(doc.id, e0Key)).toBe(true)
    render()
    const eastTabAfter = host.querySelector<HTMLElement>('.rt-tab[data-target-key="prod-east"]')!
    expect(eastTabAfter).toBe(eastTabBefore)
  })

  it('R10 D4 #1: Pivots and Comparisons derived from rolledBackPreview results inherit rolledBackPreview', () => {
    const { results } = serviceFixture()
    results.begin('t1', 'q1', undefined, { multi: { mode: 'transaction', targets: sqlTargets.slice(0, 2) } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, rolledBackPreview: true })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0, rolledBackPreview: true })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { status: 'rolledBack', resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { status: 'rolledBack', resultSetIds: [2] })
        ],
        [s1, s2],
        { mode: 'transaction', status: 'rolledBack' }
      )
    })

    // Pivot derived from a rolled-back server table inherits rolledBackPreview even when backend descriptor omits it.
    const pivotKey = results.addSet('t1', descriptor(100, { kind: 'pivot', index: 2 }), 'Pivot of East', ['1:1'])!
    const pivotEntry = results.getSnapshot().t1.sets.find(entry => entry.key === pivotKey)!
    expect(pivotEntry.descriptor.rolledBackPreview).toBe(true)
    expect(entryNotices(results.getSnapshot().t1, pivotEntry).some(n => n.kind === 'rolledBack')).toBe(true)

    // Comparison derived from rolled-back server tables inherits rolledBackPreview on both addSet and replaceComparison.
    const diffKey = results.addSet('t1', descriptor(101, { kind: 'diff', index: 3 }), 'East vs West', ['1:1', '1:2'])!
    expect(results.getSnapshot().t1.sets.find(entry => entry.key === diffKey)!.descriptor.rolledBackPreview).toBe(true)
    expect(results.replaceComparison('t1', diffKey, descriptor(102, { kind: 'diff', index: 3 }), 'West vs East', ['1:2', '1:1'], { moved: new Map() })).toBe(diffKey)
    expect(results.getSnapshot().t1.sets.find(entry => entry.key === diffKey)!.descriptor.rolledBackPreview).toBe(true)
  })

  it('R10 D4 #2 & #4: ResultsTabs sets aria-controls/aria-labelledby on statement sub-tabs and rescues focus from stmt select on one -> none fold', () => {
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    let mockHeight = 320
    const resizeCallbacks = new Set<() => void>()
    const origResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      private readonly cb: () => void
      constructor(cb: ResizeObserverCallback) { this.cb = () => cb([], this as unknown as ResizeObserver) }
      observe() { resizeCallbacks.add(this.cb) }
      unobserve() { resizeCallbacks.delete(this.cb) }
      disconnect() { resizeCallbacks.delete(this.cb) }
    } as unknown as typeof ResizeObserver
    const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => mockHeight })
    cleanups.add(() => {
      globalThis.ResizeObserver = origResizeObserver
      if (origClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientHeight)
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    })

    const doc = f.documents.create('r10-stmt-a11y.sql', 'SELECT 1; SELECT 2;', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const e0 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, name: 'First' })
    const e1 = descriptor(2, { index: 1, targetKey: 'prod-east', statementSlot: 1, name: 'Second' })
    const w0 = descriptor(3, { index: 2, targetKey: 'prod-west', statementSlot: 0, name: 'First' })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1, 2] }), multiOutcome(sqlTargets[1], { resultSetIds: [3] })],
        [e0, e1, w0]
      )
    })
    const e1Key = f.results.getSnapshot()[doc.id].sets.find(entry => entry.descriptor.resultId === 2)!.key
    f.results.focusEntry(doc.id, e1Key)

    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.add(() => { act(() => root.unmount()); host.remove() })
    const render = () => act(() => {
      root.render(createElement(WorkbenchProvider, {
        workbench: f as unknown as Workbench,
        children: createElement(ResultsTabs, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
      }))
    })
    render()

    // R10 D4 #4: Active statement tab controls the panel and panel aria-labelledby includes the active statement tab id.
    const activeStmtTab = host.querySelector<HTMLButtonElement>('.rt-stmt-tab[aria-selected="true"]')!
    const panel = host.querySelector<HTMLElement>('.rt-panel')!
    expect(activeStmtTab.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.getAttribute('aria-labelledby')).toContain(activeStmtTab.id)

    // R10 D4 #2: Shrink to fold='one' (renders <select class="rt-stmt-select">), focus it, then shrink to fold='none':
    // focus must move into the visible grid, never drop to document.body.
    mockHeight = g.headerHeight + 2 * g.rowHeight + scrollbarSize() + g.stackBorder + g.resultTabsHeight + 2
    act(() => { for (const cb of resizeCallbacks) cb() })
    const selectEl = host.querySelector<HTMLSelectElement>('select.rt-stmt-select')!
    expect(selectEl).not.toBeNull()
    act(() => { selectEl.focus() })
    expect(document.activeElement).toBe(selectEl)

    mockHeight = 90
    act(() => { for (const cb of resizeCallbacks) cb() })
    expect(host.querySelector('.rt-root')?.getAttribute('data-fold')).toBe('none')
    expect(document.activeElement).toBe(host.querySelector('.rt-panel [data-result-grid]'))
  })

  it('R10 D4 #3: run-level skipped-statement combineWarnings survive closing or rebuilding another statement Combined view', async () => {
    const { results, combine } = serviceFixture()
    results.begin('t1', 'q1', undefined, { multi: { mode: 'transaction', targets: sqlTargets.slice(0, 2) } })
    const s2a = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 1 })
    const s2b = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 1 })
    const c2 = descriptor(10, { index: 2, kind: 'combined', statementSlot: 1 })
    const skipWarning = 'Combined view for statement 1 was skipped because targets had mixed transaction outcomes.'
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1], { resultSetIds: [2] })],
        [s2a, s2b, c2],
        { combineWarnings: [skipWarning, 'Column Amount widened.'] }
      )
    })
    const c2Key = results.getSnapshot().t1.sets.find(entry => entry.descriptor.kind === 'combined')!.key
    // Run-level skip warning is shown in Summary, while per-entry notice on c2 gets the per-entry warning.
    expect(results.getSnapshot().t1.multi?.combineWarnings).toEqual([skipWarning, 'Column Amount widened.'])
    expect(results.getSnapshot().t1.combineWarnings?.get(c2Key)).toEqual(['Column Amount widened.'])

    // Rebuilding c2 with a new schema-drift warning keeps the run-level skipWarning in Summary!
    combine.mockResolvedValueOnce({
      descriptor: descriptor(510, { kind: 'combined', index: 2, statementSlot: 1 }),
      warnings: ['Column Total widened.']
    })
    expect(await results.rebuildCombined('t1', c2Key)).toBe(c2Key)
    expect(results.getSnapshot().t1.multi?.combineWarnings).toEqual([skipWarning, 'Column Total widened.'])

    // Closing c2 completely still keeps the run-level skipWarning in Summary!
    expect(results.removeEntry('t1', c2Key)).toBe(true)
    expect(results.getSnapshot().t1.multi?.combineWarnings).toEqual([skipWarning])
  })

  it('R10 D4 #5, #6, #7, #8: PivotService catches duplicate-name row collapse, Close notice button has tooltip, and CSS overflow/forced-colors rules hold', async () => {
    // R10 D4 #5: duplicate-name row column collapsing to a single column reports missing column error.
    const { results, client, combine } = serviceFixture()
    const pivot = new PivotService(results)
    cleanups.add(() => pivot.dispose())
    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const origCols: ResultColumn[] = [
      { name: '_server', dataType: 'nvarchar', wire: 'text', nullable: false },
      { name: 'id', dataType: 'int', wire: 'text', nullable: false },
      { name: 'y', dataType: 'int', wire: 'text', nullable: false },
      { name: 'id', dataType: 'int', wire: 'text', nullable: false }
    ]
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, columns: origCols })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0, columns: origCols })
    const comb = descriptor(10, { index: 2, kind: 'combined', statementSlot: 0, columns: origCols })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1], { resultSetIds: [2] })],
        [s1, s2, comb]
      )
    })
    const combKey = results.getSnapshot().t1.sets.find(entry => entry.descriptor.kind === 'combined')!.key
    pivot.open('t1', combKey)
    pivot.setDraft('t1', { rows: [1, 3], values: [{ aggregate: 'count' }] })
    await pivot.run('t1')
    const shrunkCols: ResultColumn[] = [
      { name: '_server', dataType: 'nvarchar', wire: 'text', nullable: false },
      { name: 'z', dataType: 'int', wire: 'text', nullable: false },
      { name: 'a', dataType: 'int', wire: 'text', nullable: false },
      { name: 'id', dataType: 'int', wire: 'text', nullable: false }
    ]
    combine.mockResolvedValueOnce({ descriptor: descriptor(20, { kind: 'combined', index: 2, statementSlot: 0, columns: shrunkCols }) })
    expect(await results.rebuildCombined('t1', combKey)).toBe(combKey)
    await pivot.update('t1', combKey)
    expect((client.handle(20) as FakeHandle).pivot).not.toHaveBeenCalled()
    expect(pivot.getSnapshot().tabs.t1.error).toContain('id')

    // R10 D4 #6: EntryNoticeBars Close button carries descriptive tooltip in normal & disabled states.
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('r10-close-tip.sql', 'SELECT 1;', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const a1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const a2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const ac = descriptor(10, { index: 2, kind: 'combined', statementSlot: 0 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf([multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1], { resultSetIds: [2] })], [a1, a2, ac])
    })
    const wKey = f.results.getSnapshot()[doc.id].sets.find(entry => entry.descriptor.targetKey === 'prod-west')!.key
    f.results.removeEntry(doc.id, wKey)
    const staleTab = f.results.getSnapshot()[doc.id]
    const staleComb = staleTab.sets.find(entry => entry.descriptor.kind === 'combined')!
    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(EntryNoticeBars, { tabId: doc.id, tab: staleTab, entry: staleComb, running: true })
    }))
    const closeBtn = [...host.querySelectorAll<HTMLButtonElement>('.multi-grid-notice-btn')].find(btn => btn.textContent?.includes('Close'))!
    expect(closeBtn.disabled).toBe(true)
    expect(closeBtn.title).toBe('Unavailable while the query runs.')

    // R10 D4 #7 & #8: CSS overflow bounds & forced-colors Highlight/HighlightText for pressed controls.
    const rules = stylesheetRules()
    expect(rules.find(r => r.selector === '.rs-stmt-btn')?.declarations).toEqual(expect.arrayContaining([
      { property: 'max-width', value: 'var(--varia-resultTab)' },
      { property: 'text-overflow', value: 'ellipsis' }
    ]))
    expect(rules.find(r => r.selector === '.messages-filter-pill > span:first-child')?.declarations).toEqual(expect.arrayContaining([
      { property: 'overflow', value: 'hidden' },
      { property: 'text-overflow', value: 'ellipsis' }
    ]))
    const forcedPressed = rules.find(r => r.at.includes('@media (forced-colors: active)') && r.selector.includes('.cross-engine-stack-btn[aria-pressed="true"]'))
    expect(forcedPressed?.declarations).toEqual(expect.arrayContaining([
      { property: 'forced-color-adjust', value: 'none' },
      { property: 'background', value: 'Highlight' },
      { property: 'color', value: 'HighlightText' }
    ]))
  })

  it('R11 D4 #1–#5: budget-skip warnings stay run-level, BigQuery sample drop does not abort rebuildCombined, and CSS select/db/forced-colors rules hold', async () => {
    // #1: "Skipped Combined view: ..." stays in run-level baseCombineWarnings (survives close/rebuild) and never suppresses partialCombine.
    const { results, combine } = serviceFixture()
    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const c1 = descriptor(10, { index: 2, kind: 'combined', statementSlot: 0 })
    const budgetWarning = 'Skipped Combined view: not enough result memory remained for the combined rows. Individual server results were kept intact.'
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { status: 'failed' })
        ],
        [s1, s2, c1],
        { combineWarnings: [budgetWarning] }
      )
    })
    const tab1 = results.getSnapshot().t1
    const c1Entry = tab1.sets.find(entry => entry.descriptor.kind === 'combined')!
    expect(tab1.multi?.combineWarnings).toEqual([budgetWarning])
    expect(tab1.combineWarnings?.get(c1Entry.key)).toEqual([])
    expect(entryNotices(tab1, c1Entry).map(n => n.kind)).toEqual(['partialCombine'])
    // Even if a budgetWarning were ever passed directly, it does NOT suppress partialCombine.
    expect(entryNotices({ ...tab1, combineWarnings: new Map([[c1Entry.key, [budgetWarning]]]) }, c1Entry).map(n => n.kind)).toEqual(['combineWarning', 'partialCombine'])

    // #4: Closing a BigQuery sample while rebuildCombined is in flight for the same slot does NOT abort the rebuild.
    let resolveRebuild!: (res: ResultsCombineResult) => void
    let rebuildSignal: AbortSignal | undefined
    combine.mockImplementationOnce((_handles, opts) => {
      rebuildSignal = (opts as { signal?: AbortSignal } | undefined)?.signal
      return new Promise(resolve => { resolveRebuild = resolve })
    })
    const sampleDesc = descriptor(88, { index: 3, kind: 'rows', targetKey: 'dev-01', statementSlot: 0 })
    results.addSet('t1', sampleDesc, 'Sample', ['1:1'])
    const sampleEntry = results.getSnapshot().t1.sets.find(entry => entry.descriptor.resultId === 88)!
    ;(sampleEntry as { sample?: boolean }).sample = true
    const rebuilding = results.rebuildCombined('t1', c1Entry.key)
    expect(rebuildSignal?.aborted).toBe(false)
    results.removeEntry('t1', sampleEntry.key)
    expect(rebuildSignal?.aborted).toBe(false)
    resolveRebuild({ descriptor: descriptor(590, { kind: 'combined', index: 2, statementSlot: 0 }) })
    expect(await rebuilding).toBe(c1Entry.key)
    // Budget warning still survives rebuild & closing c1!
    expect(results.getSnapshot().t1.multi?.combineWarnings).toEqual([budgetWarning])
    expect(results.removeEntry('t1', c1Entry.key)).toBe(true)
    expect(results.getSnapshot().t1.multi?.combineWarnings).toEqual([budgetWarning])

    // #2, #3, #5: CSS compact select padding, .compare-search focus/padding, scoped .multi-target-db, and forced-colors fixes.
    const rules = stylesheetRules()
    for (const sel of ['.rs-stmt-select', '.rt-stmt-select', '.messages-filter-select']) {
      expect(rules.find(r => r.selector === sel)?.declarations).toEqual(expect.arrayContaining([
        { property: 'padding', value: '0 var(--varia-space-2)' },
        { property: 'line-height', value: '20px' }
      ]))
    }
    expect(rules.find(r => r.selector === '.compare-search')?.declarations).toEqual(expect.arrayContaining([{ property: 'padding', value: '0' }]))
    expect(rules.find(r => r.selector === '.compare-search:focus-visible')?.declarations).toEqual(expect.arrayContaining([{ property: 'outline', value: 'none' }]))
    expect(rules.find(r => r.selector === '.multi-target-db')).toBeUndefined()
    expect(rules.find(r => r.selector === '.multi-target-row .multi-target-db')).toBeDefined()
    expect(rules.find(r => r.selector === '.multi-target-card .multi-target-db')?.declarations).toEqual(expect.arrayContaining([
      { property: 'overflow', value: 'hidden' },
      { property: 'text-overflow', value: 'ellipsis' }
    ]))
    expect(rules.find(r => r.at.includes('@media (forced-colors: active)') && r.selector.includes('.rt-stmt-tab[aria-selected="true"]:focus-visible'))?.declarations)
      .toEqual(expect.arrayContaining([{ property: 'outline-color', value: 'HighlightText' }]))
    expect(rules.find(r => r.at.includes('@media (forced-colors: active)') && r.selector.includes('.multi-target-swatch'))?.declarations)
      .toEqual(expect.arrayContaining([{ property: 'forced-color-adjust', value: 'none' }]))
  })

  it('R12 D4 #1–#4: prevents mixed-transaction rebuilds, isolates per-statement combine warnings, keeps uncombined Skipped warnings in Summary, and bounds summary card grid', async () => {
    // #1: Loading a windowed commitInDoubt or mismatched rolledBackPreview server must NOT mark committed Combined stale or include it in rebuildCombined.
    const { results, client, combine } = serviceFixture()
    results.begin('t1', 'q1', undefined, { multi: { mode: 'transaction', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const s3 = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0, residence: 'remote', rolledBackPreview: true })
    const c0 = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0 })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { status: 'committed', resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { status: 'committed', resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { status: 'commitInDoubt', resultSetIds: [3] })
        ],
        [s1, s2, s3, c0],
        { mode: 'transaction', status: 'commitInDoubt' }
      )
    })
    const c0Key = results.getSnapshot().t1.sets.find(entry => entry.descriptor.kind === 'combined')!.key
    // Simulate dev-01 loading into memory: Combined (committed) must NOT be marked stale and rebuild excludes dev-01!
    ;(results as unknown as { loaded(tabId: string, run: unknown, summary: unknown): void }).loaded(
      't1',
      (results as unknown as { runs: Map<string, unknown> }).runs.get('t1'),
      {
        resultSets: [descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0, residence: 'memory', rolledBackPreview: true, revision: 2 })],
        messages: [],
        planSets: []
      }
    )
    expect(results.getSnapshot().t1.staleCombined?.has(c0Key) ?? false).toBe(false)
    let combinedSourceIds: number[] = []
    combine.mockImplementationOnce(async (handles: unknown) => {
      combinedSourceIds = (handles as readonly { key: { resultId: number } }[]).map(h => h.key.resultId)
      return { descriptor: descriptor(601, { kind: 'combined', index: 3, statementSlot: 0 }) }
    })
    expect(await results.rebuildCombined('t1', c0Key)).toBe(c0Key)
    expect(combinedSourceIds).toEqual([1, 2])
    void client

    // #2: Rebuilding c1 with warnings when initial run had no combineWarnings must NOT leak onto sibling c2!
    const fx2 = serviceFixture()
    fx2.results.begin('t2', 'q2', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const a1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const a2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const ca = descriptor(10, { index: 2, kind: 'combined', statementSlot: 0 })
    const b1 = descriptor(3, { index: 3, targetKey: 'prod-east', statementSlot: 1 })
    const b2 = descriptor(4, { index: 4, targetKey: 'prod-west', statementSlot: 1 })
    const cb = descriptor(11, { index: 5, kind: 'combined', statementSlot: 1 })
    void fx2.results.finish('t2', 'q2', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1, 3] }), multiOutcome(sqlTargets[1], { resultSetIds: [2, 4] })],
        [a1, a2, ca, b1, b2, cb]
      )
    })
    const caKey = fx2.results.getSnapshot().t2.sets.find(e => e.descriptor.resultId === 10)!.key
    const cbKey = fx2.results.getSnapshot().t2.sets.find(e => e.descriptor.resultId === 11)!.key
    fx2.combine.mockResolvedValueOnce({
      descriptor: descriptor(610, { kind: 'combined', index: 2, statementSlot: 0 }),
      warnings: ['Schema drift on slot 0.']
    })
    expect(await fx2.results.rebuildCombined('t2', caKey)).toBe(caKey)
    const tab2 = fx2.results.getSnapshot().t2
    const caAfter = tab2.sets.find(e => e.key === caKey)!
    const cbAfter = tab2.sets.find(e => e.key === cbKey)!
    expect(entryNotices(tab2, caAfter).map(n => n.kind)).toEqual(['combineWarning'])
    expect(entryNotices(tab2, cbAfter)).toEqual([])

    // #3: "Skipped <server>: ..." for an uncombined statement slot stays in baseCombineWarnings, never pollutes Combined 1.
    const fx3 = serviceFixture()
    fx3.results.begin('t3', 'q3', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const p1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const p2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const cp = descriptor(10, { index: 2, kind: 'combined', statementSlot: 0 })
    const q1 = descriptor(3, { index: 3, targetKey: 'prod-east', statementSlot: 1 })
    const q2 = descriptor(4, { index: 4, targetKey: 'prod-west', statementSlot: 1, residence: 'remote' })
    const skippedMsg = 'Skipped prod-sql-west-01: result is windowed in BigQuery. Load it into memory to include it in Combined.'
    void fx3.results.finish('t3', 'q3', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1, 3] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [2, 4] }),
          multiOutcome(sqlTargets[2], { resultSetIds: [] })
        ],
        [p1, p2, cp, q1, q2],
        { combineWarnings: [skippedMsg] }
      )
    })
    const tab3 = fx3.results.getSnapshot().t3
    const cpEntry = tab3.sets.find(e => e.descriptor.kind === 'combined')!
    expect(tab3.multi?.combineWarnings).toEqual([skippedMsg])
    expect(entryNotices(tab3, cpEntry).map(n => n.kind)).toEqual(['partialCombine'])
    expect(fx3.results.removeEntry('t3', cpEntry.key)).toBe(true)
    expect(fx3.results.getSnapshot().t3.multi?.combineWarnings).toEqual([skippedMsg])

    // #4: .multi-summary-cards uses minmax(min(260px, 100%), 1fr) and .multi-target-card sets min-width: 0.
    const rules = stylesheetRules()
    expect(rules.find(r => r.selector === '.multi-summary-cards')?.declarations).toEqual(expect.arrayContaining([
      { property: 'grid-template-columns', value: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))' }
    ]))
    expect(rules.find(r => r.selector === '.multi-target-card')?.declarations).toEqual(expect.arrayContaining([
      { property: 'min-width', value: '0' }
    ]))
  })

  it('R13 D4 #1–#4: fixes CSS active/hover specificity, excludes samples from defaultMultiPair, handles colons in Skipped target labels, and avoids premature allRolledBack while running', async () => {
    // #1: CSS active toggle & chip rules outrank button.ui-button[aria-pressed="true"] and button:hover:not(:disabled).
    const rules = stylesheetRules()
    expect(rules.find(r => r.selector.includes('button.ui-button.cross-engine-view-btn[aria-pressed="true"]'))?.declarations).toEqual(expect.arrayContaining([
      { property: 'background', value: 'var(--varia-chip-activeBackground)' },
      { property: 'color', value: 'var(--varia-chip-activeForeground)' }
    ]))
    expect(rules.find(r => r.selector === '.multi-exec-mode-card:hover:not(.is-disabled, .is-picked)')).toBeDefined()
    expect(rules.find(r => r.selector.includes('button.multi-grid-notice-btn[aria-disabled="true"]:hover:not(:disabled)'))?.declarations).toEqual(expect.arrayContaining([
      { property: 'background', value: 'transparent' }
    ]))
    expect(rules.find(r => r.at.includes('@media (forced-colors: active)') && r.selector.includes('button.ui-button.cross-engine-stack-btn[aria-pressed="true"]'))?.declarations).toEqual(expect.arrayContaining([
      { property: 'forced-color-adjust', value: 'none' },
      { property: 'background', value: 'Highlight' },
      { property: 'color', value: 'HighlightText' }
    ]))

    // #2: CompareService.defaultMultiPair excludes BigQuery samples and never pairs two sets from the same targetKey.
    const fx2 = serviceFixture()
    const compare = new CompareService(fx2.results)
    cleanups.add(() => compare.dispose())
    const cols: ResultColumn[] = [{ name: 'Id', dataType: 'int', wire: 'text', nullable: false }]
    fx2.results.begin('t2', 'q2', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    const eastFull = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, columns: cols })
    const westFull = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0, columns: cols })
    void fx2.results.finish('t2', 'q2', {
      multiSummary: multiSummaryOf(
        [multiOutcome(sqlTargets[0], { resultSetIds: [1] }), multiOutcome(sqlTargets[1], { resultSetIds: [2] })],
        [eastFull, westFull]
      )
    })
    const sampleDesc = descriptor(3, { index: 2, targetKey: 'prod-east', statementSlot: 0, columns: cols })
    fx2.results.addSet('t2', sampleDesc, 'Sample of East', ['1:1'])
    const sampleEntry = fx2.results.getSnapshot().t2.sets.find(e => e.descriptor.resultId === 3)!
    ;(sampleEntry as { sample?: boolean }).sample = true
    const pair = compare.defaultMultiPair('t2', 0)
    expect(pair?.old.descriptor.targetKey).toBe('prod-east')
    expect(pair?.neu.descriptor.targetKey).toBe('prod-west')

    // #3: Target label containing a colon ("BQ: Analytics Prod") attaches Skipped warning to the matching Combined entry and clears on rebuild.
    const fx3 = serviceFixture()
    const colonTargets: MultiTargetIdentity[] = [
      { targetKey: 'sql-1', connectionId: 'c-sql-1', provider: 'sqlserver', label: 'SQL: East' },
      { targetKey: 'sql-2', connectionId: 'c-sql-2', provider: 'sqlserver', label: 'SQL: West' },
      { targetKey: 'bq-1', connectionId: 'c-bq-1', provider: 'bigquery', label: 'BQ: Analytics Prod' }
    ]
    fx3.results.begin('t3', 'q3', undefined, { multi: { mode: 'fireAndForget', targets: colonTargets } })
    const m1 = descriptor(1, { index: 0, targetKey: 'sql-1', statementSlot: 0 })
    const m2 = descriptor(2, { index: 1, targetKey: 'sql-2', statementSlot: 0 })
    const m3 = descriptor(3, { index: 2, targetKey: 'bq-1', statementSlot: 0, residence: 'remote' })
    const mc = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0 })
    const colonSkip = 'Skipped BQ: Analytics Prod: result is windowed in BigQuery. Load it into memory to include it in Combined.'
    void fx3.results.finish('t3', 'q3', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(colonTargets[0], { resultSetIds: [1] }),
          multiOutcome(colonTargets[1], { resultSetIds: [2] }),
          multiOutcome(colonTargets[2], { resultSetIds: [3] })
        ],
        [m1, m2, m3, mc],
        { combineWarnings: [colonSkip] }
      )
    })
    const mcKey = fx3.results.getSnapshot().t3.sets.find(e => e.descriptor.kind === 'combined')!.key
    expect(fx3.results.getSnapshot().t3.combineWarnings?.get(mcKey)).toEqual([colonSkip])
    fx3.combine.mockResolvedValueOnce({ descriptor: descriptor(650, { kind: 'combined', index: 3, statementSlot: 0 }) })
    expect(await fx3.results.rebuildCombined('t3', mcKey)).toBe(mcKey)
    expect(fx3.results.getSnapshot().t3.multi?.combineWarnings).toBeUndefined()

    // #4: While a transaction run is still running and one target rolled back, MultiRunSummary does NOT claim "every server transaction was rolled back".
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('r13-running-rb.sql', 'UPDATE t SET a = 1; SELECT 1;', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'transaction', targets: sqlTargets.slice(0, 2) } })
    const rSet = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, rolledBackPreview: true })
    ;(f.results as unknown as { runs: Map<string, { sets: unknown[]; multi?: { targets: { phase: string }[] } }> }).runs.get(doc.id)!.multi!.targets[0]!.phase = 'rolledBack'
    f.results.begin(doc.id, 'q2', undefined, { multi: { mode: 'transaction', targets: sqlTargets.slice(0, 2) } })
    const runningTab: TabResults = {
      ...f.results.getSnapshot()[doc.id],
      status: 'running',
      sets: [{ key: 'e1', number: 1, descriptor: rSet, handle: fakeResultClient().open(rSet), label: 'prod-sql-east-01' }]
    }
    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(MultiRunSummary, { tabId: doc.id, tab: runningTab, active: true })
    }))
    const noticeText = host.querySelector('.multi-notice-warn')?.textContent ?? ''
    expect(noticeText).toContain('while remaining servers finish settling')
    expect(noticeText).not.toContain('every server transaction was rolled back')
  })

  it('R14 D4 #1–#7: failed/timedOut rolledBackPreview shows full rollback copy, duplicate target labels route Skipped warnings, and CSS collation/forced-colors/min-height/disabled-hover rules hold', async () => {
    // #1: All targets failed/timedOut with rolledBackPreview (zero committed/commitInDoubt) -> does NOT falsely claim committed or in doubt!
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('r14-failed-rb.sql', 'UPDATE t SET a = 1; SELECT 1;', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'transaction', targets: sqlTargets.slice(0, 2) } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0, rolledBackPreview: true })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { status: 'failed', resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { status: 'timedOut' })
        ],
        [s1],
        { mode: 'transaction', status: 'failed' }
      )
    })
    const host = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(MultiRunSummary, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id], active: true })
    }))
    const banner = host.querySelector('.multi-notice-warn')?.textContent ?? ''
    expect(banner).toContain('every server transaction was rolled back')
    expect(banner).not.toContain('committed or are in doubt')

    // #2: Duplicate display labels ("Analytics") where 2nd target is remote routes Skipped warning to Combined and clears on rebuild.
    const fx2 = serviceFixture()
    const dupTargets: MultiTargetIdentity[] = [
      { targetKey: 'bq-1', connectionId: 'c-1', provider: 'bigquery', label: 'Analytics' },
      { targetKey: 'bq-2', connectionId: 'c-2', provider: 'bigquery', label: 'Analytics' },
      { targetKey: 'bq-3', connectionId: 'c-3', provider: 'bigquery', label: 'Warehouse' }
    ]
    fx2.results.begin('t2', 'q2', undefined, { multi: { mode: 'fireAndForget', targets: dupTargets } })
    const d1 = descriptor(1, { index: 0, targetKey: 'bq-1', statementSlot: 0 })
    const d2 = descriptor(2, { index: 1, targetKey: 'bq-2', statementSlot: 0, residence: 'remote' })
    const d3 = descriptor(3, { index: 2, targetKey: 'bq-3', statementSlot: 0 })
    const dc = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0 })
    const skipMsg = 'Skipped Analytics: result is windowed in BigQuery. Load it into memory to include it in Combined.'
    void fx2.results.finish('t2', 'q2', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(dupTargets[0], { resultSetIds: [1] }),
          multiOutcome(dupTargets[1], { resultSetIds: [2] }),
          multiOutcome(dupTargets[2], { resultSetIds: [3] })
        ],
        [d1, d2, d3, dc],
        { combineWarnings: [skipMsg] }
      )
    })
    const dcKey = fx2.results.getSnapshot().t2.sets.find(e => e.descriptor.kind === 'combined')!.key
    expect(fx2.results.getSnapshot().t2.combineWarnings?.get(dcKey)).toEqual([skipMsg])
    fx2.combine.mockResolvedValueOnce({ descriptor: descriptor(700, { kind: 'combined', index: 3, statementSlot: 0 }) })
    expect(await fx2.results.rebuildCombined('t2', dcKey)).toBe(dcKey)
    expect(fx2.results.getSnapshot().t2.multi?.combineWarnings).toBeUndefined()

    // #3, #4, #5, #6, #7: CSS collation specificity, forced-colors focus indicators, compact button min-height, disabled search hover.
    const rules = stylesheetRules()
    expect(rules.find(r => r.selector === '.compare-note.compare-cross-collation')?.declarations).toEqual(expect.arrayContaining([
      { property: 'color', value: 'var(--varia-statusPill-infoForeground)' }
    ]))
    expect(rules.find(r => r.at.includes('@media (forced-colors: active)') && r.selector.includes('button.ui-button.cross-engine-view-btn[aria-pressed="true"]:focus-visible'))?.declarations)
      .toEqual(expect.arrayContaining([{ property: 'outline-color', value: 'HighlightText' }]))
    expect(rules.find(r => r.at.includes('@media (forced-colors: active)') && r.selector === '.compare-search-row:focus-within')?.declarations)
      .toEqual(expect.arrayContaining([{ property: 'border-color', value: 'Highlight' }]))
    for (const sel of ['.multi-target-reconnect', '.multi-target-apply-btn', '.cross-engine-view-btn, .cross-engine-stack-btn']) {
      expect(rules.find(r => r.selector === sel)?.declarations).toEqual(expect.arrayContaining([{ property: 'min-height', value: '0' }]))
    }
    expect(rules.find(r => r.selector === '.results-search:hover:not(:focus-within, [data-disabled])')).toBeDefined()
  })

  it('R15 D4 #1–#5: excludes non-complete/remote sources from combinedTargetCount & stale marking, preserves resultTitle server names, and guards disabled forced-colors/open trigger hover', () => {
    // #1 & #2: Incomplete (state: 'open') target result is NOT counted in Combined (k/N) and closing it does NOT mark Combined stale!
    const { results, client } = serviceFixture()
    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const s3 = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0, state: 'open' })
    const c1 = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0 })
    client.emit('q1', { type: 'resultSet.opened', descriptor: s3 })
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { status: 'failed', resultSetIds: [3] })
        ],
        [s1, s2, c1]
      )
    })
    const tab = results.getSnapshot().t1
    const c1Entry = tab.sets.find(e => e.descriptor.kind === 'combined')!
    const s3Entry = tab.sets.find(e => e.descriptor.targetKey === 'dev-01')!
    expect(tab.combinedCounts?.get(c1Entry.key)).toBe(2)
    expect(combinedTargetCount(tab, 0)).toBe(2)
    expect(topItems(tab).find(i => i.combined)?.name).toBe('Combined (2/3)')
    expect(entryNotices(tab, c1Entry).map(n => n.kind)).toEqual(['partialCombine'])

    // Closing the failed dev-01 entry must NOT mark Combined stale!
    expect(results.removeEntry('t1', s3Entry.key)).toBe(true)
    expect(results.getSnapshot().t1.staleCombined?.has(c1Entry.key) ?? false).toBe(false)

    // #4: resultTitle preserves multi-server server name and Combined label alongside Result N.
    const s1Entry = results.getSnapshot().t1.sets.find(e => e.descriptor.targetKey === 'prod-east')!
    expect(resultTitle(s1Entry)).toBe(`prod-sql-east-01, Result ${s1Entry.number}`)
    expect(resultTitle(c1Entry)).toBe(`Combined, Result ${c1Entry.number}`)

    // #3 & #5: forced-colors disabled toolbar guards & .multi-target-trigger hover excluding [data-open].
    const rules = stylesheetRules()
    expect(rules.find(r => r.at.includes('@media (forced-colors: active)') && r.selector.includes('.results-segments button[aria-pressed="true"]:not(:disabled)'))).toBeDefined()
    expect(rules.find(r => r.at.includes('@media (forced-colors: active)') && r.selector.includes('.results-choice-trigger[data-active]:not(:disabled)'))).toBeDefined()
    expect(rules.find(r => r.at.includes('@media (forced-colors: active)') && r.selector.includes('.results-segments button:disabled'))?.declarations).toEqual(expect.arrayContaining([
      { property: 'color', value: 'GrayText' },
      { property: 'opacity', value: '1' }
    ]))
    expect(rules.find(r => r.selector === '.multi-target-trigger:hover:not(:disabled, [data-open])')).toBeDefined()
  })

  it('R16 D4 #1–#5: deduplicates multi-statement combine warnings, disables Rebuild on backend loss, updates Summary toolbar titles, and fixes open trigger & forced-colors disabled rules', () => {
    // #1: Duplicate combineWarnings from multiple statement slots are deduplicated per entry & in baseWarnings.
    const { results, client } = serviceFixture()
    results.begin('t1', 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const s3 = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0 })
    const c1 = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0 })
    const drift = 'Schema drift: 1 column(s) were missing on one or more servers and filled with NULL.'
    void results.finish('t1', 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { resultSetIds: [3] })
        ],
        [s1, s2, s3, c1],
        { combineWarnings: [drift, drift] }
      )
    })
    const c1Entry = results.getSnapshot().t1.sets.find(e => e.descriptor.kind === 'combined')!
    expect(results.getSnapshot().t1.combineWarnings?.get(c1Entry.key)).toEqual([drift])

    // #2: Backend loss (`client.lose()`) re-renders EntryNoticeBars immediately, disabling Rebuild with the backend-restart tooltip!
    const devKey = results.getSnapshot().t1.sets.find(e => e.descriptor.targetKey === 'dev-01')!.key
    results.removeEntry('t1', devKey)
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const wb = { ...f, results } as unknown as Workbench
    const host = mount(createElement(WorkbenchProvider, {
      workbench: wb,
      children: createElement(EntryNoticeBars, { tabId: 't1', tab: results.getSnapshot().t1, entry: results.getSnapshot().t1.sets.find(e => e.key === c1Entry.key)!, running: false })
    }))
    const rebuildBtn = () => [...host.querySelectorAll<HTMLButtonElement>('.multi-grid-notice-btn')].find(b => b.textContent?.includes('Rebuild'))!
    expect(rebuildBtn().disabled).toBe(false)
    act(() => { client.lose() })
    expect(rebuildBtn().disabled).toBe(true)
    expect(rebuildBtn().title).toContain('SQL backend restarted')

    // #5: ResultsToolbar swaps Profile/Row size/Pivot/Transposed titles when gridDisabled on Summary.
    const doc = f.documents.create('r16-toolbar.sql', 'SELECT 1;', 'SalesDB')
    f.results.begin(doc.id, 'q2', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets.slice(0, 2) } })
    void f.results.finish(doc.id, 'q2', {
      multiSummary: multiSummaryOf([multiOutcome(sqlTargets[0]), multiOutcome(sqlTargets[1])], [])
    })
    const tbHost = mount(createElement(WorkbenchProvider, {
      workbench: f as unknown as Workbench,
      children: createElement(ResultsToolbar, { tabId: doc.id })
    }))
    expect(tbHost.querySelector<HTMLButtonElement>('button[aria-label="Profile"]')?.title).toBe('Column profile: unavailable on Summary')
    expect(tbHost.querySelector<HTMLButtonElement>('button[aria-label="Transposed"]')?.title).toBe('Transposed: unavailable on Summary')

    // #3 & #4: Open trigger hover rule & forced-colors native disabled buttons.
    const rules = stylesheetRules()
    expect(rules.find(r => r.selector.includes('button.multi-target-trigger[data-open]:hover:not(:disabled)'))?.declarations).toEqual(expect.arrayContaining([
      { property: 'transition', value: 'none' },
      { property: 'background', value: 'var(--varia-input-background)' }
    ]))
    const forcedDisabled = rules.find(r => r.at.includes('@media (forced-colors: active)') && r.selector.includes('button.multi-grid-notice-btn:disabled'))
    expect(forcedDisabled?.selector).toContain('button.multi-target-link:disabled')
    expect(forcedDisabled?.declarations).toEqual(expect.arrayContaining([
      { property: 'color', value: 'GrayText' },
      { property: 'opacity', value: '1' }
    ]))
  })

  it('R17 D4 #1–#4: inset focus rings on summary toggle & stmt select, forced-colors pressed error badge, summaryOnly->grid focus handoff, and visually adjacent close focus in Stacked', () => {
    // #1 & #4: CSS inset focus rings & forced-colors pressed error badge.
    const rules = stylesheetRules()
    expect(rules.find(r => r.selector === '.rs-multi-summary-toggle:focus-visible')?.declarations).toEqual(expect.arrayContaining([
      { property: 'outline-offset', value: '-2px' }
    ]))
    expect(rules.find(r => r.selector.includes('.rt-stmt-select:focus-visible'))?.declarations).toEqual(expect.arrayContaining([
      { property: 'outline-offset', value: '-1px' }
    ]))
    expect(rules.find(r => r.at.includes('@media (forced-colors: active)') && r.selector === 'button.messages-filter-pill[aria-pressed="true"] .messages-filter-err')?.declarations)
      .toEqual(expect.arrayContaining([
        { property: 'background', value: 'HighlightText' },
        { property: 'color', value: 'Highlight' }
      ]))

    // #2: In Stacked layout, focusing [data-multi-summary] while 0 sets exist and then streaming the first set moves focus to .rs-multi-summary-toggle (never document.body).
    const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
    cleanups.add(() => {
      if (origClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientHeight)
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    })
    const f = workbenchFixture()
    cleanups.add(f.dispose)
    const doc = f.documents.create('r17-stack-focus.sql', 'SELECT 1;', 'SalesDB')
    f.results.begin(doc.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets: sqlTargets } })

    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.add(() => { act(() => root.unmount()); host.remove() })
    const render = () => act(() => {
      root.render(createElement(WorkbenchProvider, {
        workbench: f as unknown as Workbench,
        children: createElement(ResultsStack, { tabId: doc.id, tab: f.results.getSnapshot()[doc.id] })
      }))
    })
    render()
    const summaryEl = host.querySelector<HTMLElement>('[data-multi-summary]')!
    act(() => { summaryEl.focus() })
    expect(document.activeElement).toBe(summaryEl)

    // Finish with [s1, s2, s3, c0] (c0 is last in tab.sets, but visually FIRST in ResultsStack!).
    const s1 = descriptor(1, { index: 0, targetKey: 'prod-east', statementSlot: 0 })
    const s2 = descriptor(2, { index: 1, targetKey: 'prod-west', statementSlot: 0 })
    const s3 = descriptor(3, { index: 2, targetKey: 'dev-01', statementSlot: 0 })
    const c0 = descriptor(10, { index: 3, kind: 'combined', statementSlot: 0 })
    void f.results.finish(doc.id, 'q1', {
      multiSummary: multiSummaryOf(
        [
          multiOutcome(sqlTargets[0], { resultSetIds: [1] }),
          multiOutcome(sqlTargets[1], { resultSetIds: [2] }),
          multiOutcome(sqlTargets[2], { resultSetIds: [3] })
        ],
        [s1, s2, s3, c0]
      )
    })
    render()
    expect(document.activeElement).toBe(host.querySelector('.rs-multi-summary-toggle'))

    // #3: Focusing Combined (visual top) and clicking its Close button moves focus to visually adjacent prod-east (s1), NOT dev-01 (s3 at bottom)!
    const tabNow = f.results.getSnapshot()[doc.id]
    const c0Key = tabNow.sets.find(e => e.descriptor.kind === 'combined')!.key
    const s1Key = tabNow.sets.find(e => e.descriptor.targetKey === 'prod-east')!.key
    act(() => { f.results.focusEntry(doc.id, c0Key) })
    render()
    const c0Caption = host.querySelector<HTMLElement>(`[data-caption-entry="${c0Key}"]`)!
    const c0Close = c0Caption.closest('.rs-caption')!.querySelector<HTMLButtonElement>('button[aria-label^="Close"]')!
    act(() => { c0Close.focus(); c0Close.click() })
    render()
    expect(f.results.getSnapshot()[doc.id].focused).toBe(s1Key)
    expect(document.activeElement).toBe(host.querySelector(`[data-caption-entry="${s1Key}"]`))
  })

  it('R18 D4 #1–#5: inset focus rings & forced-colors outlines on stmt/filter controls, sample exclusion from entrySecondary/distinctName, Stacked selectStmt scrollTop reset, and chip/guard CSS bounds', () => {
    // #2: Multi-server BigQuery sample carrying targetKey does NOT get duplicated "Result N" from entrySecondary / distinctName.
    const sampleEntry = {
      number: 5,
      label: 'Sample: 1,000 of 50,000 rows (Result 5)',
      sample: true as const,
      descriptor: descriptor(5, { targetKey: 'bq-1', statementSlot: 0 })
    }
    expect(entrySecondary(sampleEntry)).toBeUndefined()
    expect(numberedName(sampleEntry)).toBe('Sample: 1,000 of 50,000 rows (Result 5)')

    // #1, #4, #5: CSS inset focus rings, forced-colors pressed outlines, target chip truncation, and guard button min-height: 0.
    const rules = stylesheetRules()
    expect(rules.find(r => r.selector.includes('.rs-stmt-btn:focus-visible') && r.selector.includes('.messages-filter-pill:focus-visible'))?.declarations)
      .toEqual(expect.arrayContaining([{ property: 'outline-offset', value: '-1px' }]))
    expect(rules.find(r => r.at.includes('@media (forced-colors: active)') && r.selector.includes('.rs-stmt-btn[aria-pressed="true"]:focus-visible') && r.selector.includes('.messages-filter-pill[aria-pressed="true"]:focus-visible'))?.declarations)
      .toEqual(expect.arrayContaining([{ property: 'outline-color', value: 'HighlightText' }]))
    expect(rules.find(r => r.selector === '.multi-exec-target-chip')?.declarations).toEqual(expect.arrayContaining([
      { property: 'min-width', value: '0' },
      { property: 'overflow', value: 'hidden' }
    ]))
    expect(rules.find(r => r.selector === '.multi-exec-target-label')?.declarations).toEqual(expect.arrayContaining([
      { property: 'text-overflow', value: 'ellipsis' }
    ]))
    expect(rules.find(r => r.selector === '.cross-engine-guard-next, .cross-engine-guard-open')?.declarations).toEqual(expect.arrayContaining([
      { property: 'min-height', value: '0' }
    ]))
  })
})
