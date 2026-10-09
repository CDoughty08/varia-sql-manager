import { afterAll, beforeAll, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { BackendSupervisor } from '../../src/main/backend/supervisor'
import { ResultsPortHost, supervisorResults, type FrameLike, type PortMainLike } from '../../src/main/backend/results-port'
import type { ResultDescriptor } from '../../src/shared/contracts'
import type { PortMessage } from '../../src/shared/ipc/port-messages'
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
  host = new ResultsPortHost({ backend: supervisorResults(supervisor), createChannel: () => { const { port1, port2 } = new MessageChannel(); return { port1: portMain(port1), port2 } } })
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
    expect(await supervisor.request('results.close', { resultIds: [descriptor.resultId] })).toMatchObject({ closed: 1 })
    return { ...result, descriptor, eventLoopP99Ms: delay.percentile(99) / 1e6, pageBytes: posted.pageBytes, distinctBytes: posted.distinctBytes }
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
    { id: 'node.storedPerWire', value: w1.descriptor.bytesStored / w1.distinctBytes, unit: '×', detail: `${w1.descriptor.bytesStored} bytes stored for ${w1.distinctBytes} bytes of distinct pages` }
  )
})

it('streams B1 rows (two 4 KB values each) into the results worker', async () => {
  const b1 = await pipeline('B1', 20_000, { windowRows: 400, maxCellChars: 65_535 })
  record({ id: 'node.b1.mbPerSecond', value: mbPerSecond(b1.distinctBytes, b1.elapsedMs), unit: 'MB/s', detail: `${(b1.distinctBytes / MiB).toFixed(0)} MiB of pages in ${Math.round(b1.elapsedMs)} ms` })
})
