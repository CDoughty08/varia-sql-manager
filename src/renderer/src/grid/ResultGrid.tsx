import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { commandDescriptor } from '../../../shared/commands/catalog'
import type { QueryResult } from '../../../shared/contracts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { useKeybindingLabel } from '../core/useCommand'
import { withKey } from '../query-context'
import type { ResultHandle } from '../results/ResultClient'
import { capStripText, entryName, entryNumber, filteredColumns, groupOf, pivotOutOfDate, queryName, setKey, slotOf, type EntryKey, type GridSort, type ResultSetEntry } from '../results/ResultsService'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { resultsFilterSource } from '../results/ColumnFilterPopover'
import { remoteHeader } from '../results/remote-views'
import { compareDetails, compareSources, compareText, type CompareInfo } from '../results/CompareService'
import { highlightText } from '../results/HighlightsService'
import ComparisonToolbar from '../results/ComparisonToolbar'
import { pivotStrip } from '../results/pivot'
import { formatBytes, formatCount } from '../results/status'
import GridShell, { GridErrorBoundary, instanceKey, type GridFunnels, type GridShellApi, type GridShellBusy, type GridSpec, type StripLead } from './GridShell'
import { gridOperation, operationNoun } from '../results/operations'
import type { GridView } from './GridView'
import { describeSelection } from './selection'
import { diffKeyFlags, type DiffSides } from './diff-gutter'
import { visibleColumnCount } from './hidden-columns'

/** The name a grid's accessible label starts with for a Pivot or a comparison: its own ("Differences: Result 1 → Result 3"),
 *  never "Result N of M" by the number Varia gave it (D8). Undefined for an original result, which keeps "Result N of M". */
export const derivedGridName = (entry: Pick<ResultSetEntry, 'label' | 'number' | 'descriptor'>): string | undefined =>
  entry.descriptor.kind === 'diff' || entry.descriptor.kind === 'pivot' ? entryName(entry) : undefined

export interface ResultGridProps {
  readonly tabId: string
  readonly entry: ResultSetEntry
  /** Result sets in the run, for the grid's name ("Result 2 of 3": the entry's number, of this many). */
  readonly count: number
  /** The grid F6 and the Query Output pane focus first: the one that last had focus. */
  readonly focused: boolean
  readonly budget?: QueryResult['budget']
  /** What the grid shows of its group, for menus and scripts (`data-result-view`): a Table, a Pivot, a comparison, a plan
   *  set; and the group's ordinal (`data-result-group`), which a comparison lacks. */
  readonly view?: 'table' | 'pivot' | 'comparison' | 'plan'
  readonly group?: number
  /** A bare stack's grid (Peek): Pivot, Compare and close are off for it (`data-result-bare`). */
  readonly bare?: boolean
  /** The grid's sort, while it has one: the grid shows its view once it is built. */
  readonly sort?: GridSort
  onFocus(key: EntryKey): void
  /** Whether the set's columns are wider than its grid (it needs a horizontal scroll bar), for sizing the stack to its rows. */
  onWide?(key: EntryKey, wide: boolean): void
}

/** What a comparison's gutter calls its inputs (the names they were compared under) and the larger one's row count. */
export function diffSidesOf(info: Pick<CompareInfo, 'left' | 'right' | 'leftNumber' | 'rightNumber' | 'leftName' | 'rightName' | 'inputRows'>, sets: readonly Pick<ResultSetEntry, 'key' | 'handle'>[]): DiffSides {
  // Frozen when compared, so closing an input leaves the numbers room; the open inputs answer for an older comparison.
  const rows = (key: EntryKey) => sets.find(set => set.key === key)?.handle.getSnapshot().rowsStored ?? 0
  return { old: info.leftName ?? entryNumber({ number: info.leftNumber }), new: info.rightName ?? entryNumber({ number: info.rightNumber }), rows: Math.max(info.inputRows ?? 0, rows(info.left), rows(info.right)) }
}

const lostText = 'These results are no longer available because the SQL backend restarted.'
const incompleteText = 'This result is incomplete because an error, cancellation, or timeout stopped it. See Messages.'
export const windowedText = 'This result is windowed in BigQuery: rows are read as you scroll. Load it into memory to sort, filter, search or pivot it.'
/** A windowed result too large for the result memory free now: Load into memory is not offered until there is room. */
export const windowedFullText = 'This result is windowed in BigQuery: rows are read as you scroll. It is too large to load into the result memory free now; close other results to make room.'
/** What a windowed result's strip offers about loading: Stop while a load runs, Load into memory only beside the note
 *  that the result is windowed (not beside a truncation, a highlight count or a Stop query), else nothing. */
export function loadOffer(o: { loading: string; loadable: boolean; other: string | undefined; stopping: boolean }): 'stop' | 'load' | undefined {
  if (o.loading === 'loading') return 'stop'
  return o.loadable && !o.stopping && o.other === windowedText ? 'load' : undefined
}
/** A load into memory's strip: how many rows it has read of how many, or that it is stopping. */
export function loadingText(loading: string, snapshot: { rowsAvailable: number; rowsExpected?: number; rowsTotal?: number; residence?: string }): string | undefined {
  if (!loading) return undefined
  if (loading === 'stopping') return 'Stopping the load: the result stays windowed in BigQuery.'
  // Until the result switches (and once it has switched back, refused), its rows are not the load's to count.
  if (snapshot.residence !== 'memory') return 'Loading into memory…'
  const total = snapshot.rowsExpected ?? snapshot.rowsTotal
  return total ? `Loading into memory: ${formatCount(snapshot.rowsAvailable)} of ${formatCount(total)} rows.` : `Loading into memory: ${formatCount(snapshot.rowsAvailable)} rows.`
}

/** Why the grid shows fewer rows than the query read, if it does (B8 strips). */
export function truncationText(o: { truncated?: string; rowsStored: number; rowsRead: number; budget?: QueryResult['budget']; residence?: string; rowsAvailable?: number }): string | undefined {
  // A windowed BigQuery result keeps no rows here: what it can show is what the grid can read, capped by the rows-kept limit
  // or, past that, by 32-bit row indexes.
  const remote = o.residence === 'remote'
  if (remote && !o.truncated) return undefined
  if (remote && (o.rowsAvailable ?? 0) >= 2_147_483_647) return `Only the first ${formatCount(o.rowsAvailable ?? 0)} of ${formatCount(o.rowsRead)} rows can be shown: a grid reads at most ${formatCount(2_147_483_647)} rows of a result windowed in BigQuery.`
  const shown = `Only the first ${formatCount(remote ? o.rowsAvailable ?? 0 : o.rowsStored)} of ${formatCount(o.rowsRead)} rows are shown`
  if (o.truncated === 'systemMemory') return `${shown} because the computer is low on memory. Execution continued.`
  if (o.truncated === 'queryBudget' || o.truncated === 'globalBudget') {
    // The figure the query stopped at when it did, not today's: the limit can change while the backend runs.
    const bytes = o.budget?.stoppedBytes ?? (o.truncated === 'queryBudget' ? o.budget?.queryBytes : o.budget?.globalBytes)
    return `${shown}: the result memory budget${bytes ? ` (${formatBytes(bytes)})` : ''} is full. Execution continued; close other results to free memory.`
  }
  if (o.truncated === 'rowLimit') return `${shown}: the limit on rows kept per execution was reached (Tools › Options › Query Results › SQL Server › Results to Grid). Execution continued.`
  return undefined
}

/** Whether a truncation strip offers Stop query while the query runs. Past the result budget or low memory the rest of the run
 *  only reads and counts rows nobody asked to lose, so stopping is the way out; the row limit is the user's own cap (off by
 *  default), reached as they asked, so its strip only says so and the toolbar's Cancel stays where it always is. */
export const stopsQuery = (truncated: string | undefined) => truncated === 'queryBudget' || truncated === 'globalBudget' || truncated === 'systemMemory'

/** The sort's keys and filters as a string: a new order or other rows put the grid back at its first row; the same view
 *  built again (once every row is in) keeps its place. */
const keysOf = (sort: GridSort | undefined) => (sort?.keys.map(key => `${key.column}${key.descending ? 'd' : 'a'}`).join(',') ?? '') + '|' + JSON.stringify(sort?.filters.map(item => item.filter) ?? [])

/**
 * A query's result set in the results grid (GridShell): the set's handle and its sorted views, ResultsService's sort and
 * filters for the header, and the strips (truncation, highlights, compare, pivot, the transposed cap). A live view mounts the same
 * shell with its own source (LiveGridPane).
 */
function ResultGridBody({ tabId, entry, count, focused, budget, sort, view, group, bare, onFocus, onWide }: ResultGridProps) {
  const { results, commands, gridStats, panes, settings, resultsSearch, highlights, compare, pivot, queries, resultVisibility, documents, resultMemory } = useWorkbench()
  // The query still running that made the rows shown: an estimate runs without results, and a finished run's results stay
  // drawn until its tab's state catches up, so the tab's run must be this result's run and still running.
  const runningId = useSyncExternalStore(queries.subscribe, () => queries.getSnapshot()[tabId]?.running?.queryId)
  const resultsRun = useSyncExternalStore(results.subscribe, () => { const run = results.getSnapshot()[tabId]; return run?.status === 'running' ? run.queryId : undefined })
  const running = runningId !== undefined && runningId === resultsRun
  const cancelKey = useKeybindingLabel('query.cancel')
  const executeKey = useKeybindingLabel('query.execute')
  const marked = useSyncExternalStore(highlights.subscribe, () => highlights.getSnapshot()[tabId]?.get(entry.key))
  const compared = useSyncExternalStore(compare.subscribe, () => compare.getSnapshot().info.get(setKey(entry.descriptor)))
  // A comparison's inputs, each the entry its link goes to while that exact result is open (else it reads closed), as a
  // string so the grid renders again only when one closes.
  const sourceKeys = useSyncExternalStore(results.subscribe, () => {
    if (!compared) return ''
    const tab = results.getSnapshot()[tabId]
    return compareSources(tab, slotOf(tab, entry.key)?.sources ?? []).map(source => source.entry ?? '').join('|')
  })
  const pivoted = useSyncExternalStore(pivot.subscribe, () => pivot.getSnapshot().info.get(setKey(entry.descriptor)))
  // A group's Pivot whose Table's filters changed since it was built says so first in its strip.
  const outOfDate = useSyncExternalStore(results.subscribe, () => {
    if (!pivoted) return false
    const tab = results.getSnapshot()[tabId], group = groupOf(tab, entry.key)
    return !!tab && group?.pivot?.key === entry.key && pivotOutOfDate(tab, group)
  })
  const values = useServiceSnapshot(settings).values
  const showTypes = values['queryResults.grid.showColumnTypes'], rowSize = values['queryResults.grid.rowSize']
  const viewRef = useRef<GridView | undefined>(undefined), apiRef = useRef<GridShellApi | undefined>(undefined)
  // The operation over this grid's result, from the one busy state every result control reads.
  const operation = useSyncExternalStore(results.operations.subscribe, () => gridOperation(results.operations.getSnapshot()[tabId]?.items, entry.key))
  const busy = useMemo((): GridShellBusy | undefined => operation && {
    shown: operation.shown, held: !operation.ending && (operation.kind === 'sort' || operation.kind === 'filter'), label: `${operationNoun(operation.kind)} ${operation.target}`,
    ...operation.kind === 'sort' || operation.kind === 'filter' ? operation.column === undefined ? {} : { column: operation.column } : {}, ...operation.percent === undefined ? {} : { percent: operation.percent }
  }, [operation])
  const snapshot = useSyncExternalStore(entry.handle.subscribe, entry.handle.getSnapshot)
  // Search in results: this grid's marks, and the tab's reveal of the active match.
  const search = useServiceSnapshot(resultsSearch)[tabId]
  const marks = search?.marks.get(entry.key)
  // Bumped by each swap, so a reveal waiting for the sorted rows runs once they show.
  const [swaps, setSwaps] = useState(0)
  const filtered = useMemo(() => filteredColumns(sort), [sort])
  const key = entry.key
  // The view's orientation is part of its grid state, so it follows the entry and outlives the grid. The transpose commands
  // set it (ResultsService.setOrientation, which publishes); a change builds the grid again, as a tab switch does. A
  // comparison is never drawn transposed (transposedView, the rule Copy and Save follow too). Read as a string, so the grid renders again only
  // when its own orientation changed.
  const oriented = useSyncExternalStore(results.subscribe, () => { const now = results.orientation(tabId, key); return now.transposed ? `t${now.headerColumn ?? ''}` : '' })
  const turnedView = oriented !== '', headerColumn = turnedView && oriented.length > 1 ? Number(oriented.slice(1)) : undefined
  const latest = useRef({ count, onWide, sort, marks, showTypes, rowSize, turnedView, headerColumn })
  latest.current = { count, onWide, sort, marks, showTypes, rowSize, turnedView, headerColumn }
  /** The handle the view shows, and the keys it was sorted by. */
  const shownRef = useRef<{ handle: ResultHandle; keys: string }>({ handle: entry.handle, keys: '' })
  const mount = (create: (spec: GridSpec) => GridView) => {
    const now = latest.current
    // A grid mounted again (a tab switch) shows its sorted view from the start: the results' own, which may be a frame ahead
    // of the published sort this render has (the view that sort names may already be closed).
    const current = results.sortOf(tabId, key), sorted = current?.view
    shownRef.current = { handle: sorted ?? entry.handle, keys: sorted ? keysOf(current) : '' }
    results.viewShown(tabId, key, sorted)
    const label = derivedGridName(entry)
    const view = create({
      handle: shownRef.current.handle, descriptor: entry.descriptor, state: results.gridState(tabId, key),
      entry: key, resultNumber: entry.number, ...queryName(entry) ? { resultName: queryName(entry) } : {}, ...label ? { label } : {}, resultCount: now.count, stats: gridStats, showTypes: now.showTypes, rowSize: now.rowSize,
      ...now.turnedView ? { transposed: true, ...now.headerColumn === undefined ? {} : { headerColumn: now.headerColumn } } : {},
      ...compared ? { diffSides: diffSidesOf(compared, results.getSnapshot()[tabId]?.sets ?? []), diffChanged: compared.columnChanges.map(column => column.changed > 0), diffKeys: diffKeyFlags(compared.match, entry.descriptor.columns.slice(0, visibleColumnCount(entry.descriptor)).map(column => column.name)) } : {},
      onSelection: selection => {
        const current = entry.handle.getSnapshot()
        results.announceSelection(tabId, describeSelection(selection, current.rowsAvailable, visibleColumnCount(entry.descriptor)))
        results.selectionChanged()
      },
      onFirstCell: () => results.selectionChanged(),
      // Edit › Copy's copy event; Ctrl+C and Ctrl+A are the catalogue's output.copy and output.selectAll.
      onCopy: () => { void commands.execute('output.copy', undefined, 'keybinding') },
      onEscape: () => results.cancelTabJob(tabId),
      onWide: wide => latest.current.onWide?.(key, wide),
      onOpenValue: (row, column) => { void commands.execute('output.openValue', { tabId, cell: { entry: key, row, column } }, 'keybinding') },
      // Find Next onto a match in a row the transposed grid does not draw: the toolbar says so.
      onBeyondCap: row => results.beyondCap(tabId, row),
      // A comparison's active row and its tone: whether Go to Possible Match is offered (comparisonRowHasPartner).
      ...compared ? { onDiffRow: (row: number, tone: string | null) => compare.activeRow(tabId, key, setKey(entry.descriptor), row, tone) } : {}
    })
    viewRef.current = view
    view.setMarks(now.marks)
    const registration = results.registerGrid(tabId, key, {
      selectAll: () => view.selectAll(), repaint: () => view.repaint(), fitColumn: column => view.fitColumn(column),
      fitDrawn: row => { if (row === undefined) view.fitNames(); else view.fitRow(row) },
      filterColumn: column => apiRef.current?.openFunnel(column),
      selectColumn: column => view.selectColumn(column),
      // Previous and Next Difference and Go to Possible Match move in what the grid shows: its view's positions, once swapped.
      ...entry.descriptor.kind === 'diff' && !now.turnedView ? { diff: { active: () => view.diffActive(), handle: () => shownRef.current.handle, land: (row, first, settle, focus) => view.landDiff(row, first, settle, focus), tone: row => view.diffTone(row), toneWhenRead: (row, signal) => view.toneWhenRead(row, signal) } } : {}
    })
    // Closing and opening the pane within one frame moves the grid without resizing it, and the move drops the scroller's
    // offsets: the frame this asks for writes them back (GridView's offsetsDropped), and a press before it keeps them.
    const unsubscribe = panes.subscribe(() => view.panesChanged())
    // The backend learns which results are shown in any window (results.visibility) while the grid lives.
    const shown = resultVisibility.track({ generation: entry.descriptor.generation, resultId: entry.descriptor.resultId }, view.root)
    return () => {
      shown.dispose()
      unsubscribe()
      registration.dispose()
      view.dispose()
      if (viewRef.current === view) viewRef.current = undefined
    }
  }
  // The grid draws the highlighted rows of the handle it shows, and switches with its swaps.
  const highlightRows = marked?.rows
  // A grid built again for another orientation takes them again: this runs after the shell has built it.
  useLayoutEffect(() => { viewRef.current?.setHighlights(highlightRows ?? []) }, [highlightRows, tabId, entry, turnedView])
  // The active match scrolls into view once, in the grid that holds it: at once, or when this grid mounts (the stack
  // scrolled to it) or has swapped to the order the matches number.
  const reveal = search?.reveal ?? 0, revealSelect = search?.revealSelect ?? false
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.setMarks(marks)
    if (resultsSearch.pendingReveal(tabId, key) && view.revealMark(revealSelect)) resultsSearch.revealed(tabId)
  }, [marks, reveal, revealSelect, swaps, resultsSearch, tabId, key, turnedView])
  // A built view replaces what the grid shows: its first rows are read before the swap, so it paints whole rows at once,
  // unless what it shows is already gone (its result released or lost). While a first sort runs the grid keeps the rows in
  // their order; the views it showed close once it has swapped (ResultsService.viewShown).
  // Read from the results, not the published sort, for the same reason as mount's.
  const live = results.sortOf(tabId, key)
  const target = live?.view ?? (live ? undefined : entry.handle)
  useEffect(() => {
    const view = viewRef.current, shown = shownRef.current
    if (!view || !target || target === shown.handle) return
    const keys = target === entry.handle ? '' : keysOf(results.sortOf(tabId, key)), top = keys !== shown.keys ? 0 : undefined
    const abort = new AbortController()
    const swap = () => {
      if (abort.signal.aborted || viewRef.current !== view) return
      shownRef.current = { handle: target, keys }
      view.swap(target, entry.descriptor, row => row, top === undefined ? {} : { top })
      setSwaps(value => value + 1)
      // The views it showed before can close now.
      results.viewShown(tabId, key, target === entry.handle ? undefined : target)
    }
    const state = shown.handle.getSnapshot().state
    if (state === 'released' || state === 'lost') swap()
    else void view.prepare(target, 0, abort.signal).then(swap)
    return () => abort.abort()
  }, [target, entry])
  // Changes only draws its hidden runs of unchanged rows only over the comparison's own rows in their own order: a sort or
  // filter (a kind chip included) moves or drops the rows the runs sit between.
  useEffect(() => {
    if (!compared) return
    const shown = shownRef.current.handle === entry.handle && !sort?.keys.length && !sort?.filters.length
    viewRef.current?.setDiffGaps({ shown, trailing: compared.trailingHidden })
    // The overview strip maps the comparison's stored rows, so it shows only over them in their own order, as the rules do.
    viewRef.current?.setOverview({ buckets: compared.overview, shown })
  }, [compared, sort, target, swaps, tabId, entry, turnedView])
  const source = useMemo(() => resultsFilterSource(results, tabId, key), [results, tabId, key])
  // A windowed BigQuery result sorts and filters in BigQuery: its tooltips say so, and columns BigQuery cannot order have
  // no funnel and a sort button that says why.
  const windowed = snapshot.residence === 'remote'
  const header = useMemo(() => windowed ? remoteHeader(entry.descriptor.columns) : undefined, [windowed, entry])
  const funnels = useMemo<GridFunnels>(() => ({ source, filtered, ...header ?? {}, columnName: column => entry.descriptor.columns[column]?.name }), [source, filtered, header, entry])
  const onApi = useCallback((api: GridShellApi | undefined) => { apiRef.current = api }, [])
  const setRootEl = useCallback((element: HTMLDivElement | null) => { rootEl.current = element }, [])
  const lost = snapshot.state === 'lost'
  const truncation = truncationText({ ...snapshot, budget })
  const sources = useMemo(() => { const tab = results.getSnapshot()[tabId]; return compared ? compareSources(tab, slotOf(tab, entry.key)?.sources ?? []) : undefined }, [compared, sourceKeys, results, tabId, entry])
  // A comparison's strip says what it found, with what its highlights say after it; its notices are under its toolbar.
  const compareNote = compared ? [compareText(compared, sources), highlightText(marked, { comparison: true })].filter(Boolean).join(' ') : undefined
  const highlightNote = !lost && snapshot.state === 'complete' ? compareNote ?? (pivoted ? pivotStrip(pivoted, highlightText(marked), outOfDate) : highlightText(marked)) : undefined
  // Transposed, the first rows of the view (the sorted and filtered one, when the grid shows one) are drawn as columns:
  // past them the strip says so first, since no scrolling reaches the rest.
  const shownRows = useSyncExternalStore((target ?? entry.handle).subscribe, () => (target ?? entry.handle).getSnapshot().rowsAvailable)
  const cap = turnedView && !lost && shownRows > wire.transpose.maxRows ? capStripText(shownRows, entry.descriptor.kind === 'pivot', snapshot.residence === 'remote') : undefined
  // A windowed result loading into memory says how far it has got, with Stop; a finished one offers to load (and when it
  // has nothing else to say, says it is windowed).
  const loading = useSyncExternalStore(results.subscribe, () => { const load = results.getSnapshot()[tabId]?.loads?.get(key); return load ? load.stopping ? 'stopping' : 'loading' : '' })
  // Load into memory is offered while the projection fits the result memory free, so it follows memory's reports too.
  const loadSubscribe = useCallback((listener: () => void) => {
    const unsubscribe = results.subscribe(listener), memory = resultMemory?.subscribe(listener)
    return () => { unsubscribe(); memory?.() }
  }, [results, resultMemory])
  const loadable = useSyncExternalStore(loadSubscribe, () => results.canLoadIntoMemory(tabId, key))
  const needsRoom = useSyncExternalStore(loadSubscribe, () => results.loadNeedsRoom(tabId, key))
  // Re-run is Execute, which runs the active query tab: a grid shown for another (a popped-out pane) does not offer it.
  const activeTab = useSyncExternalStore(documents.subscribe, () => documents.getSnapshot().activeId === tabId)
  const loadNote = lost ? undefined : loadingText(loading, snapshot)
  const other = lost ? undefined : loadNote ?? (snapshot.incomplete ? incompleteText : truncation ?? highlightNote ?? (loadable ? windowedText : needsRoom ? windowedFullText : undefined))
  const note = cap && other ? `${cap} ${other}` : cap ?? other
  // A comparison's strip starts with links to its inputs: one goes to that grid (focused, so the stack scrolls to it).
  const rootEl = useRef<HTMLDivElement | null>(null), hadFocus = useRef(false)
  useLayoutEffect(() => {
    const element = rootEl.current, owner = element?.ownerDocument
    if (!element || !owner) return
    const active = owner.activeElement
    if (handoff?.owner === owner && handoff.tabId === tabId && handoff.key === key && (!active || active === owner.body)) element.focus({ preventScroll: true })
    return () => {
      // A removed element gets no blur, so the focus it had is read before it goes, or from the last focus it saw.
      if (!hadFocus.current && !element.contains(owner.activeElement)) return
      const mark = { owner, tabId, key }
      handoff = mark
      queueMicrotask(() => { if (handoff === mark) handoff = undefined })
    }
  }, [tabId, key])
  const goTo = useCallback((target: EntryKey) => {
    results.focusEntry(tabId, target)
    focusResultGrid(rootEl.current?.ownerDocument, tabId, target)
  }, [results, tabId])
  const lead: StripLead | undefined = compared && sources?.length === 2 && note === compareNote
    ? { links: sources.map(source => source.entry === undefined ? { label: source.name, closed: true, title: `${source.name} was closed after it was compared` } : { label: source.name, title: `Go to ${source.name}`, run: () => goTo(source.entry!) }), detail: [compareDetails(compared), highlightText(marked, { comparison: true })].filter(Boolean).join(' ') }
    : undefined
  // While the query that filled the budget still runs, the strip can stop it: the catalogue's Cancel Executing Query, for this
  // grid's tab, whose running state stands in for the active tab's in the command's precondition.
  const stop = running && other !== undefined && other === truncation && stopsQuery(snapshot.truncated)
    ? { label: 'Stop query', icon: commandDescriptor('query.cancel').icon, title: withKey(commandDescriptor('query.cancel').title, cancelKey), keys: cancelKey?.aria,
      run: () => void commands.execute('query.cancel', { tabId, state: { queryRunning: running } }, 'toolbar') }
    : undefined
  const offer = loadOffer({ loading, loadable, other, stopping: !!stop })
  const load = offer === 'stop' ? { label: 'Stop', icon: commandDescriptor('query.cancel').icon, title: 'Stop loading: the result stays windowed in BigQuery', run: () => results.stopLoad(tabId, key) }
    : offer === 'load' ? { label: 'Load into memory', icon: commandDescriptor('output.loadIntoMemory').icon, title: 'Read every row of this result into result memory, so it can be sorted, filtered, searched and pivoted',
      run: () => void results.loadIntoMemory(tabId, key).then(refused => { if (refused) results.announce(tabId, refused) }) }
    : undefined
  const action = stop ?? load
  // An expired windowed result offers Re-run: Execute for its tab, which estimates the query and asks as any run does.
  const rerun = snapshot.residence === 'remote' && !bare && activeTab ? { label: 'Re-run…', icon: commandDescriptor('query.execute').icon, title: withKey('Run the query again: Execute estimates what it processes first', executeKey), keys: executeKey?.aria,
    run: () => { if (documents.getSnapshot().activeId === tabId) void commands.execute('query.execute', undefined, 'toolbar') } } : undefined
  const quiet = loadNote !== undefined && other === loadNote
  // The entry's key names the grid for commands and menus; the generation and result id say which stored result it showed
  // when a target was read from it, so a target read before a re-run is told from the new one.
  return <GridShell mountKey={`${tabId}|${key}|${instanceKey(entry)}${turnedView ? '|transposed' : ''}`} mount={mount} onApi={onApi}
    rootProps={{
      'data-result-grid': '', 'data-output-view': 'grid', 'data-tab-id': tabId, 'data-result-entry': key, 'data-result-generation': entry.descriptor.generation,
      'data-result-id': entry.descriptor.resultId, 'data-result-kind': entry.descriptor.kind,
      // A Pivot's or comparison's grid is named for itself, so its number ("Result 4" in a save's name) is kept here.
      ...derivedGridName(entry) ? { 'data-result-number': entry.number } : {}, ...view ? { 'data-result-view': view } : {}, ...group === undefined ? {} : { 'data-result-group': group },
      ...bare ? { 'data-result-bare': '' } : {}, ...compared ? { 'data-comparison-inputs': sources?.every(source => source.entry !== undefined) ? 'open' : 'closed' } : {}, 'data-pane-focus': focused ? 'selected' : 'grid',
      // The stack keeps the focused entry for its own drawing and tells the service (`focusEntry`), so the toolbar, the
      // menus' toggle and the pivot builder follow.
      onFocus: () => { hadFocus.current = true; onFocus(key) },
      onBlur: event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) hadFocus.current = false }
    }}
    sort={sort?.keys} onSort={(column, add) => results.cycleSort(tabId, key, column, add)} funnels={funnels} busy={busy} onHeld={() => results.operations.refused(tabId, key)}
    update={{ resultCount: count, showTypes, rowSize, ...turnedView ? { headerColumn: headerColumn ?? null } : {} }} gone={lost ? lostText : undefined}
    strip={note ? { text: note, ...action ? { action } : {}, ...lead ? { lead } : {}, ...quiet ? { quiet } : {} } : undefined} {...rerun ? { expired: rerun } : {}} rootRef={setRootEl}
    head={compared && !bare && !lost ? <ComparisonToolbar tabId={tabId} entry={entry} info={compared} sources={sources} goTo={goTo} /> : undefined} />
}

/** Gives the keyboard focus to a result's grid in `owner` (a popped-out pane has its own document). A grid just added, or
 *  one a layout mounts only once it is selected (Tabs), is drawn a few frames later: it is looked for at each of the next
 *  few frames, and given up on after them. */
export function focusResultGrid(owner: Document | undefined, tabId: string, key: EntryKey, frames = 10): void {
  const grid = owner?.querySelector<HTMLElement>(`[data-result-grid][data-tab-id="${CSS.escape(tabId)}"][data-result-entry="${CSS.escape(key)}"]`)
  if (grid) grid.focus()
  else if (frames > 0) owner?.defaultView?.requestAnimationFrame(() => focusResultGrid(owner, tabId, key, frames - 1))
}

/**
 * A grid that unmounts holding the focus, kept until the end of its commit. A rebuilt Pivot (Update, Build Pivot) keeps
 * its entry key but brings a new result, and the layouts key a grid by its result, so the grid the user was in is
 * replaced by a new one in the same commit; that one takes the focus, or the grid's keys would fall to the page.
 */
let handoff: { readonly owner: Document; readonly tabId: string; readonly key: EntryKey } | undefined

/** A result set's grid: a throw while rendering it stays in its frame (GridErrorBoundary), whose Retry renders it again. */
export default function ResultGrid(props: ResultGridProps) {
  return <GridErrorBoundary frameProps={{ 'data-result-entry': props.entry.key }}><ResultGridBody {...props} /></GridErrorBoundary>
}
