import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { nextFrame } from '../core/frame'
import { observeResize } from '../core/windows'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import MultiRunSummary, { environmentTone, multiModeLabel, multiOutcomeInfo } from '../results/MultiRunSummary'
import { distinctName, entryName, entryNumber, entrySecondary, entryTitle, hasMultiSummary, pivotOutOfDate, setKey, slotNamed, summaryEntryKey, targetOfEntry, transposedView, type EntryKey, type GridSort, type GridViewState, type ResultSetEntry, type TabResults } from '../results/ResultsService'
import { formatCount, plural, rowsFact } from '../results/status'
import { gridLimits as g } from './constants'
import ResultGrid from './ResultGrid'
import { combinedTargetCount, stackReveals } from './result-picker'
import { visibleColumnCount } from './hidden-columns'
import { scrollbarSize } from './scrollbar'
import { contentHeight, dragSplitter, minGridHeight, mountedRange, revealScrollTop, setFloors, splitterMoves, stackLayout, stackMinimum } from './stack'

export { scrollbarSize }

/** Height (px) of one multi-server grid notice strip (Rolled-back preview, Stale Combined, or Partial-merge/Schema-drift). */
export const multiNoticeHeight = 28
/** Height (px) of the collapsible summary header band above grids in Stacked layout. */
export const multiStackHeaderHeight = 32
/** Height (px) of the compact statement selector strip in Stacked layout when statements > 1. */
export const multiStmtBarHeight = 28
/** Minimum comfortable height (px) for the MultiRunSummary view when sets.length === 0 or Summary is active. */
export const multiSummaryMinHeight = 120

export interface EntryNotice {
  readonly kind: 'rolledBack' | 'staleCombined' | 'partialCombine' | 'combineWarning'
  readonly tone: 'warn' | 'info'
  readonly text: string
}

/** Notice strips shown directly above a grid (Rolled-back preview, Stale Combined, Partial-merge / Schema-drift). */
export function entryNotices(tab: Partial<Pick<TabResults, 'multi' | 'sets' | 'staleCombined'>>, entry: ResultSetEntry): EntryNotice[] {
  const notices: EntryNotice[] = []
  if (entry.descriptor.rolledBackPreview || entry.handle?.getSnapshot().rolledBackPreview) {
    notices.push({ kind: 'rolledBack', tone: 'warn', text: 'Rolled back — preview only (not committed).' })
  }
  if (entry.descriptor.kind === 'combined') {
    const stale = !!tab.staleCombined?.has(entry.key)
    if (stale) {
      notices.push({ kind: 'staleCombined', tone: 'warn', text: 'A source server result was closed. Rebuild Combined from the remaining servers or close this view.' })
    }
    if (hasMultiSummary(tab)) {
      const warnings = tab.multi!.combineWarnings
      if (warnings && warnings.length > 0) {
        notices.push({ kind: 'combineWarning', tone: 'info', text: warnings.join(' ') })
      } else if (!stale) {
        const slot = entry.descriptor.statementSlot ?? 0
        const k = combinedTargetCount(tab, slot), total = tab.multi!.targets.length
        if (k < total) {
          notices.push({ kind: 'partialCombine', tone: 'info', text: `Combined from ${formatCount(k)} of ${formatCount(total)} servers — remaining servers returned no in-memory rows for this statement.` })
        }
      }
    }
  }
  return notices
}

/** Exact total height (px) of notice strips rendered above `entry`'s grid (0 for ordinary single-server grids). */
export function entryNoticesHeight(tab: Partial<Pick<TabResults, 'multi' | 'sets' | 'staleCombined'>>, entry: ResultSetEntry | undefined): number {
  return entry ? entryNotices(tab, entry).length * multiNoticeHeight : 0
}

/** Renders the notice strip(s) above a multi-server result grid, including Rebuild / Close actions for stale Combined views. */
export const EntryNoticeBars = memo(function EntryNoticeBars({ tabId, tab, entry, running }: {
  readonly tabId: string; readonly tab: TabResults; readonly entry: ResultSetEntry; readonly running: boolean
}) {
  const { results } = useWorkbench()
  const notices = entryNotices(tab, entry)
  const [rebuilding, setRebuilding] = useState(false)
  if (notices.length === 0) return null
  const canRebuild = !running && !rebuilding && results.canRebuildCombined(tabId, entry.key)
  const rebuild = async () => {
    setRebuilding(true)
    try { await results.rebuildCombined(tabId, entry.key) } finally { setRebuilding(false) }
  }
  return <div className="multi-grid-notices">
    {notices.map(notice => <div key={notice.kind} className={`multi-grid-notice multi-grid-notice-${notice.tone}`} role="status" data-notice-kind={notice.kind}>
      <Icon name={notice.tone === 'warn' ? 'warning' : 'info'} />
      <span className="multi-grid-notice-text">{notice.text}</span>
      {notice.kind === 'staleCombined' && <span className="multi-grid-notice-actions">
        <button type="button" className="multi-grid-notice-btn" disabled={!canRebuild} onClick={() => void rebuild()}>
          <Icon name={rebuilding ? 'loading' : 'refresh'} spin={rebuilding} /><span>{rebuilding ? 'Rebuilding…' : 'Rebuild'}</span>
        </button>
        <button type="button" className="multi-grid-notice-btn" disabled={running || rebuilding} onClick={() => results.removeEntry(tabId, entry.key)}>
          <Icon name="close" /><span>Close</span>
        </button>
      </span>}
    </div>)}
  </div>
})

/** Counts distinct multi-server statement slots present across a tab's sets. */
function distinctStatementSlots(sets: readonly ResultSetEntry[]): { readonly slot: number; readonly label: string }[] {
  const bySlot = new Map<number, string>()
  for (const entry of sets) {
    if (entry.descriptor.kind !== 'rows' && entry.descriptor.kind !== 'combined') continue
    if (entry.descriptor.targetKey === undefined && entry.descriptor.kind !== 'combined') continue
    const slot = entry.descriptor.statementSlot ?? 0
    if (!bySlot.has(slot) || (entry.descriptor.name && bySlot.get(slot) === `Statement ${slot + 1}`)) {
      bySlot.set(slot, entry.descriptor.name || `Statement ${slot + 1}`)
    }
  }
  return [...bySlot.entries()].sort(([a], [b]) => a - b).map(([slot, label]) => ({ slot, label }))
}

/** Orders multi-server stacked entries: Combined first, then each server in target order (with its Pivot directly under it),
 *  then any other entries, and comparisons last. */
function orderedMultiSets(tab: TabResults, selectedStmt: number | 'all'): readonly ResultSetEntry[] {
  if (!hasMultiSummary(tab)) return tab.sets
  const matchesStmt = (entry: ResultSetEntry) => selectedStmt === 'all' || (entry.descriptor.statementSlot ?? 0) === selectedStmt
  const ordered: ResultSetEntry[] = []
  const added = new Set<EntryKey>()
  const pushGroup = (group: TabResults['groups'][number]) => {
    if (!matchesStmt(group.table.entry)) return
    ordered.push(group.table.entry)
    added.add(group.table.key)
    if (group.pivot) { ordered.push(group.pivot.entry); added.add(group.pivot.key) }
  }
  // 1. Combined sets first
  for (const group of tab.groups) if (group.table.entry.descriptor.kind === 'combined') pushGroup(group)
  // 2. Per-server sets in tab.multi.targets order
  for (const target of tab.multi!.targets) {
    for (const group of tab.groups) {
      if (group.table.entry.descriptor.targetKey === target.targetKey && !added.has(group.table.key)) pushGroup(group)
    }
  }
  // 3. Any remaining groups (e.g. samples)
  for (const group of tab.groups) if (!added.has(group.table.key)) pushGroup(group)
  // 4. Comparisons last
  for (const slot of tab.comparisons) ordered.push(slot.entry)
  return ordered
}

/**
 * Each set's height sized to its rows once it has them all (`contentHeight`), undefined while it streams. A horizontal scroll
 * bar is counted unless the set's grid said its columns fit (`narrow`): a grid not yet shown might need one. A set drawn
 * transposed (`turned`) is sized by the rows it draws, which are its columns, with the strip it shows past the cap.
 * Multi-server notice strips above a grid are included in its settled height.
 */
export function settledContent(tab: Pick<TabResults, 'sets' | 'settled'> & Partial<Pick<TabResults, 'sorts' | 'multi' | 'staleCombined'>>, narrow?: ReadonlySet<EntryKey>, turned?: ReadonlySet<EntryKey>, entries: readonly ResultSetEntry[] = tab.sets): (number | undefined)[] {
  return entries.map(entry => {
    const set = tab.settled.get(setKey(entry.descriptor))
    if (!set) return undefined
    const isTurned = !!turned?.has(entry.key)
    // Past the cap a transposed grid shows a strip saying which rows it draws: the rows of the view it shows, so a
    // filter that leaves fewer (Transpose Selected Rows always does) leaves no strip.
    const capped = isTurned && (tab.sorts?.get(entry.key)?.view?.rows ?? set.rows) > wire.transpose.maxRows
    return contentHeight(isTurned ? entry.descriptor.columns.length : set.rows, narrow?.has(entry.key) ? 0 : scrollbarSize(), set.strip || capped, entry.descriptor.kind === 'diff')
      + entryNoticesHeight(tab, entry)
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
/** The room a run's stack needs before it scrolls: every set at its floor (including multi-server summary/statement/notice
 *  strips, so short panes never starve grids). */
export function stackNeed(tab: Pick<TabResults, 'sets' | 'settled'> & Partial<Pick<TabResults, 'sorts' | 'multi' | 'staleCombined'>>, collapsed: ReadonlySet<EntryKey>, grids?: ReadonlyMap<EntryKey, GridViewState>): number {
  const multi = hasMultiSummary(tab)
  const count = tab.sets.length
  if (count === 0) return multi ? multiSummaryMinHeight : 0
  const minHeight = minGridHeight(scrollbarSize()), content = settledContent(tab, undefined, grids && turnedEntries(tab.sets, grids)), places = collapsedPlaces(tab.sets, collapsed)
  const extraMin = multi ? tab.sets.map(entry => entryNoticesHeight(tab, entry)) : undefined
  const multiChrome = multi ? multiStackHeaderHeight + (distinctStatementSlots(tab.sets).length > 1 ? multiStmtBarHeight : 0) : 0
  return multiChrome + stackMinimum(count, minHeight, { content, collapsed: places, ...extraMin ? { extraMin } : {} })
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
 * A group's Pivot's mark and its one action, beside its name (a Stacked caption, the Tabs view row): "Building again…"
 * and Cancel while it is built again (by Update, or Build Pivot in the builder); else, while it is out of date (its
 * Table's filters changed since it was built), an Out of date chip and Update, which waits while the Table cannot be
 * pivoted (the query running, its sort or filter being built, the backend gone). The action is one button, so the focus
 * stays on it as Update turns into Cancel and back; when it goes (built, and up to date) the focus goes to `refocus`,
 * unless the user had put it somewhere else. The status line is mounted with it, so a screen reader hears it start.
 */
export function PivotMark({ tabId, entry, name, ordinal, source, stale, running, refocus }: { tabId: string; entry: ResultSetEntry; name: string; ordinal: number; source: string; stale: boolean; running: boolean; refocus(): void }) {
  const { commands, results, pivot } = useWorkbench()
  const rebuilding = useSyncExternalStore(pivot.subscribe, () => pivot.building(tabId, ordinal))
  const updatable = useSyncExternalStore(results.subscribe, () => stale && pivot.canPivot(tabId, entry.key))
  const action = rebuilding ? 'cancel' : stale ? 'update' : undefined
  const actionRef = useRef<HTMLButtonElement>(null), actionFocus = useRef(false)
  useLayoutEffect(() => {
    if (action || !actionFocus.current) return
    actionFocus.current = false
    const document = actionRef.current?.ownerDocument ?? globalThis.document
    if (!document.activeElement || document.activeElement === document.body) refocus()
  }, [action])
  const update = (event: MouseEvent<HTMLButtonElement>) => {
    void commands.execute('output.updatePivot', { target: { kind: 'output', tabId, view: 'grid', entry: entry.key, selectedText: '', element: event.currentTarget } }, 'toolbar')
  }
  return <>
    <span className="rs-caption-state" role="status">{rebuilding ? 'Building again…' : ''}</span>
    {action === 'update' && <span className="rs-caption-stale" title={`${source}'s filters changed after this Pivot was built`}><Icon name="warning" />Out of date</span>}
    {action && <button ref={actionRef} type="button" className="rs-caption-action" onFocus={() => { actionFocus.current = true }} onBlur={event => { if (event.relatedTarget) actionFocus.current = false }}
      {...action === 'cancel'
        ? { 'aria-label': `Cancel building ${name} again`, title: `Stop building ${name} again; it keeps its last build`, onClick: () => pivot.cancel(tabId, ordinal) }
        : { 'aria-label': `Update ${name}`, title: `Build ${name} again from ${source} as it is filtered now`, disabled: !updatable || running, onClick: update }}>
      {action === 'cancel' ? 'Cancel' : <><Icon name="refresh" />Update</>}
    </button>}
  </>
}

/**
 * A set's caption: Collapse, its name, rows (counting while they stream) and columns, the batch it came from, Save
 * Results As for it and, in a stack that closes results (`onClose`), its close button, which is disabled while the query
 * runs (`running`). A Table's closes its group, so its tooltip says what goes with it (`others`: its Pivot); a Pivot's or
 * a comparison's closes that view alone. It renders for each set in view, so a set's facts show before its grid mounts.
 * Calm Pro: multi-server captions show a small color dot and optional environment pill with zero left-border stripes.
 */
const ResultCaption = memo(function ResultCaption({ tabId, tab, entry, collapsed, totalBatches, sort, running, others, named, pivotOf, pivotSource, stale, onToggle, onClose }: {
  tabId: string; tab: TabResults; entry: ResultSetEntry; collapsed: boolean; totalBatches: number; sort?: GridSort; running: boolean; others: string
  /** The group number of the Pivot this caption heads, and whether it is out of date (its Table's filters changed). */
  pivotOf?: number; stale?: boolean
  /** The name of the Table that Pivot was built from ("Result 2", "Open orders"). */
  pivotSource?: string
  /** It shows a name the query gave (`slotNamed`): only then may its name give way to an ellipsis. */
  named?: boolean
  onToggle(key: EntryKey): void; onClose?(key: EntryKey): void
}) {
  const { commands, results } = useWorkbench()
  const snapshot = useSyncExternalStore(entry.handle.subscribe, entry.handle.getSnapshot)
  const cached = useSyncExternalStore(results.subscribe, () => results.getSnapshot()[tabId]?.summary?.job?.cacheHit === true)
  const { descriptor } = entry, columns = visibleColumnCount(descriptor), name = entryName(entry), number = entrySecondary(entry)
  const target = targetOfEntry(tab, entry)
  const targetIndex = target && tab.multi ? tab.multi.targets.findIndex(item => item.targetKey === target.targetKey) : -1
  const envTone = environmentTone(target?.environment)
  // A named result's buttons are named with its number too, so a screen reader tells two of one name apart.
  const spoken = number ? `${name}, ${number}` : name
  // A named result's number leads its facts, so two results of one name are told apart.
  const facts = [...number ? [number] : [], rowsFact(snapshot, sort, cached), `${formatCount(columns)} ${plural(columns, 'column')}`]
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
    <button ref={toggleRef} type="button" className="rs-caption-toggle" data-caption-entry={entry.key} aria-expanded={!collapsed} data-named={named || undefined}
      {...number ? { title: `${name} · ${number}`, 'aria-label': spoken } : named ? { title: name } : {}} onClick={() => onToggle(entry.key)}>
      <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} />
      {targetIndex >= 0 && <span className="rs-server-dot" data-target-color={targetIndex % 6} aria-hidden="true" />}
      {descriptor.kind === 'combined' && <Icon name="layers" />}
      <span className="rs-caption-name">{name}</span>
    </button>
    {target?.environment && <span className="multi-env-pill" data-env={envTone}>{target.environment.toUpperCase()}</span>}
    {/* Rows change while the set streams; the grid's own label announces its counts. */}
    <span className="rs-caption-facts" aria-live="off">{facts.join(' · ')}</span>
    <FilterChips tabId={tabId} entry={entry} name={spoken} sort={sort} refocus={refocus} />
    {batch && <span className="rs-caption-batch">{batch}</span>}
    {pivotOf !== undefined && <PivotMark tabId={tabId} entry={entry} name={name} ordinal={pivotOf} source={pivotSource ?? entryNumber({ number: pivotOf })} stale={!!stale} running={running} refocus={refocus} />}
    {held && <button type="button" className="icon-button rs-caption-save" aria-label={`Save ${spoken} As…`} title={`Save ${spoken} As…`} onClick={save}><Icon name="save-as" /></button>}
    {/* A Table closes its group, its Pivot with it; a comparison made from it stays. There is no undo. */}
    {onClose && <button type="button" className="icon-button rs-caption-close" aria-label={`Close ${spoken}`} title={running ? `Close ${spoken} (unavailable while the query runs)` : `Close ${spoken}${others}`}
      disabled={running} onClick={() => onClose(entry.key)}><Icon name="close" /></button>}
  </div>
})

/**
 * A run's views stacked, one item each, in the order of `tab.sets` (or for multi-server runs: a top MultiRunSummary band
 * — full when sets.length === 0 so pure-DDL/DML runs are never blank, collapsible above grids when sets.length > 0 —
 * optional compact statement selector strip when statements > 1, then Combined, each server's grids in target order,
 * and comparisons last). Each grid sits under its calm caption with zero left-border accent stripes.
 */
export default function ResultsStack({ tabId, tab, revealFocused = false }: { tabId: string; tab: TabResults; revealFocused?: boolean }) {
  const { results, resultsSearch } = useWorkbench()
  const view = results.viewState(tabId)
  const search = useServiceSnapshot(resultsSearch)[tabId]
  const multi = hasMultiSummary(tab)
  const summaryOnly = multi && tab.sets.length === 0
  const statementSlots = useMemo(() => multi ? distinctStatementSlots(tab.sets) : [], [multi, tab.sets])
  const [selectedStmt, setSelectedStmt] = useState<number | 'all'>('all')
  const effectiveStmt = selectedStmt !== 'all' && !statementSlots.some(item => item.slot === selectedStmt) ? 'all' : selectedStmt
  // Compact summary band defaults collapsed once sets exist (pure-DDL/DML renders full MultiRunSummary above).
  const [summaryOpen, setSummaryOpen] = useState(false)
  const sets = useMemo(() => multi ? orderedMultiSets(tab, effectiveStmt) : tab.sets, [multi, tab, effectiveStmt])
  const count = sets.length, closable = !tab.bare
  // What each entry shows of its group, for its grid's attributes and its caption.
  const slots = useMemo(() => {
    const map = new Map<EntryKey, { view: 'table' | 'pivot' | 'comparison' | 'plan'; group?: number; others: string; stale?: boolean; source?: string; named: boolean }>()
    for (const group of tab.groups) {
      // What a Table's close takes with it, for its button's tooltip.
      map.set(group.table.key, { view: group.planSet ? 'plan' : 'table', group: group.ordinal, others: group.pivot ? ' and its Pivot' : '', named: slotNamed(group.table) })
      // A Pivot whose Table's filters changed since it was built is marked on its caption, with Update.
      if (group.pivot) map.set(group.pivot.key, { view: 'pivot', group: group.ordinal, others: '', source: distinctName(group.table.entry, tab.sets), named: slotNamed(group.pivot), ...pivotOutOfDate(tab, group) ? { stale: true } : {} })
    }
    for (const slot of tab.comparisons) map.set(slot.key, { view: 'comparison', others: '', named: slotNamed(slot) })
    return map
  }, [tab.groups, tab.comparisons, tab.sorts, tab.sets])
  const stackRef = useRef<HTMLDivElement>(null)
  const [paneHeight, setPaneHeight] = useState(0)
  const [scrollTop, setScrollTop] = useState(view.stackScrollTop)
  const [entryWeights, setWeightsState] = useState(view.weights)
  const [focusedEntry, setFocused] = useState(view.focused)
  const [collapsedEntries, setCollapsedState] = useState(view.collapsed)
  const [mounted, setMounted] = useState<ReadonlySet<EntryKey>>(() => new Set())
  // The sets whose grids said their columns fit, so their content height leaves out the horizontal scroll bar.
  const [narrow, setNarrow] = useState<ReadonlySet<EntryKey>>(() => new Set())
  const lastTurned = useRef<ReadonlySet<EntryKey>>(new Set())
  const turned = useMemo(() => {
    const next = turnedEntries(sets, view.grids), last = lastTurned.current
    if (next.size === last.size && [...next].every(key => last.has(key))) return last
    return lastTurned.current = next
  }, [tab, sets, view])
  const minHeight = useMemo(() => minGridHeight(scrollbarSize()), [])
  const settled = tab.settled
  const sorts = tab.sorts
  const content = useMemo(() => settledContent({ sets: tab.sets, settled, sorts, multi: tab.multi, staleCombined: tab.staleCombined }, narrow, turned, sets), [tab.sets, settled, sorts, tab.multi, tab.staleCombined, narrow, turned, sets])
  // By place, for the layout: what the stack keeps by entry key, over the entries as they are drawn.
  const weights = useMemo(() => weightsOf(sets, entryWeights), [sets, entryWeights])
  const collapsed = useMemo(() => collapsedPlaces(sets, collapsedEntries), [sets, collapsedEntries])
  // The grid F6 focuses: the one that last had the focus, else the first.
  const focused = focusedEntry !== undefined && sets.some(entry => entry.key === focusedEntry) ? focusedEntry : (tab.focused && sets.some(entry => entry.key === tab.focused) ? tab.focused : sets[0]?.key)
  const extraMin = useMemo(() => multi ? sets.map(entry => entryNoticesHeight(tab, entry)) : undefined, [multi, sets, tab])
  const layout = useMemo(() => stackLayout(paneHeight, count, weights, minHeight, { content, collapsed, ...extraMin ? { extraMin } : {} }), [paneHeight, count, weights, minHeight, content, collapsed, extraMin])
  const floors = useMemo(() => setFloors(count, minHeight, { content, collapsed, ...extraMin ? { extraMin } : {} }), [count, minHeight, content, collapsed, extraMin])
  const bare = !multi && count === 1 && !collapsed.has(0) && paneHeight > 0 && paneHeight < minHeight
  const [first, last] = paneHeight > 0 ? mountedRange(layout, scrollTop, paneHeight) : [0, -1]
  const drag = useRef<{ index: number; pointerId: number; startY: number; heights: readonly number[]; floors: readonly number[]; frame?: () => void; y: number } | undefined>(undefined)
  const setWeights = (next: number[] | undefined) => {
    const byEntry = next && new Map(sets.map((entry, place): [EntryKey, number] => [entry.key, next[place]]))
    view.weights = byEntry
    setWeightsState(byEntry)
  }

  // Stacked layout displays grids immediately when sets exist: clear virtual Summary focus so Transpose / Save Results As act on the first grid right away.
  const firstEntryKey = sets[0]?.key
  useLayoutEffect(() => {
    if (!multi || firstEntryKey === undefined) return
    if (tab.activeSummary || tab.focused === summaryEntryKey) {
      results.focusEntry(tabId, firstEntryKey)
      setFocused(firstEntryKey)
    }
  }, [multi, firstEntryKey, tab.activeSummary, tab.focused, results, tabId])

  useLayoutEffect(() => {
    const element = stackRef.current
    if (!element) return
    const observer = observeResize(element, () => setPaneHeight(element.clientHeight))
    setPaneHeight(element.clientHeight)
    return () => observer.dispose()
  }, [summaryOnly])
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
  const drawn = useRef(count)
  useEffect(() => {
    if (count < drawn.current) { drag.current?.frame?.(); drag.current = undefined }
    drawn.current = count
  }, [count])
  const pendingFocus = useRef<{ readonly closed: EntryKey; readonly next: EntryKey } | undefined>(undefined)
  const close = useCallback((key: EntryKey) => {
    const stack = stackRef.current, list = results.getSnapshot()[tabId]?.sets ?? []
    const gone = new Set(results.closing(tabId, key).map(entry => entry.key))
    const places = list.flatMap((entry, place) => gone.has(entry.key) ? [place] : [])
    const slot = slots.get(key), table = slot?.group !== undefined && slot.view !== 'table' && slot.view !== 'plan' ? list.find(entry => entry.ordinal === slot.group) : undefined
    const next = table ?? (places.length ? list[places[places.length - 1] + 1] ?? list[places[0] - 1] : undefined)
    const active = stack?.ownerDocument.activeElement
    const own = !active || active === stack?.ownerDocument.body || gone.has(active.closest('.rs-item')?.querySelector('[data-caption-entry]')?.getAttribute('data-caption-entry') ?? '')
    if (own && !next) resultsTab()?.focus({ preventScroll: true })
    const focusedNow = results.getSnapshot()[tabId]?.focused
    if (!results.removeEntry(tabId, key) || !own || !next) return
    const moved = focusedNow !== undefined && gone.has(focusedNow) ? results.getSnapshot()[tabId]?.focused : undefined
    pendingFocus.current = { closed: key, next: moved ?? next.key }
  }, [results, tabId, slots])
  const resultsTab = () => stackRef.current?.closest('.output-panel')?.querySelector<HTMLElement>('[role="tab"][data-output-tab="results"]')
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending || sets.some(entry => entry.key === pending.closed)) return
    pendingFocus.current = undefined
    const stack = stackRef.current, active = stack?.ownerDocument.activeElement
    if (active && active !== stack?.ownerDocument.body && !stack?.contains(active)) return
    const target = stack?.querySelector<HTMLElement>(`[data-caption-entry="${pending.next}"]`) ?? resultsTab()
    target?.focus({ preventScroll: true })
  })

  const focus = (key: EntryKey) => { results.focusEntry(tabId, key); setFocused(key) }
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
  const toggle = useCallback((key: EntryKey) => {
    const next = new Set(view.collapsed)
    if (!next.delete(key)) next.add(key)
    setCollapsedState(next)
    results.setCollapsed(tabId, next)
  }, [view, results, tabId])
  const revealSeq = search?.reveal ?? 0, revealEntry = search?.revealEntry
  const stackReveal = useRef<EntryKey | undefined>(undefined)
  useLayoutEffect(() => {
    if (revealEntry === undefined || !sets.some(entry => entry.key === revealEntry) || !resultsSearch.pendingReveal(tabId, revealEntry)) return
    if (collapsedEntries.has(revealEntry)) toggle(revealEntry)
    stackReveal.current = revealEntry
  }, [revealSeq, revealEntry])
  const revealAtMount = useRef(revealFocused)
  useLayoutEffect(() => {
    const key = tab.focused
    if (!revealAtMount.current || key === undefined || !sets.some(entry => entry.key === key)) return
    revealAtMount.current = false
    if (collapsedEntries.has(key)) toggle(key)
    stackReveal.current = key
  }, [])
  const [revealTick, setRevealTick] = useState(0)
  const revealAsked = useRef<EntryKey | undefined>(undefined), commandFocus = useRef<EntryKey | undefined>(undefined)
  useEffect(() => {
    const take = () => { const key = stackReveals.take(tabId); if (key !== undefined) { revealAsked.current = key; setRevealTick(tick => tick + 1) } }
    take()
    const requests = stackReveals.subscribe(requested => { if (requested === tabId) take() })
    return () => requests.dispose()
  }, [tabId])
  useLayoutEffect(() => {
    const key = revealAsked.current
    revealAsked.current = undefined
    if (key === undefined || !sets.some(entry => entry.key === key)) return
    if (collapsedEntries.has(key)) toggle(key)
    setFocused(key)
    stackReveal.current = key
    const stack = stackRef.current, active = stack?.ownerDocument.activeElement
    commandFocus.current = stack && active && stack.contains(active) ? key : undefined
  }, [revealTick])
  useLayoutEffect(() => {
    const key = commandFocus.current, stack = stackRef.current
    if (key === undefined || !stack) return
    const active = stack.ownerDocument.activeElement
    if (!sets.some(entry => entry.key === key) || (active && active !== stack.ownerDocument.body && !stack.contains(active))) { commandFocus.current = undefined; return }
    const grid = stack.querySelector<HTMLElement>(`[data-result-entry="${CSS.escape(key)}"]`)
    if (!grid) return
    commandFocus.current = undefined
    grid.focus({ preventScroll: true })
  })
  useLayoutEffect(() => {
    const element = stackRef.current, key = stackReveal.current
    if (key === undefined) return
    const index = sets.findIndex(entry => entry.key === key)
    if (index < 0) { stackReveal.current = undefined; return }
    if (!element || index >= layout.offsets.length || collapsed.has(index) || paneHeight <= 0) return
    stackReveal.current = undefined
    const top = revealScrollTop(layout, index, element.scrollTop, element.clientHeight)
    if (top === undefined) return
    element.scrollTop = top
    view.stackScrollTop = element.scrollTop
  }, [revealSeq, revealEntry, revealTick, layout, collapsed, paneHeight, sets])
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

  // Pure-DDL/DML multi-server run (0 result sets): render full MultiRunSummary so Stacked layout is never blank.
  if (summaryOnly) {
    return <div ref={stackRef} className="rs-stack rs-stack-summary">
      <MultiRunSummary tabId={tabId} tab={tab} active />
    </div>
  }

  const budget = tab.summary?.budget ?? tab.multiSummary?.budget
  const items = []
  for (let index = first; index <= last; index++) {
    const entry = sets[index]
    if (!entry) continue
    const shut = collapsed.has(index), slot = slots.get(entry.key), sort = tab.sorts.get(entry.key)
    const plain = bare || captionless
    items.push(<div key={`item-${entry.key}`} className="rs-item" data-collapsed={shut || undefined} style={{ top: layout.offsets[index], height: layout.heights[index] }}>
      {!plain && <ResultCaption tabId={tabId} tab={tab} entry={entry} collapsed={shut} totalBatches={tab.totalBatches} sort={sort} running={tab.status === 'running'} others={slot?.others ?? ''} named={!!slot?.named} {...slot?.view === 'pivot' && !tab.bare ? { pivotOf: slot.group, pivotSource: slot.source, stale: !!slot.stale } : {}} onToggle={toggle} onClose={closable ? close : undefined} />}
      {!shut && <EntryNoticeBars tabId={tabId} tab={tab} entry={entry} running={tab.status === 'running'} />}
      {!shut && mounted.has(entry.key) && <ResultGrid key={setKey(entry.descriptor)} tabId={tabId} entry={entry} count={tab.numbered} focused={entry.key === focused} budget={budget} sort={sort}
        view={slot?.view} group={slot?.group} bare={tab.bare} onFocus={focus} onWide={wide} />}
    </div>)
    if (index < count - 1) {
      const top = layout.offsets[index] + layout.heights[index]
      if (!splitterMoves(count, index, collapsed)) { items.push(<div key={`splitter-${entry.key}`} className="rs-splitter" role="separator" aria-orientation="horizontal" data-inert="" style={{ top }} />); continue }
      const height = Math.round(layout.heights[index])
      items.push(<div key={`splitter-${entry.key}`} className="rs-splitter" role="separator" aria-orientation="horizontal" aria-label={`Resize ${entryTitle(entry)}`}
        aria-valuenow={height} aria-valuemin={Math.round(floors[index])} aria-valuemax={Math.round(Math.max(floors[index], layout.heights[index] + layout.heights[index + 1] - floors[index + 1]))}
        aria-valuetext={`${entryTitle(entry)} height ${height} pixels`} tabIndex={0} style={{ top }}
        onPointerDown={event => splitterDown(index, event)} onPointerMove={splitterMove} onPointerUp={splitterUp} onLostPointerCapture={() => { drag.current = undefined }}
        onDoubleClick={() => setWeights(undefined)} onKeyDown={event => splitterKey(index, event)} />)
    }
  }

  const jumpToTarget = (targetKey: string) => {
    const entry = sets.find(item => item.descriptor.targetKey === targetKey) ?? tab.sets.find(item => item.descriptor.targetKey === targetKey)
    if (!entry) return
    if (effectiveStmt !== 'all' && (entry.descriptor.statementSlot ?? 0) !== effectiveStmt) setSelectedStmt('all')
    if (collapsedEntries.has(entry.key)) toggle(entry.key)
    focus(entry.key)
    stackReveal.current = entry.key
    setRevealTick(tick => tick + 1)
  }

  const multiOutcome = multi ? multiOutcomeInfo(tab) : undefined
  const okCount = multi ? tab.multi!.targets.filter(target => target.phase === 'committed' || target.phase === 'succeeded').length : 0

  const stackEl = <div ref={stackRef} className="rs-stack" onFocus={trackFocus} onBlur={trackBlur} onScroll={event => { view.stackScrollTop = event.currentTarget.scrollTop; setScrollTop(event.currentTarget.scrollTop) }}>
    <div className="rs-content" style={{ height: layout.total }}>{items}</div>
  </div>

  if (!multi) return stackEl

  return <div className="rs-multi-root">
    {multiOutcome && <div className="rs-multi-summary-band" data-open={summaryOpen || undefined}>
      <button type="button" className="rs-multi-summary-toggle" aria-expanded={summaryOpen} onClick={() => setSummaryOpen(open => !open)}>
        <Icon name={summaryOpen ? 'chevron-down' : 'chevron-right'} />
        <span className="multi-mode-pill" data-mode={tab.multi!.mode}>{multiModeLabel(tab.multi!.mode)}</span>
        <span className="multi-outcome-badge" data-tone={multiOutcome.tone}>
          <Icon name={multiOutcome.icon} spin={multiOutcome.icon === 'loading'} /><strong>{multiOutcome.label}</strong>
        </span>
        <span className="rs-multi-summary-facts">{formatCount(okCount)}/{formatCount(tab.multi!.targets.length)} {plural(tab.multi!.targets.length, 'server')}</span>
      </button>
      {summaryOpen && <MultiRunSummary tabId={tabId} tab={tab} compact onSelectTarget={jumpToTarget} />}
    </div>}
    {statementSlots.length > 1 && <div className="rs-stmt-strip" role="region" aria-label="Filter stacked results by statement">
      {statementSlots.length > 5
        ? <select className="rs-stmt-select" aria-label="Statement" value={String(effectiveStmt)} onChange={event => setSelectedStmt(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
            <option value="all">All statements ({formatCount(statementSlots.length)})</option>
            {statementSlots.map(item => <option key={item.slot} value={String(item.slot)}>{item.label}</option>)}
          </select>
        : <div className="rs-stmt-buttons" role="group" aria-label="Statements">
            <button type="button" className="rs-stmt-btn" aria-pressed={effectiveStmt === 'all'} onClick={() => setSelectedStmt('all')}>All statements</button>
            {statementSlots.map(item => <button key={item.slot} type="button" className="rs-stmt-btn" aria-pressed={effectiveStmt === item.slot} onClick={() => setSelectedStmt(item.slot)}>{item.label}</button>)}
          </div>}
    </div>}
    {stackEl}
  </div>
}
