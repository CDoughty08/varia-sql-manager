// A live table in a grid (docs/ipc.md, Live subscriptions, LiveGrid): GridView over the result a LiveService view's
// table holds now. A snapshot table's next revision swaps in place and keeps the user's rows (the active cell, each
// block and the first row shown follow their keys, which the backend tracks for the grid); a selected row that left the
// source stays one revision, muted. An append table grows in place and follows its tail while the view is at the end;
// when the user scrolls up, the rows that arrive since are counted for a "n new rows" button. A roll or restart swaps to
// the new segment. Copy reads the revision the grid shows (the backend leases it, so a retire mid-copy loses nothing);
// Save writes the table's newest revision once the file is chosen, since the samples retire the one shown while the
// dialog is open.
import type { ApiResult, ResultsFormat, ResultsJobResult, SavedResults, VariaApi } from '../../../shared/contracts'
import { limits, type ErrorCode } from '../../../shared/ipc/wire/protocol'
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
import type { GridViewState } from '../results/ResultsService'
import { FLAG_CAPPED, FLAG_ERROR, FLAG_NULL } from '../results/worker-protocol'
import { sameSort, type LiveHandle, type LiveTable } from './LiveService'

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
  /** The sort this grid's table has (the probe's keys for it, by catalogue column id). */
  readonly sort?: readonly LiveSort[]
  /** The shown result is lost (the backend restarted): the pane says so, since the grid can no longer read its rows. */
  readonly lost: boolean
  /** The shown result was released because the view's subscription ended: `dormant` while the view is hidden long enough
   *  to stop (it subscribes again when shown), `stopped` otherwise (a failure, a Reconnect, its tab's disconnect). */
  readonly released?: 'dormant' | 'stopped'
  /** The grid's selection as it last reported it, including where a swap moved it. */
  readonly selection?: GridSelection
  /** The active row's key (its key columns' stored texts joined with U+001F), once the grid knows it: what an owner's
   *  details pane, Kill or context menu acts on. While a swap waits for the backend to say where the selected row went,
   *  it is that row's key, not the key of the row now at its index. */
  readonly activeKey?: string
}
/** What an owner keeps across remounts: the grid's own state, and where the live grid was in the result it showed
 *  (`seenIn` and `keysIn` name that result, generation:resultId). */
export interface LiveGridState extends GridViewState {
  /** An append table scrolled up: the rows its segment had when the view left its last row. */
  seenRows?: number
  seenIn?: string
  /** The selected rows' keys, so a remount over a newer revision follows the same rows. */
  keys?: readonly (readonly [number, string])[]
  keysIn?: string
}
export interface LiveGridOptions {
  readonly live: Pick<LiveHandle, 'table' | 'onTick' | 'track' | 'setProbe' | 'probeOptions' | 'subscribe' | 'getSnapshot'>
  readonly probe: LiveProbeId
  /** The table's index in the probe's catalogue entry (0 by default). */
  readonly table?: number
  /** The table's catalogue entry; the shipped catalogue's by default. */
  readonly spec?: LiveTableSpec
  /** Kept by the owner across remounts; the grid writes where it is into it. */
  readonly state?: LiveGridState
  /** Builds the grid once the table's first result is there (a GridView over the shell's root in the app). */
  createView(table: LiveTable, hooks: LiveGridHooks): LiveGridView
  readonly api?: Pick<VariaApi, 'copyResults' | 'saveResults'>
  readonly newId?: () => string
  readonly timers?: Timers
}

/** A snapshot revision waits at most this long for its first rows to be read before it swaps in anyway. */
export const prepareMs = 250

/** What the pane shows, and Copy and Save answer, when the shown result is gone. */
export const liveGridText = {
  lost: 'This live view lost its rows because the SQL backend restarted.',
  stopped: 'This live view stopped; its rows are no longer available.',
  dormant: 'Paused while hidden; the rows come back when the view is shown.'
} as const

/** The failures that mean a job's result was gone (released, lost or never there), rather than that the job failed. */
const goneCodes: ReadonlySet<ErrorCode> = new Set(['RESULT_UNAVAILABLE', 'RESULT_RELEASED', 'RESULT_NOT_FOUND', 'NOT_FOUND', 'BACKEND_LOST', 'BACKEND_UNAVAILABLE'])
const unitSeparator = '\u001f'
const resultKey = (table: LiveTable) => `${table.descriptor.generation}:${table.descriptor.resultId}`

/**
 * Where each row of the shown revision went, from the rows whose keys the grid knew and where the backend says the
 * tracked keys are now (`tracked.keys[i]` is at `tracked.rows[i]`, −1 when gone). A row whose key the grid did not know,
 * or did not send yet, keeps its index: the grid cannot tell where it went, and the map's `known` says so (the search for
 * a gone active row's neighbour passes such rows over).
 */
export function trackedRowMap(known: ReadonlyMap<number, string>, tracked: LiveTable['tracked']): RowMap {
  if (!tracked?.keys || tracked.keys.length !== tracked.rows.length) return row => row
  const moved = new Map<string, number>()
  tracked.keys.forEach((key, index) => moved.set(key, tracked.rows[index]))
  const placed = (row: number) => { const key = known.get(row); return key === undefined ? undefined : moved.get(key) }
  return Object.assign((row: number) => placed(row) ?? row, { known: (row: number) => placed(row) !== undefined })
}
/** The keys a revision's tracked rows answer (none without the answered list's keys). */
function answeredKeys(tracked: LiveTable['tracked']): ReadonlySet<string> {
  return new Set(tracked?.keys && tracked.keys.length === tracked.rows.length ? tracked.keys : [])
}
/** The rows a selection holds across a swap: the active row and each block of cells' or rows' anchor and focus rows. */
export function selectedRows(selection: GridSelection | undefined): number[] {
  if (!selection) return []
  const rows = new Set([selection.active.row])
  for (const block of selection.blocks) {
    if (block.kind === 'columns' || block.kind === 'all') continue
    rows.add(block.anchor.row)
    rows.add(block.focus.row)
  }
  return [...rows]
}
/**
 * The rows a grid follows across revisions, each once, within the rows, at most limits.live.trackedKeys: first the
 * selected rows (selectedRows; the backend keeps these one revision when they leave), then the active row's neighbours
 * (where the selection goes when the active row leaves) and the first row shown, unless that is the first row: a view at
 * the top stays at the top. `selected` counts the selected rows at the front.
 */
export function wantedRows(selection: GridSelection | undefined, viewport: GridViewport | undefined): { rows: number[]; selected: number } {
  const inside = (row: number) => row >= 0 && (!viewport || row < viewport.rows)
  const selected = selectedRows(selection).filter(inside)
  const rows = new Set(selected)
  if (selection) for (const row of [selection.active.row + 1, selection.active.row - 1]) if (inside(row)) rows.add(row)
  if (viewport && viewport.rows > 0 && viewport.firstRow > 0) rows.add(viewport.firstRow)
  const list = [...rows].slice(0, limits.live.trackedKeys)
  return { rows: list, selected: Math.min(selected.length, list.length) }
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
  /**
   * Row → key, for selected rows whose key the grid knew before a swap that the backend had not answered yet (it sampled
   * under an older track list): the selection stays at the row's index, which may now hold another row, so the grid goes
   * on following the key it knew, and moves the selection once a revision says where that key went. A choice of the
   * user's replaces them: they chose by what they see.
   */
  private pinned = new Map<number, string>()
  /** Bumps on every swap: reads of an older revision's keys are dropped. */
  private revision = 0
  private sent: { readonly keys: readonly string[]; readonly linger: number } = { keys: [], linger: 0 }
  private reading = false
  private again = false
  private queued = false
  /** A swap is reporting where it moved the selection: that is no choice of the user's. */
  private swapping = false
  private following: boolean
  /** The rows there were when the view left its last row. */
  private seenRows = 0
  private selection: GridSelection | undefined
  /** The rows the grid's last frame had (the new segment's after a swap, until its first frame). */
  private viewRows = 0
  /** The shown table's handle this grid listens to (its state: lost, released), and how to stop. */
  private watched: { readonly handle: LiveTable['handle']; readonly stop: () => void } | undefined
  /** A snapshot revision whose first rows are being read before it swaps in. */
  private pending: { readonly table: LiveTable; readonly abort: AbortController; timer: unknown } | undefined
  private readonly timers: Timers
  private readonly stopTick: Disposable
  private readonly stopLive: () => void
  private disposed = false

  constructor(o: LiveGridOptions) {
    super({ newRows: 0, following: o.state?.following ?? true, lost: false })
    this.o = o
    this.index = o.table ?? 0
    this.timers = o.timers ?? browserTimers
    this.following = o.state?.following ?? true
    const spec = o.spec ?? liveProbes[o.probe]?.tables?.[this.index]
    if (!spec) throw new Error('The probe has no such table.')
    this.spec = spec
    this.keyColumns = spec.mode === 'snapshot' ? spec.key.map(id => spec.columns.findIndex(column => column.id === id)) : []
    // After each applied tick, before it is acknowledged: the grid shows the newest revision when the next one is written.
    this.stopTick = o.live.onTick(() => { try { this.sync() } catch (error) { onUnexpectedError(error) } })
    // The view's status says why a released result is gone (dormant or stopped), and its settings hold the sort.
    this.stopLive = o.live.subscribe(() => this.changed())
    this.sync()
    // A probe sorted before this grid was built (a remount) shows its sort from the start.
    this.changed()
  }

  /** The table the grid shows, if any. */
  get shown(): LiveTable | undefined { return this.table }

  /** Scrolls to the last row; follow tail goes on from there. */
  jumpToEnd(): void {
    this.view?.revealEnd()
  }

  /**
   * Sorts this grid's snapshot table by a shown column (its index) or a catalogue column id; `undefined` goes back to the
   * source's order. The backend sorts, and its next revision arrives sorted: the probe's sort setting holds a key for
   * this table (`table`), so the probe's other tables keep theirs. A probe-wide key (no table) gives way to it here, and
   * stays on the other tables as their own keys.
   */
  sortBy(column: number | string | undefined, descending = false): void {
    if (this.spec.mode !== 'snapshot') return
    const others = this.siblingKeys()
    if (column === undefined) this.o.live.setProbe(this.o.probe, { sort: others.length > 0 ? others.slice(0, limits.live.sortColumns) : undefined })
    else {
      const id = typeof column === 'number' ? this.spec.columns[column]?.id : this.spec.columns.find(item => item.id === column)?.id
      if (!id || this.spec.columns.find(item => item.id === id)?.role === 'tone') return
      this.o.live.setProbe(this.o.probe, { sort: [{ column: id, descending, table: this.index }, ...others].slice(0, limits.live.sortColumns) })
    }
    this.changed()
  }

  /** Copy: the grid's selection of the revision it shows, as Copy in a results grid (the tone column is never copied). */
  async copy(headers: boolean): Promise<ApiResult<ResultsJobResult> | undefined> {
    const table = this.table, selection = this.view?.currentSelection()
    if (!table || !selection || !this.o.api) return undefined
    const parts = copyPlan(selection, this.shownColumns(table))
    if (parts.length === 0) return undefined
    return this.gone(table, () => this.o.api!.copyResults({ jobId: this.newId(), generation: table.descriptor.generation, resultId: table.descriptor.resultId, headers, parts }))
  }
  /** Save Results As (main asks for the file): of a snapshot table, the revision it has once the file is chosen (main's
   *  ResultsPortHost.liveNewest); of an append table, the segment shown, once it is complete. */
  async save(suggestedName: string, format?: ResultsFormat): Promise<ApiResult<SavedResults | null> | undefined> {
    const table = this.table
    if (!table || !this.o.api) return undefined
    return this.gone(table, () => this.o.api!.saveResults({ jobId: this.newId(), generation: table.descriptor.generation, resultId: table.descriptor.resultId, suggestedName, ...format ? { format } : {} }))
  }
  /**
   * Runs a job on the shown result, and says in a live view's words when the view's rows are gone (before or during it).
   * Only the view's loss counts: the samples retire the revision a job started on as a matter of course, and a job that
   * failed for its own reason (a file in use) keeps its own words.
   */
  private async gone<T>(table: LiveTable, job: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    const before = this.goneText(table) && this.viewGone()
    if (before) return { ok: false, error: before, code: 'RESULT_UNAVAILABLE' }
    const result = await job()
    if (result.ok || !result.code || !goneCodes.has(result.code)) return result
    const after = this.viewGone()
    return after ? { ...result, error: after } : result
  }
  /** Why the view no longer has rows: the table it holds now (the newest revision, or the one shown) is lost or released. */
  private viewGone(): string | undefined {
    const current = this.o.live.table(this.o.probe, this.index) ?? this.table
    return current && this.goneText(current)
  }
  private goneText(table: LiveTable): string | undefined {
    const state = table.handle.getSnapshot().state
    if (state === 'lost') return liveGridText.lost
    if (state === 'released') return liveGridText.stopped
    return undefined
  }

  dispose(): void {
    if (this.disposed) return
    // The table's track list is this grid's: left behind, the backend would go on following (and keeping) its rows for a
    // grid that no longer selects them, and a new grid's first list, if empty, would never replace it.
    if (this.sent.keys.length > 0 || this.sent.linger > 0) {
      try { this.o.live.track(this.o.probe, [], this.index, 0) } catch (error) { onUnexpectedError(error) }
    }
    this.disposed = true
    this.stopTick.dispose()
    this.stopLive()
    this.watched?.stop()
    this.watched = undefined
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
      this.restore(next)
      this.view = this.o.createView(next, { onViewport: viewport => this.viewportChanged(viewport), onSelection: selection => this.selectionChanged(selection) })
      // A grid built over kept state shows its selection at once, without telling: the owner hears of it here.
      this.selection = this.view.currentSelection()
      this.changed()
      this.updateTracking()
      return
    }
    const same = (table: LiveTable | undefined) => table !== undefined && table.descriptor.generation === next.descriptor.generation && table.descriptor.resultId === next.descriptor.resultId
    if (same(latest)) {
      if (this.pending) this.pending = { ...this.pending, table: next }
      else { this.table = next; this.changed() }
      return
    }
    if (next.mode === 'snapshot' && !this.pending) {
      const map = trackedRowMap(this.intent(), next.tracked), viewport = this.view.lastViewport()
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

  /** Where a remounted grid was, from its owner's kept state: the rows it had seen, and its selected rows' keys (known
   *  when the result is the one they were read in, else pinned until a revision places them). */
  private restore(first: LiveTable): void {
    const state = this.o.state
    if (!state) return
    const here = resultKey(first)
    if (!this.following && state.seenIn === here) this.seenRows = state.seenRows ?? 0
    const into = state.keysIn === here ? this.known : this.pinned
    for (const [row, key] of state.keys ?? []) into.set(row, key)
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
      const intent = this.intent()
      const map = trackedRowMap(intent, next.tracked)
      // The tracked keys are where the backend put them; other rows are read again when wanted. Known before the swap, so
      // the selection it reports already has its active row's key.
      const known = new Map<number, string>()
      next.tracked?.keys?.forEach((key, index) => { const row = next.tracked!.rows[index]; if (row >= 0) known.set(row, key) })
      // A selected row whose key this revision does not answer stays at its index (map keeps it there): it is pinned.
      const answered = answeredKeys(next.tracked), rows = next.handle.getSnapshot().rowsAvailable, pinned = new Map<number, string>()
      if (rows > 0) for (const row of selectedRows(view.currentSelection())) {
        const key = intent.get(row)
        if (key !== undefined && !answered.has(key)) pinned.set(Math.min(row, rows - 1), key)
      }
      this.known = known
      this.pinned = pinned
      this.revision++
      this.swapping = true
      try { view.swap(next.handle, next.descriptor, map, next.departed ? { muted: next.departed } : {}) } finally { this.swapping = false }
      // A swap to a revision with no rows drops the selection without a word: the snapshot must not go on naming it.
      this.selection = view.currentSelection()
      this.updateTracking()
    } else {
      // A new segment holds other rows: nothing maps. A roll keeps following the tail; a restart keeps the view's intent,
      // the tail, or else the first of the new rows.
      const follow = this.following || next.rolledFrom !== undefined
      this.revision++
      this.known = new Map()
      this.pinned = new Map()
      view.swap(next.handle, next.descriptor, () => -1, follow ? {} : { top: 0 })
      this.selection = view.currentSelection()
      // Scrolled up, only rows that arrive after the restart are new.
      this.viewRows = this.seenRows = follow ? 0 : next.handle.getSnapshot().rowsAvailable
      if (follow) view.revealEnd()
    }
    this.changed()
  }

  private viewportChanged(viewport: GridViewport): void {
    this.viewRows = viewport.rows
    // A frame that finds rows and no selection selects the first cell without reporting it (GridView's current cell);
    // the snapshot names what the grid shows.
    if (this.view) this.selection = this.view.currentSelection()
    if (viewport.atEnd) { this.following = true; this.seenRows = viewport.rows }
    else if (this.following) { this.following = false; this.seenRows = Math.min(this.seenRows || viewport.rows, viewport.rows) }
    this.changed()
    this.updateTracking()
  }
  private selectionChanged(selection: GridSelection): void {
    this.selection = selection
    if (!this.swapping) this.pinned.clear()
    this.changed()
    this.updateTracking()
  }

  /** What the grid means by each row it follows: a pinned key over the key of the row now at that index. */
  private intent(): Map<number, string> {
    return this.pinned.size === 0 ? this.known : new Map([...this.known, ...this.pinned])
  }
  private keyAt(row: number): string | undefined { return this.pinned.get(row) ?? this.known.get(row) }

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
    const { rows, selected } = wantedRows(this.view.currentSelection(), this.view.lastViewport())
    const held = new Set(rows.slice(0, selected))
    for (const row of [...this.pinned.keys()]) if (!held.has(row)) this.pinned.delete(row)
    const missing = rows.filter(row => this.keyAt(row) === undefined)
    if (missing.length === 0) { this.sendTrack(rows, selected); return }
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
      if (revision === this.revision) { this.sendTrack(rows, selected); this.changed() }
      if (this.again || revision !== this.revision) { this.again = false; this.track() }
    }, onUnexpectedError)
  }

  /** The keys of `rows`, each once; the keys of the first `selected` rows linger when they leave. */
  private sendTrack(rows: readonly number[], selected: number): void {
    const keys: string[] = [], seen = new Set<string>()
    let linger = 0
    rows.forEach((row, index) => {
      const key = this.keyAt(row)
      if (key === undefined || seen.has(key)) return
      seen.add(key)
      keys.push(key)
      if (index < selected) linger = keys.length
    })
    if (linger === this.sent.linger && keys.length === this.sent.keys.length && keys.every((key, index) => key === this.sent.keys[index])) return
    this.sent = { keys, linger }
    this.o.live.track(this.o.probe, keys, this.index, linger)
  }

  private shownColumns(table: LiveTable): number {
    const columns = table.descriptor.columns
    return columns.length - (columns.at(-1)?.role === 'tone' ? 1 : 0)
  }
  private newId(): string { return this.o.newId?.() ?? crypto.randomUUID() }
  /** The probe's sort keys for its other tables, in order: theirs, and each probe-wide key as a key of every other snapshot
   *  table with that column (which it sorted), so that sorting this grid leaves its siblings' order as it was. */
  private siblingKeys(): LiveSort[] {
    const keys = this.o.live.probeOptions(this.o.probe)?.sort ?? [], tables = liveProbes[this.o.probe]?.tables ?? [], out: LiveSort[] = []
    const has = (table: number, column: string) => [...keys, ...out].some(key => key.table === table && key.column === column)
    for (const key of keys) {
      if (key.table !== undefined) { if (key.table !== this.index) out.push(key); continue }
      tables.forEach((table, at) => {
        if (at !== this.index && table.mode === 'snapshot' && table.columns.some(column => column.id === key.column && column.role !== 'tone') && !has(at, key.column)) {
          out.push({ column: key.column, descending: key.descending, table: at })
        }
      })
    }
    return out
  }
  /** This table's sort keys in the probe's sort setting: those for it, and probe-wide ones on a column it has. */
  private sortOf(): LiveSort[] | undefined {
    if (this.spec.mode !== 'snapshot') return undefined
    const keys = (this.o.live.probeOptions(this.o.probe)?.sort ?? [])
      .filter(key => key.table === undefined ? this.spec.columns.some(column => column.id === key.column) : key.table === this.index)
    return keys.length > 0 ? keys.map(({ column, descending }) => ({ column, descending })) : undefined
  }

  /** Publishes what the pane and the owner see, only when some of it changed: a scrolled frame of a snapshot table
   *  changes none of it, and each publish renders the pane. */
  private changed(): void {
    if (this.disposed) return
    const table = this.table
    this.watch(table)
    this.keep(table)
    const newRows = this.following || table?.mode !== 'append' ? 0 : Math.max(0, this.viewRows - this.seenRows)
    const state = table?.handle.getSnapshot().state
    const lost = state === 'lost'
    const released = state === 'released' ? this.o.live.getSnapshot().status === 'dormant' ? 'dormant' : 'stopped' : undefined
    const activeKey = this.selection && this.keyAt(this.selection.active.row)
    const now = this.getSnapshot(), wanted = this.sortOf()
    const sort = sameSort(now.sort, wanted) ? now.sort : wanted
    if (now.table === table && now.newRows === newRows && now.following === this.following && now.sort === sort && now.lost === lost && now.released === released
      && now.selection === this.selection && now.activeKey === activeKey) return
    this.publish({
      ...table ? { table } : {}, newRows, following: this.following, lost, ...released ? { released } : {}, ...sort ? { sort } : {},
      ...this.selection ? { selection: this.selection } : {}, ...activeKey !== undefined ? { activeKey } : {}
    })
  }
  /** Writes where the grid is into the owner's kept state, for a remount. */
  private keep(table: LiveTable | undefined): void {
    const state = this.o.state
    if (!state || !table) return
    const here = resultKey(table)
    state.seenRows = this.seenRows
    state.seenIn = here
    if (this.spec.mode !== 'snapshot') return
    const rows = selectedRows(this.selection)
    state.keys = rows.flatMap(row => { const key = this.keyAt(row); return key === undefined ? [] : [[row, key] as const] })
    // A pinned key is not the key of the row at its index here: a remount pins them all again rather than know them.
    state.keysIn = rows.some(row => this.pinned.has(row)) ? undefined : here
  }
  /** Listens to the shown result: a backend loss or a stream's end changes its state, and nothing else would tell the pane. */
  private watch(table: LiveTable | undefined): void {
    if (this.watched?.handle === table?.handle) return
    this.watched?.stop()
    this.watched = table && { handle: table.handle, stop: table.handle.subscribe(() => this.changed()) }
  }
}
