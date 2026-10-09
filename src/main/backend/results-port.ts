import type { BackendState, BackendStatus, QueryEvent, ResultDescriptor, ResultsCloseResult, ResultsReadParams, ResultsReadResult } from '../../shared/contracts'
import { portRequestSchema, type PortMessage, type PortRequest } from '../../shared/ipc/port-messages'
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
/** What the host needs from the backend; supervisorResults adapts BackendSupervisor. */
export interface ResultsBackend {
  /** The generation whose results can be read now, or undefined while none is ready. */
  readyGeneration(): number | undefined
  read(generation: number, params: ResultsReadParams, sink: StreamSink, credit: number): ReadStream
  close(generation: number, resultIds: number[]): Promise<ResultsCloseResult>
}
export interface PortLimits { outstanding: number; invalidMessages: number; opensPerMinute: number; ownedResults: number; perStream: number; perPort: number }
export const portLimits: PortLimits = { ...wire.port, ownedResults: wire.registries.ownedResults, perStream: wire.credit.perStream, perPort: wire.credit.perPort }

/**
 * Exactly one ArrayBuffer of exactly the page's bytes. Posting a view would structured-clone its whole backing store,
 * which for a pooled Node Buffer is unrelated memory; pages from the frame parser already own an exact buffer.
 */
export function toExactArrayBuffer(body: Uint8Array): ArrayBuffer {
  if (body.byteOffset === 0 && body.byteLength === body.buffer.byteLength && body.buffer instanceof ArrayBuffer) return body.buffer
  return body.slice().buffer as ArrayBuffer
}

interface Stream { readonly rid: number; readonly generation: number; granted: number; received: number; handle?: ReadStream }

/**
 * Main's end of the results port: one MessagePort per renderer load, through which the results worker reads pages and
 * receives query events. Every worker message is validated (portRequestSchema), reads are limited to results the
 * current generation owns, credits are clamped (16 MiB per stream, 64 MiB per port), and page bodies are forwarded
 * without being decoded, as exact-size ArrayBuffers. A backend loss ends the streams but keeps the port: the port lives
 * as long as the renderer.
 */
export class ResultsPortHost {
  private readonly backend: ResultsBackend
  private readonly createChannel: () => { port1: PortMainLike; port2: unknown }
  private readonly now: () => number
  private readonly limits: PortLimits
  private readonly streams = new Map<number, Stream>()
  /** Result ids the current generation holds for this renderer, oldest first. */
  private readonly owned = new Set<number>()
  private port: PortMainLike | undefined
  private generation = 0
  private status: BackendStatus = 'stopped'
  private closing = 0
  private invalid = 0
  private opens: number[] = []

  constructor(o: { backend: ResultsBackend; createChannel: () => { port1: PortMainLike; port2: unknown }; now?: () => number; limits?: Partial<PortLimits> }) {
    this.backend = o.backend
    this.createChannel = o.createChannel
    this.now = o.now ?? (() => Date.now())
    this.limits = { ...portLimits, ...o.limits }
  }

  get isOpen(): boolean { return !!this.port }
  get ownedCount(): number { return this.owned.size }

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

  /** Renderer reload, crash or window close: the port and its streams end. Ownership stays with the generation. */
  close(): void {
    const port = this.port
    this.port = undefined
    for (const stream of this.streams.values()) stream.handle?.cancel(cancelReasons.consumerGone)
    this.streams.clear()
    this.closing = 0
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

  queryEvent(queryId: string, event: QueryEvent): void {
    if (event.type === 'resultSet.opened') this.own([event.descriptor])
    this.post({ t: 'query', queryId, event })
  }

  memory(usedBytes: number, globalBytes: number): void { this.post({ t: 'memory', usedBytes, globalBytes }) }

  private receive(data: unknown): void {
    const parsed = portRequestSchema.safeParse(data)
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
      case 'cancel': this.streams.get(request.rid)?.handle?.cancel(cancelReasons.user); return
      case 'close': return this.closeResults(request)
    }
  }

  private outstanding(): number {
    let total = 0
    for (const stream of this.streams.values()) total += Math.max(0, stream.granted - stream.received)
    return total
  }

  private read(request: Extract<PortRequest, { t: 'read' }>): void {
    const { rid } = request
    if (this.streams.has(rid)) return this.end(rid, 'INVALID_REQUEST', 'The results request was invalid.')
    if (this.streams.size + this.closing >= this.limits.outstanding) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.tooMany)
    if (request.generation !== this.generation || this.backend.readyGeneration() !== request.generation || !this.owned.has(request.resultId)) return this.end(rid, 'RESULT_UNAVAILABLE', sentences.resultUnavailable)
    const credit = Math.min(request.credit, Math.max(wire.credit.min, this.limits.perPort - this.outstanding()))
    const stream: Stream = { rid, generation: request.generation, granted: credit, received: 0 }
    this.streams.set(rid, stream)
    const port = this.port
    const sink: StreamSink = {
      data: (seq, body) => {
        stream.received += body.byteLength
        if (this.streams.get(rid) === stream) this.post({ t: 'page', rid, seq, body: toExactArrayBuffer(new Uint8Array(body)) })
      }
    }
    stream.handle = this.backend.read(request.generation, { resultId: request.resultId, firstRow: request.firstRow, maxRows: request.maxRows }, sink, credit)
    stream.handle.done.then(result => {
      if (this.streams.get(rid) !== stream || this.port !== port) return
      this.streams.delete(rid)
      this.post({ t: 'end', rid, ok: true, result: result as ResultsReadResult })
    }, error => {
      if (this.streams.get(rid) !== stream || this.port !== port) return
      this.streams.delete(rid)
      this.fail(rid, error)
    })
  }

  /** Credit from the worker, after it cached a page; clamped to what the stream and the port may have outstanding. */
  private credit(rid: number, bytes: number): void {
    const stream = this.streams.get(rid)
    if (!stream?.handle) return
    const grant = Math.min(bytes, this.limits.perStream - (stream.granted - stream.received), this.limits.perPort - this.outstanding())
    if (grant < 1) return
    stream.granted += grant
    stream.handle.credit(grant)
  }

  private closeResults(request: Extract<PortRequest, { t: 'close' }>): void {
    const { rid } = request
    if (this.streams.size + this.closing >= this.limits.outstanding) return this.end(rid, 'TOO_MANY_REQUESTS', sentences.tooMany)
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
    close: (generation, resultIds) => supervisor.request('results.close', { resultIds }, { generation })
  }
}
