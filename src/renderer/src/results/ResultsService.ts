import { limits as wire, type ErrorCode } from '../../../shared/ipc/wire/protocol'
import { cycleSortKeys, sortKeysBy, type SortDirection } from '../grid/sort-keys'
import { multiQueryTargetStatuses, type DiffKindName, type MessageEntry, type QueryEvent, type QueryMultiResult, type QueryMultiStatus, type QueryResult, type QueryStatus, type ResolvedGroupsFilter, type ResolvedViewFilter, type ResultColumn, type ResultDescriptor, type ResultsJobProgress, type ResultsRemoteQueryParams, type VariaApi, type ViewFilter, type ViewSortKey, type ViewSortMode } from '../../../shared/contracts'
import type { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import { requestFrame } from '../core/windows'
import { gridLimits as g } from '../grid/constants'
import { columnSelection, copyPlan, noColumnName, resolveBlocks, selectAll, transposedCopyPlan, type GridSelection } from '../grid/selection'
import { kindInfo } from '../documents'
import type { DocumentService, TextDocument } from '../services/documents'
import type { DistinctList, ResultClient, ResultHandle, ResultView } from './ResultClient'
import type { ResultKey } from './worker-protocol'
import { sortKindOf } from '../../../shared/results/sort-kind'
import { completionSentence, formatCount, plural } from './status'
import { columnFilterKind, conditionFilter, conditionKind, sameFilterFamily, type ColumnCondition } from './column-filter'
import { retainedPlanLimits, type RetainedPlansService, type SnapshotSource } from '../plans/RetainedPlansService'
import { orderPlanEntries } from '../plans/sources'
import { ResultOperations, type OperationTicket } from './operations'
import { nameMeetsOthers, sameFileName, saveName, type SaveSubject } from './save-names'
import { isHiddenColumn, visibleColumnCount } from '../grid/hidden-columns'
import type { DiffUnit } from '../grid/diff-navigation'
import { isRemoteHandle, isRemoteView, RemoteDeclined, remoteStop, remoteOrderable, remoteSelectionText, unorderableText, type RemoteViews } from './remote-views'
import type { MemoryUsage } from './memory'
import type { SampleMethod } from '../../../shared/bigquery/remote-view'
import { sampleName } from './sample'
import { applyMultiOutcomes, applyTargetStateEvent, initialMultiTargetStates, type BeginRunOptions, type MultiResultsSink, type MultiRunEnd, type MultiRunState, type MultiTargetLiveState } from './multi-results-contract'

export type { BeginRunOptions, MultiResultsSink, MultiRunEnd, MultiRunState, MultiTargetLiveState }
/** Sentinel entry key for a multi-server run's virtual Summary tab. */
export const summaryEntryKey: EntryKey = '__summary__'

export type RunStatus = 'running' | QueryStatus | 'lost' | 'closed'
/**
 * An entry's key: an opaque id ResultsService mints when the entry joins its run, unique in the window and never reused.
 * It is not `setKey`: an entry maps to the stored result it currently shows, and state that belongs to the entry (its sort,
 * views, grid state, jobs) is kept by this key, so it stays with the entry when the entries around it come and go.
 */
export type EntryKey = string
/**
 * One result set of the run, named everywhere by its `key` (the grid's `data-result-entry`), never by its place in the
 * list. `ordinal` is an original result's number in its run (`descriptor.index + 1`); a result Varia made (a pivot, a
 * diff) has none. `number` is what the entry is numbered by where it has no name of its own ("Result 4" in
 * its caption, on a job's strip, in a save's suggested name): the ordinal, or for a derived entry the next number after
 * the run's highest when it was appended, fixed for its life. That is the place it was appended at, and stays unique when
 * an entry before it has gone.
 */
export interface ResultSetEntry {
  readonly key: EntryKey; readonly ordinal?: number; readonly number: number
  readonly descriptor: ResultDescriptor; readonly handle: ResultHandle; readonly capturedPlan?: true; readonly label?: string
  /** A sample of a windowed BigQuery result (Load sample): a group of its own, its `label` its name everywhere it shows
   *  ("Sample: 1,000 of 52,341,118 rows"), so what is built from it says it is a sample. */
  readonly sample?: true
}
type Named = Pick<ResultSetEntry, 'label' | 'number' | 'sample'> & { readonly descriptor?: Pick<ResultDescriptor, 'name'> & Partial<Pick<ResultDescriptor, 'kind' | 'targetKey'>> }
// One naming function for every results surface (docs/named-result-sets-scope.md, Where the name shows): an entry's name,
// and apart from it its positional text, so a surface shows either or both. An unnamed result reads as it always has.
/** An entry's positional text, "Result 4" by its number: every entry has one, named or not, and two results of one name
 *  are told apart by it. */
export const entryNumber = (entry: Pick<ResultSetEntry, 'number'>): string => `Result ${entry.number}`
/** A Pivot's name, from its Table's ("Pivot of Result 3", "Pivot of Open orders"). */
export const pivotName = (source: string): string => `Pivot of ${source}`
/** A comparison's name, old side first ("Differences: Result 1 → Result 3"). */
export const comparisonName = (old: string, neu: string, exact = false): string => `Differences: ${old} → ${neu}${exact ? exactSuffix : ''}`
/** What a comparison with Exact text on adds to its name, its tab label and its caption. */
export const exactSuffix = ' (exact text)'
/** The name the query gave an original result with a `#Name` marker, if it gave one. A Pivot's or a comparison's
 *  descriptor never carries one. */
export const queryName = (entry: Named): string | undefined => entry.descriptor?.name || undefined
/** An entry's name: its label (the query's #Name for an original result, or Varia's name for one it made, "Pivot of
 *  Result 3"), else "Result N" by its number. */
export const entryName = (entry: Pick<ResultSetEntry, 'label' | 'number'>): string => entry.label ?? entryNumber(entry)
/** An original result's own title where its number named it before names existed (its splitter, its plans, its copy and
 *  save jobs, the Column Profile): the query's name for it with its number ("Totals, Result 3"), so two of one name are
 *  told apart, else "Result N". Unlike
 *  `entryName` it never takes a Pivot's or a comparison's label, so those read as they did. */
export const resultTitle = (entry: Named): string => {
  // A sample is named for what it is wherever an original result would be numbered, so its profile or copy says so.
  if (entry.sample) return entryName(entry)
  const name = queryName(entry)
  return name === undefined ? entryNumber(entry) : `${name}, ${entryNumber(entry)}`
}
/** What a surface that names an original result by its title (its splitter, its plans, the Column Profile and its
 *  operation) calls any entry: an original result by `resultTitle`, a Pivot or a comparison by its own name ("Differences:
 *  Result 1 → Result 3"), never by the number a derived entry was given, which no one sees elsewhere. */
export const entryTitle = (entry: Named): string => entry.descriptor?.kind === 'diff' || entry.descriptor?.kind === 'pivot' ? entryName(entry) : resultTitle(entry)
/** The positional text a named result shows beside its name ("Result 2": secondary text in a list, a caption's first fact,
 *  a tooltip), or undefined for an entry whose name already is its number or carries its source's (a Pivot, a comparison). */
export const entrySecondary = (entry: Named): string | undefined =>
  queryName(entry) !== undefined || entry.descriptor?.targetKey !== undefined || entry.descriptor?.kind === 'combined' ? entryNumber(entry) : undefined
/** A named entry's name with its number ("Totals · Result 2"), an unnamed one's name alone: for places that list results
 *  and must tell two of one name apart without room for secondary text. */
export const numberedName = (entry: Named): string => {
  const number = entrySecondary(entry)
  return number ? `${entryName(entry)} · ${number}` : entryName(entry)
}
/** Two compared results' names, for a comparison's title: each its name, and each with its number when the two names are
 *  the same ("Totals (Result 1)" and "Totals (Result 3)"), so the title says which way round it is. Unnamed results'
 *  names are their numbers, which never collide. */
export const comparedNames = (old: Named, neu: Named, sets: readonly Named[] = [old, neu]): [string, string] => [distinctName(old, [...sets, old, neu]), distinctName(neu, [...sets, old, neu])]
/** An entry's name, with its number when another of the run's results has the same name ("Totals (Result 3)"): for the
 *  titles a Pivot or comparison takes from its sources, and their sources' links, so two of one name are told apart.
 *  Unnamed results, Pivots and comparisons keep their names, so theirs read as before. */
export const distinctName = (entry: Named, sets: readonly Named[]): string => {
  const name = entryName(entry)
  // Only a name the query gave (or a multi-server target/combined label) takes the number on collision: an unnamed
  // single-server result keeps "Result 2" even when a marker named another result "Result 2", which then reads "Result 2 (Result 1)".
  if (queryName(entry) === undefined && entry.descriptor?.targetKey === undefined && entry.descriptor?.kind !== 'combined') return name
  return sets.some(other => other.number !== entry.number && entryName(other) === name) ? `${name} (${entryNumber(entry)})` : name
}
/** An entry's accessible name: a named result's name with its number ("Totals, Result 3"), so two tabs, captions or
 *  buttons of one name are told apart by a screen reader; anything else its name alone. */
export const spokenName = (entry: Named): string => {
  const number = entrySecondary(entry)
  return number ? `${entryName(entry)}, ${number}` : entryName(entry)
}
/** Whether a slot shows a name the query gave: a named Table, or a Pivot or comparison made from a named result (its frozen
 *  sources' names are not their numbers). Only such a slot's tab and caption take the long-name ellipsis rules, so an
 *  unnamed result's are laid out exactly as they were before names. */
export const slotNamed = (slot: Pick<ResultSlot, 'view' | 'entry' | 'sources'>): boolean =>
  slot.view === 'table' ? queryName(slot.entry) !== undefined : slot.sources.some(source => source.name !== entryNumber(source))
/** The entry of `sets` with the key, for a consumer that holds a published list (the service looks its own up in a map). */
export const entryOf = (sets: readonly ResultSetEntry[] | undefined, key: EntryKey | undefined): ResultSetEntry | undefined =>
  key === undefined ? undefined : sets?.find(entry => entry.key === key)
/** How a slot shows its result: a group's Table (the original result) or its Pivot, or a comparison. Transposed is not a
 *  view kind: it is how a Table or a Pivot is drawn (its grid state's orientation). */
export type ViewKind = 'table' | 'pivot' | 'comparison'
/**
 * What a derived slot was made from, frozen when it was made and kept apart from the source's handle: the source's entry
 * key and set key (for telling whether it is still that exact result), and the number and name it had. A closed or
 * replaced source leaves the reference as it was.
 */
export interface SourceRef { readonly key: EntryKey; readonly set: string; readonly number: number; readonly name: string; readonly ordinal?: number }
/**
 * What a Pivot was built from, recorded when its build publishes and kept with its slot: the recipe (row columns, column
 * group, values, in the Table's columns), the Table's resolved filters the build applied (none when it read the stored
 * rows), the rows it read, and whether the Table was cut short (truncated, incomplete) or long values were grouped by a
 * prefix (approximate), and how long it took (`buildMs`). PR 11 compares `filters` with the Table's to say the Pivot is out
 * of date; PR 17 rebuilds it by itself when it is shown, small and quick enough.
 */
export interface PivotProvenance {
  readonly recipe: { readonly rows: readonly number[]; readonly column?: number; readonly values: readonly { readonly aggregate: string; readonly column?: number }[] }
  /** Source Table's column names at build time so updating over a replaced source (e.g. a rebuilt Combined view) can
   *  remap column indices by name instead of sending stale numeric positions. */
  readonly sourceColumns?: readonly string[]
  readonly filters: readonly ResolvedViewFilter[]
  readonly inputRows: number
  readonly truncated: boolean
  readonly incomplete: boolean
  readonly approximate: boolean
  /** How long the build took in milliseconds, from taking its place to its answer (its waits left out): under
   *  `pivotFollow.maxLastBuildMs` the Pivot may rebuild by itself when its Table's filters change. */
  readonly buildMs?: number
  /** The Pivot rebuilt by itself, following its Table's filters (nobody clicked): Tabs does not select it for that. */
  readonly followed?: true
}
/**
 * A presentation slot: one view the stack draws. Its identity is `key`, the key of the entry it shows, which is also where
 * its grid state lives (`ResultsService.gridState(tabId, key)`: scroll, widths, selection, orientation) and its sort and
 * filters (`TabResults.sorts`). `entry` is the stored result it shows now and `revision` counts the results the slot has
 * shown (a group's second Pivot is revision 2). `sources` is its provenance: none for a Table, the Table for a Pivot, and
 * the old and the new input, in that order, for a comparison.
 */
export interface ResultSlot {
  readonly key: EntryKey; readonly view: ViewKind; readonly entry: ResultSetEntry; readonly revision: number
  /** The ordinal of the group it belongs to; a comparison belongs to none. */
  readonly group?: number
  readonly sources: readonly SourceRef[]
  /** A Pivot's provenance, from its latest build. */
  readonly pivot?: PivotProvenance
  /** A comparison's place among the run's comparisons in the order made, fixed for its life ('Differences2' in a saved
   *  file's name, even after the first was closed). */
  readonly made?: number
}
/**
 * An original result and what was made of it: named by its `ordinal` ("Result 3"), with the batch it came from, its Table,
 * at most one Pivot, and the view of the two that last had the focus (`selected`). A SQL-returned plan set is a group too
 * (`planSet`), with Pivot, Compare and Transposed off.
 */
export interface ResultGroup {
  readonly ordinal: number; readonly batchNumber: number; readonly iteration: number; readonly planSet: boolean
  readonly table: ResultSlot; readonly pivot?: ResultSlot
  readonly selected: 'table' | 'pivot'
}
type Shape = Pick<TabResults, 'groups' | 'comparisons'>
/** The slot that shows the entry `key`, in a published run. */
export function slotOf(tab: Shape | undefined, key: EntryKey | undefined): ResultSlot | undefined {
  if (!tab || key === undefined) return undefined
  for (const group of tab.groups) {
    if (group.table.key === key) return group.table
    if (group.pivot?.key === key) return group.pivot
  }
  return tab.comparisons.find(slot => slot.key === key)
}
/** The group the entry `key` belongs to (as its Table or its Pivot); a comparison has none. */
export function groupOf(tab: Pick<TabResults, 'groups'> | undefined, key: EntryKey | undefined): ResultGroup | undefined {
  if (!tab || key === undefined) return undefined
  return tab.groups.find(group => group.table.key === key || group.pivot?.key === key)
}
/** What a resolved filter keeps, in a form two of them compare by values, never by the snapshot or cells that made it: a
 *  `groups` filter by its digest (the backend's hash of its column, keep or drop, NULL and its values' rows), a value
 *  filter by its rows in any order and a range by its two in order (the backend resolves each value to its lowest row). */
const filterIdentity = (filter: ResolvedViewFilter): string => {
  switch (filter.op) {
    case 'groups': return `groups:${filter.digest}`
    case 'duplicates': return `duplicates:${filter.columns.join(',')}`
    case 'keepRows': return `keepRows:${[...filter.rows].sort((a, b) => a - b).join(',')}`
    case 'kind': return `kind:${[...filter.kinds].sort().join(',')}`
    case 'between': return `between:${filter.column}:${filter.nulls}:${filter.rows.join(',')}`
    default: return `${filter.op}:${filter.column}:${filter.nulls}:${[...filter.rows].sort((a, b) => a - b).join(',')}`
  }
}
/** A list of filters as what it keeps: each keeps rows among those the ones before it kept, which is an intersection, so
 *  the order matters only around a duplicates filter (it counts the rows it is given). The runs between duplicates
 *  filters are sorted, and each duplicates filter stays where it is. */
export const filtersIdentity = (filters: readonly ResolvedViewFilter[]): string => {
  const parts: string[] = []
  let run: string[] = []
  for (const filter of filters) {
    if (filter.op !== 'duplicates') { run.push(filterIdentity(filter)); continue }
    parts.push(...run.sort(), filterIdentity(filter))
    run = []
  }
  return [...parts, ...run.sort()].join('|')
}
/** Whether two lists of resolved filters keep the same rows: the same filters by the values they keep, in any order between
 *  duplicates filters (re-applying a filter moves it last). Ticking the same values again, or filtering by other cells of
 *  the same values, changes nothing. A filter's words are not part of it. */
export function sameFilters(a: readonly ResolvedViewFilter[], b: readonly ResolvedViewFilter[]): boolean {
  return a.length === b.length && filtersIdentity(a) === filtersIdentity(b)
}
/** The resolved filters of the view a Table's grid shows now: none while it shows its stored rows (or only the first view
 *  is still being built). A view being built does not count until it shows, so the Pivot's mark changes with the grid. */
export function shownFilters(tab: Pick<TabResults, 'sorts'>, key: EntryKey): readonly ResolvedViewFilter[] {
  return tab.sorts.get(key)?.view?.filters ?? []
}
/**
 * Whether a group's Pivot is out of date: the Table's stored result was replaced in place (e.g. a rebuilt Combined view)
 * or the Table's resolved filters, as its grid shows them now, differ from those the Pivot's last build recorded (its
 * provenance). Row order changes no aggregate, so a sort alone does not count, nor does a filter's label being named
 * later. A Pivot with no provenance (none is published without one) is never marked.
 */
export function pivotOutOfDate(tab: Pick<TabResults, 'sorts'>, group: Pick<ResultGroup, 'table' | 'pivot'> | undefined): boolean {
  const built = group?.pivot?.pivot
  if (!group || !built) return false
  const sourceSet = group.pivot?.sources[0]?.set
  if (sourceSet !== undefined && sourceSet !== setKey(group.table.entry.descriptor)) return true
  return !sameFilters(built.filters, shownFilters(tab, group.table.key))
}
/** Whether a tab run has multi-server summary cards to show (live or settled). */
export const hasMultiSummary = (tab: Pick<TabResults, 'multi'> | undefined): boolean => !!tab?.multi && tab.multi.targets.length > 0
/** Whether a multi-server run's virtual Summary tab is the active view (always true when there are 0 result sets). */
export const isSummaryActive = (tab: Partial<Pick<TabResults, 'multi' | 'activeSummary' | 'sets' | 'focused'>> | undefined): boolean =>
  !!tab && hasMultiSummary(tab) && (tab.activeSummary === true || tab.focused === summaryEntryKey || (tab.sets?.length ?? 0) === 0)
/** Looks up the participating multi-server target metadata for a result entry. */
export const targetOfEntry = (tab: Pick<TabResults, 'multi'> | undefined, entry: Pick<ResultSetEntry, 'descriptor'> | undefined): MultiTargetLiveState | undefined => {
  const targetKey = entry?.descriptor.targetKey
  return targetKey ? tab?.multi?.targets.find(target => target.targetKey === targetKey) : undefined
}
/** The view the Tabs layout shows: undefined when Summary is active, else the entry whose grid last had the focus, else the run's first. */
export function selectedEntry(tab: Pick<TabResults, 'sets' | 'focused'> & Partial<Pick<TabResults, 'multi' | 'activeSummary'>>): ResultSetEntry | undefined {
  if (isSummaryActive(tab)) return undefined
  return entryOf(tab.sets, tab.focused) ?? tab.sets[0]
}
/**
 * A grid's sort and filters (results.view): its keys in order, with the text mode each was sorted by, its filters, and the
 * view the grid shows. While a view is built (`sorting`) the grid keeps showing what it showed; a failed one keeps the last
 * view, its keys and filters. `stale` is a view built while rows were still arriving: it is built again once they are all in.
 */
export interface GridSort {
  readonly keys: readonly ViewSortKey[]
  /** In order; each keeps rows among those the ones before it kept. */
  readonly filters: readonly GridFilter[]
  /** The filters `view` applied: a failed view goes back to them. */
  readonly applied: readonly GridFilter[]
  readonly view?: ResultView
  readonly sorting: boolean
  readonly approximate: boolean
  readonly stale: boolean
}
/** A grid filter: what the view is asked for (selected cells until the view resolves them to rows) and its words. */
export interface GridFilter {
  readonly filter: ViewFilter
  readonly label: string
  /** The label already says all it will (its values named, or none to name): building the view again reads none. */
  readonly named?: true
  /** A `groups` filter's distinct snapshot, which the grid keeps while a filter of its sort names it and then closes. */
  readonly list?: DistinctList
}
/** What a selection filters by: its values, other values, the range from its lowest to its highest, or no NULL in its column. */
export type SelectionFilter = 'in' | 'notIn' | 'between' | 'notNull'
/** How a header click or a command changes a column's place in the sort. */
export type { SortDirection } from '../grid/sort-keys'
/** A set that has all its rows, for sizing the stack to them: its rows, and whether its grid shows a strip (truncated or incomplete). */
export interface SettledSet { readonly rows: number; readonly strip: boolean }
/** The output pane's views: the stacked grids, Messages, and the run's execution plans (shown only when it returned some). */
export type OutputViewName = 'results' | 'messages' | 'plan' | 'statistics'
/** A set's key in a run: its generation and result id. */
export const setKey = (descriptor: Pick<ResultDescriptor, 'generation' | 'resultId'>): string => descriptor.generation + ':' + descriptor.resultId
/**
 * A copy or save of one result set. Its strip shows once it has run for 300 ms (`visible`); a save's clock starts when
 * main reports its file (`fileName`), after the save dialog closed.
 */
export interface ResultJob {
  readonly jobId: string; readonly kind: 'copy' | 'save'; readonly label: string
  /** The entry it copies or saves. */
  readonly entry: EntryKey
  readonly rowsDone: number; readonly rowsTotal: number; readonly startedAt: number; readonly visible: boolean; readonly fileName?: string
  /** The job writes a grid drawn transposed: its progress counts the result's columns (its lines), not rows. */
  readonly columns?: boolean
}
/** What the output pane shows for one query tab. */
export interface TabResults {
  readonly queryId: string; readonly startedAt: number; readonly status: RunStatus
  /** Every entry the stack draws, in the order drawn: each group's Table, its Pivot under it, then the next group;
   *  comparisons last. `groups` and `comparisons` say what each is. */
  readonly sets: readonly ResultSetEntry[]
  /** The run's original results, by ordinal, each with its views. */
  readonly groups: readonly ResultGroup[]
  /** The comparisons, in the order made: each a slot of its own, after the groups. */
  readonly comparisons: readonly ResultSlot[]
  /** The entry whose grid last had the focus; undefined until one has. */
  readonly focused?: EntryKey
  /** A run drawn bare (Peek's rows): the grid alone, and no Pivot, Compare or close. */
  readonly bare?: true
  readonly planSets: readonly ResultSetEntry[]
  readonly messages: readonly MessageEntry[]; readonly messagesTruncated: boolean; readonly rowsRead: number
  /** How many of `messages`, first, are Varia's own notices (a new session) rather than SQL Server's. */
  readonly notices: number
  readonly completedBatches: number; readonly totalBatches: number; readonly summary?: QueryResult; readonly error?: string
  readonly view: OutputViewName; readonly manualView: boolean; readonly jobs: readonly ResultJob[]; readonly announcement: string
  /** Whether the Messages strip under the results is open: it opens itself when an error, PRINT or RAISERROR output arrives,
   *  until the user opens or closes it in this run (`stripChosen`). Only the user's choice opens it in a pane too short to show it. */
  readonly strip: boolean
  readonly stripChosen: boolean
  /** When the run ended, for its duration when it has no summary (main failed it, or the backend was lost). */
  readonly endedAt?: number
  /** How a run whose results were closed had ended. */
  readonly closedFrom?: Exclude<RunStatus, 'running' | 'closed'>
  /** The sets that have all their rows, by `setKey`. */
  readonly settled: ReadonlyMap<string, SettledSet>
  /** When `announcement` was set, on a counter that only grows (0 before the run's first), so the live region reads out
   *  only sentences newer than the moment it was shown. */
  readonly announced: number
  /** How the last save ended ("Saved 400 rows to results.csv."), shown in the toolbar for a few seconds; '' otherwise. */
  readonly jobNotice: string
  /** Each sorted grid's sort, by entry key. */
  readonly sorts: ReadonlyMap<EntryKey, GridSort>
  /** The highest number an entry of the run was given: the M of a grid's "Result N of M", which closing a result does not
   *  lower (so no grid reads "Result 3 of 2"). */
  readonly numbered: number
  /** The run's last result was closed one at a time (not by Close Results): its status and summary stay as they were, and
   *  the Results view stays, saying so, in place of "returned no result sets". Captured plans are not affected. */
  readonly emptied?: true
  /** The run was made with Discard results after execution on: its sets were read and none kept (plans are), so the
   *  Results view says so in place of grids, whatever the setting is now. */
  readonly discard?: true
  /** A view made only to show Messages lines written outside any execution (`addMessage`): no run summary is drawn. */
  readonly messagesOnly?: true
  /** Windowed BigQuery results loading into memory, by entry key, and whether Stop was asked. */
  readonly loads?: ReadonlyMap<EntryKey, { readonly stopping: boolean; readonly kind?: AuxiliaryKind }>
  /** Multi-server / cross-engine run state (live target phases + terminal outcomes + combine warnings). */
  readonly multi?: MultiRunState
  /** Authoritative multi-server completion summary once the run settles. */
  readonly multiSummary?: QueryMultiResult
  /** True when a multi-server run's virtual Summary tab is active. */
  readonly activeSummary?: true
  /** Combined result entries whose underlying server results changed (e.g. closed, loaded into memory, or re-run) and can be rebuilt or closed. */
  readonly staleCombined?: ReadonlySet<EntryKey>
  /** Combine warnings tracked per Combined entry key so rebuilding one statement slot never wipes another slot's warnings. */
  readonly combineWarnings?: ReadonlyMap<EntryKey, readonly string[]>
}
/** One grid's view, outside React and never in a snapshot: it survives tab switches, Ctrl+R and unmounting. */
export interface GridViewState {
  topRow: number; virtualTop: number; scrollLeft: number; widths?: Float64Array
  userSized?: Set<number>; sized: boolean; selection?: GridSelection
  /** A follow-tail grid (a live log): whether its last frame showed the last row. A grid built over a state with false
   *  opens where it was rather than at the tail. */
  following?: boolean
  /** How the view is drawn: as a table (absent), or transposed, its columns as rows (ResultsService.setOrientation). */
  orientation?: 'transposed'
  /** Transposed: the column whose value heads each drawn column in place of "Row N" (Using Column as Headers). */
  headerColumn?: number
  /** What the transposed view keeps apart from the table's: its scroll offsets, the width its drawn columns share and the
   *  columns sized apart from it (grid/uniform-layout.ts), whether the first rows have set that width, and the name column's
   *  width once the user has sized it. The selection is the one above, in the result's rows and columns, in both. */
  transposed?: { topRow: number; virtualTop: number; scrollLeft: number; width: number; overrides: Map<number, number>; sized: boolean; nameWidth?: number }
}
/**
 * A tab's stack, all of it by entry key: `weights` are the shares a splitter drag left (used while every entry of the run
 * has one), `focused` the entry whose grid last had the focus, `collapsed` the entries shown as their caption alone (a
 * caption toggles it), `grids` each grid's own state.
 */
export interface TabViewState { stackScrollTop: number; weights?: ReadonlyMap<EntryKey, number>; focused?: EntryKey; grids: Map<EntryKey, GridViewState>; collapsed: ReadonlySet<EntryKey> }
/** How a view is drawn, read from its grid state: transposed or as a table, and, transposed, the column that heads its
 *  drawn columns (Using Column as Headers). */
export interface ViewOrientation { readonly transposed: boolean; readonly headerColumn?: number }
/** The entry kinds a view can be drawn transposed for: a query's rows, a combined multi-server set, and a pivot. Never a
 *  comparison (its tone column marks rows) or a plan set. */
export const turnableKinds: ReadonlySet<string> = new Set(['rows', 'pivot', 'combined'])
/** A mounted grid, for the commands that act on it. */
export interface GridController {
  selectAll(): void; repaint(): void; fitColumn(column: number): void
  /** Transposed: fits the drawn column that shows a row of the result, or, without one, the name column to its names. */
  fitDrawn?(row: number | undefined): void
  /** Opens the header funnel's popover for a column (results grids). */
  filterColumn?(column: number): void
  /** Selects a whole column (in the result's columns) and scrolls it into view, without taking the focus. */
  selectColumn?(column: number): void
  /** A comparison's grid: what moving between its differences reads and does (CompareService.navigate). */
  diff?: DiffGridControls
}
/** A mounted comparison grid, for Go to Next or Previous Difference and Go to Possible Match: its active cell (with whether
 *  its whole row is selected) and that row's tone (undefined while not read), the handle it shows (its sorted or filtered
 *  view, whose positions results.diffSeek then takes), and landing on a change unit (GridView.landDiff). */
export interface DiffGridControls {
  active(): { readonly row: number; readonly column: number; readonly whole: boolean; readonly tone: string | null | undefined } | undefined
  handle(): ResultHandle
  land(row: number, first: DiffUnit, settle: ((tone: string | null) => DiffUnit) | undefined, focus: boolean): void
  /** A row's tone, once its tile has loaded (undefined until then). */
  tone(row: number): string | null | undefined
  /** A row's tone once its tile is read; undefined when it cannot come (GridView.toneWhenRead). */
  toneWhenRead(row: number, signal: AbortSignal): Promise<string | null | undefined>
}
/** How a run ended: the summary (single or multi-server), or main's failure (`code` BACKEND_LOST when the backend stopped), plus a notice to show first. */
export type RunEnd = MultiRunEnd
/** Open Value in New Tab's outcome: whether a document opened, and what the banner says (a failure, or that it opened unformatted). */
export interface OpenedValue { readonly opened: boolean; readonly message?: string }

/** What the service keeps of a slot beside its entry. */
interface SlotRecord { readonly view: ViewKind; readonly group?: number; readonly revision: number; readonly sources: readonly SourceRef[]; readonly pivot?: PivotProvenance; readonly made?: number }
interface Run {
  readonly tabId: string
  readonly queryId: string
  readonly bare: boolean
  /** Each entry's slot, by entry key. */
  readonly slots: Map<EntryKey, SlotRecord>
  /** The groups whose Pivot last had the focus, by ordinal; the others' Table is selected. */
  readonly selected: Set<number>
  /** The published groups and comparisons, built when asked for after the entries changed. */
  shape?: Shape
  /** The ordinal of the group that had the focus in the tab's previous run: its Table takes the focus when it opens. */
  refocus?: number
  readonly startedAt: number
  status: RunStatus
  sets: ResultSetEntry[]
  planSets: ResultSetEntry[]
  /** The sets' keys, so a thousand sets open in linear time. */
  readonly setKeys: Set<string>
  /** `sets` by entry key. */
  readonly entries: Map<EntryKey, ResultSetEntry>
  /** The highest number an entry of the run was given: a derived entry takes the next. */
  numbered: number
  /** How many comparisons the run made: a comparison is numbered by the next, for its saved file's name. */
  compared: number
  /** `sets` is held by a published snapshot, so the next change copies it first. */
  setsPublished: boolean
  readonly rowsRead: Map<number, number>
  messages: MessageEntry[]
  notices: MessageEntry[]
  messagesTruncated: boolean
  completedBatches: number
  totalBatches: number
  summary?: QueryResult
  error?: string
  view: OutputViewName
  manualView: boolean
  strip: boolean
  stripManual: boolean
  settled: Map<string, SettledSet>
  /** `settled` is held by a published snapshot, so the next change copies it first. */
  settledPublished: boolean
  jobs: ResultJob[]
  announcement: string
  announced: number
  jobNotice: string
  subscription?: Disposable
  endedAt?: number
  closedFrom?: Exclude<RunStatus, 'running' | 'closed'>
  retaining?: Promise<void>
  /** By entry key. Replaced, never changed in place: snapshots share it. */
  sorts: ReadonlyMap<EntryKey, GridSort>
  /** The sort each grid is waiting for, by entry key. */
  readonly sorting: Map<EntryKey, AbortController>
  /** Each grid's views still open (its current one, the one it shows, and those superseded since), by entry key: a view
   *  closes only once the grid shows another or none, so a re-sort keeps painting the old order until the new one is read. */
  readonly held: Map<EntryKey, { shown?: ResultHandle; readonly views: Set<ResultView>; pins?: Map<ResultView, number> }>
  /** Its last entry was closed by `removeEntry`. */
  emptied: boolean
  readonly discard: boolean
  /** Lines written outside the execution (`addMessage`), after its own; the summary does not replace them. */
  notes: MessageEntry[]
  messagesOnly?: true
  /** Loads into memory running (results.remoteQuery), by entry key. Replaced, never changed in place: snapshots share it. */
  loads: ReadonlyMap<EntryKey, RunningLoad>
  /** Multi-server / cross-engine run state. */
  multi?: MultiRunState
  multiSummary?: QueryMultiResult
  /** True when a multi-server run's virtual Summary view is active. */
  activeSummary: boolean
  /** `rolledBackPreview` flags received via `resultSet.meta`, keyed by `setKey`, so out-of-order arrivals still apply. */
  readonly rolledBackIds: Map<string, boolean>
  /** Combined entries whose underlying per-server result sets changed, so UI shows Rebuild/Close. */
  staleCombined: ReadonlySet<EntryKey>
  /** Run-level combine warnings from `multiSummary` when no combined entries were created. */
  baseCombineWarnings: readonly string[]
  /** Combine warnings tracked per Combined entry key. Replaced, never mutated in place: snapshots share it. */
  combineWarnings: ReadonlyMap<EntryKey, readonly string[]>
  /** In-flight `results.combine` rebuilds per combined entry key, aborted on drop or run disposal. */
  readonly combining: Map<EntryKey, AbortController>
}
/** A Load into memory: its own query id (query.cancel stops it) and the subscription to its events. */
/** A query over a windowed result its grid shows running: Load into memory (no kind), Load sample or Re-run, which `abort`
 *  stops (their RemoteViews query cancels itself). */
interface RunningLoad { readonly queryId: string; readonly subscription?: Disposable; readonly stopping: boolean; readonly kind?: AuxiliaryKind; readonly abort?: AbortController }
/** The queries over a windowed result besides Load into memory that its strip shows running, with Stop. */
export type AuxiliaryKind = 'sample' | 'rerun'
/** `handle` and `done`: a save's result, and when it ends (a rebuilt Pivot releases the old one only after its saves). */
interface RunningJob { job: ResultJob; readonly tabId: string; timer?: unknown; handle?: ResultSetEntry['handle']; done?: Promise<void> }

const emptyView = (): TabViewState => ({ stackScrollTop: 0, grids: new Map(), collapsed: new Set() })

/** Result sets a run keeps (the backend keeps the same number) and the Messages entries it shows: the backend's, the errors
 *  it keeps past its cap, and its notes. */
export const resultLimits = { sets: 1000, messages: wire.messages.count + wire.messages.lateErrors + 8 } as const
const unavailable = 'These results are no longer available because the SQL backend restarted.'
const closedResults = 'These results were closed. Execute the query again to see them.'
const stillLoading = 'Save the results after this result set finishes loading.'
const stillSorting = 'Save the results after they are sorted.'
const remoteUnavailable = 'This result is windowed in BigQuery, and this window cannot query BigQuery. Load it into memory first.'
const loadWhileRunning = 'Load the result into memory once its query has finished.'
const sampleWhileRunning = 'Load a sample of the result once its query has finished.'
const rerunWhileRunning = 'Run the result again once its query has finished.'
const busyWindowed = 'This result is already loading or running again in BigQuery. Wait for it, or stop it first.'
/** Load into memory or Load sample on a windowed result BigQuery no longer keeps: only Re-run can help. */
export const expiredRefusal = 'BigQuery no longer keeps this result. Re-run… runs its query again.'
const isExpiredError = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'REMOTE_EXPIRED'
const sampleFull = `These results already show ${resultLimits.sets.toLocaleString('en-US')} sets, so no sample can be added. Close some results first.`
// A view built while rows still arrived whose rebuild from every row was cancelled: nothing builds it again by itself.
const partialView = 'The grid is sorted or filtered over only the rows that had arrived. Sort or filter it again to include every row, then save.'
const saveCancelled = 'Saving was cancelled. The file was not written.'
/** Main's and the backend's own sentences for a save; anything else is prefixed. */
const saveSentences: ReadonlySet<string> = new Set<ErrorCode>(['EXPORT_FAILED', 'JOB_BUSY', 'RESULT_OPEN', 'RESULT_UNAVAILABLE', 'RESULT_NOT_FOUND'])
const sameMessages = (a: readonly MessageEntry[], b: readonly MessageEntry[]) => a.length === b.length && a.every((entry, index) => entry.text === b[index].text && entry.kind === b[index].kind && entry.targetKey === b[index].targetKey && entry.dialect === b[index].dialect && entry.line === b[index].line)
const runStatus = (summary: QueryResult): RunStatus => summary.status
const multiRunStatus = (status: QueryMultiStatus): RunStatus => {
  switch (status) {
    case 'completed': return 'completed'
    case 'completedWithErrors': case 'partialFailure': return 'completedWithErrors'
    case 'cancelled': return 'cancelled'
    case 'timedOut': return 'timedOut'
    case 'rolledBack': case 'commitInDoubt': case 'failed': return 'failed'
  }
}
const terminalMultiTargetPhases: ReadonlySet<string> = new Set(multiQueryTargetStatuses)
/** What Copy and Save read: the result, or its view by id. A sort or filter in BigQuery is a result of its own (viewId 0),
 *  which they read as itself. */
const jobSource = (handle: ResultHandle, view: ResultView | undefined): { generation: number; resultId: number; viewId?: number } =>
  isRemoteView(view) ? { generation: view.key.generation, resultId: view.key.resultId }
    : { generation: handle.key.generation, resultId: handle.key.resultId, ...view ? { viewId: view.viewId } : {} }
/** How many sets a run made with Discard results after execution read and did not keep. */
const discardedSets = (run: Pick<Run, 'discard' | 'summary' | 'multiSummary'>): number => run.discard ? (run.summary?.discardedResultSets ?? run.multiSummary?.discardedResultSets ?? 0) : 0
/** " 3 values were truncated." after a copy or save that wrote values the backend stored cut; '' otherwise. */
const truncatedClause = (cells: number): string => cells > 0 ? ` ${formatCount(cells)} ${cells === 1 ? 'value was' : 'values were'} truncated.` : ''
/** What a transposed copy or save left out: the rows past those a transposed grid draws. */
const cappedClause = (rows: number): string => rows > 0 ? ` ${formatCount(rows)} ${rows === 1 ? 'row' : 'rows'} past the first ${formatCount(wire.transpose.maxRows)} ${rows === 1 ? 'was' : 'were'} left out; filter the results to copy or save others.` : ''
/**
 * How a view is drawn transposed, and so how its Copy and Save are written: undefined for a table, else the column whose
 * values head the drawn columns (when it is one of the result's shown columns). A result with hidden columns (a
 * comparison, a toned live table) is never drawn transposed.
 */
export function transposedView(state: Pick<GridViewState, 'orientation' | 'headerColumn'> | undefined, descriptor: Pick<ResultDescriptor, 'columns'>): { headerColumn?: number } | undefined {
  if (state?.orientation !== 'transposed' || visibleColumnCount(descriptor) < descriptor.columns.length) return undefined
  const header = state.headerColumn
  return header !== undefined && Number.isInteger(header) && header >= 0 && header < descriptor.columns.length ? { headerColumn: header } : {}
}
const held = (set: ResultSetEntry): boolean => { const state = set.handle.getSnapshot().state; return state !== 'lost' && state !== 'released' }
/** The document a link cell opens in: its kind, and the name its tabs count from (SSMS: XML_F52E2B61-…1.xml, ExecutionPlan1.sqlplan). */
const valueKinds: Readonly<Record<string, { kind: TextDocument['kind']; base?: string; extension: string }>> = {
  xml: { kind: 'xml', extension: '.xml' }, json: { kind: 'json', extension: '.json' }, plan: { kind: 'sqlplan', base: 'ExecutionPlan', extension: '.sqlplan' }
}
/**
 * Characters a file name cannot hold become '_', and so do bidirectional controls and line separators, with which a
 * column alias could make 'report\u202egpj.xml' read as another file type; a blank name becomes the kind's ('XML', 'JSON').
 */
function valueBase(column: ResultColumn, kind: TextDocument['kind']): string {
  const name = column.name.replace(/[\\/:*?"<>|\x00-\x1f\x7f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '_').trim().slice(0, 100)
  return name || kindInfo[kind].blankName
}

/**
 * Each query tab's results: the run's result sets (handles from ResultClient, opened as the backend announces them),
 * its streaming Messages, progress, and copy jobs. Events are applied as they arrive and published at most once per
 * frame; the summary is authoritative when the run ends. Results are released when the tab runs again, closes, or the
 * user closes them; changing the connection or database keeps them, as SSMS does.
 */
/** Whether a windowed result's projected size fits the result memory free now. With no projection or no report yet
 *  (globalBytes 0) nothing is held back: the load itself switches back to windowed if the rows do not fit. */
export function fitsFreeMemory(projected: number | undefined, memory: Pick<MemoryUsage, 'usedBytes' | 'globalBytes'> | undefined): boolean {
  if (projected === undefined || !memory || memory.globalBytes <= 0) return true
  return projected <= Math.max(0, memory.globalBytes - memory.usedBytes)
}

export class ResultsService extends SnapshotStore<Readonly<Record<string, TabResults>>> implements Disposable, MultiResultsSink {
  private readonly client: Pick<ResultClient, 'open' | 'onQueryEvent' | 'applySummary' | 'release' | 'onGeneration'> & Partial<Pick<ResultClient, 'combine'>>
  private readonly events: EventBus
  private readonly api: Pick<VariaApi, 'copyResults' | 'saveResults' | 'cancelResultsJob' | 'onResultsJob'> & Partial<Pick<VariaApi, 'remoteQuery' | 'cancel'>>
  private readonly documents: Pick<DocumentService, 'openText'> | undefined
  private readonly retainedPlans?: RetainedPlansService
  /** Sort, filter and value lists of results windowed in BigQuery (remote-views.ts); without it they are refused. */
  private readonly remote?: RemoteViews
  /** How text columns sort (queryResults.grid.sortText). */
  private readonly sortText: () => ViewSortMode
  private readonly memory?: () => Pick<MemoryUsage, 'usedBytes' | 'globalBytes'>
  /** The last number each value tab name used (XML_F52E2B61-…3.xml), for the window's lifetime. */
  private readonly valueNumbers = new Map<string, number>()
  private readonly frame: (callback: () => void) => void
  private readonly timers: Timers
  /** Operations over whole results by tab: the one busy state every result control reads (see ResultOperations). */
  readonly operations: ResultOperations
  private readonly now: () => number
  private readonly newId: () => string
  private readonly runs = new Map<string, Run>()
  private readonly views = new Map<string, TabViewState>()
  /** Each tab's last choice to open or close the Messages strip: a strip the user opened starts open in the next run. */
  private readonly stripChoices = new Map<string, boolean>()
  /** Mounted grids, by entry key. */
  private readonly controllers = new Map<EntryKey, GridController>()
  /** The grids drawn now: from a mount's first viewShown until it unregisters. */
  private readonly drawing = new Set<EntryKey>()
  private readonly dirty = new Set<string>()
  private readonly announcements = new Map<string, unknown>()
  /** The last selection each tab's live region read out: an arrow key that leaves its size unchanged says nothing. */
  private readonly selectionAnnounced = new Map<string, string>()
  /** Values being opened, by entry key, row and column: another click or Enter while one opens opens nothing more. */
  private readonly opening = new Set<string>()
  private readonly subscriptions: (() => void)[] = []
  private readonly noticeTimers = new Map<string, unknown>()
  private copying: RunningJob | undefined
  /** Saves by job id: main allows one per window, but a second request must not lose track of the first. */
  private readonly saves = new Map<string, RunningJob>()
  private readonly contextStore = new (class extends SnapshotStore<Readonly<Record<string, true>>> { set(value: Readonly<Record<string, true>>) { this.publish(value) } clear() { this.clearListeners() } })({})
  /** The tabs whose results can be closed (`hasResults`): result sets or captured plans. It publishes only when that set of
   *  tabs changes. */
  readonly context: ExternalStore<Readonly<Record<string, true>>> = this.contextStore
  private readonly setsStore = new (class extends SnapshotStore<Readonly<Record<string, true>>> { set(value: Readonly<Record<string, true>>) { this.publish(value) } clear() { this.clearListeners() } })({})
  /** The tabs with a result set a grid can show (`hasResultSets`), which Find and Save Results As need: an emptied run that
   *  keeps captured plans is in `context` but not here. It publishes only when that set of tabs changes. */
  readonly resultSets: ExternalStore<Readonly<Record<string, true>>> = this.setsStore
  private readonly steppableStore = new (class extends SnapshotStore<Readonly<Record<string, true>>> { set(value: Readonly<Record<string, true>>) { this.publish(value) } clear() { this.clearListeners() } })({})
  /** The tabs with two or more results or comparisons to step through (`multipleResults`): the browser tab keys in the
   *  results pane act on results only then, and fall through to query tabs otherwise. */
  readonly steppable: ExternalStore<Readonly<Record<string, true>>> = this.steppableStore
  private readonly turnedStore = new (class extends SnapshotStore<Readonly<Record<string, FocusedOrientation>>> { set(value: Readonly<Record<string, FocusedOrientation>>) { this.publish(value) } clear() { this.clearListeners() } })({})
  /** The tabs whose focused grid (the one a command acts on when it names none) is drawn transposed, with that grid's entry
   *  and header column: the `resultsGridTransposed` key and the toolbar's Transposed button. It publishes only when one changes. */
  readonly turned: ExternalStore<Readonly<Record<string, FocusedOrientation>>> = this.turnedStore
  private readonly comparingStore = new (class extends SnapshotStore<Readonly<Record<string, FocusedComparison>>> { set(value: Readonly<Record<string, FocusedComparison>>) { this.publish(value) } clear() { this.clearListeners() } })({})
  /** The tabs whose focused grid is a comparison, with whether both its inputs are still open: the `resultsGridComparison`
   *  and `comparisonInputsOpen` keys. It publishes only when one changes. */
  readonly comparing: ExternalStore<Readonly<Record<string, FocusedComparison>>> = this.comparingStore
  private readonly selectionStore = new (class extends SnapshotStore<number> { bump() { this.publish(this.getSnapshot() + 1) } clear() { this.clearListeners() } })(0)
  /** A revision that changes with any grid's selection (every arrow key): a store of its own, so a selection move redraws
   *  only what follows the selection (the column profile), never everything the service's snapshot feeds. */
  readonly selections: ExternalStore<number> = this.selectionStore
  private scheduled = false
  private disposed = false
  /** The last sample group handed out (negative, counting down), never reused in this window. */
  private sampleGroup = 0
  private announcedCount = 0
  /** Residence switches said by tab whose announcement has not been read out yet: the run's end, within the live region's
   *  delay, would replace it, so it says them too. */
  /** The other sentence waiting in the debounce with unheard switches (announce). */
  private readonly unheardSentence = new Map<string, string>()
  private readonly unheardSwitches = new Map<string, string[]>()
  private minted = 0

  constructor(o: {
    client: Pick<ResultClient, 'open' | 'onQueryEvent' | 'applySummary' | 'release' | 'onGeneration'> & Partial<Pick<ResultClient, 'combine'>>; api: Pick<VariaApi, 'copyResults' | 'saveResults' | 'cancelResultsJob' | 'onResultsJob'> & Partial<Pick<VariaApi, 'remoteQuery' | 'cancel'>>; events: EventBus
    documents?: Pick<DocumentService, 'openText'>; frame?: (callback: () => void) => void; timers?: Timers; now?: () => number; newId?: () => string; retainedPlans?: RetainedPlansService
    sortText?: () => ViewSortMode
    remote?: RemoteViews
    /** Result memory's latest report (MemoryUsageService): Load into memory is offered only while a windowed result's
     *  projection fits the room it has free. Without it (or before a report) nothing is held back. */
    memory?: () => Pick<MemoryUsage, 'usedBytes' | 'globalBytes'>
    /** Calls the listener when settings change; sorted grids sort again when the text mode did. Returns the unsubscribe. */
    onSortTextChange?: (listener: () => void) => () => void
  }) {
    super({})
    this.client = o.client
    this.events = o.events
    this.api = o.api
    this.documents = o.documents
    this.retainedPlans = o.retainedPlans
    this.remote = o.remote
    this.sortText = o.sortText ?? (() => 'value')
    this.memory = o.memory
    let sortText = this.sortText()
    if (o.onSortTextChange) this.subscriptions.push(o.onSortTextChange(() => { const next = this.sortText(); if (next !== sortText) { sortText = next; this.resort() } }))
    this.frame = o.frame ?? (callback => requestFrame(callback))
    this.timers = o.timers ?? browserTimers
    this.now = o.now ?? (() => Date.now())
    this.operations = new ResultOperations({ timers: this.timers, now: this.now })
    this.newId = o.newId ?? (() => crypto.randomUUID())
    const events = o.events.subscribe(event => { if (event.type === 'documents.closed') this.release(event.tabId) })
    // A new backend lost every result: nothing is left to save or close, or to turn back.
    const generations = this.client.onGeneration(() => { this.updateContext(); this.updateTurned(); this.updateComparing() })
    this.subscriptions.push(() => events.dispose(), () => generations.dispose(), this.api.onResultsJob(progress => this.progress(progress)))
  }

  /** A run starts: the tab's previous results are released, its copy cancelled and its selections cleared, and the
   *  run's events are followed from now on (before the script is sent). A running save goes on (the backend leases its
   *  result), so its strip moves to the new run. */
  begin(tabId: string, queryId: string, onSession?: (session: Extract<QueryEvent, { type: 'session.opened' }>) => void, o: BeginRunOptions = {}): void {
    if (this.disposed) return
    // A switch of the run this replaces is not said with the new one's end.
    this.unheardSwitches.delete(tabId)
    this.unheardSentence.delete(tabId)
    // The focus follows a group by its ordinal into the next run, as names and highlights do; nothing derived is rebuilt,
    // so a focused Pivot leaves the focus on its group's Table, and a focused comparison leaves none.
    // A run that ended before it returned that group passes the wish on.
    const was = this.views.get(tabId)?.focused, previous = this.runs.get(tabId)
    const refocus = was === undefined || was === summaryEntryKey ? previous?.refocus : previous?.slots.get(was)?.group
    this.disposeRun(tabId)
    this.clearJobNotice(tabId)
    this.selectionAnnounced.delete(tabId)
    const multi: MultiRunState | undefined = o.multi && o.multi.targets.length > 0 ? { mode: o.multi.mode, targets: initialMultiTargetStates(o.multi.targets) } : undefined
    const viewState = emptyView()
    if (multi) viewState.focused = summaryEntryKey
    this.views.set(tabId, viewState)
    const run: Run = {
      tabId, bare: o.bare === true, slots: new Map(), selected: new Set(), ...refocus === undefined || multi ? {} : { refocus },
      queryId, startedAt: this.now(), status: 'running', sets: [], planSets: [], setKeys: new Set(), entries: new Map(), numbered: 0, compared: 0, setsPublished: false, rowsRead: new Map(), messages: [], notices: [], messagesTruncated: false,
      completedBatches: 0, totalBatches: 0, view: multi ? 'results' : 'messages', manualView: false, strip: this.stripChoices.get(tabId) === true, stripManual: false,
      settled: new Map(), settledPublished: false, jobs: this.savesOf(tabId), announcement: '', announced: 0, jobNotice: '', sorts: new Map(), sorting: new Map(), held: new Map(), emptied: false, discard: o.discard === true, notes: [], loads: new Map(),
      ...multi ? { multi } : {}, activeSummary: !!multi, rolledBackIds: new Map(), staleCombined: new Set(), baseCombineWarnings: [], combineWarnings: new Map(), combining: new Map()
    }
    run.subscription = this.client.onQueryEvent(queryId, event => {
      if (event.type === 'session.opened') {
        if (this.runs.get(tabId) === run && run.status === 'running') onSession?.(event)
      } else if (event.type === 'query.job') {
        if (this.runs.get(tabId) === run && run.status === 'running') o.onJob?.(event)
      } else if (event.type === 'multiQuery.targetState') {
        if (this.runs.get(tabId) === run && run.status === 'running') {
          this.updateMultiTargetState(tabId, queryId, event)
          o.onTargetState?.(event)
        }
      } else if (event.type === 'resultSet.meta') {
        if (this.runs.get(tabId) === run && run.status === 'running') {
          this.updateResultMeta(tabId, queryId, event)
          o.onResultMeta?.(event)
        }
      } else this.event(tabId, run, event)
    })
    this.runs.set(tabId, run)
    this.publishNow(tabId)
  }

  /** Applies a live `multiQuery.targetState` streaming event to the active multi-server run's summary cards. */
  updateMultiTargetState(tabId: string, queryId: string, event: Extract<QueryEvent, { type: 'multiQuery.targetState' }>): void {
    const run = this.runs.get(tabId)
    if (!run || run.queryId !== queryId || run.status !== 'running' || !run.multi) return
    const existing = run.multi.targets.find(target => target.targetKey === event.targetKey)
    if (existing
      && existing.phase === event.phase
      && existing.batchesCompleted === event.batchesCompleted
      && existing.batchesTotal === event.batchesTotal
      && existing.rowsAffected === event.rowsAffected
      && existing.resultSetCount === event.resultSetCount
      && existing.elapsedMs === event.elapsedMs
      && existing.bytesProcessed === event.bytesProcessed
      && existing.errorCode === event.errorCode
      && existing.errorMessage === event.errorMessage) return
    const nextTargets = applyTargetStateEvent(run.multi.targets, event)
    run.multi = { ...run.multi, targets: nextTargets }
    this.schedule(tabId)
  }

  /** Applies a live `resultSet.meta` event (e.g. `rolledBackPreview`) to a streaming or completed set. */
  updateResultMeta(tabId: string, queryId: string, event: Extract<QueryEvent, { type: 'resultSet.meta' }>): void {
    const run = this.runs.get(tabId)
    if (!run || run.queryId !== queryId || run.status === 'closed') return
    const key = setKey({ generation: event.generation, resultId: event.resultId })
    if (run.rolledBackIds.get(key) === event.rolledBackPreview) {
      const current = run.sets.find(entry => setKey(entry.descriptor) === key)
      if (!current || current.descriptor.rolledBackPreview === event.rolledBackPreview) return
    }
    run.rolledBackIds.set(key, event.rolledBackPreview)
    const index = run.sets.findIndex(entry => setKey(entry.descriptor) === key)
    if (index >= 0) {
      const existing = run.sets[index]
      if (existing.descriptor.rolledBackPreview !== event.rolledBackPreview) {
        const updated: ResultSetEntry = { ...existing, descriptor: { ...existing.descriptor, rolledBackPreview: event.rolledBackPreview } }
        if (run.setsPublished) { run.sets = run.sets.slice(); run.setsPublished = false }
        run.sets[index] = updated
        run.entries.set(updated.key, updated)
        run.shape = undefined
      }
    }
    this.schedule(tabId)
  }

  /** Resolves the live `connectionId` for a result set inside a multi-server run (used by `BigQueryCostService`). */
  connectionForResult(tabId: string, resultId: number): string | undefined {
    const run = this.runs.get(tabId)
    if (!run?.multi || run.status === 'closed' || run.status === 'lost') return undefined
    const entry = run.sets.find(set => set.descriptor.resultId === resultId)
    if (entry) {
      if (!held(entry) || !entry.descriptor.targetKey) return undefined
      const target = run.multi.targets.find(item => item.targetKey === entry.descriptor.targetKey)
      return target?.connectionId || undefined
    }
    if (run.status !== 'running') return undefined
    const byId = run.multi.targets.find(item => item.resultSetIds.includes(resultId))
    return byId?.connectionId || undefined
  }

  /** The run ended. The summary settles every set (opening any whose events were dropped) and replaces the streamed
   *  messages when they differ; events that arrive later are ignored. */
  finish(tabId: string, queryId: string, end: RunEnd): void | Promise<void> {
    const run = this.runs.get(tabId)
    // The tab closed before its run ended: nothing will show or close the sets the summary describes, so they go now.
    if (!run && !this.disposed) {
      const sets = [...end.summary?.resultSets ?? [], ...end.summary?.planSets ?? [], ...end.multiSummary?.resultSets ?? []]
      if (sets.length) void this.client.release(sets.map(set => ({ generation: set.generation, resultId: set.resultId }))).catch(() => {})
    }
    if (!run || run.queryId !== queryId || run.status !== 'running') return
    run.subscription?.dispose()
    run.subscription = undefined
    const { summary, multiSummary } = end
    // Switches the summary carried, and those whose own announcement the run's end now replaces, said with the run's end
    // (one announcement replaces another).
    let switchNotes: string[] = this.unheardSwitches.get(tabId) ?? []
    this.unheardSwitches.delete(tabId)
    if (multiSummary) {
      const switched = multiSummary.resultSets.filter(descriptor => {
        const entry = run.sets.find(set => set.descriptor.resultId === descriptor.resultId)
        return entry !== undefined && (descriptor.revision ?? 0) > (entry.handle.getSnapshot().revision ?? 0)
      })
      run.multi = {
        mode: multiSummary.mode,
        status: multiSummary.status,
        targets: applyMultiOutcomes(run.multi?.targets ?? [], multiSummary.targets),
        ...multiSummary.combineWarnings?.length ? { combineWarnings: multiSummary.combineWarnings } : {}
      }
      run.multiSummary = multiSummary
      this.client.applySummary({ resultSets: multiSummary.resultSets })
      switchNotes = [...switchNotes, ...switched.map(descriptor => this.switched(tabId, run, descriptor, false))]
      for (const descriptor of multiSummary.resultSets) {
        this.opened(run, descriptor)
        this.settle(run, descriptor)
        if (descriptor.kind !== 'combined') run.rowsRead.set(descriptor.resultId, descriptor.rowsRead)
      }
      if (multiSummary.combineWarnings?.length) {
        const combined = run.sets.filter(entry => entry.descriptor.kind === 'combined')
        if (combined.length > 0) {
          run.combineWarnings = new Map(combined.map(entry => [entry.key, [...multiSummary.combineWarnings!]]))
          run.baseCombineWarnings = []
        } else {
          run.baseCombineWarnings = [...multiSummary.combineWarnings]
        }
        this.syncCombineWarnings(run)
      }
      this.refreshSorts(tabId, run)
      if (!sameMessages(run.messages, multiSummary.messages)) run.messages = multiSummary.messages.slice(0, resultLimits.messages)
      if (end.messages?.length) run.messages = [...run.messages, ...end.messages].slice(-resultLimits.messages)
      run.messagesTruncated = multiSummary.messagesTruncated
      run.completedBatches = multiSummary.targets.reduce((sum, target) => sum + target.batchesCompleted, 0)
      run.totalBatches = multiSummary.targets.reduce((sum, target) => sum + target.batchesTotal, 0)
      run.status = multiRunStatus(multiSummary.status)
      if (run.sets.length === 0 && hasMultiSummary(run)) {
        run.activeSummary = true
        this.viewState(tabId).focused = summaryEntryKey
      }
    } else if (summary) {
      // A summary that overtook a set's residence event (which now arrives after the run, and is ignored) switches it here.
      const switched = summary.resultSets.filter(descriptor => {
        const entry = run.sets.find(set => set.descriptor.resultId === descriptor.resultId)
        return entry !== undefined && (descriptor.revision ?? 0) > (entry.handle.getSnapshot().revision ?? 0)
      })
      this.client.applySummary(summary)
      switchNotes = [...switchNotes, ...switched.map(descriptor => this.switched(tabId, run, descriptor, false))]
      for (const descriptor of summary.resultSets) {
        this.opened(run, descriptor)
        this.settle(run, descriptor)
        run.rowsRead.set(descriptor.resultId, descriptor.rowsRead)
      }
      run.planSets = (summary.planSets ?? []).map((descriptor, index) => ({
        key: this.mint(), number: index + 1, descriptor, handle: this.client.open(descriptor), capturedPlan: true
      }))
      this.refreshSorts(tabId, run)
      if (!sameMessages(run.messages, summary.messages)) run.messages = summary.messages.slice(0, resultLimits.messages)
      if (end.messages?.length) run.messages = [...run.messages, ...end.messages].slice(-resultLimits.messages)
      // The error that ended the run is always in Messages, whatever the backend could keep there.
      if (summary.error && summary.status !== 'completed' && !run.messages.some(entry => entry.kind === 'error')) run.messages = [...run.messages, { text: summary.error.message, kind: 'error' }]
      run.messagesTruncated = summary.messagesTruncated
      run.completedBatches = summary.completedBatches
      run.totalBatches = summary.totalBatches
      run.summary = summary
      run.status = runStatus(summary)
    } else {
      run.status = end.code === 'BACKEND_LOST' ? 'lost' : 'failed'
      run.error = end.error ?? 'The query failed.'
      if (run.multi) {
        const targets = run.multi.targets.map(target => terminalMultiTargetPhases.has(target.phase) ? target : { ...target, phase: 'failed' as const })
        run.multi = { ...run.multi, status: 'failed', targets }
      }
      if (end.messages?.length) run.messages = [...run.messages, ...end.messages].slice(-resultLimits.messages)
      else run.messages = [...run.messages, { text: run.error, kind: 'error' as const }].slice(-resultLimits.messages)
    }
    if (end.notice) run.notices = [{ text: end.notice, kind: 'info' }]
    run.endedAt = this.now()
    this.openStripFor(run, run.messages)
    // A run with sets (or multi-server summary cards) stays on Results even when it failed or returned 0 sets:
    // the strip under the grids or Summary shows its errors beside them.
    // A run that discarded its sets shows the Results view's notice that it did, unless it kept a plan to show.
    if (!run.manualView) run.view = run.sets.length || hasMultiSummary(run) ? 'results' : run.status === 'completed' && run.planSets.length ? 'plan' : discardedSets(run) ? 'results' : 'messages'
    // A screen reader hears why there are no sets, as the Results view's notice shows it; focus does not move there.
    const discarded = discardedSets(run)
    this.announce(tabId, completionSentence(run.status, run.sets.length, this.totalRows(run))
      + (discarded ? ` ${formatCount(discarded)} ${plural(discarded, 'result set')} ${discarded === 1 ? 'was' : 'were'} read and not kept: Discard results after execution is on.` : '')
      + switchNotes.map(note => ' ' + note).join(''))
    let retaining: Promise<void> | undefined
    if (end.planContext && this.retainedPlans) {
      const sources: SnapshotSource[] = []
      let available = 0
      for (const entry of orderPlanEntries([...run.planSets, ...run.sets.filter(set => set.descriptor.kind === 'executionPlan')], summary?.planOrder)) {
        const { descriptor, handle } = entry
        const snapshot = handle.getSnapshot()
        if (snapshot.state !== 'complete') continue
        available += snapshot.rowsAvailable
        for (let row = 0; row < snapshot.rowsAvailable && sources.length < retainedPlanLimits.documentsPerRun; row++) {
          sources.push({ key: `${descriptor.generation}:${descriptor.resultId}:${row}`, label: `${entry.capturedPlan ? 'Actual plan' : 'SQL-returned plan'} ${entry.number}${queryName(entry) ? ` (${queryName(entry)})` : ''}, row ${row + 1}`,
            captureType: entry.capturedPlan ? 'actual' : 'query-returned', batchNumber: descriptor.batchNumber, iteration: descriptor.iteration,
            generation: descriptor.generation, resultId: descriptor.resultId, row, incomplete: snapshot.incomplete,
            read: async signal => {
              const value = await handle.getCell(row, 0, { signal })
              if (value.error || value.isNull) throw new Error('The original plan XML is unavailable.')
              return value
            } })
        }
      }
      const context = end.planContext, history = this.retainedPlans, endedAt = run.endedAt
      // Install ownership before capture publishes: a subscriber may close/reset output synchronously.
      let copied!: () => void, failed!: (error: unknown) => void
      const copying = retaining = run.retaining = new Promise<void>((resolve, reject) => { copied = resolve; failed = reject })
      // Once the copy has ended a close releases at once.
      const ended = () => { if (run.retaining === copying) run.retaining = undefined }
      void copying.then(ended, ended)
      void history.capture(context, {
        status: summary?.status ?? (end.code === 'BACKEND_LOST' ? 'lost' : 'failed'), endedAt,
        completedAt: summary?.completedAt, elapsedMs: summary?.elapsedMs, database: summary?.database,
        spid: summary?.spid, login: summary?.login, completedBatches: summary?.completedBatches, totalBatches: summary?.totalBatches,
        error: summary?.error?.message ?? end.error
      }, sources, Math.max(0, available - sources.length)).then(copied, failed)
    }
    this.publishNow(tabId)
    return retaining
  }

  /** The tab closed: its results are released and forgotten (a running save still finishes its file). */
  release(tabId: string): void {
    this.clearJobNotice(tabId)
    this.disposeRun(tabId)
    this.operations.forget(tabId, { closed: true })
    this.views.delete(tabId)
    this.stripChoices.delete(tabId)
    this.selectionAnnounced.delete(tabId)
    const timer = this.announcements.get(tabId)
    if (timer !== undefined) this.timers.clearTimeout(timer)
    this.announcements.delete(tabId)
    this.unheardSwitches.delete(tabId)
    this.unheardSentence.delete(tabId)
    if (!Object.hasOwn(this.getSnapshot(), tabId)) return
    const next = { ...this.getSnapshot() }
    delete next[tabId]
    this.publish(next)
  }

  /**
   * Appends a line to the tab's Messages outside any execution (QueryService.addSessionMessage: a session close's note, a
   * refused close): after the run's own lines, which a running run's summary does not replace; a tab with no run gets a
   * messages-only view. The strip opens for an error line, as for a run's.
   */
  /** A query over a windowed result's lines (its job, rows, cost): after the run's, only while the tab's run is there, so an
   *  answer that came after the tab closed opens nothing. */
  remoteMessages(tabId: string, messages: readonly MessageEntry[]): void {
    if (!this.runs.has(tabId)) return
    for (const message of messages) this.addMessage(tabId, message.text, message.kind === 'error' ? 'error' : 'info')
  }

  addMessage(tabId: string, text: string, kind: 'info' | 'error' = 'info'): void {
    if (this.disposed) return
    const entry: MessageEntry = { text: text.slice(0, wire.messages.characters), kind }
    let run = this.runs.get(tabId)
    if (!run) {
      this.begin(tabId, crypto.randomUUID())
      run = this.runs.get(tabId)
      if (!run) return
      run.subscription?.dispose()
      run.subscription = undefined
      run.status = 'completed'
      run.endedAt = run.startedAt
      run.messagesOnly = true
    }
    run.notes = [...run.notes, entry].slice(-resultLimits.messages)
    if (!run.manualView && !run.sets.length && !hasMultiSummary(run)) run.view = 'messages'
    this.openStripFor(run, [entry])
    this.publishNow(tabId)
  }

  /**
   * Load into memory (results.remoteQuery `load`): a windowed BigQuery result of a finished run reads its rows into result
   * memory under a new revision, its grid keeping its rows and place meanwhile. Its events are its own query's, followed
   * here after the run ended (a run's own stop once it finishes); the summary settles it, loaded or windowed again, and its
   * messages join the run's. Returns why it cannot start, or undefined.
   */
  async loadIntoMemory(tabId: string, key: EntryKey): Promise<string | undefined> {
    const run = this.runs.get(tabId), set = run?.entries.get(key)
    if (!run || !set || !this.api.remoteQuery || this.disposed) return undefined
    if (this.expiredSets.has(set)) return expiredRefusal
    const snapshot = set.handle.getSnapshot()
    if (snapshot.state === 'lost' || snapshot.state === 'released') return snapshot.state === 'lost' ? unavailable : closedResults
    if (snapshot.residence !== 'remote' || run.loads.has(key)) return undefined
    if (run.status === 'running' || snapshot.state !== 'complete') return loadWhileRunning
    const queryId = this.newId()
    const subscription = this.client.onQueryEvent(queryId, event => this.loadEvent(tabId, run, key, event))
    const load: RunningLoad = { queryId, subscription, stopping: false }
    run.loads = new Map(run.loads).set(key, load)
    this.publishNow(tabId)
    // The strip's count is no live region (it changes every tick): the start is said once here.
    this.announce(tabId, 'Loading into memory…')
    const { generation, resultId } = set.descriptor
    let refusal: string | undefined
    try {
      const params: ResultsRemoteQueryParams = { queryId, generation, resultId, kind: 'load' }
      const answer = await this.api.remoteQuery(params)
      // The run replaced, or this result closed (Close Results, its caption's close), stopped the load: the user's own
      // close is not reported as its failure.
      if (this.runs.get(tabId) !== run || run.entries.get(key) !== set || this.disposed) return undefined
      if (answer.ok) this.loaded(tabId, run, answer.value)
      else { refusal = `Could not load the result into memory: ${answer.error}`; if (answer.code === 'REMOTE_EXPIRED') this.markExpired(tabId, key) }
    } catch (error) {
      refusal = `Could not load the result into memory: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      subscription.dispose()
      if (run.loads.get(key)?.queryId === queryId) { const loads = new Map(run.loads); loads.delete(key); run.loads = loads }
      if (this.runs.get(tabId) === run) this.schedule(tabId)
    }
    if (refusal && this.runs.get(tabId) === run && run.entries.get(key) === set) {
      this.addMessage(tabId, refusal, 'error')
      this.announce(tabId, refusal)
    }
    return undefined
  }

  /** Whether Load into memory can start for this entry: a windowed BigQuery result whose run has finished, not loading,
   *  whose projected size fits the result memory free now (docs/bigquery.md, Load into memory). */
  canLoadIntoMemory(tabId: string, key: EntryKey): boolean { return this.loadState(tabId, key) === 'ready' }
  /** Whether BigQuery no longer keeps this windowed result (a read, load, sample or estimate answered REMOTE_EXPIRED): its
   *  grid offers only Re-run, and Load into memory and Load sample are not offered. A re-run's result is a new entry. */
  isExpired(tabId: string, key: EntryKey): boolean { const set = this.runs.get(tabId)?.entries.get(key); return !!set && this.expiredSets.has(set) }
  /** Marks a windowed result BigQuery no longer keeps (its grid read a page that answered REMOTE_EXPIRED, say). */
  markExpired(tabId: string, key: EntryKey): void {
    const set = this.runs.get(tabId)?.entries.get(key)
    if (!set || this.expiredSets.has(set) || set.handle.getSnapshot().residence !== 'remote') return
    this.expiredSets.add(set)
    this.schedule(tabId)
  }
  private readonly expiredSets = new WeakSet<object>()
  /** Whether the one thing keeping Load into memory back is the room: the result's projection does not fit the memory free. */
  loadNeedsRoom(tabId: string, key: EntryKey): boolean { return this.loadState(tabId, key) === 'room' }
  private loadState(tabId: string, key: EntryKey): 'ready' | 'room' | undefined {
    const run = this.runs.get(tabId), set = run?.entries.get(key)
    if (!run || !set || !this.api.remoteQuery || run.status === 'running' || run.loads.has(key)) return undefined
    const snapshot = set.handle.getSnapshot()
    if (snapshot.residence !== 'remote' || snapshot.state !== 'complete' || this.expiredSets.has(set)) return undefined
    return fitsFreeMemory(snapshot.projectedBytes, this.memory?.()) ? 'ready' : 'room'
  }

  /** Stops a Load into memory (query.cancel with its own id): the result stays windowed, whole. Stops a Load sample or a
   *  Re-run the same way (their RemoteViews query cancels itself): the result stays as it was. */
  stopLoad(tabId: string, key: EntryKey): void {
    const run = this.runs.get(tabId), load = run?.loads.get(key)
    if (!run || !load || load.stopping || (!load.abort && !this.api.cancel)) return
    run.loads = new Map(run.loads).set(key, { ...load, stopping: true })
    this.schedule(tabId)
    // A re-run's strip is a status that says it is stopping itself.
    if (load.kind !== 'rerun') this.announce(tabId, load.kind === 'sample' ? 'Stopping the sample.' : 'Stopping the load: the result stays windowed in BigQuery.')
    if (load.abort) load.abort.abort(remoteStop)
    else void this.api.cancel?.(load.queryId).catch(() => {})
  }

  /** Whether Load sample can start for this entry: a windowed BigQuery result of a finished run, with nothing loading or
   *  running again over it. */
  canLoadSample(tabId: string, key: EntryKey): boolean { return this.auxiliaryRefusal(tabId, key, 'sample') === undefined }

  /** What Load sample's dialog needs of a result it can sample: its name, its rows (BigQuery's total), a row's projected size
   *  in memory and the result memory free now. */
  sampleSource(tabId: string, key: EntryKey): { readonly name: string; readonly resultId: number; readonly generation: number; readonly total: number; readonly projectedBytes?: number; readonly freeBytes?: number } | undefined {
    const run = this.runs.get(tabId), set = run?.entries.get(key)
    if (!run || !set || !this.canLoadSample(tabId, key)) return undefined
    const snapshot = set.handle.getSnapshot(), memory = this.memory?.()
    return {
      name: distinctName(set, run.sets), resultId: set.descriptor.resultId, generation: set.descriptor.generation, total: snapshot.rowsTotal ?? snapshot.rowsAvailable, ...snapshot.projectedBytes === undefined ? {} : { projectedBytes: snapshot.projectedBytes },
      ...memory && memory.globalBytes > 0 ? { freeBytes: Math.max(0, memory.globalBytes - memory.usedBytes) } : {}
    }
  }

  /** Why a Load sample or Re-run cannot start for this entry ('' when there is nothing to say), or undefined when it can. */
  private auxiliaryRefusal(tabId: string, key: EntryKey, kind: AuxiliaryKind): string | undefined {
    const run = this.runs.get(tabId), set = run?.entries.get(key)
    if (!run || !set || !this.remote || !this.api.remoteQuery || run.bare || this.disposed) return ''
    const snapshot = set.handle.getSnapshot()
    if (snapshot.state === 'lost' || snapshot.state === 'released') return snapshot.state === 'lost' ? unavailable : closedResults
    if (snapshot.residence !== 'remote') return ''
    if (run.status === 'running' || run.status === 'closed' || snapshot.state !== 'complete') return kind === 'sample' ? sampleWhileRunning : rerunWhileRunning
    if (run.loads.has(key)) return busyWindowed
    if (kind === 'sample' && this.expiredSets.has(set)) return expiredRefusal
    if (kind === 'sample' && run.sets.length >= resultLimits.sets) return sampleFull
    return undefined
  }

  /** Marks a Load sample or Re-run running over `key`, for its strip. */
  private beginAuxiliary(tabId: string, run: Run, key: EntryKey, kind: AuxiliaryKind, abort: AbortController): void {
    run.loads = new Map(run.loads).set(key, { queryId: '', stopping: false, kind, abort })
    this.publishNow(tabId)
  }

  private endAuxiliary(tabId: string, run: Run, key: EntryKey, abort: AbortController): void {
    if (run.loads.get(key)?.abort === abort) { const loads = new Map(run.loads); loads.delete(key); run.loads = loads }
    if (this.runs.get(tabId) === run) this.schedule(tabId)
  }

  /**
   * Load sample (results.remoteQuery `sample`, docs/bigquery.md › Load a sample): `rows` rows of a windowed BigQuery result
   * of a finished run, its first ones (free) or a random sample (estimated and asked about first), read into a new result
   * in memory. It stands after its source's group as a group of its own, named "Sample: 1,000 of 52,341,118 rows", where
   * Pivot, Compare and Column Profile work. Its source's strip shows it running, with Stop; closing the source cancels it.
   * Returns why it cannot start, or undefined (a failure is said in Messages).
   */
  async loadSample(tabId: string, key: EntryKey, rows: number, method: SampleMethod): Promise<string | undefined> {
    const refused = this.auxiliaryRefusal(tabId, key, 'sample')
    if (refused !== undefined) return refused || undefined
    const run = this.runs.get(tabId)!, set = run.entries.get(key)!
    const abort = new AbortController()
    this.beginAuxiliary(tabId, run, key, 'sample', abort)
    this.announce(tabId, method === 'first' ? 'Loading the first rows as a sample…' : 'Loading a random sample…')
    let failure: string | undefined
    try {
      const descriptor = await this.remote!.sample(tabId, set.handle, rows, method, abort.signal)
      if (this.runs.get(tabId) !== run || run.entries.get(key) !== set || this.disposed) { this.releaseDescriptor(descriptor); return undefined }
      const snapshot = set.handle.getSnapshot()
      const name = sampleName(descriptor.rowsStored, snapshot.rowsTotal ?? snapshot.rowsAvailable)
      const added = this.addSample(tabId, run, set, descriptor, name)
      if (added) this.announce(tabId, `${added} loaded.`)
      else failure = `Could not show the sample: ${sampleFull}`
    } catch (error) {
      // A declined prompt or a Stop ran nothing worth an error (a Stop's lines are already in Messages).
      if (!(error instanceof RemoteDeclined) && !abort.signal.aborted) failure = `Could not load a sample: ${error instanceof Error ? error.message : String(error)}`
      if (isExpiredError(error) && this.runs.get(tabId) === run && run.entries.get(key) === set) this.markExpired(tabId, key)
    } finally {
      this.endAuxiliary(tabId, run, key, abort)
    }
    if (failure && this.runs.get(tabId) === run && run.entries.get(key) === set) {
      this.addMessage(tabId, failure, 'error')
      this.announce(tabId, failure)
    }
    return undefined
  }

  /**
   * Re-run (results.remoteQuery `rerun`, docs/bigquery.md › Expiry): a windowed BigQuery result whose table expired runs its
   * own statement again (a script child's alone), after its estimate and the cost prompts, and the new result takes its
   * place: the same entry, number and name. Its strip shows it running, with Stop; closing the result cancels it. Returns
   * why it cannot start, or undefined (a failure is said in Messages).
   */
  async rerun(tabId: string, key: EntryKey): Promise<string | undefined> {
    const refused = this.auxiliaryRefusal(tabId, key, 'rerun')
    if (refused !== undefined) return refused || undefined
    const run = this.runs.get(tabId)!, set = run.entries.get(key)!
    const abort = new AbortController()
    // The strip's status says it is running again (loadingText), so nothing more is announced.
    this.beginAuxiliary(tabId, run, key, 'rerun', abort)
    let failure: string | undefined
    try {
      const descriptor = await this.remote!.rerun(tabId, set.handle, abort.signal)
      if (this.runs.get(tabId) !== run || run.entries.get(key) !== set || this.disposed || run.status === 'running' || run.status === 'closed') { this.releaseDescriptor(descriptor); return undefined }
      this.rerunInPlace(tabId, run, set, descriptor)
      this.announce(tabId, `${run.sets.length > 1 ? distinctName(run.entries.get(key) ?? set, run.sets) : 'The result'} ran again.`)
    } catch (error) {
      if (!(error instanceof RemoteDeclined) && !abort.signal.aborted) failure = `Could not run the query again: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      this.endAuxiliary(tabId, run, key, abort)
    }
    if (failure && this.runs.get(tabId) === run && run.entries.has(key)) {
      this.addMessage(tabId, failure, 'error')
      this.announce(tabId, failure)
    }
    return undefined
  }

  /** A result nothing will hold (its run or source went while it was made): released at once. */
  private releaseDescriptor(descriptor: ResultDescriptor): void {
    void this.client.release([{ generation: descriptor.generation, resultId: descriptor.resultId }]).catch(() => {})
  }

  /** Adds a sample after its source's group (its Table and Pivot), before the next group and the comparisons, as a Table of
   *  a group of its own numbered after the run's highest, with the focus: the name it is given. Released, and false, when the
   *  run cannot take it. */
  private addSample(tabId: string, run: Run, source: ResultSetEntry, descriptor: ResultDescriptor, label: string): string | false {
    const key = setKey(descriptor)
    if (run.setKeys.has(key)) return false
    if (run.bare || run.status === 'running' || run.status === 'closed' || run.sets.length >= resultLimits.sets) { this.releaseDescriptor(descriptor); return false }
    run.setKeys.add(key)
    if (run.setsPublished) { run.sets = run.sets.slice(); run.setsPublished = false }
    // Numbered once, for its life, as a derived entry is. Its group is negative and never handed out again: a group's ordinal
    // is what highlights, the Column Profile, the focus, Pivot drafts and Compare follow into the next run, where the query's
    // own results are numbered from 1 and later samples get groups of their own, so a sample's state passes to nothing.
    const number = ++run.numbered, ordinal = --this.sampleGroup
    // Two samples of one size read apart by their numbers.
    const named = run.sets.some(other => other.label === label) ? `${label} (${entryNumber({ number })})` : label
    const entry: ResultSetEntry = { key: this.mint(), ordinal, number, descriptor, handle: this.client.open(descriptor), label: named, sample: true }
    const group = run.slots.get(source.key)?.group
    let at = run.sets.indexOf(source) + 1
    // After the source's Pivot and the samples made of it before (each a group of a negative ordinal, with its own Pivot).
    const after = (key: EntryKey) => { const slot = run.slots.get(key); return slot?.group !== undefined && (slot.group === group && slot.view === 'pivot' || slot.group < 0) }
    while (at > 0 && at < run.sets.length && group !== undefined && after(run.sets[at].key)) at++
    if (at <= 0) at = run.sets.length
    run.sets.splice(at, 0, entry)
    run.entries.set(entry.key, entry)
    run.slots.set(entry.key, { view: 'table', group: ordinal, revision: 1, sources: [] })
    run.shape = undefined
    this.settle(run, descriptor)
    run.emptied = false
    run.activeSummary = false
    run.view = 'results'
    this.viewState(tabId).focused = entry.key
    this.schedule(tabId)
    return named
  }

  /**
   * A rerun's result takes its source's place: the same entry key, number, ordinal, name and slot (its next revision). What
   * named the old result's rows goes with it (its sort and filters, its views, its controller, a copy of it, its selection
   * and scroll); column widths carry over by name. Published before the old result is released, after a Save of it in its
   * file dialog ends.
   */
  private rerunInPlace(tabId: string, run: Run, old: ResultSetEntry, descriptor: ResultDescriptor): void {
    const key = old.key, record = run.slots.get(key)
    run.sorting.get(key)?.abort()
    run.sorting.delete(key)
    const sort = run.sorts.get(key)
    // Views built in BigQuery are results of their own: closed with the old result.
    for (const view of new Set([...run.held.get(key)?.views ?? [], ...sort?.view ? [sort.view] : []])) if (isRemoteView(view)) void view.close()
    run.held.delete(key)
    if (sort) {
      for (const list of new Set([...sort.filters, ...sort.applied].flatMap(item => item.list ? [item.list] : []))) void list.close()
      const sorts = new Map(run.sorts)
      sorts.delete(key)
      run.sorts = sorts
    }
    this.controllers.delete(key)
    this.drawing.delete(key)
    if (this.copying && this.runs.get(this.copying.tabId) === run && this.copying.job.entry === key) this.cancelRunning(this.copying)
    run.setKeys.delete(setKey(old.descriptor))
    if (run.settled.has(setKey(old.descriptor))) {
      if (run.settledPublished) { run.settled = new Map(run.settled); run.settledPublished = false }
      run.settled.delete(setKey(old.descriptor))
    }
    run.setKeys.add(setKey(descriptor))
    // A name the query gave its result (and multi-server target/statement metadata) stays with it (the backend opens the rerun's set without them).
    const carried: ResultDescriptor = {
      ...descriptor,
      ...old.descriptor.name !== undefined && descriptor.name === undefined ? { name: old.descriptor.name } : {},
      ...old.descriptor.targetKey !== undefined && descriptor.targetKey === undefined ? { targetKey: old.descriptor.targetKey } : {},
      ...old.descriptor.statementSlot !== undefined && descriptor.statementSlot === undefined ? { statementSlot: old.descriptor.statementSlot } : {}
    }
    const label = this.entryLabel(run, carried)
    const entry: ResultSetEntry = { ...old, descriptor: carried, handle: this.client.open(descriptor), ...label === undefined ? {} : { label } }
    if (run.setsPublished) { run.sets = run.sets.slice(); run.setsPublished = false }
    run.sets[run.sets.indexOf(old)] = entry
    run.entries.set(key, entry)
    if (record) run.slots.set(key, { ...record, revision: record.revision + 1 })
    run.shape = undefined
    if (carried.residence !== 'remote') this.markCombinedStaleFor(run, [entry])
    const grids = this.views.get(tabId)?.grids, state = grids?.get(key)
    if (grids && state) grids.set(key, carriedState(state, uniqueNames(old.descriptor.columns, descriptor.columns), descriptor.columns.length))
    this.settle(run, descriptor)
    run.emptied = false
    this.publishNow(tabId)
    this.releaseEntries(run, [old], [...this.saves.values()].flatMap(save => save.handle === old.handle && save.done ? [save.done] : []))
    if (sort && (sort.keys.length > 0 || sort.filters.length > 0)) this.notify(tabId, `${distinctName(entry, run.sets)} ran again, so its sort and filters were removed.`)
  }

  /** A load's events: its residence switches (loading, or windowed again), and its set settling. Its messages come with
   *  its summary. */
  private loadEvent(tabId: string, run: Run, key: EntryKey, event: QueryEvent): void {
    if (this.runs.get(tabId) !== run || !run.loads.has(key) || this.disposed) return
    if (event.type === 'resultSet.residence') this.switched(tabId, run, event.descriptor)
    else if (event.type === 'resultSet.opened' || event.type === 'resultSet.closed') this.settle(run, event.descriptor)
    else return
    this.schedule(tabId)
  }

  /** A load's summary: a switch it carried that its event has not (the event may come after), the set settled, its
   *  messages added after the run's, and what happened said. */
  private loaded(tabId: string, run: Run, summary: QueryResult): void {
    for (const descriptor of summary.resultSets) {
      const entry = run.sets.find(set => set.descriptor.resultId === descriptor.resultId && set.descriptor.generation === descriptor.generation)
      if (!entry) continue
      const revised = (descriptor.revision ?? 0) > (entry.handle.getSnapshot().revision ?? 0)
      this.client.applySummary({ ...summary, resultSets: [descriptor], planSets: [] })
      if (revised) this.switched(tabId, run, descriptor, false)
      if (descriptor.residence !== 'remote') this.markCombinedStaleFor(run, [entry])
      this.settle(run, descriptor)
    }
    const lines = summary.messages.map(entry => ({ ...entry, text: entry.text.slice(0, wire.messages.characters) }))
    run.notes = [...run.notes, ...lines].slice(-resultLimits.messages)
    this.openStripFor(run, lines.filter(entry => entry.kind === 'error'))
    const said = lines.at(-1)?.text
    if (said) this.announce(tabId, said)
  }

  /** Close Results: the memory is freed now; Messages stay. Not for a bare run (Peek's rows go with their card or tab). */
  closeResults(tabId: string): void {
    const run = this.runs.get(tabId)
    if (!run || run.bare || run.status === 'running' || run.status === 'closed') return
    this.drop(tabId, run, run.sets, run.planSets)
    run.closedFrom = run.status
    run.status = 'closed'
    run.emptied = false
    run.activeSummary = false
    run.staleCombined = new Set()
    run.baseCombineWarnings = []
    run.combineWarnings = new Map()
    run.view = 'results'
    this.views.set(tabId, emptyView())
    this.publishNow(tabId)
  }

  /**
   * Releases all non-running results across every query tab without closing any query tabs (Memory popover's Close all).
   * Running queries and bare runs (Peek) are left untouched. Returns how many tabs had results closed.
   */
  closeAllResults(isRunning?: (tabId: string) => boolean): number {
    let closed = 0
    for (const [tabId, run] of this.runs) {
      if (run.bare || run.status === 'running' || run.status === 'closed' || isRunning?.(tabId)) continue
      if (run.sets.length === 0 && run.planSets.length === 0 && !hasMultiSummary(run)) continue
      this.closeResults(tabId)
      closed++
    }
    return closed
  }

  /**
   * Closes one view of a run that has ended (a caption's close button, Close Result): a Table closes its group, so its
   * Pivot goes with it; a Pivot, Combined or comparison closes alone. What
   * closes leaves the run and its results are released (`drop`); the entries after move up and keep their keys, numbers,
   * names and state. A comparison copied its cells, so it outlives its inputs, under its name. Closing a per-server result
   * marks any Combined view covering its statement slot stale so the user can Rebuild or Close it. When what closed had the
   * focus, the next surviving item takes it, else the one before, as the view its group last showed (its Table or its
   * Pivot), so that group keeps what it remembered. The run's status, summary and row total do not change;
   * closing its last entry marks it `emptied` (or returns to Summary on multi-server runs). Unavailable while the query
   * runs and in a bare run (Peek). False when there is no such entry.
   */
  removeEntry(tabId: string, key: EntryKey): boolean {
    const run = this.runs.get(tabId), entry = run?.entries.get(key)
    if (!run || !entry || run.bare || run.status === 'running' || run.status === 'closed') return false
    const gone = this.owned(run, entry), keys = new Set(gone.map(item => item.key))
    const view = this.views.get(tabId)
    let next: ResultSetEntry | undefined
    if (view?.focused !== undefined && keys.has(view.focused)) {
      // A Pivot leaves the focus in its group, on the Table.
      const slot = run.slots.get(key), last = run.sets.indexOf(gone[gone.length - 1])
      next = (slot?.view !== 'table' && slot?.group !== undefined ? run.sets.find(item => item.ordinal === slot.group) : undefined)
        ?? this.shownView(run, run.sets[last + 1] ?? run.sets[run.sets.indexOf(gone[0]) - 1])
    }
    this.markCombinedStaleFor(run, gone)
    this.drop(tabId, run, gone)
    if (view && next) { view.focused = next.key; run.activeSummary = false; this.select(run, next.key) }
    else if (run.sets.length === 0) {
      if (hasMultiSummary(run)) { run.activeSummary = true; this.viewState(tabId).focused = summaryEntryKey }
      else run.emptied = true
    }
    this.publishNow(tabId)
    return true
  }

  /** Closes every result set (and its Pivot) belonging to `targetKey` in a finished multi-server run, marking any Combined
   *  views built from those statement slots stale so the user can Rebuild or Close them. */
  removeTargetEntries(tabId: string, targetKey: string): boolean {
    const run = this.runs.get(tabId)
    if (!run || run.bare || run.status === 'running' || run.status === 'closed') return false
    const roots = run.sets.filter(entry => entry.descriptor.targetKey === targetKey && run.slots.get(entry.key)?.view === 'table')
    if (roots.length === 0) return false
    const goneSet = new Set<ResultSetEntry>()
    for (const root of roots) for (const item of this.owned(run, root)) goneSet.add(item)
    const gone = run.sets.filter(entry => goneSet.has(entry))
    const keys = new Set(gone.map(item => item.key))
    const view = this.views.get(tabId)
    let next: ResultSetEntry | undefined
    if (view?.focused !== undefined && keys.has(view.focused)) {
      const remaining = run.sets.filter(entry => !keys.has(entry.key))
      const last = run.sets.indexOf(gone[gone.length - 1])
      next = this.shownView(run, run.sets.slice(last + 1).find(entry => !keys.has(entry.key)) ?? remaining.at(-1))
    }
    this.markCombinedStaleFor(run, gone)
    this.drop(tabId, run, gone)
    if (view && next) { view.focused = next.key; run.activeSummary = false; this.select(run, next.key) }
    else if (run.sets.length === 0) {
      if (hasMultiSummary(run)) { run.activeSummary = true; this.viewState(tabId).focused = summaryEntryKey }
      else run.emptied = true
    } else if (view && view.focused !== undefined && !run.entries.has(view.focused) && hasMultiSummary(run)) {
      run.activeSummary = true
      view.focused = summaryEntryKey
    }
    this.publishNow(tabId)
    return true
  }

  /** The entries closing a multi-server target tab would release (all its statement tables and Pivots). */
  closingTarget(tabId: string, targetKey: string): readonly ResultSetEntry[] {
    const run = this.runs.get(tabId)
    if (!run) return []
    const roots = run.sets.filter(entry => entry.descriptor.targetKey === targetKey && run.slots.get(entry.key)?.view === 'table')
    const seen = new Set<ResultSetEntry>()
    for (const root of roots) for (const item of this.owned(run, root)) seen.add(item)
    return run.sets.filter(entry => seen.has(entry))
  }

  /** Whether a stale Combined entry has at least two complete in-memory server source sets left to rebuild from. */
  canRebuildCombined(tabId: string, combinedKey: EntryKey): boolean {
    const run = this.runs.get(tabId), entry = run?.entries.get(combinedKey)
    if (!run || !entry || entry.descriptor.kind !== 'combined' || run.status === 'running' || run.status === 'closed' || run.status === 'lost' || !this.client.combine || run.combining.has(combinedKey)) return false
    return this.combinedSourcesOf(run, entry).length >= 2
  }

  /** Rebuilds a stale Combined entry via `results.combine` (`ResultClient.combine`) from the remaining server result sets
   *  for its statement slot, replacing it in place and releasing the old combined buffer. */
  async rebuildCombined(tabId: string, combinedKey: EntryKey): Promise<EntryKey | undefined> {
    const run = this.runs.get(tabId), old = run?.entries.get(combinedKey)
    if (!run || !old || old.descriptor.kind !== 'combined' || run.status === 'running' || run.status === 'closed' || run.status === 'lost' || !this.client.combine) return undefined
    if (run.combining.has(combinedKey)) return undefined
    const sources = this.combinedSourcesOf(run, old)
    if (sources.length < 2) {
      this.notify(tabId, 'At least two server result sets are needed to rebuild Combined.')
      return undefined
    }
    const abort = new AbortController()
    run.combining.set(combinedKey, abort)
    try {
      const result = await this.client.combine(sources.map(source => source.handle), { ...old.descriptor.name ? { statementName: old.descriptor.name } : {}, signal: abort.signal })
      const current = this.runs.get(tabId)
      if (
        this.disposed
        || abort.signal.aborted
        || current !== run
        || current.entries.get(combinedKey) !== old
        || current.status === 'closed'
        || current.status === 'running'
        || current.status === 'lost'
        || result.descriptor.generation !== old.descriptor.generation
        || !sources.every(source => current.entries.get(source.key) === source && held(source))
      ) {
        this.discard(result.descriptor)
        return undefined
      }
      const nextDescriptor: ResultDescriptor = {
        ...result.descriptor,
        kind: 'combined',
        ...old.descriptor.statementSlot !== undefined && result.descriptor.statementSlot === undefined ? { statementSlot: old.descriptor.statementSlot } : {},
        ...old.descriptor.name !== undefined && result.descriptor.name === undefined ? { name: old.descriptor.name } : {}
      }
      const label = this.entryLabel(run, nextDescriptor) ?? old.label ?? 'Combined'
      const record = run.slots.get(combinedKey)
      if (!record) { this.discard(result.descriptor); return undefined }
      const moved = uniqueNames(old.descriptor.columns, nextDescriptor.columns)
      run.sorting.get(combinedKey)?.abort()
      run.sorting.delete(combinedKey)
      run.held.delete(combinedKey)
      const sort = run.sorts.get(combinedKey)
      if (sort) {
        for (const list of new Set([...sort.filters, ...sort.applied].flatMap(item => item.list ? [item.list] : []))) void list.close()
        const sorts = new Map(run.sorts)
        sorts.delete(combinedKey)
        run.sorts = sorts
      }
      this.controllers.delete(combinedKey)
      this.drawing.delete(combinedKey)
      if (this.copying && this.runs.get(this.copying.tabId) === run && this.copying.job.entry === combinedKey) this.cancelRunning(this.copying)
      run.setKeys.delete(setKey(old.descriptor))
      if (run.settled.has(setKey(old.descriptor))) {
        if (run.settledPublished) { run.settled = new Map(run.settled); run.settledPublished = false }
        run.settled.delete(setKey(old.descriptor))
      }
      run.setKeys.add(setKey(nextDescriptor))
      const entry: ResultSetEntry = { ...old, descriptor: nextDescriptor, handle: this.client.open(nextDescriptor), label }
      if (run.setsPublished) { run.sets = run.sets.slice(); run.setsPublished = false }
      run.sets[run.sets.indexOf(old)] = entry
      run.entries.set(combinedKey, entry)
      run.slots.set(combinedKey, { ...record, revision: record.revision + 1 })
      run.shape = undefined
      if (run.staleCombined.has(combinedKey)) {
        const nextStale = new Set(run.staleCombined)
        nextStale.delete(combinedKey)
        run.staleCombined = nextStale
      }
      const warnings = (result as { readonly warnings?: readonly string[] }).warnings
      if (run.multi && Array.isArray(warnings)) {
        const nextWarnings = new Map(run.combineWarnings)
        nextWarnings.set(combinedKey, [...warnings])
        run.combineWarnings = nextWarnings
        this.syncCombineWarnings(run)
      }
      const grids = this.views.get(tabId)?.grids, state = grids?.get(combinedKey)
      if (grids && state) grids.set(combinedKey, carriedState(state, moved, nextDescriptor.columns.length))
      this.settle(run, nextDescriptor)
      this.publishNow(tabId)
      this.releaseEntries(run, [old], [...this.saves.values()].flatMap(save => save.handle === old.handle && save.done ? [save.done] : []))
      return combinedKey
    } catch (error) {
      const current = this.runs.get(tabId)
      if (!abort.signal.aborted && !this.disposed && current === run && current.status !== 'closed' && current.status !== 'lost') {
        this.notify(tabId, `Could not rebuild Combined: ${error instanceof Error ? error.message : String(error)}`)
      }
      return undefined
    } finally {
      if (run.combining.get(combinedKey) === abort) run.combining.delete(combinedKey)
    }
  }

  private combinedSourcesOf(run: Run, combined: ResultSetEntry): ResultSetEntry[] {
    const slot = combined.descriptor.statementSlot ?? 0
    return run.sets.filter(entry =>
      !entry.sample
      && entry.descriptor.kind === 'rows'
      && entry.descriptor.targetKey !== undefined
      && (entry.descriptor.statementSlot ?? 0) === slot
      && entry.handle.getSnapshot().state === 'complete'
      && entry.handle.getSnapshot().residence !== 'remote'
    )
  }

  private markCombinedStaleFor(run: Run, removed: readonly ResultSetEntry[]): void {
    const slots = new Set<number>()
    for (const entry of removed) {
      if (!entry.sample && entry.descriptor.kind === 'rows' && entry.descriptor.targetKey !== undefined) slots.add(entry.descriptor.statementSlot ?? 0)
    }
    if (slots.size === 0) return
    let stale: Set<EntryKey> | undefined
    for (const entry of run.sets) {
      if (entry.descriptor.kind !== 'combined') continue
      if (!slots.has(entry.descriptor.statementSlot ?? 0)) continue
      if (run.staleCombined.has(entry.key)) continue
      stale ??= new Set(run.staleCombined)
      stale.add(entry.key)
    }
    if (stale) run.staleCombined = stale
  }

  private syncCombineWarnings(run: Run): void {
    if (!run.multi) return
    const merged: string[] = []
    const add = (list: readonly string[] | undefined) => {
      if (!list) return
      for (const item of list) if (!merged.includes(item)) merged.push(item)
    }
    const combined = run.sets.filter(entry => entry.descriptor.kind === 'combined')
    if (combined.length === 0) add(run.baseCombineWarnings)
    else for (const entry of combined) add(run.combineWarnings.get(entry.key) ?? run.baseCombineWarnings)
    if (merged.length > 0) run.multi = { ...run.multi, combineWarnings: merged }
    else if (run.multi.combineWarnings !== undefined) {
      const { combineWarnings: _dropped, ...rest } = run.multi
      run.multi = rest
    }
  }

  /** The view of `entry`'s group that the group last showed (its Pivot while selected and built, else its Table); a
   *  comparison is itself. */
  private shownView(run: Run, entry: ResultSetEntry | undefined): ResultSetEntry | undefined {
    const group = entry && run.slots.get(entry.key)?.group
    if (!entry || group === undefined) return entry
    const pivot = run.selected.has(group) ? run.sets.find(item => { const slot = run.slots.get(item.key); return slot?.group === group && slot.view === 'pivot' }) : undefined
    return pivot ?? run.sets.find(item => { const slot = run.slots.get(item.key); return slot?.group === group && slot.view === 'table' }) ?? entry
  }
  /** The entries closing `key` would close, in the order drawn: a Table's whole group, any other view alone. */
  closing(tabId: string, key: EntryKey): readonly ResultSetEntry[] {
    const run = this.runs.get(tabId), entry = run?.entries.get(key)
    return run && entry ? this.owned(run, entry) : []
  }
  /** A grid (or a multi-server run's virtual Summary view) took the focus: commands that name no grid act on it (the
   *  toolbar's and the menus' Transposed toggle read its orientation, through the publish), its group's selected view is
   *  the one it shows, and the pivot builder follows its group. */
  focusEntry(tabId: string, key: EntryKey): void {
    const run = this.runs.get(tabId)
    if (!run) return
    if (key === summaryEntryKey) {
      if (!hasMultiSummary(run)) return
      const view = this.viewState(tabId)
      const changed = view.focused !== summaryEntryKey || !run.activeSummary
      view.focused = summaryEntryKey
      run.activeSummary = true
      if (changed) this.publishNow(tabId)
      return
    }
    const record = run.slots.get(key)
    if (!record) return
    const view = this.viewState(tabId)
    let changed = view.focused !== key || run.activeSummary
    view.focused = key
    run.activeSummary = false
    if (this.select(run, key)) changed = true
    if (changed) this.publishNow(tabId)
  }
  /** The entry `key` has the focus: its group's selected view is the one it shows (a comparison has no group).
   *  Whether that changed. */
  private select(run: Run, key: EntryKey): boolean {
    const record = run.slots.get(key)
    if (!record || record.group === undefined || run.selected.has(record.group) === (record.view === 'pivot')) return false
    if (record.view === 'pivot') run.selected.add(record.group)
    else run.selected.delete(record.group)
    run.shape = undefined
    return true
  }

  /** The stack's collapsed entries (a caption's toggle, a search opening a grid): kept in the tab's view state and
   *  published, so what reads whether a view is shown (a Pivot following its Table's filters) sees it change. */
  setCollapsed(tabId: string, collapsed: ReadonlySet<EntryKey>): void {
    const view = this.viewState(tabId)
    if (view.collapsed === collapsed) return
    view.collapsed = collapsed
    this.publishNow(tabId)
  }

  /** The tab's view state, created on first use. */
  viewState(tabId: string): TabViewState {
    let view = this.views.get(tabId)
    if (!view) this.views.set(tabId, view = emptyView())
    return view
  }
  /** The entry whose grid last had the focus, else the run's first (undefined when Summary is active): what a command acts on when it names no grid. */
  focusedEntry(tabId: string): ResultSetEntry | undefined {
    const run = this.runs.get(tabId), focused = this.views.get(tabId)?.focused
    if (!run) return undefined
    if (run.activeSummary || focused === summaryEntryKey) return undefined
    return (focused === undefined ? undefined : run.entries.get(focused)) ?? run.sets[0]
  }
  /** One grid's state: scroll, widths and selection. It is the entry's, wherever the entry stands. */
  gridState(tabId: string, key: EntryKey): GridViewState {
    const grids = this.viewState(tabId).grids
    let state = grids.get(key)
    if (state) return state
    state = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false }
    // Kept only for an entry the run has: a key that names none (a grid drawn from a snapshot the run has left behind)
    // gets a state of its own that nothing holds on to.
    if (this.runs.get(tabId)?.entries.has(key)) grids.set(key, state)
    return state
  }

  /** Whether an entry's view can be drawn transposed: a query's rows or a pivot (never a comparison or a plan set), while its
   *  results are open and readable. It can while rows still arrive: the drawn columns grow with them. */
  canTranspose(tabId: string, key: EntryKey): boolean {
    const run = this.runs.get(tabId), set = this.entry(run, key), state = set?.handle.getSnapshot().state
    return !!run && !!set && run.status !== 'closed' && run.status !== 'lost' && turnable(set) && state !== 'released' && state !== 'lost'
  }
  /** How an entry's view is drawn. A header column the result does not have heads nothing. */
  orientation(tabId: string, key: EntryKey): ViewOrientation {
    const set = this.entry(this.runs.get(tabId), key)
    // The one rule (transposedView), so the grid, the commands and Copy and Save agree on what is drawn.
    const turned = set && transposedView(this.views.get(tabId)?.grids.get(set.key), set.descriptor)
    return !turned ? table : turned.headerColumn === undefined ? turnedPlain : { transposed: true, headerColumn: turned.headerColumn }
  }
  /**
   * Draws an entry's view transposed or as a table, and sets the column that heads its drawn columns (`headerColumn`: a
   * column, null for "Row N", absent to keep the one it has; it is kept while the view is a table). Only the view's grid
   * state changes: nothing is stored, and the selection, sort and filters stay as they are. False when nothing changed.
   */
  setOrientation(tabId: string, key: EntryKey, o: { readonly transposed: boolean; readonly headerColumn?: number | null }): boolean {
    const set = this.entry(this.runs.get(tabId), key)
    if (!set || !this.canTranspose(tabId, set.key)) return false
    if (typeof o.headerColumn === 'number' && !headerable(set, o.headerColumn)) return false
    const state = this.gridState(tabId, set.key), before = this.orientation(tabId, set.key)
    if (o.transposed) state.orientation = 'transposed'
    else delete state.orientation
    if (o.headerColumn === null) delete state.headerColumn
    else if (o.headerColumn !== undefined) state.headerColumn = o.headerColumn
    const after = this.orientation(tabId, set.key)
    if (before.transposed === after.transposed && before.headerColumn === after.headerColumn) return false
    this.publishNow(tabId)
    return true
  }
  /** Transposed, a search match in a row past those drawn was asked for: the toolbar says so, and nothing moved. */
  beyondCap(tabId: string, row: number): void {
    this.notify(tabId, beyondCapText(row))
  }

  /** The user picked an output pane: automatic switching stops until the next run. */
  setView(tabId: string, view: OutputViewName): void {
    // An isolated estimate may own the output before this tab has ordinary results.
    this.events.emit({ type: 'query.outputSelected', tabId, view })
    const run = this.runs.get(tabId)
    if (!run || (run.view === view && run.manualView)) return
    run.view = view
    run.manualView = true
    this.publishNow(tabId)
  }

  /** The user opened or closed the Messages strip: it stays so for this run, and a strip opened starts open next time. */
  setStrip(tabId: string, open: boolean): void {
    const run = this.runs.get(tabId)
    if (!run) return
    this.stripChoices.set(tabId, open)
    if (run.strip === open && run.stripManual) return
    run.strip = open
    run.stripManual = true
    this.publishNow(tabId)
  }

  /** The grid a command acts on registers while it is mounted. */
  registerGrid(tabId: string, key: EntryKey, controller: GridController): Disposable {
    if (!this.entry(this.runs.get(tabId), key)) return { dispose: () => {} }
    this.controllers.set(key, controller)
    return {
      dispose: () => {
        if (this.controllers.get(key) !== controller) return
        this.controllers.delete(key)
        this.drawing.delete(key)
        // No grid draws it now (collapsed, or its tab switched away): the views it held close but the current one
        // (drawnView), so a cleared sort's view does not wait for the grid to be shown again.
        const run = this.runs.get(tabId)
        if (run) this.closeHeld(run, key)
      }
    }
  }
  /** The mounted comparison grid of an entry, for moving between its differences. */
  diffControls(tabId: string, key: EntryKey): DiffGridControls | undefined {
    const set = this.entry(this.runs.get(tabId), key)
    return set?.descriptor.kind === 'diff' ? this.controllers.get(set.key)?.diff : undefined
  }
  /** Fitting uses the mounted grid's bounded measurement and current (possibly sorted) view. */
  canFitColumn(tabId: string, key: EntryKey, column: number): boolean {
    const set = this.entry(this.runs.get(tabId), key), state = set?.handle.getSnapshot().state
    return !!set && Number.isInteger(column) && column >= 0 && column < set.descriptor.columns.length && !isHiddenColumn(set.descriptor.columns[column])
      && state !== 'released' && state !== 'lost' && this.controllers.has(set.key)
  }
  fitColumn(tabId: string, key: EntryKey, column: number): void {
    const set = this.entry(this.runs.get(tabId), key)
    if (set && this.canFitColumn(tabId, set.key, column)) this.controllers.get(set.key)?.fitColumn(column)
  }
  /** Transposed, Fit Column fits a drawn column, which shows one row of the result (`row`), or without a row the name
   *  column: whether the mounted grid can. */
  canFitDrawn(tabId: string, key: EntryKey, row: number | undefined): boolean {
    const set = this.entry(this.runs.get(tabId), key), snapshot = set?.handle.getSnapshot()
    return !!set && !!snapshot && this.orientation(tabId, set.key).transposed && snapshot.state !== 'released' && snapshot.state !== 'lost'
      && (row === undefined || (Number.isInteger(row) && row >= 0 && row < wire.transpose.maxRows)) && !!this.controllers.get(set.key)?.fitDrawn
  }
  fitDrawn(tabId: string, key: EntryKey, row: number | undefined): void {
    const set = this.entry(this.runs.get(tabId), key)
    if (set && this.canFitDrawn(tabId, set.key, row)) this.controllers.get(set.key)?.fitDrawn?.(row)
  }
  selection(tabId: string, key: EntryKey): GridSelection | undefined {
    const set = this.entry(this.runs.get(tabId), key)
    const selection = set && this.views.get(tabId)?.grids.get(set.key)?.selection
    return selection && selection.entry === set.key ? selection : undefined
  }
  setSelection(tabId: string, key: EntryKey, selection: GridSelection | undefined): void {
    const set = this.entry(this.runs.get(tabId), key)
    if (!set) return
    this.gridState(tabId, set.key).selection = selection
    this.controllers.get(set.key)?.repaint()
    this.selectionChanged()
  }
  /** A grid's selection changed (the grid reports its own presses and keys; `setSelection` and the rest report theirs). */
  selectionChanged(): void { this.selectionStore.bump() }
  /**
   * Selects a whole column of a grid from outside it (a column profile card) and scrolls the grid to it, keeping the
   * active row; the grid keeps its focus where it was. A grid not drawn just takes the selection.
   */
  selectColumn(tabId: string, key: EntryKey, column: number): void {
    const set = this.entry(this.runs.get(tabId), key)
    if (!set || !Number.isInteger(column) || column < 0 || column >= set.descriptor.columns.length) return
    const controller = this.controllers.get(set.key)
    if (controller?.selectColumn) controller.selectColumn(column)
    else this.setSelection(tabId, set.key, columnSelection(set.key, column, this.selection(tabId, set.key)?.active.row ?? 0))
  }
  /** Select All: an open-ended block that grows as rows stream in. */
  selectAll(tabId: string, key: EntryKey): void {
    const set = this.entry(this.runs.get(tabId), key)
    if (!set) return
    const controller = this.controllers.get(set.key)
    if (controller) controller.selectAll()
    else this.setSelection(tabId, set.key, selectAll(set.key, this.selection(tabId, set.key)?.active))
  }
  clearSelections(tabId: string): void {
    for (const [key, state] of this.views.get(tabId)?.grids ?? []) {
      state.selection = undefined
      this.controllers.get(key)?.repaint()
    }
    this.selectionChanged()
  }

  /** The entry a copy of this tab's runs now (the service's own state, a frame ahead of the published job list): a
   *  rebuild nobody asked for waits for it rather than cancel it. */
  copyingEntry(tabId: string): EntryKey | undefined {
    const copying = this.copying
    return copying && copying.tabId === tabId && this.runs.get(tabId)?.jobs.includes(copying.job) ? copying.job.entry : undefined
  }

  /**
   * Copies the grid's selection: the backend formats it (Copy's TSV, with headers on request) and main writes the
   * clipboard. One copy runs per window, so a new one cancels the last. Resolves to the sentence the error banner shows
   * when it fails; a cancelled copy is silent.
   */
  async copy(tabId: string, key: EntryKey, headers: boolean): Promise<string | undefined> {
    const run = this.runs.get(tabId), set = this.entry(run, key), selection = set && this.selection(tabId, set.key)
    if (!run || !set || !selection) return undefined
    const state = set.handle.getSnapshot().state
    if (state === 'lost' || state === 'released') return state === 'lost' ? unavailable : closedResults
    // A grid drawn transposed copies as drawn: the selection it shows, written turned.
    const turned = transposedView(this.views.get(tabId)?.grids.get(set.key), set.descriptor)
    const parts = (turned ? transposedCopyPlan : copyPlan)(selection, set.descriptor.columns.length)
    if (parts.length === 0) return undefined
    this.cancelRunning(this.copying)
    const jobId = this.newId()
    const running: RunningJob = { tabId, job: { jobId, kind: 'copy', entry: set.key, label: this.jobLabel(run, set), rowsDone: 0, rowsTotal: 0, startedAt: this.now(), visible: false, ...turned ? { columns: true } : {} } }
    this.copying = running
    run.jobs = [...run.jobs, running.job]
    this.schedule(tabId)
    running.timer = this.timers.setTimeout(() => { running.timer = undefined; this.updateJob(running, { visible: true }) }, g.copyStripDelayMs)
    let result
    // The view the selection's rows are positions in (a sort just built is not it until the grid has swapped to it).
    const view = this.drawnView(run, set.key)
    try { result = await this.api.copyResults({ jobId, ...jobSource(set.handle, view), headers, parts, ...turned ? { transposed: true, ...turned } : {} }) }
    finally { this.endJob(running) }
    if (result.ok) {
      const { rows, partial, truncatedCells, capped } = result.value
      const sentence = `Copied ${formatCount(rows)} ${plural(rows, 'row')}${turned ? ' as columns' : ''}${partial ? '; the query is still running.' : '.'}${truncatedClause(truncatedCells)}${cappedClause(capped)}`
      // Values cut where they were stored are copied cut, and rows past those drawn are left out: that is shown, not only read out.
      if (truncatedCells > 0 || capped > 0) this.notify(tabId, sentence)
      else this.announce(tabId, sentence)
      return undefined
    }
    if (result.code === 'CANCELLED') return undefined
    return result.code === 'TOO_LARGE' ? result.error : 'Could not copy the results: ' + result.error
  }

  /**
   * Save Results As for one grid: main asks for the file and the backend writes it (ResultTextWriter); only the file's
   * name comes back. The set must have finished loading. The save goes on when the tab runs again or closes (the backend
   * leases the result); Cancel, Escape and reloading the window stop it. Resolves to the sentence the error banner shows
   * when it fails; a cancelled dialog is silent, and the end of a save is announced and shown in the toolbar.
   */
  async saveAs(tabId: string, key: EntryKey, baseName: string): Promise<string | undefined> {
    const run = this.runs.get(tabId), set = this.entry(run, key)
    if (!run || !set) return undefined
    const snapshot = set.handle.getSnapshot()
    if (snapshot.state === 'lost' || snapshot.state === 'released') return snapshot.state === 'lost' ? unavailable : closedResults
    if (snapshot.state !== 'complete') return stillLoading
    const sort = run.sorts.get(set.key)
    // The file follows the grid's order, which a running sort or filter is about to change: Save waits for it.
    if (this.heldOff(tabId, set.key)) return stillSorting
    if (sort && !sort.sorting && sort.stale && sort.view) return partialView
    if (sort && (sort.sorting || sort.stale || !sort.view)) return stillSorting
    const jobId = this.newId()
    // A grid drawn transposed saves as drawn: a line per column, which its progress then counts.
    const turned = transposedView(this.views.get(tabId)?.grids.get(set.key), set.descriptor)
    let saved!: () => void
    const done = new Promise<void>(resolve => { saved = resolve })
    const running: RunningJob = { tabId, handle: set.handle, done, job: { jobId, kind: 'save', entry: set.key, label: this.jobLabel(run, set), rowsDone: 0, rowsTotal: turned ? set.descriptor.columns.length : isRemoteView(sort?.view) ? sort.view.rows : snapshot.rowsAvailable, startedAt: this.now(), visible: false, ...turned ? { columns: true } : {} } }
    this.saves.set(jobId, running)
    this.clearJobNotice(tabId)
    run.jobs = [...run.jobs, running.job]
    this.schedule(tabId)
    let result
    const suggested = saveName(baseName, this.saveSubject(run, set, !!turned))
    try { result = await this.api.saveResults({ jobId, ...jobSource(set.handle, sort?.view), suggestedName: suggested.name, ...suggested.suffix ? { suggestedSuffix: suggested.suffix } : {}, ...turned ? { transposed: true, ...turned } : {} }) }
    finally { this.endJob(running); saved() }
    if (this.disposed) return undefined
    if (result.ok) {
      if (!result.value) return undefined
      const { rows, truncatedCells, fileName, capped } = result.value
      const text = `Saved ${formatCount(rows)} ${plural(rows, 'row')}${turned ? ' as columns' : ''} to ${fileName}.${truncatedClause(truncatedCells)}${cappedClause(capped)}`
      this.notify(running.tabId, text)
      // Also when the tab has closed meanwhile (the save outlives it), which leaves no toolbar to say so.
      this.events.emit({ type: 'results.saved', tabId: running.tabId, text })
      return undefined
    }
    if (result.code === 'CANCELLED') { this.notify(running.tabId, saveCancelled); return undefined }
    return result.code && saveSentences.has(result.code) ? result.error : 'Could not save the results: ' + result.error
  }

  /** What a copy's or save's strip calls the view: a Table by its result's title ("Totals, Result 3", "Result 3"), a Pivot
   *  or comparison by its own name ("Pivot of Result 3", "Differences: Result 1 → Result 3"), never by the number a derived
   *  entry was given. */
  private jobLabel(run: Run, set: ResultSetEntry): string {
    return run.slots.get(set.key)?.view === 'table' ? resultTitle(set) : entryName(set)
  }

  /** What Save Results As names the entry's file after (save-names.ts): a Table or Pivot by its group's result (its number,
   *  and its name when the query gave one, numbered too when another result's name makes the same file name), a
   *  comparison by its place among the run's comparisons. */
  private saveSubject(run: Run, set: ResultSetEntry, transposed: boolean): SaveSubject {
    const subject = this.namingOf(run, set)
    if (subject.view === 'comparison') return subject
    const table = subject.table, name = subject.name
    // Two tables whose names make one file name both keep their numbers, and so do their Pivots; so does a name that is a
    // tail another entry's file takes by its number or its name (`#Result2` beside an unnamed Result 2).
    const collides = name !== undefined && (run.sets.some(other => other !== table && run.slots.get(other.key)?.view === 'table' && sameFileName(queryName(other), name))
      || nameMeetsOthers(subject, run.sets.filter(other => other !== set).map(other => this.namingOf(run, other))))
    return { view: subject.view, number: subject.number, ...name === undefined ? {} : { name }, ...collides ? { collides } : {}, ...transposed ? { transposed } : {} }
  }

  /** An entry as Save Results As names it, before collisions: a Table or Pivot by its group's Table, a comparison by its
   *  place among the run's comparisons. */
  private namingOf(run: Run, set: ResultSetEntry): SaveSubject & { table?: ResultSetEntry } {
    const record = run.slots.get(set.key)
    if (record?.view === 'comparison') return { view: 'comparison', number: record.made ?? 1 }
    const table = record?.view === 'pivot' ? run.sets.find(entry => { const slot = run.slots.get(entry.key); return slot?.view === 'table' && slot.group === record.group }) : set
    const number = table?.number ?? record?.sources[0]?.number ?? set.number, name = table ? queryName(table) : undefined
    return { view: record?.view === 'pivot' ? 'pivot' : 'table', number, ...name === undefined ? {} : { name }, ...table ? { table } : {} }
  }

  /**
   * Open Value in New Tab for an XML, JSON or plan cell: the worker reads the whole stored value and formats it, and it
   * opens as a text document. A value the backend stored as a prefix opens unformatted, with a sentence saying so; a
   * NULL or unreadable value opens nothing.
   */
  async openValue(tabId: string, key: EntryKey, row: number, column: number, capturedPlan = false): Promise<OpenedValue> {
    // A captured plan's set is not one of the stack's entries: it is looked up among the run's plan sets.
    const run = this.runs.get(tabId), set = capturedPlan ? run?.planSets.find(plan => plan.key === key) : this.entry(run, key)
    const info = set?.descriptor.columns[column], spec = info?.role ? valueKinds[info.role] : undefined
    if (!set || !info || !spec || !this.documents) return { opened: false }
    const state = set.handle.getSnapshot().state
    if (state === 'lost' || state === 'released') return { opened: false, message: state === 'lost' ? unavailable : closedResults }
    const cell = `${set.key}:${row}:${column}`
    if (this.opening.has(cell)) return { opened: false }
    this.opening.add(cell)
    try {
      // Rows are the grid's: a sorted grid's are its view's positions.
      const handle = (capturedPlan ? undefined : run?.sorts.get(set.key)?.view) ?? set.handle
      const value = await handle.getCell(row, column, { format: spec.kind === 'json' ? 'json' : 'xml' })
      // A value read for a result closed meanwhile opens nothing.
      if (this.disposed || !this.has(tabId, run, set) || value.isNull || value.error) return { opened: false }
      const base = spec.base ?? valueBase(info, spec.kind), number = (this.valueNumbers.get(base + spec.extension) ?? 0) + 1
      this.valueNumbers.set(base + spec.extension, number)
      this.documents.openText({ name: `${base}${number}${spec.extension}`, text: value.text, kind: spec.kind })
      return { opened: true, ...value.truncated ? { message: `This ${kindInfo[spec.kind].value} value was truncated at 2,097,152 characters, so it opened unformatted.` } : {} }
    } catch (error) {
      // Its result was closed while the value was read: that is not a failure to report.
      if (!this.has(tabId, run, set)) return { opened: false }
      return { opened: false, message: 'Could not open the value: ' + (error instanceof Error ? error.message : 'The value could not be read.') }
    }
    finally { this.opening.delete(cell) }
  }

  /** A grid's sort, while it has one. */
  sortOf(tabId: string, key: EntryKey): GridSort | undefined {
    const run = this.runs.get(tabId), set = this.entry(run, key)
    return set && run!.sorts.get(set.key)
  }

  /**
   * Sorts a grid by a column: alone, or with `add` as a further key after those it has (moved to the end when it is one).
   * `none` takes the column out of the sort; a grid left with no key shows its rows in the order SQL Server sent them.
   */
  sortBy(tabId: string, key: EntryKey, column: number, direction: SortDirection, add = false): void {
    const run = this.runs.get(tabId), set = this.entry(run, key)
    if (!run || !set || column < 0 || column >= set.descriptor.columns.length || this.heldOff(tabId, set.key) || this.unorderable(tabId, set, column, direction !== 'none')) return
    this.applySort(tabId, run, set.key, sortKeysBy(run.sorts.get(set.key)?.keys ?? [], column, direction, add, wire.views.maxKeys, (descending): ViewSortKey => ({ column, descending, mode: 'value' })))
  }

  /** A header's sort button (`cycleSortKeys`, which a live grid's header shares): ascending, then descending, then out of
   *  the sort. With `add`, the column changes in place among the keys (a new one goes last); without, it becomes the only key. */
  cycleSort(tabId: string, key: EntryKey, column: number, add = false): void {
    const run = this.runs.get(tabId), set = this.entry(run, key)
    if (!run || !set || column < 0 || column >= set.descriptor.columns.length || this.heldOff(tabId, set.key) || this.unorderable(tabId, set, column, true)) return
    this.applySort(tabId, run, set.key, cycleSortKeys(run.sorts.get(set.key)?.keys ?? [], column, add, wire.views.maxKeys, (descending): ViewSortKey => ({ column, descending, mode: 'value' })))
  }

  /** Whether a column of a grid can be sorted by and filtered by value: a windowed BigQuery result's only when BigQuery can
   *  order its type (its header's sort button and funnel say why not). */
  canOrderColumn(tabId: string, key: EntryKey, column: number): boolean {
    const set = this.entry(this.runs.get(tabId), key), item = set?.descriptor.columns[column]
    return !!item && (!isRemoteHandle(set!.handle) || remoteOrderable(item))
  }

  /** A windowed result's column BigQuery cannot order, said in the toolbar when `say`. */
  private unorderable(tabId: string, set: ResultSetEntry, column: number, say: boolean): boolean {
    const item = set.descriptor.columns[column]
    if (!item || !isRemoteHandle(set.handle) || remoteOrderable(item)) return false
    if (say) this.notify(tabId, unorderableText(item))
    return say
  }

  clearSort(tabId: string, key: EntryKey): void {
    const run = this.runs.get(tabId), set = this.entry(run, key)
    if (run && set && run.sorts.get(set.key)?.keys.length && !this.heldOff(tabId, set.key)) this.applySort(tabId, run, set.key, [])
  }

  /**
   * Filters a grid by its selection: rows with a selected value (`in`), without one (`notIn`), from the lowest selected
   * value to the highest (`between`), or, for the active cell's column, without NULL (`notNull`). A selection across
   * columns, contiguous or not, filters each column by the cells selected in it, and a row must pass every column's
   * filter. Values are equal as the column's collation and type say. A filter of the same kind on a column replaces the
   * one it has. False when the selection does not fit the filter.
   */
  filterSelection(tabId: string, key: EntryKey, kind: SelectionFilter): boolean {
    const run = this.runs.get(tabId), set = this.entry(run, key), target = this.filterTarget(tabId, key, kind)
    if (set && this.needsRows(tabId, set)) return false
    if (!run || !set || !target || this.heldOff(tabId, set.key)) return false
    const index = set.key
    const items = target.columns.map(({ column, ranges }): GridFilter => {
      const filter: ViewFilter = kind === 'notNull' ? { op: 'notIn', column, rows: [], nulls: true }
        : { op: kind, column, cells: { ranges, ...target.viewId === undefined ? {} : { viewId: target.viewId } } }
      const name = columnName(set.descriptor.columns, column)
      return kind === 'notNull' ? { filter, label: `${name} is not NULL`, named: true } : { filter, label: `${name}: filtering…` }
    })
    // Exclude NULLs is a notIn of its own: it and Exclude Selected Values on a column each replace only their own kind.
    const same = (other: GridFilter) => items.some(({ filter }) => other.filter.op === filter.op && 'column' in other.filter && 'column' in filter
      && other.filter.column === filter.column && isNotNull(other.filter) === (kind === 'notNull'))
    return this.addFilter(tabId, run, index, (run.sorts.get(index)?.filters ?? []).filter(other => !same(other)), items)
  }

  /** A windowed BigQuery result has no rows here for a filter that names rows: the toolbar says so. */
  private needsRows(tabId: string, set: ResultSetEntry): boolean {
    if (!isRemoteHandle(set.handle)) return false
    this.notify(tabId, remoteSelectionText)
    return true
  }

  /** Whether `filterSelection` can filter the grid's selection that way. */
  canFilterSelection(tabId: string, key: EntryKey, kind: SelectionFilter): boolean { return !!this.filterTarget(tabId, key, kind) }

  /** Keeps a grid's rows whose values in the selected columns (every column with `allColumns`) repeat, each group together. */
  filterDuplicates(tabId: string, key: EntryKey, allColumns = false): boolean {
    const run = this.runs.get(tabId), set = this.entry(run, key), columns = this.duplicateColumns(tabId, key, allColumns)
    if (set && this.needsRows(tabId, set)) return false
    if (!run || !set || !columns || this.heldOff(tabId, set.key)) return false
    const index = set.key
    const names = set.descriptor.columns
    const label = filterLabel({ op: 'duplicates', columns }, names)
    const filters = (run.sorts.get(index)?.filters ?? []).filter(item => !(item.filter.op === 'duplicates' && sameColumns(item.filter.columns, columns)))
    return this.addFilter(tabId, run, index, filters, { filter: { op: 'duplicates', columns }, label, named: true })
  }

  /**
   * Keep Selected Rows: filters a grid to the rows its selection covers, whatever their values (a `keepRows` filter, which
   * the view resolves to base rows). A grid has one: a new one takes the place of the one it has among the filters, or goes
   * last when a duplicates filter follows that one. More rows or ranges than the filter takes says so in the toolbar and
   * applies nothing. False when nothing was applied.
   */
  keepSelectedRows(tabId: string, key: EntryKey, kept?: () => void): boolean {
    const run = this.runs.get(tabId), set = this.entry(run, key), target = this.keepTarget(tabId, key)
    if (set && this.needsRows(tabId, set)) return false
    if (!run || !set || !target || this.heldOff(tabId, set.key)) return false
    const maxRows = wire.transpose.maxRows, maxRanges = wire.views.maxFilterRanges
    if (target.rows > maxRows || target.ranges.length > maxRanges) {
      const selected = target.rows > maxRows ? `${formatCount(target.rows)} rows` : `${formatCount(target.ranges.length)} ranges`
      this.notify(tabId, `Keep Selected Rows takes at most ${formatCount(maxRows)} rows in ${maxRanges} ranges; ${selected} are selected. Nothing was applied.`)
      return false
    }
    const filters = run.sorts.get(set.key)?.filters ?? [], others = filters.filter(item => item.filter.op !== 'keepRows')
    const old = filters.findIndex(item => item.filter.op === 'keepRows')
    // The selected rows passed every filter. In the old one's place a duplicates filter after it would count only them, and
    // drop each whose pair was not selected; last, the grid shows exactly the rows selected.
    const at = old < 0 || filters.slice(old + 1).some(item => item.filter.op === 'duplicates') ? others.length : old
    const filter: ViewFilter = { op: 'keepRows', cells: { ranges: target.ranges, ...target.viewId === undefined ? {} : { viewId: target.viewId } } }
    // The view answers the rows it kept (fewer than selected while rows still arrive): the chip then counts those.
    // `kept` runs once, when the view this call asked for has been built (Transpose Selected Rows turns the grid then): never
    // for a view that failed, or that another sort or filter took the place of first.
    return this.addFilter(tabId, run, set.key, others, { filter, label: keptLabel(target.rows) }, at, kept)
  }

  /** Whether the grid has rows selected to keep (more than the filter takes still runs the command, which then says so). */
  canKeepSelectedRows(tabId: string, key: EntryKey): boolean { return !!this.keepTarget(tabId, key) }

  /**
   * A comparison's chips (D11): its kind filter keeps exactly `kinds`, read from the change index, before its other
   * filters; none removes it. Its sort keys and other filters stay. False when nothing was applied (not a comparison, or
   * a sort or filter of it still being built).
   */
  setKindFilter(tabId: string, key: EntryKey, kinds: readonly DiffKindName[]): boolean {
    const run = this.runs.get(tabId), set = this.entry(run, key)
    if (!run || !set || set.descriptor.kind !== 'diff' || !this.filterable(set) || this.heldOff(tabId, set.key)) return false
    const filters = run.sorts.get(set.key)?.filters ?? [], others = filters.filter(item => item.filter.op !== 'kind')
    if (kinds.length === 0) {
      if (others.length !== filters.length) this.applyView(tabId, run, set.key, run.sorts.get(set.key)?.keys ?? [], others, 'filter')
      return true
    }
    const filter: ViewFilter = { op: 'kind', kinds: [...kinds] }
    return this.addFilter(tabId, run, set.key, others, { filter, label: kindLabel(kinds), named: true }, 0)
  }

  /** Adds a filter after the grid's others, or at `at` among them (where the one it replaces stood, since filters apply in
   *  order and a duplicates filter after it counts only the rows it keeps); a grid that has as many as a view takes says
   *  so and keeps them. */
  private addFilter(tabId: string, run: Run, index: EntryKey, others: readonly GridFilter[], item: GridFilter | readonly GridFilter[], at = others.length, built?: () => void): boolean {
    const items = Array.isArray(item) ? item as readonly GridFilter[] : [item as GridFilter]
    if (others.length + items.length > wire.views.maxFilters) {
      this.notify(tabId, `Could not filter the results: a grid takes at most ${wire.views.maxFilters} filters. Remove ${others.length + items.length - wire.views.maxFilters === 1 ? 'one' : 'some'} first.`)
      return false
    }
    this.applyView(tabId, run, index, run.sorts.get(index)?.keys ?? [], [...others.slice(0, at), ...items, ...others.slice(at)], 'filter', built)
    return true
  }

  /** Whether a grid's column can open the funnel's popover: a result's own column (not a hidden one) on a mounted grid. */
  canFilterColumn(tabId: string, key: EntryKey, column: number): boolean {
    const set = this.entry(this.runs.get(tabId), key)
    return !!set && this.filterable(set) && Number.isInteger(column) && column >= 0 && column < set.descriptor.columns.length && !isHiddenColumn(set.descriptor.columns[column]) && this.canOrderColumn(tabId, set.key, column)
      && !!this.controllers.get(set.key)?.filterColumn
  }

  /** Opens the funnel's popover for a column (the grid menu's Filter Column Values, Alt+Down in a grid). */
  filterColumn(tabId: string, key: EntryKey, column: number): void {
    const set = this.entry(this.runs.get(tabId), key)
    if (set && this.canFilterColumn(tabId, set.key, column)) this.controllers.get(set.key)?.filterColumn?.(column)
  }

  /**
   * A column's distinct values for the funnel, kept in the backend as a snapshot (results.distinct): over the rows the
   * grid's other filters keep, so values the column's own value list drops can be ticked again. When the column has such a
   * filter the grid's view starts each value ticked only when it keeps it, as it does NULL. The view built for it is closed
   * once the snapshot is; the snapshot is the caller's to close, or to hand to `applyColumnFilter`.
   */
  async columnValues(tabId: string, key: EntryKey, column: number, o: { signal?: AbortSignal } = {}): Promise<DistinctList> {
    const run = this.runs.get(tabId), set = this.entry(run, key), sort = set && run?.sorts.get(set.key)
    if (!run || !set || !this.filterable(set)) throw new Error('These results are no longer available.')
    if (this.heldOff(tabId, set.key) || sort?.sorting) throw new Error('The results are still being sorted or filtered. Try again when they are shown.')
    const filters = sort?.filters ?? [], others = filters.filter(item => { const own = columnFilterKind(item.filter, column); return own === undefined || own === 'between' })
    const signal = o.signal ? { signal: o.signal } : {}
    if (isRemoteHandle(set.handle)) {
      // A query in BigQuery under the other filters, its values ticked by every filter when the column has one of its own.
      if (!this.remote) throw new Error(remoteUnavailable)
      if (!this.canOrderColumn(tabId, set.key, column)) throw new Error(unorderableText(set.descriptor.columns[column]))
      try {
        return await this.remote.values(tabId, set.handle, column, others, others.length === filters.length ? undefined : filters, o.signal)
      } catch (error) {
        if (error instanceof RemoteDeclined) throw new Error('The value list was not loaded.')
        throw error
      }
    }
    if (others.length === filters.length) return (sort?.view ?? set.handle).distinct(column, signal)
    const base = others.length > 0 ? await set.handle.sort([], { filters: others.map(item => item.filter), ...signal }) : undefined
    try {
      return await (base ?? set.handle).distinct(column, { ...signal, ...sort?.view ? { kept: sort.view } : {} })
    } finally { void base?.close() }
  }

  /**
   * Applies the funnel's condition to a column: it replaces the column's filter of the same kind (its value list, its
   * range or its not-NULL), and `clear` takes all of the column's filters off. False when the grid cannot be filtered.
   */
  applyColumnFilter(tabId: string, key: EntryKey, column: number, condition: ColumnCondition): boolean {
    const run = this.runs.get(tabId), set = this.entry(run, key)
    if (!run || !set || !this.filterable(set) || !Number.isInteger(column) || column < 0 || column >= set.descriptor.columns.length || this.heldOff(tabId, set.key)) return false
    const index = set.key
    const filters = run.sorts.get(index)?.filters ?? [], kind = conditionKind(condition)
    const others = filters.filter(item => { const own = columnFilterKind(item.filter, column); return own === undefined || (kind !== undefined && !sameFilterFamily(own, kind)) })
    const filter = conditionFilter(condition, column)
    if (!filter) {
      if (others.length !== filters.length) this.applyView(tabId, run, index, run.sorts.get(index)?.keys ?? [], others, 'filter')
      return true
    }
    if ('rows' in filter && filter.rows.length > wire.views.maxFilterValues) {
      this.notify(tabId, `Could not filter the results: a filter holds at most ${formatCount(wire.views.maxFilterValues)} values.`)
      return false
    }
    // A list of the grid's own result, or a BigQuery value list of it (whose own small result holds the values).
    const list = 'list' in condition ? condition.list : undefined
    // A BigQuery value list fits only a windowed result, a list of its rows only one in memory: the result may have switched
    // while the funnel was open.
    if (list && (list.column !== column || list.generation !== set.handle.key.generation || (list.source ? list.source.resultId : list.resultId) !== set.handle.key.resultId
      || !!list.source !== isRemoteHandle(set.handle))) return false
    // A windowed result's filter names values by a value list's rows.
    if (isRemoteHandle(set.handle) && 'rows' in filter && filter.rows.length > 0 && !list?.source) return false
    const name = columnName(set.descriptor.columns, column)
    const item: GridFilter = condition.kind === 'null' || condition.kind === 'notNull' ? { filter, label: `${name} is ${condition.kind === 'null' ? '' : 'not '}NULL`, named: true }
      : { filter, label: `${name}: filtering…`, ...list ? { list } : {} }
    // In the place of the first filter it replaces: before it, every filter is one of the others.
    const replaced = filters.findIndex(item => !others.includes(item))
    return this.addFilter(tabId, run, index, others, item, replaced < 0 ? others.length : replaced)
  }

  canFilterDuplicates(tabId: string, key: EntryKey, allColumns = false): boolean { return !!this.duplicateColumns(tabId, key, allColumns) }

  /** Takes one filter off a grid; the others apply again in their order. */
  removeFilter(tabId: string, key: EntryKey, at: number): void {
    const run = this.runs.get(tabId), set = this.entry(run, key), sort = set && run?.sorts.get(set.key)
    if (!run || !set || !sort || at < 0 || at >= sort.filters.length || this.heldOff(tabId, set.key)) return
    this.applyView(tabId, run, set.key, sort.keys, sort.filters.filter((_, position) => position !== at), 'filter')
  }

  clearFilters(tabId: string, key: EntryKey): void {
    const run = this.runs.get(tabId), set = this.entry(run, key), sort = set && run?.sorts.get(set.key)
    if (run && set && sort?.filters.length && !this.heldOff(tabId, set.key)) this.applyView(tabId, run, set.key, sort.keys, [], 'filter')
  }

  /** The text sort mode changed: every grid sorted by a column the mode orders (text, xml, json, binary) sorts again. */
  resort(): void {
    for (const [tabId, run] of this.runs) for (const [index, sort] of run.sorts) {
      const columns = run.entries.get(index)?.descriptor.columns
      // BigQuery orders text one way: its views do not depend on the mode, and sorting again would bill a query.
      const handle = run.entries.get(index)?.handle
      if (columns && !(handle && isRemoteHandle(handle)) && sort.keys.some(key => columns[key.column] && lengthSortable(columns[key.column]))) this.applySort(tabId, run, index, sort.keys)
    }
  }

  /** The grid now shows `view` (undefined: its result's own order): the views it held before close. */
  viewShown(tabId: string, key: EntryKey, view: ResultHandle | undefined): void {
    const run = this.runs.get(tabId), set = this.entry(run, key), held = set && run?.held.get(set.key)
    if (!set) return
    this.drawing.add(set.key)
    if (!held) return
    held.shown = view
    this.closeHeld(run!, set.key)
  }

  /** Cancels a copy or save by its job id (Cancel on its strip). */
  cancelJob(jobId: string): void {
    if (this.copying?.job.jobId === jobId) this.cancelRunning(this.copying)
    this.cancelRunning(this.saves.get(jobId))
  }
  /** Escape in a grid: cancels the tab's running copy, else its save once the file is chosen, else its sorts, filters and
   *  other operations over whole results; false when there is none. */
  cancelTabJob(tabId: string): boolean {
    if (this.copying?.tabId === tabId) { this.cancelRunning(this.copying); return true }
    for (const save of this.saves.values()) {
      if (save.tabId === tabId && save.job.fileName !== undefined) { this.cancelRunning(save); return true }
    }
    if (this.operations.cancellable(tabId)) { this.operations.cancel(tabId); return true }
    return false
  }

  /** Whether a sort or filter is building the grid's view, which holds its sorting, filtering and Save off. */
  holdsOff(tabId: string, key: EntryKey): boolean {
    const set = this.entry(this.runs.get(tabId), key)
    return !!set && !!this.operations.building(tabId, set.key)
  }

  /** A held-off control was used: nothing is queued; the operation shows, pulses and the live region says why. */
  private heldOff(tabId: string, key: EntryKey): boolean {
    if (!this.operations.building(tabId, key)) return false
    this.operations.refused(tabId, key)
    return true
  }

  /**
   * A grid's selection changed: its size is read out when it differs from the last one read, so moving the active cell
   * with the arrow keys (which screen readers announce themselves) adds nothing.
   */
  announceSelection(tabId: string, text: string): void {
    // A grid disposing after its tab closed has nothing to read out, and must not leave its sentence behind.
    if (!this.runs.has(tabId) || this.selectionAnnounced.get(tabId) === text) return
    this.selectionAnnounced.set(tabId, text)
    this.announce(tabId, text)
  }

  /** The live region's sentence, after the 300 ms debounce; a copy's or save's outcome is read out again when repeated. */
  announce(tabId: string, sentence: string, fromSwitch = false): void {
    // Switches not read out yet are said first, then the other sentence waiting (a selection, a copy): neither kind replaces
    // the other inside the debounce, while a later sentence of the same kind replaces an earlier one.
    if (!fromSwitch) this.unheardSentence.set(tabId, sentence)
    const text = [...this.unheardSwitches.get(tabId) ?? [], this.unheardSentence.get(tabId) ?? ''].filter(Boolean).join(' ')
    const previous = this.announcements.get(tabId)
    if (previous !== undefined) this.timers.clearTimeout(previous)
    this.announcements.set(tabId, this.timers.setTimeout(() => {
      this.announcements.delete(tabId)
      this.unheardSwitches.delete(tabId)
      this.unheardSentence.delete(tabId)
      const run = this.runs.get(tabId)
      if (!run) return
      // The same sentence again must still be read out: a zero-width space makes it a change.
      run.announcement = run.announcement === text ? text + '\u200b' : text
      run.announced = ++this.announcedCount
      this.publishNow(tabId)
    }, g.liveRegionMs))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.subscriptions) unsubscribe()
    for (const tabId of [...this.runs.keys()]) this.disposeRun(tabId)
    for (const save of this.saves.values()) this.cancelRunning(save)
    for (const timer of [...this.announcements.values(), ...this.noticeTimers.values()]) this.timers.clearTimeout(timer)
    this.announcements.clear()
    this.noticeTimers.clear()
    this.operations.dispose()
    this.controllers.clear()
    this.drawing.clear()
    this.contextStore.clear()
    this.setsStore.clear()
    this.steppableStore.clear()
    this.turnedStore.clear()
    this.comparingStore.clear()
    this.selectionStore.clear()
    this.clearListeners()
  }

  private event(tabId: string, run: Run, event: Exclude<QueryEvent, { type: 'session.opened' }>): void {
    if (this.runs.get(tabId) !== run || run.status !== 'running') return
    switch (event.type) {
      case 'resultSet.opened': case 'resultSet.closed':
        this.opened(run, event.descriptor)
        this.settle(run, event.descriptor)
        if (event.descriptor.kind !== 'combined') run.rowsRead.set(event.descriptor.resultId, event.descriptor.rowsRead)
        if (!run.manualView && run.sets.length > 0) run.view = 'results'
        if (event.descriptor.state === 'complete') this.refreshSorts(tabId, run)
        break
      case 'resultSet.residence':
        this.switched(tabId, run, event.descriptor)
        break
      case 'progress':
        run.completedBatches = event.completedBatches
        run.totalBatches = event.totalBatches
        for (const item of event.results) if (run.rowsRead.has(item.resultId)) run.rowsRead.set(item.resultId, item.rowsRead)
        break
      case 'messages':
        if (run.messages.length + event.messages.length > resultLimits.messages) run.messagesTruncated = true
        run.messages = [...run.messages, ...event.messages].slice(0, resultLimits.messages)
        this.openStripFor(run, event.messages)
        break
    }
    this.schedule(tabId)
  }

  /** Resolves the display label for an opened result set: multi-server target/combined labels, else the query's `#Name`. */
  private entryLabel(run: Run, descriptor: ResultDescriptor): string | undefined {
    if (descriptor.kind === 'combined') return descriptor.name ? `Combined · ${descriptor.name}` : 'Combined'
    if (descriptor.targetKey && run.multi) {
      const target = run.multi.targets.find(item => item.targetKey === descriptor.targetKey)
      const server = target?.label ?? descriptor.targetKey
      return descriptor.name ? `${server} · ${descriptor.name}` : server
    }
    return descriptor.name
  }

  /** Opens a set's handle once, keeping the sets in the backend's order; sets past the limit are not kept.
   *  When called again with final summary metadata (e.g. `rolledBackPreview`, `targetKey`, `statementSlot`), refreshes the entry's descriptor. */
  private opened(run: Run, descriptor: ResultDescriptor): void {
    const key = setKey(descriptor)
    const rolledBack = descriptor.rolledBackPreview ?? run.rolledBackIds.get(key)
    const normalized: ResultDescriptor = rolledBack !== undefined && descriptor.rolledBackPreview !== rolledBack
      ? { ...descriptor, rolledBackPreview: rolledBack }
      : descriptor
    if (run.setKeys.has(key)) {
      const index = run.sets.findIndex(item => setKey(item.descriptor) === key)
      if (index >= 0) {
        const existing = run.sets[index]
        const nextLabel = this.entryLabel(run, normalized)
        const changed = existing.descriptor.rolledBackPreview !== normalized.rolledBackPreview
          || existing.descriptor.targetKey !== normalized.targetKey
          || existing.descriptor.statementSlot !== normalized.statementSlot
          || existing.descriptor.state !== normalized.state
          || existing.label !== nextLabel
        if (changed) {
          const updated: ResultSetEntry = { ...existing, descriptor: { ...existing.descriptor, ...normalized }, ...nextLabel === undefined ? {} : { label: nextLabel } }
          if (run.setsPublished) { run.sets = run.sets.slice(); run.setsPublished = false }
          run.sets[index] = updated
          run.entries.set(updated.key, updated)
          run.shape = undefined
        }
      }
      return
    }
    if (run.sets.length >= resultLimits.sets) return
    run.setKeys.add(key)
    const handle = this.client.open(normalized)
    if (run.setsPublished) { run.sets = run.sets.slice(); run.setsPublished = false }
    // Sets arrive in order, so the place is almost always the end.
    let at = run.sets.length
    while (at > 0 && (run.sets[at - 1].descriptor.index - normalized.index || run.sets[at - 1].descriptor.resultId - normalized.resultId) > 0) at--
    const label = this.entryLabel(run, normalized)
    // The query's own name for the set (a #Name marker, or multi-server target/combined label) labels it as Varia's names label the entries it makes.
    const entry: ResultSetEntry = { key: this.mint(), ordinal: normalized.index + 1, number: normalized.index + 1, descriptor: normalized, handle, ...label === undefined ? {} : { label } }
    run.numbered = Math.max(run.numbered, entry.number)
    run.sets.splice(at, 0, entry)
    run.entries.set(entry.key, entry)
    run.slots.set(entry.key, { view: 'table', group: entry.ordinal, revision: 1, sources: [] })
    run.shape = undefined
    if (run.refocus === entry.ordinal) {
      run.refocus = undefined
      const view = this.viewState(run.tabId)
      view.focused ??= entry.key
    }
  }

  /** Records a set that has all its rows (once): the stack sizes it to them from then on. */
  private settle(run: Run, descriptor: ResultDescriptor): void {
    const key = setKey(descriptor)
    if (descriptor.state !== 'complete' || !run.setKeys.has(key) || run.settled.has(key)) return
    if (run.settledPublished) { run.settled = new Map(run.settled); run.settledPublished = false }
    // A windowed result stores no rows here: the stack sizes it by the rows its grid can read.
    const rows = descriptor.residence === 'remote' ? descriptor.rowsAvailable : descriptor.rowsStored
    run.settled.set(key, { rows, strip: descriptor.incomplete || descriptor.truncated !== undefined })
  }

  /** An error, PRINT or RAISERROR output opens the strip, unless the user opened or closed it in this run. SQL Server's other
   *  messages (warnings, SET STATISTICS output) show in it without opening it. */
  private openStripFor(run: Run, entries: readonly MessageEntry[]): void {
    if (run.strip || run.stripManual) return
    if (entries.some(entry => entry.kind === 'error' || entry.kind === 'print')) run.strip = true
  }

  private totalRows(run: Run): number {
    let rows = 0
    for (const value of run.rowsRead.values()) rows += value
    return rows
  }

  private progress(progress: ResultsJobProgress): void {
    if (this.copying?.job.jobId === progress.jobId) { this.updateJob(this.copying, { rowsDone: progress.rowsDone, rowsTotal: progress.rowsTotal }); return }
    const save = this.saves.get(progress.jobId)
    if (!save) return
    // The first report comes when the file is chosen: the strip's 300 ms start from then, not from the dialog.
    if (save.job.fileName === undefined) save.timer = this.timers.setTimeout(() => { save.timer = undefined; this.updateJob(save, { visible: true }) }, g.copyStripDelayMs)
    this.updateJob(save, { rowsDone: progress.rowsDone, ...progress.rowsTotal > 0 ? { rowsTotal: progress.rowsTotal } : {}, fileName: progress.fileName ?? save.job.fileName ?? '' })
  }

  /** The running saves a tab's new run keeps showing. */
  private savesOf(tabId: string): ResultJob[] {
    const jobs: ResultJob[] = []
    for (const save of this.saves.values()) if (save.tabId === tabId) jobs.push(save.job)
    return jobs
  }

  /** A save's outcome: announced, and shown in the toolbar until the next run or save, or for a few seconds. */
  /** Shows `text` in the tab's results toolbar for a few seconds and reads it out. */
  /** Adds a result Varia made from the run's own after the run ended, named `label`, into the slot its kind takes: a pivot
   *  (results.pivot) as its source group's Pivot, directly under the Table; a diff (results.diff) as a comparison, after the
   *  groups. It is released with the run's others, and its rows are not counted among those the query read. `sources` are
   *  the set keys it was made from (a pivot's Table; a diff's old side, then its new one): a run without them (a newer one)
   *  does not take it. `pivot` is a pivot's provenance, kept with its slot. `names` are the sources' names as its title
   *  gave them (a comparison's, frozen when Compare was pressed), so its tab's "old → new" says what its title says.
   *
   *  A group that has a Pivot keeps it until this call: the new result replaces the old one in the same slot, under the same
   *  entry key, as the slot's next revision, and only then is the old result released (`replaceSet`). Nothing is freed
   *  early to make room, so the backend held both while the new one was built.
   *
   *  Returns its entry's key, or undefined when the run is gone, still running, lacks a source, has its most sets, is
   *  drawn bare, or the result is a pivot of anything but a group's Table of rows; the result is then released, since
   *  nothing else would close it. */
  addSet(tabId: string, descriptor: ResultDescriptor, label: string, sources: readonly string[] = [], o: { readonly pivot?: PivotProvenance; readonly names?: readonly string[] } = {}): EntryKey | undefined {
    const run = this.runs.get(tabId)
    const key = setKey(descriptor)
    if (run?.setKeys.has(key)) return undefined
    const refuse = () => { void this.client.release([{ generation: descriptor.generation, resultId: descriptor.resultId }]).catch(() => {}); return undefined }
    if (!run || run.status === 'running' || run.status === 'closed' || sources.some(source => !run.setKeys.has(source))) return refuse()
    const from = sources.map(source => run.sets.find(entry => setKey(entry.descriptor) === source)!)
    const view: ViewKind = descriptor.kind === 'pivot' ? 'pivot' : 'comparison'
    const origin = from.length ? run.slots.get(from[0].key) : undefined
    // A bare run (Peek) shows its rows alone: no Pivot and no comparison.
    if (run.bare) return refuse()
    // The rules that keep every list a list of groups: a Pivot is made only from a group's Table of rows (never from a
    // Pivot, a comparison or a plan set), and a group has one, so a new one takes the slot of the one it had.
    const group = view === 'comparison' ? undefined : origin?.group
    const refs = from.map((source, at): SourceRef => ({ key: source.key, set: setKey(source.descriptor), number: source.number, name: o.names?.[at] ?? distinctName(source, run.sets), ...source.ordinal === undefined ? {} : { ordinal: source.ordinal } }))
    if (view === 'pivot') {
      if (group === undefined || origin?.view !== 'table' || (from[0].descriptor.kind !== 'rows' && from[0].descriptor.kind !== 'combined')) return refuse()
      const replaced = run.sets.find(entry => { const slot = run.slots.get(entry.key); return slot?.view === 'pivot' && slot.group === group })
      if (replaced) return this.replaceSet(tabId, run, replaced, descriptor, label, refs, o.pivot)
    }
    if (run.sets.length >= resultLimits.sets) return refuse()
    run.setKeys.add(key)
    if (run.setsPublished) { run.sets = run.sets.slice(); run.setsPublished = false }
    // Numbered once, for its life: an entry that goes before it does not renumber it, nor give its number to the next.
    const entry: ResultSetEntry = { key: this.mint(), number: ++run.numbered, descriptor, handle: this.client.open(descriptor), label }
    // A group's Pivot stands directly under its Table; a comparison goes last, after the groups.
    const at = group === undefined ? run.sets.length : run.sets.findIndex(item => item.ordinal === group) + 1
    run.sets.splice(at, 0, entry)
    run.entries.set(entry.key, entry)
    run.slots.set(entry.key, { view, ...group === undefined ? {} : { group }, revision: 1, sources: refs, ...o.pivot ? { pivot: o.pivot } : {}, ...view === 'comparison' ? { made: ++run.compared } : {} })
    run.shape = undefined
    this.settleDerived(run, key, descriptor)
    run.emptied = false
    run.view = 'results'
    this.schedule(tabId)
    return entry.key
  }

  /**
   * A group's Pivot shows a new result: the same entry key, number and place, the slot's next revision and the new
   * provenance, published together; then the old result is released. What named the old result's rows goes with it: the
   * sort or filter being built, its views and filters (the toolbar says the filters were removed), its controller (the grid
   * is built again over the new result), a copy of it, its selection and its scroll. The rest stays: the focus and the
   * group's selected view, collapse and splitter share, the orientation, and the sort keys, widths and header column of each
   * column whose name is unique in both results.
   */
  private replaceSet(tabId: string, run: Run, old: ResultSetEntry, descriptor: ResultDescriptor, label: string, sources: readonly SourceRef[], pivot: PivotProvenance | undefined, columns?: ReadonlyMap<number, number>): EntryKey {
    const key = old.key, record = run.slots.get(key)!
    // A comparison's sort, filters and scroll reset on a replace; its widths follow their columns' names (`columns`).
    const comparison = record.view === 'comparison'
    const moved = columns ?? uniqueNames(old.descriptor.columns, descriptor.columns)
    run.sorting.get(key)?.abort()
    run.sorting.delete(key)
    // Releasing the old result closes its views.
    run.held.delete(key)
    const sort = run.sorts.get(key)
    if (sort) {
      for (const list of new Set([...sort.filters, ...sort.applied].flatMap(item => item.list ? [item.list] : []))) void list.close()
      const sorts = new Map(run.sorts)
      sorts.delete(key)
      run.sorts = sorts
    }
    this.controllers.delete(key)
    this.drawing.delete(key)
    if (this.copying && this.runs.get(this.copying.tabId) === run && this.copying.job.entry === key) this.cancelRunning(this.copying)
    run.setKeys.delete(setKey(old.descriptor))
    if (run.settled.has(setKey(old.descriptor))) {
      if (run.settledPublished) { run.settled = new Map(run.settled); run.settledPublished = false }
      run.settled.delete(setKey(old.descriptor))
    }
    run.setKeys.add(setKey(descriptor))
    const entry: ResultSetEntry = { key, number: old.number, descriptor, handle: this.client.open(descriptor), label }
    if (run.setsPublished) { run.sets = run.sets.slice(); run.setsPublished = false }
    run.sets[run.sets.indexOf(old)] = entry
    run.entries.set(key, entry)
    // The old build's provenance never describes the new one: without its own, the slot has none.
    const { pivot: _previous, ...kept } = record
    run.slots.set(key, { ...kept, revision: record.revision + 1, sources, ...pivot ? { pivot } : {} })
    run.shape = undefined
    const grids = this.views.get(tabId)?.grids, state = grids?.get(key)
    if (grids && state) grids.set(key, carriedState(state, moved, descriptor.columns.length))
    this.settleDerived(run, setKey(descriptor), descriptor)
    run.emptied = false
    // A rebuild the user asked for shows the results; one that followed its Table's filters by itself leaves the pane alone.
    if (!pivot?.followed) run.view = 'results'
    // Published now, before the old result is released: no snapshot ever points a grid at a released handle.
    this.publishNow(tabId)
    // A save of the old Pivot may still be in its file dialog, before main checks the result is there: it is released
    // once that save ends, so rebuilding never fails a save the user started.
    this.releaseEntries(run, [old], [...this.saves.values()].flatMap(save => save.handle === old.handle && save.done ? [save.done] : []))
    if (comparison) return key
    const keys = (sort?.keys ?? []).flatMap(item => { const at = moved.get(item.column); return at === undefined ? [] : [{ ...item, column: at }] })
    if (keys.length) this.applySort(tabId, run, key, keys)
    if (sort?.filters.length) this.notify(tabId, `${distinctName(entry, run.sets)} was built again, so its filters were removed.`)
    return key
  }

  /** A BigQuery result switched residence under a new revision (its event, or a summary that overtook it): the rows the grid
   *  showed are from an older revision, so its selection goes (the grid keeps its scroll), and the status bar and live
   *  region say what changed. */
  private switched(tabId: string, run: Run, descriptor: ResultDescriptor, announce = true): string {
    const entry = run.sets.find(set => set.descriptor.resultId === descriptor.resultId)
    const grid = entry ? this.views.get(tabId)?.grids.get(entry.key) : undefined
    if (entry && grid?.selection) { grid.selection = undefined; this.controllers.get(entry.key)?.repaint(); this.selectionChanged() }
    // Its sort and filters went with the old pages (the backend dropped their views): the grid shows the result again.
    const sort = entry ? run.sorts.get(entry.key) : undefined
    if (entry) {
      run.sorting.get(entry.key)?.abort()
      run.sorting.delete(entry.key)
      // A view built in BigQuery is a result of its own, which the backend kept: it is closed with them.
      for (const view of run.held.get(entry.key)?.views ?? []) if (isRemoteView(view)) void view.close()
      run.held.delete(entry.key)
    }
    if (entry && sort) {
      for (const list of new Set([...sort.filters, ...sort.applied].flatMap(item => item.list ? [item.list] : []))) void list.close()
      const sorts = new Map(run.sorts)
      sorts.delete(entry.key)
      run.sorts = sorts
    }
    // The stack sized it by the older revision's rows: it settles again from this one (a load, once it completes).
    const settledKey = setKey(descriptor)
    if (run.settled.has(settledKey)) {
      if (run.settledPublished) { run.settled = new Map(run.settled); run.settledPublished = false }
      run.settled.delete(settledKey)
    }
    this.settle(run, descriptor)
    const removed = sort && (sort.keys.length > 0 || sort.filters.length > 0) ? ' Its sort and filters were removed.' : ''
    // Among several results the sentence names which one switched.
    const subject = entry && run.sets.length > 1 ? distinctName(entry, run.sets) : 'The result'
    const text = (descriptor.residence === 'remote'
      ? `${subject} is now windowed in BigQuery: rows are read as you scroll.`
      : `${subject} is loading into memory.`) + removed
    if (announce) {
      // Said with any switch not yet read out (several results of a script switching at once): one replaces another.
      this.unheardSwitches.set(tabId, [...this.unheardSwitches.get(tabId) ?? [], text])
      this.announce(tabId, text, true)
    }
    return text
  }

  /**
   * A comparison shows a new result in place (D9): the same entry key, number, place in Tabs and Stacked and count against
   * the run's 1,000 (none more), named `label` (renamed on a swap or Exact text: its tab, caption and accessible name
   * together) with `sources` (set keys, old side then new) and their `names`. Its selection, sort, filters and scroll reset;
   * its column widths carry over by column name (`moved`, old column to new: comparisonColumns), since a swap reorders the
   * pairs. Its highlights stay with the entry key, and the old result is released only after the new one is published
   * (after a Save of it in its dialog ends, as `replaceSet` does). Returns the entry key, or undefined (the new result
   * released) when the run, the comparison or an input is gone.
   */
  replaceComparison(tabId: string, key: EntryKey, descriptor: ResultDescriptor, label: string, sources: readonly string[], o: { readonly names?: readonly string[]; readonly moved: ReadonlyMap<number, number> }): EntryKey | undefined {
    const run = this.runs.get(tabId), old = run?.entries.get(key)
    const refuse = () => { void this.client.release([{ generation: descriptor.generation, resultId: descriptor.resultId }]).catch(() => {}); return undefined }
    if (!run || !old || run.status === 'running' || run.status === 'closed' || run.setKeys.has(setKey(descriptor)) || run.slots.get(key)?.view !== 'comparison'
      || sources.length !== 2 || sources.some(source => !run.setKeys.has(source))) return refuse()
    const refs = sources.map((source, at): SourceRef => {
      const from = run.sets.find(entry => setKey(entry.descriptor) === source)!
      return { key: from.key, set: source, number: from.number, name: o.names?.[at] ?? distinctName(from, run.sets), ...from.ordinal === undefined ? {} : { ordinal: from.ordinal } }
    })
    return this.replaceSet(tabId, run, old, descriptor, label, refs, undefined, o.moved)
  }

  /** A derived set has all its rows when it is added: the stack sizes it to them, and its grid always shows a strip (what
   *  was pivoted or compared). */
  private settleDerived(run: Run, key: string, descriptor: ResultDescriptor): void {
    if (run.settledPublished) { run.settled = new Map(run.settled); run.settledPublished = false }
    run.settled.set(key, { rows: descriptor.rowsStored, strip: true })
  }

  /**
   * Keeps `view` of a grid open while work reads it (a pivot build reads its Table's view), also once the grid has moved on
   * to another; it closes when the last hold ends and the grid neither has it nor shows it. The backend may still evict it.
   * Returns the end of the hold.
   */
  holdView(tabId: string, key: EntryKey, view: ResultView): () => void {
    const run = this.runs.get(tabId)
    if (!run || !run.entries.has(key)) return () => {}
    const held = run.held.get(key) ?? { views: new Set<ResultView>() }
    run.held.set(key, held)
    held.views.add(view)
    const pins = held.pins ??= new Map()
    pins.set(view, (pins.get(view) ?? 0) + 1)
    let ended = false
    return () => {
      if (ended) return
      ended = true
      const count = (pins.get(view) ?? 1) - 1
      if (count > 0) pins.set(view, count)
      else pins.delete(view)
      if (run.held.get(key) === held && this.runs.get(tabId) === run) this.closeHeld(run, key)
    }
  }

  /** Releases a derived result no run took: the late answer of work that was given up. */
  discard(descriptor: Pick<ResultDescriptor, 'generation' | 'resultId'>): void {
    void this.client.release([{ generation: descriptor.generation, resultId: descriptor.resultId }]).catch(() => {})
  }

  notify(tabId: string, text: string): void {
    const run = this.runs.get(tabId)
    if (!run) return
    this.announce(tabId, text)
    this.clearJobNotice(tabId)
    run.jobNotice = text
    this.noticeTimers.set(tabId, this.timers.setTimeout(() => { this.noticeTimers.delete(tabId); this.clearJobNotice(tabId) }, g.jobNoticeMs))
    this.schedule(tabId)
  }
  private clearJobNotice(tabId: string): void {
    const timer = this.noticeTimers.get(tabId)
    if (timer !== undefined) this.timers.clearTimeout(timer)
    this.noticeTimers.delete(tabId)
    const run = this.runs.get(tabId)
    if (run?.jobNotice) { run.jobNotice = ''; this.schedule(tabId) }
  }

  private updateJob(running: RunningJob, patch: Partial<ResultJob>): void {
    const run = this.runs.get(running.tabId)
    const next = { ...running.job, ...patch }
    if (run) run.jobs = run.jobs.map(job => job === running.job ? next : job)
    running.job = next
    this.schedule(running.tabId)
  }

  private endJob(running: RunningJob): void {
    if (running.timer !== undefined) this.timers.clearTimeout(running.timer)
    running.timer = undefined
    if (this.copying === running) this.copying = undefined
    if (this.saves.get(running.job.jobId) === running) this.saves.delete(running.job.jobId)
    const run = this.runs.get(running.tabId)
    if (run && run.jobs.includes(running.job)) { run.jobs = run.jobs.filter(job => job !== running.job); this.schedule(running.tabId) }
  }

  private cancelRunning(running: RunningJob | undefined): void {
    if (!running) return
    void this.api.cancelResultsJob(running.job.jobId).catch(() => {})
  }

  /**
   * Sends a grid's sort to the backend (each key with the text mode now chosen), replacing the view it has once the new one
   * is built; a newer sort of the same grid cancels this one. No keys closes the view. A failure keeps the last view and
   * says why in the toolbar.
   */
  private applySort(tabId: string, run: Run, index: EntryKey, keys: readonly ViewSortKey[]): void {
    this.applyView(tabId, run, index, keys, run.sorts.get(index)?.filters ?? [], 'sort')
  }

  /** Builds a grid's view from its keys and filters (see applySort); a filter's selected cells come back as base rows,
   *  whose values then name the filter. */
  private applyView(tabId: string, run: Run, index: EntryKey, keys: readonly ViewSortKey[], filters: readonly GridFilter[], action: 'sort' | 'filter', built?: () => void): void {
    const set = run.entries.get(index)
    if (!set || this.disposed) return
    run.sorting.get(index)?.abort()
    run.sorting.delete(index)
    const current = run.sorts.get(index)
    if (keys.length === 0 && filters.length === 0) {
      // The view closes once the grid shows the rows in SQL Server's order (viewShown).
      this.setSort(tabId, run, index, undefined)
      this.closeHeld(run, index)
      return
    }
    const mode = this.sortText(), sort = keys.map(key => ({ column: key.column, descending: key.descending, mode }))
    const controller = new AbortController()
    run.sorting.set(index, controller)
    const applied = current?.view ? current.applied : []
    this.setSort(tabId, run, index, { keys: sort, filters, applied, ...current?.view ? { view: current.view } : {}, sorting: true, approximate: current?.approximate ?? false, stale: current?.stale ?? false })
    // The busy state every control reads: newer work that takes its place, or the grid's result going, drops it silently;
    // Cancel (the strip's, Escape) keeps the view the grid had.
    let ticket: OperationTicket | undefined
    const cancel = () => {
      if (run.sorting.get(index) !== controller || this.runs.get(tabId) !== run) return
      run.sorting.delete(index)
      // Cancelling while the view kept was built from the rows that had arrived, and they are all in now, keeps a view
      // nothing builds again (refreshSorts skipped it while this ran): the notice says so, as Save Results As does.
      const partial = !!current?.view && current.stale && set.handle.getSnapshot().state === 'complete'
      ticket?.end(partial ? { cancelled: `${action === 'sort' ? 'Sort' : 'Filter'} cancelled. The grid kept the view of the rows that had arrived; sort or filter again to include every row.` } : 'cancelled')
      controller.abort(remoteStop)
      this.keepLastView(tabId, run, index, set)
    }
    ticket = this.operations.begin(tabId, { kind: action, target: distinctName(set, run.sets), entry: index, column: action === 'sort' ? sort[0]?.column : changedColumn(current?.applied ?? [], filters), cancel })
    controller.signal.addEventListener('abort', () => ticket?.end('dropped'), { once: true })
    // No `replaces`: the old view stays readable until the grid has swapped to the new one, and a sort given up after the
    // backend built it cannot take the shown view with it.
    // A windowed BigQuery result sorts and filters in BigQuery: a billed query after its estimate and the cost prompts,
    // whose answer is a result of its own shown as the view.
    const building = isRemoteHandle(set.handle)
      ? this.remote ? this.remote.view(tabId, set.handle, sort, filters, controller.signal) : Promise.reject(new Error(remoteUnavailable))
      : set.handle.sort(sort, { ...filters.length ? { filters: filters.map(item => item.filter) } : {}, signal: controller.signal, onProgress: (phase, percent) => ticket?.progress(phase, percent) })
    building.then(view => {
      if (run.sorting.get(index) !== controller || this.runs.get(tabId) !== run) { ticket?.end('dropped'); void view.close(); return }
      run.sorting.delete(index)
      ticket?.end('done')
      const held = run.held.get(index) ?? { views: new Set<ResultView>() }
      held.views.add(view)
      run.held.set(index, held)
      const resolved = filters.map((item, at): GridFilter => ({ ...item, filter: view.filters[at] ?? item.filter }))
      this.setSort(tabId, run, index, { keys: sort, filters: resolved, applied: resolved, view, sorting: false, approximate: view.approximate, stale: !view.complete })
      this.closeHeld(run, index)
      this.nameFilters(tabId, run, index, set)
      built?.()
      // The set finished while this view was built (refreshSorts skipped it): build it from every row now.
      if (!view.complete && set.handle.getSnapshot().state === 'complete') this.applyView(tabId, run, index, sort, resolved, action)
    }, (error: unknown) => {
      // A failure is said by the toolbar's notice below, not the operation's.
      ticket?.end('dropped')
      if (run.sorting.get(index) !== controller || this.runs.get(tabId) !== run) return
      run.sorting.delete(index)
      this.keepLastView(tabId, run, index, set)
      // A declined cost prompt ran nothing: the grid keeps what it showed, and nothing needs saying.
      if (error instanceof RemoteDeclined) return
      const reason = error instanceof Error ? error.message : 'The rows could not be sorted.'
      this.notify(tabId, (action === 'filter' ? 'Could not filter the results: ' : 'Could not sort the results: ') + reason)
    })
  }

  /** A view that failed or was cancelled leaves the grid with the last view it had (none: SQL Server's order). */
  private keepLastView(tabId: string, run: Run, index: EntryKey, set: ResultSetEntry): void {
    const last = run.sorts.get(index)
    this.setSort(tabId, run, index, last?.view ? { ...last, keys: last.view.keys, filters: last.applied, sorting: false } : undefined)
    // Names the filters a rebuild took over before their values were read.
    this.nameFilters(tabId, run, index, set)
  }

  /** The column and cells a selection filter takes, or undefined when the selection does not fit it. */
  /**
   * The columns a selection filter acts on, each with the merged runs of view positions selected in it: one column per
   * column the selection's blocks cover (a non-contiguous selection's blocks may cover different rows in each), or the
   * active cell's column for `notNull`. Undefined when a column has more separate runs than a filter takes, `between`
   * has a column with fewer than two cells selected, or the columns are more than a view takes filters.
   */
  private filterTarget(tabId: string, key: EntryKey, kind: SelectionFilter): { columns: { column: number; ranges: [number, number][] }[]; viewId?: number } | undefined {
    const run = this.runs.get(tabId), set = this.entry(run, key), selection = set && this.selection(tabId, set.key)
    if (!run || !set || !selection || !this.filterable(set) || isRemoteHandle(set.handle)) return undefined
    const shown = run.held.get(set.key)?.shown as ResultView | undefined
    const rows = (shown ?? set.handle).getSnapshot().rowsAvailable, names = set.descriptor.columns, count = names.length
    if (kind === 'notNull') return selection.active.column < count ? { columns: [{ column: selection.active.column, ranges: [] }] } : undefined
    const byColumn = new Map<number, [number, number][]>()
    for (const block of resolveBlocks(selection, rows, count))
      for (let column = block.left; column <= block.right; column++) {
        // A hidden column (a tone, a diff's suffix) is not one of the rows' values.
        if (isHiddenColumn(names[column])) continue
        const runs = byColumn.get(column) ?? []
        runs.push([block.top, block.bottom - block.top + 1])
        byColumn.set(column, runs)
      }
    if (byColumn.size === 0 || byColumn.size > wire.views.maxFilters) return undefined
    const columns = [...byColumn].sort(([a], [b]) => a - b).map(([column, runs]) => ({ column, ranges: mergeRanges(runs) }))
    // More separate runs of rows than a filter takes cannot filter by them all.
    if (columns.some(({ ranges }) => ranges.length > wire.views.maxFilterRanges || (kind === 'between' && ranges.reduce((sum, [, cells]) => sum + cells, 0) < 2))) return undefined
    return { columns, ...shown ? { viewId: shown.viewId } : {} }
  }

  /** The rows a grid's selection covers, as merged ranges of positions in the view the grid shows, and how many they are. */
  private keepTarget(tabId: string, key: EntryKey): { ranges: [number, number][]; rows: number; viewId?: number } | undefined {
    const run = this.runs.get(tabId), set = this.entry(run, key), selection = set && this.selection(tabId, set.key)
    if (!run || !set || !selection || !this.filterable(set) || isRemoteHandle(set.handle)) return undefined
    const shown = run.held.get(set.key)?.shown as ResultView | undefined
    const blocks = resolveBlocks(selection, (shown ?? set.handle).getSnapshot().rowsAvailable, set.descriptor.columns.length)
    const ranges = mergeRanges(blocks.map((block): [number, number] => [block.top, block.bottom - block.top + 1]))
    const rows = ranges.reduce((sum, [, count]) => sum + count, 0)
    return rows > 0 ? { ranges, rows, ...shown ? { viewId: shown.viewId } : {} } : undefined
  }

  private duplicateColumns(tabId: string, key: EntryKey, allColumns: boolean): number[] | undefined {
    const run = this.runs.get(tabId), set = this.entry(run, key)
    if (!run || !set || !this.filterable(set) || isRemoteHandle(set.handle)) return undefined
    const columns = set.descriptor.columns.length
    // A hidden column (a tone, a diff's suffix) is not one of the rows' values.
    const shownColumns = set.descriptor.columns.flatMap((item, column) => isHiddenColumn(item) ? [] : [column])
    if (allColumns) return shownColumns.length > 0 ? shownColumns : undefined
    const selection = this.selection(tabId, set.key)
    if (!selection) return undefined
    const shown = run.held.get(set.key)?.shown ?? set.handle
    const picked = new Set<number>()
    for (const block of resolveBlocks(selection, shown.getSnapshot().rowsAvailable, columns)) for (let column = block.left; column <= block.right; column++) if (!isHiddenColumn(set.descriptor.columns[column])) picked.add(column)
    return picked.size > 0 ? [...picked].sort((a, b) => a - b) : undefined
  }

  /** A set whose rows the backend still holds, other than an execution plan's. */
  private filterable(set: ResultSetEntry): boolean {
    const state = set.handle.getSnapshot().state
    return state !== 'lost' && state !== 'released' && set.descriptor.kind !== 'executionPlan'
  }

  /** Names each filter of the grid's view by the values its rows hold: "name = 'x'", "name between 'a' and 'b'". */
  private nameFilters(tabId: string, run: Run, index: EntryKey, set: ResultSetEntry): void {
    const sort = run.sorts.get(index)
    if (!sort?.view || sort.sorting || sort.filters.every(item => item.named)) return
    const columns = set.descriptor.columns
    const named = sort.filters.map(async (item): Promise<GridFilter> => {
      const filter = item.filter
      if (item.named || filter.op === 'duplicates') return item
      if (filter.op === 'kind') return { ...item, label: filterLabel(filter, columns), named: true }
      // Its words are its rows' count, known once the view resolved its cells.
      if (filter.op === 'keepRows') return 'rows' in filter ? { ...item, label: filterLabel(filter, columns), named: true } : item
      if (filter.op === 'groups' && item.list?.source) return { ...item, label: await remoteGroupsLabel(item.list, filter.column, columns), named: true }
      if (filter.op === 'groups') {
        if (!('keep' in filter)) return item
        const resolved = filter as ResolvedGroupsFilter
        const texts = resolved.row === undefined || resolved.nulls ? [] : [await valueText(set.handle, resolved.row, resolved.column)]
        return texts.every(text => text !== undefined) ? { ...item, label: filterLabel(resolved, columns, texts), named: true } : { ...item, label: filterLabel(resolved, columns, texts) }
      }
      if (!('rows' in filter)) return item
      const wanted = filter.op === 'between' ? filter.rows : filter.rows.length === 1 && !filter.nulls ? filter.rows : []
      // A BigQuery value list's rows are rows of its own result, whose first column holds the values.
      const values = item.list?.source?.values
      const texts = await Promise.all(wanted.map(row => values ? valueText(values, row, 0) : valueText(set.handle, row, filter.column)))
      const label = filterLabel(filter as ResolvedViewFilter, columns, texts)
      // A value that could not be read is read again the next time the view is built.
      return texts.every(text => text !== undefined) ? { ...item, filter, label, named: true } : { ...item, filter, label }
    })
    void Promise.all(named).then(filters => {
      // Only onto the same sort: a view building since has its own filters, and names them when it is built.
      if (run.sorts.get(index) !== sort || this.runs.get(tabId) !== run) return
      this.setSort(tabId, run, index, { ...sort, filters, applied: filters })
    }, () => { /* Labels keep their words without values. */ })
  }

  /** The view a grid draws, which its selection's rows are positions in: a mounted grid's is the one it reported
   *  (viewShown), which trails a sort built until the grid has swapped to it; a grid not mounted draws the current view
   *  from the start of its next mount. Undefined: the result's own order. */
  private drawnView(run: Run, key: EntryKey): ResultView | undefined {
    return this.drawing.has(key) ? run.held.get(key)?.shown as ResultView | undefined : run.sorts.get(key)?.view
  }

  /** Closes the grid's views but its current one and the one it shows. */
  private closeHeld(run: Run, index: EntryKey): void {
    const held = run.held.get(index)
    if (!held) return
    const keep = run.sorts.get(index)?.view
    for (const view of [...held.views]) {
      if (view === keep || view === this.drawnView(run, index) || held.pins?.has(view)) continue
      held.views.delete(view)
      void view.close()
    }
    if (held.views.size === 0) run.held.delete(index)
  }

  private setSort(tabId: string, run: Run, index: EntryKey, sort: GridSort | undefined): void {
    // A snapshot no filter of the grid's sort names any more (asked for, or applied) is closed: it went with its filter.
    const lists = (value: GridSort | undefined) => new Set([...value?.filters ?? [], ...value?.applied ?? []].flatMap(item => item.list ? [item.list] : []))
    const kept = lists(sort)
    for (const list of lists(run.sorts.get(index))) if (!kept.has(list)) void list.close()
    const next = new Map(run.sorts)
    if (sort) next.set(index, sort)
    else next.delete(index)
    run.sorts = next
    this.schedule(tabId)
  }

  /** Views built while rows were still arriving are built again once their set has every row. */
  private refreshSorts(tabId: string, run: Run): void {
    for (const [index, sort] of run.sorts) {
      if (sort.stale && !sort.sorting && run.entries.get(index)?.handle.getSnapshot().state === 'complete') this.applyView(tabId, run, index, sort.keys, sort.filters, sort.keys.length ? 'sort' : 'filter')
    }
  }

  /**
   * The one way results leave a run: closing one entry, Close Results, the run starting again and the tab closing all come
   * here. For each entry it gives up the sort or filter being built (a view that answers later is closed, not shown),
   * forgets the views its grid held and its sort (closing its filters' distinct snapshots), its grid's controller and
   * state, its share of the stack, its collapse and the focus, and cancels a copy of it; a save the backend already
   * accepted finishes under its lease. Then the stored results are released, in one request (main refuses requests past
   * 64 at a time, and a request closes 1,024 ids), which drops their views and snapshots in the backend and makes their
   * handles report them released, so work other services have in flight on them fails and is dropped. A retained-plan
   * copy in progress reads its results first. The caller publishes.
   */
  private drop(tabId: string, run: Run, entries: readonly ResultSetEntry[], plans: readonly ResultSetEntry[] = []): void {
    const gone = [...entries, ...plans]
    if (gone.length === 0) return
    const keys = new Set(gone.map(entry => entry.key))
    const view = this.views.get(tabId)
    let sorts: Map<EntryKey, GridSort> | undefined, collapsed: Set<EntryKey> | undefined, weights: Map<EntryKey, number> | undefined
    for (const entry of entries) {
      const key = entry.key
      run.sorting.get(key)?.abort()
      run.sorting.delete(key)
      run.combining.get(key)?.abort()
      run.combining.delete(key)
      if (entry.descriptor.kind === 'rows' && entry.descriptor.targetKey !== undefined && run.combining.size > 0) {
        const slot = entry.descriptor.statementSlot ?? 0
        for (const [combinedKey, controller] of [...run.combining]) {
          const combined = run.entries.get(combinedKey)
          if (combined && (combined.descriptor.statementSlot ?? 0) === slot) {
            controller.abort()
            run.combining.delete(combinedKey)
          }
        }
      }
      // A sample or re-run over the result is given up with it (no reason: its lines are not wanted now). The backend also
      // cancels it on the release, but an estimate or a cost prompt still open would otherwise go on to send it.
      const load = run.loads.get(key)
      if (load?.abort) { load.abort.abort(); const loads = new Map(run.loads); loads.delete(key); run.loads = loads }
      // Releasing the result closes its views, but not one built in BigQuery: a result of its own, closed here.
      const sort = run.sorts.get(key)
      for (const view of new Set([...run.held.get(key)?.views ?? [], ...sort?.view ? [sort.view] : []])) if (isRemoteView(view)) void view.close()
      run.held.delete(key)
      if (sort) {
        for (const list of new Set([...sort.filters, ...sort.applied].flatMap(item => item.list ? [item.list] : []))) void list.close()
        sorts ??= new Map(run.sorts)
        sorts.delete(key)
      }
      this.controllers.delete(key)
      this.drawing.delete(key)
      run.entries.delete(key)
      const slot = run.slots.get(key)
      run.slots.delete(key)
      if (slot?.group !== undefined) run.selected.delete(slot.group)
      run.shape = undefined
      run.setKeys.delete(setKey(entry.descriptor))
      if (run.settled.has(setKey(entry.descriptor))) {
        if (run.settledPublished) { run.settled = new Map(run.settled); run.settledPublished = false }
        run.settled.delete(setKey(entry.descriptor))
      }
      if (!view) continue
      view.grids.delete(key)
      if (view.collapsed.has(key)) { collapsed ??= new Set(view.collapsed); collapsed.delete(key) }
      // The others keep their shares of what is left.
      if (view.weights?.has(key)) { weights ??= new Map(view.weights); weights.delete(key) }
      if (view.focused === key) view.focused = undefined
    }
    if (sorts) run.sorts = sorts
    if (run.staleCombined.size) {
      const remaining = new Set([...run.staleCombined].filter(key => !keys.has(key)))
      if (remaining.size !== run.staleCombined.size) run.staleCombined = remaining
    }
    if (view && collapsed) view.collapsed = collapsed
    if (view && weights) view.weights = weights
    if (entries.length) { run.sets = run.sets.filter(entry => !keys.has(entry.key)); run.setsPublished = false }
    if (run.combineWarnings.size) {
      let changed = false
      const remaining = new Map(run.combineWarnings)
      for (const key of keys) if (remaining.delete(key)) changed = true
      if (changed) {
        run.combineWarnings = remaining
        this.syncCombineWarnings(run)
      }
    }
    if (plans.length) run.planSets = run.planSets.filter(entry => !keys.has(entry.key))
    if (this.copying && this.runs.get(this.copying.tabId) === run && keys.has(this.copying.job.entry)) this.cancelRunning(this.copying)
    this.releaseEntries(run, gone)
  }

  /** Releases stored results in one request and disposes their handles. A close may race a bounded XML copy: the copy
   *  owns that temporary lease and reads them first; history owns no handles. */
  private releaseEntries(run: Run, gone: readonly ResultSetEntry[], after: readonly Promise<void>[] = []): void {
    const released: ResultKey[] = gone.map(entry => entry.handle.key)
    const release = () => {
      void this.client.release(released).catch(() => {})
      for (const entry of gone) entry.handle.dispose()
    }
    const waits = run.retaining ? [run.retaining, ...after] : after
    if (waits.length) void Promise.allSettled(waits).then(release)
    else release()
  }

  /** Whether a run still shows an entry (or captured plan set): work that answers for one it does not is dropped. */
  /** What closing an entry closes: a Table's group (its Pivot with it), any other view alone. */
  private owned(run: Run, entry: ResultSetEntry): ResultSetEntry[] {
    const slot = run.slots.get(entry.key)
    return slot?.view === 'table' ? run.sets.filter(item => run.slots.get(item.key)?.group === slot.group) : [entry]
  }

  /** The run's groups and comparisons, from its entries in the order drawn (a group's Table comes before its other views). */
  private shapeOf(run: Run): Shape {
    if (run.shape) return run.shape
    const groups: ResultGroup[] = [], comparisons: ResultSlot[] = []
    let open: { -readonly [K in keyof ResultGroup]: ResultGroup[K] } | undefined
    for (const entry of run.sets) {
      const record = run.slots.get(entry.key)
      if (!record) continue
      const slot: ResultSlot = { key: entry.key, entry, ...record }
      if (record.view === 'table') {
        const { descriptor } = entry
        groups.push(open = { ordinal: record.group!, batchNumber: descriptor.batchNumber, iteration: descriptor.iteration, planSet: descriptor.kind === 'executionPlan', table: slot, selected: 'table' })
      } else if (open && record.group === open.ordinal && record.view === 'pivot') {
        open.pivot = slot
        if (run.selected.has(open.ordinal)) open.selected = 'pivot'
      } else comparisons.push(slot)
    }
    return run.shape = { groups, comparisons }
  }

  private has(tabId: string, run: Run | undefined, entry: ResultSetEntry): boolean {
    return !!run && this.runs.get(tabId) === run && (entry.capturedPlan ? run.planSets.includes(entry) : run.entries.get(entry.key) === entry)
  }

  private disposeRun(tabId: string): void {
    const run = this.runs.get(tabId)
    if (!run) return
    run.subscription?.dispose()
    // A load ends with its result, which the backend stops on release: its events concern no one now.
    // A sample or re-run is given up too (no reason: its lines are not this tab's now), and its result, if one comes, released.
    for (const load of run.loads.values()) { load.subscription?.dispose(); load.abort?.abort() }
    for (const abort of run.combining.values()) abort.abort()
    run.combining.clear()
    this.drop(tabId, run, run.sets, run.planSets)
    this.runs.delete(tabId)
    this.operations.forget(tabId)
  }

  private schedule(tabId: string): void {
    this.dirty.add(tabId)
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    this.frame(() => {
      this.scheduled = false
      if (this.disposed || this.dirty.size === 0) return
      const next = { ...this.getSnapshot() }
      for (const id of this.dirty) {
        const run = this.runs.get(id)
        if (run) next[id] = this.snapshotOf(run)
      }
      this.dirty.clear()
      this.publish(next)
    })
  }

  private publishNow(tabId: string): void {
    const run = this.runs.get(tabId)
    if (!run || this.disposed) return
    this.dirty.delete(tabId)
    this.publish({ ...this.getSnapshot(), [tabId]: this.snapshotOf(run) })
  }

  protected override publish(snapshot: Readonly<Record<string, TabResults>>): void {
    super.publish(snapshot)
    this.updateContext()
    this.updateTurned()
    this.updateComparing()
  }
  /** `comparing` per tab: its focused entry, when that is a comparison, and whether each input it compared is still open. */
  private updateComparing(): void {
    const current = this.comparingStore.getSnapshot(), snapshot = this.getSnapshot(), next: Record<string, FocusedComparison> = {}
    let changed = false
    for (const tabId of this.runs.keys()) {
      const tab = snapshot[tabId], focused = this.focusedEntry(tabId), slot = focused && slotOf(tab, focused.key)
      // A comparison lost with the backend, or in closed results, can no longer be changed: no keys for it.
      if (!focused || slot?.view !== 'comparison' || tab?.status === 'closed' || !held(slot.entry)) continue
      const inputsOpen = comparisonInputsOpen(tab, slot.sources), was = current[tabId]
      next[tabId] = was && was.entry === focused.key && was.inputsOpen === inputsOpen ? was : { entry: focused.key, inputsOpen }
      if (next[tabId] !== was) changed = true
    }
    if (changed || Object.keys(current).length !== Object.keys(next).length) this.comparingStore.set(next)
  }
  /** `turned` per tab: its focused entry, when that view is drawn transposed and can still be turned back. Results lost
   *  with the backend keep their grids as they were drawn, under the overlay, but nothing reads as pressed for them. */
  private updateTurned(): void {
    const current = this.turnedStore.getSnapshot(), next: Record<string, FocusedOrientation> = {}
    let changed = false
    for (const tabId of this.runs.keys()) {
      const focused = this.focusedEntry(tabId), orientation = focused && this.orientation(tabId, focused.key)
      if (!focused || !orientation?.transposed || !this.canTranspose(tabId, focused.key)) continue
      const was = current[tabId]
      next[tabId] = was && was.entry === focused.key && was.headerColumn === orientation.headerColumn ? was
        : { entry: focused.key, ...orientation.headerColumn === undefined ? {} : { headerColumn: orientation.headerColumn } }
      if (next[tabId] !== was) changed = true
    }
    if (changed || Object.keys(current).length !== Object.keys(next).length) this.turnedStore.set(next)
  }
  /** Counts top-level tabs for a multi-server run (Summary + optional Combined + distinct target tabs + comparisons). */
  private multiTopCount(run: Run): number {
    let count = 1 // Summary
    let hasCombined = false
    const targets = new Set<string>()
    let extras = 0
    for (const entry of run.sets) {
      if (!held(entry) || entry.descriptor.kind === 'pivot') continue
      if (entry.descriptor.kind === 'combined') hasCombined = true
      else if (entry.descriptor.kind === 'diff') extras++
      else if (entry.descriptor.targetKey) targets.add(entry.descriptor.targetKey)
      else extras++
    }
    return count + (hasCombined ? 1 : 0) + targets.size + extras
  }

  /** `hasResults` per tab: a set, captured plan, or multi-server summary cards, in results neither closed nor lost with the
   *  backend; and `hasResultSets`: the same, counting only the sets a grid shows (rows, combined, plan sets and comparisons). */
  private updateContext(): void {
    const results: Record<string, true> = {}, sets: Record<string, true> = {}, steppable: Record<string, true> = {}
    for (const [tabId, run] of this.runs) {
      if (run.status === 'closed' || run.status === 'lost') continue
      const grids = run.sets.some(held)
      const multiSummary = hasMultiSummary(run)
      if (grids) sets[tabId] = true
      // The Tabs layout's top row: Summary (for multi-server), each result/combined/server group (its Pivot is under it) and each comparison.
      const topCount = multiSummary ? this.multiTopCount(run) : run.sets.filter(entry => held(entry) && entry.descriptor.kind !== 'pivot').length
      if (!run.bare && topCount > 1) steppable[tabId] = true
      if (grids || run.planSets.some(held) || multiSummary) results[tabId] = true
    }
    publishTabs(this.contextStore, results)
    publishTabs(this.setsStore, sets)
    publishTabs(this.steppableStore, steppable)
  }

  private snapshotOf(run: Run): TabResults {
    run.setsPublished = true
    run.settledPublished = true
    const focused = this.views.get(run.tabId)?.focused
    const validFocused = focused === summaryEntryKey ? hasMultiSummary(run) : focused !== undefined && run.entries.has(focused)
    return {
      ...this.shapeOf(run), ...validFocused ? { focused } : {}, ...run.bare ? { bare: true as const } : {},
      queryId: run.queryId, startedAt: run.startedAt, status: run.status, sets: run.sets, planSets: run.planSets,
      messages: run.notices.length || run.notes.length ? [...run.notices, ...run.messages, ...run.notes] : run.messages, notices: run.notices.length,
      messagesTruncated: run.messagesTruncated, rowsRead: this.totalRows(run), completedBatches: run.completedBatches, totalBatches: run.totalBatches,
      ...run.summary ? { summary: run.summary } : {}, ...run.error ? { error: run.error } : {}, view: run.view, manualView: run.manualView, strip: run.strip, stripChosen: run.stripManual, settled: run.settled,
      ...run.endedAt !== undefined ? { endedAt: run.endedAt } : {}, ...run.closedFrom ? { closedFrom: run.closedFrom } : {}, jobs: run.jobs, announcement: run.announcement, announced: run.announced,
      jobNotice: run.jobNotice, sorts: run.sorts, numbered: run.numbered, ...run.emptied ? { emptied: true as const } : {}, ...run.discard ? { discard: true as const } : {},
      ...run.messagesOnly ? { messagesOnly: true as const } : {}, ...run.loads.size ? { loads: run.loads } : {},
      ...run.multi ? { multi: run.multi } : {}, ...run.multiSummary ? { multiSummary: run.multiSummary } : {},
      ...run.activeSummary && hasMultiSummary(run) ? { activeSummary: true as const } : {},
      ...run.staleCombined.size ? { staleCombined: run.staleCombined } : {},
      ...run.combineWarnings.size ? { combineWarnings: run.combineWarnings } : {}
    }
  }

  private mint(): EntryKey { return 'e' + ++this.minted }

  private entry(run: Run | undefined, key: EntryKey): ResultSetEntry | undefined { return run?.entries.get(key) }
}

/** Publishes a set of tabs only when it differs from the one the store holds. */
function publishTabs(store: { getSnapshot(): Readonly<Record<string, true>>; set(value: Readonly<Record<string, true>>): void }, next: Record<string, true>): void {
  const current = store.getSnapshot(), keys = Object.keys(next)
  if (keys.length !== Object.keys(current).length || keys.some(tabId => !current[tabId])) store.set(next)
}

const table: ViewOrientation = { transposed: false }, turnedPlain: ViewOrientation = { transposed: true }

/** Where each column of `from` stands in `to`, for the columns whose name is unique in both: what a rebuilt Pivot carries
 *  over (sort keys, widths, the header column). */
export function uniqueNames(from: readonly ResultColumn[], to: readonly ResultColumn[]): ReadonlyMap<number, number> {
  const once = (columns: readonly ResultColumn[]) => {
    const seen = new Map<string, number>()
    columns.forEach((column, at) => seen.set(column.name, seen.has(column.name) ? -1 : at))
    return seen
  }
  const target = once(to), moved = new Map<number, number>()
  for (const [name, at] of once(from)) {
    const there = target.get(name)
    if (at >= 0 && there !== undefined && there >= 0) moved.set(at, there)
  }
  return moved
}

/**
 * How a replaced comparison's visible (data) columns map to the new one's, by name and wire type (as columns pair, the
 * name ignoring case): the k-th such column to the new result's k-th. A swap or another layout reorders and adds columns, so
 * positions say nothing; hidden columns (previous values, the gutter's, the tone) are never mapped.
 */
export function comparisonColumns(from: readonly ResultColumn[], to: readonly ResultColumn[]): ReadonlyMap<number, number> {
  const places = (columns: readonly ResultColumn[]) => {
    const seen = new Map<string, number[]>()
    columns.forEach((column, at) => { if (isHiddenColumn(column)) return; const name = `${column.name.toLowerCase()}\u0000${column.wire}`; seen.set(name, [...seen.get(name) ?? [], at]) })
    return seen
  }
  const target = places(to), moved = new Map<number, number>()
  for (const [name, ats] of places(from)) ats.forEach((at, k) => { const there = target.get(name)?.[k]; if (there !== undefined) moved.set(at, there) })
  return moved
}

/**
 * A rebuilt Pivot's grid state from the old one's: the orientation, the header column and the widths the user gave the
 * columns it keeps by name (`moved`), the transposed layout's shared width and name column; not its selection, scroll or
 * per-row widths, which named the old rows. A width left NaN is measured as a new column's (GridView).
 */
export function carriedState(state: GridViewState, moved: ReadonlyMap<number, number>, columns: number): GridViewState {
  const next: GridViewState = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false }
  if (state.widths && state.userSized?.size) {
    const widths = new Float64Array(columns).fill(Number.NaN), userSized = new Set<number>()
    for (const column of state.userSized) {
      const at = moved.get(column)
      if (at === undefined || column >= state.widths.length) continue
      widths[at] = state.widths[column]
      userSized.add(at)
    }
    if (userSized.size) { next.widths = widths; next.userSized = userSized }
  }
  if (state.orientation) next.orientation = state.orientation
  const header = state.headerColumn === undefined ? undefined : moved.get(state.headerColumn)
  if (header !== undefined) next.headerColumn = header
  // The shared width stays as it was (sized, so the first rows do not measure it again); per-row widths named old rows.
  if (state.transposed) next.transposed = { topRow: 0, virtualTop: 0, scrollLeft: 0, width: state.transposed.width, overrides: new Map(), sized: state.transposed.sized, ...state.transposed.nameWidth === undefined ? {} : { nameWidth: state.transposed.nameWidth } }
  return next
}
/** A focused grid drawn transposed (`ResultsService.turned`): its entry and the column that heads its drawn columns. */
export interface FocusedOrientation { readonly entry: EntryKey; readonly headerColumn?: number }
/** An entry whose view can be drawn transposed: its descriptor's kind (`turnableKinds`; never a comparison). */
const turnable = (set: ResultSetEntry): boolean => turnableKinds.has(set.descriptor.kind)
/** A column that can head a transposed view's drawn columns: one of the result's own. */
const headerable = (set: ResultSetEntry, column: number): boolean => Number.isInteger(column) && column >= 0 && column < set.descriptor.columns.length && !isHiddenColumn(set.descriptor.columns[column])
/** What the toolbar says when Find Next lands on a match in a row a transposed grid does not draw. */
export const beyondCapText = (row: number): string =>
  `The match is in row ${formatCount(row + 1)}, and a transposed grid draws only the first ${formatCount(wire.transpose.maxRows)} rows. Filter the rows, or turn Transposed off, to see it.`
/** A transposed grid's strip when the view has more rows than it draws as columns. */
export const capStripText = (rows: number, pivot: boolean, windowed = false): string =>
  `Showing the first ${formatCount(wire.transpose.maxRows)} of ${formatCount(rows)} rows as columns.${windowed
    // A windowed result refuses filters (REMOTE_RESULT): the strip offers no way to the rest that cannot work.
    ? ' A result windowed in BigQuery cannot be filtered yet.'
    : ` Filter the ${pivot ? 'Pivot' : 'Table'} to see other rows.`}`

/** A column whose order Sort text by changes (ViewSorter.IsText in C#, plus binary for Bytes). */
export function lengthSortable(column: ResultColumn): boolean {
  if (column.wire === 'binary' || column.collation !== undefined || column.role === 'xml' || column.role === 'json') return true
  const kind = sortKindOf(column)
  return kind === 'text' || kind === 'json'
}

const columnName = (columns: readonly ResultColumn[], column: number) => columns[column]?.name || noColumnName
const isNotNull = (filter: ViewFilter) => filter.op === 'notIn' && 'rows' in filter && filter.rows.length === 0 && !!filter.nulls
/** A Keep Selected Rows filter's words: the rows it names, though a later filter may show fewer. */
const keptLabel = (rows: number) => `${formatCount(rows)} selected ${plural(rows, 'row')}`
const sameColumns = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((column, at) => column === b[at])

/** [first, count] ranges sorted, with overlapping and adjacent ones joined. */
export function mergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const merged: [number, number][] = []
  for (const [first, count] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1)
    if (last && first <= last[0] + last[1]) last[1] = Math.max(last[1], first + count - last[0])
    else merged.push([first, count])
  }
  return merged
}

/** A value as a filter's words show it: quoted, its first 24 characters, NULL bare. */
async function valueText(handle: ResultHandle, row: number, column: number): Promise<string | undefined> {
  try {
    const window = await handle.getWindow(row, 1, { colStart: column, colEnd: column + 1, display: true, maxCellChars: 64 })
    if (window.text.length === 0) return undefined
    if (window.flags[0] & 1) return 'NULL'
    const text = window.text[0].replace(/\s+/g, ' ')
    return `'${text.length > 24 ? text.slice(0, 24) + '…' : text}'`
  } catch { return undefined }
}

/** A BigQuery value list's filter words, from its ticks as the backend applies them (DistinctSnapshot.Freeze): it keeps the
 *  ticked values when the list is whole and they are no more than the others, else drops the others. */
async function remoteGroupsLabel(list: DistinctList, column: number, columns: readonly ResultColumn[]): Promise<string> {
  const ticks = await list.read({ order: 'value', offset: 0, count: 1 })
  const distinct = list.summary.distinct, hasNull = list.summary.nulls > 0, cleared = distinct - ticks.checked
  const keep = list.summary.complete && ticks.checked <= cleared
  const nulls = hasNull && (keep ? ticks.nullsChecked : !ticks.nullsChecked)
  return filterLabel({ op: 'groups', column, snapshotId: list.snapshotId, keep, values: keep ? ticks.checked : cleared, nulls, digest: '' }, columns)
}

/** A resolved filter's words, with the texts of its rows' values where it names them (one value, or Between's two). */
export function filterLabel(filter: ResolvedViewFilter, columns: readonly ResultColumn[], texts: readonly (string | undefined)[] = []): string {
  if (filter.op === 'duplicates') return filter.columns.length === columns.filter(column => !isHiddenColumn(column)).length ? 'Duplicate rows' : `Duplicates in ${filter.columns.map(column => columnName(columns, column)).join(' + ')}`
  if (filter.op === 'keepRows') return keptLabel(filter.rows.length)
  if (filter.op === 'kind') return kindLabel(filter.kinds)
  const name = columnName(columns, filter.column)
  if (filter.op === 'between') return texts[0] && texts[1] ? `${name} between ${texts[0]} and ${texts[1]}` : `${name} between 2 values`
  const values = (filter.op === 'groups' ? filter.values : filter.rows.length) + (filter.nulls ? 1 : 0), not = filter.op === 'notIn' || (filter.op === 'groups' && !filter.keep)
  // A checklist that keeps nothing it names drops nothing either.
  if (values === 0) return `${name}: every value`
  if (values === 1 && filter.nulls) return `${name} is ${not ? 'not ' : ''}NULL`
  if (values === 1 && texts[0]) return `${name} ${not ? '≠' : '='} ${texts[0]}`
  return `${name} ${not ? 'not in' : 'in'} (${formatCount(values)} ${plural(values, 'value')})`
}

/** The columns a grid's filters name one by one (a value list, a range or not NULL): their header funnels show it.
 *  Duplicates span columns, and Keep Selected Rows and a comparison's kind filter name none, so none marks a funnel. */
export function filteredColumns(sort: GridSort | undefined): ReadonlySet<number> {
  const columns = new Set<number>()
  for (const item of sort?.filters ?? []) if (item.filter.op !== 'duplicates' && item.filter.op !== 'keepRows' && item.filter.op !== 'kind') columns.add(item.filter.column)
  return columns
}

/** A comparison's kind filter's words: "Changed rows", "Changed or added rows", "Changed, added or removed rows". */
export function kindLabel(kinds: readonly DiffKindName[]): string {
  const order: readonly DiffKindName[] = ['same', 'changed', 'added', 'removed']
  const words = order.filter(kind => kinds.includes(kind)).map(kind => kind === 'same' ? 'unchanged' : kind)
  const listed = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`
  return `${listed.charAt(0).toUpperCase()}${listed.slice(1)} rows`
}

/** The column a filter change works on, for its header's ring: the first filter that is new among `filters`. */
function changedColumn(applied: readonly GridFilter[], filters: readonly GridFilter[]): number | undefined {
  for (const item of filters) if (!applied.includes(item) && 'column' in item.filter && typeof item.filter.column === 'number' && item.filter.column >= 0) return item.filter.column
  return undefined
}

/** A focused comparison (`ResultsService.comparing`): its entry, and whether both inputs it compared are still open (D10). */
export interface FocusedComparison { readonly entry: EntryKey; readonly inputsOpen: boolean }
/** Whether every input a comparison compared is still open: the entry its reference names, still holding that result. */
export function comparisonInputsOpen(tab: TabResults | undefined, sources: readonly SourceRef[]): boolean {
  return sources.every(source => { const entry = entryOf(tab?.sets, source.key); return !!entry && setKey(entry.descriptor) === source.set })
}
