import { afterAll, beforeAll, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { BackendSupervisor } from '../../src/main/backend/supervisor'
import { ResultsPortHost, supervisorResults, type FrameLike, type PortMainLike } from '../../src/main/backend/results-port'
import type { ResultDescriptor } from '../../src/shared/contracts'
import type { PortMessage } from '../../src/shared/ipc/port-messages'
import type { LiveTick } from '../../src/shared/live/schema'
import { mbPerSecond, median, percentile, record } from './harness'

// Main's real pipeline against the Release backend with its test hooks: BackendSupervisor and BackendConnection over
// stdio, ResultsPortHost, a MessageChannel, and ResultsWorkerCore in its own thread (tests/bench/results-thread.mjs).
const dll = resolve('backend/Varia.Backend/bin/Release/net10.0/Varia.Backend.dll')
const MiB = 1024 * 1024
let supervisor: BackendSupervisor
let host: ResultsPortHost
/** What main posted to the worker: every page body, and the distinct pages among them. */
const posted = { pageBytes: 0, distinctBytes: 0, distinct: new Set<string>() }

/** Node's MessagePort as Electron's MessagePortMain; counts the page bytes main forwards. */
function portMain(port: MessagePort): PortMainLike {
  return {
    postMessage: message => {
      const page = message as PortMessage
      if (page.t === 'page') {
        posted.pageBytes += page.body.byteLength
        // The header names the result, first row and row count, so it identifies a page sent more than once.
        const id = Buffer.from(page.body, 0, Math.min(32, page.body.byteLength)).toString('hex')
        if (!posted.distinct.has(id)) { posted.distinct.add(id); posted.distinctBytes += page.body.byteLength }
      }
      port.postMessage(message)
    },
    on: ((event: 'message' | 'close', listener: (event?: { data: unknown }) => void) => event === 'message' ? port.on('message', data => listener({ data })) : port.on('close', () => listener())) as PortMainLike['on'],
    start: () => port.start(),
    close: () => port.close()
  }
}

beforeAll(async () => {
  if (!existsSync(dll)) throw new Error('Build the Release backend first: npm run check (or npm run backend:test).')
  supervisor = new BackendSupervisor({ command: 'dotnet', args: [dll], cwd: process.cwd(), packaged: false, env: { ...process.env, VARIA_BACKEND_TEST_HOOKS: '1', VARIA_RESULT_BUDGET_BYTES: String(1024 * MiB) } })
  // Test sources: the live round trip runs on the backend's debug.synthetic source, as the smoke tests do.
  host = new ResultsPortHost({ backend: supervisorResults(supervisor), createChannel: () => { const { port1, port2 } = new MessageChannel(); return { port1: portMain(port1), port2 } }, testSources: true })
  supervisor.onState(state => host.backendState(state))
  const ready = new Promise<void>((done, fail) => supervisor.onState(state => { if (state.status === 'ready') done(); else if (state.status === 'failed') fail(new Error(state.message)) }))
  supervisor.start()
  await ready
})
afterAll(async () => { host?.close(); await supervisor?.stop() })

it('round-trips system.health between main and the backend', async () => {
  for (let i = 0; i < 300; i++) await supervisor.request('system.health', {})
  const samples: number[] = []
  for (let i = 0; i < 2000; i++) {
    const started = performance.now()
    await supervisor.request('system.health', {})
    samples.push(performance.now() - started)
  }
  record(
    { id: 'node.health.p50Ms', value: percentile(samples, 50), unit: 'ms', detail: '2,000 sequential calls' },
    { id: 'node.health.p99Ms', value: percentile(samples, 99), unit: 'ms', detail: '2,000 sequential calls' }
  )
})

it('answers 256 concurrent system.health requests', async () => {
  const run = async () => {
    const started = performance.now()
    const answers = await Promise.all(Array.from({ length: 256 }, () => supervisor.request('system.health', {})))
    expect(answers.every(answer => answer.protocolVersion === 2)).toBe(true)
    return performance.now() - started
  }
  await run()
  const runs: number[] = []
  for (let i = 0; i < 5; i++) runs.push(await run())
  record({ id: 'node.health.concurrent256Ms', value: median(runs), unit: 'ms', detail: 'median of 5 runs' })
})

/** Stores `rows` synthetic rows, then reads all of them through the results port into a worker thread. */
async function pipeline(shape: 'W1' | 'B1', rows: number, o: { windowRows: number; maxCellChars: number }) {
  const descriptor = await supervisor.request('debug.results.synthesize', { shape, rows }) as ResultDescriptor
  expect(descriptor).toMatchObject({ rowsStored: rows, rowsAvailable: rows, state: 'complete' })
  host.own([descriptor])
  let workerPort: MessagePort | undefined
  const frame: FrameLike = { postMessage: (_channel, _message, transfer) => { workerPort = transfer[0] as unknown as MessagePort } }
  host.open(frame)
  posted.pageBytes = posted.distinctBytes = 0
  posted.distinct.clear()
  const worker = new Worker(new URL('./results-thread.mjs', import.meta.url), {
    execArgv: ['--disable-warning=ExperimentalWarning'], transferList: [workerPort!],
    workerData: { port: workerPort, key: { generation: descriptor.generation, resultId: descriptor.resultId }, wires: descriptor.columns.map(column => column.wire), rows, windowRows: o.windowRows, inFlight: 4, maxCellChars: o.maxCellChars, textBudget: 4_000_000 }
  })
  try {
    await new Promise((done, fail) => { worker.once('message', done); worker.once('error', fail) })
    const delay = monitorEventLoopDelay({ resolution: 10 })
    delay.enable()
    const result = await new Promise<{ rows: number; cells: number; characters: number; cut: number; errors: string[]; elapsedMs: number }>((done, fail) => {
      worker.once('message', done)
      worker.once('error', fail)
      worker.postMessage('start')
    })
    delay.disable()
    expect(result.errors).toEqual([])
    expect(result.rows).toBe(rows)
    expect(result.cells).toBe(rows * descriptor.columns.length)
    expect(result.cut).toBe(0)
    // Closing an id that was never issued closes nothing and reports the budget in use, so the difference is what this
    // result was charged: pages, their bookkeeping and the column metadata.
    const before = await supervisor.request('results.close', { resultIds: [2 ** 32 - 1] })
    const closed = await supervisor.request('results.close', { resultIds: [descriptor.resultId] })
    expect(closed).toMatchObject({ closed: 1 })
    return { ...result, descriptor, eventLoopP99Ms: delay.percentile(99) / 1e6, pageBytes: posted.pageBytes, distinctBytes: posted.distinctBytes, chargedBytes: before.usedBytes - closed.usedBytes }
  } finally {
    await worker.terminate()
  }
}

it('streams 500,000 W1 rows from the store into the results worker', async () => {
  await pipeline('W1', 20_000, { windowRows: 4096, maxCellChars: 1024 })
  const w1 = await pipeline('W1', 500_000, { windowRows: 4096, maxCellChars: 1024 })
  const detail = `${(w1.distinctBytes / MiB).toFixed(0)} MiB of pages (${(w1.pageBytes / MiB).toFixed(0)} MiB sent) in ${Math.round(w1.elapsedMs)} ms`
  record(
    { id: 'node.w1.rowsPerSecond', value: w1.rows / (w1.elapsedMs / 1000), unit: 'rows/s', detail },
    { id: 'node.w1.mbPerSecond', value: mbPerSecond(w1.distinctBytes, w1.elapsedMs), unit: 'MB/s', detail },
    { id: 'node.w1.eventLoopP99Ms', value: w1.eventLoopP99Ms, unit: 'ms', detail: 'main thread, monitorEventLoopDelay p99' },
    { id: 'node.w1.sentPerDistinct', value: w1.pageBytes / w1.distinctBytes, unit: '×', detail: `${w1.pageBytes} page bytes sent for ${w1.distinctBytes} bytes of distinct pages` },
    { id: 'node.storedPerWire', value: w1.chargedBytes / w1.distinctBytes, unit: '×', detail: `${w1.chargedBytes} bytes charged to the budget for ${w1.distinctBytes} bytes of distinct pages` }
  )
})

it('streams B1 rows (two 4 KB values each) into the results worker', async () => {
  const b1 = await pipeline('B1', 20_000, { windowRows: 400, maxCellChars: 65_535 })
  record({ id: 'node.b1.mbPerSecond', value: mbPerSecond(b1.distinctBytes, b1.elapsedMs), unit: 'MB/s', detail: `${(b1.distinctBytes / MiB).toFixed(0)} MiB of pages in ${Math.round(b1.elapsedMs)} ms` })
})

it('round-trips a live tick: the page\'s acknowledgement → worker → main → backend → the next tick at the page', async () => {
  let workerPort: MessagePort | undefined
  host.open({ postMessage: (_channel, _message, transfer) => { workerPort = transfer[0] as unknown as MessagePort } })
  // A 10 ms source and acknowledgements held 20 ms: each next sample is overdue when its credit arrives, so the time from
  // the acknowledgement to the next event is the whole loop, not the source's schedule.
  const params = { subscriptionId: crypto.randomUUID(), connectionId: crypto.randomUUID(), source: 'debug.synthetic', probes: [{ probe: 'debug.synthetic.metrics', intervalMs: 1000 }], args: { tickMs: 10 } }
  const worker = new Worker(new URL('./live-thread.mjs', import.meta.url), { execArgv: ['--disable-warning=ExperimentalWarning'], transferList: [workerPort!], workerData: { port: workerPort, params } })
  const samples: number[] = []
  let ackedAt = 0, events = 0
  try {
    await new Promise<void>((done, fail) => {
      worker.on('error', fail)
      worker.on('message', (message: { type: string; bytes?: number; message?: string }) => {
        if (message.type === 'error' || message.type === 'liveEnd') return fail(new Error(`The live stream ended: ${JSON.stringify(message)}`))
        if (message.type !== 'live') return
        // The first events (opened, the baseline) warm the path up.
        if (++events > 5 && ackedAt > 0) samples.push(performance.now() - ackedAt)
        if (samples.length >= 300) return done()
        setTimeout(() => { ackedAt = performance.now(); worker.postMessage({ type: 'ack', bytes: message.bytes }) }, 20)
      })
    })
  } finally {
    worker.postMessage({ type: 'cancel' })
    await new Promise(done => setTimeout(done, 50))
    await worker.terminate()
  }
  expect(host.liveCount).toBe(0)
  record({ id: 'node.liveData.tickRoundTripP50Ms', value: median(samples), unit: 'ms', detail: `${samples.length} ticks; p99 ${percentile(samples, 99).toFixed(2)} ms` })
})

it('swaps 5,000-row × 23-column live snapshots through main', async () => {
  // The whole live path on main's side (ResultsPortHost with the test sources, the supervisor, the backend's table writer)
  // with a worker stand-in that acknowledges each frame at once, as the page does once it has applied it: every revision is
  // stored, owned, retired, forgotten and released, one at a time, at the source's fastest test period.
  const posted: PortMessage[] = []
  let send: ((data: unknown) => void) | undefined
  const port: PortMainLike = {
    postMessage: message => {
      const value = message as PortMessage
      if (value.t === 'live') queueMicrotask(() => send?.({ t: 'credit', rid: value.rid, bytes: value.bytes }))
      if (value.t === 'live' || value.t === 'end') posted.push(value)
    },
    on: ((event: 'message' | 'close', listener: (event: { data: unknown }) => void) => { if (event === 'message') send = data => listener({ data }) }) as PortMainLike['on'],
    start: () => {},
    close: () => {}
  }
  const live = new ResultsPortHost({ backend: supervisorResults(supervisor), createChannel: () => ({ port1: port, port2: {} }), testSources: true })
  supervisor.onState(state => live.backendState(state))
  live.backendState(supervisor.state)
  live.open({ postMessage: () => {} })
  const state = supervisor.state
  const generation = state.status === 'ready' ? state.generation : 0
  const ticks = () => posted.flatMap(message => message.t === 'live' && message.event.type === 'live.tick' ? [message.event as LiveTick] : [])
  const subscriptionId = crypto.randomUUID()
  send!({ t: 'live', rid: 1, generation, params: { subscriptionId, connectionId: crypto.randomUUID(), source: 'debug.synthetic', probes: [{ probe: 'debug.synthetic.wide', intervalMs: 1000 }], args: { tickMs: 10, rows: 5000 } } })
  await expect.poll(() => ticks().length, { timeout: 30_000 }).toBeGreaterThanOrEqual(20)
  const gen2 = (tick: LiveTick) => Number(tick.samples[0].status?.find(item => item.id === 'gen2')?.value ?? 0)
  const first = ticks().length - 1, started = performance.now()
  await new Promise(done => setTimeout(done, 5000))
  const all = ticks(), elapsedMs = performance.now() - started
  const swaps = all.length - 1 - first
  send!({ t: 'cancel', rid: 1 })
  await expect.poll(() => posted.some(message => message.t === 'end' && message.rid === 1), { timeout: 10_000 }).toBe(true)
  // Every revision arrived complete, and all of them went with the subscription.
  expect(all.slice(first).every(tick => tick.samples[0].tables?.[0].descriptor.rowsAvailable === 5000)).toBe(true)
  expect(live.ownedCount).toBe(0)
  const collections = gen2(all.at(-1)!) - gen2(all[first])
  live.close()
  record(
    { id: 'node.liveData.snapshotSwapsPerSecond', value: swaps / (elapsedMs / 1000), unit: 'swaps/s', detail: `${swaps} revisions of 5,000 × 23 in ${Math.round(elapsedMs)} ms, ${collections} gen2 collections` },
    // As a 1 s snapshot runs them: the collections follow the revisions written (each promotes what lives across a collection),
    // not the clock, so the figure does not depend on how fast this machine swaps.
    { id: 'node.liveData.snapshotGen2PerMinute', value: collections * 60 / Math.max(1, swaps), unit: 'collections/min', detail: `${collections} gen2 collections in ${swaps} revisions (${Math.round(collections * 60_000 / elapsedMs)} a minute at this rate)` }
  )
}, 60_000)
