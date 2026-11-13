import type { BackendState, BackendStatus, QueryEvent, QueryResult, ResultDescriptor, ResultsCloseResult, ResultsDiffParams, ResultsDiffResult, ResultsDistinctCloseParams, ResultsDistinctCloseResult, ResultsDistinctParams, ResultsDistinctReadParams, ResultsDistinctReadResult, ResultsDistinctResult, ResultsDistinctTickParams, ResultsDistinctTickResult, ResultsFindRowsParams, ResultsFindRowsResult, ResultsIdentifyParams, ResultsIdentifyResult, ResultsPivotParams, ResultsPivotResult, ResultsProfileParams, ResultsProfileResult, ResultsReadParams, ResultsReadResult, ResultsRowBytesParams, ResultsRowBytesResult, ResultsRowIdsParams, ResultsRowIdsResult, ResultsSearchParams, ResultsSearchResult, ResultsViewCloseParams, ResultsViewCloseResult, ResultsViewParams, ResultsViewResult, ViewCells, ViewFilter } from '../../shared/contracts'
import { diffResultSchema, distinctCloseResultSchema, distinctReadResultSchema, distinctResultSchema, distinctTickResultSchema, findRowsResultSchema, identifyResultSchema, type MemoryFeature, type MemoryReport, pivotResultSchema, type PortEndResult, type PortMessage, type PortRequest, portRequestSchema, profileResultSchema, rowBytesResultSchema, rowIdsResultSchema, searchResultSchema, testPortRequestSchema, viewCloseResultSchema, viewResultSchema } from '../../shared/ipc/port-messages'
import { liveDescriptors, liveRetired, type LiveEnd, type LiveEvent, type LiveSubscribeParams, type LiveUpdateParams, type LiveUpdateResult } from '../../shared/live/schema'
import { cancelReasons, limits as wire, type CancelReason, type ErrorCode } from '../../shared/ipc/wire/protocol'
import type { StreamSink } from './connection'
import { BackendError, sentences } from './errors'
import type { BackendSupervisor } from './supervisor'

/** The parts of Electron's MessagePortMain the host uses. */
export interface PortMainLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  start(): void
  close(): void
}
/** The renderer frame that asked for the port (WebFrameMain). */
export interface FrameLike { postMessage(channel: string, message: unknown, transfer: never[]): void }
export interface ReadStream { readonly done: Promise<unknown>; credit(bytes: number): void; cancel(reason: CancelReason): void }
/** A live subscription in the backend: its events arrive through `onLive`, its credit acknowledges them, and `done`
 *  settles with its end. */
export interface LiveStreamHandle { readonly done: Promise<LiveEnd>; credit(bytes: number): void; cancel(reason: CancelReason): void }
/** What the host needs from the backend; supervisorResults adapts BackendSupervisor. */
export interface ResultsBackend {
  /** The generation whose results can be read now, or undefined while none is ready. */
  readyGeneration(): number | undefined
  read(generation: number, params: ResultsReadParams, sink: StreamSink, credit: number): ReadStream
  close(generation: number, resultIds: number[]): Promise<ResultsCloseResult>
  rowBytes(generation: number, params: ResultsRowBytesParams): Promise<ResultsRowBytesResult>
  /** A sort may take seconds: the worker's cancel (a newer sort, or the view no longer wanted) stops it. */
  view(generation: number, params: ResultsViewParams): { readonly done: Promise<ResultsViewResult>; cancel(reason: CancelReason): void }
  viewClose(generation: number, params: ResultsViewCloseParams): Promise<ResultsViewCloseResult>
  /** Hashing a result's rows may take seconds: the worker's cancel stops it, as it does a sort. */
  identify(generation: number, params: ResultsIdentifyParams): { readonly done: Promise<ResultsIdentifyResult>; cancel(reason: CancelReason): void }
  rowIds(generation: number, params: ResultsRowIdsParams): Promise<ResultsRowIdsResult>
  findRows(generation: number, params: ResultsFindRowsParams): Promise<ResultsFindRowsResult>
  /** Comparing two results may take seconds: the worker's cancel stops it, as it does a sort. */
  diff(generation: number, params: ResultsDiffParams): { readonly done: Promise<ResultsDiffResult>; cancel(reason: CancelReason): void }
  /** Pivoting a result may take seconds: the worker's cancel stops it, as it does a sort. */
  pivot(generation: number, params: ResultsPivotParams): { readonly done: Promise<ResultsPivotResult>; cancel(reason: CancelReason): void }
  /** A search reads every stored row: the worker's cancel (a newer search, or the text cleared) stops it. */
  search(generation: number, params: ResultsSearchParams): { readonly done: Promise<ResultsSearchResult>; cancel(reason: CancelReason): void }
  /** A profile reads every row: the worker's cancel (a newer profile, or the panel closed) stops it. */
  profile(generation: number, params: ResultsProfileParams): { readonly done: Promise<ResultsProfileResult>; cancel(reason: CancelReason): void }
  /** A distinct snapshot reads every row of a column: the worker's cancel (the popover closed) stops building it. */
  distinct(generation: number, params: ResultsDistinctParams): { readonly done: Promise<ResultsDistinctResult>; cancel(reason: CancelReason): void }
  /** A window of a snapshot; a new search scans its values, so the worker's cancel (a newer search) stops it. */
  distinctRead(generation: number, params: ResultsDistinctReadParams): { readonly done: Promise<ResultsDistinctReadResult>; cancel(reason: CancelReason): void }
  distinctTick(generation: number, params: ResultsDistinctTickParams): Promise<ResultsDistinctTickResult>
  distinctClose(generation: number, params: ResultsDistinctCloseParams): Promise<ResultsDistinctCloseResult>
  live(generation: number, params: LiveSubscribeParams, onLive: (event: LiveEvent, bytes: number) => void, credit: number): LiveStreamHandle
  liveUpdate(generation: number, params: LiveUpdateParams): Promise<LiveUpdateResult>
}
export interface PortLimits { outstanding: number; invalidMessages: number; opensPerMinute: number; ownedResults: number; perStream: number; perPort: number; liveStreams: number }
export const portLimits: PortLimits = { ...wire.port, ownedResults: wire.registries.ownedResults, perStream: wire.credit.perStream, perPort: wire.credit.perPort, liveStreams: wire.live.portStreams }

/**
 * Exactly one ArrayBuffer of exactly the page's bytes. Posting a view would structured-clone its whole backing store,
 * which for a pooled Node Buffer is unrelated memory; pages from the frame parser already own an exact buffer.
 */
export function toExactArrayBuffer(body: Uint8Array): ArrayBuffer {
  if (body.byteOffset === 0 && body.byteLength === body.buffer.byteLength && body.buffer instanceof ArrayBuffer) return body.buffer
  return body.slice().buffer as ArrayBuffer
}

/** `withheld` is credit the worker granted that the port's limits held back; it is passed on once there is room. */
interface Stream { readonly rid: number; readonly generation: number; granted: number; received: number; withheld: number; handle?: ReadStream }
/** `ids` are the results this stream's ticks named: the only ones its `retired` lists and its end may take back.
 *  `snapshots` names the table (probe/index) of each snapshot revision not yet retired, and `newest` each table's latest. */
interface LiveStream {
  readonly rid: number; readonly generation: number; readonly subscriptionId: string; readonly source: string; readonly ids: Set<number>
  readonly snapshots: Map<number, string>; readonly newest: Map<string, number>; granted: number; received: number; withheld: number; handle?: LiveStreamHandle
}

/**
 * Main's end of the results port: one MessagePort per renderer load, through which the results worker reads pages and
 * receives query events. Every worker message is validated (portRequestSchema), reads are limited to results the
 * current generation owns, credits are clamped (16 MiB per stream, 64 MiB per port), and page bodies are forwarded
 * without being decoded, as exact-size ArrayBuffers. A backend loss ends the streams but keeps the port: the port lives
 * as long as the renderer. Live subscriptions (at most 16, counted apart from the 64 outstanding requests) are streams of
 * EVENTs whose credit the worker grants back once the page applied each one; their tables become readable as they
 * arrive, and only their own results leave again when a tick retires them or the stream ends.
 */
export class ResultsPortHost {
  private readonly backend: ResultsBackend
  private readonly createChannel: () => { port1: PortMainLike; port2: unknown }
  private readonly now: () => number
  private readonly limits: PortLimits
  private readonly streams = new Map<number, Stream>()
  private readonly lives = new Map<number, LiveStream>()
  /** Live streams by subscription id: a second subscribe with the same id is refused. */
  private readonly subscriptions = new Map<string, number>()
  private readonly schema: typeof portRequestSchema
  /** Result ids the current generation holds for this renderer, oldest first, with their column count when a descriptor
   *  named it (search answers are bounded by it). */
  private readonly owned = new Map<number, number | undefined>()
  private readonly latestMemory = new Map<MemoryFeature, Extract<PortMessage, { t: 'memory' }>>()
  private port: PortMainLike | undefined
  private generation = 0
  private status: BackendStatus = 'stopped'
  private closing = 0
  private updating = 0
  /** results.view and results.profile requests in flight, by rid, so the worker's cancel reaches them. */
  private readonly sorting = new Map<number, { cancel(reason: CancelReason): void }>()
  /** results.search requests in flight, by rid, likewise. */
  private readonly searching = new Map<number, { cancel(reason: CancelReason): void }>()
  private invalid = 0
  private opens: number[] = []

  /** `testSources`: accept test-only live sources (debug.synthetic); main sets it only for unpackaged smoke runs. `schema`
   *  replaces the request schema (tests, with a catalogue the shipped one does not match yet). */
  constructor(o: { backend: ResultsBackend; createChannel: () => { port1: PortMainLike; port2: unknown }; now?: () => number; limits?: Partial<PortLimits>; testSources?: boolean; schema?: typeof portRequestSchema }) {
    this.backend = o.backend
    this.schema = o.schema ?? (o.testSources ? testPortRequestSchema : portRequestSchema)
    this.createChannel = o.createChannel
    this.now = o.now ?? (() => Date.now())
    this.limits = { ...portLimits, ...o.limits }
  }

  get isOpen(): boolean { return !!this.port }
  get ownedCount(): number { return this.owned.size }
  get liveCount(): number { return this.lives.size }
  /** The snapshot revisions the live streams name and have not retired (each stream's `snapshots`), for tests of its bound. */
  get liveSnapshotCount(): number { let count = 0; for (const stream of this.lives.values()) count += stream.snapshots.size; return count }

  /** A new port for the frame (after trusted()); the previous one closes and its streams are cancelled. */
  open(frame: FrameLike): void {
    const now = this.now()
    this.opens = this.opens.filter(at => now - at < 60_000)
    if (this.opens.length >= this.limits.opensPerMinute) throw new Error('The results connection was reopened too often. Reload the workbench.')
    this.opens.push(now)
    this.close()
    const { port1, port2 } = this.createChannel()
    this.port = port1
    this.invalid = 0
    port1.on('message', event => { if (this.port === port1) this.receive(event.data) })
    port1.on('close', () => { if (this.port === port1) this.close() })
    port1.start()
    frame.postMessage('varia:results-port', { generation: this.generation }, [port2 as never])
    this.post({ t: 'backend', generation: this.generation, status: this.status })
    for (const report of this.latestMemory.values()) this.post(report)
  }

  /** A new page load (reload, crash or window close): the port closes and earlier opens stop counting, so the rate
   *  limit applies to reopens within one load. */
  reset(): void {
    this.close()
    this.opens = []
  }

  /** The port and its streams end. Ownership of query results stays with the generation; live streams' results go. */
  close(): void {
    const port = this.port
    this.port = undefined
    for (const stream of this.streams.values()) stream.handle?.cancel(cancelReasons.consumerGone)
    this.streams.clear()
    // A cancelled subscription releases its results in the backend, so this renderer may no longer read them.
    for (const stream of this.lives.values()) {
      stream.handle?.cancel(cancelReasons.consumerGone)
      this.disown(stream, [])
    }
    this.lives.clear()
    this.subscriptions.clear()
    for (const sort of this.sorting.values()) sort.cancel(cancelReasons.consumerGone)
    this.sorting.clear()
    // A search's answer is dropped once its port is gone, so it is stopped here: left in the map it would count as busy
    // for good and refuse its rid in the next page.
    for (const search of this.searching.values()) search.cancel(cancelReasons.consumerGone)
    this.searching.clear()
    this.closing = 0
    this.updating = 0
    try { port?.close() } catch { /* Already closed. */ }
  }

  /** Every backend state; a new generation drops the previous generation's results. */
  backendState(state: BackendState): void {
    const generation = 'generation' in state ? state.generation : 0
    if (generation !== this.generation) {
      this.generation = generation
      this.owned.clear()
      this.latestMemory.clear()
    }
    if (state.status === 'restarting') this.latestMemory.clear()
    this.status = state.status
    this.post({ t: 'backend', generation, status: state.status })
  }

  /** Results the renderer may read: from a query summary or event, or the test hooks. */
  own(descriptors: readonly (Pick<ResultDescriptor, 'generation' | 'resultId'> & { readonly columns?: readonly unknown[] })[]): void {
    for (const { generation, resultId, columns } of descriptors) {
      if (generation === this.generation) this.keep(resultId, columns?.length)
    }
  }

  /** Owns a result as the newest, keeping the column count known before when this one names none. */
  private keep(resultId: number, columns: number | undefined): void {
    const known = columns ?? this.owned.get(resultId)
    this.owned.delete(resultId)
    this.owned.set(resultId, known)
    if (this.owned.size > this.limits.ownedResults) this.owned.delete(this.owned.keys().next().value!)
  }

  /** Whether this renderer may use the result: the current generation holds it for this renderer (copy and save). */
  owns(generation: number, resultId: number): boolean { return generation === this.generation && this.owned.has(resultId) }

  /**
   * For a live snapshot table's revision this renderer owns: a function that names the table's newest revision it owns
   * when called (undefined once it no longer owns one: the stream ended without keeping it). Save Results As asks before
   * its dialog, which may stay open for many samples while each revision is retired two samples on, and saves the revision
   * the table has once the file is chosen; a source that ended meanwhile keeps its newest revision, which is saved.
   * Undefined for any other result.
   */
  liveNewest(generation: number, resultId: number): (() => number | undefined) | undefined {
    if (!this.owns(generation, resultId)) return undefined
    for (const stream of this.lives.values()) {
      const table = stream.generation === generation ? stream.snapshots.get(resultId) : undefined
      if (table === undefined) continue
      return () => {
        const newest = stream.newest.get(table)
        // Ownership alone decides: a stream's end disowns its results except those its source kept (still shown, saved until
        // results.close), and a port's close or a new generation disowns them all.
        return newest !== undefined && this.owns(generation, newest) ? newest : undefined
      }
    }
    return undefined
  }

  queryEvent(queryId: string, event: QueryEvent): void {
    if (event.type === 'resultSet.opened') this.own([event.descriptor])
    this.post({ t: 'query', queryId, event })
  }

  querySummary(summary: QueryResult): void {
    this.own(summary.resultSets)
    if (summary.planSets) this.own(summary.planSets)
    this.rememberMemory('results', summary.budget)
  }

  memory(feature: MemoryFeature, report: MemoryReport): void {
    const message = this.rememberMemory(feature, report)
    if (message) this.post(message)
  }

  /** Retain the newest samples for a port opened after the backend's initial reports or after a reload. */
  private rememberMemory(feature: MemoryFeature, { generation, seq, usedBytes, globalBytes }: MemoryReport) {
    if (generation !== this.generation || this.status === 'restarting' || seq <= (this.latestMemory.get(feature)?.seq ?? 0)) return
    const message = { t: 'memory', feature, generation, seq, usedBytes, globalBytes } as const
    this.latestMemory.set(feature, message)
    return message
  }

  private receive(data: unknown): void {
    const parsed = this.schema.safeParse(data)
    if (!parsed.success) {
      const rid = data !== null && typeof data === 'object' ? (data as { rid?: unknown }).rid : undefined
      if (typeof rid === 'number' && Number.isInteger(rid) && rid > 0 && rid < 2 ** 31) this.end(rid, 'INVALID_REQUEST', 'The results request was invalid.')
      if (++this.invalid >= this.limits.invalidMessages) this.close()
      return
    }
    const request = parsed.data
    switch (request.t) {
      case 'read': return this.read(request)
      case 'credit': return this.credit(request.rid, request.bytes)
      case 'cancel':
        (this.streams.get(request.rid) ?? this.lives.get(request.rid))?.handle?.cancel(cancelReasons.user)
        this.sorting.get(request.rid)?.cancel(cancelReasons.user)
        this.searching.get(request.rid)?.cancel(cancelReasons.user)
        return
      case 'close': return this.closeResults(request)
      case 'rowBytes': return this.rowBytes(request)
      case 'view': return this.view(request)
      case 'viewClose': return this.viewClose(request)
      case 'identify': return this.identify(request)
      case 'rowIds': return this.rowIds(request)
      case 'findRows': return this.findRows(request)
      case 'diff': return this.diff(request)
      case 'pivot': return this.pivot(request)
      case 'search': return this.search(request)
      case 'profile': return this.profile(request)
      case 'distinct': return this.distinct(request)
      case 'distinctRead': return this.distinctRead(request)
      case 'distinctTick': return this.distinctTick(request)
      case 'distinctClose': return this.distinctClose(request)
      case 'live': return this.live(request)
      case 'liveUpdate': return this.liveUpdate(request)
    }
  }

  private outstanding(): number {
    let total = 0
    for (const stream of this.streams.values()) total += Math.max(0, stream.granted - stream.received)
    for (const stream of this.lives.values()) total += Math.max(0, stream.granted - stream.received)
    return total
  }

  /** Requests counted against the 64 outstanding: reads, closes, sorts, searches, row sizes and live updates (live streams
   *  have their own cap). */
  private busy(): number { return this.streams.size + this.closing + this.updating + this.sorting.size + this.searching.size }

  private read(request: Extract<PortRequest, { t: 'read' }>): void {
    const { rid } = request
    if (this.streams.has(rid) || this.lives.has(rid)) return this.end(rid, 'INVALID_REQUEST', 'The results request was invalid.')
    if (this.busy() >= this.limits.outstanding) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.tooMany)
    if (request.generation !== this.generation || this.backend.readyGeneration() !== request.generation || !this.owned.has(request.resultId)) return this.end(rid, 'RESULT_UNAVAILABLE', sentences.resultUnavailable)
    const credit = Math.min(request.credit, Math.max(wire.credit.min, this.limits.perPort - this.outstanding()))
    const stream: Stream = { rid, generation: request.generation, granted: credit, received: 0, withheld: 0 }
    this.streams.set(rid, stream)
    const port = this.port
    const sink: StreamSink = {
      data: (seq, body) => {
        stream.received += body.byteLength
        if (this.streams.get(rid) !== stream) return
        this.post({ t: 'page', rid, seq, body: toExactArrayBuffer(new Uint8Array(body)) })
        this.grantWithheld()
      }
    }
    const params: ResultsReadParams = { resultId: request.resultId, firstRow: request.firstRow, maxRows: request.maxRows }
    if (request.viewId !== undefined) params.viewId = request.viewId
    stream.handle = this.backend.read(request.generation, params, sink, credit)
    stream.handle.done.then(result => {
      if (this.streams.get(rid) !== stream || this.port !== port) return
      this.streams.delete(rid)
      this.post({ t: 'end', rid, ok: true, result: result as ResultsReadResult })
      this.grantWithheld()
    }, error => {
      if (this.streams.get(rid) !== stream || this.port !== port) return
      this.streams.delete(rid)
      this.fail(rid, error)
      this.grantWithheld()
    })
  }

  /** Credit from the worker, after it cached a page; clamped to what the stream and the port may have outstanding. The
   *  worker grants only when a page arrives, so what the limits hold back is kept and passed on as room frees up:
   *  otherwise a stream left without credit would never receive another page. */
  private credit(rid: number, bytes: number): void {
    const live = this.lives.get(rid)
    if (live?.handle) {
      // An acknowledgement returns at most what the stream's events took, so it can never make room for a second frame.
      live.withheld = Math.max(0, Math.min(wire.live.initialCredit - (live.granted - live.received), live.withheld + bytes))
      return this.grant(live)
    }
    const stream = this.streams.get(rid)
    if (!stream?.handle) return
    stream.withheld = Math.min(this.limits.perStream, stream.withheld + bytes)
    this.grant(stream)
  }

  private grant(stream: Stream | LiveStream): void {
    const grant = Math.min(stream.withheld, this.limits.perStream - (stream.granted - stream.received), this.limits.perPort - this.outstanding())
    if (!(grant >= 1) || !stream.handle) return
    stream.withheld -= grant
    stream.granted += grant
    stream.handle.credit(grant)
  }

  private grantWithheld(): void {
    for (const stream of this.streams.values()) if (stream.withheld > 0) this.grant(stream)
    for (const stream of this.lives.values()) if (stream.withheld > 0) this.grant(stream)
  }

  private live(request: Extract<PortRequest, { t: 'live' }>): void {
    const { rid, params } = request
    if (this.streams.has(rid) || this.lives.has(rid)) return this.end(rid, 'INVALID_REQUEST', 'The results request was invalid.')
    if (this.lives.size >= this.limits.liveStreams) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.liveTooMany)
    if (request.generation !== this.generation || this.backend.readyGeneration() !== request.generation) return this.end(rid, 'RESULT_UNAVAILABLE', sentences.resultUnavailable)
    if (this.subscriptions.has(params.subscriptionId)) return this.end(rid, 'DUPLICATE_REQUEST', sentences.liveDuplicate)
    const credit = wire.live.initialCredit
    const stream: LiveStream = { rid, generation: request.generation, subscriptionId: params.subscriptionId, source: params.source, ids: new Set(), snapshots: new Map(), newest: new Map(), granted: credit, received: 0, withheld: 0 }
    this.lives.set(rid, stream)
    this.subscriptions.set(params.subscriptionId, rid)
    const port = this.port
    const onLive = (event: LiveEvent, bytes: number) => {
      stream.received += bytes
      if (this.lives.get(rid) !== stream) return
      const descriptors = liveDescriptors(event)
      this.own(descriptors)
      for (const descriptor of descriptors) stream.ids.add(descriptor.resultId)
      if (event.type === 'live.tick') {
        for (const sample of event.samples) for (const entry of sample.tables ?? []) {
          const table = sample.probe + '/' + entry.table
          stream.snapshots.set(entry.descriptor.resultId, table)
          stream.newest.set(table, entry.descriptor.resultId)
        }
      }
      // A tick can never take back results it did not deliver: a query's, or another stream's.
      for (const id of liveRetired(event)) if (stream.ids.delete(id)) { this.owned.delete(id); stream.snapshots.delete(id) }
      this.post({ t: 'live', rid, bytes, event })
    }
    stream.handle = this.backend.live(request.generation, params, onLive, credit)
    stream.handle.done.then(result => {
      if (this.lives.get(rid) !== stream || this.port !== port) {
        // The port closed (and disowned the stream's results) while the source was ending: nothing can read or close what
        // it kept, so main closes it, rather than leave it counted against the result budget until the backend restarts.
        if (result.ended === 'sourceEnded' && result.kept?.length && stream.generation === this.generation && this.backend.readyGeneration() === stream.generation) {
          this.backend.close(stream.generation, result.kept).catch(() => { /* The backend went away; its results went with it. */ })
        }
        return
      }
      this.forgetLive(stream)
      this.disown(stream, result.ended === 'sourceEnded' ? result.kept ?? [] : [])
      this.post({ t: 'end', rid, ok: true, result })
      this.grantWithheld()
    }, error => {
      if (this.lives.get(rid) !== stream || this.port !== port) return
      this.forgetLive(stream)
      this.disown(stream, [])
      this.fail(rid, error)
      this.grantWithheld()
    })
  }

  private liveUpdate(request: Extract<PortRequest, { t: 'liveUpdate' }>): void {
    const { rid, params } = request
    if (this.streams.has(rid) || this.lives.has(rid)) return this.end(rid, 'INVALID_REQUEST', 'The results request was invalid.')
    if (this.busy() >= this.limits.outstanding) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.tooMany)
    const live = this.lives.get(this.subscriptions.get(params.subscriptionId) ?? 0)
    if (!live || live.generation !== request.generation) return this.end(rid, 'NOT_FOUND', sentences.liveEnded)
    if (live.source !== params.source) return this.end(rid, 'INVALID_REQUEST', 'The results request was invalid.')
    if (this.backend.readyGeneration() !== request.generation) return this.end(rid, 'RESULT_UNAVAILABLE', sentences.resultUnavailable)
    const port = this.port
    this.updating++
    this.backend.liveUpdate(request.generation, params).then(result => {
      if (this.port !== port) return
      this.updating--
      this.post({ t: 'end', rid, ok: true, result })
    }, error => {
      if (this.port !== port) return
      this.updating--
      this.fail(rid, error)
    })
  }

  private forgetLive(stream: LiveStream): void {
    this.lives.delete(stream.rid)
    if (this.subscriptions.get(stream.subscriptionId) === stream.rid) this.subscriptions.delete(stream.subscriptionId)
  }

  /** The stream's results leave what this renderer may read, except those its source kept (closed by results.close). */
  private disown(stream: LiveStream, kept: readonly number[]): void {
    const keep = new Set(kept)
    // A later generation numbers its results afresh: an earlier stream's ids may now name other results.
    if (stream.generation === this.generation) for (const id of stream.ids) if (!keep.has(id)) this.owned.delete(id)
    stream.ids.clear()
  }

  private closeResults(request: Extract<PortRequest, { t: 'close' }>): void {
    const { rid } = request
    if (this.busy() >= this.limits.outstanding) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.tooMany)
    // Results of an earlier generation are already gone with it.
    const columns = new Map(request.resultIds.map(id => [id, this.owned.get(id)]))
    const ids = request.generation === this.generation ? request.resultIds.filter(id => this.owned.delete(id)) : []
    if (ids.length === 0 || this.backend.readyGeneration() !== request.generation) {
      this.post({ t: 'end', rid, ok: true, result: { closed: 0, usedBytes: 0 } })
      return
    }
    const port = this.port
    this.closing++
    this.backend.close(request.generation, ids).then(result => {
      if (this.port !== port) return
      this.closing--
      this.post({ t: 'end', rid, ok: true, result })
    }, error => {
      if (this.port !== port) return
      this.closing--
      // The backend may not have released them (a TOO_MANY_REQUESTS refusal never reached it): the renderer may close
      // them again, so they stay its own; closing a result the backend already released closes nothing.
      if (request.generation === this.generation) for (const id of ids) this.keep(id, columns.get(id))
      this.fail(rid, error)
    })
  }

  /** Row sizes of a result this renderer owns in the current generation; counted with live updates against the 64. */
  private rowBytes(request: Extract<PortRequest, { t: 'rowBytes' }>): void {
    const { rid } = request
    if (this.busy() >= this.limits.outstanding) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.tooMany)
    if (request.generation !== this.generation || this.backend.readyGeneration() !== request.generation || !this.owned.has(request.resultId)) return this.end(rid, 'RESULT_UNAVAILABLE', sentences.resultUnavailable)
    const port = this.port
    this.updating++
    const params: ResultsRowBytesParams = { resultId: request.resultId, firstRow: request.firstRow, count: request.count }
    if (request.viewId !== undefined) params.viewId = request.viewId
    this.backend.rowBytes(request.generation, params).then(result => {
      if (this.port !== port) return
      this.updating--
      // Backend output is bounded before the renderer sees it: the range asked, at most as many rows as asked or as exist.
      const parsed = rowBytesResultSchema.safeParse(result)
      const answered = parsed.success ? parsed.data : undefined
      const rowsIn = (rows: number[], from: number, to: number) => rows.every((row, index) => row >= from && row < to && (index === 0 || row > rows[index - 1]))
      if (!answered || answered.firstRow !== request.firstRow || answered.bytes.length > Math.min(request.count, Math.max(0, answered.rowsAvailable - answered.firstRow))
        || !rowsIn(answered.estimated, answered.firstRow, answered.firstRow + answered.bytes.length)) return this.end(rid, 'BACKEND_ERROR', 'The results could not be read.')
      this.post({ t: 'end', rid, ok: true, result: answered })
    }, error => {
      if (this.port !== port) return
      this.updating--
      this.fail(rid, error)
    })
  }

  /** A view of a result this renderer owns: views belong to their result in the backend, which refuses another result's
   *  view id, so main checks only the result. */
  private view(request: Extract<PortRequest, { t: 'view' }>): void {
    const { rid } = request
    if (this.sorting.has(rid)) return this.end(rid, 'INVALID_REQUEST', 'The results request was invalid.')
    if (this.busy() >= this.limits.outstanding) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.tooMany)
    if (!this.current(request.generation, request.resultId)) return this.end(rid, 'RESULT_UNAVAILABLE', sentences.resultUnavailable)
    const port = this.port
    const params: ResultsViewParams = { resultId: request.resultId, sort: request.sort.map(key => ({ ...key })) }
    if (request.filters) params.filters = request.filters.map(copyFilter)
    if (request.replaces !== undefined) params.replaces = request.replaces
    const sort = this.backend.view(request.generation, params)
    this.sorting.set(rid, sort)
    sort.done.then(result => {
      const parsed = viewResultSchema.safeParse(result)
      if (this.port !== port || this.sorting.get(rid) !== sort) {
        // Built after its port went (a reload): nobody can close the view, so main does.
        if (parsed.success) this.backend.viewClose(request.generation, { resultId: request.resultId, viewIds: [parsed.data.viewId] }).catch(() => {})
        return
      }
      this.sorting.delete(rid)
      // A filtered view answers each filter it was asked for, no more.
      if (!parsed.success || (parsed.data.filters?.length ?? 0) !== (request.filters?.length ?? 0)) return this.end(rid, 'BACKEND_ERROR', 'The results could not be sorted.')
      this.post({ t: 'end', rid, ok: true, result: parsed.data })
    }, error => {
      if (this.port !== port || this.sorting.get(rid) !== sort) return
      this.sorting.delete(rid)
      this.fail(rid, error)
    })
  }

  private viewClose(request: Extract<PortRequest, { t: 'viewClose' }>): void {
    const { rid } = request
    if (this.busy() >= this.limits.outstanding) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.tooMany)
    if (!this.current(request.generation, request.resultId)) return this.end(rid, 'RESULT_UNAVAILABLE', sentences.resultUnavailable)
    const port = this.port
    this.updating++
    this.backend.viewClose(request.generation, { resultId: request.resultId, viewIds: [...request.viewIds] }).then(result => {
      if (this.port !== port) return
      this.updating--
      const parsed = viewCloseResultSchema.safeParse(result)
      if (!parsed.success) return this.end(rid, 'BACKEND_ERROR', 'The results could not be read.')
      this.post({ t: 'end', rid, ok: true, result: parsed.data })
    }, error => {
      if (this.port !== port) return
      this.updating--
      this.fail(rid, error)
    })
  }

  /** A search of a result this renderer owns (through one of its views, which the backend checks belongs to it). Its answer
   *  is checked before the renderer sees it: matches in row then column order, inside the rows searched and on the side of
   *  `fromRow` asked, and a count that holds them. */
  private search(request: Extract<PortRequest, { t: 'search' }>): void {
    const { rid } = request
    if (this.searching.has(rid)) return this.end(rid, 'INVALID_REQUEST', 'The results request was invalid.')
    if (this.busy() >= this.limits.outstanding) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.tooMany)
    if (!this.current(request.generation, request.resultId)) return this.end(rid, 'RESULT_UNAVAILABLE', sentences.resultUnavailable)
    const port = this.port
    const columns = this.owned.get(request.resultId)
    const params: ResultsSearchParams = { resultId: request.resultId, text: request.text, fromRow: request.fromRow, maxMatches: request.maxMatches }
    if (request.backward) params.backward = true
    if (request.viewId !== undefined) params.viewId = request.viewId
    const search = this.backend.search(request.generation, params)
    this.searching.set(rid, search)
    search.done.then(result => {
      if (this.port !== port || this.searching.get(rid) !== search) return
      this.searching.delete(rid)
      const parsed = searchResultSchema.safeParse(result)
      if (!parsed.success || !searchAnswers(parsed.data, params, columns)) return this.end(rid, 'BACKEND_ERROR', 'The results could not be searched.')
      this.post({ t: 'end', rid, ok: true, result: parsed.data })
    }, error => {
      if (this.port !== port || this.searching.get(rid) !== search) return
      this.searching.delete(rid)
      this.fail(rid, error)
    })
  }

  /** A profile of a result this renderer owns (a view id is checked against its result by the backend). The answer is
   *  bounded before the renderer sees it: the columns asked, in order. */
  private profile(request: Extract<PortRequest, { t: 'profile' }>): void {
    const { rid } = request
    if (this.sorting.has(rid)) return this.end(rid, 'INVALID_REQUEST', 'The results request was invalid.')
    if (this.busy() >= this.limits.outstanding) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.tooMany)
    if (!this.current(request.generation, request.resultId)) return this.end(rid, 'RESULT_UNAVAILABLE', sentences.resultUnavailable)
    const port = this.port
    const params: ResultsProfileParams = { resultId: request.resultId, columns: [...request.columns] }
    if (request.viewId !== undefined) params.viewId = request.viewId
    const profile = this.backend.profile(request.generation, params)
    this.sorting.set(rid, profile)
    profile.done.then(result => {
      if (this.port !== port || this.sorting.get(rid) !== profile) return
      this.sorting.delete(rid)
      const parsed = profileResultSchema.safeParse(result)
      if (!parsed.success || parsed.data.columns.length !== request.columns.length || parsed.data.columns.some((column, index) => column.column !== request.columns[index]))
        return this.end(rid, 'BACKEND_ERROR', 'The results could not be profiled.')
      this.post({ t: 'end', rid, ok: true, result: parsed.data })
    }, error => {
      if (this.port !== port || this.sorting.get(rid) !== profile) return
      this.sorting.delete(rid)
      this.fail(rid, error)
    })
  }

  /** A distinct snapshot of a column of a result this renderer owns (a view id is checked against its result by the
   *  backend), cancelled and counted like a sort; the column is one the descriptor named. One built after its port went
   *  (a reload) is closed, since nobody else can. */
  private distinct(request: Extract<PortRequest, { t: 'distinct' }>): void {
    const columns = this.owned.get(request.resultId)
    if (columns !== undefined && request.column >= columns) return this.end(request.rid, 'INVALID_REQUEST', 'The results request was invalid.')
    const params: ResultsDistinctParams = { resultId: request.resultId, column: request.column }
    if (request.viewId !== undefined) params.viewId = request.viewId
    if (request.keptViewId !== undefined) params.keptViewId = request.keptViewId
    this.cancellable(request, () => this.backend.distinct(request.generation, params), result => {
      const parsed = distinctResultSchema.safeParse(result)
      return parsed.success ? parsed.data : undefined
    }, 'The column\'s values could not be listed.', result => {
      const parsed = distinctResultSchema.safeParse(result)
      if (parsed.success) this.backend.distinctClose(request.generation, { resultId: request.resultId, snapshotIds: [parsed.data.snapshotId] }).catch(() => {})
    })
  }

  /** A window of a distinct snapshot, cancelled like a sort; the answer is the window asked for, no more. */
  private distinctRead(request: Extract<PortRequest, { t: 'distinctRead' }>): void {
    const params: ResultsDistinctReadParams = { resultId: request.resultId, snapshotId: request.snapshotId, order: request.order, offset: request.offset, count: request.count }
    if (request.search !== undefined) params.search = request.search
    this.cancellable(request, () => this.backend.distinctRead(request.generation, params), result => {
      const parsed = distinctReadResultSchema.safeParse(result)
      return parsed.success && parsed.data.offset === request.offset && parsed.data.values.length <= request.count
        && parsed.data.values.length === Math.max(0, Math.min(request.count, parsed.data.total - request.offset)) ? parsed.data : undefined
    }, 'The column\'s values could not be listed.')
  }

  private distinctTick(request: Extract<PortRequest, { t: 'distinctTick' }>): void {
    const params: ResultsDistinctTickParams = { resultId: request.resultId, snapshotId: request.snapshotId, checked: request.checked }
    if (request.groups) params.groups = [...request.groups]
    if (request.all) params.all = true
    if (request.search !== undefined) params.search = request.search
    if (request.nulls !== undefined) params.nulls = request.nulls
    this.counted(request.rid, request.generation, request.resultId, () => this.backend.distinctTick(request.generation, params), result => {
      const parsed = distinctTickResultSchema.safeParse(result)
      return parsed.success ? parsed.data : undefined
    })
  }

  private distinctClose(request: Extract<PortRequest, { t: 'distinctClose' }>): void {
    this.counted(request.rid, request.generation, request.resultId, () => this.backend.distinctClose(request.generation, { resultId: request.resultId, snapshotIds: [...request.snapshotIds] }), result => {
      const parsed = distinctCloseResultSchema.safeParse(result)
      return parsed.success && parsed.data.closed <= request.snapshotIds.length ? parsed.data : undefined
    })
  }

  /** A request of a result this renderer owns that the worker's cancel stops, counted with sorts; `check` bounds its
   *  answer, and `orphan` cleans up after one that arrives once its port went. */
  private cancellable(request: { rid: number; generation: number; resultId: number }, run: () => { readonly done: Promise<unknown>; cancel(reason: CancelReason): void }, check: (result: unknown) => PortEndResult | undefined, failure: string, orphan?: (result: unknown) => void): void {
    const { rid } = request
    if (this.sorting.has(rid)) return this.end(rid, 'INVALID_REQUEST', 'The results request was invalid.')
    if (this.busy() >= this.limits.outstanding) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.tooMany)
    if (!this.current(request.generation, request.resultId)) return this.end(rid, 'RESULT_UNAVAILABLE', sentences.resultUnavailable)
    const port = this.port
    const running = run()
    this.sorting.set(rid, running)
    running.done.then(result => {
      if (this.port !== port || this.sorting.get(rid) !== running) { if (this.port !== port) orphan?.(result); return }
      this.sorting.delete(rid)
      const answered = check(result)
      if (answered === undefined) return this.end(rid, 'BACKEND_ERROR', failure)
      this.post({ t: 'end', rid, ok: true, result: answered })
    }, error => {
      if (this.port !== port || this.sorting.get(rid) !== running) return
      this.sorting.delete(rid)
      this.fail(rid, error)
    })
  }

  /** Row identities of a result this renderer owns (results.identify); cancelled like a sort, and counted with sorts. */
  private identify(request: Extract<PortRequest, { t: 'identify' }>): void {
    const { rid } = request
    if (this.sorting.has(rid)) return this.end(rid, 'INVALID_REQUEST', 'The results request was invalid.')
    if (this.busy() >= this.limits.outstanding) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.tooMany)
    if (!this.current(request.generation, request.resultId)) return this.end(rid, 'RESULT_UNAVAILABLE', sentences.resultUnavailable)
    const port = this.port
    const params: ResultsIdentifyParams = { resultId: request.resultId, by: request.by }
    if (request.column !== undefined) params.column = request.column
    const identify = this.backend.identify(request.generation, params)
    this.sorting.set(rid, identify)
    identify.done.then(result => {
      if (this.port !== port || this.sorting.get(rid) !== identify) return
      this.sorting.delete(rid)
      const parsed = identifyResultSchema.safeParse(result)
      if (!parsed.success || (request.column !== undefined && parsed.data.column !== request.column)) return this.end(rid, 'BACKEND_ERROR', 'The rows could not be told apart.')
      this.post({ t: 'end', rid, ok: true, result: parsed.data })
    }, error => {
      if (this.port !== port || this.sorting.get(rid) !== identify) return
      this.sorting.delete(rid)
      this.fail(rid, error)
    })
  }

  /** A range's identities; the answer covers the range asked, at most as many rows as asked or as exist. */
  private rowIds(request: Extract<PortRequest, { t: 'rowIds' }>): void {
    const params: ResultsRowIdsParams = { resultId: request.resultId, firstRow: request.firstRow, count: request.count }
    if (request.viewId !== undefined) params.viewId = request.viewId
    this.counted(request.rid, request.generation, request.resultId, () => this.backend.rowIds(request.generation, params), result => {
      const parsed = rowIdsResultSchema.safeParse(result)
      return parsed.success && parsed.data.firstRow === request.firstRow && parsed.data.ids.length <= Math.min(request.count, Math.max(0, parsed.data.rows - request.firstRow)) ? parsed.data : undefined
    })
  }

  /** The rows matching identities; every mark names one of the identities asked and every position is a row. */
  private findRows(request: Extract<PortRequest, { t: 'findRows' }>): void {
    const params: ResultsFindRowsParams = { resultId: request.resultId, ids: [...request.ids] }
    if (request.viewId !== undefined) params.viewId = request.viewId
    this.counted(request.rid, request.generation, request.resultId, () => this.backend.findRows(request.generation, params), result => {
      const parsed = findRowsResultSchema.safeParse(result)
      return parsed.success && parsed.data.marks.every(mark => mark < request.ids.length) && parsed.data.positions.every(position => position < parsed.data.rows) ? parsed.data : undefined
    })
  }

  /** A unified diff of two results this renderer owns (results.diff); cancelled like a sort, and counted with sorts. The
   *  diff is a new result: the port owns it once answered, and main closes one answered after its port went (a reload). */
  private diff(request: Extract<PortRequest, { t: 'diff' }>): void {
    const { rid, generation } = request
    if (this.sorting.has(rid)) return this.end(rid, 'INVALID_REQUEST', 'The results request was invalid.')
    if (this.busy() >= this.limits.outstanding) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.tooMany)
    if (!this.current(generation, request.resultId) || !this.current(generation, request.right)) return this.end(rid, 'RESULT_UNAVAILABLE', sentences.resultUnavailable)
    const port = this.port
    const diff = this.backend.diff(generation, { left: request.resultId, right: request.right, exact: request.exact, context: request.context })
    this.sorting.set(rid, diff)
    diff.done.then(result => {
      const parsed = diffResultSchema.safeParse(result)
      // The result the backend stored, even from an answer its schema refuses: nothing else would close it.
      const stored = parsed.success ? parsed.data.descriptor.resultId : storedResultId(result)
      const close = () => { if (stored !== undefined) void this.backend.close(generation, [stored]).catch(() => undefined) }
      if (this.port !== port || this.sorting.get(rid) !== diff) return close()
      this.sorting.delete(rid)
      if (!parsed.success) {
        close()
        return this.end(rid, 'BACKEND_ERROR', 'The results could not be compared.')
      }
      const descriptor: ResultDescriptor = { ...parsed.data.descriptor, generation }
      if (generation === this.generation) this.own([descriptor])
      this.post({ t: 'end', rid, ok: true, result: { ...parsed.data, descriptor } })
    }, error => {
      if (this.port !== port || this.sorting.get(rid) !== diff) return
      this.sorting.delete(rid)
      this.fail(rid, error)
    })
  }

  /** A pivot of a result this renderer owns (results.pivot; a view id is checked against its result by the backend);
   *  cancelled like a sort, and counted with sorts. The pivot is a new result: the port owns it once answered, and main
   *  closes one answered after its port went (a reload). */
  private pivot(request: Extract<PortRequest, { t: 'pivot' }>): void {
    const { rid, generation } = request
    if (this.sorting.has(rid)) return this.end(rid, 'INVALID_REQUEST', 'The results request was invalid.')
    if (this.busy() >= this.limits.outstanding) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.tooMany)
    if (!this.current(generation, request.resultId)) return this.end(rid, 'RESULT_UNAVAILABLE', sentences.resultUnavailable)
    const port = this.port
    // Copied member by member, so nothing but the schema's members reaches the backend.
    const params: ResultsPivotParams = {
      resultId: request.resultId, rows: [...request.rows], values: request.values.map(value => 'column' in value ? { aggregate: value.aggregate, column: value.column } : { aggregate: value.aggregate })
    }
    if (request.column !== undefined) params.column = request.column
    if (request.viewId !== undefined) params.viewId = request.viewId
    const pivot = this.backend.pivot(generation, params)
    this.sorting.set(rid, pivot)
    pivot.done.then(result => {
      const parsed = pivotResultSchema.safeParse(result)
      // The result the backend stored, even from an answer its schema refuses: nothing else would close it.
      const stored = parsed.success ? parsed.data.descriptor.resultId : storedResultId(result)
      const close = () => { if (stored !== undefined) void this.backend.close(generation, [stored]).catch(() => undefined) }
      if (this.port !== port || this.sorting.get(rid) !== pivot) return close()
      this.sorting.delete(rid)
      // The pivot's columns: its row columns, then each column group's values and each value's total; its figures within the bound.
      const values = request.values.length, stride = request.column === undefined ? 1 : (parsed.success ? parsed.data.columnGroups : 0) + 1
      if (!parsed.success || (request.column === undefined && parsed.data.columnGroups !== 0) || parsed.data.descriptor.columns.length !== request.rows.length + stride * values
        || parsed.data.rowGroups * stride * values > wire.pivot.maxCells) {
        close()
        return this.end(rid, 'BACKEND_ERROR', 'The results could not be pivoted.')
      }
      const descriptor: ResultDescriptor = { ...parsed.data.descriptor, generation }
      if (generation === this.generation) this.own([descriptor])
      this.post({ t: 'end', rid, ok: true, result: { ...parsed.data, descriptor } })
    }, error => {
      if (this.port !== port || this.sorting.get(rid) !== pivot) return
      this.sorting.delete(rid)
      this.fail(rid, error)
    })
  }

  /** A request of a result this renderer owns, counted with live updates against the 64; `check` bounds its answer. */
  private counted<T>(rid: number, generation: number, resultId: number, run: () => Promise<unknown>, check: (result: unknown) => T | undefined): void {
    if (this.busy() >= this.limits.outstanding) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.tooMany)
    if (!this.current(generation, resultId)) return this.end(rid, 'RESULT_UNAVAILABLE', sentences.resultUnavailable)
    const port = this.port
    this.updating++
    run().then(result => {
      if (this.port !== port) return
      this.updating--
      const answered = check(result)
      if (answered === undefined) return this.end(rid, 'BACKEND_ERROR', 'The results could not be read.')
      this.post({ t: 'end', rid, ok: true, result: answered as PortEndResult })
    }, error => {
      if (this.port !== port) return
      this.updating--
      this.fail(rid, error)
    })
  }

  /** The request names the current, ready generation and a result this renderer owns. */
  private current(generation: number, resultId: number): boolean {
    return generation === this.generation && this.backend.readyGeneration() === generation && this.owned.has(resultId)
  }

  private fail(rid: number, error: unknown): void {
    if (error instanceof BackendError) this.end(rid, error.code, error.message)
    else this.end(rid, 'BACKEND_ERROR', 'The results could not be read.')
  }

  private end(rid: number, code: ErrorCode, message: string): void { this.post({ t: 'end', rid, ok: false, code, message }) }

  /** Posting races renderer teardown; a closed port drops the message. */
  private post(message: PortMessage): void {
    if (!this.port) return
    try { this.port.postMessage(message) } catch { /* The port closed concurrently. */ }
  }
}

/** A search answer fits its request: as many columns as rows, matches strictly in (row, column) order and in the rows
 *  searched, after `fromRow` (or before it, backward), columns inside the result's (`columns`, when its descriptor named
 *  them), and no more than `total` counts with those before them. */
export function searchAnswers(answer: ResultsSearchResult, request: Pick<ResultsSearchParams, 'fromRow' | 'maxMatches' | 'backward'>, columns?: number): boolean {
  const { matchRows: rows, matchColumns: columnsOf } = answer
  if (rows.length !== columnsOf.length || answer.first + rows.length > answer.total || rows.length > request.maxMatches + wire.page.maxColumns) return false
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k]
    if (row >= answer.rows || (request.backward ? row >= request.fromRow : row < request.fromRow)) return false
    if (columns !== undefined && columnsOf[k] >= columns) return false
    if (k > 0 && (row < rows[k - 1] || (row === rows[k - 1] && columnsOf[k] <= columnsOf[k - 1]))) return false
  }
  return true
}

/** The supervisor as a results backend: reads are bound to their generation, and credit and cancellation reach a
 *  stream once it has been written. */
export function supervisorResults(supervisor: BackendSupervisor): ResultsBackend {
  return {
    readyGeneration: () => supervisor.readyGeneration,
    read: (generation, params, sink, credit) => {
      let id = 0
      const done = supervisor.request('results.read', params, { generation, stream: sink, credit, onSent: sent => { id = sent } })
      return {
        done,
        credit: bytes => { if (id) supervisor.credit(generation, id, bytes) },
        cancel: reason => { if (id) supervisor.cancel(generation, id, reason) }
      }
    },
    close: (generation, resultIds) => supervisor.request('results.close', { resultIds }, { generation }),
    rowBytes: (generation, params) => supervisor.request('results.rowBytes', params, { generation }),
    view: (generation, params) => {
      let id = 0
      const done = supervisor.request('results.view', params, { generation, onSent: sent => { id = sent } })
      return { done, cancel: reason => { if (id) supervisor.cancel(generation, id, reason) } }
    },
    viewClose: (generation, params) => supervisor.request('results.viewClose', params, { generation }),
    identify: (generation, params) => {
      let id = 0
      const done = supervisor.request('results.identify', params, { generation, onSent: sent => { id = sent } })
      return { done, cancel: reason => { if (id) supervisor.cancel(generation, id, reason) } }
    },
    rowIds: (generation, params) => supervisor.request('results.rowIds', params, { generation }),
    findRows: (generation, params) => supervisor.request('results.findRows', params, { generation }),
    diff: (generation, params) => {
      let id = 0
      const done = supervisor.request('results.diff', params, { generation, onSent: sent => { id = sent } })
      return { done, cancel: reason => { if (id) supervisor.cancel(generation, id, reason) } }
    },
    pivot: (generation, params) => {
      let id = 0
      const done = supervisor.request('results.pivot', params, { generation, onSent: sent => { id = sent } })
      return { done, cancel: reason => { if (id) supervisor.cancel(generation, id, reason) } }
    },
    search: (generation, params) => {
      let id = 0
      const done = supervisor.request('results.search', params, { generation, onSent: sent => { id = sent } })
      return { done, cancel: reason => { if (id) supervisor.cancel(generation, id, reason) } }
    },
    profile: (generation, params) => {
      let id = 0
      const done = supervisor.request('results.profile', params, { generation, onSent: sent => { id = sent } })
      return { done, cancel: reason => { if (id) supervisor.cancel(generation, id, reason) } }
    },
    distinct: (generation, params) => {
      let id = 0
      const done = supervisor.request('results.distinct', params, { generation, onSent: sent => { id = sent } })
      return { done, cancel: reason => { if (id) supervisor.cancel(generation, id, reason) } }
    },
    distinctRead: (generation, params) => {
      let id = 0
      const done = supervisor.request('results.distinctRead', params, { generation, onSent: sent => { id = sent } })
      return { done, cancel: reason => { if (id) supervisor.cancel(generation, id, reason) } }
    },
    distinctTick: (generation, params) => supervisor.request('results.distinctTick', params, { generation }),
    distinctClose: (generation, params) => supervisor.request('results.distinctClose', params, { generation }),
    live: (generation, params, onLive, credit) => {
      let id = 0
      const done = supervisor.request('live.subscribe', params, { generation, credit, onLive, onSent: sent => { id = sent } })
      return {
        done,
        credit: bytes => { if (id) supervisor.credit(generation, id, bytes) },
        cancel: reason => { if (id) supervisor.cancel(generation, id, reason) }
      }
    },
    liveUpdate: (generation, params) => supervisor.request('live.update', params, { generation })
  }
}

/** The result id an answer's descriptor names, read without trusting the rest of it; undefined when it has none. */
function storedResultId(answer: unknown): number | undefined {
  const descriptor = typeof answer === 'object' && answer !== null ? (answer as { descriptor?: unknown }).descriptor : undefined
  const id = typeof descriptor === 'object' && descriptor !== null ? (descriptor as { resultId?: unknown }).resultId : undefined
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= 0xffff_ffff ? id : undefined
}

const copyCells = (cells: ViewCells): ViewCells => ({ ranges: cells.ranges.map(([first, count]) => [first, count]), ...(cells.viewId === undefined ? {} : { viewId: cells.viewId }) })

/** A validated filter copied member by member, so nothing but its schema's members reaches the backend. */
function copyFilter(filter: ViewFilter): ViewFilter {
  if (filter.op === 'duplicates') return { op: 'duplicates', columns: [...filter.columns] }
  if (filter.op === 'groups') return { op: 'groups', column: filter.column, snapshotId: filter.snapshotId }
  if (filter.op === 'keepRows') return 'cells' in filter ? { op: 'keepRows', cells: copyCells(filter.cells) } : { op: 'keepRows', rows: [...filter.rows] }
  if ('cells' in filter) return { op: filter.op, column: filter.column, cells: copyCells(filter.cells) }
  return { op: filter.op, column: filter.column, rows: [...filter.rows], ...(filter.nulls === undefined ? {} : { nulls: filter.nulls }) }
}
