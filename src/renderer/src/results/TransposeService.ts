import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { resolveBlocks } from '../grid/selection'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import type { ResultSetEntry, ResultsService } from './ResultsService'
import { resultLimits, setKey } from './ResultsService'
import { formatCount, plural } from './status'

/** What a transpose set holds, for its grid's strip. */
export interface TransposeInfo {
  readonly source: number
  readonly sourceLabel: string
  /** It read the grid's view: the rows as its sort and filters show them. */
  readonly viewed: boolean
  /** It took only the selected rows. */
  readonly selected: boolean
  /** The rows it could take, the first of them it took (its columns past "Column"), and the source columns (its rows). */
  readonly rows: number
  readonly transposed: number
  readonly columns: number
  /** The column whose values name its columns. */
  readonly header?: string
}
/** Each transpose set's strip, by its set key. */
export type TransposeSnapshot = ReadonlyMap<string, TransposeInfo>

type Results = Pick<ResultsService, 'getSnapshot' | 'subscribe' | 'addSet' | 'notify' | 'sortOf' | 'selection'>

/** A set a transpose can read: a query's rows, a pivot or another transpose, all loaded. Never a diff or a plan. */
export const transposable = (entry: ResultSetEntry | undefined): entry is ResultSetEntry =>
  entry !== undefined && (entry.descriptor.kind === 'rows' || entry.descriptor.kind === 'pivot' || entry.descriptor.kind === 'transpose') && entry.handle.getSnapshot().state === 'complete'

/** Options of one transpose: only the grid's selected rows, and the column (of the active cell) naming the columns. */
export interface TransposeOptions { readonly selected?: boolean; readonly header?: number }

/**
 * Transpose: a grid's columns as rows and its rows (as its sort and filters show them, or only the selected ones) as
 * columns, in the backend (results.transpose). The transpose is a new result of the run, appended as its last set
 * ("Transpose of Result N") and released with the run's others, so its grid searches, profiles, highlights, sorts,
 * filters, copies and saves as any other. Rows never come to the renderer to be transposed.
 */
export class TransposeService extends SnapshotStore<TransposeSnapshot> implements Disposable {
  private readonly results: Results
  /** Transposes in flight by tab, with the run they read: a newer run (or none) gives them up. */
  private readonly running = new Map<string, { readonly abort: AbortController; readonly queryId: string }>()
  private readonly unsubscribe: () => void

  constructor(results: Results) {
    super(new Map())
    this.results = results
    this.unsubscribe = results.subscribe(() => this.sync())
  }

  /** Whether a grid's set can be transposed now: its run has ended, its rows have all loaded, its grid's sort or filter is
   *  built (the transpose reads the rows the grid shows), and no transpose runs in its tab. */
  canTranspose(tabId: string, index: number): boolean {
    const tab = this.results.getSnapshot()[tabId]
    const sort = this.results.sortOf(tabId, index)
    return !!tab && tab.status !== 'running' && tab.status !== 'closed' && !this.running.has(tabId) && transposable(tab.sets[index])
      && !(sort && (sort.sorting || sort.stale || !sort.view))
  }

  /** The grid's selected rows as [first, count] position ranges (merged, at most 256), or undefined without any. */
  selectedRows(tabId: string, index: number): [number, number][] | undefined {
    const entry = this.results.getSnapshot()[tabId]?.sets[index]
    const selection = entry && this.results.selection(tabId, index)
    if (!entry || !selection) return undefined
    const sort = this.results.sortOf(tabId, index)
    const rows = (sort?.view ?? entry.handle).getSnapshot().rowsAvailable
    const spans = resolveBlocks(selection, rows, entry.descriptor.columns.length).map(block => [block.top, block.bottom] as [number, number]).sort((a, b) => a[0] - b[0])
    const merged: [number, number][] = []
    for (const [top, bottom] of spans) {
      const last = merged.at(-1)
      if (last && top <= last[1] + 1) last[1] = Math.max(last[1], bottom)
      else merged.push([top, bottom])
    }
    return merged.length > 0 && merged.length <= wire.transpose.maxRanges ? merged.map(([top, bottom]) => [top, bottom - top + 1]) : undefined
  }

  /** The column of the grid's active cell, which Transpose Using Column as Headers names the columns by. */
  activeColumn(tabId: string, index: number): number | undefined {
    const entry = this.results.getSnapshot()[tabId]?.sets[index]
    const column = entry && this.results.selection(tabId, index)?.active.column
    return entry && column !== undefined && column >= 0 && column < entry.descriptor.columns.length && entry.descriptor.columns[column].role !== 'tone' ? column : undefined
  }

  /** Transposes a grid's set and appends the transpose to the run; a failure is said in the toolbar. */
  async transpose(tabId: string, index: number, o: TransposeOptions = {}): Promise<void> {
    const tab = this.results.getSnapshot()[tabId]
    if (!tab || !this.canTranspose(tabId, index)) return
    const entry = tab.sets[index]
    const rows = o.selected ? this.selectedRows(tabId, index) : undefined
    if (o.selected && !rows) return
    const sort = this.results.sortOf(tabId, index)
    // The grid's view when it shows one: the transpose reads its rows as the grid shows them.
    const handle = sort?.view ?? entry.handle
    const abort = new AbortController()
    const item = { abort, queryId: tab.queryId }
    this.running.set(tabId, item)
    try {
      const result = await handle.transpose({ ...(rows ? { rows } : {}), ...(o.header === undefined ? {} : { headerColumn: o.header }) }, { signal: abort.signal })
      const sourceLabel = entry.label ?? `Result ${entry.index + 1}`
      // Only the run that holds the set takes the transpose; otherwise (a re-run, a closed tab) it is released.
      if (this.results.addSet(tabId, result.descriptor, `Transpose of ${sourceLabel}`, [setKey(entry.descriptor)]) === undefined) {
        const now = this.results.getSnapshot()[tabId]
        if (now?.queryId === tab.queryId && now.sets.length >= resultLimits.sets)
          this.results.notify(tabId, `These results already show ${resultLimits.sets.toLocaleString('en-US')} sets, so the transpose was not added. Close Results or run the query again.`)
        return
      }
      const info: TransposeInfo = {
        source: entry.index, sourceLabel, viewed: !!sort?.view, selected: !!rows, rows: result.rows, transposed: result.transposed, columns: result.columns,
        ...(o.header === undefined ? {} : { header: entry.descriptor.columns[o.header]?.name })
      }
      this.publish(new Map([...this.shown(this.getSnapshot()), [setKey(result.descriptor), info]]))
    } catch (error) {
      if (!abort.signal.aborted) this.results.notify(tabId, error instanceof Error ? error.message : 'The results could not be transposed.')
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

  /** Only transposes some run still shows keep their strips. */
  private shown(info: TransposeSnapshot): Map<string, TransposeInfo> {
    const shown = new Set(Object.values(this.results.getSnapshot()).flatMap(run => run.sets.map(entry => setKey(entry.descriptor))))
    return new Map([...info].filter(([key]) => shown.has(key)))
  }

  /** A new run (or a closed tab) gives up its tab's running transpose; strips of sets no run shows go. */
  private sync(): void {
    const snapshot = this.results.getSnapshot()
    for (const [tabId, item] of this.running) if (snapshot[tabId]?.queryId !== item.queryId) item.abort.abort()
    const current = this.getSnapshot()
    if (current.size === 0) return
    const kept = this.shown(current)
    if (kept.size !== current.size) this.publish(kept)
  }
}

/** The strip: what was transposed and its shape, or, when it took the first rows only, which and how to see the rest. */
export function transposeText(info: TransposeInfo): string {
  if (info.transposed < info.rows)
    return `Transposed the first ${formatCount(info.transposed)} of ${formatCount(info.rows)} rows; filter or select rows to transpose others.`
  const rows = `${formatCount(info.transposed)} ${info.selected ? 'selected ' : ''}${plural(info.transposed, 'row')}`
  const named = info.header ? `, named by ${info.header}` : ''
  return `Transpose of ${info.sourceLabel}${info.viewed ? ' (as sorted and filtered)' : ''}: ${formatCount(info.columns)} ${plural(info.columns, 'column')} as rows, ${rows} as columns${named}.`
}

/** The strip with the grid's highlight note after it. */
export function transposeStrip(info: TransposeInfo, highlight: string | undefined): string {
  return highlight ? `${transposeText(info)} ${highlight}` : transposeText(info)
}
