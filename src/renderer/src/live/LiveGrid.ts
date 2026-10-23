// A live table in a grid (docs/ipc.md, Live subscriptions, LiveGrid): GridView over the result a LiveService view's
// table holds now. A snapshot table's next revision swaps in place and keeps the user's rows (the active cell, each
// block and the first row shown follow their keys, which the backend tracks for the grid); a row that left the source
// stays one revision, muted. An append table grows in place and follows its tail while the view is at the end; when the
// user scrolls up, the rows that arrive since are counted for a "n new rows" button. A roll or restart swaps to the new
// segment. Copy and Save read the revision the grid shows; the backend leases it, so a retire mid-copy loses nothing.
import type { ApiResult, ResultsFormat, ResultsJobResult, SavedResults, VariaApi } from '../../../shared/contracts'
import { limits } from '../../../shared/ipc/wire/protocol'
import { liveProbes, type LiveProbeId, type LiveTableSpec } from '../../../shared/live/catalog'
import type { LiveSort } from '../../../shared/live/schema'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable } from '../core/types'
import type { GridViewport } from '../grid/GridView'
import { copyPlan, type GridSelection } from '../grid/selection'
import type { RowMap } from '../grid/swap'
import type { ResultHandle, RowWindow } from '../results/ResultClient'
import { FLAG_CAPPED, FLAG_ERROR, FLAG_NULL } from '../results/worker-protocol'
import type { LiveHandle, LiveTable } from './LiveService'

/** The parts of GridView a LiveGrid drives (tests use a stand-in). */
export interface LiveGridView extends Disposable {
  swap(handle: ResultHandle, descriptor: LiveTable['descriptor'], mapRow: RowMap, o?: { readonly muted?: readonly number[]; readonly top?: number }): void
  prepare(handle: ResultHandle, firstRow: number, signal?: AbortSignal): Promise<void>
  revealEnd(): void
  currentSelection(): GridSelection | undefined
  lastViewport(): GridViewport | undefined
}
/** What the grid tells its LiveGrid; the shell passes these to GridView's options. */
export interface LiveGridHooks {
  onViewport(viewport: GridViewport): void
  onSelection(selection: GridSelection): void
}
export interface LiveGridSnapshot {
  /** The table the grid shows: undefined until the view's first sample of it. */
  readonly table?: LiveTable
  /** An append table: rows that arrived since the view left its last row; 0 while it follows the tail. */
  readonly newRows: number
  readonly following: boolean
  /** The sort the grid asked for (sortBy), by catalogue column id. */
  readonly sort?: readonly LiveSort[]
}
export interface LiveGridOptions {
  readonly live: Pick<LiveHandle, 'table' | 'onTick' | 'track' | 'setProbe'>
  readonly probe: LiveProbeId
  /** The table's index in the probe's catalogue entry (0 by default). */
  readonly table?: number
  /** The table's catalogue entry; the shipped catalogue's by default. */
  readonly spec?: LiveTableSpec
  /** Builds the grid once the table's first result is there (a GridView over the shell's root in the app). */
  createView(table: LiveTable, hooks: LiveGridHooks): LiveGridView
  readonly api?: Pick<VariaApi, 'copyResults' | 'saveResults'>
  readonly newId?: () => string
  readonly timers?: Timers
}

/** A snapshot revision waits at most this long for its first rows to be read before it swaps in anyway. */
export const prepareMs = 250

const unitSeparator = '\u001f'

/**
 * Where each row of the shown revision went, from the rows whose keys the grid knew and where the backend says the
 * tracked keys are now (`tracked.keys[i]` is at `tracked.rows[i]`, −1 when gone). A row whose key the grid did not know,
 * or did not send yet, keeps its index: the grid cannot tell where it went.
 */
export function trackedRowMap(known: ReadonlyMap<number, string>, tracked: LiveTable['tracked']): RowMap {
  if (!tracked?.keys || tracked.keys.length !== tracked.rows.length) return row => row
  const moved = new Map<string, number>()
  tracked.keys.forEach((key, index) => moved.set(key, tracked.rows[index]))
  return row => {
    const key = known.get(row)
    if (key === undefined) return row
    return moved.get(key) ?? row
  }
}
/** The rows a grid follows across revisions: the active row and its neighbours (where the selection goes when the active
 *  row leaves), the first row shown, then each block's anchor and focus rows, each once, at most limits.live.trackedKeys. */
export function wantedRows(selection: GridSelection | undefined, viewport: GridViewport | undefined): number[] {
  const rows = new Set<number>()
  if (selection) for (const row of [selection.active.row, selection.active.row + 1, selection.active.row - 1]) rows.add(row)
  if (viewport && viewport.rows > 0) rows.add(viewport.firstRow)
  for (const block of selection?.blocks ?? []) {
    if (block.kind === 'columns' || block.kind === 'all') continue
    rows.add(block.anchor.row)
    rows.add(block.focus.row)
  }
  return [...rows].filter(row => row >= 0 && (!viewport || row < viewport.rows)).slice(0, limits.live.trackedKeys)
}
/** A row's key as the backend builds it: the key columns' stored texts (NULL as empty) joined with U+001F; undefined when
 *  a cell could not be read or was cut. `columns` are the key columns' indexes; the window holds [colStart, colEnd). */
export function keyOfRow(window: RowWindow, row: number, columns: readonly number[]): string | undefined {
  if (row < window.first || row >= window.first + window.count) return undefined
  const width = window.colEnd - window.colStart, texts: string[] = []
  for (const column of columns) {
    const index = (row - window.first) * width + column - window.colStart
    const flags = window.flags[index]
    if (flags & (FLAG_ERROR | FLAG_CAPPED)) return undefined
    texts.push(flags & FLAG_NULL ? '' : window.text[index])
  }
  const key = texts.join(unitSeparator)
  return key.length <= limits.live.keyCharacters ? key : undefined
}
/** Groups sorted rows into reads of at most `span` rows each. */
export function readSpans(rows: readonly number[], span: number): { first: number; count: number }[] {
  const sorted = [...new Set(rows)].sort((a, b) => a - b), spans: { first: number; count: number }[] = []
  for (const row of sorted) {
    const last = spans.at(-1)
    if (last && row - last.first < span) last.count = row - last.first + 1
    else spans.push({ first: row, count: 1 })
  }
  return spans
}

export class LiveGrid extends SnapshotStore<LiveGridSnapshot> implements Disposable {
  private readonly o: LiveGridOptions
  private readonly index: number
  private readonly spec: LiveTableSpec
  private readonly keyColumns: number[]
  private view: LiveGridView | undefined
  private table: LiveTable | undefined
  /** Row → key, for rows of the shown revision whose keys are known (read, or placed there by tracking). */
  private known = new Map<number, string>()
  /** Bumps on every swap: reads of an older revision's keys are dropped. */
  private revision = 0
  private sent: readonly string[] = []
  private reading = false
  private again = false
  private queued = false
  private following = true
  /** The rows there were when the view left its last row. */
  private seenRows = 0
  private sort: readonly LiveSort[] | undefined
  /** A snapshot revision whose first rows are being read before it swaps in. */
  private pending: { readonly table: LiveTable; readonly abort: AbortController; timer: unknown } | undefined
  private readonly timers: Timers
  private readonly stopTick: Disposable
  private disposed = false

  constructor(o: LiveGridOptions) {
    super({ newRows: 0, following: true })
    this.o = o
    this.index = o.table ?? 0
    this.timers = o.timers ?? browserTimers
    const spec = o.spec ?? liveProbes[o.probe]?.tables?.[this.index]
    if (!spec) throw new Error('The probe has no such table.')
    this.spec = spec
    this.keyColumns = spec.mode === 'snapshot' ? spec.key.map(id => spec.columns.findIndex(column => column.id === id)) : []
    // After each applied tick, before it is acknowledged: the grid shows the newest revision when the next one is written.
    this.stopTick = o.live.onTick(() => { try { this.sync() } catch (error) { onUnexpectedError(error) } })
    this.sync()
  }

  /** The table the grid shows, if any. */
  get shown(): LiveTable | undefined { return this.table }

  /** Scrolls to the last row; follow tail goes on from there. */
  jumpToEnd(): void {
    this.view?.revealEnd()
  }

  /**
   * Sorts a snapshot table by a shown column (its index) or a catalogue column id; `undefined` goes back to the source's
   * order. The backend sorts, and its next revision arrives sorted (the probe's sort setting, by catalogue column id).
   */
  sortBy(column: number | string | undefined, descending = false): void {
    if (this.spec.mode !== 'snapshot') return
    if (column === undefined) {
      this.sort = undefined
      this.o.live.setProbe(this.o.probe, { sort: undefined })
    } else {
      const id = typeof column === 'number' ? this.spec.columns[column]?.id : this.spec.columns.find(item => item.id === column)?.id
      if (!id || this.spec.columns.find(item => item.id === id)?.role === 'tone') return
      this.sort = [{ column: id, descending }]
      this.o.live.setProbe(this.o.probe, { sort: [...this.sort] })
    }
    this.changed()
  }

  /** Copy: the grid's selection of the revision it shows, as Copy in a results grid (the tone column is never copied). */
  async copy(headers: boolean): Promise<ApiResult<ResultsJobResult> | undefined> {
    const table = this.table, selection = this.view?.currentSelection()
    if (!table || !selection || !this.o.api) return undefined
    const parts = copyPlan(selection, this.shownColumns(table))
    if (parts.length === 0) return undefined
    return this.o.api.copyResults({ jobId: this.newId(), generation: table.descriptor.generation, resultId: table.descriptor.resultId, headers, parts })
  }
  /** Save Results As of the revision the grid shows (main asks for the file). An append segment saves once complete. */
  async save(suggestedName: string, format?: ResultsFormat): Promise<ApiResult<SavedResults | null> | undefined> {
    const table = this.table
    if (!table || !this.o.api) return undefined
    return this.o.api.saveResults({ jobId: this.newId(), generation: table.descriptor.generation, resultId: table.descriptor.resultId, suggestedName, ...format ? { format } : {} })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopTick.dispose()
    this.cancelPending()
    this.view?.dispose()
    this.view = undefined
    this.clearListeners()
  }

  /**
   * The view's latest table: the first creates the grid; the same result grew (append) in place; another one swaps in. A
   * snapshot revision first reads the rows it will show (GridView.prepare, at most prepareMs), so the swap never paints
   * empty cells; a newer revision arriving meanwhile swaps in at once, since it retired the one the grid still shows.
   */
  private sync(): void {
    if (this.disposed) return
    const next = this.o.live.table(this.o.probe, this.index)
    const latest = this.pending?.table ?? this.table
    if (!next || next === latest) return
    if (!this.view) {
      this.table = next
      this.view = this.o.createView(next, { onViewport: viewport => this.viewportChanged(viewport), onSelection: () => this.updateTracking() })
      this.changed()
      return
    }
    const same = (table: LiveTable | undefined) => table !== undefined && table.descriptor.generation === next.descriptor.generation && table.descriptor.resultId === next.descriptor.resultId
    if (same(latest)) {
      if (this.pending) this.pending = { ...this.pending, table: next }
      else { this.table = next; this.changed() }
      return
    }
    if (next.mode === 'snapshot' && !this.pending) {
      const map = trackedRowMap(this.known, next.tracked), viewport = this.view.lastViewport()
      const top = !viewport || viewport.firstRow === 0 ? 0 : map(viewport.firstRow) >= 0 ? map(viewport.firstRow) : viewport.firstRow
      const pending = { table: next, abort: new AbortController(), timer: undefined as unknown }
      this.pending = pending
      pending.timer = this.timers.setTimeout(() => this.commitPending(pending.abort), prepareMs)
      this.view.prepare(next.handle, top, pending.abort.signal).then(() => this.commitPending(pending.abort), () => this.commitPending(pending.abort))
      return
    }
    this.cancelPending()
    this.swapTo(next)
  }

  /** The pending revision swaps in, unless it was superseded (its abort controller is no longer the pending one's). */
  private commitPending(abort: AbortController): void {
    const pending = this.pending
    if (this.disposed || pending?.abort !== abort) return
    this.cancelPending()
    this.swapTo(pending.table)
  }
  private cancelPending(): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    this.timers.clearTimeout(pending.timer)
    pending.abort.abort()
  }

  private swapTo(next: LiveTable): void {
    const view = this.view
    if (!view) return
    this.table = next
    if (next.mode === 'snapshot') {
      const map = trackedRowMap(this.known, next.tracked)
      this.revision++
      view.swap(next.handle, next.descriptor, map, next.departed ? { muted: next.departed } : {})
      // The tracked keys are where the backend put them; other rows are read again when wanted.
      const known = new Map<number, string>()
      next.tracked?.keys?.forEach((key, index) => { const row = next.tracked!.rows[index]; if (row >= 0) known.set(row, key) })
      this.known = known
      this.updateTracking()
    } else {
      // A new segment holds other rows: nothing maps. A roll keeps following the tail; a restart keeps the view's intent,
      // the tail, or else the first of the new rows.
      const follow = this.following || next.rolledFrom !== undefined
      this.revision++
      this.known = new Map()
      view.swap(next.handle, next.descriptor, () => -1, follow ? {} : { top: 0 })
      this.seenRows = 0
      if (follow) view.revealEnd()
    }
    this.changed()
  }

  private viewportChanged(viewport: GridViewport): void {
    if (viewport.atEnd) { this.following = true; this.seenRows = viewport.rows }
    else if (this.following) { this.following = false; this.seenRows = Math.min(this.seenRows || viewport.rows, viewport.rows) }
    this.changed()
    this.updateTracking()
  }

  /** Once a task, after a swap, a selection or a frame: what a click and the frame after it change goes as one round. */
  private updateTracking(): void {
    if (this.queued || this.disposed) return
    this.queued = true
    queueMicrotask(() => { this.queued = false; this.track() })
  }
  /** Sends the keys of the rows the grid follows, reading the ones it does not know yet; one round at a time. */
  private track(): void {
    if (this.disposed || this.spec.mode !== 'snapshot' || this.keyColumns.length === 0 || !this.view || !this.table) return
    if (this.reading) { this.again = true; return }
    const rows = wantedRows(this.view.currentSelection(), this.view.lastViewport())
    const missing = rows.filter(row => !this.known.has(row))
    if (missing.length === 0) { this.sendTrack(rows); return }
    this.reading = true
    const revision = this.revision, handle = this.table.handle
    const colStart = Math.min(...this.keyColumns), colEnd = Math.max(...this.keyColumns) + 1
    const reads = readSpans(missing, 4096).map(span => handle.getWindow(span.first, span.count, { colStart, colEnd, display: false, maxCellChars: limits.live.keyCharacters + 1 }).then(window => {
      if (revision !== this.revision) return
      for (let row = span.first; row < span.first + window.count; row++) {
        const key = keyOfRow(window, row, this.keyColumns)
        if (key !== undefined) this.known.set(row, key)
      }
    }))
    Promise.allSettled(reads).then(() => {
      this.reading = false
      if (this.disposed) return
      if (revision === this.revision) this.sendTrack(rows)
      if (this.again || revision !== this.revision) { this.again = false; this.track() }
    }, onUnexpectedError)
  }

  private sendTrack(rows: readonly number[]): void {
    const keys = [...new Set(rows.flatMap(row => { const key = this.known.get(row); return key === undefined ? [] : [key] }))]
    if (keys.length === this.sent.length && keys.every((key, index) => key === this.sent[index])) return
    this.sent = keys
    this.o.live.track(this.o.probe, keys, this.index)
  }

  private shownColumns(table: LiveTable): number {
    const columns = table.descriptor.columns
    return columns.length - (columns.at(-1)?.role === 'tone' ? 1 : 0)
  }
  private newId(): string { return this.o.newId?.() ?? crypto.randomUUID() }

  private changed(): void {
    if (this.disposed) return
    const newRows = this.following || this.table?.mode !== 'append' ? 0 : Math.max(0, (this.view?.lastViewport()?.rows ?? 0) - this.seenRows)
    this.publish({ ...this.table ? { table: this.table } : {}, newRows, following: this.following, ...this.sort ? { sort: this.sort } : {} })
  }
}
