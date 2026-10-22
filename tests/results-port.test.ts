import { describe, expect, it, vi } from 'vitest'
import { ResultsPortHost, toExactArrayBuffer, type FrameLike, type LiveStreamHandle, type PortMainLike, type ReadStream, type ResultsBackend } from '../src/main/backend/results-port'
import { BackendError } from '../src/main/backend/errors'
import type { StreamSink } from '../src/main/backend/connection'
import type { QueryEvent, ResultDescriptor, ResultsReadParams } from '../src/shared/contracts'
import { buildPortRequestSchema, type PortMessage, type portRequestSchema } from '../src/shared/ipc/port-messages'
import { buildLiveSchemas } from '../src/shared/live/schema'
import type { LiveProbeSpec, LiveSourceSpec } from '../src/shared/live/catalog'
import type { LiveEnd, LiveEvent, LiveSubscribeParams, LiveUpdateParams, LiveUpdateResult } from '../src/shared/live/schema'

const MiB = 1024 * 1024

/** MessagePortMain as main sees it: what main posted, and messages or a close from the renderer side. */
class FakePort implements PortMainLike {
  readonly posted: PortMessage[] = []
  private readonly listeners: { message: ((event: { data: unknown }) => void)[]; close: (() => void)[] } = { message: [], close: [] }
  started = false
  closed = false
  postMessage(message: unknown): void {
    if (this.closed) throw new Error('The port is closed.')
    this.posted.push(structuredClone(message) as PortMessage)
  }
  on(event: 'message' | 'close', listener: never): unknown { (this.listeners[event] as unknown[]).push(listener); return this }
  start(): void { this.started = true }
  close(): void { this.closed = true }
  send(data: unknown): void { for (const listener of this.listeners.message) listener({ data }) }
  hangUp(): void { for (const listener of this.listeners.close) listener() }
  ends(): Extract<PortMessage, { t: 'end' }>[] { return this.posted.filter((message): message is Extract<PortMessage, { t: 'end' }> => message.t === 'end') }
}

interface FakeRead { generation: number; params: ResultsReadParams; sink: StreamSink; credit: number; credits: number[]; cancels: number[]; resolve(value: unknown): void; reject(error: unknown): void }
interface FakeLive { generation: number; params: LiveSubscribeParams; onLive: (event: LiveEvent, bytes: number) => void; credit: number; credits: number[]; cancels: number[]; resolve(value: LiveEnd): void; reject(error: unknown): void }
interface FakeUpdate { generation: number; params: LiveUpdateParams; resolve(value: LiveUpdateResult): void; reject(error: unknown): void }

function fixture(o: { now?: () => number; testSources?: boolean; schema?: typeof portRequestSchema } = {}) {
  const reads: FakeRead[] = []
  const lives: FakeLive[] = []
  const updates: FakeUpdate[] = []
  let ready: number | undefined = 1
  const backend: ResultsBackend = {
    readyGeneration: () => ready,
    read: (generation, params, sink, credit): ReadStream => {
      let resolve!: (value: unknown) => void, reject!: (error: unknown) => void
      const done = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject })
      const read: FakeRead = { generation, params, sink, credit, credits: [], cancels: [], resolve, reject }
      reads.push(read)
      return { done, credit: bytes => read.credits.push(bytes), cancel: reason => read.cancels.push(reason) }
    },
    close: vi.fn(async (_generation: number, resultIds: number[]) => ({ closed: resultIds.length, usedBytes: 0 })),
    live: (generation, params, onLive, credit): LiveStreamHandle => {
      let resolve!: (value: LiveEnd) => void, reject!: (error: unknown) => void
      const done = new Promise<LiveEnd>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
      const live: FakeLive = { generation, params, onLive, credit, credits: [], cancels: [], resolve, reject }
      lives.push(live)
      return { done, credit: bytes => live.credits.push(bytes), cancel: reason => live.cancels.push(reason) }
    },
    liveUpdate: (generation, params) => new Promise<LiveUpdateResult>((resolve, reject) => { updates.push({ generation, params, resolve, reject }) })
  }
  const ports: FakePort[] = []
  const host = new ResultsPortHost({ backend, createChannel: () => { const port1 = new FakePort(); ports.push(port1); return { port1, port2: { renderer: true } } }, now: o.now, testSources: o.testSources ?? true, schema: o.schema })
  const frame: FrameLike & { sent: unknown[][] } = { sent: [], postMessage(...args: unknown[]) { this.sent.push(args) } }
  host.backendState({ status: 'ready', generation: 1, pid: 10, runtime: 'test', platform: 'test' })
  host.open(frame)
  const port = () => ports.at(-1)!
  const read = (rid: number, resultId = 7, patch: Record<string, unknown> = {}) => port().send({ t: 'read', rid, generation: 1, resultId, firstRow: 0, maxRows: 100, credit: 4 * MiB, ...patch })
  const live = (rid: number, patch: Partial<LiveSubscribeParams> = {}, generation = 1) => {
    const params = { subscriptionId: crypto.randomUUID(), connectionId: crypto.randomUUID(), source: 'debug.synthetic', probes: [{ probe: 'debug.synthetic.table', intervalMs: 1000 }], ...patch }
    port().send({ t: 'live', rid, generation, params })
    return params
  }
  return { host, backend, reads, lives, updates, ports, port, frame, read, live, setReady: (generation: number | undefined) => { ready = generation } }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const descriptor = (resultId: number, generation = 1): Pick<ResultDescriptor, 'generation' | 'resultId'> => ({ generation, resultId })

describe('ResultsPortHost', () => {
  it('hands the frame one port, starts it, and tells the worker the backend state', () => {
    const { frame, port } = fixture()
    expect(frame.sent).toEqual([['varia:results-port', { generation: 1 }, [{ renderer: true }]]])
    expect(port().started).toBe(true)
    expect(port().posted).toEqual([{ t: 'backend', generation: 1, status: 'ready' }])
  })

  it('rejects malformed requests, answering those with a readable rid, and closes the port at the 100th', () => {
    const { port, reads } = fixture()
    const invalid = [
      { t: 'read', rid: 1, generation: 1, resultId: 7, firstRow: 0, maxRows: 100, credit: 4 * MiB, extra: true },
      { t: 'read', rid: 2, generation: 1, resultId: 7, firstRow: 0, maxRows: 65_537, credit: 4 * MiB },
      { t: 'read', rid: 3, generation: 1, resultId: 7, firstRow: -1, maxRows: 1, credit: 4 * MiB },
      { t: 'read', rid: 4, generation: 1, resultId: 7, firstRow: 0, maxRows: 1, credit: 1024 },
      { t: 'credit', rid: 5, bytes: 16 * MiB + 1 },
      { t: 'close', rid: 6, generation: 1, resultIds: [] },
      { t: 'close', rid: 7, generation: 1, resultIds: [0] },
      { t: 'shell', rid: 8 }
    ]
    for (const message of invalid) port().send(message)
    port().send('not an object')
    port().send({ t: 'read', rid: 2 ** 31 })
    expect(port().ends().map(end => [end.rid, !end.ok && end.code])).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(rid => [rid, 'INVALID_REQUEST']))
    expect(reads).toHaveLength(0)
    for (let index = invalid.length + 2; index < 99; index++) port().send({ t: 'nope' })
    expect(port().closed).toBe(false)
    port().send({ t: 'nope' })
    expect(port().closed).toBe(true)
  })

  it('reads only results the current generation owns, while that generation is ready', async () => {
    const { host, read, reads, port, setReady } = fixture()
    read(1)
    host.own([descriptor(7, 2)])
    read(2)
    host.own([descriptor(7)])
    read(3, 7, { generation: 2 })
    setReady(undefined)
    read(4)
    setReady(1)
    read(5)
    expect(port().ends().map(end => [end.rid, !end.ok && end.code])).toEqual([[1, 'RESULT_UNAVAILABLE'], [2, 'RESULT_UNAVAILABLE'], [3, 'RESULT_UNAVAILABLE'], [4, 'RESULT_UNAVAILABLE']])
    expect(reads.map(item => [item.generation, item.params])).toEqual([[1, { resultId: 7, firstRow: 0, maxRows: 100 }]])
    // A new generation drops every result of the old one.
    host.backendState({ status: 'restarting', generation: 1, retryInMs: 0 })
    expect(host.ownedCount).toBe(1)
    host.backendState({ status: 'starting', generation: 2 })
    expect(host.ownedCount).toBe(0)
    expect(port().posted.filter(message => message.t === 'backend').map(message => message.t === 'backend' && [message.generation, message.status])).toEqual([[1, 'ready'], [1, 'restarting'], [2, 'starting']])
  })

  it('forwards pages as exact-size ArrayBuffers in sequence, then the end', async () => {
    const { host, read, reads, port } = fixture()
    host.own([descriptor(7)])
    read(1)
    const backing = new Uint8Array(64)
    backing.set([1, 2, 3, 4, 5], 8)
    reads[0].sink.data(1, backing.slice(8, 13).buffer)
    reads[0].sink.data(2, new Uint8Array([9]).buffer)
    reads[0].resolve({ nextRow: 100, rowsAvailable: 100, complete: true, pages: 2, rows: 100 })
    await settle()
    const pages = port().posted.filter(message => message.t === 'page')
    expect(pages.map(page => page.t === 'page' && [page.rid, page.seq, [...new Uint8Array(page.body)], page.body.byteLength])).toEqual([[1, 1, [1, 2, 3, 4, 5], 5], [1, 2, [9], 1]])
    expect(port().posted.at(-1)).toEqual({ t: 'end', rid: 1, ok: true, result: { nextRow: 100, rowsAvailable: 100, complete: true, pages: 2, rows: 100 } })
    // A view into a larger buffer is copied; a whole buffer is passed as it is.
    const view = backing.subarray(8, 13)
    expect(toExactArrayBuffer(view).byteLength).toBe(5)
    expect(toExactArrayBuffer(view)).not.toBe(backing.buffer)
    expect(toExactArrayBuffer(backing)).toBe(backing.buffer)
  })

  it('ends a failed read with the backend error code', async () => {
    const { host, read, reads, port } = fixture()
    host.own([descriptor(7)])
    read(1)
    reads[0].reject(new BackendError('BACKEND_LOST', 'The SQL backend stopped before answering. The request was not retried.'))
    await settle()
    expect(port().posted.at(-1)).toEqual({ t: 'end', rid: 1, ok: false, code: 'BACKEND_LOST', message: 'The SQL backend stopped before answering. The request was not retried.' })
  })

  it('clamps credit to 16 MiB outstanding per stream and 64 MiB per port', () => {
    const { host, read, reads, port } = fixture()
    host.own([descriptor(7)])
    for (let rid = 1; rid <= 4; rid++) read(rid, 7, { credit: 16 * MiB })
    expect(reads.map(item => item.credit)).toEqual([16 * MiB, 16 * MiB, 16 * MiB, 16 * MiB])
    // The port is full: a new stream still gets the minimum, so it can make progress.
    read(5, 7, { credit: 16 * MiB })
    expect(reads[4].credit).toBe(64 * 1024)
    port().send({ t: 'credit', rid: 1, bytes: MiB })
    expect(reads[0].credits).toEqual([])
    // The page frees room on the port: the credit held back goes out first, then as much of the next as fits.
    reads[0].sink.data(1, new ArrayBuffer(2 * MiB))
    expect(reads[0].credits).toEqual([MiB])
    port().send({ t: 'credit', rid: 1, bytes: 16 * MiB })
    expect(reads[0].credits).toEqual([MiB, MiB - 64 * 1024])
    port().send({ t: 'credit', rid: 99, bytes: MiB })
  })

  it('passes on credit the port held back once other streams end, so no stream stalls', async () => {
    const { host, read, reads, port } = fixture()
    host.own([descriptor(7)])
    for (let rid = 1; rid <= 16; rid++) read(rid, 7, { credit: 4 * MiB })
    read(17, 7, { credit: 4 * MiB })
    expect(reads[16].credit).toBe(64 * 1024)
    // The backend sends while credit is positive, so one 256 KiB page overdraws the stream; the worker credits it back.
    reads[16].sink.data(1, new ArrayBuffer(256 * 1024))
    port().send({ t: 'credit', rid: 17, bytes: 256 * 1024 })
    expect(reads[16].credits).toEqual([])
    for (const stream of reads.slice(0, 16)) stream.resolve({ nextRow: 0, rowsAvailable: 0, complete: true, pages: 0, rows: 0 })
    await settle()
    expect(reads[16].credits).toEqual([256 * 1024])
  })

  it('allows at most 64 outstanding requests', () => {
    const { host, read, reads, port } = fixture()
    host.own([descriptor(7)])
    for (let rid = 1; rid <= 65; rid++) read(rid, 7, { credit: 64 * 1024 })
    expect(reads).toHaveLength(64)
    expect(port().ends()).toEqual([{ t: 'end', rid: 65, ok: false, code: 'TOO_MANY_REQUESTS', message: 'Too many pending backend requests.' }])
  })

  it('cancels streams on request, when the port closes, and when a new port replaces it', () => {
    const { host, read, reads, port, frame } = fixture()
    host.own([descriptor(7)])
    read(1)
    read(2)
    port().send({ t: 'cancel', rid: 1 })
    expect(reads[0].cancels).toEqual([1])
    const first = port()
    host.open(frame)
    expect(first.closed).toBe(true)
    expect(reads.map(item => item.cancels)).toEqual([[1, 3], [3]])
    // Pages and answers for the old port's streams go nowhere.
    reads[1].sink.data(1, new ArrayBuffer(4))
    expect(port().posted.some(message => message.t === 'page')).toBe(false)
    read(3)
    port().hangUp()
    expect(reads[2].cancels).toEqual([3])
    expect(host.isOpen).toBe(false)
  })

  it('limits opens to 10 a minute within one page load', () => {
    let now = 0
    const { host, frame } = fixture({ now: () => now })
    for (let open = 1; open < 10; open++) host.open(frame)
    expect(() => host.open(frame)).toThrow('reopened too often')
    now = 60_001
    expect(() => host.open(frame)).not.toThrow()
    for (let open = 1; open < 10; open++) host.open(frame)
    expect(() => host.open(frame)).toThrow('reopened too often')
    // A reload starts a new page, whose first open must not fail because of the previous page's.
    host.reset()
    expect(host.isOpen).toBe(false)
    expect(() => host.open(frame)).not.toThrow()
  })

  it('routes query events by query id, owning the results they open, and forwards memory', () => {
    const { host, read, reads, port } = fixture()
    const opened: QueryEvent = { type: 'resultSet.opened', descriptor: { generation: 1, resultId: 9, index: 0, batchNumber: 1, iteration: 1, kind: 'rows', columns: [{ name: 'a', dataType: 'int', wire: 'text', nullable: true }], rowsRead: 0, rowsStored: 0, rowsAvailable: 0, bytesStored: 0, truncatedCells: 0, state: 'open', incomplete: false } }
    host.queryEvent('query-1', opened)
    host.memory(1, { usedBytes: 10, globalBytes: 100, seq: 7 })
    expect(port().posted.slice(-2)).toEqual([{ t: 'query', queryId: 'query-1', event: opened }, { t: 'memory', usedBytes: 10, globalBytes: 100, generation: 1, seq: 7 }])
    read(1, 9)
    expect(reads).toHaveLength(1)
  })

  it('closes only owned results of the current generation', async () => {
    const { host, backend, port } = fixture()
    host.own([descriptor(7), descriptor(8)])
    port().send({ t: 'close', rid: 1, generation: 1, resultIds: [7, 99] })
    port().send({ t: 'close', rid: 2, generation: 2, resultIds: [8] })
    await settle()
    expect(backend.close).toHaveBeenCalledTimes(1)
    expect(backend.close).toHaveBeenCalledWith(1, [7])
    expect(port().ends()).toEqual([{ t: 'end', rid: 2, ok: true, result: { closed: 0, usedBytes: 0 } }, { t: 'end', rid: 1, ok: true, result: { closed: 1, usedBytes: 0 } }])
    expect(host.ownedCount).toBe(1)
  })
})

const table = (resultId: number, revision: number, retired?: number[]) => ({
  table: 0, revision, ...(retired ? { retired } : {}),
  descriptor: { generation: 1, resultId, index: 0, batchNumber: 1, iteration: 1, kind: 'rows' as const, columns: ['id', 'label', 'value'].map(name => ({ name, dataType: 'int', wire: 'text' as const, nullable: false })), rowsRead: 3, rowsStored: 3, rowsAvailable: 3, bytesStored: 30, truncatedCells: 0, state: 'complete' as const, incomplete: false }
})
const tick = (seq: number, ...tables: ReturnType<typeof table>[]): LiveEvent => ({ type: 'live.tick', seq, sampledAt: seq, samples: [{ probe: 'debug.synthetic.table', costMs: 0, effectiveIntervalMs: 1000, tables }] })
const ended = (patch: Partial<LiveEnd> = {}): LiveEnd => ({ ended: 'cancelled', ticks: 1, elapsedMs: 1, ...patch })
const codes = (port: FakePort) => port.ends().map(end => [end.rid, end.ok ? 'ok' : end.code])

describe('ResultsPortHost live subscriptions', () => {
  it('accepts test-only sources only with the test schemas', () => {
    const production = fixture({ testSources: false })
    production.live(1)
    expect(codes(production.port())).toEqual([[1, 'INVALID_REQUEST']])
    expect(production.lives).toHaveLength(0)
    const test = fixture()
    const params = test.live(1)
    expect(test.lives.map(item => [item.generation, item.params, item.credit])).toEqual([[1, params, 64 * 1024]])
  })

  it('counts up to 16 live streams apart from the 64 outstanding requests, and refuses a duplicate subscription', () => {
    const { host, read, reads, live, lives, port } = fixture()
    host.own([descriptor(7)])
    for (let rid = 1; rid <= 64; rid++) read(rid, 7, { credit: 64 * 1024 })
    for (let rid = 101; rid <= 117; rid++) live(rid)
    expect(reads).toHaveLength(64)
    expect(lives).toHaveLength(16)
    expect(host.liveCount).toBe(16)
    expect(codes(port())).toEqual([[117, 'TOO_MANY_REQUESTS']])
    const repeat = lives[0].params.subscriptionId
    lives[1].resolve(ended())
    return settle().then(() => {
      live(118, { subscriptionId: repeat })
      expect(codes(port()).at(-1)).toEqual([118, 'DUPLICATE_REQUEST'])
      // The same rid as a running read or stream is refused too.
      live(101)
      expect(codes(port()).at(-1)).toEqual([101, 'INVALID_REQUEST'])
    })
  })

  it('refuses a stream for another generation, or while none is ready', () => {
    const { live, lives, port, setReady } = fixture()
    live(1, {}, 2)
    setReady(undefined)
    live(2)
    expect(codes(port())).toEqual([[1, 'RESULT_UNAVAILABLE'], [2, 'RESULT_UNAVAILABLE']])
    expect(lives).toHaveLength(0)
  })

  it('owns the tables ticks carry, retires only the stream\'s own results, and forwards each event with its length', async () => {
    const { host, live, lives, port, read, reads } = fixture()
    host.own([descriptor(50)])
    live(1)
    const opened: LiveEvent = { type: 'live.opened', seq: 0, source: 'debug.synthetic', probes: [{ probe: 'debug.synthetic.table', intervalMs: 1000, minIntervalMs: 1000, maxIntervalMs: 1000, state: 'ok' }] }
    lives[0].onLive(opened, 120)
    lives[0].onLive(tick(1, table(10, 1)), 400)
    lives[0].onLive(tick(2, table(11, 2)), 400)
    // A tick that names a query's result (50) as retired cannot take it from the renderer.
    lives[0].onLive(tick(3, table(12, 3, [10, 50])), 400)
    expect(port().posted.filter(message => message.t === 'live').map(message => message.t === 'live' && [message.rid, message.bytes, message.event.seq])).toEqual([[1, 120, 0], [1, 400, 1], [1, 400, 2], [1, 400, 3]])
    read(2, 11)
    read(3, 10)
    read(4, 50)
    expect(reads.map(item => item.params.resultId)).toEqual([11, 50])
    expect(codes(port())).toEqual([[3, 'RESULT_UNAVAILABLE']])
    // The end takes back the stream's results; a source that ended keeps the ones it names until they are closed.
    lives[0].resolve(ended({ ended: 'sourceEnded', kept: [12], ticks: 3 }))
    await settle()
    expect(port().posted.at(-1)).toEqual({ t: 'end', rid: 1, ok: true, result: ended({ ended: 'sourceEnded', kept: [12], ticks: 3 }) })
    expect(host.owns(1, 12) && host.owns(1, 50) && !host.owns(1, 11)).toBe(true)
    expect(host.liveCount).toBe(0)
  })

  it('takes back every result of a stream that fails, and none of a later generation\'s', async () => {
    const { host, live, lives, port } = fixture()
    live(1)
    lives[0].onLive(tick(1, table(10, 1)), 400)
    live(2)
    lives[1].onLive(tick(1, table(20, 1)), 400)
    lives[0].reject(new BackendError('STREAM_PROTOCOL', 'The SQL backend sent an invalid response. The request was cancelled.'))
    await settle()
    expect(codes(port())).toEqual([[1, 'STREAM_PROTOCOL']])
    expect(host.owns(1, 10)).toBe(false)
    host.backendState({ status: 'ready', generation: 2, pid: 11, runtime: 'test', platform: 'test' })
    host.own([descriptor(20, 2)])
    lives[1].reject(new BackendError('BACKEND_LOST', 'The SQL backend stopped before answering. The request was not retried.'))
    await settle()
    expect(host.owns(2, 20)).toBe(true)
  })

  it('relays acknowledgements as credit, never more than the events took', () => {
    const { live, lives, port } = fixture()
    live(1)
    lives[0].onLive(tick(1, table(10, 1)), 400)
    port().send({ t: 'credit', rid: 1, bytes: MiB })
    port().send({ t: 'credit', rid: 1, bytes: 400 })
    lives[0].onLive(tick(2, table(11, 2)), 300)
    port().send({ t: 'credit', rid: 1, bytes: 100 })
    port().send({ t: 'credit', rid: 1, bytes: 200 })
    expect(lives[0].credits).toEqual([400, 100, 200])
  })

  it('sends updates for the port\'s own subscriptions only, counting them in the 64 outstanding', async () => {
    const { host, live, lives, updates, port, read } = fixture()
    const params = live(1)
    port().send({ t: 'liveUpdate', rid: 2, generation: 1, params: { subscriptionId: params.subscriptionId, source: 'debug.synthetic', paused: true } })
    port().send({ t: 'liveUpdate', rid: 3, generation: 1, params: { subscriptionId: crypto.randomUUID(), source: 'debug.synthetic', paused: true } })
    port().send({ t: 'liveUpdate', rid: 4, generation: 1, params: { subscriptionId: params.subscriptionId, source: 'debug.synthetic' } })
    expect(updates.map(update => update.params)).toEqual([{ subscriptionId: params.subscriptionId, source: 'debug.synthetic', paused: true }])
    expect(codes(port())).toEqual([[3, 'NOT_FOUND'], [4, 'INVALID_REQUEST']])
    updates[0].resolve({ applied: true, probes: [{ probe: 'debug.synthetic.table', intervalMs: 1000, effectiveIntervalMs: 1000, paused: true }] })
    await settle()
    expect(port().posted.at(-1)).toEqual({ t: 'end', rid: 2, ok: true, result: { applied: true, probes: [{ probe: 'debug.synthetic.table', intervalMs: 1000, effectiveIntervalMs: 1000, paused: true }] } })
    host.own([descriptor(7)])
    for (let rid = 10; rid < 73; rid++) read(rid, 7, { credit: 64 * 1024 })
    port().send({ t: 'liveUpdate', rid: 80, generation: 1, params: { subscriptionId: params.subscriptionId, source: 'debug.synthetic', refresh: true } })
    port().send({ t: 'liveUpdate', rid: 81, generation: 1, params: { subscriptionId: params.subscriptionId, source: 'debug.synthetic', refresh: true } })
    expect(codes(port()).slice(-1)).toEqual([[81, 'TOO_MANY_REQUESTS']])
    expect(lives).toHaveLength(1)
  })

  it('refuses a read or an update that reuses the rid of a running live stream, without reaching the backend', () => {
    const { host, live, lives, reads, updates, port, read } = fixture()
    const params = live(1)
    lives[0].onLive(tick(1, table(10, 1)), 400)
    host.own([descriptor(7)])
    read(1, 7)
    port().send({ t: 'liveUpdate', rid: 1, generation: 1, params: { subscriptionId: params.subscriptionId, source: 'debug.synthetic', paused: true } })
    expect(codes(port())).toEqual([[1, 'INVALID_REQUEST'], [1, 'INVALID_REQUEST']])
    expect(reads).toHaveLength(0)
    expect(updates).toHaveLength(0)
    // Credit for the rid still reaches the live stream alone.
    port().send({ t: 'credit', rid: 1, bytes: 400 })
    expect(lives[0].credits).toEqual([400])
  })

  it('refuses an update naming another source than the subscription has, which the schema alone cannot tell', () => {
    const column = (id: string) => ({ id, name: id, dataType: 'int' })
    const probes: Record<string, LiveProbeSpec> = {
      'one.rows': { id: 'one.rows', source: 'one', label: 'Rows', description: 'Rows', intervalMs: { default: 1000, min: 1000, max: 60_000 }, tables: [{ id: 't', mode: 'snapshot', key: ['k'], columns: [column('k')] }] },
      'two.rows': { id: 'two.rows', source: 'two', label: 'Rows', description: 'Rows', intervalMs: { default: 1000, min: 1000, max: 60_000 }, tables: [{ id: 't', mode: 'snapshot', key: ['k'], columns: [column('k')] }] }
    }
    const sources: Record<string, LiveSourceSpec> = {
      one: { id: 'one', label: 'One', description: 'One', scope: 'server', testOnly: false, probes: ['one.rows'] },
      two: { id: 'two', label: 'Two', description: 'Two', scope: 'server', testOnly: false, probes: ['two.rows'] }
    }
    const schema = buildPortRequestSchema(buildLiveSchemas({ sources, probes, args: {} }, { test: false })) as unknown as typeof portRequestSchema
    const { live, lives, updates, port } = fixture({ schema })
    const params = live(1, { source: 'one' as never, probes: [{ probe: 'one.rows' as never, intervalMs: 1000 }] })
    expect(lives).toHaveLength(1)
    port().send({ t: 'liveUpdate', rid: 2, generation: 1, params: { subscriptionId: params.subscriptionId, source: 'two', probes: [{ probe: 'two.rows', paused: true }] } })
    port().send({ t: 'liveUpdate', rid: 3, generation: 1, params: { subscriptionId: params.subscriptionId, source: 'one', probes: [{ probe: 'one.rows', paused: true }] } })
    expect(codes(port())).toEqual([[2, 'INVALID_REQUEST']])
    expect(updates.map(update => update.params.source)).toEqual(['one'])
  })

  it('closes what a source kept when it ends after the port closed, since nothing else can', async () => {
    const { host, backend, live, lives, frame } = fixture()
    live(1)
    live(2)
    lives[0].onLive(tick(1, table(12, 1)), 400)
    lives[1].onLive(tick(1, table(13, 1)), 400)
    host.close()
    expect(host.owns(1, 12)).toBe(false)
    // Both RESPONSEs were already on the wire: one source ended, keeping its table; the other was cancelled.
    lives[0].resolve(ended({ ended: 'sourceEnded', kept: [12], ticks: 1 }))
    lives[1].resolve(ended({ ended: 'cancelled' }))
    await settle()
    expect(backend.close).toHaveBeenCalledTimes(1)
    expect(backend.close).toHaveBeenCalledWith(1, [12])
    expect(host.owns(1, 12)).toBe(false)
    // After a backend loss there is nothing to close: the kept results went with that generation.
    host.open(frame)
    live(3)
    lives[2].onLive(tick(1, table(14, 1)), 400)
    host.close()
    host.backendState({ status: 'ready', generation: 2, pid: 11, runtime: 'test', platform: 'test' })
    lives[2].resolve(ended({ ended: 'sourceEnded', kept: [14], ticks: 1 }))
    await settle()
    expect(backend.close).toHaveBeenCalledTimes(1)
  })

  it('cancels a stream on request, and with reason 3 when the port closes, taking back its results', () => {
    const { host, live, lives, port, frame } = fixture()
    live(1)
    live(2)
    lives[1].onLive(tick(1, table(10, 1)), 400)
    port().send({ t: 'cancel', rid: 1 })
    expect(lives[0].cancels).toEqual([1])
    host.open(frame)
    expect(lives.map(item => item.cancels)).toEqual([[1, 3], [3]])
    expect(host.owns(1, 10)).toBe(false)
    expect(host.liveCount).toBe(0)
    // Events of the old port's streams go nowhere.
    lives[1].onLive(tick(2, table(11, 2)), 400)
    expect(port().posted.some(message => message.t === 'live')).toBe(false)
    expect(host.owns(1, 11)).toBe(false)
  })
})
