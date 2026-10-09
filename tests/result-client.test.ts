import { describe, expect, it, vi } from 'vitest'
import { ResultClient, WindowCache, type PortMessageEvent, type RowWindow, type WindowLike, type WorkerLike } from '../src/renderer/src/results/ResultClient'
import { ResultsWorkerCore } from '../src/renderer/src/results/worker-core'
import type { WorkerRequest, WorkerResponse } from '../src/renderer/src/results/worker-protocol'
import type { ApiResult, QueryResult, ResultDescriptor } from '../src/shared/contracts'
import type { PortMessage, PortRequest } from '../src/shared/ipc/port-messages'
import { encodePage } from '../src/shared/ipc/wire/pages'

const descriptor = (patch: Partial<ResultDescriptor> = {}): ResultDescriptor => ({
  generation: 1, resultId: 3, index: 0, batchNumber: 1, iteration: 1, kind: 'rows', columns: [{ name: 'n', dataType: 'int', wire: 'text', nullable: true }],
  rowsRead: 10, rowsStored: 10, rowsAvailable: 10, bytesStored: 100, truncatedCells: 0, state: 'complete', incomplete: false, ...patch
})

/** A worker running the real core; main's end of the port is `fromWorker` / `toWorker`. */
class FakeWorker implements WorkerLike {
  readonly listeners: { message: ((event: { data: WorkerResponse }) => void)[]; error: ((event: unknown) => void)[]; messageerror: ((event: unknown) => void)[] } = { message: [], error: [], messageerror: [] }
  readonly fromWorker: PortRequest[] = []
  readonly received: WorkerRequest[] = []
  readonly core = new ResultsWorkerCore({ post: message => queueMicrotask(() => { for (const listener of this.listeners.message) listener({ data: message }) }) })
  terminated = false
  postMessage(message: WorkerRequest): void {
    this.received.push(message)
    if (message.type === 'attach') this.core.attach({ postMessage: request => { this.fromWorker.push(request as PortRequest) } })
    else this.core.handle(message)
  }
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: never): void { (this.listeners[type] as unknown[]).push(listener) }
  terminate(): void { this.terminated = true }
  toWorker(message: PortMessage): void { this.core.receive(message) }
  crash(): void { for (const listener of this.listeners.error) listener(new Error('worker failed')) }
}

class FakeWindow implements WindowLike {
  readonly listeners = new Set<(event: PortMessageEvent) => void>()
  addEventListener(_type: 'message', listener: (event: PortMessageEvent) => void): void { this.listeners.add(listener) }
  removeEventListener(_type: 'message', listener: (event: PortMessageEvent) => void): void { this.listeners.delete(listener) }
  dispatch(event: PortMessageEvent): void { for (const listener of [...this.listeners]) listener(event) }
}

function fixture() {
  const workers: FakeWorker[] = []
  const window = new FakeWindow()
  let now = 0
  const api = { openResultsPort: vi.fn(async (): Promise<ApiResult<void>> => ({ ok: true, value: undefined })) }
  const scheduled: (() => void)[] = []
  const client = new ResultClient({ api, window, createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker }, now: () => now, schedule: callback => { scheduled.push(callback) } })
  const port = () => new MessageChannel().port1
  /** Main hands over the port as the preload does: a message from the page's own window carrying one port. */
  const handOver = () => window.dispatch({ source: window, data: { type: 'varia:results-port' }, ports: [port()] })
  const worker = () => workers.at(-1)!
  /** Main answers the worker's reads with 4-row pages of the numbers firstRow.. and an end. */
  const serve = (rows = 10) => {
    for (const request of worker().fromWorker.splice(0)) {
      if (request.t !== 'read') continue
      let seq = 0
      for (let first = request.firstRow - request.firstRow % 4; first < Math.min(rows, request.firstRow + request.maxRows); first += 4) {
        const count = Math.min(4, rows - first)
        const body = encodePage({ resultId: request.resultId, firstRow: first, columns: [{ wire: 'text' }], rows: Array.from({ length: count }, (_, index) => [String(first + index)]) })
        worker().toWorker({ t: 'page', rid: request.rid, seq: ++seq, body: body.buffer as ArrayBuffer })
      }
      worker().toWorker({ t: 'end', rid: request.rid, ok: true, result: { nextRow: rows, rowsAvailable: rows, complete: true, pages: seq, rows } })
    }
  }
  return { client, api, window, workers, worker, handOver, serve, scheduled, advance: (ms: number) => { now += ms }, flush: () => { for (const callback of scheduled.splice(0)) callback() } }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('ResultClient', () => {
  it('accepts exactly one port from its own window while it waits for one', async () => {
    const { client, api, window, worker, handOver } = fixture()
    expect(api.openResultsPort).toHaveBeenCalledTimes(1)
    const ports = [new MessageChannel().port1]
    window.dispatch({ source: {}, data: { type: 'varia:results-port' }, ports })
    window.dispatch({ source: window, data: { type: 'other' }, ports })
    window.dispatch({ source: window, data: null, ports })
    window.dispatch({ source: window, data: { type: 'varia:results-port' }, ports: [...ports, new MessageChannel().port1] })
    expect(worker().received).toEqual([])
    handOver()
    await client.ready()
    expect(worker().received.map(message => message.type)).toEqual(['attach'])
    handOver()
    expect(worker().received).toHaveLength(1)
    client.dispose()
    expect(window.listeners.size).toBe(0)
    expect(worker().terminated).toBe(true)
  })

  it('reads windows through the worker and remembers recent ones', async () => {
    const { client, handOver, serve } = fixture()
    handOver()
    const handle = client.open(descriptor())
    const pending = handle.getWindow(2, 100)
    await settle()
    serve()
    const window = await pending
    expect([window.first, window.count, window.text]).toEqual([2, 8, ['2', '3', '4', '5', '6', '7', '8', '9']])
    expect(handle.peekWindow(2, 100)).toBe(window)
    expect(handle.peekWindow(0, 100)).toBeUndefined()
    expect(await handle.getWindow(20, 5)).toMatchObject({ count: 0, text: [] })
    expect(await handle.getCell(4, 0)).toEqual({ text: '4', isNull: false, truncated: false })
  })

  it('fails pending requests when the worker fails, recreates it at most 3 times a minute, then gives up', async () => {
    const { client, api, workers, worker, handOver, advance } = fixture()
    handOver()
    const handle = client.open(descriptor())
    const pending = handle.getWindow(0, 10)
    await settle()
    worker().crash()
    await expect(pending).rejects.toMatchObject({ code: 'RESULT_DECODER_FAILED' })
    expect(workers).toHaveLength(2)
    expect(workers[0].terminated).toBe(true)
    expect(api.openResultsPort).toHaveBeenCalledTimes(2)
    handOver()
    await client.ready()
    expect(worker().received.map(message => message.type)).toEqual(['attach'])
    worker().crash()
    advance(1000)
    worker().crash()
    expect(workers).toHaveLength(4)
    worker().crash()
    expect(workers).toHaveLength(4)
    expect(client.failed).toBe('Results cannot be displayed; reload the workbench.')
    await expect(handle.getWindow(0, 10)).rejects.toMatchObject({ code: 'RESULT_DECODER_FAILED', message: 'Results cannot be displayed; reload the workbench.' })
  })

  it('fails a request waiting for the port when the worker fails before receiving one', async () => {
    const { client, worker, handOver, serve } = fixture()
    const handle = client.open(descriptor())
    const waiting = handle.getWindow(0, 4)
    worker().crash()
    await expect(waiting).rejects.toMatchObject({ code: 'RESULT_DECODER_FAILED' })
    handOver()
    const window = handle.getWindow(0, 4)
    await settle()
    serve()
    expect((await window).text).toEqual(['0', '1', '2', '3'])
  })

  it('marks results of an earlier generation lost and refuses to read them', async () => {
    const { client, worker, handOver, flush } = fixture()
    handOver()
    await client.ready()
    const handle = client.open(descriptor())
    const changes = vi.fn()
    handle.subscribe(changes)
    worker().toWorker({ t: 'backend', generation: 1, status: 'ready' })
    worker().toWorker({ t: 'backend', generation: 2, status: 'starting' })
    await settle()
    flush()
    expect(handle.getSnapshot().state).toBe('lost')
    expect(changes).toHaveBeenCalledTimes(1)
    await expect(handle.getWindow(0, 5)).rejects.toMatchObject({ code: 'RESULT_UNAVAILABLE', message: 'These results are no longer available because the SQL backend restarted.' })
    expect(client.open(descriptor({ resultId: 4 })).getSnapshot().state).toBe('lost')
  })

  it('routes query events, coalesces snapshot notifications, and settles with the summary', async () => {
    const { client, worker, handOver, flush } = fixture()
    handOver()
    await client.ready()
    worker().toWorker({ t: 'backend', generation: 1, status: 'ready' })
    const events = vi.fn()
    const subscription = client.onQueryEvent('query-1', events)
    const opened = descriptor({ rowsRead: 0, rowsStored: 0, rowsAvailable: 0, state: 'open' })
    worker().toWorker({ t: 'query', queryId: 'query-1', event: { type: 'resultSet.opened', descriptor: opened } })
    await settle()
    const handle = client.open(opened)
    const changes = vi.fn()
    handle.subscribe(changes)
    for (const rows of [10, 20, 30]) worker().toWorker({ t: 'query', queryId: 'query-1', event: { type: 'progress', completedBatches: 0, totalBatches: 1, batchNumber: 1, iteration: 1, results: [{ resultId: 3, rowsRead: rows, rowsStored: rows, rowsAvailable: rows - 5, bytesStored: rows * 10 }] } })
    worker().toWorker({ t: 'query', queryId: 'other', event: { type: 'messages', messages: [{ text: 'elsewhere', kind: 'info' }] } })
    await settle()
    expect(events).toHaveBeenCalledTimes(4)
    expect(handle.getSnapshot()).toMatchObject({ rowsRead: 30, rowsAvailable: 25, state: 'open' })
    flush()
    expect(changes).toHaveBeenCalledTimes(1)
    const summary = { resultSets: [descriptor({ rowsRead: 40, rowsStored: 40, rowsAvailable: 40, truncated: 'rowLimit' })] } as QueryResult
    client.applySummary(summary)
    expect(handle.getSnapshot()).toMatchObject({ rowsRead: 40, rowsAvailable: 40, state: 'complete', truncated: 'rowLimit' })
    subscription.dispose()
    worker().toWorker({ t: 'query', queryId: 'query-1', event: { type: 'messages', messages: [{ text: 'late', kind: 'error' }] } })
    await settle()
    expect(events).toHaveBeenCalledTimes(4)
    const memory = vi.fn()
    client.onMemory(memory)
    worker().toWorker({ t: 'memory', usedBytes: 5, globalBytes: 50 })
    await settle()
    expect(memory).toHaveBeenCalledWith({ usedBytes: 5, globalBytes: 50 })
  })

  it('closes results in the backend and refuses to read them afterwards', async () => {
    const { client, worker, handOver } = fixture()
    handOver()
    const handle = client.open(descriptor())
    const closing = handle.close()
    await settle()
    const close = worker().fromWorker.find(request => request.t === 'close')
    expect(close).toEqual({ t: 'close', rid: 1, generation: 1, resultIds: [3] })
    worker().toWorker({ t: 'end', rid: 1, ok: true, result: { closed: 1, usedBytes: 0 } })
    await closing
    expect(handle.getSnapshot().state).toBe('released')
    await expect(handle.getWindow(0, 5)).rejects.toMatchObject({ code: 'RESULT_RELEASED' })
  })

  it('forgets released results and their windows, and every result of an earlier generation', async () => {
    const { client, worker, handOver, serve } = fixture()
    handOver()
    await client.ready()
    worker().toWorker({ t: 'backend', generation: 1, status: 'ready' })
    const handles = [3, 4, 5].map(resultId => client.open(descriptor({ resultId })))
    const pending = handles[0].getWindow(0, 10)
    await settle()
    serve()
    await pending
    expect(handles[0].peekWindow(0, 10)).toBeDefined()
    expect(client.trackedResults).toBe(3)
    const closing = client.release([handles[0].key, handles[1].key])
    await settle()
    worker().toWorker({ t: 'end', rid: worker().fromWorker.find(request => request.t === 'close')!.rid, ok: true, result: { closed: 2, usedBytes: 0 } })
    await closing
    expect(client.trackedResults).toBe(1)
    expect(handles[0].getSnapshot().state).toBe('released')
    expect(handles[0].peekWindow(0, 10)).toBeUndefined()
    worker().toWorker({ t: 'backend', generation: 2, status: 'ready' })
    await settle()
    expect(client.trackedResults).toBe(0)
    expect(handles[2].getSnapshot().state).toBe('lost')
    client.open(descriptor({ resultId: 6 }))
    expect(client.trackedResults).toBe(0)
  })

  it('bounds the text of the windows a result remembers', async () => {
    const workers: FakeWorker[] = []
    const window = new FakeWindow()
    const client = new ResultClient({ api: { openResultsPort: async () => ({ ok: true, value: undefined }) }, window, createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker }, windowCache: { units: 12 } })
    window.dispatch({ source: window, data: { type: 'varia:results-port' }, ports: [new MessageChannel().port1] })
    await client.ready()
    const handle = client.open(descriptor())
    for (const first of [0, 4, 8]) {
      const pending = handle.getWindow(first, 4)
      await settle()
      for (const request of workers[0].fromWorker.splice(0)) {
        if (request.t !== 'read') continue
        const body = encodePage({ resultId: 3, firstRow: request.firstRow, columns: [{ wire: 'text' }], rows: Array.from({ length: request.maxRows }, (_, index) => ['row ' + (request.firstRow + index)]) })
        workers[0].toWorker({ t: 'page', rid: request.rid, seq: 1, body: body.buffer as ArrayBuffer })
        workers[0].toWorker({ t: 'end', rid: request.rid, ok: true, result: { nextRow: request.firstRow + request.maxRows, rowsAvailable: 10, complete: true, pages: 1, rows: request.maxRows } })
      }
      await pending
    }
    // Each 4-row window holds 20 characters: only the latest stays.
    expect([0, 4, 8].map(first => handle.peekWindow(first, 4) !== undefined)).toEqual([false, false, true])
  })

  it('cancels a window when its signal aborts', async () => {
    const { client, worker, handOver } = fixture()
    handOver()
    const handle = client.open(descriptor())
    const controller = new AbortController()
    const pending = handle.getWindow(0, 10, { signal: controller.signal })
    await settle()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker().received.map(message => message.type)).toEqual(['attach', 'window', 'cancel'])
    expect(worker().fromWorker.map(request => request.t)).toEqual(['read', 'cancel'])
  })

  it('reports a port main refused', async () => {
    const window = new FakeWindow()
    const client = new ResultClient({ api: { openResultsPort: async () => ({ ok: false, error: 'The results connection was reopened too often. Reload the workbench.' }) }, window, createWorker: () => new FakeWorker() })
    await expect(client.ready()).rejects.toMatchObject({ code: 'PORT_CLOSED', message: 'The results connection was reopened too often. Reload the workbench.' })
    await expect(client.open(descriptor()).getWindow(0, 1)).rejects.toMatchObject({ code: 'PORT_CLOSED' })
  })
  it('shares one window cache, keyed by everything that shapes a window and bounded by windows and units', () => {
    const window = (characters: number): RowWindow => ({ first: 0, count: 1, colStart: 0, colEnd: 1, text: ['x'.repeat(characters)], flags: new Uint8Array(1) })
    const cache = new WindowCache(3, 100)
    const key = (result: string, first: number, display = true) => WindowCache.key(result, first, 128, 0, 32, 512, display)
    expect(key('1:3', 0)).not.toBe(key('1:3', 0, false))
    expect(key('1:3', 0)).not.toBe(WindowCache.key('1:3', 0, 128, 0, 32, 1024, true))
    cache.set(key('1:3', 0), '1:3', window(10))
    cache.set(key('1:3', 128), '1:3', window(10))
    cache.set(key('1:4', 0), '1:4', window(10))
    // A peek makes a window the most recently used, so the oldest other one goes first.
    expect(cache.get(key('1:3', 0))).toBeDefined()
    cache.set(key('1:4', 128), '1:4', window(10))
    expect([cache.get(key('1:3', 128)), cache.size, cache.units]).toEqual([undefined, 3, 30])
    cache.set(key('1:5', 0), '1:5', window(90))
    expect([cache.size, cache.units]).toEqual([2, 100])
    cache.set(key('1:5', 0), '1:5', window(200))
    expect([cache.size, cache.units]).toEqual([1, 200])
    cache.set(key('1:4', 0), '1:4', window(5))
    cache.dropResult('1:5')
    expect([cache.size, cache.units]).toEqual([1, 5])
    cache.clear()
    expect([cache.size, cache.units]).toEqual([0, 0])
  })

  it('opens one handle per result until it is disposed, which forgets its windows', async () => {
    const { client, handOver, serve } = fixture()
    handOver()
    const handle = client.open(descriptor())
    expect(client.open(descriptor())).toBe(handle)
    const pending = handle.getWindow(0, 4, { display: true })
    await settle()
    serve()
    await pending
    expect(handle.peekWindow(0, 4, { display: true })).toBeDefined()
    expect(handle.peekWindow(0, 4)).toBeUndefined()
    expect(client.windows.size).toBe(1)
    handle.dispose()
    expect(handle.peekWindow(0, 4, { display: true })).toBeUndefined()
    expect(client.windows.size).toBe(0)
    expect(client.open(descriptor())).not.toBe(handle)
  })

  it('queues closes while the results port is down and sends them once one is attached', async () => {
    const { client, worker, handOver } = fixture()
    const handle = client.open(descriptor())
    await client.release([handle.key, { generation: 1, resultId: 9 }, handle.key])
    expect(handle.getSnapshot().state).toBe('released')
    expect(client.queuedCloses).toBe(2)
    expect(worker().received).toEqual([])
    handOver()
    await settle()
    expect(client.queuedCloses).toBe(0)
    expect(worker().fromWorker).toEqual([{ t: 'close', rid: 1, generation: 1, resultIds: [3, 9] }])
    // A close the worker never answered, because it stopped, waits for the next port.
    worker().crash()
    await settle()
    expect(client.queuedCloses).toBe(2)
    // Results of an earlier backend generation are gone with it.
    handOver()
    await client.ready()
    worker().toWorker({ t: 'backend', generation: 2, status: 'ready' })
    await settle()
    expect(client.queuedCloses).toBe(0)
  })

  it('measures display columns in the worker, and reports its counters', async () => {
    const { client, handOver, serve, worker } = fixture()
    handOver()
    const handle = client.open(descriptor())
    const measuring = handle.measure(0, 10, 0, 1)
    await settle()
    serve()
    expect(await measuring).toEqual({ rows: 10, widths: Uint16Array.of(1) })
    expect(worker().received.at(-1)).toMatchObject({ type: 'measure', first: 0, count: 10, colStart: 0, colEnd: 1 })
    const window = handle.getWindow(0, 4)
    await settle()
    serve()
    await window
    const stats = client.stats()
    await settle()
    expect(await stats).toEqual({ workerBytes: worker().core.cachedBytes, workerPages: 3, uiWindows: 1, uiUnits: 4, inflight: 0 })
  })
})
