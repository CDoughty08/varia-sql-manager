import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { distinctName, entryName, entrySecondary, pivotOutOfDate, spokenName, setKey, transposedView, type EntryKey, type GridSort, type GridViewState, type ResultSetEntry, type TabResults } from '../results/ResultsService'
import { formatCount, plural, rowsFact } from '../results/status'
import { observeResize, windows } from '../core/windows'
import { gridLimits as g } from './constants'
import ResultGrid from './ResultGrid'
import { batchText, FilterChips, PivotMark, scrollbarSize, settledContent } from './ResultsStack'
import { minGridHeight } from './stack'
import { visibleColumnCount } from './hidden-columns'
import { groupView, pickerRequests, selectedEntry, selectedGroup, selectedItem, topItems } from './result-picker'
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

/** The room the Tabs layout needs before the Messages strip opens by itself: its two rows of tabs and the selected grid at
 *  its minimum height, or at its rows' height when its result has them all and needs less. No caption. */
export function tabsNeed(tab: Pick<TabResults, 'sets' | 'settled' | 'focused'> & Partial<Pick<TabResults, 'sorts'>>, grids?: ReadonlyMap<EntryKey, GridViewState>): number {
  const entry = selectedEntry(tab)
  if (!entry) return 0
  const turned = transposedView(grids?.get(entry.key), entry.descriptor) ? new Set([entry.key]) : undefined
  const content = settledContent({ sets: [entry], settled: tab.settled, ...tab.sorts ? { sorts: tab.sorts } : {} }, undefined, turned)[0]
  const minHeight = minGridHeight(scrollbarSize())
  return g.resultTabsHeight + g.viewTabsHeight + Math.min(minHeight, content ?? minHeight)
}

/**
 * How the Tabs layout folds its two rows of tabs in a short pane, so the grid keeps room for its header and two rows (the
 * results pane can be dragged to 100 px, and a window made smaller takes its room first): undefined, both rows; `one`, the
 * result tabs and the selected view's row side by side in one row, without the facts (the status line has them); `none`,
 * the grid alone, as Stacked's one set gives up its caption. Next Result, Go to Result N and Go to Result… still reach
 * every view then. Undefined before the layout has a height.
 */
export function tabsFold(height: number, scrollbar: number = scrollbarSize()): 'one' | 'none' | undefined {
  if (height <= 0) return undefined
  const need = g.headerHeight + 2 * g.rowHeight + Math.max(0, scrollbar) + g.stackBorder
  if (height - g.resultTabsHeight - g.viewTabsHeight >= need) return undefined
  return height - g.resultTabsHeight >= need ? 'one' : 'none'
}

/** The selected view's facts beside its view tabs: rows (counting while they stream) and columns, the batch it came from. */
const ViewFacts = memo(function ViewFacts({ entry, sort, totalBatches }: { entry: ResultSetEntry; sort?: GridSort; totalBatches: number }) {
  const snapshot = useSyncExternalStore(entry.handle.subscribe, entry.handle.getSnapshot)
  const columns = visibleColumnCount(entry.descriptor), number = entrySecondary(entry)
  // A named result's number leads its facts, as in its Stacked caption, so two tabs of one name are told apart on screen.
  const facts = [...number ? [number] : [], rowsFact(snapshot, sort), `${formatCount(columns)} ${plural(columns, 'column')}`]
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

/**
 * A run's results one at a time: a row of tabs for its groups ("Result 3") and comparisons, the selected group's view tabs
 * beneath (Table, and Pivot once one is built), and the one grid of the selected view. The selection is the service's
 * focused entry (`focusEntry`), so commands, the toolbar, the Pivot builder and Column Profile act on the view shown, and a
 * group's tab returns to the view it last showed. Only the selected grid is mounted; switching unmounts the other, whose
 * scroll, widths, selection, sort and filters stay in its grid state, and releases nothing. Find Next onto a match in
 * another view selects it first. Each tab closes its view (a group's closes its Table and Pivot) once the query has ended;
 * the focus then goes to the tab selected next, else to the Results tab. A bare run (Peek) is never drawn here. When the
 * tabs do not all fit, a button at the row's end counts those without a tab in view and opens the overflow picker, which
 * lists every view (Go to Result… opens it too); Next and Previous Result and their view commands move the selection.
 */
export default function ResultsTabs({ tabId, tab }: { tabId: string; tab: TabResults }) {
  const { results, resultsSearch, gestures } = useWorkbench()
  const search = useServiceSnapshot(resultsSearch)[tabId]
  const rootRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const sets = tab.sets, running = tab.status === 'running'
  const selected = selectedEntry(tab)
  const items = topItems(tab)
  const group = selectedGroup(tab)
  const at = Math.max(0, selectedItem(tab, items))
  const [first, last] = tabWindow(items.length, at)
  const shown = items.slice(first, last + 1)
  const select = useCallback((key: EntryKey) => results.focusEntry(tabId, key), [results, tabId])
  const tabIdOf = (key: EntryKey, row: 'result' | 'view') => `${id}${row}-${key}`

  // Closing a view: when the focus was in what closes (or nowhere), it goes to the tab selected next, in the row the closed
  // tab was in, once that tab is drawn; with nothing left, to the Results tab. Only once, in the first layout without it.
  const pendingFocus = useRef<{ readonly closed: EntryKey; readonly row: 'result' | 'view' } | undefined>(undefined)
  const resultsTab = () => rootRef.current?.closest('.output-panel')?.querySelector<HTMLElement>('[role="tab"][data-output-tab="results"]')
  const close = (key: EntryKey, row: 'result' | 'view', event: MouseEvent<HTMLButtonElement>) => {
    const root = rootRef.current, active = root?.ownerDocument.activeElement
    // What closes: a result's whole group (its Pivot's view tab too), or one view. The view row and the panel belong to the
    // selected view, so the focus there is in what closes when the selected view does.
    const gone = new Set(results.closing(tabId, key).map(entry => entry.key))
    const inSelected = !!selected && gone.has(selected.key) && !!active?.closest('.rt-views, .rt-panel')
    const own = !active || active === root?.ownerDocument.body || active === event.currentTarget
      || (!!root && root.contains(active) && (gone.has(active.closest('[data-tab-entry]')?.getAttribute('data-tab-entry') ?? '') || inSelected))
    const last = gone.size === results.getSnapshot()[tabId]?.sets.length
    if (own && last) resultsTab()?.focus({ preventScroll: true })
    if (results.removeEntry(tabId, key) && own && !last) pendingFocus.current = { closed: key, row }
  }
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending || sets.some(entry => entry.key === pending.closed)) return
    pendingFocus.current = undefined
    const root = rootRef.current, active = root?.ownerDocument.activeElement
    // The user has moved on meanwhile: the focus is theirs.
    if (active && active !== root?.ownerDocument.body && !root?.contains(active)) return
    const target = root?.querySelector<HTMLElement>(`[data-tab-row="${pending.row}"] [role="tab"][aria-selected="true"]`) ?? root?.querySelector<HTMLElement>('[data-tab-row="result"] [role="tab"][aria-selected="true"]') ?? resultsTab()
    target?.focus({ preventScroll: true })
  })

  // A switch while the grid had the focus (F3 onto another view's match, Close Just This Result, a Pivot shown as it is
  // built): the grid that held the focus unmounts, so the focus would fall to the page and the grid's keys with it. The
  // grid shown instead takes it, before its own effects run (a reveal selects the match only while a grid has the focus).
  // Close Just This Result first puts the focus on the Results tab, so that counts as the grid's too. A removed element
  // gets no blur, so the mark stays set until the focus moves to something else.
  const gridFocus = useRef(false)
  // The row of the tab that last had the focus, kept while the focus stays in the layout: a tab that unmounts (another
  // result's view tabs, a tab the drawn window leaves behind) drops the focus to the page with no blur of its own.
  const tabRow = useRef<string | undefined>(undefined)
  const trackFocus = (event: FocusEvent<HTMLDivElement>) => {
    const target = event.target as Element
    gridFocus.current = !!target.closest?.('[data-result-grid]')
    tabRow.current = target.matches?.('[role="tab"]') ? target.closest('[data-tab-row]')?.getAttribute('data-tab-row') ?? undefined : undefined
  }
  const trackBlur = (event: FocusEvent<HTMLDivElement>) => {
    const to = event.relatedTarget as Element | null
    if (to && !event.currentTarget.contains(to) && to !== resultsTab()) gridFocus.current = false
    if (to && !event.currentTarget.contains(to)) tabRow.current = undefined
  }
  // A command (Next Result, Next Result View) moving the selection while a tab has the focus: the focus follows to the
  // tab now selected in that row, as the arrow keys move it, once it is drawn; also when the tab that had it unmounted
  // (another result's view tabs, the drawn window moving), which left the focus on the page.
  useLayoutEffect(() => {
    const root = rootRef.current, doc = root?.ownerDocument, active = doc?.activeElement
    const lost = !active || active === doc?.body
    const row = active?.matches('[role="tab"][aria-selected="false"]') && root?.contains(active) ? active.closest('[data-tab-row]')?.getAttribute('data-tab-row') : lost ? tabRow.current : undefined
    const view = row === 'view' ? root?.querySelector<HTMLElement>('[data-tab-row="view"] [role="tab"][aria-selected="true"]') : undefined
    if (view) view.focus()
    else if (row) { focusTab.current = items[at]?.key; focusResultTab() }
  }, [selected?.key, first])
  useLayoutEffect(() => {
    const root = rootRef.current, active = root?.ownerDocument.activeElement
    if (!gridFocus.current || !root || (active && active !== root.ownerDocument.body && active !== resultsTab() && !root.contains(active))) return
    if (active && root.querySelector('.rt-panel')?.contains(active)) return
    root.querySelector<HTMLElement>('.rt-panel [data-result-grid]')?.focus({ preventScroll: true })
  }, [selected?.key])

  // Find Next onto a match in a view not shown selects that view (and its group's tab); the grid mounted for it then
  // reveals the match itself, as a grid the stack scrolls to does (ResultGrid).
  const revealSeq = search?.reveal ?? 0, revealEntry = search?.revealEntry
  useLayoutEffect(() => {
    if (revealEntry === undefined || revealEntry === selected?.key || !sets.some(entry => entry.key === revealEntry) || !resultsSearch.pendingReveal(tabId, revealEntry)) return
    select(revealEntry)
  }, [revealSeq, revealEntry])

  // A Pivot built for the selected group shows at once: Tabs draws one view, and the builder works on this group, so a
  // Pivot that stayed behind its Table's tab would be built out of sight. A rebuilt Pivot keeps its entry key and swaps in
  // a new result, so a build is told by the Pivot's result, not its key. (A rebuilt grid takes the focus its old one had in ResultGrid.)
  // While a comparison or a plan set is selected the builder works on a group it can pivot, so a Pivot built for any group
  // shows. Only a Pivot that appears while the layout is drawn: one there at mount, or another group's while a group that
  // can be pivoted is selected, selects nothing. Nor does one that arrives while a grid of the layout has the focus: the
  // Build button is in the builder, so the user went back to a grid while it was built, and PivotService leaves the focus
  // with them then too. (The focus itself, not the hand-off mark, which a trip through the Results tab can leave set.)
  const pivots = useRef<ReadonlyMap<number, string | undefined> | undefined>(undefined)
  useLayoutEffect(() => {
    const seen = pivots.current
    pivots.current = new Map(tab.groups.map(item => [item.ordinal, item.pivot && setKey(item.pivot.entry.descriptor)]))
    if (!seen) return
    // A Pivot that rebuilt by itself was shown when it started, and the user may have gone back to its Table since: it
    // selects nothing.
    const built = tab.groups.filter(item => item.pivot && !item.pivot.pivot?.followed && seen.has(item.ordinal) && seen.get(item.ordinal) !== setKey(item.pivot.entry.descriptor))
    const shown = group && !group.planSet ? built.find(item => item === group) : built[0]
    const root = rootRef.current, active = root?.ownerDocument.activeElement
    if (!shown?.pivot || (active && root?.contains(active) && active.closest('[data-result-grid]'))) return
    if (selected?.key !== shown.pivot.key) select(shown.pivot.key)
  }, [tab.groups])
  // A comparison made while the layout is drawn shows at once too, for the same reason: it is the last tab of the row,
  // often past the strip's edge. One there at mount selects nothing.
  const comparisons = useRef<ReadonlySet<EntryKey> | undefined>(undefined)
  useLayoutEffect(() => {
    const seen = comparisons.current
    comparisons.current = new Set(tab.comparisons.map(slot => slot.key))
    const made = seen && tab.comparisons.findLast(slot => !seen.has(slot.key))
    if (made && selected?.key !== made.key) select(made.key)
  }, [tab.comparisons])

  // The arrow keys, Home and End move over every result, not only the drawn window; the tab they reach may be drawn only
  // once the window has moved, so it takes the focus after that render.
  const focusTab = useRef<EntryKey | undefined>(undefined)
  const resultKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // Only on a tab: the overflow button beside them keeps its own keys.
    if (!(event.target as Element).matches('[role="tab"]')) return
    const next = tabKey(event, at, items.length)
    if (next < 0) return
    event.preventDefault()
    const item = items[next]
    focusTab.current = item.key
    select(item.group ? groupView(item.group) : item.key)
    focusResultTab()
  }
  const focusResultTab = () => {
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
  // Fewer tabs fit than the window draws: the strip scrolls (the wheel scrolls it sideways) and fades an edge that hides
  // tabs. It brings the selected tab into view, clear of the fade, when the selection or the window moves and when the
  // strip is resized, not on every render (OutputPane draws often), so a strip the user scrolled stays where they left it.
  // Each time it marks its edges it counts the items without a tab in view, for the overflow button.
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
  useLayoutEffect(() => { measureStrip(true) }, [group?.table.key ?? selected?.key, first, !selected])
  useLayoutEffect(() => { measureStrip(false) }, [items.length, last, !selected])
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const observer = observeResize(strip, () => measureStrip(true))
    return () => observer.dispose()
  }, [!selected])

  // A short pane folds the rows of tabs (`tabsFold`); a tab that had the focus when its row went gives it to the grid.
  const [fold, setFold] = useState<ReturnType<typeof tabsFold>>(undefined)
  const foldRef = useRef(fold)
  foldRef.current = fold
  // Measured before the first paint too: each run draws a new layout, which would show both rows for a frame, then fold.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    setFold(tabsFold(root.clientHeight))
    const observer = observeResize(root, () => setFold(tabsFold(root.clientHeight)))
    return () => observer.dispose()
  }, [!selected])
  useLayoutEffect(() => {
    const root = rootRef.current, active = root?.ownerDocument.activeElement
    if (fold !== 'none' || !root || !active || ![...root.querySelectorAll('.rt-results, .rt-views')].some(row => row.contains(active))) return
    root.querySelector<HTMLElement>('.rt-panel [data-result-grid]')?.focus({ preventScroll: true })
  }, [fold])

  // The overflow picker: from the button, or Go to Result… (a request made before this layout was drawn waits for it).
  const [picking, setPicking] = useState(false)
  const pickerFrom = useRef<HTMLElement | undefined>(undefined)
  useEffect(() => {
    // Opened by a request (Go to Result…), Escape gives the focus back to where it was, the editor or a grid.
    // Asked again while it is open (the focus is in it), it keeps where it was opened from.
    // Read in the window the user is in, which may not be this layout's (the pane popped out, the editor in the main one).
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
  // With no rows of tabs (a very short pane) the picker is placed under the top of the layout.
  const pickerAnchor = () => foldRef.current === 'none' ? rootRef.current : overflowRef.current ?? rootRef.current?.querySelector<HTMLElement>('.rt-results')
  const closePicker = (restore: boolean) => {
    setPicking(false)
    const from = pickerFrom.current
    pickerFrom.current = undefined
    if (!restore) return
    if (from?.isConnected && from !== from.ownerDocument.body) {
      // In another window (the editor, with the pane popped out): that window comes forward first.
      if (from.ownerDocument !== rootRef.current?.ownerDocument) from.ownerDocument.defaultView?.focus()
      from.focus({ preventScroll: true })
    }
    // Where it was opened from may be hidden now (the pane folded while it was open): then as if it had gone.
    if (from && from.ownerDocument.activeElement === from) return
    if (foldRef.current === 'none') panelGrid()?.focus({ preventScroll: true })
    else (overflowRef.current ?? rootRef.current?.querySelector<HTMLElement>('[data-tab-row="result"] [role="tab"][aria-selected="true"]'))?.focus()
  }
  // With no rows of tabs drawn (the shortest pane), the grid shown takes the focus in a tab's place.
  const panelGrid = () => rootRef.current?.querySelector<HTMLElement>('.rt-panel [data-result-grid]')
  // A view picked: shown, and the focus goes to its result's tab once the window drawn has moved to it.
  const pick = (key: EntryKey) => {
    setPicking(false)
    if (foldRef.current === 'none') {
      // The grid of the view picked takes the focus: at once when it is the one shown, else once it is drawn.
      if (key === selected?.key) panelGrid()?.focus({ preventScroll: true })
      else { gridFocus.current = true; select(key) }
      return
    }
    select(key)
    const item = topItems(results.getSnapshot()[tabId] ?? tab).find(top => top.key === key || top.group?.pivot?.key === key)
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
  if (!selected) return null
  const selectedSlot = group ? (group.pivot?.key === selected.key ? group.pivot : group.table) : tab.comparisons.find(slot => slot.key === selected.key)
  const selectedName = entryName(selected), sort = tab.sorts.get(selected.key)
  // The selected group's Pivot is out of date: a dot on its view tab, and its mark with Update while it is shown.
  const stale = !!group && pivotOutOfDate(tab, group)
  const labelledBy = group ? tabIdOf(selected.key, 'view') : tabIdOf(selected.key, 'result')
  return <div ref={rootRef} className="rt-root" data-fold={fold} onFocus={trackFocus} onBlur={trackBlur}>
    <div className="rt-results" data-tab-row="result" onKeyDown={resultKey}>
      <div className="rt-strip" ref={stripRef} role="tablist" aria-label="Results and comparisons" onScroll={() => measureStrip(false)} onWheel={wheel}>
      {shown.map((item, place) => {
        const on = item === items[at], others = item.group?.pivot ? ' and its Pivot' : ''
        const batch = item.group ? batchText(item.group.batchNumber, item.group.iteration, tab.totalBatches) : ''
        // A named result's tooltip has its whole name (the tab may cut it short) and its number; a named comparison's, its name.
        const tip = [item.number ? `${item.name} · ${item.number}` : item.named ? item.name : '', batch].filter(Boolean).join(' · ')
        // A named result's accessible name carries its number too, so a screen reader tells two of one name apart.
        const spoken = item.number ? `${item.name}, ${item.number}` : item.name
        return <div key={item.key} className="rt-tab" data-tab-entry={item.key} data-selected={on || undefined} data-named={item.named || undefined}>
          <button type="button" role="tab" id={tabIdOf(item.key, 'result')} aria-selected={on} tabIndex={on ? 0 : -1} title={tip || undefined} {...item.number ? { 'aria-label': spoken } : {}}
            aria-setsize={items.length} aria-posinset={first + place + 1} {...on ? { 'aria-controls': id + 'panel' } : {}} onClick={() => select(item.group ? groupView(item.group) : item.key)}>
            {item.group?.planSet && <Icon name="execution-plan" />}{item.comparison && <Icon name="git-compare" />}<span className="rt-name">{item.name}</span>
          </button>
          {!tab.bare && <button type="button" className="icon-button rt-close" tabIndex={-1} aria-label={`Close ${spoken}`} title={closeTitle(spoken, others)} disabled={running}
            onClick={event => close(item.key, 'result', event)}><Icon name="close" /></button>}
        </div>
      })}
      </div>
      {hidden > 0 && <button ref={overflowRef} type="button" className="rt-overflow" aria-haspopup="dialog" aria-expanded={picking}
        aria-label={`All results, views and comparisons; ${formatCount(hidden)} not shown as tabs`} title="All results, views and comparisons (Go to Result…)"
        onClick={() => { pickerFrom.current = undefined; setPicking(open => !open) }}>+{formatCount(hidden)}<Icon name="chevron-down" /></button>}
      {picking && <ResultsPicker tab={tab} anchor={pickerAnchor} selected={selected?.key} onPick={pick} onClose={closePicker} />}
    </div>
    <div className="rt-views">
      {group ? <div className="rt-view-tabs" role="tablist" aria-label={`Views of ${distinctName(group.table.entry, tab.sets)}`} data-tab-row="view" onKeyDown={viewKey}>
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
      <ViewFacts key={selected.key} entry={selected} sort={sort} totalBatches={tab.totalBatches} />
      {group?.pivot && selected.key === group.pivot.key && !tab.bare && <PivotMark key={`mark:${group.pivot.key}`} tabId={tabId} entry={selected} name={selectedName} ordinal={group.ordinal} source={distinctName(group.table.entry, tab.sets)} stale={stale} running={running} refocus={refocusView} />}
      <FilterChips tabId={tabId} entry={selected} name={spokenName(selected)} sort={sort} refocus={refocusView} />
      <SaveView tabId={tabId} entry={selected} name={spokenName(selected)} />
    </div>
    <div className="rt-panel" role="tabpanel" id={id + 'panel'} aria-labelledby={labelledBy}>
      {/* Keyed by result: another view is another grid, and the one it replaces unmounts and gives back its pool; so is a
          rebuilt Pivot, which keeps its entry key but is drawn over its new result. */}
      <ResultGrid key={setKey(selected.descriptor)} tabId={tabId} entry={selected} count={tab.numbered} focused budget={tab.summary?.budget} sort={sort}
        view={group?.planSet ? 'plan' : selectedSlot?.view} group={group?.ordinal} onFocus={select} />
    </div>
  </div>
}
