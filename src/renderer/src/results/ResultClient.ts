// The renderer's access to stored query results (the PR7 grid contract). Rows stay in the backend; the results worker
// reads and decodes pages, and the UI thread receives only windows of display text.
import type { BackendStatus, QueryEvent, QueryResult, ResultColumn, ResultDescriptor, TruncationReason, VariaApi, WireKind } from '../../../shared/contracts'
import { limits as wire, type ErrorCode } from '../../../shared/ipc/wire/protocol'
import type { Disposable } from '../core/types'
import type { ResultKey, WorkerRequest, WorkerResponse } from './worker-protocol'

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
  /** Per cell: 1 NULL, 2 truncated, 4 read error, 8 over the window's text budget. */
  flags: Uint8Array
}
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
export interface WindowOptions { colStart?: number; colEnd?: number; maxCellChars?: number; textBudget?: number; signal?: AbortSignal }
export interface ResultHandle extends Disposable {
  readonly key: ResultKey
  readonly columns: readonly ResultColumn[]
  getSnapshot(): ResultSnapshot
  /** Progress and closed events, coalesced per animation frame. */
  subscribe(listener: () => void): () => void
  /** Up to 4,096 rows of display text; `count` shrinks to the rows available. */
  getWindow(first: number, count: number, o?: WindowOptions): Promise<RowWindow>
  /** A window this handle fetched recently (the last 64), without asking the worker. */
  peekWindow(first: number, count: number, colStart?: number, colEnd?: number): RowWindow | undefined
  prefetch(first: number, count: number): void
  /** The full stored value of one cell. */
  getCell(row: number, col: number, signal?: AbortSignal): Promise<{ text: string; isNull: boolean; truncated: boolean }>
  /** Releases the result in the backend (results.close). */
  close(): Promise<void>
}

const decoderFailed = 'Results cannot be displayed; reload the workbench.'
const workerStopped = 'The results worker stopped. Try again.'
const unavailable = 'These results are no longer available because the SQL backend restarted.'
const released = 'These results were closed. Execute the query again to see them.'
const windowCacheSize = 64

interface ResultState {
  readonly key: ResultKey
  readonly columns: readonly ResultColumn[]
  readonly wires: readonly WireKind[]
  snapshot: ResultSnapshot
  readonly listeners: Set<() => void>
  readonly windows: Map<string, RowWindow>
  scheduled: boolean
}
interface Pending { resolve(message: WorkerResponse): void; reject(error: Error): void }

const keyOf = (key: ResultKey): string => `${key.generation}:${key.resultId}`
const abortError = (): Error => new DOMException('The request was aborted.', 'AbortError')

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
  private worker: WorkerLike
  private attached!: Promise<void>
  private resolveAttached!: () => void
  private rejectAttached!: (error: Error) => void
  private expecting = false
  private restarts: number[] = []
  private failure: string | undefined
  private nextId = 1
  private generation = 0
  private status: BackendStatus = 'starting'
  private disposed = false

  constructor(o: { api: Pick<VariaApi, 'openResultsPort'>; createWorker: () => WorkerLike; window: WindowLike; now?: () => number; schedule?: (callback: () => void) => void }) {
    this.api = o.api
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
  get backendStatus(): BackendStatus { return this.status }

  open(descriptor: ResultDescriptor): ResultHandle {
    const state = this.state(descriptor)
    const listeners = new Set<() => void>()
    const handle: ResultHandle = {
      key: state.key,
      columns: state.columns,
      getSnapshot: () => state.snapshot,
      subscribe: listener => {
        listeners.add(listener)
        state.listeners.add(listener)
        return () => { listeners.delete(listener); state.listeners.delete(listener) }
      },
      getWindow: (first, count, o = {}) => this.fetchWindow(state, first, count, o),
      peekWindow: (first, count, colStart = 0, colEnd = state.columns.length) => {
        const window = state.windows.get(`${first}:${count}:${colStart}:${colEnd}`)
        if (window) { state.windows.delete(`${first}:${count}:${colStart}:${colEnd}`); state.windows.set(`${first}:${count}:${colStart}:${colEnd}`, window) }
        return window
      },
      prefetch: (first, count) => {
        if (state.snapshot.state === 'lost' || state.snapshot.state === 'released' || this.failure) return
        void this.attached.then(() => this.worker.postMessage({ type: 'prefetch', key: state.key, wires: state.wires, first, count: Math.min(count, state.snapshot.rowsAvailable - first) }), () => {})
      },
      getCell: async (row, col, signal) => {
        this.usable(state)
        const response = await this.request(id => ({ type: 'cell', id, key: state.key, wires: state.wires, row, col }), signal)
        if (response.type !== 'cell') throw new ResultError('RESULT_DECODER_FAILED', workerStopped)
        return { text: response.text, isNull: response.isNull, truncated: response.truncated }
      },
      close: () => this.release([{ generation: state.key.generation, resultId: state.key.resultId }]),
      dispose: () => { for (const listener of listeners) state.listeners.delete(listener); listeners.clear() }
    }
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

  /** Releases results in the backend (results.close); their pages leave the worker's cache. */
  async release(keys: readonly ResultKey[]): Promise<void> {
    const byGeneration = new Map<number, number[]>()
    for (const key of keys) {
      const state = this.results.get(keyOf(key))
      if (state) this.publish(state, { ...state.snapshot, state: state.snapshot.state === 'lost' ? 'lost' : 'released' })
      byGeneration.set(key.generation, [...byGeneration.get(key.generation) ?? [], key.resultId])
    }
    for (const [generation, ids] of byGeneration) {
      for (let at = 0; at < ids.length; at += 1024) {
        const resultIds = ids.slice(at, at + 1024)
        await this.request(id => ({ type: 'close', id, generation, resultIds }))
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.window.removeEventListener('message', this.onWindowMessage)
    this.worker.terminate()
    this.rejectAll(new ResultError('PORT_CLOSED', 'The workbench closed.'))
    this.queryListeners.clear()
    this.memoryListeners.clear()
  }

  private startWorker(): WorkerLike {
    const worker = this.createWorker()
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
    this.resolveAttached()
  }

  private workerFailed(): void {
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
      case 'window': case 'cell': case 'closed': {
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
    for (const state of this.results.values()) if (state.key.generation !== generation && state.snapshot.state !== 'lost') this.publish(state, { ...state.snapshot, state: 'lost' })
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
      key, columns: descriptor.columns, wires: descriptor.columns.map(column => column.wire), listeners: new Set(), windows: new Map(), scheduled: false,
      snapshot: { rowsRead: 0, rowsStored: 0, rowsAvailable: 0, bytesStored: 0, truncatedCells: 0, state: 'open', incomplete: false }
    }
    this.results.set(keyOf(key), state)
    this.update(state, descriptor, false)
    if (this.generation !== 0 && key.generation !== this.generation) state.snapshot = { ...state.snapshot, state: 'lost' }
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

  private async fetchWindow(state: ResultState, first: number, count: number, o: WindowOptions): Promise<RowWindow> {
    this.usable(state)
    const colStart = Math.max(0, Math.min(state.columns.length, o.colStart ?? 0))
    const colEnd = Math.max(colStart, Math.min(state.columns.length, o.colEnd ?? state.columns.length))
    const start = Math.max(0, Math.floor(first))
    const width = Math.max(1, colEnd - colStart)
    const rows = Math.max(0, Math.min(Math.floor(count), wire.worker.windowRows, Math.floor(wire.worker.windowCells / width), state.snapshot.rowsAvailable - start))
    if (rows === 0) return { first: start, count: 0, colStart, colEnd, text: [], flags: new Uint8Array(0) }
    const response = await this.request(id => ({
      type: 'window', id, key: state.key, wires: state.wires, first: start, count: rows, colStart, colEnd,
      maxCellChars: Math.min(o.maxCellChars ?? wire.worker.displayCharacters, wire.cell.document), textBudget: Math.min(o.textBudget ?? 1_000_000, wire.worker.windowCharacters)
    }), o.signal)
    if (response.type !== 'window') throw new ResultError('RESULT_DECODER_FAILED', workerStopped)
    const window: RowWindow = { first: response.first, count: response.count, colStart: response.colStart, colEnd: response.colEnd, text: response.text, flags: response.flags }
    const cacheKey = `${start}:${Math.floor(count)}:${colStart}:${colEnd}`
    state.windows.delete(cacheKey)
    state.windows.set(cacheKey, window)
    if (state.windows.size > windowCacheSize) state.windows.delete(state.windows.keys().next().value!)
    return window
  }
}
