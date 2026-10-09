import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { spawn as spawnProcess } from 'node:child_process'
import type { Clock } from '../../src/main/backend/connection'
import { FrameKind, FrameParser, encodeFrame, type ParsedFrame } from '../../src/shared/ipc/wire/frames'
import { decodeControl, encodeControl } from '../../src/shared/ipc/wire/msgpack'
import { backendMethods } from '../../src/shared/ipc/methods'

export interface FakeRequest { readonly generation: number; readonly id: number; readonly method: string; readonly params: Record<string, unknown> }

/**
 * A backend process in this test process: it speaks protocol v2 through the real wire code, so the supervisor can be
 * driven with a manual clock and exact control over exits, silence, and answers.
 */
export class FakeBackend extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  readonly pid: number
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  generation = 0
  /** Answer PING frames; a live backend that stops doing so is unresponsive. */
  pong = true
  /** Answer requests at once; otherwise they stay pending (see `respond`). */
  answer = true
  /** Say HELLO back; without it the generation never becomes ready. */
  hello = true
  /** Exit when stdin ends, as the real backend does. */
  exitOnEnd = true
  readonly requests: FakeRequest[] = []
  readonly cancels: { id: number; reason: number }[] = []
  readonly signals: string[] = []
  private readonly parser = new FrameParser({ maxBody: 4 * 1024 * 1024, direction: 'toBackend' })

  constructor(pid: number) {
    super()
    this.pid = pid
    this.stdin = new Writable({
      write: (chunk: Uint8Array, _encoding, done) => { for (const frame of this.parser.push(chunk)) this.handle(frame); done() },
      final: done => { if (this.exitOnEnd) this.exit(0); done() }
    })
  }

  get alive(): boolean { return this.exitCode === null && this.signalCode === null }

  /** Answers a request the way the real backend would, enough for the supervisor's registries. */
  respond(request: FakeRequest): void {
    const { method, params } = request
    const result = method === 'connections.connect' ? { id: `connection-${this.generation}-${request.id}`, server: params.server, database: 'master', serverVersion: '16.0' }
      : method === 'system.health' ? { pid: this.pid, generation: this.generation }
      : method === 'connections.disconnect' ? { disconnected: true }
      : method === 'query.session.close' ? { closed: true }
      : method === 'query.execute' ? { resultSets: [], discardedResultSets: 0, messages: [], recordsAffected: -1, elapsedMs: 1, status: 'completed', completedBatches: 1, totalBatches: 1, database: 'master', messagesTruncated: false, budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1 } }
      : { method }
    this.send(FrameKind.RESPONSE, request.id, 0, { result })
  }

  /** The HELLO reply; call it directly for a backend whose HELLO comes late (`hello = false`). */
  sayHello(): void {
    this.send(FrameKind.HELLO, 0, 0, { version: 2, generation: this.generation, pid: this.pid, runtime: '.NET fake', platform: 'fake OS', sqlClientVersion: '0', maxFrameBytes: 4 * 1024 * 1024, methods: backendMethods })
  }

  send(kind: FrameKind, id: number, arg: number, value?: unknown): void {
    if (this.alive) this.stdout.write(encodeFrame(kind, id, arg, value === undefined ? undefined : encodeControl(value)))
  }

  /** The process ends: its pipes close, then 'close' reports the code or signal. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (!this.alive) return
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    this.stderr.end()
    setImmediate(() => this.emit('close', code, signal))
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    this.exit(null, signal)
    return true
  }

  private handle(frame: ParsedFrame): void {
    if (!this.alive || frame.oversize) return
    if (frame.kind === FrameKind.HELLO) {
      this.generation = (decodeControl(frame.body) as { generation: number }).generation
      if (this.hello) this.sayHello()
      return
    }
    if (frame.kind === FrameKind.PING) { if (this.pong) this.send(FrameKind.PONG, 0, frame.arg); return }
    if (frame.kind === FrameKind.CANCEL) { this.cancels.push({ id: frame.id, reason: frame.arg }); return }
    if (frame.kind !== FrameKind.REQUEST) return
    const { method, params } = decodeControl(frame.body) as { method: string; params: Record<string, unknown> }
    const request = { generation: this.generation, id: frame.id, method, params }
    this.requests.push(request)
    if (this.answer) this.respond(request)
  }
}

/** A `spawn` that starts FakeBackends; `configure` sets each one up before it runs. */
export function fakeSpawn(configure: (backend: FakeBackend, index: number) => void = () => {}) {
  const backends: FakeBackend[] = []
  const spawn = (() => {
    const backend = new FakeBackend(1000 + backends.length)
    backends.push(backend)
    configure(backend, backends.length - 1)
    setImmediate(() => backend.emit('spawn'))
    return backend
  }) as unknown as typeof spawnProcess
  return { spawn, backends, last: () => backends.at(-1)! }
}

/** Lets pipes, promises, and setImmediate callbacks run. */
export async function settle(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await new Promise(resolve => setImmediate(resolve))
}

/** A clock whose timers run only in `advance`; `jump` moves time without running any, as a stalled event loop would. */
export function manualClock() {
  let now = 0, next = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  const clock: Clock = {
    now: () => now,
    setTimeout: (callback, ms) => { timers.set(next, { at: now + ms, callback }); return next++ },
    clearTimeout: handle => { timers.delete(handle as number) }
  }
  async function advance(ms: number): Promise<void> {
    const until = now + ms
    await settle()
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      timers.delete(due[0])
      // A timer that is overdue (after `jump`) runs late, at the current time.
      now = Math.max(now, due[1].at)
      due[1].callback()
      await settle()
    }
    now = until
    await settle()
  }
  return { clock, advance, jump: (ms: number) => { now += ms }, now: () => now }
}
