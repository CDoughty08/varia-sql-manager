import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { pairColumns, type ColumnPairing } from './compare-pairing'
import { DerivedWork } from './derived-work'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import type { EntryKey, ResultSetEntry, ResultsService, SourceRef, TabResults } from './ResultsService'
import { entryName, entryOf, resultLimits, setKey, slotOf } from './ResultsService'
import { formatCount } from './status'

/** What a diff set compared, for its grid's strip. */
export interface CompareInfo {
  /** The compared entries' keys: the old side (−), then the new side (+). */
  readonly left: EntryKey
  readonly right: EntryKey
  /** The numbers the compared results are named by ("Result 3"). */
  readonly leftNumber: number
  readonly rightNumber: number
  /** The column whose values matched rows, or null when whole rows did. */
  readonly key: string | null
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
/**
 * The Compare picker of one query tab, opened on a group's Table (`active`, the new side unless `swapped`), with the Table
 * picked to compare it with (`target`), whether text compares exactly, and why the last comparison it started failed.
 */
export interface ComparePicker {
  readonly queryId: string
  readonly active: EntryKey
  readonly target?: EntryKey
  readonly swapped: boolean
  readonly exact: boolean
  readonly error?: string
}
export interface CompareSnapshot {
  /** Each diff set's comparison, by its set key. */
  readonly info: ReadonlyMap<string, CompareInfo>
  /** The open pickers, by tab. */
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

interface Running { readonly abort: AbortController; readonly queryId: string; readonly old: EntryKey; readonly neu: EntryKey; readonly id: string }

type Results = Pick<ResultsService, 'getSnapshot' | 'subscribe' | 'addSet' | 'notify' | 'focusEntry' | 'focusStamp'>

/**
 * Comparisons (results.diff): one group's Table against another's of the same run, in the backend, aligned by a key column
 * both share or by whole rows, values equal by collation (or exactly). The diff is a comparison of the run, after its
 * groups, which the grid shows unified like git: each change as its old row (−) and its new one (+) with the differing
 * cells marked, around them a row of unchanged context. It copied its cells, so it outlives its inputs.
 *
 * Compare… opens a picker (`open`) on a Table: the Table is the new side and the one picked the old, which the picker can
 * swap. Compare with Previous Result compares a Table with the nearest earlier one at once. Both start through
 * `comparePair`: one comparison per pair and exact-text choice at a time (asking again while it runs does nothing), at most
 * `derivedLimits.parallel` at once per window (`DerivedWork`, which retries a busy refusal), and none that would take the
 * run past `resultLimits.sets` results counting those in flight. Each is given up when its run ends or either input closes.
 */
export class CompareService extends SnapshotStore<CompareSnapshot> implements Disposable {
  private readonly results: Results
  private readonly work: DerivedWork
  /** Comparisons in flight by tab. */
  private readonly inFlight = new Map<string, Map<string, Running>>()
  private readonly unsubscribe: () => void

  constructor(results: Results, o: { work?: DerivedWork } = {}) {
    super({ info: new Map(), pickers: {}, running: {} })
    this.results = results
    this.work = o.work ?? new DerivedWork()
    this.unsubscribe = results.subscribe(() => this.sync())
  }

  /** Gives up comparisons whose run ended or whose input closed, and closes pickers whose Table went or whose run changed. */
  private sync(): void {
    const snapshot = this.results.getSnapshot()
    for (const [tabId, items] of this.inFlight) {
      const tab = snapshot[tabId]
      for (const item of items.values()) if (tab?.queryId !== item.queryId || !entryOf(tab.sets, item.old) || !entryOf(tab.sets, item.neu)) item.abort.abort()
    }
    const pickers = this.getSnapshot().pickers
    let next: Record<string, ComparePicker> | undefined
    for (const [tabId, picker] of Object.entries(pickers)) {
      const tab = snapshot[tabId]
      if (tab?.queryId === picker.queryId && tab.status !== 'running' && tab.status !== 'closed' && entryOf(tab.sets, picker.active)) continue
      next ??= { ...pickers }
      delete next[tabId]
    }
    if (next) this.publish({ ...this.getSnapshot(), pickers: next })
  }

  /** The Tables a Table can be compared with: the other groups' Tables of its run and backend generation that have every
   *  row and share at least one column with it, in the order drawn. None while the query runs or in a bare run (Peek). */
  targetsOf(tabId: string, key: EntryKey, o: { first?: boolean } = {}): readonly CompareTarget[] {
    const tab = this.results.getSnapshot()[tabId]
    const active = entryOf(tab?.sets, key)
    if (!tab || tab.bare || tab.status === 'running' || tab.status === 'closed' || !comparableTable(tab, active)) return []
    const targets: CompareTarget[] = []
    for (const group of tab.groups) {
      const entry = group.table.entry
      if (entry.key === key || entry.descriptor.generation !== active.descriptor.generation || !comparableTable(tab, entry)) continue
      const pairing = pairColumns(entry.descriptor.columns, active.descriptor.columns)
      // At least one shared column, and no more than a diff can show (ResultDiffer.MaxPairs: a page's columns less the
      // marker, two row numbers and the tone).
      if (pairing.pairs.length === 0 || pairing.pairs.length > maxPairs) continue
      targets.push({ entry, pairing })
      // A menu's or the toolbar's question (is there any?) stops at the first.
      if (o.first) break
    }
    return targets
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

  /** Opens the picker on a Table, picking its previous Table (else the first offered) and keeping the exact-text choice of a
   *  picker already open in the tab. */
  open(tabId: string, key: EntryKey): void {
    const tab = this.results.getSnapshot()[tabId]
    if (!tab || !this.canPick(tabId, key)) return
    const before = this.getSnapshot().pickers[tabId]
    const target = this.previousOf(tabId, key)?.key ?? this.targetsOf(tabId, key)[0]?.entry.key
    this.setPicker(tabId, { queryId: tab.queryId, active: key, ...target === undefined ? {} : { target }, swapped: false, exact: before?.exact ?? false })
  }
  close(tabId: string): void {
    const pickers = this.getSnapshot().pickers
    if (!pickers[tabId]) return
    const next = { ...pickers }
    delete next[tabId]
    this.publish({ ...this.getSnapshot(), pickers: next })
  }
  pick(tabId: string, target: EntryKey): void { this.update(tabId, { target, error: undefined }) }
  swap(tabId: string): void { const picker = this.getSnapshot().pickers[tabId]; if (picker) this.update(tabId, { swapped: !picker.swapped, error: undefined }) }
  setExact(tabId: string, exact: boolean): void { this.update(tabId, { exact, error: undefined }) }

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
  isRunning(tabId: string, old: EntryKey, neu: EntryKey, exact: boolean): boolean { return this.inFlight.get(tabId)?.has(pairId(old, neu, exact)) ?? false }

  /** The picker's Compare: shows the comparison of its sides when the run has it, else starts it; on success the picker
   *  closes (when it still shows that pair) and the comparison takes the focus (when the user has not moved it meanwhile). */
  async run(tabId: string): Promise<void> {
    const picker = this.getSnapshot().pickers[tabId], sides = this.sidesOf(tabId)
    if (!picker || !sides) return
    const shown = this.existing(tabId, sides.old.key, sides.neu.key, picker.exact)
    if (shown) { this.close(tabId); this.results.focusEntry(tabId, shown.key); return }
    const stamp = this.results.focusStamp(tabId)
    const outcome = await this.comparePair(tabId, sides.old.key, sides.neu.key, { exact: picker.exact, quiet: true })
    const now = this.getSnapshot().pickers[tabId]
    const same = now?.queryId === picker.queryId && this.sidesOf(tabId)?.old.key === sides.old.key && this.sidesOf(tabId)?.neu.key === sides.neu.key && now.exact === picker.exact
    if (outcome && 'error' in outcome) {
      // A failure is said where it was asked for: in the picker while it still shows that pair, else in the toolbar.
      if (same) this.update(tabId, { error: outcome.error })
      else this.results.notify(tabId, outcome.error)
      return
    }
    if (outcome === undefined) return
    if (same) this.close(tabId)
    if (this.results.focusStamp(tabId) === stamp) this.results.focusEntry(tabId, outcome.key)
  }

  /** Cancels the comparison of these inputs, if it runs. */
  cancel(tabId: string, old: EntryKey, neu: EntryKey, exact: boolean): void { this.inFlight.get(tabId)?.get(pairId(old, neu, exact))?.abort.abort() }

  /** Compare with Previous Result: a grid's set against its previous Table; a failure is said in the toolbar. */
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
    const fail = (text: string) => { if (o.quiet) return { error: text }; this.results.notify(tabId, text); return undefined }
    // A run keeps at most resultLimits.sets results, derived ones included: one that would pass it, counting those in
    // flight, is refused before the backend is asked.
    if (tab.sets.length + (items?.size ?? 0) >= resultLimits.sets) return fail(compareFullText)
    const abort = new AbortController()
    const item: Running = { abort, queryId: tab.queryId, old, neu, id }
    if (!items) this.inFlight.set(tabId, items = new Map())
    items.set(id, item)
    this.publishRunning()
    try {
      const result = await this.work.run(signal => from.handle.diff(to.handle, { exact: o.exact, signal }), abort.signal)
      const label = `Differences: ${entryName(from)} → ${entryName(to)}`
      // Only the run that holds both sets takes the diff; otherwise (a re-run, a closed tab) it is released.
      const key = this.results.addSet(tabId, result.descriptor, label, [setKey(from.descriptor), setKey(to.descriptor)])
      if (key === undefined) return undefined
      const info: CompareInfo = {
        left: from.key, right: to.key, leftNumber: from.number, rightNumber: to.number, key: result.key, exact: o.exact, same: result.same, changed: result.changed, added: result.added, removed: result.removed,
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
  private setPicker(tabId: string, picker: ComparePicker): void { this.publish({ ...this.getSnapshot(), pickers: { ...this.getSnapshot().pickers, [tabId]: picker } }) }
  private update(tabId: string, change: Partial<ComparePicker>): void {
    const picker = this.getSnapshot().pickers[tabId]
    if (!picker) return
    const next = { ...picker, ...change }
    if (next.error === undefined) delete (next as { error?: string }).error
    this.setPicker(tabId, next)
  }

  dispose(): void {
    this.unsubscribe()
    for (const items of this.inFlight.values()) for (const item of items.values()) item.abort.abort()
    this.inFlight.clear()
    this.clearListeners()
  }
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

/** What a diff grid's strip says after its two inputs: how rows matched, the counts, soft differences, the columns left
 *  out, and that the inputs' filters and sorts were not applied. */
export function compareDetails(info: CompareInfo): string {
  const by = info.key ? `rows matched by ${info.key}` : 'whole rows matched'
  const { leftNumber, rightNumber } = info
  const parts = [`${by}${info.exact ? ', text compared exactly' : ''}: ${count(info.changed, 'changed row')}, ${count(info.added, 'added row')}, ${count(info.removed, 'removed row')}, ${formatCount(info.same)} unchanged.`]
  if (info.soft > 0) parts.push(`${count(info.soft, 'value differs', 'values differ')} only by collation (case or trailing spaces), underlined.`)
  if (info.approximate) parts.push('Long values were compared by the part these results keep, so a difference past it does not show.')
  const others = [...info.leftOnly.map(name => `${name} (Result ${leftNumber})`), ...info.rightOnly.map(name => `${name} (Result ${rightNumber})`)]
  if (others.length > 0) parts.push(`Not compared: ${others.join(', ')}.`)
  parts.push('Filters and sorts on the inputs were not applied.')
  return parts.join(' ')
}

/** The whole strip as text (its tooltip, and what a screen reader reads): the inputs, a closed one so marked, then the details. */
export function compareText(info: CompareInfo, sources?: readonly CompareSource[]): string {
  const names = sources?.length === 2 ? sources.map(source => source.entry === undefined ? `${source.name} (closed)` : source.name) : [`Result ${info.leftNumber}`, `Result ${info.rightNumber}`]
  return `${names[0]} → ${names[1]}, ${compareDetails(info)}`
}
