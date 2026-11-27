import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import MultiRunSummary, { targetPhaseInfo } from '../results/MultiRunSummary'
import { distinctName, entryName, entrySecondary, hasMultiSummary, isSummaryActive, pivotOutOfDate, setKey, spokenName, summaryEntryKey, transposedView, type EntryKey, type GridSort, type GridViewState, type ResultGroup, type ResultSetEntry, type TabResults } from '../results/ResultsService'
import { formatCount, plural, rowsFact } from '../results/status'
import { observeResize, windows } from '../core/windows'
import { gridLimits as g } from './constants'
import ResultGrid from './ResultGrid'
import { batchText, EntryNoticeBars, entryNoticesHeight, FilterChips, multiSummaryMinHeight, PivotMark, scrollbarSize, settledContent } from './ResultsStack'
import { minGridHeight } from './stack'
import { visibleColumnCount } from './hidden-columns'
import { groupView, pickerRequests, selectedEntry, selectedGroup, selectedItem, topItems, type TopItem } from './result-picker'
import ResultsPicker from './ResultsPicker'

export { groupView, selectedEntry, topItems, type TopItem } from './result-picker'

/** The strip's scroll offset that shows a tab from `start` to `start + width` whole, moving as little as it can (a tab wider
 *  than the strip shows its start). */
export function revealLeft(scrollLeft: number, viewWidth: number, start: number, width: number): number {
  if (start < scrollLeft || width >= viewWidth) return start
  return start + width > scrollLeft + viewWidth ? start + width - viewWidth : scrollLeft
}

/** The width of the fade at a strip edge that hides tabs: .rt-strip's mask in styles.css, --varia-space-4. */
const stripFade = 16
/** Marks the edges of the strip that hide tabs, for the fade. */
function clipStrip(strip: HTMLElement | null) {
  const row = strip?.parentElement
  if (!strip || !row) return
  row.toggleAttribute('data-clip-start', strip.scrollLeft > 0)
  row.toggleAttribute('data-clip-end', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1)
}
/** Scrolls the strip to show its selected tab whole and clear of the fade, then marks its edges. */
function revealSelectedTab(strip: HTMLElement | null) {
  const target = strip?.querySelector<HTMLElement>('.rt-tab[data-selected]')
  if (strip && target) {
    const start = Math.max(0, target.offsetLeft - stripFade), end = Math.min(strip.scrollWidth, target.offsetLeft + target.offsetWidth + stripFade)
    strip.scrollLeft = Math.max(0, Math.min(revealLeft(strip.scrollLeft, strip.clientWidth, start, end - start), strip.scrollWidth - strip.clientWidth))
  }
  clipStrip(strip)
}

/** How many of a row of `count` items have no tab shown whole in the strip: those outside the window drawn and those the
 *  strip scrolls out of view or cuts at an edge. The overflow button counts them. */
export function hiddenTabs(strip: HTMLElement | null, count: number): number {
  if (!strip) return 0
  let whole = 0
  for (const tab of strip.querySelectorAll<HTMLElement>('.rt-tab')) {
    const left = tab.offsetLeft - strip.scrollLeft
    if (left >= -1 && left + tab.offsetWidth <= strip.clientWidth + 1) whole++
  }
  return Math.max(0, count - whole)
}

/** The places of the top-row items drawn: all of them up to `size`, else a window of `size` around the selected one, so a
 *  run of 1,000 results draws a bounded row; the overflow picker lists them all. */
export function tabWindow(count: number, at: number, size: number = g.resultTabsDrawn): [number, number] {
  if (count <= size) return [0, count - 1]
  const first = Math.max(0, Math.min(count - size, at - Math.floor(size / 2)))
  return [first, first + size - 1]
}

/** Statement groups belonging to the active multi-server top tab (all Combined groups, or all groups of the active target). */
function statementGroupsOf(tab: Pick<TabResults, 'groups'> & Partial<Pick<TabResults, 'multi'>>, group: ResultGroup | undefined): readonly ResultGroup[] {
  if (!group || !hasMultiSummary(tab)) return []
  const kind = group.table.entry.descriptor.kind
  if (kind === 'combined') return tab.groups.filter(item => item.table.entry.descriptor.kind === 'combined')
  const targetKey = group.table.entry.descriptor.targetKey
  if (targetKey) return tab.groups.filter(item => item.table.entry.descriptor.targetKey === targetKey)
  return []
}

/** Human-readable label for a statement sub-tab inside a multi-server Combined or per-server tab. */
function statementLabel(group: ResultGroup, index: number): string {
  if (group.table.entry.sample) return entryName(group.table.entry)
  const name = group.table.entry.descriptor.name
  return name || `Statement ${(group.table.entry.descriptor.statementSlot ?? index) + 1}`
}

/** Whether the Tabs layout renders the `.rt-views` sub-bar: hidden for Summary or a solo Table view with no Pivot, no
 *  statement sub-tabs, and no active filters. */
export function showsViewRow(group: ReturnType<typeof selectedGroup>, sort?: GridSort, statements = 1): boolean {
  if (!group) return true
  if (statements > 1) return true
  if (group.pivot) return true
  return (sort?.filters.length ?? 0) > 0
}

/** The room the Tabs layout needs before the Messages strip opens by itself: its tab row(s), any multi-server notice
 *  strips, and the selected grid at its minimum height (or its rows' height when settled and shorter). */
export function tabsNeed(tab: Pick<TabResults, 'sets' | 'settled' | 'focused'> & Partial<Pick<TabResults, 'sorts' | 'groups' | 'comparisons' | 'multi' | 'activeSummary' | 'staleCombined' | 'combineWarnings'>>, grids?: ReadonlyMap<EntryKey, GridViewState>): number {
  if (isSummaryActive(tab)) return g.resultTabsHeight + multiSummaryMinHeight
  const entry = selectedEntry(tab)
  if (!entry) return 0
  const turned = transposedView(grids?.get(entry.key), entry.descriptor) ? new Set([entry.key]) : undefined
  const content = settledContent(tab, undefined, turned, [entry])[0]
  const noticeHeight = entryNoticesHeight(tab, entry)
  const minHeight = minGridHeight(scrollbarSize()) + noticeHeight
  const group = tab.groups ? selectedGroup({ ...tab, groups: tab.groups, comparisons: tab.comparisons ?? [] }) : undefined
  const statements = tab.groups ? statementGroupsOf({ groups: tab.groups, multi: tab.multi }, group).length : 1
  const viewBar = tab.groups ? (showsViewRow(group, tab.sorts?.get(entry.key), statements) ? g.viewTabsHeight : 0) : g.viewTabsHeight
  return g.resultTabsHeight + viewBar + Math.min(minHeight, content ?? minHeight)
}

/**
 * How the Tabs layout folds its rows of tabs in a short pane, so the grid keeps room for its header, two rows, and any
 * multi-server notice strips (`noticeHeight`, e.g. Rolled-back preview + Partial-merge/Schema-drift/Stale-combined):
 * undefined, every shown row; `one` (only when `.rt-views` is shown), the result tabs and the selected view's row side
 * by side in one row, without the facts (the status line has them); `none`, the grid alone, as Stacked's one set gives
 * up its caption. Undefined before the layout has a height.
 */
export function tabsFold(height: number, scrollbar: number = scrollbarSize(), twoRows = true, noticeHeight = 0): 'one' | 'none' | undefined {
  if (height <= 0) return undefined
  const need = g.headerHeight + 2 * g.rowHeight + Math.max(0, scrollbar) + g.stackBorder + Math.max(0, noticeHeight)
  if (twoRows) {
    if (height - g.resultTabsHeight - g.viewTabsHeight >= need) return undefined
    return height - g.resultTabsHeight >= need ? 'one' : 'none'
  }
  return height - g.resultTabsHeight >= need ? undefined : 'none'
}

/** The selected view's facts beside its view tabs: rows (counting while they stream) and columns, the batch it came from. */
const ViewFacts = memo(function ViewFacts({ entry, sort, totalBatches, cached }: { entry: ResultSetEntry; sort?: GridSort; totalBatches: number; cached: boolean }) {
  const snapshot = useSyncExternalStore(entry.handle.subscribe, entry.handle.getSnapshot)
  const columns = visibleColumnCount(entry.descriptor), number = entrySecondary(entry)
  // A named result's number leads its facts, as in its Stacked caption, so two tabs of one name are told apart on screen.
  const facts = [...number ? [number] : [], rowsFact(snapshot, sort, cached), `${formatCount(columns)} ${plural(columns, 'column')}`]
  if (entry.descriptor.kind === 'executionPlan') facts.push('execution plan')
  const batch = batchText(entry.descriptor.batchNumber, entry.descriptor.iteration, totalBatches)
  if (batch) facts.push(batch)
  // Rows change while the set streams; the grid's own label announces its counts.
  return <span className="rt-facts" aria-live="off">{facts.join(' · ')}</span>
})

/** Save Results As for the selected view, while its rows are held. */
const SaveView = memo(function SaveView({ tabId, entry, name }: { tabId: string; entry: ResultSetEntry; name: string }) {
  const { commands } = useWorkbench()
  const state = useSyncExternalStore(entry.handle.subscribe, () => entry.handle.getSnapshot().state)
  if (state === 'lost' || state === 'released') return null
  const save = (event: MouseEvent<HTMLButtonElement>) => {
    void commands.execute('output.saveResultsAs', { target: { kind: 'output', tabId, view: 'grid', entry: entry.key, selectedText: '', element: event.currentTarget } }, 'toolbar')
  }
  return <button type="button" className="icon-button rt-save" aria-label={`Save ${name} As…`} title={`Save ${name} As…`} onClick={save}><Icon name="save-as" /></button>
})

/** Moves along a tab list with the arrow keys, Home and End (ARIA tabs, selection follows focus): the place to go to, or -1. */
function tabKey(event: KeyboardEvent, at: number, count: number): number {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || count === 0) return -1
  return event.key === 'ArrowRight' ? (at + 1) % count : event.key === 'ArrowLeft' ? (at + count - 1) % count
    : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : -1
}

/** Accessible spoken label for a top-level tab item (including multi-server status and statement count). */
function spokenTopItem(item: TopItem): string {
  if (item.summary) return 'Summary'
  if (item.targetKey && item.targetPhase) {
    const phase = targetPhaseInfo(item.targetPhase).label
    const count = item.statementCount && item.statementCount > 1 ? `, ${formatCount(item.statementCount)} ${plural(item.statementCount, 'result set')}` : ''
    return `${item.name}, ${phase}${count}`
  }
  return item.number ? `${item.name}, ${item.number}` : item.name
}

/**
 * A run's results one at a time: a row of tabs for its groups ("Result 3") and comparisons (or for multi-server runs:
 * Summary → Combined (k/N) → per-server tabs → Differences), the selected group's view/statement sub-bar beneath, and
 * the active Summary or grid panel.
 */
export default function ResultsTabs({ tabId, tab }: { tabId: string; tab: TabResults }) {
  const { results, resultsSearch, gestures } = useWorkbench()
  const search = useServiceSnapshot(resultsSearch)[tabId]
  const rootRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const sets = tab.sets, running = tab.status === 'running'
  const summaryActive = isSummaryActive(tab)
  const selected = selectedEntry(tab)
  const items = topItems(tab)
  const group = selectedGroup(tab)
  const statementGroups = statementGroupsOf(tab, group)
  const sort = selected ? tab.sorts.get(selected.key) : undefined
  const showViewRow = !summaryActive && showsViewRow(group, sort, statementGroups.length)
  const noticeHeight = summaryActive ? 0 : entryNoticesHeight(tab, selected)
  const at = Math.max(0, selectedItem(tab, items))
  const [first, last] = tabWindow(items.length, at)
  const shown = items.slice(first, last + 1)
  const select = useCallback((key: EntryKey) => results.focusEntry(tabId, key), [results, tabId])
  const tabIdOf = (key: EntryKey, row: 'result' | 'view' | 'stmt') => `${id}${row}-${key}`

  // Closing a view: when the focus was in what closes (or nowhere), it goes to the tab selected next, in the row the closed
  // tab was in, once that tab is drawn; with nothing left, to the Results tab. Only once, in the first layout without it.
  const pendingFocus = useRef<{ readonly closed: EntryKey; readonly row: 'result' | 'view' } | undefined>(undefined)
  const resultsTab = () => rootRef.current?.closest('.output-panel')?.querySelector<HTMLElement>('[role="tab"][data-output-tab="results"]')
  const close = (key: EntryKey, row: 'result' | 'view', event: MouseEvent<HTMLButtonElement>, item?: TopItem) => {
    const root = rootRef.current, active = root?.ownerDocument.activeElement
    if (item?.targetKey) {
      const gone = new Set(results.closingTarget(tabId, item.targetKey).map(entry => entry.key))
      const inSelected = !!selected && gone.has(selected.key) && !!active?.closest('.rt-views, .rt-panel')
      const own = !active || active === root?.ownerDocument.body || active === event.currentTarget
        || (!!root && root.contains(active) && (gone.has(active.closest('[data-tab-entry]')?.getAttribute('data-tab-entry') ?? '') || inSelected))
      if (results.removeTargetEntries(tabId, item.targetKey) && own) pendingFocus.current = { closed: key, row }
      return
    }
    if (item?.combined) {
      // Closing Combined closes only the combined view(s), leaving all per-server result sets intact.
      const combinedKeys = tab.groups.filter(gItem => gItem.table.entry.descriptor.kind === 'combined').map(gItem => gItem.table.key)
      const gone = new Set(combinedKeys.flatMap(entryKey => results.closing(tabId, entryKey).map(entry => entry.key)))
      const inSelected = !!selected && gone.has(selected.key) && !!active?.closest('.rt-views, .rt-panel')
      const own = !active || active === root?.ownerDocument.body || active === event.currentTarget
        || (!!root && root.contains(active) && (gone.has(active.closest('[data-tab-entry]')?.getAttribute('data-tab-entry') ?? '') || inSelected))
      let removed = false
      for (const entryKey of combinedKeys) if (results.removeEntry(tabId, entryKey)) removed = true
      if (removed && own) pendingFocus.current = { closed: key, row }
      return
    }
    const gone = new Set(results.closing(tabId, key).map(entry => entry.key))
    const inSelected = !!selected && gone.has(selected.key) && !!active?.closest('.rt-views, .rt-panel')
    const own = !active || active === root?.ownerDocument.body || active === event.currentTarget
      || (!!root && root.contains(active) && (gone.has(active.closest('[data-tab-entry]')?.getAttribute('data-tab-entry') ?? '') || inSelected))
    const lastSet = !hasMultiSummary(tab) && gone.size === results.getSnapshot()[tabId]?.sets.length
    if (own && lastSet) resultsTab()?.focus({ preventScroll: true })
    if (results.removeEntry(tabId, key) && own && !lastSet) pendingFocus.current = { closed: key, row }
  }
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending || sets.some(entry => entry.key === pending.closed)) return
    pendingFocus.current = undefined
    const root = rootRef.current, active = root?.ownerDocument.activeElement
    if (active && active !== root?.ownerDocument.body && !root?.contains(active)) return
    const target = root?.querySelector<HTMLElement>(`[data-tab-row="${pending.row}"] [role="tab"][aria-selected="true"]`) ?? root?.querySelector<HTMLElement>('[data-tab-row="result"] [role="tab"][aria-selected="true"]') ?? resultsTab()
    target?.focus({ preventScroll: true })
  })

  // A short pane folds the rows of tabs (`tabsFold`, accounting for exact notice strip height so grids are never starved).
  const [fold, setFold] = useState<ReturnType<typeof tabsFold>>(undefined)
  const effectiveFold = summaryActive ? undefined : fold
  const foldRef = useRef(effectiveFold)
  foldRef.current = effectiveFold
  const collapseStatements = effectiveFold === 'one' || statementGroups.length > 3

  const gridFocus = useRef(false)
  const tabRow = useRef<string | undefined>(undefined)
  const trackFocus = (event: FocusEvent<HTMLDivElement>) => {
    const target = event.target as Element
    gridFocus.current = !!target.closest?.('[data-result-grid]')
    tabRow.current = target.matches?.('[role="tab"]') ? target.closest('[data-tab-row]')?.getAttribute('data-tab-row') ?? undefined : target.matches?.('.rt-stmt-select') ? 'stmt' : undefined
  }
  const trackBlur = (event: FocusEvent<HTMLDivElement>) => {
    const to = event.relatedTarget as Element | null
    if (to && !event.currentTarget.contains(to) && to !== resultsTab()) gridFocus.current = false
    if (to && !event.currentTarget.contains(to)) tabRow.current = undefined
  }
  useLayoutEffect(() => {
    const root = rootRef.current, doc = root?.ownerDocument, active = doc?.activeElement
    const lost = !active || active === doc?.body
    const row = active?.matches('[role="tab"][aria-selected="false"]') && root?.contains(active) ? active.closest('[data-tab-row]')?.getAttribute('data-tab-row') : lost ? tabRow.current : undefined
    const target = row === 'view'
      ? root?.querySelector<HTMLElement>('[data-tab-row="view"] [role="tab"][aria-selected="true"]')
      : row === 'stmt'
        ? root?.querySelector<HTMLElement>('[data-tab-row="stmt"] [role="tab"][aria-selected="true"]') ?? root?.querySelector<HTMLElement>('.rt-stmt-select')
        : undefined
    if (target) target.focus()
    else if (row) { focusTab.current = items[at]?.key; focusResultTab() }
  }, [selected?.key, summaryActive, first, showViewRow, collapseStatements])
  useLayoutEffect(() => {
    const root = rootRef.current, active = root?.ownerDocument.activeElement
    if (!gridFocus.current || !root || (active && active !== root.ownerDocument.body && active !== resultsTab() && !root.contains(active))) return
    if (active && root.querySelector('.rt-panel')?.contains(active)) return
    root.querySelector<HTMLElement>('.rt-panel [data-result-grid]')?.focus({ preventScroll: true })
  }, [selected?.key])

  const revealSeq = search?.reveal ?? 0, revealEntry = search?.revealEntry
  useLayoutEffect(() => {
    if (revealEntry === undefined || revealEntry === selected?.key || !sets.some(entry => entry.key === revealEntry) || !resultsSearch.pendingReveal(tabId, revealEntry)) return
    select(revealEntry)
  }, [revealSeq, revealEntry])

  const pivots = useRef<ReadonlyMap<number, string | undefined> | undefined>(undefined)
  useLayoutEffect(() => {
    const seen = pivots.current
    pivots.current = new Map(tab.groups.map(item => [item.ordinal, item.pivot && setKey(item.pivot.entry.descriptor)]))
    if (!seen) return
    const built = tab.groups.filter(item => item.pivot && !item.pivot.pivot?.followed && seen.has(item.ordinal) && seen.get(item.ordinal) !== setKey(item.pivot.entry.descriptor))
    const shownGroup = group && !group.planSet ? built.find(item => item === group) : built[0]
    const root = rootRef.current, active = root?.ownerDocument.activeElement
    if (!shownGroup?.pivot || (active && root?.contains(active) && active.closest('[data-result-grid]'))) return
    if (selected?.key !== shownGroup.pivot.key) select(shownGroup.pivot.key)
  }, [tab.groups])
  const comparisons = useRef<ReadonlySet<EntryKey> | undefined>(undefined)
  useLayoutEffect(() => {
    const seen = comparisons.current
    comparisons.current = new Set(tab.comparisons.map(slot => slot.key))
    const made = seen && tab.comparisons.findLast(slot => !seen.has(slot.key))
    if (made && selected?.key !== made.key) select(made.key)
  }, [tab.comparisons])

  const focusTab = useRef<EntryKey | undefined>(undefined)
  const selectTopItem = (item: TopItem) => {
    if (item.summary) { select(summaryEntryKey); return }
    select(item.group ? groupView(item.group) : item.key)
  }
  const resultKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target as Element).matches('[role="tab"]')) return
    const next = tabKey(event, at, items.length)
    if (next < 0) return
    event.preventDefault()
    const item = items[next]
    focusTab.current = item.key
    selectTopItem(item)
    focusResultTab()
  }
  const focusResultTab = () => {
    if (rootRef.current?.getAttribute('data-fold') === 'none') return
    const key = focusTab.current, target = key === undefined ? null : rootRef.current?.querySelector<HTMLElement>(`[data-tab-row="result"] [data-tab-entry="${key}"] [role="tab"]`)
    if (!target) return
    focusTab.current = undefined
    target.focus()
  }
  useLayoutEffect(focusResultTab)
  const views = group ? [group.table, ...group.pivot ? [group.pivot] : []] : []
  const viewKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = tabKey(event, Math.max(0, views.findIndex(view => view.key === selected?.key)), views.length)
    if (next < 0) return
    event.preventDefault()
    select(views[next].key)
    rootRef.current?.querySelector<HTMLElement>(`[data-tab-row="view"] [data-tab-entry="${views[next].key}"] [role="tab"]`)?.focus()
  }
  const stmtKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = tabKey(event, Math.max(0, statementGroups.findIndex(item => item === group)), statementGroups.length)
    if (next < 0) return
    event.preventDefault()
    const targetGroup = statementGroups[next]
    select(groupView(targetGroup))
    rootRef.current?.querySelector<HTMLElement>(`[data-tab-row="stmt"] [data-tab-entry="${targetGroup.table.key}"]`)?.focus()
  }

  const stripRef = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState(0)
  const count = useRef(items.length)
  count.current = items.length
  const measureStrip = (reveal: boolean) => {
    const strip = stripRef.current
    if (reveal) revealSelectedTab(strip)
    else clipStrip(strip)
    setHidden(hiddenTabs(strip, count.current))
  }
  const hasActiveView = !!selected || summaryActive
  useLayoutEffect(() => { measureStrip(true) }, [group?.table.key ?? selected?.key ?? (summaryActive ? summaryEntryKey : undefined), first, !hasActiveView, showViewRow])
  useLayoutEffect(() => { measureStrip(false) }, [items.length, last, !hasActiveView])
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const observer = observeResize(strip, () => measureStrip(true))
    return () => observer.dispose()
  }, [!hasActiveView])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const measure = () => setFold(summaryActive ? undefined : tabsFold(root.clientHeight, undefined, showViewRow, noticeHeight))
    measure()
    const observer = observeResize(root, measure)
    return () => observer.dispose()
  }, [!hasActiveView, summaryActive, showViewRow, noticeHeight])
  useLayoutEffect(() => {
    const root = rootRef.current, active = root?.ownerDocument.activeElement
    if (effectiveFold !== 'none' || !root || !active || ![...root.querySelectorAll('.rt-results, .rt-views')].some(row => row.contains(active))) return
    root.querySelector<HTMLElement>('.rt-panel [data-result-grid]')?.focus({ preventScroll: true })
  }, [effectiveFold])

  const [picking, setPicking] = useState(false)
  const pickerFrom = useRef<HTMLElement | undefined>(undefined)
  useEffect(() => {
    const open = () => {
      const active = windows.activeElement()
      if (!(active instanceof HTMLElement && active.closest('[data-results-picker]'))) pickerFrom.current = active instanceof HTMLElement ? active : undefined
      setPicking(true)
    }
    if (pickerRequests.take(tabId)) open()
    const requests = pickerRequests.subscribe(requested => { if (requested === tabId && pickerRequests.take(tabId)) open() })
    return () => requests.dispose()
  }, [tabId])
  const overflowRef = useRef<HTMLButtonElement>(null)
  const pickerAnchor = () => foldRef.current === 'none' ? rootRef.current : overflowRef.current ?? rootRef.current?.querySelector<HTMLElement>('.rt-results')
  const closePicker = (restore: boolean) => {
    setPicking(false)
    const from = pickerFrom.current
    pickerFrom.current = undefined
    if (!restore) return
    if (from?.isConnected && from !== from.ownerDocument.body) {
      if (from.ownerDocument !== rootRef.current?.ownerDocument) from.ownerDocument.defaultView?.focus()
      from.focus({ preventScroll: true })
    }
    if (from && from.ownerDocument.activeElement === from) return
    if (foldRef.current === 'none') panelGrid()?.focus({ preventScroll: true })
    else (overflowRef.current ?? rootRef.current?.querySelector<HTMLElement>('[data-tab-row="result"] [role="tab"][aria-selected="true"]'))?.focus()
  }
  const panelGrid = () => rootRef.current?.querySelector<HTMLElement>('.rt-panel [data-result-grid]')
  const pick = (key: EntryKey) => {
    setPicking(false)
    if (key === summaryEntryKey) {
      select(summaryEntryKey)
      focusTab.current = summaryEntryKey
      if (foldRef.current !== 'none') focusResultTab()
      return
    }
    if (foldRef.current === 'none') {
      if (key === selected?.key) panelGrid()?.focus({ preventScroll: true })
      else { gridFocus.current = true; select(key) }
      return
    }
    select(key)
    const snapshotTab = results.getSnapshot()[tabId] ?? tab
    const item = topItems(snapshotTab).find(top => top.key === key || top.group?.pivot?.key === key
      || (top.combined && snapshotTab.groups.some(gItem => gItem.table.entry.descriptor.kind === 'combined' && (gItem.table.key === key || gItem.pivot?.key === key)))
      || (top.targetKey && snapshotTab.groups.some(gItem => gItem.table.entry.descriptor.targetKey === top.targetKey && (gItem.table.key === key || gItem.pivot?.key === key))))
    focusTab.current = item?.key
    focusResultTab()
  }
  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaX || !event.deltaY || gestures.matches('global.wheelZoom', event) || !gestures.matches('resultTabs.scroll', event)) return
    const strip = event.currentTarget
    strip.scrollLeft += event.deltaY * (event.deltaMode === 2 ? strip.clientWidth : event.deltaMode === 1 ? stripFade : 1)
  }
  const closeTitle = (name: string, others = '') => running ? `Close ${name} (unavailable while the query runs)` : `Close ${name}${others}`
  const refocusView = () => (rootRef.current?.querySelector<HTMLElement>('[data-tab-row="view"] [role="tab"][aria-selected="true"]')
    ?? rootRef.current?.querySelector<HTMLElement>('[data-tab-row="result"] [role="tab"][aria-selected="true"]'))?.focus()

  // Do NOT return null when Summary is active (including pure-DDL/DML multi-server runs with 0 result sets).
  if (!selected && !summaryActive) return null

  const selectedSlot = selected ? (group ? (group.pivot?.key === selected.key ? group.pivot : group.table) : tab.comparisons.find(slot => slot.key === selected.key)) : undefined
  const selectedName = selected ? entryName(selected) : 'Summary'
  const stale = !!group && pivotOutOfDate(tab, group)
  const labelledBy = summaryActive
    ? tabIdOf(summaryEntryKey, 'result')
    : group && showViewRow && (views.length > 1 || statementGroups.length <= 1)
      ? tabIdOf(selected!.key, 'view')
      : tabIdOf(items[at]?.key ?? selected!.key, 'result')
  const cached = tab.summary?.job?.cacheHit === true
  const budget = tab.summary?.budget ?? tab.multiSummary?.budget

  return <div ref={rootRef} className="rt-root" data-fold={effectiveFold} data-compact={!showViewRow || undefined} data-summary={summaryActive || undefined} onFocus={trackFocus} onBlur={trackBlur}>
    <div className="rt-results" data-tab-row="result" onKeyDown={resultKey}>
      <div className="rt-strip" ref={stripRef} role="tablist" aria-label="Results and comparisons" onScroll={() => measureStrip(false)} onWheel={wheel}>
        {shown.map((item, place) => {
          const on = item === items[at], others = item.group?.pivot ? ' and its Pivot' : ''
          const batch = item.group && !item.targetKey && !item.combined ? batchText(item.group.batchNumber, item.group.iteration, tab.totalBatches) : ''
          const tip = [item.number ? `${item.name} · ${item.number}` : item.short ? item.name : item.targetPhase ? `${item.name} · ${targetPhaseInfo(item.targetPhase).label}` : '', batch].filter(Boolean).join(' · ')
          const spoken = spokenTopItem(item)
          const phase = item.targetPhase ? targetPhaseInfo(item.targetPhase) : undefined
          const needsAriaLabel = !!(item.number || item.short || item.targetKey)
          return <div key={item.key} className="rt-tab" data-tab-entry={item.key} data-selected={on || undefined} data-named={item.named || undefined}
            data-summary={item.summary || undefined} data-combined={item.combined || undefined} data-target-key={item.targetKey}>
            <button type="button" role="tab" id={tabIdOf(item.key, 'result')} aria-selected={on} tabIndex={on ? 0 : -1} title={tip || undefined} {...needsAriaLabel ? { 'aria-label': spoken } : {}}
              aria-setsize={items.length} aria-posinset={first + place + 1} {...on ? { 'aria-controls': id + 'panel' } : {}} onClick={() => selectTopItem(item)}>
              {item.summary && <Icon name="layers" />}
              {item.combined && <Icon name="table" />}
              {item.targetKey && <span className="rt-server-dot" data-target-color={(item.targetIndex ?? 0) % 6} aria-hidden="true" />}
              {item.group?.planSet && <Icon name="execution-plan" />}
              {item.comparison && <Icon name="git-compare" />}
              <span className="rt-name">{item.short ?? item.name}</span>
              {phase && <span className="rt-server-status" data-tone={phase.tone} aria-hidden="true"><Icon name={phase.icon} spin={phase.spin} /></span>}
              {item.statementCount && item.statementCount > 1 && <span className="rt-stmt-count" aria-hidden="true">{item.statementCount}</span>}
            </button>
            {!tab.bare && !item.summary && <button type="button" className="icon-button rt-close" tabIndex={-1} aria-label={`Close ${spoken}`} title={closeTitle(spoken, others)} disabled={running}
              onClick={event => close(item.key, 'result', event, item)}><Icon name="close" /></button>}
          </div>
        })}
      </div>
      {hidden > 0 && <button ref={overflowRef} type="button" className="rt-overflow" aria-haspopup="dialog" aria-expanded={picking}
        aria-label={`All results, views and comparisons; ${formatCount(hidden)} not shown as tabs`} title="All results, views and comparisons (Go to Result…)"
        onClick={() => { pickerFrom.current = undefined; setPicking(open => !open) }}>+{formatCount(hidden)}<Icon name="chevron-down" /></button>}
      {!showViewRow && selected && <div className="rt-inline-right">
        <ViewFacts key={selected.key} entry={selected} sort={sort} totalBatches={tab.totalBatches} cached={cached} />
        <SaveView tabId={tabId} entry={selected} name={spokenName(selected)} />
      </div>}
      {picking && <ResultsPicker tab={tab} anchor={pickerAnchor} selected={summaryActive ? summaryEntryKey : selected?.key} onPick={pick} onClose={closePicker} />}
    </div>
    {showViewRow && selected && <div className="rt-views">
      {statementGroups.length > 1 && (collapseStatements
        ? <select className="rt-stmt-select" aria-label="Statement" value={group?.table.key ?? statementGroups[0].table.key}
            onChange={event => { const target = statementGroups.find(item => item.table.key === event.target.value); if (target) select(groupView(target)) }}>
            {statementGroups.map((stmtGroup, index) => <option key={stmtGroup.table.key} value={stmtGroup.table.key}>{statementLabel(stmtGroup, index)}</option>)}
          </select>
        : <div className="rt-stmt-tabs" role="tablist" aria-label="Statements" data-tab-row="stmt" onKeyDown={stmtKey}>
            {statementGroups.map((stmtGroup, index) => {
              const on = stmtGroup === group
              return <button key={stmtGroup.table.key} type="button" role="tab" className="rt-stmt-tab" id={tabIdOf(stmtGroup.table.key, 'stmt')}
                data-tab-entry={stmtGroup.table.key} data-selected={on || undefined} aria-selected={on} tabIndex={on ? 0 : -1}
                onClick={() => select(groupView(stmtGroup))}>{statementLabel(stmtGroup, index)}</button>
            })}
          </div>)}
      {group ? (statementGroups.length <= 1 || views.length > 1) && <div className="rt-view-tabs" role="tablist" aria-label={`Views of ${distinctName(group.table.entry, tab.sets)}`} data-tab-row="view" onKeyDown={viewKey}>
        {views.map(view => {
          const on = view.key === selected.key, pivot = view.view === 'pivot', marked = pivot && stale
          return <div key={view.key} className="rt-view" data-tab-entry={view.key} data-selected={on || undefined}>
            <button type="button" role="tab" id={tabIdOf(view.key, 'view')} aria-selected={on} tabIndex={on ? 0 : -1} {...on ? { 'aria-controls': id + 'panel' } : {}}
              aria-label={pivot ? entryName(view.entry) : group.planSet ? 'Plan set' : 'Table'} {...marked ? { 'aria-description': 'Out of date', title: "Out of date: its Table's filters changed" } : {}} onClick={() => select(view.key)}>
              {pivot ? 'Pivot' : group.planSet ? 'Plan set' : 'Table'}{marked && <span className="rt-dot" aria-hidden="true" />}
            </button>
            {pivot && !tab.bare && <button type="button" className="icon-button rt-close" tabIndex={-1} aria-label={`Close ${entryName(view.entry)}`} title={closeTitle(entryName(view.entry))} disabled={running}
              onClick={event => close(view.key, 'view', event)}><Icon name="close" /></button>}
          </div>
        })}
      </div> : <span className="rt-view-label"><Icon name="git-compare" />Comparison</span>}
      <ViewFacts key={selected.key} entry={selected} sort={sort} totalBatches={tab.totalBatches} cached={cached} />
      {group?.pivot && selected.key === group.pivot.key && !tab.bare && <PivotMark key={`mark:${group.pivot.key}`} tabId={tabId} entry={selected} name={selectedName} ordinal={group.ordinal} source={distinctName(group.table.entry, tab.sets)} stale={stale} running={running} refocus={refocusView} />}
      <FilterChips tabId={tabId} entry={selected} name={spokenName(selected)} sort={sort} refocus={refocusView} />
      <SaveView tabId={tabId} entry={selected} name={spokenName(selected)} />
    </div>}
    <div className="rt-panel" role="tabpanel" id={id + 'panel'} aria-labelledby={labelledBy}>
      {summaryActive
        ? <MultiRunSummary tabId={tabId} tab={tab} active onSelectTarget={targetKey => {
            const firstSet = tab.sets.find(entry => entry.descriptor.targetKey === targetKey && entry.descriptor.kind !== 'pivot')
            if (firstSet) select(firstSet.key)
          }} />
        : selected && <>
            <EntryNoticeBars tabId={tabId} tab={tab} entry={selected} running={running} />
            <ResultGrid key={setKey(selected.descriptor)} tabId={tabId} entry={selected} count={tab.numbered} focused budget={budget} sort={sort}
              view={group?.planSet ? 'plan' : selectedSlot?.view} group={group?.ordinal} onFocus={select} />
          </>}
    </div>
  </div>
}
