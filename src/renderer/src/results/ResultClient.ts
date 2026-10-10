// The renderer's access to stored query results (the PR7 grid contract). Rows stay in the backend; the results worker
// reads and decodes pages, and the UI thread receives only windows of display text.
import type { BackendStatus, QueryEvent, QueryResult, ResultColumn, ResultDescriptor, TruncationReason, VariaApi, WireKind } from '../../../shared/contracts'
import { limits as wire, type ErrorCode } from '../../../shared/ipc/wire/protocol'
import type { Disposable } from '../core/types'
import { gridLimits as g } from '../grid/constants'
import type { ResultKey, ValueFormat, WorkerRequest, WorkerResponse } from './worker-protocol'

/** A failed result request; `code` is a protocol error code (docs/ipc.md). */
export class ResultError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'ResultError'
    this.code = code
  }
}

export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: { data: WorkerResponse }) => void): void
  addEventListener(type: 'error' | 'messageerror', listener: (event: unknown) => void): void
  terminate(): void
}
export interface PortMessageEvent { readonly source: unknown; readonly data: unknown; readonly ports: readonly MessagePort[] }
export interface WindowLike {
  addEventListener(type: 'message', listener: (event: PortMessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: PortMessageEvent) => void): void
}

export interface RowWindow {
  first: number
  count: number
  colStart: number
  colEnd: number
  /** Row-major display text, (colEnd − colStart) cells per row; '' for NULL and cells over the text budget. */
  text: string[]
  /** Per cell: 1 NULL, 2 truncated where stored, 4 read error, 8 over the window's text budget, 16 cut at maxCellChars. */
  flags: Uint8Array
}
/** One cell's whole value: `truncated` when the backend stored only a prefix (never formatted), `error` for a read error. */
export interface CellValue { text: string; isNull: boolean; truncated: boolean; error: boolean; formatted: boolean }
export interface ResultSnapshot {
  rowsRead: number
  rowsStored: number
  rowsAvailable: number
  bytesStored: number
  truncatedCells: number
  state: 'open' | 'complete' | 'released' | 'lost'
  truncated?: TruncationReason
  incomplete: boolean
}
/** What a window holds: columns [colStart, colEnd), cells cut at `maxCellChars`, and with `display` grid text. */
export interface WindowShape { colStart?: number; colEnd?: number; maxCellChars?: number; display?: boolean }
export interface WindowOptions extends WindowShape { textBudget?: number; signal?: AbortSignal }
export interface ResultHandle extends Disposable {
  readonly key: ResultKey
  readonly columns: readonly ResultColumn[]
  getSnapshot(): ResultSnapshot
  /** Progress and closed events, coalesced per animation frame. */
  subscribe(listener: () => void): () => void
  /** Up to 4,096 rows of display text; `count` shrinks to the rows available. */
  getWindow(first: number, count: number, o?: WindowOptions): Promise<RowWindow>
  /** A window fetched recently with the same arguments, from the client's window cache, without asking the worker. */
  peekWindow(first: number, count: number, o?: WindowShape): RowWindow | undefined
  prefetch(first: number, count: number): void
  /** The widest display text of each column in [colStart, colEnd) over the rows, in monospace columns (≤ 512). */
  measure(first: number, count: number, colStart: number, colEnd: number, signal?: AbortSignal): Promise<{ rows: number; widths: Uint16Array }>
  /** The full stored value of one cell; with `format`, the worker pretty-prints it (`formatted`) when it can. */
  getCell(row: number, col: number, o?: { format?: ValueFormat; signal?: AbortSignal }): Promise<CellValue>
  /** Releases the result in the backend (results.close); queued while the results port is down. */
  close(): Promise<void>
}
/** Test mode's counters (the grid's `__variaGrid.stats()`). */
export interface ClientStats { workerBytes: number; workerPages: number; uiWindows: number; uiUnits: number; inflight: number }

const decoderFailed = 'Results cannot be displayed; reload the workbench.'
const workerStopped = 'The results worker stopped. Try again.'
const unavailable = 'These results are no longer available because the SQL backend restarted.'
const released = 'These results were closed. Execute the query again to see them.'
/** Result ids waiting to be closed while the port is down; more are dropped (the backend frees them with their tab). */
const maxQueuedCloses = 100_000

interface ResultState {
  readonly key: ResultKey
  readonly id: string
  readonly columns: readonly ResultColumn[]
  readonly wires: readonly WireKind[]
  snapshot: ResultSnapshot
  readonly listeners: Set<() => void>
  handle: ResultHandle | undefined
  scheduled: boolean
}
interface Pending { resolve(message: WorkerResponse): void; reject(error: Error): void }

const keyOf = (key: ResultKey): string => `${key.generation}:${key.resultId}`
const abortError = (): Error => new DOMException('The request was aborted.', 'AbortError')

/**
 * The UI thread's windows of every result, least recently used first: at most 256 windows and 16,777,216 UTF-16 units of
 * text together. A window is keyed by everything that shapes it, so a peek never returns text of another shape.
 */
export class WindowCache {
  private readonly entries = new Map<string, { readonly window: RowWindow; readonly units: number; readonly result: string }>()
  private used = 0
  constructor(private readonly maxWindows: number = g.uiCacheWindows, private readonly maxUnits: number = g.uiCacheUnits) {}
  static key(result: string, first: number, count: number, colStart: number, colEnd: number, maxCellChars: number, display: boolean): string {
    return `${result}:${first}:${count}:${colStart}:${colEnd}:${maxCellChars}:${display ? 1 : 0}`
  }
  get size(): number { return this.entries.size }
  get units(): number { return this.used }
  /** The window, now the most recently used. */
  get(key: string): RowWindow | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.window
  }
  set(key: string, result: string, window: RowWindow): void {
    let units = 0
    for (const text of window.text) units += text.length
    this.delete(key)
    this.entries.set(key, { window, units, result })
    this.used += units
    while (this.entries.size > 1 && (this.entries.size > this.maxWindows || this.used > this.maxUnits)) this.delete(this.entries.keys().next().value!)
  }
  /** Every window of one result (`generation:resultId`). */
  dropResult(result: string): void {
    for (const [key, entry] of this.entries) if (entry.result === result) this.delete(key)
  }
  clear(): void { this.entries.clear(); this.used = 0 }
  private delete(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.used -= entry.units
  }
}

/**
 * Owns the results worker and hands it the results port: the page asks main for the port, accepts exactly one port
 * posted by its own window while it waits for one, and transfers it to the worker. A worker that fails is recreated and
 * given a new port, at most 3 times a minute; after that results cannot be displayed until the workbench reloads.
 */
export class ResultClient implements Disposable {
  private readonly api: Pick<VariaApi, 'openResultsPort'>
  private readonly createWorker: () => WorkerLike
  private readonly window: WindowLike
  private readonly now: () => number
  private readonly schedule: (callback: () => void) => void
  private readonly pending = new Map<number, Pending>()
  private readonly results = new Map<string, ResultState>()
  private readonly queryListeners = new Map<string, Set<(event: QueryEvent) => void>>()
  private readonly memoryListeners = new Set<(memory: { usedBytes: number; globalBytes: number }) => void>()
  /** Result ids to close, by generation, until the port is attached. */
  private readonly closeQueue = new Map<number, Set<number>>()
  readonly windows: WindowCache
  private worker: WorkerLike
  private attached!: Promise<void>
  private resolveAttached!: () => void
  private rejectAttached!: (error: Error) => void
  private expecting = false
  private portReady = false
  private restarts: number[] = []
  private failure: string | undefined
  private nextId = 1
  private generation = 0
  private status: BackendStatus = 'starting'
  private windowRequests = 0
  private disposed = false

  /** `windowCache` bounds the windows every result shares (default 256 windows and 16 Mi UTF-16 units). */
  constructor(o: { api: Pick<VariaApi, 'openResultsPort'>; createWorker: () => WorkerLike; window: WindowLike; now?: () => number; schedule?: (callback: () => void) => void; windowCache?: { windows?: number; units?: number } }) {
    this.api = o.api
    this.windows = new WindowCache(o.windowCache?.windows, o.windowCache?.units)
    this.createWorker = o.createWorker
    this.window = o.window
    this.now = o.now ?? (() => Date.now())
    this.schedule = o.schedule ?? (callback => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback()); else queueMicrotask(callback) })
    this.window.addEventListener('message', this.onWindowMessage)
    this.worker = this.startWorker()
    this.openPort()
  }

  /** Resolves once the worker holds a results port. */
  ready(): Promise<void> { return this.attached }
  /** Why results cannot be displayed, once the worker failed too often. */
  get failed(): string | undefined { return this.failure }
  get backendGeneration(): number { return this.generation }
  /** Results this client still tracks: neither released nor from an earlier generation. */
  get trackedResults(): number { return this.results.size }
  get backendStatus(): BackendStatus { return this.status }
  /** Window requests waiting for the worker, across every result (grids share a limit of 16). */
  get windowsInFlight(): number { return this.windowRequests }
  /** Result ids waiting for the port to close them. */
  get queuedCloses(): number { let count = 0; for (const ids of this.closeQueue.values()) count += ids.size; return count }

  /** The result's handle; opening the same result again returns the same handle until it is disposed. */
  open(descriptor: ResultDescriptor): ResultHandle {
    const state = this.state(descriptor)
    if (state.handle) return state.handle
    const listeners = new Set<() => void>()
    const shape = (o: WindowShape) => {
      const colStart = Math.max(0, Math.min(state.columns.length, o.colStart ?? 0))
      const colEnd = Math.max(colStart, Math.min(state.columns.length, o.colEnd ?? state.columns.length))
      return { colStart, colEnd, maxCellChars: Math.min(o.maxCellChars ?? wire.worker.displayCharacters, wire.cell.document), display: !!o.display }
    }
    const handle: ResultHandle = {
      key: state.key,
      columns: state.columns,
      getSnapshot: () => state.snapshot,
      subscribe: listener => {
        listeners.add(listener)
        state.listeners.add(listener)
        return () => { listeners.delete(listener); state.listeners.delete(listener) }
      },
      getWindow: (first, count, o = {}) => this.fetchWindow(state, first, count, shape(o), o),
      peekWindow: (first, count, o = {}) => {
        const s = shape(o)
        return this.windows.get(WindowCache.key(state.id, Math.max(0, Math.floor(first)), Math.floor(count), s.colStart, s.colEnd, s.maxCellChars, s.display))
      },
      prefetch: (first, count) => {
        if (state.snapshot.state === 'lost' || state.snapshot.state === 'released' || this.failure) return
        void this.attached.then(() => this.worker.postMessage({ type: 'prefetch', key: state.key, wires: state.wires, first, count: Math.min(count, state.snapshot.rowsAvailable - first) }), () => {})
      },
      measure: async (first, count, colStart, colEnd, signal) => {
        this.usable(state)
        const response = await this.request(id => ({ type: 'measure', id, key: state.key, wires: state.wires, first, count: Math.min(count, state.snapshot.rowsAvailable - first), colStart, colEnd }), signal)
        if (response.type !== 'measure') throw new ResultError('RESULT_DECODER_FAILED', workerStopped)
        return { rows: response.rows, widths: response.widths }
      },
      getCell: async (row, col, o) => {
        this.usable(state)
        const response = await this.request(id => ({ type: 'cell', id, key: state.key, wires: state.wires, row, col, ...o?.format ? { format: o.format } : {} }), o?.signal)
        if (response.type !== 'cell') throw new ResultError('RESULT_DECODER_FAILED', workerStopped)
        return { text: response.text, isNull: response.isNull, truncated: response.truncated, error: response.error, formatted: response.formatted }
      },
      close: () => this.release([{ generation: state.key.generation, resultId: state.key.resultId }]),
      dispose: () => {
        for (const listener of listeners) state.listeners.delete(listener)
        listeners.clear()
        this.windows.dropResult(state.id)
        if (state.handle === handle) state.handle = undefined
      }
    }
    state.handle = handle
    return handle
  }

  /** Events of one running script (from main, through the worker). */
  onQueryEvent(queryId: string, listener: (event: QueryEvent) => void): Disposable {
    const listeners = this.queryListeners.get(queryId) ?? new Set()
    listeners.add(listener)
    this.queryListeners.set(queryId, listeners)
    return { dispose: () => { listeners.delete(listener); if (listeners.size === 0) this.queryListeners.delete(queryId) } }
  }

  onMemory(listener: (memory: { usedBytes: number; globalBytes: number }) => void): Disposable {
    this.memoryListeners.add(listener)
    return { dispose: () => { this.memoryListeners.delete(listener) } }
  }

  /** The summary's descriptors are final; events for the script that arrive later change nothing. */
  applySummary(summary: QueryResult): void {
    for (const descriptor of summary.resultSets) this.update(this.state(descriptor), descriptor, true)
  }

  /** Releases results in the backend (results.close); their pages leave the worker's cache and their windows this
   *  client's, and this client forgets them (handles still report them released). While the results port is down the
   *  ids wait, and are closed once a port is attached. */
  release(keys: readonly ResultKey[]): Promise<void> {
    let queued = this.queuedCloses
    for (const key of keys) {
      const state = this.results.get(keyOf(key))
      if (state) {
        this.publish(state, { ...state.snapshot, state: state.snapshot.state === 'lost' ? 'lost' : 'released' })
        this.forget(state)
      }
      if (this.generation !== 0 && key.generation !== this.generation) continue
      const ids = this.closeQueue.get(key.generation) ?? new Set<number>()
      if (queued >= maxQueuedCloses || ids.has(key.resultId)) continue
      ids.add(key.resultId)
      queued++
      this.closeQueue.set(key.generation, ids)
    }
    return this.flushCloses()
  }

  /** Test mode's cache counters; the worker's are 0 while it has no port. */
  async stats(): Promise<ClientStats> {
    let workerBytes = 0, workerPages = 0
    if (this.portReady && !this.failure) {
      const response = await this.request(id => ({ type: 'stats', id })).catch(() => undefined)
      if (response?.type === 'stats') { workerBytes = response.bytes; workerPages = response.pages }
    }
    return { workerBytes, workerPages, uiWindows: this.windows.size, uiUnits: this.windows.units, inflight: this.pending.size }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.window.removeEventListener('message', this.onWindowMessage)
    this.worker.terminate()
    this.rejectAll(new ResultError('PORT_CLOSED', 'The workbench closed.'))
    this.queryListeners.clear()
    this.memoryListeners.clear()
    this.windows.clear()
  }

  private async flushCloses(): Promise<void> {
    if (!this.portReady || this.failure || this.disposed || this.closeQueue.size === 0) return
    const batches = [...this.closeQueue]
    this.closeQueue.clear()
    for (const [generation, set] of batches) {
      const ids = [...set]
      for (let at = 0; at < ids.length; at += 1024) {
        const resultIds = ids.slice(at, at + 1024)
        try { await this.request(id => ({ type: 'close', id, generation, resultIds })) }
        catch (error) {
          // The port or the worker went away before main had them: they wait for the next port.
          const code = error instanceof ResultError ? error.code : undefined
          if (code === 'PORT_CLOSED' || code === 'RESULT_DECODER_FAILED') {
            const again = this.closeQueue.get(generation) ?? new Set<number>()
            for (const resultId of resultIds) again.add(resultId)
            this.closeQueue.set(generation, again)
          }
        }
      }
    }
  }

  private startWorker(): WorkerLike {
    const worker = this.createWorker()
    this.portReady = false
    this.attached = new Promise((resolve, reject) => { this.resolveAttached = resolve; this.rejectAttached = reject })
    // A request made before the port arrives waits for it; one that never arrives is reported where it is awaited.
    this.attached.catch(() => {})
    worker.addEventListener('message', event => { if (this.worker === worker) this.received(event.data) })
    worker.addEventListener('error', () => { if (this.worker === worker) this.workerFailed() })
    worker.addEventListener('messageerror', () => { if (this.worker === worker) this.workerFailed() })
    return worker
  }

  private openPort(): void {
    this.expecting = true
    this.api.openResultsPort().then(result => { if (!result.ok) this.portFailed(result.error) }, () => this.portFailed('The results connection could not be opened.'))
  }

  private portFailed(message: string): void {
    this.expecting = false
    this.portReady = false
    this.rejectAttached(new ResultError('PORT_CLOSED', message))
  }

  /** Only a port this page's own window posted, while one is expected, and exactly one. */
  private readonly onWindowMessage = (event: PortMessageEvent): void => {
    if (!this.expecting || event.source !== this.window) return
    const data = event.data as { type?: unknown } | null
    if (data === null || typeof data !== 'object' || data.type !== 'varia:results-port' || event.ports.length !== 1) return
    this.expecting = false
    const port = event.ports[0]
    this.worker.postMessage({ type: 'attach', port }, [port])
    this.portReady = true
    this.resolveAttached()
    void this.flushCloses()
  }

  private workerFailed(): void {
    this.portReady = false
    this.rejectAll(new ResultError('RESULT_DECODER_FAILED', workerStopped))
    // Requests still waiting for the failed worker's port fail with it (a port it already had changes nothing).
    this.rejectAttached(new ResultError('RESULT_DECODER_FAILED', workerStopped))
    this.worker.terminate()
    const now = this.now()
    this.restarts = this.restarts.filter(at => now - at < 60_000)
    if (this.restarts.length >= 3 || this.disposed) {
      this.failure = decoderFailed
      this.rejectAttached(new ResultError('RESULT_DECODER_FAILED', decoderFailed))
      return
    }
    this.restarts.push(now)
    this.worker = this.startWorker()
    this.openPort()
  }

  private rejectAll(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const request of pending) request.reject(error)
  }

  private async request(build: (id: number) => WorkerRequest, signal?: AbortSignal): Promise<WorkerResponse> {
    if (this.failure) throw new ResultError('RESULT_DECODER_FAILED', this.failure)
    await this.attached
    if (signal?.aborted) throw abortError()
    const id = this.nextId++
    return new Promise<WorkerResponse>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.delete(id)) return
        this.worker.postMessage({ type: 'cancel', id })
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: message => { signal?.removeEventListener('abort', onAbort); resolve(message) },
        reject: error => { signal?.removeEventListener('abort', onAbort); reject(error) }
      })
      this.worker.postMessage(build(id))
    })
  }

  private received(message: WorkerResponse): void {
    switch (message.type) {
      case 'window': case 'cell': case 'closed': case 'measure': case 'stats': {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        pending?.resolve(message)
        return
      }
      case 'error': {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        pending?.reject(new ResultError(message.code, message.message))
        return
      }
      case 'query': return this.queryEvent(message.queryId, message.event)
      case 'memory': for (const listener of [...this.memoryListeners]) listener({ usedBytes: message.usedBytes, globalBytes: message.globalBytes }); return
      case 'backend': return this.backend(message.generation, message.status)
    }
  }

  private backend(generation: number, status: BackendStatus): void {
    this.status = status
    if (generation === this.generation) return
    this.generation = generation
    // The backend that held them is gone, and with it their results.
    for (const queued of [...this.closeQueue.keys()]) if (queued !== generation) this.closeQueue.delete(queued)
    for (const state of [...this.results.values()]) {
      if (state.key.generation === generation) continue
      if (state.snapshot.state !== 'lost') this.publish(state, { ...state.snapshot, state: 'lost' })
      this.forget(state)
    }
  }

  private forget(state: ResultState): void {
    if (this.results.get(state.id) === state) this.results.delete(state.id)
    this.windows.dropResult(state.id)
  }

  private queryEvent(queryId: string, event: QueryEvent): void {
    if (event.type === 'resultSet.opened' || event.type === 'resultSet.closed') this.update(this.state(event.descriptor), event.descriptor, false)
    else if (event.type === 'progress') {
      for (const item of event.results) {
        const state = this.results.get(keyOf({ generation: this.generation, resultId: item.resultId }))
        if (state) this.update(state, item, false)
      }
    }
    for (const listener of [...this.queryListeners.get(queryId) ?? []]) listener(event)
  }

  private state(descriptor: ResultDescriptor): ResultState {
    const key = { generation: descriptor.generation, resultId: descriptor.resultId }
    const existing = this.results.get(keyOf(key))
    if (existing) return existing
    const state: ResultState = {
      key, id: keyOf(key), columns: descriptor.columns, wires: descriptor.columns.map(column => column.wire), listeners: new Set(), handle: undefined, scheduled: false,
      snapshot: { rowsRead: 0, rowsStored: 0, rowsAvailable: 0, bytesStored: 0, truncatedCells: 0, state: 'open', incomplete: false }
    }
    this.update(state, descriptor, false)
    // A result of an earlier generation can never be read, so it is not tracked.
    if (this.generation !== 0 && key.generation !== this.generation) state.snapshot = { ...state.snapshot, state: 'lost' }
    else this.results.set(state.id, state)
    return state
  }

  /** Counters only grow, and a final (summary) descriptor settles the state; released and lost stay. */
  private update(state: ResultState, values: Partial<ResultDescriptor>, final: boolean): void {
    const previous = state.snapshot
    const max = (key: 'rowsRead' | 'rowsStored' | 'rowsAvailable' | 'bytesStored' | 'truncatedCells') => Math.max(previous[key], values[key] ?? 0)
    const sticky = previous.state === 'released' || previous.state === 'lost'
    const next: ResultSnapshot = {
      rowsRead: max('rowsRead'), rowsStored: max('rowsStored'), rowsAvailable: max('rowsAvailable'), bytesStored: max('bytesStored'), truncatedCells: max('truncatedCells'),
      state: sticky ? previous.state : values.state === 'released' ? 'released' : values.state === 'complete' || previous.state === 'complete' || final ? 'complete' : 'open',
      incomplete: values.incomplete ?? previous.incomplete
    }
    const truncated = values.truncated ?? previous.truncated
    if (truncated) next.truncated = truncated
    this.publish(state, next)
  }

  private publish(state: ResultState, snapshot: ResultSnapshot): void {
    state.snapshot = snapshot
    if (state.scheduled || state.listeners.size === 0) return
    state.scheduled = true
    this.schedule(() => {
      state.scheduled = false
      for (const listener of [...state.listeners]) {
        try { listener() } catch { /* One listener's failure must not stop the others. */ }
      }
    })
  }

  private usable(state: ResultState): void {
    if (state.snapshot.state === 'lost') throw new ResultError('RESULT_UNAVAILABLE', unavailable)
    if (state.snapshot.state === 'released') throw new ResultError('RESULT_RELEASED', released)
  }

  private async fetchWindow(state: ResultState, first: number, count: number, shape: { colStart: number; colEnd: number; maxCellChars: number; display: boolean }, o: WindowOptions): Promise<RowWindow> {
    this.usable(state)
    const { colStart, colEnd, maxCellChars, display } = shape
    const start = Math.max(0, Math.floor(first))
    const width = Math.max(1, colEnd - colStart)
    const rows = Math.max(0, Math.min(Math.floor(count), wire.worker.windowRows, Math.floor(wire.worker.windowCells / width), state.snapshot.rowsAvailable - start))
    if (rows === 0) return { first: start, count: 0, colStart, colEnd, text: [], flags: new Uint8Array(0) }
    this.windowRequests++
    let response: WorkerResponse
    try {
      response = await this.request(id => ({
        type: 'window', id, key: state.key, wires: state.wires, first: start, count: rows, colStart, colEnd, maxCellChars,
        textBudget: Math.min(o.textBudget ?? 1_000_000, wire.worker.windowCharacters), ...display ? { display: true } : {}
      }), o.signal)
    } finally { this.windowRequests-- }
    if (response.type !== 'window') throw new ResultError('RESULT_DECODER_FAILED', workerStopped)
    const window: RowWindow = { first: response.first, count: response.count, colStart: response.colStart, colEnd: response.colEnd, text: response.text, flags: response.flags }
    // A result released or lost meanwhile keeps nothing.
    if (this.results.get(state.id) === state) this.windows.set(WindowCache.key(state.id, start, Math.floor(count), colStart, colEnd, maxCellChars, display), state.id, window)
    return window
  }
}
