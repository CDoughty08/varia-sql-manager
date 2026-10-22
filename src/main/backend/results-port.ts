import type { BackendState, BackendStatus, QueryEvent, ResultDescriptor, ResultsCloseResult, ResultsReadParams, ResultsReadResult } from '../../shared/contracts'
import { portRequestSchema, testPortRequestSchema, type PortMessage, type PortRequest } from '../../shared/ipc/port-messages'
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
/** `ids` are the results this stream's ticks named: the only ones its `retired` lists and its end may take back. */
interface LiveStream { readonly rid: number; readonly generation: number; readonly subscriptionId: string; readonly source: string; readonly ids: Set<number>; granted: number; received: number; withheld: number; handle?: LiveStreamHandle }

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
  /** Result ids the current generation holds for this renderer, oldest first. */
  private readonly owned = new Set<number>()
  private port: PortMainLike | undefined
  private generation = 0
  private status: BackendStatus = 'stopped'
  private closing = 0
  private updating = 0
  private invalid = 0
  private opens: number[] = []

  /** `testSources`: accept test-only live sources (debug.synthetic); main sets it only for unpackaged smoke runs. */
  constructor(o: { backend: ResultsBackend; createChannel: () => { port1: PortMainLike; port2: unknown }; now?: () => number; limits?: Partial<PortLimits>; testSources?: boolean }) {
    this.backend = o.backend
    this.schema = o.testSources ? testPortRequestSchema : portRequestSchema
    this.createChannel = o.createChannel
    this.now = o.now ?? (() => Date.now())
    this.limits = { ...portLimits, ...o.limits }
  }

  get isOpen(): boolean { return !!this.port }
  get ownedCount(): number { return this.owned.size }
  get liveCount(): number { return this.lives.size }

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
    }
    this.status = state.status
    this.post({ t: 'backend', generation, status: state.status })
  }

  /** Results the renderer may read: from a query summary or event, or the test hooks. */
  own(descriptors: readonly Pick<ResultDescriptor, 'generation' | 'resultId'>[]): void {
    for (const { generation, resultId } of descriptors) {
      if (generation !== this.generation) continue
      this.owned.delete(resultId)
      this.owned.add(resultId)
      if (this.owned.size > this.limits.ownedResults) this.owned.delete(this.owned.values().next().value!)
    }
  }

  /** Whether this renderer may use the result: the current generation holds it for this renderer (copy and save). */
  owns(generation: number, resultId: number): boolean { return generation === this.generation && this.owned.has(resultId) }

  queryEvent(queryId: string, event: QueryEvent): void {
    if (event.type === 'resultSet.opened') this.own([event.descriptor])
    this.post({ t: 'query', queryId, event })
  }

  /** A results.memory event of `generation`; the renderer orders it with the summaries by generation and seq. */
  memory(generation: number, report: { usedBytes: number; globalBytes: number; seq: number }): void {
    this.post({ t: 'memory', usedBytes: report.usedBytes, globalBytes: report.globalBytes, generation, seq: report.seq })
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
      case 'cancel': (this.streams.get(request.rid) ?? this.lives.get(request.rid))?.handle?.cancel(cancelReasons.user); return
      case 'close': return this.closeResults(request)
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

  /** Requests counted against the 64 outstanding: reads, closes and live updates (live streams have their own cap). */
  private busy(): number { return this.streams.size + this.closing + this.updating }

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
    stream.handle = this.backend.read(request.generation, { resultId: request.resultId, firstRow: request.firstRow, maxRows: request.maxRows }, sink, credit)
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
    const stream: LiveStream = { rid, generation: request.generation, subscriptionId: params.subscriptionId, source: params.source, ids: new Set(), granted: credit, received: 0, withheld: 0 }
    this.lives.set(rid, stream)
    this.subscriptions.set(params.subscriptionId, rid)
    const port = this.port
    const onLive = (event: LiveEvent, bytes: number) => {
      stream.received += bytes
      if (this.lives.get(rid) !== stream) return
      const descriptors = liveDescriptors(event)
      this.own(descriptors)
      for (const descriptor of descriptors) stream.ids.add(descriptor.resultId)
      // A tick can never take back results it did not deliver: a query's, or another stream's.
      for (const id of liveRetired(event)) if (stream.ids.delete(id)) this.owned.delete(id)
      this.post({ t: 'live', rid, bytes, event })
    }
    stream.handle = this.backend.live(request.generation, params, onLive, credit)
    stream.handle.done.then(result => {
      if (this.lives.get(rid) !== stream || this.port !== port) return
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
      this.fail(rid, error)
    })
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
