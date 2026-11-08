import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { ResultSetEntry, ResultsService } from './ResultsService'
import { setKey } from './ResultsService'
import { formatCount } from './status'

/** What a diff set compared, for its grid's strip. */
export interface CompareInfo {
  /** The compared sets' places in the run. */
  readonly left: number
  readonly right: number
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
}
/** Each diff set's comparison, by its set key. */
export type CompareSnapshot = ReadonlyMap<string, CompareInfo>

const comparable = (entry: ResultSetEntry | undefined): entry is ResultSetEntry =>
  entry !== undefined && entry.descriptor.kind === 'rows' && entry.handle.getSnapshot().state === 'complete'
const names = (entry: ResultSetEntry) => new Set(entry.descriptor.columns.filter(column => column.role !== 'tone').map(column => column.name.toLowerCase()))

/**
 * Compare with Previous Result (results PR 8): a set against the run's set before it, in the backend (results.diff),
 * aligned by a key column both share or by whole rows, values equal by collation (or exactly). The diff is a new result
 * of the run, appended as its last set, which the grid shows unified like git: each change as its old row (−) and its new
 * one (+) with the differing cells marked, around them a row of unchanged context. It goes with the run's other results.
 * The diff's rows are aligned entries (ResultDiff.cs's DiffModel); a side-by-side view would render the same entries.
 */
export class CompareService extends SnapshotStore<CompareSnapshot> implements Disposable {
  private readonly results: Pick<ResultsService, 'getSnapshot' | 'addSet' | 'notify'>
  private readonly running = new Map<string, AbortController>()

  constructor(results: Pick<ResultsService, 'getSnapshot' | 'addSet' | 'notify'>) {
    super(new Map())
    this.results = results
  }

  /** The set a grid's set is compared with: the nearest set before it of rows, with every row and a column name in common. */
  previousOf(tabId: string, index: number): number | undefined {
    const tab = this.results.getSnapshot()[tabId]
    const right = tab?.sets[index]
    if (!tab || tab.status === 'running' || !comparable(right)) return undefined
    const columns = names(right)
    for (let left = index - 1; left >= 0; left--) {
      const entry = tab.sets[left]
      if (comparable(entry) && [...names(entry)].some(name => columns.has(name))) return left
    }
    return undefined
  }

  /** Whether a grid's set can be compared now: it has a previous set, and no comparison runs in its tab. */
  canCompare(tabId: string, index: number): boolean { return !this.running.has(tabId) && this.previousOf(tabId, index) !== undefined }

  /** Compares a grid's set with its previous set and appends the diff; a failure is said in the toolbar. */
  async compare(tabId: string, index: number, o: { exact?: boolean } = {}): Promise<void> {
    const left = this.previousOf(tabId, index)
    const tab = this.results.getSnapshot()[tabId]
    if (left === undefined || !tab || this.running.has(tabId)) return
    const from = tab.sets[left], to = tab.sets[index]
    const abort = new AbortController()
    this.running.set(tabId, abort)
    try {
      const result = await from.handle.diff(to.handle, { exact: o.exact ?? false, signal: abort.signal })
      if (abort.signal.aborted) return
      const label = `Differences: ${from.label ?? `Result ${left + 1}`} → ${to.label ?? `Result ${index + 1}`}`
      if (this.results.addSet(tabId, result.descriptor, label) === undefined) return
      const info: CompareInfo = {
        left, right: index, key: result.key, exact: o.exact ?? false, same: result.same, changed: result.changed, added: result.added, removed: result.removed,
        soft: result.soft, leftOnly: result.leftOnly, rightOnly: result.rightOnly
      }
      // Only diffs some run still shows are kept.
      const shown = new Set(Object.values(this.results.getSnapshot()).flatMap(run => run.sets.map(entry => setKey(entry.descriptor))))
      const next = new Map([...this.getSnapshot()].filter(([key]) => shown.has(key)))
      this.publish(next.set(setKey(result.descriptor), info))
    } catch (error) {
      if (!abort.signal.aborted) this.results.notify(tabId, error instanceof Error ? error.message : 'The results could not be compared.')
    } finally {
      if (this.running.get(tabId) === abort) this.running.delete(tabId)
    }
  }

  dispose(): void {
    for (const abort of this.running.values()) abort.abort()
    this.running.clear()
    this.clearListeners()
  }
}

const count = (value: number, one: string, many = one + 's') => `${formatCount(value)} ${value === 1 ? one : many}`

/** What a diff grid's strip says: what was compared and how, the counts, soft differences and the columns left out. */
export function compareText(info: CompareInfo): string {
  const by = info.key ? `rows matched by ${info.key}` : 'whole rows matched'
  const parts = [`Result ${info.left + 1} → Result ${info.right + 1}, ${by}${info.exact ? ', text compared exactly' : ''}: ${count(info.changed, 'changed row')}, ${count(info.added, 'added row')}, ${count(info.removed, 'removed row')}, ${formatCount(info.same)} unchanged.`]
  if (info.soft > 0) parts.push(`${count(info.soft, 'value differs', 'values differ')} only by collation (case or trailing spaces), underlined.`)
  const others = [...info.leftOnly.map(name => `${name} (Result ${info.left + 1})`), ...info.rightOnly.map(name => `${name} (Result ${info.right + 1})`)]
  if (others.length > 0) parts.push(`Not compared: ${others.join(', ')}.`)
  return parts.join(' ')
}
