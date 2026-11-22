import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { pairColumns, type ColumnPairing } from './compare-pairing'
import { DerivedJobs } from './derived-jobs'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import type { DiffLayout, DiffMatch, DiffMatchUsed, ResultsDiffResult } from '../../../shared/contracts'
import type { EntryKey, ResultSetEntry, ResultsService, SourceRef, TabResults } from './ResultsService'
import { comparedNames, comparisonColumns, comparisonName, entryNumber, entryOf, resultLimits, setKey, slotOf } from './ResultsService'
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
}
/** What a comparison is asked for besides its two inputs (its identity): its state, which a replace changes in place (D9). */
export interface CompareOptions { readonly exact: boolean; readonly layout?: DiffLayout; readonly match?: DiffMatch; readonly context?: number }
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
const sameOptions = (a: CompareOptions, b: CompareOptions) => a.exact === b.exact && a.layout === b.layout && a.context === b.context && JSON.stringify(a.match ?? null) === JSON.stringify(b.match ?? null)

/** The refusal of a comparison a run has no room for (plan: Concurrency and limits, the 1,000 rule). */
export const compareFullText = `This query's results already hold ${formatCount(resultLimits.sets)} results, comparisons and pivots included, the most a run keeps. Close some results to compare these.`

/** A group's Table of rows that has every row in memory: the only results a comparison reads (never a Pivot, a comparison, a
 *  plan set, a live result or a result windowed in BigQuery, which the backend would refuse). */
export function comparableTable(tab: TabResults | undefined, entry: ResultSetEntry | undefined): entry is ResultSetEntry {
  const snapshot = entry?.handle.getSnapshot()
  return !!tab && entry !== undefined && entry.descriptor.kind === 'rows' && slotOf(tab, entry.key)?.view === 'table' && snapshot?.state === 'complete' && snapshot.residence !== 'remote'
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

type Results = Pick<ResultsService, 'getSnapshot' | 'subscribe' | 'addSet' | 'replaceComparison' | 'discard' | 'notify' | 'focusEntry' | 'operations'>
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

  constructor(results: Results, o: { jobs?: DerivedJobs; adding?: (tabId: string) => number; layout?: () => DiffLayout; carry?: CarryHighlights } = {}) {
    super({ info: new Map(), pickers: {}, running: {}, notices: new Map(), announcements: new Map() })
    this.results = results
    this.jobs = o.jobs ?? new DerivedJobs()
    this.elsewhere = o.adding ?? (() => 0)
    this.layout = o.layout ?? (() => 'entry')
    this.carry = o.carry
    this.unsubscribe = results.subscribe(() => this.sync())
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
    // A comparison's details go with the last run that shows it, not at the next comparison; so do its notice and
    // announcement once no run shows its entry.
    const info = this.getSnapshot().info, kept = info.size ? this.shown(info) : info
    if (kept.size !== info.size) this.publish({ ...this.getSnapshot(), info: kept })
    const { notices, announcements } = this.getSnapshot()
    if (notices.size || announcements.size || this.spoken.size) {
      const keys = new Set(Object.values(snapshot).flatMap(run => run.comparisons.map(slot => slot.key)))
      for (const key of this.spoken.keys()) if (!keys.has(key)) this.spoken.delete(key)
      const nextNotices = shownOnly(notices, keys), nextAnnouncements = shownOnly(announcements, keys)
      if (nextNotices !== notices || nextAnnouncements !== announcements) this.publish({ ...this.getSnapshot(), notices: nextNotices, announcements: nextAnnouncements })
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
    if (tab && entry) this.choose(tabId, { target, targetOrdinal: slotOf(tab, entry.key)?.group, error: undefined, cancelled: false })
  }
  swap(tabId: string): void { const picker = this.getSnapshot().pickers[tabId]; if (picker) this.choose(tabId, { swapped: !picker.swapped, error: undefined, cancelled: false }) }
  setExact(tabId: string, exact: boolean): void { this.choose(tabId, { exact, error: undefined, cancelled: false }) }

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
  async run(tabId: string, o: { readonly holdsFocus?: () => boolean } = {}): Promise<EntryKey | undefined> {
    const picker = this.getSnapshot().pickers[tabId], sides = this.sidesOf(tabId)
    if (!picker || !sides) return undefined
    const shown = this.existing(tabId, sides.old.key, sides.neu.key)
    // Show It on a pair the run has applies the popover's Exact text (D13): it only focuses the comparison when that
    // matches, else Update replaces it, with its progress, Cancel and failure in the popover as a first run's are.
    if (shown && this.stateOf(tabId, shown)?.exact === picker.exact) { this.remember(tabId, picker); this.close(tabId); this.results.focusEntry(tabId, shown.key); return shown.key }
    this.choose(tabId, { error: undefined, cancelled: false })
    const outcome = shown ? await this.replace(tabId, shown.key, { exact: picker.exact }, { quiet: true }) : await this.comparePair(tabId, sides.old.key, sides.neu.key, { exact: picker.exact, quiet: true })
    const same = this.shows(tabId, picker.queryId, sides.old.key, sides.neu.key, picker.exact)
    if (outcome && 'error' in outcome) {
      // A failure is said where it was asked for: in the picker while it still shows that pair, else in the toolbar.
      if (same) this.update(tabId, { error: outcome.error })
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
    if (!shown) { await this.comparePair(tabId, from.key, key, { exact: o.exact ?? false }); return }
    this.results.focusEntry(tabId, shown.key)
    if (o.exact && !this.stateOf(tabId, shown)?.exact) await this.replace(tabId, shown.key, { exact: true })
  }

  /**
   * Compares two Tables of a run, `old` (−) with `neu` (+), and adds their diff as a comparison. Returns the comparison's
   * entry key; undefined when nothing was started (not two comparable Tables sharing a column, the same comparison already
   * running) or it was given up; or, with `quiet`, the sentence of a failure instead of saying it in the toolbar.
   */
  async comparePair(tabId: string, old: EntryKey, neu: EntryKey, o: CompareOptions & { quiet?: boolean }): Promise<{ readonly key: EntryKey } | { readonly error: string } | undefined> {
    const tab = this.results.getSnapshot()[tabId]
    const from = entryOf(tab?.sets, old), to = entryOf(tab?.sets, neu)
    if (!tab || !from || !to || !this.targetsOf(tabId, neu).some(target => target.entry.key === old)) return undefined
    // One comparison per ordered pair: the run's is focused, not made again.
    const shown = this.existing(tabId, old, neu)
    if (shown) { this.results.focusEntry(tabId, shown.key); return { key: shown.key } }
    // Its comparison is being swapped away: that one is focused, with its Cancel, until the swap settles.
    const leaving = this.leaving(tabId, old, neu)
    if (leaving !== undefined) { this.results.focusEntry(tabId, leaving); return undefined }
    const pairs = pairColumns(from.descriptor.columns, to.descriptor.columns).pairs.length
    const { layout, fallback } = layoutFor(o.layout ?? this.layout(), pairs)
    const options: CompareOptions = { exact: o.exact, layout, ...o.match && o.match.mode !== 'auto' ? { match: o.match } : {}, ...o.context === undefined ? {} : { context: o.context } }
    const id = pairId(old, neu)
    let items = this.inFlight.get(tabId)
    // Asked again while it runs: the same options do nothing; other options give it up and start again with them.
    const running = items?.get(id)
    if (running && sameOptions(running.options, options)) return undefined
    running?.abort.abort()
    // Said in the popover while it shows this pair (it offers this comparison's Cancel), else in the toolbar.
    const fail = (text: string) => {
      if (o.quiet) return { error: text }
      if (this.shows(tabId, tab.queryId, old, neu, o.exact)) this.update(tabId, { error: text })
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
    if (!o.quiet && this.shows(tabId, tab.queryId, old, neu, o.exact)) this.update(tabId, { error: undefined, cancelled: false })
    this.publishRunning()
    // The toolbar's strip shows it, with a Cancel of its own beside the popover's.
    const [fromName, toName] = comparedNames(from, to, this.results.getSnapshot()[tabId]?.sets ?? [])
    const ticket = this.results.operations.begin(tabId, { kind: 'compare', target: `${fromName} → ${toName}`, cancel: () => this.cancel(tabId, old, neu) })
    let done = false
    try {
      const result = await this.jobs.run(() => from.handle.diff(to.handle, { ...diffOptions(options), signal: abort.signal, onProgress: (phase, percent) => ticket.progress(phase, percent) }), { signal: abort.signal })
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
      const info = compareInfoOf(from, to, fromName, toName, options, result, pairs, fallback)
      // Only diffs some run still shows are kept; this one is kept until its run publishes it.
      this.fresh.set(setKey(result.descriptor), { tabId, queryId: tab.queryId })
      this.publish({ ...this.getSnapshot(), info: this.shown(this.getSnapshot().info).set(setKey(result.descriptor), info) })
      this.say(key, undefined, publishText(info, false))
      return { key }
    } catch (error) {
      if (abort.signal.aborted) return undefined
      return fail(error instanceof Error ? error.message : 'The results could not be compared.')
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
  async replace(tabId: string, key: EntryKey, change: CompareChange, o: { quiet?: boolean } = {}): Promise<{ readonly key: EntryKey } | { readonly error: string } | undefined> {
    const tab = this.results.getSnapshot()[tabId], slot = slotOf(tab, key), info = this.infoOf(slot?.entry)
    if (!tab || !slot || slot.view !== 'comparison' || !info || this.closedReason(tabId, key) !== undefined) return undefined
    let items = this.inFlight.get(tabId)
    // A change still running is what this one changes further.
    const base: ChangeBase = this.pendingChange(tabId, key) ?? info
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
      const shownInfo = compareInfoOf(from, to, fromName, toName, options, result, pairing.pairs.length, fallback)
      const replaced = slotOf(this.results.getSnapshot()[tabId], key)?.entry
      if (!replaced) { this.results.discard(result.descriptor); return undefined }
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
      this.say(key, undefined, publishText(shownInfo, true))
      // Highlights follow their entries (D15); with every row stored, those whose entry is gone are dropped and counted.
      this.carry?.(tabId, key, { prune: shownInfo.context === -1, pruned: count => { if (count > 0) this.say(key, undefined, `${formatCount(count)} ${count === 1 ? 'highlight' : 'highlights'} removed`) } })
      return { key }
    } catch (error) {
      if (abort.signal.aborted) return undefined
      const message = error instanceof Error ? error.message : 'The results could not be compared.'
      if (o.quiet) return { error: message }
      this.say(key, `The comparison was not changed: ${message}`)
      return undefined
    } finally {
      ticket.end(done ? 'done' : item.cancelled ? 'cancelled' : 'dropped')
      if (items.get(item.id) === item) items.delete(item.id)
      if (items.size === 0 && this.inFlight.get(tabId) === items) this.inFlight.delete(tabId)
      this.publishRunning()
    }
  }

  /** Whether a comparison's live region is to say its announcement `at`: once per announcement, so a toolbar mounted again
   *  (another tab shown and back, a popout) does not say it again. */
  speak(key: EntryKey, at: number): boolean {
    if ((this.spoken.get(key) ?? 0) >= at) return false
    this.spoken.set(key, at)
    return true
  }

  /** Sets a comparison's notice (when `notice` is given) and announces `text`, by default the notice, in its live region. */
  private say(key: EntryKey, notice: string | undefined, text = notice): void {
    const snapshot = this.getSnapshot()
    const notices = notice === undefined ? snapshot.notices : new Map(snapshot.notices).set(key, notice)
    const announcements = text === undefined ? snapshot.announcements : new Map(snapshot.announcements).set(key, { text, at: ++this.announced })
    this.publish({ ...snapshot, notices, announcements })
  }
  private clearNotice(key: EntryKey): void {
    const notices = this.getSnapshot().notices
    if (!notices.has(key)) return
    const next = new Map(notices)
    next.delete(key)
    this.publish({ ...this.getSnapshot(), notices: next })
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
    for (const items of this.inFlight.values()) for (const item of items.values()) item.abort.abort()
    this.inFlight.clear()
    this.clearListeners()
  }
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
    // The handles' counts: an entry keeps the descriptor it opened with, before any row was stored.
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
 *  after a change, then any notice it shows (two rows past the one-row limit). */
export function publishText(info: CompareInfo, updated: boolean): string {
  const by = info.match.mode === 'position' ? 'matched by position' : info.match.columns.length > 0 && info.match.mode !== 'rows' ? `matched by ${info.match.columns.join(', ')}` : 'matched by whole rows'
  const text = `Comparison ${updated ? 'updated' : 'ready'}: ${by}, ${formatCount(info.changed)} changed, ${formatCount(info.added)} added, ${formatCount(info.removed)} removed.`
  return info.fallback ? `${text} ${fallbackText}` : text
}

/** The popover with nothing picked (its target closed), and nothing said of the pair it had. */
function withoutTarget(picker: ComparePicker): ComparePicker {
  const next: { -readonly [K in keyof ComparePicker]: ComparePicker[K] } = { ...picker }
  delete next.target
  delete next.targetOrdinal
  delete next.error
  delete next.cancelled
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

/** What a diff grid's strip says after its two inputs: how rows matched, the counts, soft differences, the columns left
 *  out, and that the inputs' filters and sorts were not applied. */
export function compareDetails(info: CompareInfo, notice?: string): string {
  const by = matchedBy(info.match)
  const [leftName, rightName] = sideNames(info)
  const parts = [`${by}${info.exact ? ', text compared exactly' : ''}: ${count(info.changed, 'changed row')}, ${count(info.added, 'added row')}, ${count(info.removed, 'removed row')}, ${formatCount(info.same)} unchanged.`]
  // Its notices follow the counts until the notice strip comes: a change that did not publish, and two rows shown past the
  // one-row limit.
  if (notice) parts.push(notice)
  if (info.fallback) parts.push(fallbackText)
  if (info.soft > 0) parts.push(`${count(info.soft, 'value differs', 'values differ')} only by collation (case or trailing spaces), underlined.`)
  if (info.approximate) parts.push('Long values were compared by the part these results keep, so a difference past it does not show.')
  const others = [...info.leftOnly.map(name => `${name} (${leftName})`), ...info.rightOnly.map(name => `${name} (${rightName})`)]
  if (others.length > 0) parts.push(`Not compared: ${others.join(', ')}.`)
  parts.push('Filters and sorts on the inputs were not applied.')
  return parts.join(' ')
}

/** The whole strip as text (its tooltip, and what a screen reader reads): the inputs, a closed one so marked, then the details. */
export function compareText(info: CompareInfo, sources?: readonly CompareSource[], notice?: string): string {
  const names = sources?.length === 2 ? sources.map(source => source.entry === undefined ? `${source.name} (closed)` : source.name) : sideNames(info)
  return `${names[0]} → ${names[1]}, ${compareDetails(info, notice)}`
}
