import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { z } from 'zod'
import { FrameKind, FrameParser, ProtocolError, encodeFrame, type ParsedFrame } from '../../shared/ipc/wire/frames'
import { decodeControl, encodeControl, encodeSensitiveControl } from '../../shared/ipc/wire/msgpack'
import { PROTOCOL_VERSION, cancelReasons, errorCodes, limits as wire, type CancelReason, type ErrorCode } from '../../shared/ipc/wire/protocol'
import { backendMethods, methodPolicies } from '../../shared/ipc/methods'
import type { BackendMethod } from '../../shared/contracts'
import { BackendError, failureMessage, sentences } from './errors'

export interface SpawnSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  /** Packaged builds word setup failures as "reinstall" rather than "rebuild". */
  readonly packaged: boolean
  /** A file the command needs (the development build's dll): when it is missing, the spawn fails as a missing command does. */
  readonly requires?: string
}

export interface Clock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
export const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout> | undefined)
}

export interface ConnectionLimits {
  helloMs: number
  pingMs: number
  requestBody: number
  responseBody: number
  /** Pending requests per generation, plus `control` more reserved for control-lane methods. */
  pending: number
  control: number
  stdinBytes: number
  /** The violation that makes contained protocol errors fatal. */
  containedViolations: number
  abandoned: number
}
export const connectionLimits: ConnectionLimits = {
  helloMs: wire.timers.helloMs, pingMs: wire.timers.pingMs, requestBody: wire.requestBody, responseBody: wire.responseBody,
  pending: wire.pending.requests, control: wire.pending.control, stdinBytes: wire.pending.stdinBytes, containedViolations: 8, abandoned: wire.registries.abandonedRequests
}

export interface ConnectionDeps {
  spawn?: typeof spawnProcess
  clock?: Clock
  limits?: Partial<ConnectionLimits>
  /** VARIA_IPC_TRACE: one line per frame with its kind, id and length, never its body. */
  trace?: (line: string) => void
  appVersion?: string
  /** Main's timers run before it polls I/O, so a backstop first yields one turn for an answer already in the pipe. */
  yieldTurn?: (callback: () => void) => void
  /** Global EVENT bodies (id 0), decoded under the control limits but otherwise unchecked. */
  onGlobalEvent?: (event: unknown) => void
}

/** Why a generation ended. `closed` means main closed it; every other reason is unexpected. */
export type LossReason = 'exit' | 'protocol' | 'helloTimeout' | 'crash' | 'incompatible' | 'spawn' | 'closed'
/** `detail` is fixed-format (codes, offsets, versions, method names), never anything else the backend sent.
 *  `queries` counts the scripts that were running when the generation ended. */
export interface Loss { readonly reason: LossReason; readonly detail: string; readonly exitCode?: number | null; readonly signal?: string | null; readonly queries?: number }

/** Each DATA body of a stream, an exact-size ArrayBuffer, in sequence order; the stream's RESPONSE settles `done`. */
export interface StreamSink { data(seq: number, body: ArrayBuffer): void }
export interface SendOptions {
  deadlineMs: number
  backstopMs?: number
  credit?: number
  stream?: StreamSink
  /** Each EVENT for this request; returning false rejects it as invalid (a contained violation). */
  onEvent?: (event: unknown) => boolean | void
  sensitive?: boolean
}

const helloSchema = z.object({
  version: z.number().int(), generation: z.number().int(), pid: z.number().int().min(1),
  runtime: z.string().max(256), platform: z.string().max(512), sqlClientVersion: z.string().max(64), maxFrameBytes: z.number().int(),
  resultBudget: z.object({ globalBytes: z.number().int().min(0), queryBytes: z.number().int().min(0) }).optional(),
  methods: z.array(z.string().max(64)).max(256)
})
export type BackendHello = z.infer<typeof helloSchema>
const errorSchema = z.object({ code: z.string().max(64), message: z.string().max(wire.messages.errorCharacters) }).strict()
const goAwaySchema = z.object({ code: z.string().max(64), message: z.string().max(wire.messages.errorCharacters), versions: z.tuple([z.number().int(), z.number().int()]).optional() }).strict()
const knownCodes: ReadonlySet<string> = new Set(errorCodes)

interface Pending {
  readonly id: number
  readonly method: BackendMethod
  readonly resolve: (value: unknown) => void
  readonly reject: (error: BackendError) => void
  readonly stream?: StreamSink
  readonly onEvent?: (event: unknown) => boolean | void
  timer?: unknown
  granted: number
  received: number
  seq: number
}

const stderrRing = { lines: wire.registries.stderrLines, characters: wire.registries.stderrCharacters }
/** One stderr line for the ring, cut without leaving half a surrogate pair. */
function clip(line: string): string {
  if (line.length <= stderrRing.characters) return line
  const cut = line.slice(0, stderrRing.characters)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

const frameNames = Object.fromEntries(Object.entries(FrameKind).map(([name, kind]) => [kind, name])) as Record<number, string>
const maxRequestId = wire.ids.maxRequestId

function decoded(body: Uint8Array): { value: unknown } | undefined {
  try { return { value: decodeControl(body) } } catch { return undefined }
}

/**
 * One backend process (one generation) speaking protocol v2. It never restarts itself and never re-sends anything:
 * when the process is lost, every request written to it fails with BACKEND_LOST.
 */
export class BackendConnection {
  readonly generation: number
  /** When the process was spawned, on the connection's clock. */
  readonly startedAt: number
  /** Resolves with the backend's validated HELLO; rejects with the Loss if the generation ends first. */
  readonly ready: Promise<BackendHello>
  /** Frames for requests main already gave up on (backstop or violation), dropped on arrival. */
  lateFrames = 0
  private readonly child: ChildProcessWithoutNullStreams
  private readonly clock: Clock
  private readonly limits: ConnectionLimits
  private readonly trace: ((line: string) => void) | undefined
  private readonly yieldTurn: (callback: () => void) => void
  private readonly onGlobalEvent: ((event: unknown) => void) | undefined
  private readonly parser: FrameParser
  private readonly pending = new Map<number, Pending>()
  private readonly abandoned = new Set<number>()
  private readonly lossListeners: ((loss: Loss) => void)[] = []
  /** Frames written before HELLO completes wait here: nothing but HELLO is written until then. `id` marks a REQUEST. */
  private readonly queue: { frame: Uint8Array; sensitive: boolean; id?: number }[] = []
  private readonly exited: Promise<void>
  private readonly packaged: boolean
  private readonly stderrLines: string[] = []
  private stderrPartial = ''
  private queuedBytes = 0
  private hello: BackendHello | undefined
  private loss: Loss | undefined
  private nextId = 1
  private violations = 0
  private nonce = 0
  private lastFrameAt: number
  private helloTimer: unknown
  private pingTimer: unknown
  private resolveReady!: (hello: BackendHello) => void
  private rejectReady!: (loss: Loss) => void

  constructor(spec: SpawnSpec, generation: number, deps: ConnectionDeps = {}) {
    this.generation = generation
    this.clock = deps.clock ?? systemClock
    this.limits = { ...connectionLimits, ...deps.limits }
    this.trace = deps.trace
    this.yieldTurn = deps.yieldTurn ?? (callback => { setImmediate(callback) })
    this.onGlobalEvent = deps.onGlobalEvent
    this.parser = new FrameParser({ maxBody: this.limits.responseBody, direction: 'toMain' })
    this.packaged = spec.packaged
    this.startedAt = this.lastFrameAt = this.clock.now()
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    // Losses also reach onLoss listeners; an unobserved rejection here must not crash main.
    this.ready.catch(() => {})
    const child = (deps.spawn ?? spawnProcess)(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.env, windowsHide: true, stdio: 'pipe' })
    this.child = child
    let started = false
    let exited: () => void = () => {}
    this.exited = new Promise(resolve => { exited = resolve })
    child.once('spawn', () => { started = true })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (!started) exited()
      this.lose({ reason: started ? 'exit' : 'spawn', detail: error.code ?? error.name })
    })
    child.on('close', (code, signal) => {
      exited()
      this.lose({ reason: 'exit', detail: signal ? 'signal ' + signal : 'exit code ' + code, exitCode: code, signal })
    })
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    child.stdout.on('end', () => {
      try { this.parser.end() } catch (error) { this.violation(error) }
    })
    // Drained so a chatty backend never blocks. Only the last lines are kept, for Copy details; nothing is logged.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => this.collect(text))
    // A failed spawn also fails the pending HELLO write; the 'error' event reports that case.
    child.stdin.on('error', () => { if (started) this.lose({ reason: 'exit', detail: 'stdin closed' }) })
    this.helloTimer = this.clock.setTimeout(() => this.lose({ reason: 'helloTimeout', detail: 'no HELLO within ' + this.limits.helloMs + ' ms' }), this.limits.helloMs)
    this.writeNow(encodeFrame(FrameKind.HELLO, 0, 0, encodeControl({ versions: [PROTOCOL_VERSION, PROTOCOL_VERSION], generation, maxFrameBytes: this.limits.responseBody, app: deps.appVersion ?? '0.1.0' })), false)
  }

  get pid(): number | undefined { return this.child.pid }
  get isReady(): boolean { return !!this.hello && !this.loss }
  get lost(): Loss | undefined { return this.loss }
  get pendingCount(): number { return this.pending.size }
  /** Scripts written to (or queued for) this generation that have not finished. */
  get runningQueries(): number { let count = 0; for (const request of this.pending.values()) if (request.method === 'query.execute') count++; return count }
  get info(): BackendHello | undefined { return this.hello }
  /** Settles once the process has exited and its pipes have closed, so `stderr` then holds everything it wrote. */
  get closed(): Promise<void> { return this.exited }
  /** The backend's last stderr lines, at most 32 of 512 characters, oldest first. */
  get stderr(): readonly string[] { return (this.stderrPartial ? [...this.stderrLines, this.stderrPartial] : this.stderrLines).slice(-stderrRing.lines) }
  /** Milliseconds since the backend last sent anything (any frame, including PONG, counts). */
  get silentMs(): number { return this.clock.now() - this.lastFrameAt }

  /** Called once when this generation ends, immediately if it already has. */
  onLoss(listener: (loss: Loss) => void): void {
    if (this.loss) { const loss = this.loss; queueMicrotask(() => listener(loss)) }
    else this.lossListeners.push(listener)
  }

  /** Writes one REQUEST (queued until HELLO completes). `done` settles exactly once: with the RESPONSE, or with a
   *  local error (limits, backstop TIMEOUT, STREAM_PROTOCOL, BACKEND_LOST). */
  send(method: BackendMethod, params: unknown, o: SendOptions): { id: number; done: Promise<unknown> } {
    const refuse = (code: ErrorCode, message: string) => ({ id: 0, done: Promise.reject(new BackendError(code, message)) })
    if (this.loss) return refuse('BACKEND_LOST', method === 'query.execute' ? sentences.lostQuery : sentences.lost)
    const policy = methodPolicies[method]
    // Cancellation and cleanup stay available however many ordinary requests are outstanding.
    if (this.pending.size >= this.limits.pending + (policy.lane === 'control' ? this.limits.control : 0)) return refuse('TOO_MANY_REQUESTS', sentences.tooMany)
    if (this.nextId > maxRequestId) {
      this.lose({ reason: 'protocol', detail: 'request ids exhausted' })
      return refuse('BACKEND_LOST', sentences.lost)
    }
    const sensitive = o.sensitive ?? policy.sensitive === true
    const credit = o.credit === undefined ? undefined : Math.min(wire.credit.max, Math.max(wire.credit.min, Math.floor(o.credit)))
    const envelope = credit === undefined ? { method, params } : { method, params, credit }
    let body: Uint8Array
    try { body = sensitive ? encodeSensitiveControl(envelope) : encodeControl(envelope) }
    catch { return refuse('INVALID_REQUEST', 'The request could not be encoded for the backend.') }
    // Validation bounds scripts in characters; UTF-8 can still exceed the backend's body limit.
    if (body.length > this.limits.requestBody) {
      if (sensitive) body.fill(0)
      return refuse('TOO_LARGE', sentences.tooLarge)
    }
    const id = this.nextId
    const frame = encodeFrame(FrameKind.REQUEST, id, o.deadlineMs, body)
    if (sensitive) body.fill(0)
    if (this.child.stdin.writableLength + this.queuedBytes + frame.length > this.limits.stdinBytes) {
      if (sensitive) frame.fill(0)
      return refuse('TOO_MANY_REQUESTS', sentences.tooMany)
    }
    this.nextId++
    let resolve!: (value: unknown) => void
    let reject!: (error: BackendError) => void
    const done = new Promise<unknown>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
    const pending: Pending = { id, method, resolve, reject, stream: o.stream, onEvent: o.onEvent, granted: credit ?? 0, received: 0, seq: 0 }
    this.pending.set(id, pending)
    const backstopMs = o.backstopMs ?? 0
    if (backstopMs > 0) pending.timer = this.clock.setTimeout(() => this.backstop(pending, backstopMs), backstopMs)
    this.write(frame, sensitive, id)
    return { id, done }
  }

  /** CANCEL for an outstanding request; its RESPONSE still settles it. */
  cancel(id: number, reason: CancelReason): void {
    if (this.pending.has(id)) this.write(encodeFrame(FrameKind.CANCEL, id, reason), false)
  }

  /** More credit for a stream, clamped to 16 MiB outstanding. */
  credit(id: number, bytes: number): void {
    const pending = this.pending.get(id)
    if (!pending?.stream) return
    const grant = Math.min(Math.floor(bytes), wire.credit.max, wire.credit.perStream - (pending.granted - pending.received))
    if (!(grant >= 1)) return
    pending.granted += grant
    this.write(encodeFrame(FrameKind.CREDIT, id, grant), false)
  }

  /** Ends this generation on purpose: pending requests fail with `error` (by default BACKEND_LOST, as for any loss),
   *  stdin closes so the backend can end its sessions, and the process is killed if it has not exited within the grace
   *  period. */
  async close(graceMs: number = wire.timers.stopGraceMs, error?: BackendError): Promise<void> {
    this.lose({ reason: 'closed', detail: 'closed by main' }, error)
    if (!this.child.stdin.destroyed) this.child.stdin.end()
    const timeout = () => new Promise<'timeout'>(resolve => this.clock.setTimeout(() => resolve('timeout'), graceMs))
    if (await Promise.race([this.exited, timeout()]) === 'timeout') {
      this.kill()
      await Promise.race([this.exited, timeout()])
    }
  }

  private receive(chunk: Uint8Array): void {
    if (this.loss) return
    let frames: ParsedFrame[]
    try { frames = this.parser.push(chunk) } catch (error) { this.violation(error); return }
    this.lastFrameAt = this.clock.now()
    for (const frame of frames) {
      if (this.loss) return
      this.trace?.(`varia-ipc <- ${frameNames[frame.kind]} id=${frame.id} length=${frame.oversize ? frame.length : frame.body.length}`)
      this.handle(frame)
    }
  }

  private handle(frame: ParsedFrame): void {
    if (frame.kind === FrameKind.GOAWAY) return frame.oversize ? this.fatal('oversized GOAWAY') : this.goAway(frame.body)
    if (!this.hello) return frame.kind === FrameKind.HELLO && !frame.oversize ? this.accept(frame.body) : this.fatal(frameNames[frame.kind] + ' before HELLO')
    switch (frame.kind) {
      case FrameKind.HELLO: return this.fatal('second HELLO')
      case FrameKind.PONG: return
      default: return this.route(frame)
    }
  }

  /** RESPONSE, EVENT and DATA frames, by request id. */
  private route(frame: ParsedFrame): void {
    const id = frame.id
    // A global event (results.memory) is advisory: an undecodable one is dropped, never fatal.
    if (id === 0 && frame.kind === FrameKind.EVENT) {
      const event = frame.oversize ? undefined : decoded(frame.body)
      if (event) this.onGlobalEvent?.(event.value)
      return
    }
    if (id === 0 || id >= this.nextId) return this.fatal(`${frameNames[frame.kind]} for unissued id ${id}`)
    if (this.abandoned.has(id)) { this.lateFrames++; return }
    const pending = this.pending.get(id)
    if (!pending || frame.oversize) return this.contained(pending)
    if (frame.kind === FrameKind.DATA) {
      if (!pending.stream || frame.arg !== pending.seq + 1 || pending.granted - pending.received <= 0) return this.contained(pending)
      pending.seq = frame.arg
      pending.received += frame.body.length
      pending.stream.data(frame.arg, frame.body.buffer as ArrayBuffer)
      return
    }
    const body = decoded(frame.body)
    if (!body) return this.contained(pending)
    if (frame.kind === FrameKind.EVENT) {
      if (pending.onEvent?.(body.value) === false) this.contained(pending)
      return
    }
    const value = body.value
    const keys = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []
    if (keys.length !== 1) return this.contained(pending)
    if (keys[0] === 'result') {
      this.settle(pending)
      pending.resolve((value as { result: unknown }).result)
      return
    }
    const error = keys[0] === 'error' ? errorSchema.safeParse((value as { error: unknown }).error) : undefined
    if (!error?.success) return this.contained(pending)
    this.settle(pending)
    pending.reject(new BackendError(knownCodes.has(error.data.code) ? error.data.code as ErrorCode : 'BACKEND_ERROR', error.data.message))
  }

  private accept(body: Uint8Array): void {
    const parsed = helloSchema.safeParse(decoded(body)?.value)
    if (!parsed.success) return this.lose({ reason: 'incompatible', detail: 'invalid HELLO' })
    const hello = parsed.data
    if (hello.version !== PROTOCOL_VERSION) return this.lose({ reason: 'incompatible', detail: `protocol ${hello.version}, expected ${PROTOCOL_VERSION}` })
    const missing = backendMethods.filter(method => !hello.methods.includes(method))
    // A missing method means a stale build: the TypeScript side changed and the backend was not rebuilt.
    if (missing.length > 0) return this.lose({ reason: 'incompatible', detail: `protocol ${hello.version}, expected ${PROTOCOL_VERSION}; missing: ${missing[0]}` })
    if (hello.generation !== this.generation || hello.maxFrameBytes < wire.requestBody) return this.lose({ reason: 'incompatible', detail: 'invalid HELLO' })
    this.hello = hello
    this.clock.clearTimeout(this.helloTimer)
    for (const queued of this.queue.splice(0)) this.writeNow(queued.frame, queued.sensitive)
    this.queuedBytes = 0
    this.schedulePing()
    this.resolveReady(hello)
  }

  private goAway(body: Uint8Array): void {
    const parsed = goAwaySchema.safeParse(decoded(body)?.value)
    const code = parsed.success ? parsed.data.code : 'invalid GOAWAY'
    if (code === 'PROTOCOL_UNSUPPORTED') {
      const versions = parsed.success ? parsed.data.versions : undefined
      return this.lose({ reason: 'incompatible', detail: `protocol ${versions ? versions[0] + '-' + versions[1] : '?'}, expected ${PROTOCOL_VERSION}` })
    }
    this.lose({ reason: code === 'BACKEND_CRASH' ? 'crash' : 'protocol', detail: 'GOAWAY ' + (knownCodes.has(code) ? code : 'invalid') })
  }

  /** A broken frame stream, or a v1 backend answering the magic's LF with a JSON line. */
  private violation(error: unknown): void {
    if (error instanceof ProtocolError && error.code === 'LEGACY') this.lose({ reason: 'incompatible', detail: `protocol 1, expected ${PROTOCOL_VERSION}` })
    else this.fatal(error instanceof ProtocolError ? `${error.code} at ${error.offset}` : 'unreadable output')
  }

  private fatal(detail: string): void { this.lose({ reason: 'protocol', detail }) }

  /** Fails one request with STREAM_PROTOCOL and keeps the generation; too many of these are fatal. */
  private contained(pending: Pending | undefined): void {
    if (pending) {
      this.settle(pending)
      this.abandon(pending.id)
      if (!this.unqueue(pending.id)) this.write(encodeFrame(FrameKind.CANCEL, pending.id, cancelReasons.consumerGone), false)
      pending.reject(new BackendError('STREAM_PROTOCOL', sentences.invalid))
    }
    if (++this.violations >= this.limits.containedViolations) this.fatal(this.violations + ' contained violations')
  }

  private backstop(pending: Pending, ms: number): void {
    this.yieldTurn(() => {
      if (this.pending.get(pending.id) !== pending) return
      this.settle(pending)
      this.abandon(pending.id)
      if (!this.unqueue(pending.id)) this.write(encodeFrame(FrameKind.CANCEL, pending.id, cancelReasons.deadline), false)
      pending.reject(new BackendError('TIMEOUT', sentences.timeout(Math.round(ms / 1000))))
    })
  }

  private settle(pending: Pending): void {
    this.pending.delete(pending.id)
    this.clock.clearTimeout(pending.timer)
  }

  private abandon(id: number): void {
    this.abandoned.add(id)
    // Insertion order makes the set a ring: the oldest id leaves first.
    if (this.abandoned.size > this.limits.abandoned) this.abandoned.delete(this.abandoned.values().next().value!)
  }

  private schedulePing(): void {
    this.pingTimer = this.clock.setTimeout(() => {
      if (this.loss) return
      this.nonce = (this.nonce + 1) >>> 0
      this.write(encodeFrame(FrameKind.PING, 0, this.nonce), false)
      this.schedulePing()
    }, this.limits.pingMs)
  }

  private write(frame: Uint8Array, sensitive: boolean, id?: number): void {
    if (this.loss) { if (sensitive) frame.fill(0); return }
    if (this.hello) { this.writeNow(frame, sensitive); return }
    this.queue.push({ frame, sensitive, id })
    this.queuedBytes += frame.length
  }

  /** Drops a request main gave up on while it still waited for HELLO, so the backend never sees it; false when it was
   *  already written. */
  private unqueue(id: number): boolean {
    const index = this.queue.findIndex(queued => queued.id === id)
    if (index < 0) return false
    const [queued] = this.queue.splice(index, 1)
    this.queuedBytes -= queued.frame.length
    if (queued.sensitive) queued.frame.fill(0)
    return true
  }

  private writeNow(frame: Uint8Array, sensitive: boolean): void {
    if (this.child.stdin.destroyed) { if (sensitive) frame.fill(0); return }
    if (this.trace) this.trace(`varia-ipc -> ${frameNames[frame[2]]} id=${new DataView(frame.buffer, frame.byteOffset).getUint32(8, true)} length=${frame.length - 16}`)
    // Node writes from this array without copying it, so zeroing it after the callback removes the password.
    this.child.stdin.write(frame, sensitive ? () => frame.fill(0) : undefined)
  }

  private collect(text: string): void {
    const lines = (this.stderrPartial + text).split(/\r?\n/)
    this.stderrPartial = clip(lines.pop() ?? '')
    for (const line of lines.slice(-stderrRing.lines)) this.stderrLines.push(clip(line))
    if (this.stderrLines.length > stderrRing.lines) this.stderrLines.splice(0, this.stderrLines.length - stderrRing.lines)
  }

  private kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
  }

  private lose(cause: Loss, error?: BackendError): void {
    if (this.loss) return
    const loss: Loss = { ...cause, queries: this.runningQueries }
    this.loss = loss
    this.clock.clearTimeout(this.helloTimer)
    this.clock.clearTimeout(this.pingTimer)
    const pending = [...this.pending.values()]
    this.pending.clear()
    // A backend that cannot start or is from another build never ran anything, so say why rather than "stopped".
    const unavailable = failureMessage(loss, this.packaged)
    for (const request of pending) {
      this.clock.clearTimeout(request.timer)
      request.reject(error ?? (unavailable ? new BackendError('BACKEND_UNAVAILABLE', unavailable) : new BackendError('BACKEND_LOST', request.method === 'query.execute' ? sentences.lostQuery : sentences.lost)))
    }
    for (const queued of this.queue.splice(0)) if (queued.sensitive) queued.frame.fill(0)
    this.queuedBytes = 0
    this.rejectReady(loss)
    // A backend that broke the protocol or never said HELLO is not trusted to exit on its own.
    if (loss.reason !== 'exit' && loss.reason !== 'spawn' && loss.reason !== 'closed') this.kill()
    for (const listener of this.lossListeners.splice(0)) listener(loss)
  }
}
