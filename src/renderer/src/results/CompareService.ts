import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import { pairColumns, type ColumnPairing } from './compare-pairing'
import { DerivedJobs } from './derived-jobs'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import type { DiffKindName, DiffLayout, DiffMatch, DiffMatchUsed, ResultColumn, ResultsDiffResult } from '../../../shared/contracts'
import type { EntryKey, ResultSetEntry, ResultsService, SourceRef, TabResults } from './ResultsService'
import { comparedNames, comparisonColumns, comparisonName, entryNumber, entryOf, resultLimits, setKey, slotOf } from './ResultsService'
import { ResultError } from './ResultClient'
import { formatCount } from './status'

/** What a diff set compared, for its grid's strip. */
export interface CompareInfo {
  /** The compared entries' keys: the old side (−), then the new side (+). */
  readonly left: EntryKey
  readonly right: EntryKey
  /** The numbers the compared results are named by ("Result 3"). */
  readonly leftNumber: number
  readonly rightNumber: number
  /** What the compared results were called when they were compared ("Open orders", "Result 3"), frozen as the title is. */
  readonly leftName?: string
  readonly rightName?: string
  /** The larger input's stored rows when compared, which sizes the gutter's row numbers after an input is closed. */
  readonly inputRows?: number
  /** What matched rows: the mode, and the key columns (auto's chosen column, or those asked for). */
  readonly match: DiffMatchUsed
  /** What was asked to match rows by (absent: Automatic), asked again when the comparison is replaced. */
  readonly asked?: DiffMatch
  /** The unchanged rows asked for around a change (-1 all; absent: results.diff's default). */
  readonly context?: number
  /** How it was written: one row per entry, or two rows a change. */
  readonly layout: DiffLayout
  /** One row per entry was wanted, but the comparison has more pairs than it can show (D12): it shows two rows. */
  readonly fallback?: true
  /** The compared (paired) columns. */
  readonly pairs: number
  /** Per pair, its changed and soft cells (the answer's `columnChanges`). */
  readonly columnChanges: readonly { readonly changed: number; readonly soft: number }[]
  readonly exact: boolean
  readonly same: number
  readonly changed: number
  readonly added: number
  readonly removed: number
  /** Values equal only by collation (case or trailing spaces, say). */
  readonly soft: number
  readonly leftOnly: readonly string[]
  readonly rightOnly: readonly string[]
  /** A value compared was a long value's stored prefix, so a difference past it does not show. */
  readonly approximate: boolean
  /** The entries whose key repeats (D4), paired in order. */
  readonly repeated: number
  /** The removed and added row pairs that look alike (D5), and whether there were too many unmatched rows to look. */
  readonly possible: number
  readonly possibleSkipped: boolean
  /** Both inputs have rows and none matched. */
  readonly nothingPaired: boolean
  /** In Changes only, the unchanged entries omitted after the last stored row. */
  readonly trailingHidden: number
  /** The inputs' stored rows when compared (old, then new): Match by row position is offered only when they are equal. */
  readonly leftRows: number
  readonly rightRows: number
  /** An input had a sort or filter when Compare was pressed: the comparison used all its stored rows, in their own order. */
  readonly filtered?: true
  /** The remembered key columns a first run could not use (they no longer pair, or hold values too long to compare), so
   *  it matched rows automatically: their names. */
  readonly rememberedLost?: string
}
/** What the Compare popover is drawn beside: the results toolbar's Compare button, or the grid of its Table. */
export type CompareAnchor = 'toolbar' | 'grid'
/**
 * The Compare popover of one query tab, opened on a group's Table of the current run (`active`, the new side unless
 * `swapped`), with the Table picked to compare it with (`target`), whether text compares exactly, and why the last
 * comparison it started failed. It is transient: it closes once its comparison is shown, when the query runs again, or when
 * its Table closes. The groups' numbers (`ordinal`, `targetOrdinal`) are what the tab remembers for the next open.
 */
export interface ComparePicker {
  readonly queryId: string
  readonly anchor: CompareAnchor
  readonly ordinal: number
  readonly active: EntryKey
  readonly targetOrdinal?: number
  readonly target?: EntryKey
  readonly swapped: boolean
  readonly exact: boolean
  readonly error?: string
  /** That the user cancelled its comparison, said where the failure would be. */
  readonly cancelled?: boolean
  /** The failure is a refusal of All rows for memory (DIFF_ROWS_TOO_LARGE): the popover offers Show changes only. */
  readonly refusedRows?: boolean
}
/** A comparison's latest announcement (its live region): the sentence and a counter that only grows, so the same sentence
 *  said twice is read out twice. */
export interface CompareAnnouncement { readonly text: string; readonly at: number }
export interface CompareSnapshot {
  /** Each diff set's comparison, by its set key. */
  readonly info: ReadonlyMap<string, CompareInfo>
  /** The open pickers (popovers), by tab. */
  readonly pickers: Readonly<Record<string, ComparePicker>>
  /** The comparisons running, by tab: first runs as `pairId(old, new)`, changes of a comparison as `replaceId(key)`. */
  readonly running: Readonly<Record<string, readonly string[]>>
  /** What a comparison says of its last change that did not publish (a failure, a cancel, an input closed), by its entry
   *  key, until its next change. Drawn in its strip until the notice strip comes. */
  readonly notices: ReadonlyMap<EntryKey, string>
  /** Each comparison's latest announcement, by its entry key. */
  readonly announcements: ReadonlyMap<EntryKey, CompareAnnouncement>
  /** The comparisons whose notice is a refusal of All rows for memory, which offers Show changes only. */
  readonly refused: ReadonlySet<EntryKey>
  /** The notices dismissed on each comparison, by kind and text (`noticeId`): one comes back once its text changes. */
  readonly dismissed: ReadonlyMap<EntryKey, ReadonlySet<string>>
  /** Per tab, a first run refused for memory with no popover to say it in: the results area's actionable notice. */
  readonly actionable: Readonly<Record<string, ActionableNotice>>
  /** The open match menu: the comparison it changes, and what opened it (the toolbar's Match, ⋯ or a notice). */
  readonly matchMenu?: { readonly tabId: string; readonly key: EntryKey; readonly from: MatchMenuFrom }
}
/** A first run refused for memory (DIFF_ROWS_TOO_LARGE), said in the results area until it is acted on, dismissed, either
 *  input closes, the query runs again or a comparison of the pair is shown: its button runs it again with Changes only. */
export interface ActionableNotice {
  readonly queryId: string
  readonly old: EntryKey
  readonly neu: EntryKey
  /** The inputs' names, old then new, for the reason its button is unavailable. */
  readonly names: readonly [string, string]
  readonly text: string
  readonly options: CompareOptions
}
/** What a notice's buttons do: Show changes only, Choose key columns… (the match menu), Match by row position. */
export type NoticeAction = 'changesOnly' | 'chooseKeys' | 'byPosition'
/** A line of a comparison's notice strip: its kind (with its text, what a dismissal remembers), its tone and its buttons. */
export interface ComparisonNotice { readonly kind: string; readonly text: string; readonly tone: 'info' | 'warning'; readonly actions?: readonly NoticeAction[] }
/** A notice's identity for dismissal: its kind and text, so the same kind with other words shows again. */
export const noticeId = (notice: Pick<ComparisonNotice, 'kind' | 'text'>): string => `${notice.kind}\u0000${notice.text}`
/** The sentence of a refusal of All rows for memory, where its Show changes only button is. */
export const rowsRefusedText = 'Not enough result memory for all rows.'
/** A remembered match: its mode, and for key columns each column's name and type (resolved by name, either side's type). */
export interface RememberedMatch { readonly mode: DiffMatch['mode']; readonly columns?: readonly { readonly name: string; readonly type: string }[] }
/** The most matches a tab remembers (by ordered pair of input names). */
export const rememberedLimit = 64
/** Which rows a comparison keeps: every row, or only changed, added and removed ones (`context` -1 and 0). */
export type CompareRows = 'all' | 'changes'
export const contextOf = (rows: CompareRows): number => rows === 'all' ? -1 : 0
/** What a comparison is asked for besides its two inputs (its identity): its state, which a replace changes in place (D9). */
export interface CompareOptions { readonly exact: boolean; readonly layout?: DiffLayout; readonly match?: DiffMatch; readonly context?: number }
/** The focused comparison's state that the ⋯ menu's toggles show. */
export interface ComparisonToggles { readonly exact: boolean; readonly oneRow: boolean; readonly changesOnly: boolean }
/** A change to a comparison, which replaces it in place: another layout, Exact text, sides, match or rows (`context`). */
export interface CompareChange { readonly layout?: DiffLayout; readonly exact?: boolean; readonly swap?: boolean; readonly match?: DiffMatch; readonly context?: number }
/** A Table the picker offers, with how its columns pair with the active Table's (the target as the old side). */
export interface CompareTarget { readonly entry: ResultSetEntry; readonly pairing: ColumnPairing }

const maxPairs = wire.page.maxColumns - 4

/** A comparison's identity: its ordered pair of inputs, old then new (D9). Its options (layout, rows, match, exact text)
 *  are its state, so the run shows one comparison per ordered pair, and one first run of it at a time. */
export const pairId = (old: EntryKey, neu: EntryKey): string => `${old}|${neu}`
/** A change of a comparison in flight, by the entry key the comparison keeps. */
export const replaceId = (key: EntryKey): string => `replace|${key}`
/** The layout a comparison is written in: the one wanted, except two rows past the one-row limit (D12). */
export const layoutFor = (wanted: DiffLayout, pairs: number): { readonly layout: DiffLayout; readonly fallback: boolean } =>
  wanted === 'entry' && pairs > wire.diff.maxEntryPairs ? { layout: 'unified', fallback: true } : { layout: wanted, fallback: false }
/** The notice of a comparison too wide for one row per entry (D12). */
export const fallbackText = 'Too many columns to show one row per entry, so two rows are shown.'
const sameOptions = (a: CompareOptions, b: CompareOptions): boolean => a.exact === b.exact && a.layout === b.layout && a.context === b.context && JSON.stringify(a.match ?? null) === JSON.stringify(b.match ?? null)

/** The refusal of a comparison a run has no room for (plan: Concurrency and limits, the 1,000 rule). */
export const compareFullText = `This query's results already hold ${formatCount(resultLimits.sets)} results, comparisons and pivots included, the most a run keeps. Close some results to compare these.`

/** A group's Table of rows that has every row: the only results a comparison reads (never a Pivot, a comparison, a plan set
 *  or a live result). */
export function comparableTable(tab: TabResults | undefined, entry: ResultSetEntry | undefined): entry is ResultSetEntry {
  return !!tab && entry !== undefined && entry.descriptor.kind === 'rows' && slotOf(tab, entry.key)?.view === 'table' && entry.handle.getSnapshot().state === 'complete'
}

/** What a tab's popover was last set to: per group (by number) the target's group and the way round, and exact text for all. */
interface Remembered { exact: boolean; readonly groups: Map<number, { readonly targetOrdinal: number; readonly swapped: boolean }> }

/** A comparison in flight: a first run of a pair (`replaces` absent), or a change replacing the comparison `replaces`. */
/** What a change of a comparison builds on: its sides and options, with the names of the key columns it asked for. A
 *  change in flight is the base of the next one, so two quick changes compose (Swap then Exact text keeps the swap). */
export type ChangeBase = Pick<CompareInfo, 'left' | 'right' | 'layout' | 'exact' | 'context' | 'asked' | 'fallback'> & { readonly match: { readonly columns: readonly string[] } }
interface Running {
  readonly abort: AbortController; readonly queryId: string; readonly old: EntryKey; readonly neu: EntryKey; readonly id: string; readonly options: CompareOptions
  readonly replaces?: EntryKey
  readonly base?: ChangeBase
  cancelled?: boolean
}

type Results = Pick<ResultsService, 'getSnapshot' | 'subscribe' | 'addSet' | 'replaceComparison' | 'discard' | 'notify' | 'focusEntry' | 'operations' | 'sortOf' | 'setKindFilter' | 'comparing'>
/** Carries a comparison's highlights over a replace (HighlightsService.carry): `prune` drops those whose entry it no longer
 *  has, said through `pruned`. */
export type CarryHighlights = (tabId: string, key: EntryKey, o: { readonly prune: boolean; readonly pruned: (count: number) => void }) => void

/**
 * Comparisons (results.diff): one group's Table against another's of the same run, in the backend, aligned by a key column
 * both share or by whole rows, values equal by collation (or exactly). The diff is a comparison of the run, after its
 * groups, which the grid shows unified like git: each change as its old row (−) and its new one (+) with the differing
 * cells marked, around them a row of unchanged context. It copied its cells, so it outlives its inputs.
 *
 * Compare… opens a popover (`open`) on a Table: the Table is the new side and the one picked the old, which the popover can
 * swap. Compare with Previous Result compares a Table with the nearest earlier one at once. Both start through
 * `comparePair`: one comparison per pair and exact-text choice at a time (asking again while it runs does nothing), at most
 * `derivedLimits.parallel` at once per window (`DerivedJobs`, shared with Pivot builds, which retries a busy refusal), and
 * none that would take the run past `resultLimits.sets` results counting those in flight and first Pivots being built. Each is given up when its run ends or either input closes.
 */
export class CompareService extends SnapshotStore<CompareSnapshot> implements Disposable {
  private readonly results: Results
  private readonly jobs: DerivedJobs
  /** New results other services are building for a tab's current run (first Pivots), counted against its 1,000. */
  private readonly elsewhere: (tabId: string) => number
  /** Comparisons in flight by tab. */
  private readonly inFlight = new Map<string, Map<string, Running>>()
  /** The choices made in each tab's popover, by group number, offered again when it opens on that group. Only a choice
   *  (a pick, a swap, Exact text, Compare) is kept: opening the popover is not one. Forgotten when the tab goes. */
  private readonly remembered = new Map<string, Remembered>()
  /** Diffs added whose run has yet to publish them, so a sync before that publish keeps their details. */
  private readonly fresh = new Map<string, { readonly tabId: string; readonly queryId: string }>()
  private readonly unsubscribe: () => void
  /** The layout a new comparison is written in (`queryResults.compare.layout`). */
  private readonly layout: () => DiffLayout
  private readonly carry: CarryHighlights | undefined
  /** The announcements' counter. */
  private announced = 0
  /** The last announcement each comparison's live region said, so a toolbar mounted again does not say it again. */
  private readonly spoken = new Map<EntryKey, number>()
  /** The rows a new comparison keeps (`queryResults.compare.rows`). */
  private readonly rows: () => CompareRows
  /** Per tab, for the session: the last match applied per ordered pair of input names, most recent last (D3). */
  private readonly matches = new Map<string, Map<string, RememberedMatch>>()
  /** Each comparison's change refused for memory, for its notice's Show changes only (kept while `refused` has it). */
  private readonly refusedChanges = new Map<EntryKey, CompareChange>()
  /** The state the focused comparison of each tab is in, for the ⋯ menu's and palette's toggles. */
  private readonly togglesStore = new (class extends SnapshotStore<Readonly<Record<string, ComparisonToggles>>> { set(value: Readonly<Record<string, ComparisonToggles>>) { this.publish(value) } clear() { this.clearListeners() } })({})
  readonly toggles: ExternalStore<Readonly<Record<string, ComparisonToggles>>> = this.togglesStore
  private readonly unsubscribeFocus: () => void

  constructor(results: Results, o: { jobs?: DerivedJobs; adding?: (tabId: string) => number; layout?: () => DiffLayout; rows?: () => CompareRows; carry?: CarryHighlights } = {}) {
    super({ info: new Map(), pickers: {}, running: {}, notices: new Map(), announcements: new Map(), refused: new Set(), dismissed: new Map(), actionable: {} })
    this.results = results
    this.jobs = o.jobs ?? new DerivedJobs()
    this.elsewhere = o.adding ?? (() => 0)
    this.layout = o.layout ?? (() => 'entry')
    this.rows = o.rows ?? (() => 'all')
    this.carry = o.carry
    this.unsubscribe = results.subscribe(() => this.sync())
    this.unsubscribeFocus = results.comparing.subscribe(() => this.refreshToggles())
    this.subscribe(() => this.refreshToggles())
  }

  /** The focused comparison's state per tab (`comparisonExactText`, `comparisonOneRow`, `comparisonChangesOnly`): what its
   *  change in flight asks for, else its own. Published only when one changes. */
  private refreshToggles(): void {
    const focused = this.results.comparing.getSnapshot(), current = this.toggles.getSnapshot(), next: Record<string, ComparisonToggles> = {}
    let changed = false
    for (const [tabId, item] of Object.entries(focused)) {
      const entry = slotOf(this.results.getSnapshot()[tabId], item.entry)?.entry, state = this.stateOf(tabId, entry)
      if (!state) continue
      const was = current[tabId], exact = state.exact, oneRow = state.layout === 'entry', changesOnly = state.context === 0
      next[tabId] = was && was.exact === exact && was.oneRow === oneRow && was.changesOnly === changesOnly ? was : { exact, oneRow, changesOnly }
      if (next[tabId] !== was) changed = true
    }
    if (changed || Object.keys(current).length !== Object.keys(next).length) this.togglesStore.set(next)
  }

  /** Gives up comparisons whose run ended or whose input closed, and closes a popover whose Table is gone: the query ran
   *  again (or runs), its Table closed, or the tab's results went. A target that closed leaves it with nothing picked. */
  private sync(): void {
    const snapshot = this.results.getSnapshot()
    for (const [tabId, items] of this.inFlight) {
      const tab = snapshot[tabId]
      for (const item of items.values()) {
        if (item.abort.signal.aborted) continue
        const gone = tab?.queryId !== item.queryId
        const closed = gone ? undefined : [item.old, item.neu].find(key => !entryOf(tab.sets, key))
        if (!gone && closed === undefined && (item.replaces === undefined || entryOf(tab.sets, item.replaces))) continue
        item.abort.abort()
        // A change cancelled because an input closed says so on the comparison, which stays readable (D10).
        if (item.replaces !== undefined && closed !== undefined && tab && entryOf(tab.sets, item.replaces)) {
          const name = slotOf(tab, item.replaces)?.sources.find(source => source.key === closed)?.name
          if (name) this.say(item.replaces, `${name} was closed, so the change was cancelled.`)
        }
      }
    }
    for (const tabId of [...this.remembered.keys()]) if (!snapshot[tabId]) this.remembered.delete(tabId)
    for (const tabId of [...this.matches.keys()]) if (!snapshot[tabId]) this.matches.delete(tabId)
    // The actionable notice goes with its run and with either input (closed, or released with the results).
    const actionable = this.getSnapshot().actionable
    let nextActionable: Record<string, ActionableNotice> | undefined
    for (const [tabId, notice] of Object.entries(actionable)) {
      const tab = snapshot[tabId]
      if (tab && tab.queryId === notice.queryId && tab.status !== 'closed' && openEntry(tab, notice.old) && openEntry(tab, notice.neu)) continue
      nextActionable ??= { ...actionable }
      delete nextActionable[tabId]
    }
    if (nextActionable) this.publish({ ...this.getSnapshot(), actionable: nextActionable })
    // A comparison's details go with the last run that shows it, not at the next comparison; so do its notice and
    // announcement once no run shows its entry.
    const info = this.getSnapshot().info, kept = info.size ? this.shown(info) : info
    if (kept.size !== info.size) this.publish({ ...this.getSnapshot(), info: kept })
    const { notices, announcements, refused, dismissed, matchMenu } = this.getSnapshot()
    if (notices.size || announcements.size || this.spoken.size || refused.size || dismissed.size || matchMenu) {
      const keys = new Set(Object.values(snapshot).flatMap(run => run.comparisons.map(slot => slot.key)))
      for (const key of this.spoken.keys()) if (!keys.has(key)) this.spoken.delete(key)
      const nextNotices = shownOnly(notices, keys), nextAnnouncements = shownOnly(announcements, keys), nextDismissed = shownOnly(dismissed, keys)
      const nextRefused = [...refused].every(key => keys.has(key)) ? refused : new Set([...refused].filter(key => keys.has(key)))
      for (const key of this.refusedChanges.keys()) if (!keys.has(key)) this.refusedChanges.delete(key)
      // The match menu goes with its comparison, and once an input closes (its Apply would run it again, D10).
      const keepMenu = !matchMenu || (keys.has(matchMenu.key) && this.closedReason(matchMenu.tabId, matchMenu.key) === undefined)
      if (nextNotices !== notices || nextAnnouncements !== announcements || nextDismissed !== dismissed || nextRefused !== refused || !keepMenu) {
        this.publish({ ...this.getSnapshot(), notices: nextNotices, announcements: nextAnnouncements, dismissed: nextDismissed, refused: nextRefused, ...keepMenu ? {} : { matchMenu: undefined } })
      }
    }
    const pickers = this.getSnapshot().pickers
    let next: Record<string, ComparePicker> | undefined
    for (const [tabId, picker] of Object.entries(pickers)) {
      const kept = this.keep(snapshot[tabId], picker)
      if (kept === picker) continue
      next ??= { ...pickers }
      if (kept) next[tabId] = kept
      else delete next[tabId]
    }
    if (next) this.publish({ ...this.getSnapshot(), pickers: next })
  }

  /** The popover as the tab's results now allow: gone once its run or its Table is, without a target that closed. */
  private keep(tab: TabResults | undefined, picker: ComparePicker): ComparePicker | undefined {
    if (!tab || tab.status === 'running' || tab.status === 'closed' || tab.queryId !== picker.queryId) return undefined
    const active = entryOf(tab.sets, picker.active)
    if (!comparableTable(tab, active)) return undefined
    return picker.target === undefined || this.offers(tab, active, entryOf(tab.sets, picker.target)) ? picker : withoutTarget(picker)
  }

  /** The Tables a Table can be compared with: the other groups' Tables of its run and backend generation that have every
   *  row and share at least one column with it, in the order drawn. None while the query runs or in a bare run (Peek). */
  targetsOf(tabId: string, key: EntryKey, o: { first?: boolean } = {}): readonly CompareTarget[] {
    const tab = this.results.getSnapshot()[tabId]
    const active = entryOf(tab?.sets, key)
    if (!tab || tab.bare || tab.status === 'running' || tab.status === 'closed' || !comparableTable(tab, active)) return []
    const targets: CompareTarget[] = []
    for (const group of tab.groups) {
      const entry = group.table.entry, pairing = this.offers(tab, active, entry)
      if (!pairing) continue
      targets.push({ entry, pairing })
      // A menu's or the toolbar's question (is there any?) stops at the first.
      if (o.first) break
    }
    return targets
  }

  /** How `entry`'s columns pair with the Table `active`'s when it is offered as its target: another Table of the run and
   *  generation that has every row, sharing at least one column and no more than a diff can show (ResultDiffer.MaxPairs: a
   *  page's columns less the marker, two row numbers and the tone). The caller checks `active` itself is comparable. */
  private offers(tab: TabResults, active: ResultSetEntry, entry: ResultSetEntry | undefined): ColumnPairing | undefined {
    if (!entry || entry.key === active.key || entry.descriptor.generation !== active.descriptor.generation || !comparableTable(tab, entry)) return undefined
    const pairing = pairColumns(entry.descriptor.columns, active.descriptor.columns)
    return pairing.pairs.length === 0 || pairing.pairs.length > maxPairs ? undefined : pairing
  }

  /** The Table a Table is compared with by Compare with Previous Result: the nearest offered target drawn before it. */
  previousOf(tabId: string, key: EntryKey): ResultSetEntry | undefined {
    const tab = this.results.getSnapshot()[tabId]
    const active = entryOf(tab?.sets, key)
    if (!tab || !active) return undefined
    const place = tab.sets.indexOf(active)
    return this.targetsOf(tabId, key).filter(target => tab.sets.indexOf(target.entry) < place).at(-1)?.entry
  }

  /** Whether Compare with Previous Result is offered for a grid's set: it has a previous Table. */
  canCompare(tabId: string, key: EntryKey): boolean { return this.previousOf(tabId, key) !== undefined }
  /** Whether Compare… is offered for a grid's set: some Table can be compared with it. */
  canPick(tabId: string, key: EntryKey): boolean { return this.targetsOf(tabId, key, { first: true }).length > 0 }

  /** Opens the popover on a Table, beside `anchor`. It offers again what was last chosen on that group in this tab (its
   *  target and way round) while that target is offered, else picks the Table's previous Table (else the first offered);
   *  the exact-text choice is the tab's last. */
  open(tabId: string, key: EntryKey, anchor: CompareAnchor = 'grid'): void {
    const tab = this.results.getSnapshot()[tabId]
    if (!tab || !this.canPick(tabId, key)) return
    const ordinal = slotOf(tab, key)?.group
    if (ordinal === undefined) return
    const memory = this.remembered.get(tabId), chosen = memory?.groups.get(ordinal)
    const targets = this.targetsOf(tabId, key)
    const again = chosen ? targets.find(target => slotOf(tab, target.entry.key)?.group === chosen.targetOrdinal)?.entry : undefined
    const target = again ?? this.previousOf(tabId, key) ?? targets[0]?.entry
    const targetOrdinal = target ? slotOf(tab, target.key)?.group : undefined
    this.setPicker(tabId, {
      queryId: tab.queryId, anchor, ordinal, active: key,
      ...target === undefined ? {} : { target: target.key }, ...targetOrdinal === undefined ? {} : { targetOrdinal },
      swapped: again ? chosen!.swapped : false, exact: memory?.exact ?? false
    })
  }
  close(tabId: string): void {
    const pickers = this.getSnapshot().pickers
    if (!pickers[tabId]) return
    const next = { ...pickers }
    delete next[tabId]
    this.publish({ ...this.getSnapshot(), pickers: next })
  }
  pick(tabId: string, target: EntryKey): void {
    const tab = this.results.getSnapshot()[tabId], entry = entryOf(tab?.sets, target)
    if (tab && entry) this.choose(tabId, { target, targetOrdinal: slotOf(tab, entry.key)?.group, error: undefined, cancelled: false, refusedRows: false })
  }
  swap(tabId: string): void { const picker = this.getSnapshot().pickers[tabId]; if (picker) this.choose(tabId, { swapped: !picker.swapped, error: undefined, cancelled: false, refusedRows: false }) }
  setExact(tabId: string, exact: boolean): void { this.choose(tabId, { exact, error: undefined, cancelled: false, refusedRows: false }) }

  /** The picker's two sides, old (−) then new (+), and how their columns pair; undefined while it has no target. */
  sidesOf(tabId: string): { readonly old: ResultSetEntry; readonly neu: ResultSetEntry; readonly pairing: ColumnPairing } | undefined {
    const picker = this.getSnapshot().pickers[tabId]
    const target = picker?.target === undefined ? undefined : this.targetsOf(tabId, picker.active).find(item => item.entry.key === picker.target)
    const tab = this.results.getSnapshot()[tabId], active = entryOf(tab?.sets, picker?.active)
    if (!picker || !target || !active) return undefined
    const [old, neu] = picker.swapped ? [active, target.entry] : [target.entry, active]
    return { old, neu, pairing: pairColumns(old.descriptor.columns, neu.descriptor.columns) }
  }

  /** The run's comparison of these inputs, this way round, if one is open, whatever its options (D9): one whose change in
   *  flight swaps it into the pair counts, one whose change swaps it out of the pair does not. */
  existing(tabId: string, old: EntryKey, neu: EntryKey): ResultSetEntry | undefined {
    const tab = this.results.getSnapshot()[tabId]
    const info = this.getSnapshot().info
    const shown = tab?.comparisons.find(slot => {
      const item = info.get(setKey(slot.entry.descriptor)), pending = this.pendingChange(tabId, slot.key)
      return item?.left === old && item.right === neu && (!pending || (pending.left === old && pending.right === neu))
    })?.entry
    const changing = shown ? undefined : this.changingInto(tabId, old, neu)
    return shown ?? (changing === undefined ? undefined : slotOf(tab, changing)?.entry)
  }
  /** A comparison's details, by its entry. */
  infoOf(entry: Pick<ResultSetEntry, 'descriptor'> | undefined): CompareInfo | undefined { return entry ? this.getSnapshot().info.get(setKey(entry.descriptor)) : undefined }
  /** What a comparison will be: its change in flight's state, else its own. */
  stateOf(tabId: string, entry: Pick<ResultSetEntry, 'descriptor' | 'key'> | undefined): ChangeBase | undefined { return entry ? this.pendingChange(tabId, entry.key) ?? this.infoOf(entry) : undefined }
  /** Comparisons in flight for a tab's current run: results they will add, which Pivot builds count against its 1,000. An
   *  earlier run's comparison given up but not yet settled is not counted, nor a change of a comparison, which adds none. */
  adding(tabId: string): number {
    const queryId = this.results.getSnapshot()[tabId]?.queryId
    return [...this.inFlight.get(tabId)?.values() ?? []].filter(item => item.queryId === queryId && item.replaces === undefined).length
  }

  /** Whether a comparison of these inputs, this way round, runs: a first run, or a change of the run's comparison of them. */
  isRunning(tabId: string, old: EntryKey, neu: EntryKey): boolean {
    for (const item of this.inFlight.get(tabId)?.values() ?? []) if (item.old === old && item.neu === neu && !item.abort.signal.aborted) return true
    return this.leaving(tabId, old, neu) !== undefined
  }
  /** Whether the pair's comparison is being swapped out of it: until that settles (it may be cancelled or fail, and stay),
   *  the pair counts as running, so no second comparison of it starts (D9). */
  private leaving(tabId: string, old: EntryKey, neu: EntryKey): EntryKey | undefined {
    const info = this.getSnapshot().info
    return this.results.getSnapshot()[tabId]?.comparisons.find(slot => {
      const item = info.get(setKey(slot.entry.descriptor)), pending = this.pendingChange(tabId, slot.key)
      return item?.left === old && item.right === neu && !!pending && (pending.left !== old || pending.right !== neu)
    })?.key
  }
  /** Whether a change of a comparison runs. */
  isReplacing(tabId: string, key: EntryKey): boolean { const item = this.inFlight.get(tabId)?.get(replaceId(key)); return !!item && !item.abort.signal.aborted }
  /** What a comparison's change in flight asks for (the state its toolbar shows until it lands), or undefined. */
  pendingChange(tabId: string, key: EntryKey): ChangeBase | undefined { const item = this.inFlight.get(tabId)?.get(replaceId(key)); return item && !item.abort.signal.aborted ? item.base : undefined }
  /** The comparison a change in flight turns into the ordered pair, if any: it is that pair's comparison (D9). */
  private changingInto(tabId: string, old: EntryKey, neu: EntryKey): EntryKey | undefined {
    for (const item of this.inFlight.get(tabId)?.values() ?? []) if (item.replaces !== undefined && item.old === old && item.neu === neu && !item.abort.signal.aborted) return item.replaces
    return undefined
  }

  /**
   * Why a comparison's changes cannot run (D10), or undefined when they can: an input closed (or its slot shows another
   * result now), said as "Sample Query is closed" for the first such input. The comparison stays readable. Re-executing
   * the query or losing the backend releases the comparison itself.
   */
  closedReason(tabId: string, key: EntryKey): string | undefined {
    const tab = this.results.getSnapshot()[tabId], slot = slotOf(tab, key)
    if (!slot || slot.view !== 'comparison') return undefined
    const closed = compareSources(tab, slot.sources).find(source => source.entry === undefined)
    return closed ? `${closed.name} is closed` : undefined
  }

  /** The popover's Compare: shows the comparison of its sides when the run has it, else starts it. Once the comparison is
   *  there, while the popover still shows that pair and holds the focus (`holdsFocus`, asked then), the popover closes and
   *  the comparison takes the focus. Closed meanwhile (Escape, Close, a press or key elsewhere) or moved to another pair,
   *  the comparison is only added, and the focus stays where the user put it; with the focus in another dialog (the
   *  palette) the popover stays, offering Show It, for that dialog to give the focus back to. A failure is said in the
   *  popover while it shows that pair, else in the toolbar. Returns the entry focused. */
  async run(tabId: string, o: { readonly holdsFocus?: () => boolean; readonly context?: number } = {}): Promise<EntryKey | undefined> {
    const picker = this.getSnapshot().pickers[tabId], sides = this.sidesOf(tabId)
    if (!picker || !sides) return undefined
    const shown = this.existing(tabId, sides.old.key, sides.neu.key)
    // Show It on a pair the run has applies the popover's Exact text (D13): it only focuses the comparison when that
    // matches, else Update replaces it, with its progress, Cancel and failure in the popover as a first run's are.
    if (shown && this.stateOf(tabId, shown)?.exact === picker.exact && o.context === undefined) { this.remember(tabId, picker); this.close(tabId); this.results.focusEntry(tabId, shown.key); return shown.key }
    this.choose(tabId, { error: undefined, cancelled: false, refusedRows: false })
    const context = o.context === undefined ? {} : { context: o.context }
    // A first run from the popover takes the match remembered for its pair of names.
    const outcome = shown ? await this.replace(tabId, shown.key, { exact: picker.exact, ...context }, { quiet: true })
      : await this.comparePair(tabId, sides.old.key, sides.neu.key, { exact: picker.exact, quiet: true, remember: true, ...context })
    const same = this.shows(tabId, picker.queryId, sides.old.key, sides.neu.key, picker.exact)
    if (outcome && 'error' in outcome) {
      // A failure is said where it was asked for: in the picker while it still shows that pair, else in the toolbar; a
      // refusal of All rows offers Show changes only there, or in the results area's actionable notice.
      const rows = outcome.code === 'DIFF_ROWS_TOO_LARGE'
      if (same) this.update(tabId, rows ? { error: rowsRefusedText, refusedRows: true } : { error: outcome.error })
      // A change of the pair's comparison is refused on that comparison, whose notice asks it again with Changes only.
      else if (rows && shown) this.refuse(shown.key, { exact: picker.exact, ...context })
      else if (rows && outcome.options) this.setActionable(tabId, picker.queryId, sides.old.key, sides.neu.key, outcome.options)
      else this.results.notify(tabId, outcome.error)
      return undefined
    }
    if (outcome === undefined || !same || (o.holdsFocus && !o.holdsFocus())) return undefined
    this.close(tabId)
    this.results.focusEntry(tabId, outcome.key)
    return outcome.key
  }

  /** Cancels the comparison of these inputs, this way round, if it runs (a first run, or a change of the run's comparison
   *  of them); the picker says so while it shows that pair, and a cancelled change says so on its comparison. */
  cancel(tabId: string, old: EntryKey, neu: EntryKey): void {
    // The pair runs too while its comparison is swapped away: Cancel stops that swap, and the comparison stays.
    const leaving = this.leaving(tabId, old, neu), away = leaving === undefined ? undefined : replaceId(leaving)
    for (const item of [...this.inFlight.get(tabId)?.values() ?? []]) {
      if ((item.id !== away && (item.old !== old || item.neu !== neu)) || item.abort.signal.aborted) continue
      item.cancelled = true
      item.abort.abort()
      if (item.replaces !== undefined) this.say(item.replaces, 'The change was cancelled.')
      if (this.shows(tabId, undefined, old, neu, item.options.exact)) this.update(tabId, { cancelled: true })
    }
    this.publishRunning()
  }
  /** Cancels a change of a comparison in flight (its operation's Cancel). */
  cancelChange(tabId: string, key: EntryKey): void {
    const item = this.inFlight.get(tabId)?.get(replaceId(key))
    if (item && !item.abort.signal.aborted) this.cancel(tabId, item.old, item.neu)
  }

  /** Whether the tab's popover is open on these inputs, this way round and with this exact-text choice (and on that run). */
  private shows(tabId: string, queryId: string | undefined, old: EntryKey, neu: EntryKey, exact: boolean): boolean {
    const picker = this.getSnapshot().pickers[tabId], sides = this.sidesOf(tabId)
    return !!picker && (queryId === undefined || picker.queryId === queryId) && sides?.old.key === old && sides.neu.key === neu && picker.exact === exact
  }

  /** Compare with Previous Result: a grid's set against its previous Table; a failure is said in the toolbar, or in the
   *  popover while it shows that pair. */
  async compare(tabId: string, key: EntryKey, o: { exact?: boolean } = {}): Promise<void> {
    const from = this.previousOf(tabId, key)
    if (!from) return
    // The run's comparison of the pair is focused and never turned Exact text off; the Exact Text variant turns it on (D13).
    const shown = this.existing(tabId, from.key, key)
    if (!shown) { await this.comparePair(tabId, from.key, key, { exact: o.exact ?? false, remember: true }); return }
    this.results.focusEntry(tabId, shown.key)
    if (o.exact && !this.stateOf(tabId, shown)?.exact) await this.replace(tabId, shown.key, { exact: true })
  }

  /**
   * Compares two Tables of a run, `old` (−) with `neu` (+), and adds their diff as a comparison. Returns the comparison's
   * entry key; undefined when nothing was started (not two comparable Tables sharing a column, the same comparison already
   * running) or it was given up; or, with `quiet`, the sentence of a failure instead of saying it in the toolbar.
   */
  async comparePair(tabId: string, old: EntryKey, neu: EntryKey, o: CompareOptions & { quiet?: boolean; remember?: boolean }): Promise<{ readonly key: EntryKey } | CompareFailure | undefined> {
    const tab = this.results.getSnapshot()[tabId]
    const from = entryOf(tab?.sets, old), to = entryOf(tab?.sets, neu)
    if (!tab || !from || !to || !this.targetsOf(tabId, neu).some(target => target.entry.key === old)) return undefined
    // One comparison per ordered pair: the run's is focused, not made again.
    const shown = this.existing(tabId, old, neu)
    if (shown) { this.results.focusEntry(tabId, shown.key); return { key: shown.key } }
    // Its comparison is being swapped away: that one is focused, with its Cancel, until the swap settles.
    const leaving = this.leaving(tabId, old, neu)
    if (leaving !== undefined) { this.results.focusEntry(tabId, leaving); return undefined }
    const pairing = pairColumns(from.descriptor.columns, to.descriptor.columns), pairs = pairing.pairs.length
    const { layout, fallback } = layoutFor(o.layout ?? this.layout(), pairs)
    const [fromName, toName] = comparedNames(from, to, tab.sets)
    // The match remembered for the pair of names (D3), for a first run from the popover or Compare with Previous Result: a
    // key column that no longer pairs leaves it to Automatic, and the comparison says so.
    const remembered = o.remember && !o.match ? this.rememberedMatch(tabId, fromName, toName) : undefined
    const resolved = remembered ? resolveRemembered(remembered, pairing, from.descriptor.columns, to.descriptor.columns) : undefined
    let lost = remembered && resolved === null ? rememberedNames(remembered) : undefined
    const match = o.match ?? resolved ?? undefined
    // A new comparison keeps the rows the setting asks for (All rows: -1; Changes only: 0).
    let options: CompareOptions = { exact: o.exact, layout, ...match && match.mode !== 'auto' ? { match } : {}, context: o.context ?? contextOf(this.rows()) }
    // The inputs' own sorts and filters are not applied: its notice says so only when one had any when Compare was pressed.
    const filtered = [from, to].some(entry => { const sort = this.results.sortOf(tabId, entry.key); return !!sort && (sort.keys.length > 0 || sort.filters.length > 0) })
    const id = pairId(old, neu)
    let items = this.inFlight.get(tabId)
    // Asked again while it runs: the same options do nothing; other options give it up and start again with them.
    const running = items?.get(id)
    if (running && sameOptions(running.options, options)) return undefined
    running?.abort.abort()
    // Said in the popover while it shows this pair (it offers this comparison's Cancel), else in the toolbar; a refusal of
    // All rows offers Show changes only there, or in the results area's actionable notice.
    const fail = (text: string, code?: string): CompareFailure | undefined => {
      if (o.quiet) return { error: text, ...code ? { code } : {}, options }
      const rows = code === 'DIFF_ROWS_TOO_LARGE'
      if (this.shows(tabId, tab.queryId, old, neu, o.exact)) this.update(tabId, rows ? { error: rowsRefusedText, refusedRows: true } : { error: text })
      else if (rows) this.setActionable(tabId, tab.queryId, old, neu, options)
      else this.results.notify(tabId, text)
      return undefined
    }
    // A run keeps at most resultLimits.sets results, derived ones included: one that would pass it, counting those in
    // flight and the first Pivots being built, is refused before the backend is asked.
    if (tab.sets.length + this.adding(tabId) + this.elsewhere(tabId) >= resultLimits.sets) return fail(compareFullText)
    const abort = new AbortController()
    const item: Running = { abort, queryId: tab.queryId, old, neu, id, options }
    if (!items) this.inFlight.set(tabId, items = new Map())
    items.set(id, item)
    // A new attempt on the pair the popover shows clears what it said of the last (a failure, a cancel), as its Compare does.
    if (!o.quiet && this.shows(tabId, tab.queryId, old, neu, o.exact)) this.update(tabId, { error: undefined, cancelled: false, refusedRows: false })
    this.publishRunning()
    // The toolbar's strip shows it, with a Cancel of its own beside the popover's.
    const ticket = this.results.operations.begin(tabId, { kind: 'compare', target: `${fromName} → ${toName}`, cancel: () => this.cancel(tabId, old, neu) })
    let done = false
    try {
      const attempt = (asked: CompareOptions) => this.jobs.run(() => from.handle.diff(to.handle, { ...diffOptions(asked), signal: abort.signal, onProgress: (phase, percent) => ticket.progress(phase, percent) }), { signal: abort.signal })
      let result: ResultsDiffResult
      try { result = await attempt(options) } catch (error) {
        // Remembered key columns holding values too long to compare are matched automatically instead, and that is said;
        // only that refusal (any other failure is the comparison's own).
        if (abort.signal.aborted || !remembered || !options.match || !(error instanceof ResultError) || error.code !== 'DIFF_KEY_TRUNCATED') throw error
        lost = rememberedNames(remembered)
        options = withoutMatch(options)
        result = await attempt(options)
      }
      // Given up after the backend answered (a Cancel, a new run, an input closed in the same task): nothing is added, and
      // the diff it built is released.
      if (abort.signal.aborted) { this.results.discard(result.descriptor); return undefined }
      // A comparison that came back to this pair meanwhile (its swap cancelled or failed) is the pair's (D9).
      const already = this.existing(tabId, old, neu)
      if (already) { this.results.discard(result.descriptor); this.results.focusEntry(tabId, already.key); return { key: already.key } }
      const label = comparisonName(fromName, toName, o.exact)
      // Only the run that holds both sets takes the diff; otherwise (a re-run, a closed tab) it is released, and the strip
      // says nothing was compared.
      // The tab's sides take the title's names, which a result closed meanwhile would otherwise change ("Totals (Result 1)").
      const key = this.results.addSet(tabId, result.descriptor, label, [setKey(from.descriptor), setKey(to.descriptor)], { names: [fromName, toName] })
      if (key === undefined) return undefined
      done = true
      const info: CompareInfo = { ...compareInfoOf(from, to, fromName, toName, options, result, pairs, fallback), ...filtered ? { filtered: true as const } : {}, ...lost ? { rememberedLost: lost } : {} }
      // Only diffs some run still shows are kept; this one is kept until its run publishes it.
      this.fresh.set(setKey(result.descriptor), { tabId, queryId: tab.queryId })
      this.publish({ ...this.getSnapshot(), info: this.shown(this.getSnapshot().info).set(setKey(result.descriptor), info) })
      this.clearActionable(tabId, old, neu)
      this.say(key, undefined, publishText(info, false, this.visibleNotices(key, info, { change: false }).map(notice => notice.text)))
      return { key }
    } catch (error) {
      if (abort.signal.aborted) return undefined
      return fail(error instanceof Error ? error.message : 'The results could not be compared.', error instanceof ResultError ? error.code : undefined)
    } finally {
      ticket.end(done ? 'done' : item.cancelled ? 'cancelled' : 'dropped')
      if (items.get(id) === item) items.delete(id)
      if (items.size === 0 && this.inFlight.get(tabId) === items) this.inFlight.delete(tabId)
      this.publishRunning()
    }
  }

  /**
   * Changes a comparison in place (D9): runs it again with the change (another layout, Exact text, its sides swapped, rows
   * matched otherwise, other rows) and shows the new result in the comparison's slot, under its entry key, before the old
   * one is released (ResultsService.replaceComparison). The old comparison's memory is the new one's allowance (`replaces`,
   * D14). A newer change cancels an older one in flight. A failure, a refusal or a Cancel leaves the old comparison as it was
   * and says why on it (with `quiet`, a failure's sentence is returned instead, for the popover); closing an input cancels
   * it and says so. Swapped onto a pair the run has the other way round, that comparison is focused instead. Its widths,
   * highlights and an open Column Profile carry over; its key columns follow their names across a swap. Returns the
   * comparison's entry key, or undefined when nothing was changed.
   */
  async replace(tabId: string, key: EntryKey, change: CompareChange, o: { quiet?: boolean } = {}): Promise<{ readonly key: EntryKey } | CompareFailure | undefined> {
    const tab = this.results.getSnapshot()[tabId], slot = slotOf(tab, key), info = this.infoOf(slot?.entry)
    if (!tab || !slot || slot.view !== 'comparison' || !info || this.closedReason(tabId, key) !== undefined) return undefined
    let items = this.inFlight.get(tabId)
    // A change still running is what this one changes further.
    const base: ChangeBase = this.pendingChange(tabId, key) ?? info
    // Its match menu lists the pairs of the comparison as it was asked; a change makes them stale, so it closes.
    if (this.getSnapshot().matchMenu?.key === key) this.closeMatchMenu()
    const [old, neu] = change.swap ? [base.right, base.left] : [base.left, base.right]
    const from = entryOf(tab.sets, old), to = entryOf(tab.sets, neu)
    if (!from || !to) return undefined
    if (old !== info.left || neu !== info.right) {
      // The pair's comparison, or another one swapping into it, is focused instead (D9).
      const other = this.existing(tabId, old, neu)
      if (other && other.key !== key) { this.results.focusEntry(tabId, other.key); return { key: other.key } }
      // The pair's first run is in flight: it will be the pair's comparison, so this one stays as it is, and says why.
      const first = items?.get(pairId(old, neu))
      if (first && !first.abort.signal.aborted) {
        const [fromName, toName] = comparedNames(from, to, tab.sets)
        this.say(key, undefined, `${fromName} → ${toName} is already being compared.`)
        return undefined
      }
    }
    const pairing = pairColumns(from.descriptor.columns, to.descriptor.columns)
    // Key columns are asked by pair index, and pairs follow the old side's columns: across a swap they are found again by
    // name (pairing by name is symmetric), and Automatic is asked when one no longer pairs.
    const match = change.match ?? (change.swap ? keysByName(base, pairing, to.descriptor.columns) : base.asked)
    const { layout, fallback } = layoutFor(change.layout ?? (base.fallback ? 'entry' : base.layout), pairing.pairs.length)
    const exact = change.exact ?? base.exact, context = change.context ?? base.context
    const options: CompareOptions = { exact, layout, ...match && match.mode !== 'auto' ? { match } : {}, ...context === undefined ? {} : { context } }
    const keyNames = match?.mode === 'columns' ? match.columns.map(at => to.descriptor.columns[pairing.pairs[at]?.[1] ?? -1]?.name ?? '') : []
    const next: ChangeBase = { left: old, right: neu, layout, exact, ...context === undefined ? {} : { context }, ...match ? { asked: match } : {}, ...fallback ? { fallback: true as const } : {}, match: { columns: keyNames } }
    // A newer change cancels an older one in flight (the Pivot rule), which then says nothing.
    items?.get(replaceId(key))?.abort.abort()
    const abort = new AbortController()
    const item: Running = { abort, queryId: tab.queryId, old, neu, id: replaceId(key), options, replaces: key, base: next }
    if (!items) this.inFlight.set(tabId, items = new Map())
    items.set(item.id, item)
    this.clearNotice(key)
    this.publishRunning()
    const [fromName, toName] = comparedNames(from, to, tab.sets)
    const ticket = this.results.operations.begin(tabId, { kind: 'compare', target: `${fromName} → ${toName}`, cancel: () => this.cancelChange(tabId, key) })
    let done = false
    try {
      const result = await this.jobs.run(() => from.handle.diff(to.handle, { ...diffOptions(options), replaces: slot.entry.handle, signal: abort.signal, onProgress: (phase, percent) => ticket.progress(phase, percent) }), { signal: abort.signal })
      if (abort.signal.aborted) { this.results.discard(result.descriptor); return undefined }
      // Its inputs' filters and sorts were not applied when it was made, and still are not.
      const shownInfo: CompareInfo = { ...compareInfoOf(from, to, fromName, toName, options, result, pairing.pairs.length, fallback), ...info.filtered ? { filtered: true as const } : {} }
      const replaced = slotOf(this.results.getSnapshot()[tabId], key)?.entry
      if (!replaced) { this.results.discard(result.descriptor); return undefined }
      // The chips pressed now, re-applied to the new result as its kind filter (the replace resets its filters), and what
      // was shown, so the announcement names only the notices it newly shows.
      const pressed = this.pressedKinds(tabId, key), before = new Set(this.visibleNotices(key, info, { change: false }).map(noticeId))
      // The details are there before the new set publishes, so its grid never shows without them.
      this.fresh.set(setKey(result.descriptor), { tabId, queryId: tab.queryId })
      this.publish({ ...this.getSnapshot(), info: this.shown(this.getSnapshot().info).set(setKey(result.descriptor), shownInfo) })
      const moved = comparisonColumns(replaced.descriptor.columns, result.descriptor.columns)
      if (this.results.replaceComparison(tabId, key, result.descriptor, comparisonName(fromName, toName, exact), [setKey(from.descriptor), setKey(to.descriptor)], { names: [fromName, toName], moved }) === undefined) {
        // Refused (and released there): its details go with it.
        this.fresh.delete(setKey(result.descriptor))
        this.publish({ ...this.getSnapshot(), info: this.shown(this.getSnapshot().info) })
        return undefined
      }
      done = true
      // A match chosen, or the sides swapped, is the pair's remembered match from now on (D3): a swap carries the match to
      // the new ordered pair, and an older entry for the reversed pair no longer applies to this one.
      if (change.match !== undefined || change.swap) this.rememberMatch(tabId, fromName, toName, rememberedOf(match, pairing, to.descriptor.columns))
      this.clearActionable(tabId, old, neu)
      // Pressed kinds the new result has none of are released, and the announcement says so (D11).
      const kept = pressed.filter(kind => countOf(shownInfo, kind) > 0), released = pressed.filter(kind => !kept.includes(kind))
      if (kept.length > 0) this.results.setKindFilter(tabId, key, kept)
      const fresh = this.visibleNotices(key, shownInfo, { change: false }).filter(notice => !before.has(noticeId(notice))).map(notice => notice.text)
      this.say(key, undefined, publishText(shownInfo, true, [...fresh, ...released.map(releasedText)]))
      // Highlights follow their entries (D15); with every row stored, those whose entry is gone are dropped and counted.
      this.carry?.(tabId, key, { prune: shownInfo.context === -1, pruned: count => { if (count > 0) this.say(key, undefined, `${formatCount(count)} ${count === 1 ? 'highlight' : 'highlights'} removed`) } })
      return { key }
    } catch (error) {
      if (abort.signal.aborted) return undefined
      const message = error instanceof Error ? error.message : 'The results could not be compared.', code = error instanceof ResultError ? error.code : undefined
      if (o.quiet) return { error: message, ...code ? { code } : {}, options }
      // A refusal of All rows for memory offers Show changes only on the comparison (DIFF_ROWS_TOO_LARGE).
      if (code === 'DIFF_ROWS_TOO_LARGE') this.refuse(key, change)
      else this.say(key, `The comparison was not changed: ${message}`)
      return undefined
    } finally {
      ticket.end(done ? 'done' : item.cancelled ? 'cancelled' : 'dropped')
      // A menu opened while it ran lists the pairs it would have made: cancelled or refused, those pairs are stale, and
      // landed, its grid and toolbar are drawn again, which would reset the menu's ticks under the user.
      if (this.getSnapshot().matchMenu?.key === key) this.closeMatchMenu()
      if (items.get(item.id) === item) items.delete(item.id)
      if (items.size === 0 && this.inFlight.get(tabId) === items) this.inFlight.delete(tabId)
      this.publishRunning()
    }
  }

  /** Says on a comparison that a change of it was refused for memory, keeping the change for its Show changes only. */
  private refuse(key: EntryKey, change: CompareChange): void {
    this.say(key, rowsRefusedText)
    this.refusedChanges.set(key, change)
    this.publish({ ...this.getSnapshot(), refused: new Set(this.getSnapshot().refused).add(key) })
  }

  /** Whether a comparison's live region is to say its announcement `at`: once per announcement, so a toolbar mounted again
   *  (another tab shown and back, a popout) does not say it again. */
  speak(key: EntryKey, at: number): boolean {
    if ((this.spoken.get(key) ?? 0) >= at) return false
    this.spoken.set(key, at)
    return true
  }

  /** Sets a comparison's notice (when `notice` is given) and announces `text`, by default the notice, in its live region.
   *  A new notice is not a refusal of All rows until the caller marks it so (`refused`). */
  private say(key: EntryKey, notice: string | undefined, text = notice): void {
    const snapshot = this.getSnapshot()
    const notices = notice === undefined ? snapshot.notices : new Map(snapshot.notices).set(key, notice)
    const announcements = text === undefined ? snapshot.announcements : new Map(snapshot.announcements).set(key, { text, at: ++this.announced })
    const refused = notice !== undefined && snapshot.refused.has(key) ? new Set([...snapshot.refused].filter(item => item !== key)) : snapshot.refused
    this.publish({ ...snapshot, notices, announcements, refused })
  }
  private clearNotice(key: EntryKey): void {
    const { notices, refused } = this.getSnapshot()
    if (!notices.has(key) && !refused.has(key)) return
    const next = new Map(notices)
    next.delete(key)
    this.publish({ ...this.getSnapshot(), notices: next, refused: new Set([...refused].filter(item => item !== key)) })
  }

  /**
   * A comparison's notice strip, in order: what its last change that did not publish said (a failure, a refusal of All rows
   * with Show changes only, a cancel, an input closed), then what the comparison itself says (`comparisonNotices`), less
   * those dismissed while their kind and text are unchanged. `change: false` leaves out the change's notice.
   */
  visibleNotices(key: EntryKey, info: CompareInfo, o: { readonly change?: boolean } = {}): readonly ComparisonNotice[] {
    const { notices, refused, dismissed } = this.getSnapshot()
    const change = o.change === false ? undefined : notices.get(key)
    const all = [...change ? [{ kind: 'change', text: change, tone: 'warning' as const, ...refused.has(key) && this.refusedChange(key) ? { actions: ['changesOnly' as const] } : {} }] : [], ...comparisonNotices(info)]
    const hidden = dismissed.get(key)
    return hidden ? all.filter(notice => !hidden.has(noticeId(notice))) : all
  }
  /** Dismisses a notice of a comparison's strip: it stays hidden while its kind and text are unchanged (a change notice
   *  is cleared). */
  dismiss(key: EntryKey, notice: Pick<ComparisonNotice, 'kind' | 'text'>): void {
    if (notice.kind === 'change') { this.clearNotice(key); return }
    const dismissed = new Map(this.getSnapshot().dismissed)
    dismissed.set(key, new Set(dismissed.get(key)).add(noticeId(notice)))
    this.publish({ ...this.getSnapshot(), dismissed })
  }

  /** The kinds a comparison's chips have pressed: its kind filter's, less `same`, which no chip sends (D11). */
  pressedKinds(tabId: string, key: EntryKey): readonly DiffKindName[] {
    const filter = this.results.sortOf(tabId, key)?.filters.find(item => item.filter.op === 'kind')?.filter
    return filter?.op === 'kind' ? filter.kinds.filter(kind => kind !== 'same') : []
  }
  /** Presses or releases a chip: the kind filter then has exactly the pressed kinds, none pressed none (D11). It only
   *  filters what the comparison holds, so it stays available while an input is closed. */
  toggleKind(tabId: string, key: EntryKey, kind: Exclude<DiffKindName, 'same'>): void {
    const pressed = this.pressedKinds(tabId, key)
    const next = pressed.includes(kind) ? pressed.filter(item => item !== kind) : chipKinds.filter(item => item === kind || pressed.includes(item))
    this.results.setKindFilter(tabId, key, next)
  }

  /** The change a comparison refused for memory (DIFF_ROWS_TOO_LARGE), which its notice's Show changes only asks again
   *  with Changes only; undefined when that change asked only for All rows (Changes only would change nothing). */
  refusedChange(key: EntryKey): CompareChange | undefined {
    if (!this.getSnapshot().refused.has(key)) return undefined
    const change = this.refusedChanges.get(key)
    if (!change) return undefined
    const { context, ...rest } = change
    return context === -1 && Object.keys(rest).length === 0 ? undefined : { ...rest, context: 0 }
  }
  /** The match remembered for an ordered pair of input names in a tab, if any. */
  rememberedMatch(tabId: string, oldName: string, newName: string): RememberedMatch | undefined { return this.matches.get(tabId)?.get(matchKey(oldName, newName)) }
  /** What the popover's next first run of its pair will match rows by: the remembered match (`remembered`), else Automatic. */
  pickerMatch(tabId: string): { readonly text: string; readonly remembered: boolean } | undefined {
    const tab = this.results.getSnapshot()[tabId], sides = this.sidesOf(tabId)
    if (!tab || !sides) return undefined
    const remembered = this.rememberedMatch(tabId, ...comparedNames(sides.old, sides.neu, tab.sets))
    return remembered ? { text: rememberedLabel(remembered), remembered: true } : { text: 'Automatic', remembered: false }
  }
  /** Keeps the last match applied to an ordered pair of names, at most `rememberedLimit` a tab (the oldest goes first). */
  private rememberMatch(tabId: string, oldName: string, newName: string, match: RememberedMatch): void {
    // Automatic is what an unremembered pair does: it forgets the pair rather than reading "Automatic (remembered)".
    if (match.mode === 'auto') { this.matches.get(tabId)?.delete(matchKey(oldName, newName)); return }
    let memory = this.matches.get(tabId)
    if (!memory) this.matches.set(tabId, memory = new Map())
    const id = matchKey(oldName, newName)
    memory.delete(id)
    memory.set(id, match)
    while (memory.size > rememberedLimit) memory.delete(memory.keys().next().value!)
  }

  /** Says a first run's refusal of All rows in the results area (no popover shows its pair): its button runs it again with
   *  Changes only. It replaces the tab's earlier one. */
  private setActionable(tabId: string, queryId: string, old: EntryKey, neu: EntryKey, options: CompareOptions): void {
    const tab = this.results.getSnapshot()[tabId], from = entryOf(tab?.sets, old), to = entryOf(tab?.sets, neu)
    if (!tab || !from || !to) return
    const names = comparedNames(from, to, tab.sets)
    this.publish({ ...this.getSnapshot(), actionable: { ...this.getSnapshot().actionable, [tabId]: { queryId, old, neu, names: [names[0], names[1]], text: rowsRefusedText, options } } })
  }
  /** Clears the tab's actionable notice: dismissed, acted on, or (with `old` and `neu`) once that pair's comparison is shown. */
  clearActionable(tabId: string, old?: EntryKey, neu?: EntryKey): void {
    const actionable = this.getSnapshot().actionable, notice = actionable[tabId]
    if (!notice || (old !== undefined && (notice.old !== old || notice.neu !== neu))) return
    const next = { ...actionable }
    delete next[tabId]
    this.publish({ ...this.getSnapshot(), actionable: next })
  }
  /** Why the actionable notice's button cannot run (D10): an input closed. */
  actionableReason(tabId: string): string | undefined {
    const tab = this.results.getSnapshot()[tabId], notice = this.getSnapshot().actionable[tabId]
    if (!tab || !notice) return undefined
    const closed = [notice.old, notice.neu].findIndex(key => !openEntry(tab, key))
    return closed < 0 ? undefined : `${notice.names[closed]} is closed`
  }
  /** The actionable notice's Show changes only: the refused first run again, with Changes only. */
  async runActionable(tabId: string): Promise<EntryKey | undefined> {
    const notice = this.getSnapshot().actionable[tabId]
    if (!notice || this.actionableReason(tabId) !== undefined) return undefined
    this.clearActionable(tabId)
    const outcome = await this.comparePair(tabId, notice.old, notice.neu, { ...notice.options, context: 0 })
    if (outcome && 'key' in outcome) { this.results.focusEntry(tabId, outcome.key); return outcome.key }
    return undefined
  }

  /** Opens a comparison's match menu, from its toolbar's Match button or a notice (drawn beside Match) or from ⋯ (More
   *  results tools, drawn beside it); not while an input is closed (D10). */
  openMatchMenu(tabId: string, key: EntryKey, from: MatchMenuFrom = 'toolbar'): void {
    if (!this.infoOf(slotOf(this.results.getSnapshot()[tabId], key)?.entry) || this.closedReason(tabId, key) !== undefined) return
    this.publish({ ...this.getSnapshot(), matchMenu: { tabId, key, from } })
  }
  closeMatchMenu(): void { if (this.getSnapshot().matchMenu) this.publish({ ...this.getSnapshot(), matchMenu: undefined }) }
  /** The columns a comparison's inputs pair (as it will be: its change in flight's sides), by pair index: the new side's
   *  name and column, which the match menu lists. Empty while an input is closed. */
  pairsOf(tabId: string, key: EntryKey): readonly { readonly name: string; readonly column: ResultColumn }[] {
    const tab = this.results.getSnapshot()[tabId], state = this.stateOf(tabId, slotOf(tab, key)?.entry)
    const from = entryOf(tab?.sets, state?.left), to = entryOf(tab?.sets, state?.right)
    if (!from || !to) return []
    return pairColumns(from.descriptor.columns, to.descriptor.columns).pairs.map(([, right]) => ({ name: to.descriptor.columns[right].name, column: to.descriptor.columns[right] }))
  }

  /** The details of the diffs some run shows, or that were just added to a run that has yet to publish them. */
  private shown(info: ReadonlyMap<string, CompareInfo>): Map<string, CompareInfo> {
    const snapshot = this.results.getSnapshot()
    const shown = new Set(Object.values(snapshot).flatMap(run => run.sets.map(entry => setKey(entry.descriptor))))
    for (const [setId, added] of this.fresh) {
      const run = snapshot[added.tabId]
      if (shown.has(setId) || run?.queryId !== added.queryId || run.status === 'closed') this.fresh.delete(setId)
    }
    return new Map([...info].filter(([setId]) => shown.has(setId) || this.fresh.has(setId)))
  }

  private publishRunning(): void {
    const running: Record<string, readonly string[]> = {}
    for (const [tabId, items] of this.inFlight) {
      const ids = [...items.values()].filter(item => !item.abort.signal.aborted).map(item => item.id)
      if (ids.length > 0) running[tabId] = ids
    }
    this.publish({ ...this.getSnapshot(), running })
  }
  /** Keeps the popover's choice for the next open on its group (a target that closed is not one). */
  private remember(tabId: string, picker: ComparePicker): void {
    let memory = this.remembered.get(tabId)
    if (!memory) this.remembered.set(tabId, memory = { exact: picker.exact, groups: new Map() })
    memory.exact = picker.exact
    if (picker.target !== undefined && picker.targetOrdinal !== undefined) memory.groups.set(picker.ordinal, { targetOrdinal: picker.targetOrdinal, swapped: picker.swapped })
  }
  private setPicker(tabId: string, picker: ComparePicker): void {
    this.publish({ ...this.getSnapshot(), pickers: { ...this.getSnapshot().pickers, [tabId]: picker } })
  }
  private update(tabId: string, change: Partial<ComparePicker>): void {
    const picker = this.getSnapshot().pickers[tabId]
    if (!picker) return
    const next = { ...picker, ...change }
    if (next.targetOrdinal === undefined) delete (next as { targetOrdinal?: number }).targetOrdinal
    if (next.error === undefined) delete (next as { error?: string }).error
    if (!next.cancelled) delete (next as { cancelled?: boolean }).cancelled
    if (!next.refusedRows) delete (next as { refusedRows?: boolean }).refusedRows
    this.setPicker(tabId, next)
  }
  /** A choice made in the popover (a pick, a swap, Exact text, Compare): applied and remembered. What it is told of a
   *  comparison (a failure, a cancel, a new attempt from elsewhere) goes through `update` and is not a choice. */
  private choose(tabId: string, change: Partial<ComparePicker>): void {
    this.update(tabId, change)
    const picker = this.getSnapshot().pickers[tabId]
    if (picker) this.remember(tabId, picker)
  }

  dispose(): void {
    this.unsubscribe()
    this.unsubscribeFocus()
    this.togglesStore.clear()
    for (const items of this.inFlight.values()) for (const item of items.values()) item.abort.abort()
    this.inFlight.clear()
    this.clearListeners()
  }
}

/** The entry of a run under its key while it holds its rows (not closed, released or lost). */
function openEntry(tab: TabResults, key: EntryKey): ResultSetEntry | undefined {
  const entry = entryOf(tab.sets, key), state = entry?.handle.getSnapshot().state
  return entry && state !== 'released' && state !== 'lost' ? entry : undefined
}

/** A map's entries whose key is still shown, or the map itself when all are. */
function shownOnly<V>(map: ReadonlyMap<EntryKey, V>, keys: ReadonlySet<EntryKey>): ReadonlyMap<EntryKey, V> {
  const next = new Map([...map].filter(([key]) => keys.has(key)))
  return next.size === map.size ? map : next
}

/** What results.diff is asked for a comparison's options. */
const diffOptions = (options: CompareOptions) => ({ exact: options.exact, ...options.layout ? { layout: options.layout } : {}, ...options.match ? { match: options.match } : {}, ...options.context === undefined ? {} : { context: options.context } })

/** A comparison's details from its inputs, its options and the backend's answer. */
function compareInfoOf(from: ResultSetEntry, to: ResultSetEntry, fromName: string, toName: string, options: CompareOptions, result: ResultsDiffResult, pairs: number, fallback: boolean): CompareInfo {
  return {
    left: from.key, right: to.key, leftNumber: from.number, rightNumber: to.number, leftName: fromName, rightName: toName, match: result.match,
    ...options.match ? { asked: options.match } : {}, ...options.context === undefined ? {} : { context: options.context },
    layout: result.layout, ...fallback ? { fallback: true as const } : {}, pairs, columnChanges: result.columnChanges,
    exact: options.exact, same: result.same, changed: result.changed, added: result.added, removed: result.removed,
    soft: result.soft, leftOnly: result.leftOnly, rightOnly: result.rightOnly, approximate: result.approximate,
    repeated: result.repeated, possible: result.possible, possibleSkipped: result.possibleSkipped, nothingPaired: result.nothingPaired, trailingHidden: result.trailingHidden,
    // The handles' counts: an entry keeps the descriptor it opened with, before any row was stored.
    leftRows: from.handle.getSnapshot().rowsStored, rightRows: to.handle.getSnapshot().rowsStored,
    inputRows: Math.max(from.handle.getSnapshot().rowsStored, to.handle.getSnapshot().rowsStored)
  }
}

/** A comparison's key columns after a swap, as pair indexes of the new pairing: the columns of the names it matched by
 *  (pairs follow the old side's columns, so their indexes change), or Automatic (undefined) when one no longer pairs. */
export function keysByName(info: { readonly asked?: DiffMatch; readonly match: { readonly columns: readonly string[] } }, pairing: ColumnPairing, newColumns: readonly { readonly name: string }[]): DiffMatch | undefined {
  if (info.asked?.mode !== 'columns') return info.asked
  const columns: number[] = []
  for (const name of info.match.columns) {
    const at = pairing.pairs.findIndex(([, column], index) => !columns.includes(index) && newColumns[column]?.name.toLowerCase() === name.toLowerCase())
    if (at < 0) return undefined
    columns.push(at)
  }
  return columns.length > 0 ? { mode: 'columns', columns } : undefined
}

/** What a comparison's live region says when it is shown: "Comparison ready: …" the first time, "Comparison updated: …"
 *  after a change, then what follows it (the notices it newly shows, chips released). */
export function publishText(info: CompareInfo, updated: boolean, then: readonly string[] = []): string {
  const by = info.match.mode === 'position' ? 'matched by position' : info.match.columns.length > 0 && info.match.mode !== 'rows' ? `matched by ${info.match.columns.join(', ')}` : 'matched by whole rows'
  const text = `Comparison ${updated ? 'updated' : 'ready'}: ${by}, ${formatCount(info.changed)} changed, ${formatCount(info.added)} added, ${formatCount(info.removed)} removed.`
  return [text, ...then].join(' ')
}

/** A first run's or change's failure, with its error code and the options it asked for (what Show changes only asks again). */
export interface CompareFailure { readonly error: string; readonly code?: string; readonly options?: CompareOptions }

/** The chips, in the toolbar's order: added, removed, changed (D11). */
export const chipKinds: readonly Exclude<DiffKindName, 'same'>[] = ['added', 'removed', 'changed']
/** A comparison's count of a kind of entry. */
export const countOf = (info: Pick<CompareInfo, 'same' | 'changed' | 'added' | 'removed'>, kind: DiffKindName): number => info[kind]
/** What the announcement says of a pressed chip the new comparison has none of. */
const releasedText = (kind: DiffKindName) => `No ${kind} rows are left, so that filter was turned off.`
/** Options without a match: Automatic. */
function withoutMatch(options: CompareOptions): CompareOptions {
  const next: { -readonly [K in keyof CompareOptions]: CompareOptions[K] } = { ...options }
  delete next.match
  return next
}

/** A tab's remembered matches are per ordered pair of input names. */
const matchKey = (oldName: string, newName: string) => `${oldName}\u0000${newName}`
/** A remembered match's key columns as the popover and the notice name them ("id, status"). */
const rememberedNames = (match: RememberedMatch) => (match.columns ?? []).map(column => column.name).join(', ')
/** The popover's words for a remembered match. */
export function rememberedLabel(match: RememberedMatch): string {
  // Key columns read as the toolbar's Match button reads them ("⚷ Id + Status").
  return match.mode === 'columns' ? `⚷ ${(match.columns ?? []).map(column => column.name).join(' + ')}` : match.mode === 'position' ? 'Row position' : match.mode === 'rows' ? 'Whole rows' : 'Automatic'
}
/** A match as a tab remembers it: key columns by name and type (the new side's), so it resolves against other results. */
export function rememberedOf(match: DiffMatch | undefined, pairing: ColumnPairing, newColumns: readonly { readonly name: string; readonly dataType: string }[]): RememberedMatch {
  if (match?.mode !== 'columns') return { mode: match?.mode ?? 'auto' }
  return { mode: 'columns', columns: match.columns.map(at => { const column = newColumns[pairing.pairs[at]?.[1] ?? -1]; return { name: column?.name ?? '', type: column?.dataType ?? '' } }) }
}
/**
 * A remembered match for a pair's columns: its mode, or for key columns the pair indexes of columns of those names whose
 * old or new side has the remembered type (a swap exchanges the sides); undefined for Automatic, and null when a column
 * no longer pairs (the comparison then matches automatically and says so).
 */
export function resolveRemembered(match: RememberedMatch, pairing: ColumnPairing, oldColumns: readonly { readonly name: string; readonly dataType: string }[], newColumns: readonly { readonly name: string; readonly dataType: string }[]): DiffMatch | undefined | null {
  if (match.mode === 'auto') return undefined
  if (match.mode !== 'columns') return { mode: match.mode }
  const columns: number[] = []
  for (const wanted of match.columns ?? []) {
    const name = wanted.name.toLowerCase()
    const at = pairing.pairs.findIndex(([left, right], index) => !columns.includes(index) && newColumns[right]?.name.toLowerCase() === name
      && (oldColumns[left]?.dataType === wanted.type || newColumns[right]?.dataType === wanted.type))
    if (at < 0) return null
    columns.push(at)
  }
  return columns.length > 0 && columns.length <= wire.diff.maxKeyColumns ? { mode: 'columns', columns } : null
}

/** What opened a comparison's match menu: its Match button, ⋯ (More results tools), or a notice's Choose key columns…. */
export type MatchMenuFrom = 'toolbar' | 'more' | 'notice'

/** What the toolbar's Match button shows ("id + status" after a ⚷ it draws, "Row position", "Whole rows", "Automatic: id",
 *  "Automatic: whole rows") and its accessible name ("Match rows by key columns: id + status"), from what was asked and
 *  what was used; `key` when it is key columns. */
export function matchLabel(state: { readonly asked?: DiffMatch; readonly match: { readonly mode?: DiffMatchUsed['mode']; readonly columns: readonly string[] } }): { readonly text: string; readonly name: string; readonly key?: boolean } {
  const mode = state.asked?.mode ?? 'auto', columns = state.match.columns
  // Key columns' ⚷ is drawn by the toolbar (CSS, not read out), so the name says "key columns" instead.
  if (mode === 'columns') return { text: columns.join(' + '), name: `Match rows by key columns: ${columns.join(' + ')}`, key: true }
  if (mode === 'position') return { text: 'Row position', name: 'Match rows by row position' }
  if (mode === 'rows') return { text: 'Whole rows', name: 'Match rows by whole rows' }
  // Automatic, as it came out (a change in flight does not know yet).
  if (state.match.mode === undefined) return { text: 'Automatic', name: 'Match rows automatically' }
  const by = state.match.mode === 'rows' || columns.length === 0 ? 'whole rows' : columns.join(', ')
  return { text: `Automatic: ${by}`, name: `Match rows automatically, by ${by}` }
}

/**
 * What a comparison says under its toolbar, in order (plan: Toolbar and notices): the remembered match it could not use,
 * two rows past the one-row limit, rows that look alike (with Choose key columns… and, when both inputs have as many
 * rows, Match by row position), possible matches not looked for, nothing paired (the same buttons), columns not
 * compared, long values compared by their stored part, soft differences, the empty cases, and that the inputs' filters
 * and sorts were not applied (only when one had any).
 */
export function comparisonNotices(info: CompareInfo): readonly ComparisonNotice[] {
  const notices: ComparisonNotice[] = []
  const [leftName, rightName] = sideNames(info)
  const keyed = info.match.mode !== 'rows' && info.match.mode !== 'position' && info.match.columns.length > 0
  const actions: readonly NoticeAction[] = info.leftRows === info.rightRows ? ['chooseKeys', 'byPosition'] : ['chooseKeys']
  if (info.rememberedLost) notices.push({ kind: 'remembered', tone: 'warning', text: `Rows could not be matched by the remembered key columns (${info.rememberedLost}), so they were matched automatically.` })
  if (info.fallback) notices.push({ kind: 'fallback', tone: 'info', text: fallbackText })
  if (info.nothingPaired) {
    notices.push({ kind: 'nothingPaired', tone: 'warning', actions, text: keyed ? `No rows matched by ${info.match.columns.join(', ')}, so every row shows as removed or added.` : 'No rows are the same in both results, so every row shows as removed or added.' })
  }
  if (info.possible > 0) {
    const n = info.possible, rows = `${formatCount(n)} removed and ${formatCount(n)} added ${n === 1 ? 'row' : 'rows'}`
    const text = keyed ? `${rows} look like the same ${n === 1 ? 'row' : 'rows'} with a changed key (${info.match.columns.join(', ')}). Counts and colours are unchanged.`
      : `${rows} look like ${n === 1 ? 'one row' : 'the same rows'} with changed values.`
    // Nothing paired already offers the buttons.
    notices.push({ kind: 'possible', tone: 'info', text, ...info.nothingPaired ? {} : { actions } })
  }
  if (info.possibleSkipped) notices.push({ kind: 'possibleSkipped', tone: 'info', text: 'Too many unmatched rows to look for possible matches.' })
  const others = [...info.leftOnly.map(name => `${name} (${leftName})`), ...info.rightOnly.map(name => `${name} (${rightName})`)]
  if (others.length > 0) notices.push({ kind: 'notCompared', tone: 'info', text: `Not compared: ${others.join(', ')}.` })
  if (info.approximate) notices.push({ kind: 'approximate', tone: 'info', text: 'Long values were compared by the part these results keep, so a difference past it does not show.' })
  if (info.soft > 0) notices.push({ kind: 'soft', tone: 'info', text: `${count(info.soft, 'value differs', 'values differ')} only by collation (case or trailing spaces), underlined.` })
  if (info.leftRows === 0 && info.rightRows === 0) notices.push({ kind: 'empty', tone: 'info', text: 'Both results are empty.' })
  else if (info.changed + info.added + info.removed === 0) {
    notices.push({ kind: 'empty', tone: 'info', text: info.context === 0 && info.same > 0 ? `No differences. ${count(info.same, 'unchanged row')} hidden.` : 'No differences.' })
  }
  if (info.filtered) notices.push({ kind: 'filtered', tone: 'info', text: 'Filters and sorts on the inputs were not applied: all their stored rows were compared, in their own order.' })
  return notices
}

/** The popover with nothing picked (its target closed), and nothing said of the pair it had. */
function withoutTarget(picker: ComparePicker): ComparePicker {
  const next: { -readonly [K in keyof ComparePicker]: ComparePicker[K] } = { ...picker }
  delete next.target
  delete next.targetOrdinal
  delete next.error
  delete next.cancelled
  delete next.refusedRows
  return next
}

const count = (value: number, one: string, many = one + 's') => `${formatCount(value)} ${value === 1 ? one : many}`

/** A comparison's input as its strip links it: its name, and the entry to go to while that exact result is open (a closed
 *  input, or one whose slot shows another result now, reads closed). */
export interface CompareSource { readonly name: string; readonly entry?: EntryKey }
/** The comparison's two inputs (old, then new) from its frozen references (`ResultSlot.sources`). */
export function compareSources(tab: TabResults | undefined, sources: readonly SourceRef[]): readonly CompareSource[] {
  return sources.map(source => {
    const entry = entryOf(tab?.sets, source.key)
    return entry && setKey(entry.descriptor) === source.set ? { name: source.name, entry: entry.key } : { name: source.name }
  })
}

/** The two compared results' names as they were when compared, "Result N" for a comparison made before names. */
const sideNames = (info: CompareInfo): [string, string] => [info.leftName ?? entryNumber({ number: info.leftNumber }), info.rightName ?? entryNumber({ number: info.rightNumber })]

/** How the strip says rows were matched. */
export function matchedBy(match: DiffMatchUsed): string {
  if (match.mode === 'position') return 'rows matched by position'
  return match.columns.length > 0 && match.mode !== 'rows' ? `rows matched by ${match.columns.join(', ')}` : 'whole rows matched'
}

/** What a diff grid's strip says after its two inputs: how rows matched and the counts, with the unchanged rows Changes
 *  only left out. What else the comparison says is in its notice strip, under its toolbar. */
export function compareDetails(info: CompareInfo): string {
  const by = matchedBy(info.match)
  const hidden = info.context === 0 && info.same > 0 ? ` (${formatCount(info.same)} hidden)` : ''
  return `${by}${info.exact ? ', text compared exactly' : ''}: ${count(info.changed, 'changed row')}, ${count(info.added, 'added row')}, ${count(info.removed, 'removed row')}, ${formatCount(info.same)} unchanged${hidden}.`
}

/** The whole strip as text (its tooltip, and what a screen reader reads): the inputs, a closed one so marked, then the details. */
export function compareText(info: CompareInfo, sources?: readonly CompareSource[]): string {
  const names = sources?.length === 2 ? sources.map(source => source.entry === undefined ? `${source.name} (closed)` : source.name) : sideNames(info)
  return `${names[0]} → ${names[1]}, ${compareDetails(info)}`
}
