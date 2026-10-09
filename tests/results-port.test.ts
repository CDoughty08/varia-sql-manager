import { describe, expect, it, vi } from 'vitest'
import { ResultsPortHost, toExactArrayBuffer, type FrameLike, type PortMainLike, type ReadStream, type ResultsBackend } from '../src/main/backend/results-port'
import { BackendError } from '../src/main/backend/errors'
import type { StreamSink } from '../src/main/backend/connection'
import type { QueryEvent, ResultDescriptor, ResultsReadParams } from '../src/shared/contracts'
import type { PortMessage } from '../src/shared/ipc/port-messages'

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

function fixture(o: { now?: () => number } = {}) {
  const reads: FakeRead[] = []
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
    close: vi.fn(async (_generation: number, resultIds: number[]) => ({ closed: resultIds.length, usedBytes: 0 }))
  }
  const ports: FakePort[] = []
  const host = new ResultsPortHost({ backend, createChannel: () => { const port1 = new FakePort(); ports.push(port1); return { port1, port2: { renderer: true } } }, now: o.now })
  const frame: FrameLike & { sent: unknown[][] } = { sent: [], postMessage(...args: unknown[]) { this.sent.push(args) } }
  host.backendState({ status: 'ready', generation: 1, pid: 10, runtime: 'test', platform: 'test' })
  host.open(frame)
  const port = () => ports.at(-1)!
  const read = (rid: number, resultId = 7, patch: Record<string, unknown> = {}) => port().send({ t: 'read', rid, generation: 1, resultId, firstRow: 0, maxRows: 100, credit: 4 * MiB, ...patch })
  return { host, backend, reads, ports, port, frame, read, setReady: (generation: number | undefined) => { ready = generation } }
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
    host.memory(10, 100)
    expect(port().posted.slice(-2)).toEqual([{ t: 'query', queryId: 'query-1', event: opened }, { t: 'memory', usedBytes: 10, globalBytes: 100 }])
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
