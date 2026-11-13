import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { nextFrame } from '../core/frame'
import { observeResize } from '../core/windows'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { entryName, setKey, transposedView, type EntryKey, type GridSort, type GridViewState, type ResultSetEntry, type TabResults } from '../results/ResultsService'
import { formatCount, plural, rowsFact } from '../results/status'
import { gridLimits as g } from './constants'
import ResultGrid from './ResultGrid'
import { contentHeight, dragSplitter, minGridHeight, mountedRange, revealScrollTop, setFloors, splitterMoves, stackLayout, stackMinimum } from './stack'

let scrollbar: number | undefined
/** The platform's scroll bar thickness (classic scroll bars take room; overlay ones take none). */
export function scrollbarSize(): number {
  if (scrollbar !== undefined) return scrollbar
  const probe = document.createElement('div')
  probe.style.cssText = 'position:absolute;top:-1000px;width:100px;height:100px;overflow:scroll'
  document.body.append(probe)
  scrollbar = probe.offsetHeight - probe.clientHeight
  probe.remove()
  return scrollbar
}

/**
 * Each set's height sized to its rows once it has them all (`contentHeight`), undefined while it streams. A horizontal scroll
 * bar is counted unless the set's grid said its columns fit (`narrow`): a grid not yet shown might need one. A set drawn
 * transposed (`turned`) is sized by the rows it draws, which are its columns, with the strip it shows past the cap.
 */
export function settledContent(tab: Pick<TabResults, 'sets' | 'settled'> & Partial<Pick<TabResults, 'sorts'>>, narrow?: ReadonlySet<EntryKey>, turned?: ReadonlySet<EntryKey>): (number | undefined)[] {
  return tab.sets.map(entry => {
    const set = tab.settled.get(setKey(entry.descriptor))
    if (!set) return undefined
    const isTurned = !!turned?.has(entry.key)
    // Past the cap a transposed grid shows a strip saying which rows it draws: the rows of the view it shows, so a
    // filter that leaves fewer (Transpose Selected Rows always does) leaves no strip.
    const capped = isTurned && (tab.sorts?.get(entry.key)?.view?.rows ?? set.rows) > wire.transpose.maxRows
    return contentHeight(isTurned ? entry.descriptor.columns.length : set.rows, narrow?.has(entry.key) ? 0 : scrollbarSize(), set.strip || capped)
  })
}
/** The entries drawn transposed, by the one rule the grid, Copy and Save follow (`transposedView`) over each grid's state. */
export function turnedEntries(sets: readonly ResultSetEntry[], grids: ReadonlyMap<EntryKey, GridViewState>): ReadonlySet<EntryKey> {
  const turned = new Set<EntryKey>()
  if (grids.size > 0) for (const entry of sets) if (transposedView(grids.get(entry.key), entry.descriptor)) turned.add(entry.key)
  return turned
}
// The stack keeps what it knows of an entry by the entry's key, so it stays with the entry when one before it goes. The
// layout (stack.ts) is geometry over the entries as they are drawn, top to bottom, so these two turn the one into the other.
/** The places, in the order drawn, of the entries that are collapsed. */
export function collapsedPlaces(sets: readonly ResultSetEntry[], collapsed: ReadonlySet<EntryKey>): ReadonlySet<number> {
  const places = new Set<number>()
  if (collapsed.size > 0) sets.forEach((entry, place) => { if (collapsed.has(entry.key)) places.add(place) })
  return places
}
/** Each entry's weight in the order drawn, or undefined (equal shares) when none has one. An entry without one (a result
 *  added since the splitter was dragged) takes the mean of the others', so adding it keeps their proportions; a closed
 *  entry's weight went with it, and the rest keep theirs. */
export function weightsOf(sets: readonly ResultSetEntry[], weights: ReadonlyMap<EntryKey, number> | undefined): number[] | undefined {
  if (!weights) return undefined
  let sum = 0, known = 0
  for (const entry of sets) { const weight = weights.get(entry.key); if (weight !== undefined) { sum += weight; known++ } }
  if (known === 0) return undefined
  const mean = sum / known
  return sets.map(entry => weights.get(entry.key) ?? mean)
}
/** The room a run's stack needs before it scrolls: every set at its floor (what the Messages strip leaves it, at least). */
export function stackNeed(tab: Pick<TabResults, 'sets' | 'settled'> & Partial<Pick<TabResults, 'sorts'>>, collapsed: ReadonlySet<EntryKey>, grids?: ReadonlyMap<EntryKey, GridViewState>): number {
  const minHeight = minGridHeight(scrollbarSize()), content = settledContent(tab, undefined, grids && turnedEntries(tab.sets, grids)), count = tab.sets.length, places = collapsedPlaces(tab.sets, collapsed)
  if (count === 0) return 0
  return count === 1 ? places.has(0) ? g.captionHeight : Math.min(minHeight, content[0] ?? minHeight) : stackMinimum(count, minHeight, { content, collapsed: places })
}

/** "Batch 2 of 3", with the repetition of a batch run with GO n; '' for a script of one batch run once. */
export function batchText(batchNumber: number, iteration: number, totalBatches: number): string {
  const batch = totalBatches > 1 ? `Batch ${batchNumber} of ${totalBatches}` : ''
  return iteration > 1 ? batch ? `${batch}, repetition ${iteration}` : `Repetition ${iteration}` : batch
}

/**
 * A filtered result's filters, each its words and a Remove button, and Clear filters when there are several. Removing the
 * last one (or clearing them) removes the button that has the focus, so the focus goes first to `refocus`'s target: the
 * caption's Collapse button in the stack, the selected view tab in Tabs.
 */
export function FilterChips({ tabId, entry, name, sort, refocus }: { tabId: string; entry: ResultSetEntry; name: string; sort?: GridSort; refocus(): void }) {
  const { results } = useWorkbench()
  if (!sort || sort.filters.length === 0) return null
  return <span className="rs-filters" role="group" aria-label={`Filters of ${name}`}>
    {sort.filters.map((item, at) => <span key={at} className="rs-filter" title={item.label}>
      <Icon name="filter" /><span className="rs-filter-text">{item.label}</span>
      <button type="button" className="icon-button rs-filter-remove" aria-label={`Remove filter ${item.label}`} title="Remove filter" onClick={() => { if (at === sort.filters.length - 1) refocus(); results.removeFilter(tabId, entry.key, at) }}><Icon name="close" /></button>
    </span>)}
    {sort.filters.length > 1 && <button type="button" className="rs-filters-clear" onClick={() => { refocus(); results.clearFilters(tabId, entry.key) }}>Clear filters</button>}
  </span>
}

/**
 * A set's caption: Collapse, its name, rows (counting while they stream) and columns, the batch it came from, Save
 * Results As for it and, in a stack that closes results (`onClose`), its close button, which is disabled while the query
 * runs (`running`). A Table's closes its group, so its tooltip says what goes with it (`others`: its Pivot); a Pivot's or
 * a comparison's closes that view alone. It renders for each set in view, so a set's facts show before its grid mounts.
 */
const ResultCaption = memo(function ResultCaption({ tabId, entry, collapsed, totalBatches, sort, running, others, onToggle, onClose }: {
  tabId: string; entry: ResultSetEntry; collapsed: boolean; totalBatches: number; sort?: GridSort; running: boolean; others: string; onToggle(key: EntryKey): void; onClose?(key: EntryKey): void
}) {
  const { commands } = useWorkbench()
  const snapshot = useSyncExternalStore(entry.handle.subscribe, entry.handle.getSnapshot)
  const { descriptor } = entry, columns = descriptor.columns.length, name = entryName(entry)
  const facts = [rowsFact(snapshot, sort), `${formatCount(columns)} ${plural(columns, 'column')}`]
  if (descriptor.kind === 'executionPlan') facts.push('execution plan')
  const batch = batchText(descriptor.batchNumber, descriptor.iteration, totalBatches)
  const held = snapshot.state !== 'lost' && snapshot.state !== 'released'
  const save = (event: MouseEvent<HTMLButtonElement>) => {
    void commands.execute('output.saveResultsAs', { target: { kind: 'output', tabId, view: 'grid', entry: entry.key, selectedText: '', element: event.currentTarget } }, 'toolbar')
  }
  // A Remove or Clear button that goes with its filters hands focus to the caption, not the page.
  const toggleRef = useRef<HTMLButtonElement>(null)
  const refocus = useCallback(() => toggleRef.current?.focus(), [])
  return <div className="rs-caption">
    <button ref={toggleRef} type="button" className="rs-caption-toggle" data-caption-entry={entry.key} aria-expanded={!collapsed} onClick={() => onToggle(entry.key)}>
      <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} /><span className="rs-caption-name">{name}</span>
    </button>
    {/* Rows change while the set streams; the grid's own label announces its counts. */}
    <span className="rs-caption-facts" aria-live="off">{facts.join(' · ')}</span>
    <FilterChips tabId={tabId} entry={entry} name={name} sort={sort} refocus={refocus} />
    {batch && <span className="rs-caption-batch">{batch}</span>}
    {held && <button type="button" className="icon-button rs-caption-save" aria-label={`Save ${name} As…`} title={`Save ${name} As…`} onClick={save}><Icon name="save-as" /></button>}
    {/* A Table closes its group, its Pivot with it; a comparison made from it stays. There is no undo. */}
    {onClose && <button type="button" className="icon-button rs-caption-close" aria-label={`Close ${name}`} title={running ? `Close ${name} (unavailable while the query runs)` : `Close ${name}${others}`}
      disabled={running} onClick={() => onClose(entry.key)}><Icon name="close" /></button>}
  </div>
})

/**
 * A run's views stacked, one item each, in the order of `tab.sets`: each group's Table, its Pivot directly under it, then
 * the next group, and the comparisons last. Each is under its caption: a set that has all its rows and needs less than its
 * share is sized to them (one drawn transposed, to the rows it draws), the rest share the pane equally (or by the weights a splitter drag left), no grid is shorter than a
 * header and four rows (or its rows), a collapsed set is its caption alone, and when they do not fit the stack scrolls.
 * Only the sets within a view above and below are rendered, at most 12, mounting at most 2 grids a frame; a set waiting
 * for its grid shows its caption. One set in a pane too short for its minimum shows its grid without the caption, whose
 * facts the run summary already gives. Scroll position, weights, collapsed sets and the focused grid live in the tab's
 * view state, each by its entry's key. Each caption has a close button for its view: a Table's closes its group. A bare
 * run (`tab.bare`, Peek's rows) draws the grid alone: no close buttons, and no caption either while it has one grid
 * without filters (a caption returns to hold the filters, so they can be removed).
 */
export default function ResultsStack({ tabId, tab }: { tabId: string; tab: TabResults }) {
  const { results, resultsSearch } = useWorkbench()
  const view = results.viewState(tabId)
  const search = useServiceSnapshot(resultsSearch)[tabId]
  const sets = tab.sets, count = sets.length, closable = !tab.bare
  // What each entry shows of its group, for its grid's attributes and its caption.
  const slots = useMemo(() => {
    const map = new Map<EntryKey, { view: 'table' | 'pivot' | 'comparison' | 'plan'; group?: number; others: string }>()
    for (const group of tab.groups) {
      // What a Table's close takes with it, for its button's tooltip.
      map.set(group.table.key, { view: group.planSet ? 'plan' : 'table', group: group.ordinal, others: group.pivot ? ' and its Pivot' : '' })
      if (group.pivot) map.set(group.pivot.key, { view: 'pivot', group: group.ordinal, others: '' })
    }
    for (const slot of tab.comparisons) map.set(slot.key, { view: 'comparison', others: '' })
    return map
  }, [tab.groups, tab.comparisons])
  const stackRef = useRef<HTMLDivElement>(null)
  const [paneHeight, setPaneHeight] = useState(0)
  const [scrollTop, setScrollTop] = useState(view.stackScrollTop)
  const [entryWeights, setWeightsState] = useState(view.weights)
  const [focusedEntry, setFocused] = useState(view.focused)
  const [collapsedEntries, setCollapsedState] = useState(view.collapsed)
  const [mounted, setMounted] = useState<ReadonlySet<EntryKey>>(() => new Set())
  // The sets whose grids said their columns fit, so their content height leaves out the horizontal scroll bar.
  const [narrow, setNarrow] = useState<ReadonlySet<EntryKey>>(() => new Set())
  // The sets drawn transposed, which are sized by their columns. The orientation is in each grid's state and the service
  // publishes when it changes (`setOrientation`), so it is read again with every snapshot, mounted grid or not.
  // The same set while the same entries are turned, so the layout is made again only when one is turned or turned back,
  // not with every snapshot.
  const lastTurned = useRef<ReadonlySet<EntryKey>>(new Set())
  const turned = useMemo(() => {
    const next = turnedEntries(sets, view.grids), last = lastTurned.current
    if (next.size === last.size && [...next].every(key => last.has(key))) return last
    return lastTurned.current = next
  }, [tab, sets, view])
  const minHeight = useMemo(() => minGridHeight(scrollbarSize()), [])
  const settled = tab.settled
  const sorts = tab.sorts
  const content = useMemo(() => settledContent({ sets, settled, sorts }, narrow, turned), [sets, settled, sorts, narrow, turned])
  // By place, for the layout: what the stack keeps by entry key, over the entries as they are drawn.
  const weights = useMemo(() => weightsOf(sets, entryWeights), [sets, entryWeights])
  const collapsed = useMemo(() => collapsedPlaces(sets, collapsedEntries), [sets, collapsedEntries])
  // The grid F6 focuses: the one that last had the focus, else the first.
  const focused = focusedEntry !== undefined && sets.some(entry => entry.key === focusedEntry) ? focusedEntry : tab.focused ?? sets[0]?.key
  const layout = useMemo(() => stackLayout(paneHeight, count, weights, minHeight, { content, collapsed }), [paneHeight, count, weights, minHeight, content, collapsed])
  const floors = useMemo(() => setFloors(count, minHeight, { content, collapsed }), [count, minHeight, content, collapsed])
  const bare = count === 1 && !collapsed.has(0) && paneHeight > 0 && paneHeight < minHeight
  const [first, last] = paneHeight > 0 ? mountedRange(layout, scrollTop, paneHeight) : [0, -1]
  const drag = useRef<{ index: number; pointerId: number; startY: number; heights: readonly number[]; floors: readonly number[]; frame?: () => void; y: number } | undefined>(undefined)
  const setWeights = (next: number[] | undefined) => {
    const byEntry = next && new Map(sets.map((entry, place): [EntryKey, number] => [entry.key, next[place]]))
    view.weights = byEntry
    setWeightsState(byEntry)
  }

  useLayoutEffect(() => {
    const element = stackRef.current!
    const observer = observeResize(element, () => setPaneHeight(element.clientHeight))
    setPaneHeight(element.clientHeight)
    return () => observer.dispose()
  }, [])
  // The saved scroll position, once the content is tall enough to take it.
  useLayoutEffect(() => {
    const element = stackRef.current
    if (element && paneHeight > 0 && Math.abs(element.scrollTop - view.stackScrollTop) >= 1) element.scrollTop = view.stackScrollTop
  }, [paneHeight, view])
  // At most 2 grids mount a frame, so scrolling a stack of 1,000 never builds 12 grids at once. The first ones mount
  // before the pane paints, so the first rows are not a frame later.
  useLayoutEffect(() => {
    // The entries in view, top to bottom.
    const wanted: EntryKey[] = []
    for (let index = first; index <= last; index++) { const entry = sets[index]; if (entry) wanted.push(entry.key) }
    const inView = new Set(wanted)
    const missing = wanted.some(key => !mounted.has(key))
    const stale = [...mounted].some(key => !inView.has(key))
    if (!missing && !stale) return
    const mount = (current: ReadonlySet<EntryKey>) => {
      const next = new Set<EntryKey>()
      for (const key of current) if (inView.has(key)) next.add(key)
      let added = 0
      for (const key of wanted) if (added < g.mountsPerFrame && !next.has(key)) { next.add(key); added++ }
      return next
    }
    if (mounted.size === 0) { setMounted(mount); return }
    return nextFrame(() => setMounted(mount))
  }, [first, last, mounted, sets])
  useEffect(() => () => drag.current?.frame?.(), [])
  // A splitter drag holds places and heights of the entries as they were: when one goes, the drag ends where it was. (One
  // that arrives while the query runs is added after them, and leaves the drag alone.)
  const drawn = useRef(count)
  useEffect(() => {
    if (count < drawn.current) { drag.current?.frame?.(); drag.current = undefined }
    drawn.current = count
  }, [count])
  // Closing a view (its caption's button; a Table's closes its group): the focus goes to the caption after what closes,
  // else the one before, else to the
  // Results tab, which stays when the last result has gone (and takes it too when that caption is not drawn: one result
  // left in a pane too short for a caption). Only when the focus was in what closes, or nowhere. It moves once, in the
  // first layout without the closed result, and never later.
  const pendingFocus = useRef<{ readonly closed: EntryKey; readonly next: EntryKey } | undefined>(undefined)
  const close = useCallback((key: EntryKey) => {
    const stack = stackRef.current, list = results.getSnapshot()[tabId]?.sets ?? []
    const gone = new Set(results.closing(tabId, key).map(entry => entry.key))
    const places = list.flatMap((entry, place) => gone.has(entry.key) ? [place] : [])
    // A Pivot leaves the focus in its group, on the Table's caption, as the service leaves the
    // grid focus on the Table; a group or a comparison passes it to the next surviving item, else the one before.
    const slot = slots.get(key), table = slot?.group !== undefined && slot.view !== 'table' && slot.view !== 'plan' ? list.find(entry => entry.ordinal === slot.group) : undefined
    const next = table ?? (places.length ? list[places[places.length - 1] + 1] ?? list[places[0] - 1] : undefined)
    const active = stack?.ownerDocument.activeElement
    const own = !active || active === stack?.ownerDocument.body || gone.has(active.closest('.rs-item')?.querySelector('[data-caption-entry]')?.getAttribute('data-caption-entry') ?? '')
    if (own && !next) resultsTab()?.focus({ preventScroll: true })
    if (results.removeEntry(tabId, key) && own && next) pendingFocus.current = { closed: key, next: next.key }
  }, [results, tabId, slots])
  const resultsTab = () => stackRef.current?.closest('.output-panel')?.querySelector<HTMLElement>('[role="tab"][data-output-tab="results"]')
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    // Until the stack is drawn without the closed result, the focus is still in it.
    if (!pending || sets.some(entry => entry.key === pending.closed)) return
    pendingFocus.current = undefined
    const stack = stackRef.current, active = stack?.ownerDocument.activeElement
    // The user has moved on meanwhile: the focus is theirs.
    if (active && active !== stack?.ownerDocument.body && !stack?.contains(active)) return
    const target = stack?.querySelector<HTMLElement>(`[data-caption-entry="${pending.next}"]`) ?? resultsTab()
    target?.focus({ preventScroll: true })
  })

  const focus = (key: EntryKey) => { results.focusEntry(tabId, key); setFocused(key) }
  // A bare run's one grid has a caption only while it has filters (or is collapsed). When the caption goes with the focus
  // in it (the last filter removed from its chip), the focus goes to the grid, not to the page: Peek's card keeps its
  // keys only while the focus is inside it. Only then: a focus that was elsewhere, or nowhere, is left alone. (An element
  // removed while it has the focus gets no blur, so the mark set when the caption took the focus is still set.)
  const captionless = !!tab.bare && count === 1 && !collapsed.has(0) && !tab.sorts.get(sets[0].key)?.filters.length
  const hadCaption = useRef(!captionless), captionFocus = useRef(false)
  const trackFocus = (event: FocusEvent<HTMLDivElement>) => { captionFocus.current = !!(event.target as Element).closest?.('.rs-caption') }
  const trackBlur = (event: FocusEvent<HTMLDivElement>) => { if (event.relatedTarget || !(event.target as Element).closest?.('.rs-caption')) captionFocus.current = false }
  useLayoutEffect(() => {
    const went = hadCaption.current && captionless, was = captionFocus.current
    hadCaption.current = !captionless
    if (went) captionFocus.current = false
    const stack = stackRef.current, active = stack?.ownerDocument.activeElement
    if (went && was && stack && (!active || active === stack.ownerDocument.body)) stack.querySelector<HTMLElement>('[data-pane-focus]')?.focus({ preventScroll: true })
  }, [captionless])
  const wide = useCallback((key: EntryKey, isWide: boolean) => {
    setNarrow(current => {
      if (current.has(key) === !isWide) return current
      const next = new Set(current)
      if (isWide) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  // Stable, so captions re-render only when their own facts change.
  const toggle = useCallback((key: EntryKey) => {
    const next = new Set(view.collapsed)
    if (!next.delete(key)) next.add(key)
    view.collapsed = next
    setCollapsedState(next)
  }, [view])
  // Search in results: the grid holding the active match opens and scrolls into view, which mounts it; the grid then
  // scrolls the match itself into view (ResultGrid). Layout effects run before the grid's effect takes the reveal, so the
  // stack still sees it pending; a collapsed grid opens first and scrolls once its new layout is in.
  const revealSeq = search?.reveal ?? 0, revealEntry = search?.revealEntry
  const stackReveal = useRef<EntryKey | undefined>(undefined)
  useLayoutEffect(() => {
    if (revealEntry === undefined || !sets.some(entry => entry.key === revealEntry) || !resultsSearch.pendingReveal(tabId, revealEntry)) return
    if (collapsedEntries.has(revealEntry)) toggle(revealEntry)
    stackReveal.current = revealEntry
  }, [revealSeq, revealEntry])
  useLayoutEffect(() => {
    const element = stackRef.current, key = stackReveal.current
    if (key === undefined) return
    // Where the entry stands now, which is where the stack scrolls to; an entry that has gone has nothing to reveal.
    const index = sets.findIndex(entry => entry.key === key)
    if (index < 0) { stackReveal.current = undefined; return }
    // A stack just mounted (Find Next while Messages showed) has no height for its first layout: the reveal waits for it.
    if (!element || index >= layout.offsets.length || collapsed.has(index) || paneHeight <= 0) return
    stackReveal.current = undefined
    const top = revealScrollTop(layout, index, element.scrollTop, element.clientHeight)
    if (top === undefined) return
    element.scrollTop = top
    // The scroll event comes later: the saved position follows now, so a restore before it does not undo the reveal.
    view.stackScrollTop = element.scrollTop
  }, [revealSeq, revealEntry, layout, collapsed, paneHeight, sets])
  const splitterDown = (index: number, event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus()
    drag.current = { index, pointerId: event.pointerId, startY: event.clientY, heights: layout.heights, floors, y: event.clientY }
  }
  const splitterMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    state.y = event.clientY
    if (state.frame) return
    // One layout per frame while dragging.
    state.frame = nextFrame(() => {
      state.frame = undefined
      if (drag.current === state) setWeights(dragSplitter(state.heights, state.index, state.y - state.startY, state.floors, collapsed))
    })
  }
  const splitterUp = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    state.frame?.()
    setWeights(dragSplitter(state.heights, state.index, event.clientY - state.startY, state.floors, collapsed))
    drag.current = undefined
  }
  const splitterKey = (index: number, event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowUp' ? -g.rowHeight : event.key === 'ArrowDown' ? g.rowHeight : event.key === 'Home' ? -Infinity : event.key === 'End' ? Infinity : undefined
    if (event.key === 'Enter') { event.preventDefault(); setWeights(undefined); return }
    if (delta === undefined || event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    setWeights(dragSplitter(layout.heights, index, delta, floors, collapsed))
  }

  const items = []
  for (let index = first; index <= last; index++) {
    const entry = sets[index]
    if (!entry) continue
    const shut = collapsed.has(index), slot = slots.get(entry.key), sort = tab.sorts.get(entry.key)
    // A bare run's one grid stands alone, unless it has filters to show and remove.
    const plain = bare || captionless
    items.push(<div key={`item-${entry.key}`} className="rs-item" data-collapsed={shut || undefined} style={{ top: layout.offsets[index], height: layout.heights[index] }}>
      {!plain && <ResultCaption tabId={tabId} entry={entry} collapsed={shut} totalBatches={tab.totalBatches} sort={sort} running={tab.status === 'running'} others={slot?.others ?? ''} onToggle={toggle} onClose={closable ? close : undefined} />}
      {!shut && mounted.has(entry.key) && <ResultGrid tabId={tabId} entry={entry} count={tab.numbered} focused={entry.key === focused} budget={tab.summary?.budget} sort={sort}
        view={slot?.view} group={slot?.group} bare={tab.bare} onFocus={focus} onWide={wide} />}
    </div>)
    if (index < count - 1) {
      const top = layout.offsets[index] + layout.heights[index]
      // Beside a collapsed set a splitter has nothing to move: it is a plain divider until the set opens again.
      if (!splitterMoves(count, index, collapsed)) { items.push(<div key={`splitter-${entry.key}`} className="rs-splitter" role="separator" aria-orientation="horizontal" data-inert="" style={{ top }} />); continue }
      // The value is the upper grid's height, which the splitter moves between the two grids' floors.
      const height = Math.round(layout.heights[index])
      // Named by the number of the result above it, as that result's grid is.
      items.push(<div key={`splitter-${entry.key}`} className="rs-splitter" role="separator" aria-orientation="horizontal" aria-label={`Resize Result ${entry.number}`}
        aria-valuenow={height} aria-valuemin={Math.round(floors[index])} aria-valuemax={Math.round(Math.max(floors[index], layout.heights[index] + layout.heights[index + 1] - floors[index + 1]))}
        aria-valuetext={`Result ${entry.number} height ${height} pixels`} tabIndex={0} style={{ top }}
        onPointerDown={event => splitterDown(index, event)} onPointerMove={splitterMove} onPointerUp={splitterUp} onLostPointerCapture={() => { drag.current = undefined }}
        onDoubleClick={() => setWeights(undefined)} onKeyDown={event => splitterKey(index, event)} />)
    }
  }
  return <div ref={stackRef} className="rs-stack" onFocus={trackFocus} onBlur={trackBlur} onScroll={event => { view.stackScrollTop = event.currentTarget.scrollTop; setScrollTop(event.currentTarget.scrollTop) }}>
    <div className="rs-content" style={{ height: layout.total }}>{items}</div>
  </div>
}
