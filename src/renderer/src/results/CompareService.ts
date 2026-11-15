import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { pairColumns, type ColumnPairing } from './compare-pairing'
import { DerivedJobs } from './derived-jobs'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import type { EntryKey, ResultSetEntry, ResultsService, SourceRef, TabResults } from './ResultsService'
import { comparedNames, entryOf, resultLimits, setKey, slotOf } from './ResultsService'
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
  /** The column whose values matched rows; undefined when whole rows did. */
  readonly key: string | undefined
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
export interface CompareSnapshot {
  /** Each diff set's comparison, by its set key. */
  readonly info: ReadonlyMap<string, CompareInfo>
  /** The open pickers (popovers), by tab. */
  readonly pickers: Readonly<Record<string, ComparePicker>>
  /** The comparisons running, by tab, each as `pairId(old, new, exact)`. */
  readonly running: Readonly<Record<string, readonly string[]>>
}
/** A Table the picker offers, with how its columns pair with the active Table's (the target as the old side). */
export interface CompareTarget { readonly entry: ResultSetEntry; readonly pairing: ColumnPairing }

const maxPairs = wire.page.maxColumns - 4

/** One comparison per pair of inputs and exact-text choice runs at a time: its identity. */
export const pairId = (old: EntryKey, neu: EntryKey, exact: boolean): string => `${old}|${neu}|${exact ? 'exact' : 'collation'}`

/** The refusal of a comparison a run has no room for (plan: Concurrency and limits, the 1,000 rule). */
export const compareFullText = `This query's results already hold ${formatCount(resultLimits.sets)} results, comparisons and pivots included, the most a run keeps. Close some results to compare these.`

/** A group's Table of rows that has every row: the only results a comparison reads (never a Pivot, a comparison, a plan set
 *  or a live result). */
export function comparableTable(tab: TabResults | undefined, entry: ResultSetEntry | undefined): entry is ResultSetEntry {
  return !!tab && entry !== undefined && entry.descriptor.kind === 'rows' && slotOf(tab, entry.key)?.view === 'table' && entry.handle.getSnapshot().state === 'complete'
}

/** What a tab's popover was last set to: per group (by number) the target's group and the way round, and exact text for all. */
interface Remembered { exact: boolean; readonly groups: Map<number, { readonly targetOrdinal: number; readonly swapped: boolean }> }

interface Running { readonly abort: AbortController; readonly queryId: string; readonly old: EntryKey; readonly neu: EntryKey; readonly id: string; cancelled?: boolean }

type Results = Pick<ResultsService, 'getSnapshot' | 'subscribe' | 'addSet' | 'notify' | 'focusEntry' | 'operations'>

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
  private readonly unsubscribe: () => void

  constructor(results: Results, o: { jobs?: DerivedJobs; adding?: (tabId: string) => number } = {}) {
    super({ info: new Map(), pickers: {}, running: {} })
    this.results = results
    this.jobs = o.jobs ?? new DerivedJobs()
    this.elsewhere = o.adding ?? (() => 0)
    this.unsubscribe = results.subscribe(() => this.sync())
  }

  /** Gives up comparisons whose run ended or whose input closed, and closes a popover whose Table is gone: the query ran
   *  again (or runs), its Table closed, or the tab's results went. A target that closed leaves it with nothing picked. */
  private sync(): void {
    const snapshot = this.results.getSnapshot()
    for (const [tabId, items] of this.inFlight) {
      const tab = snapshot[tabId]
      for (const item of items.values()) if (tab?.queryId !== item.queryId || !entryOf(tab.sets, item.old) || !entryOf(tab.sets, item.neu)) item.abort.abort()
    }
    for (const tabId of [...this.remembered.keys()]) if (!snapshot[tabId]) this.remembered.delete(tabId)
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

  /** The run's comparison of exactly these inputs and exact-text choice, if one is open. */
  existing(tabId: string, old: EntryKey, neu: EntryKey, exact: boolean): ResultSetEntry | undefined {
    const tab = this.results.getSnapshot()[tabId]
    const info = this.getSnapshot().info
    return tab?.comparisons.find(slot => { const item = info.get(setKey(slot.entry.descriptor)); return item?.left === old && item.right === neu && item.exact === exact })?.entry
  }
  /** Comparisons in flight for a tab's current run: results they will add, which Pivot builds count against its 1,000. An
   *  earlier run's comparison given up but not yet settled is not counted. */
  adding(tabId: string): number {
    const queryId = this.results.getSnapshot()[tabId]?.queryId
    return [...this.inFlight.get(tabId)?.values() ?? []].filter(item => item.queryId === queryId).length
  }

  isRunning(tabId: string, old: EntryKey, neu: EntryKey, exact: boolean): boolean { return this.inFlight.get(tabId)?.has(pairId(old, neu, exact)) ?? false }

  /** The popover's Compare: shows the comparison of its sides when the run has it, else starts it. Once the comparison is
   *  there, while the popover still shows that pair and holds the focus (`holdsFocus`, asked then), the popover closes and
   *  the comparison takes the focus. Closed meanwhile (Escape, Close, a press or key elsewhere) or moved to another pair,
   *  the comparison is only added, and the focus stays where the user put it; with the focus in another dialog (the
   *  palette) the popover stays, offering Show It, for that dialog to give the focus back to. A failure is said in the
   *  popover while it shows that pair, else in the toolbar. Returns the entry focused. */
  async run(tabId: string, o: { readonly holdsFocus?: () => boolean } = {}): Promise<EntryKey | undefined> {
    const picker = this.getSnapshot().pickers[tabId], sides = this.sidesOf(tabId)
    if (!picker || !sides) return undefined
    const shown = this.existing(tabId, sides.old.key, sides.neu.key, picker.exact)
    if (shown) { this.remember(tabId, picker); this.close(tabId); this.results.focusEntry(tabId, shown.key); return shown.key }
    this.choose(tabId, { error: undefined, cancelled: false })
    const outcome = await this.comparePair(tabId, sides.old.key, sides.neu.key, { exact: picker.exact, quiet: true })
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

  /** Cancels the comparison of these inputs, if it runs; the picker says so when it shows that pair. */
  cancel(tabId: string, old: EntryKey, neu: EntryKey, exact: boolean): void {
    const item = this.inFlight.get(tabId)?.get(pairId(old, neu, exact))
    if (!item) return
    item.cancelled = true
    item.abort.abort()
    if (this.shows(tabId, undefined, old, neu, exact)) this.update(tabId, { cancelled: true })
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
    if (from) await this.comparePair(tabId, from.key, key, { exact: o.exact ?? false })
  }

  /**
   * Compares two Tables of a run, `old` (−) with `neu` (+), and adds their diff as a comparison. Returns the comparison's
   * entry key; undefined when nothing was started (not two comparable Tables sharing a column, the same comparison already
   * running) or it was given up; or, with `quiet`, the sentence of a failure instead of saying it in the toolbar.
   */
  async comparePair(tabId: string, old: EntryKey, neu: EntryKey, o: { exact: boolean; quiet?: boolean }): Promise<{ readonly key: EntryKey } | { readonly error: string } | undefined> {
    const tab = this.results.getSnapshot()[tabId]
    const from = entryOf(tab?.sets, old), to = entryOf(tab?.sets, neu)
    if (!tab || !from || !to || !this.targetsOf(tabId, neu).some(target => target.entry.key === old)) return undefined
    const id = pairId(old, neu, o.exact)
    let items = this.inFlight.get(tabId)
    if (items?.has(id)) return undefined
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
    const item: Running = { abort, queryId: tab.queryId, old, neu, id }
    if (!items) this.inFlight.set(tabId, items = new Map())
    items.set(id, item)
    // A new attempt on the pair the popover shows clears what it said of the last (a failure, a cancel), as its Compare does.
    if (!o.quiet && this.shows(tabId, tab.queryId, old, neu, o.exact)) this.update(tabId, { error: undefined, cancelled: false })
    this.publishRunning()
    // The toolbar's strip shows it, with a Cancel of its own beside the popover's.
    const [fromName, toName] = comparedNames(from, to, this.results.getSnapshot()[tabId]?.sets ?? [])
    const ticket = this.results.operations.begin(tabId, { kind: 'compare', target: `${fromName} → ${toName}`, cancel: () => this.cancel(tabId, old, neu, o.exact) })
    let done = false
    try {
      const result = await this.jobs.run(() => from.handle.diff(to.handle, { exact: o.exact, signal: abort.signal, onProgress: (phase, percent) => ticket.progress(phase, percent) }), { signal: abort.signal })
      const label = `Differences: ${fromName} → ${toName}`
      // Only the run that holds both sets takes the diff; otherwise (a re-run, a closed tab) it is released, and the strip
      // says nothing was compared.
      const key = this.results.addSet(tabId, result.descriptor, label, [setKey(from.descriptor), setKey(to.descriptor)])
      if (key === undefined) return undefined
      done = true
      const info: CompareInfo = {
        left: from.key, right: to.key, leftNumber: from.number, rightNumber: to.number, leftName: fromName, rightName: toName, key: result.key, exact: o.exact, same: result.same, changed: result.changed, added: result.added, removed: result.removed,
        soft: result.soft, leftOnly: result.leftOnly, rightOnly: result.rightOnly, approximate: result.approximate
      }
      // Only diffs some run still shows are kept.
      const shown = new Set(Object.values(this.results.getSnapshot()).flatMap(run => run.sets.map(entry => setKey(entry.descriptor))))
      const next = new Map([...this.getSnapshot().info].filter(([setId]) => shown.has(setId)))
      this.publish({ ...this.getSnapshot(), info: next.set(setKey(result.descriptor), info) })
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

  private publishRunning(): void {
    const running: Record<string, readonly string[]> = {}
    for (const [tabId, items] of this.inFlight) if (items.size > 0) running[tabId] = [...items.keys()]
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
const sideNames = (info: CompareInfo): [string, string] => [info.leftName ?? `Result ${info.leftNumber}`, info.rightName ?? `Result ${info.rightNumber}`]

/** What a diff grid's strip says after its two inputs: how rows matched, the counts, soft differences, the columns left
 *  out, and that the inputs' filters and sorts were not applied. */
export function compareDetails(info: CompareInfo): string {
  const by = info.key ? `rows matched by ${info.key}` : 'whole rows matched'
  const [leftName, rightName] = sideNames(info)
  const parts = [`${by}${info.exact ? ', text compared exactly' : ''}: ${count(info.changed, 'changed row')}, ${count(info.added, 'added row')}, ${count(info.removed, 'removed row')}, ${formatCount(info.same)} unchanged.`]
  if (info.soft > 0) parts.push(`${count(info.soft, 'value differs', 'values differ')} only by collation (case or trailing spaces), underlined.`)
  if (info.approximate) parts.push('Long values were compared by the part these results keep, so a difference past it does not show.')
  const others = [...info.leftOnly.map(name => `${name} (${leftName})`), ...info.rightOnly.map(name => `${name} (${rightName})`)]
  if (others.length > 0) parts.push(`Not compared: ${others.join(', ')}.`)
  parts.push('Filters and sorts on the inputs were not applied.')
  return parts.join(' ')
}

/** The whole strip as text (its tooltip, and what a screen reader reads): the inputs, a closed one so marked, then the details. */
export function compareText(info: CompareInfo, sources?: readonly CompareSource[]): string {
  const names = sources?.length === 2 ? sources.map(source => source.entry === undefined ? `${source.name} (closed)` : source.name) : sideNames(info)
  return `${names[0]} → ${names[1]}, ${compareDetails(info)}`
}
