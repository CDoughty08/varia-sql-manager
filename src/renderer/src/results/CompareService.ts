import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { EntryKey, ResultSetEntry, ResultsService } from './ResultsService'
import { entryName, entryOf, setKey } from './ResultsService'
import { formatCount } from './status'

/** What a diff set compared, for its grid's strip. */
export interface CompareInfo {
  /** The compared entries' keys. */
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
/** Each diff set's comparison, by its set key. */
export type CompareSnapshot = ReadonlyMap<string, CompareInfo>

const comparable = (entry: ResultSetEntry | undefined): entry is ResultSetEntry =>
  entry !== undefined && entry.descriptor.kind === 'rows' && entry.handle.getSnapshot().state === 'complete'
/** The columns a diff can pair: visible ones, by name and whether they hold text or binary (ResultDiffer.Pairs). */
const names = (entry: ResultSetEntry) => new Set(entry.descriptor.columns.filter(column => column.role !== 'tone').map(column => column.wire + ':' + column.name.toLowerCase()))

/**
 * Compare with Previous Result (results PR 8): a set against the run's set before it, in the backend (results.diff),
 * aligned by a key column both share or by whole rows, values equal by collation (or exactly). The diff is a new result
 * of the run, appended as its last set, which the grid shows unified like git: each change as its old row (−) and its new
 * one (+) with the differing cells marked, around them a row of unchanged context. It goes with the run's other results.
 * The diff's rows are aligned entries (ResultDiff.cs's DiffModel); a side-by-side view would render the same entries.
 */
export class CompareService extends SnapshotStore<CompareSnapshot> implements Disposable {
  private readonly results: Pick<ResultsService, 'getSnapshot' | 'subscribe' | 'addSet' | 'notify'>
  /** Comparisons in flight by tab, with the run and the two entries they compare: a newer run (or none), or either entry
   *  closed, gives them up. */
  private readonly running = new Map<string, { readonly abort: AbortController; readonly queryId: string; readonly left: EntryKey; readonly right: EntryKey }>()
  private readonly unsubscribe: () => void

  constructor(results: Pick<ResultsService, 'getSnapshot' | 'subscribe' | 'addSet' | 'notify'>) {
    super(new Map())
    this.results = results
    this.unsubscribe = results.subscribe(() => {
      if (this.running.size === 0) return
      const snapshot = this.results.getSnapshot()
      for (const [tabId, item] of this.running) {
        const tab = snapshot[tabId]
        if (tab?.queryId !== item.queryId || !entryOf(tab.sets, item.left) || !entryOf(tab.sets, item.right)) item.abort.abort()
      }
    })
  }

  /** The set a grid's set is compared with: the nearest set before it of rows, with every row and a column name in common. */
  previousOf(tabId: string, key: EntryKey): ResultSetEntry | undefined {
    const tab = this.results.getSnapshot()[tabId]
    const right = entryOf(tab?.sets, key)
    if (!tab || tab.status === 'running' || !comparable(right)) return undefined
    const columns = names(right)
    // Back from where it is listed, to the first that fits.
    for (let place = tab.sets.indexOf(right) - 1; place >= 0; place--) {
      const entry = tab.sets[place]
      if (comparable(entry) && [...names(entry)].some(name => columns.has(name))) return entry
    }
    return undefined
  }

  /** Whether a grid's set can be compared now: it has a previous set, and no comparison runs in its tab. */
  canCompare(tabId: string, key: EntryKey): boolean { return !this.running.has(tabId) && this.previousOf(tabId, key) !== undefined }

  /** Compares a grid's set with its previous set and appends the diff; a failure is said in the toolbar. */
  async compare(tabId: string, key: EntryKey, o: { exact?: boolean } = {}): Promise<void> {
    const from = this.previousOf(tabId, key)
    const tab = this.results.getSnapshot()[tabId], to = entryOf(tab?.sets, key)
    if (!from || !tab || !to || this.running.has(tabId)) return
    const abort = new AbortController()
    const item = { abort, queryId: tab.queryId, left: from.key, right: to.key }
    this.running.set(tabId, item)
    try {
      const result = await from.handle.diff(to.handle, { exact: o.exact ?? false, signal: abort.signal })
      const label = `Differences: ${entryName(from)} → ${entryName(to)}`
      // Only the run that holds both sets takes the diff; otherwise (a re-run, a closed tab) it is released.
      if (this.results.addSet(tabId, result.descriptor, label, [setKey(from.descriptor), setKey(to.descriptor)]) === undefined) return
      const info: CompareInfo = {
        left: from.key, right: to.key, leftNumber: from.number, rightNumber: to.number, key: result.key, exact: o.exact ?? false, same: result.same, changed: result.changed, added: result.added, removed: result.removed,
        soft: result.soft, leftOnly: result.leftOnly, rightOnly: result.rightOnly, approximate: result.approximate
      }
      // Only diffs some run still shows are kept.
      const shown = new Set(Object.values(this.results.getSnapshot()).flatMap(run => run.sets.map(entry => setKey(entry.descriptor))))
      const next = new Map([...this.getSnapshot()].filter(([key]) => shown.has(key)))
      this.publish(next.set(setKey(result.descriptor), info))
    } catch (error) {
      if (!abort.signal.aborted) this.results.notify(tabId, error instanceof Error ? error.message : 'The results could not be compared.')
    } finally {
      if (this.running.get(tabId) === item) this.running.delete(tabId)
    }
  }

  dispose(): void {
    this.unsubscribe()
    for (const item of this.running.values()) item.abort.abort()
    this.running.clear()
    this.clearListeners()
  }
}

const count = (value: number, one: string, many = one + 's') => `${formatCount(value)} ${value === 1 ? one : many}`

/** What a diff grid's strip says: what was compared and how, the counts, soft differences and the columns left out. */
export function compareText(info: CompareInfo): string {
  const by = info.key ? `rows matched by ${info.key}` : 'whole rows matched'
  const { leftNumber, rightNumber } = info
  const parts = [`Result ${leftNumber} → Result ${rightNumber}, ${by}${info.exact ? ', text compared exactly' : ''}: ${count(info.changed, 'changed row')}, ${count(info.added, 'added row')}, ${count(info.removed, 'removed row')}, ${formatCount(info.same)} unchanged.`]
  if (info.soft > 0) parts.push(`${count(info.soft, 'value differs', 'values differ')} only by collation (case or trailing spaces), underlined.`)
  if (info.approximate) parts.push('Long values were compared by the part these results keep, so a difference past it does not show.')
  const others = [...info.leftOnly.map(name => `${name} (Result ${leftNumber})`), ...info.rightOnly.map(name => `${name} (Result ${rightNumber})`)]
  if (others.length > 0) parts.push(`Not compared: ${others.join(', ')}.`)
  return parts.join(' ')
}
