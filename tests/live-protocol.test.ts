import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { BackendSupervisor } from '../src/main/backend/supervisor'
import { ResultsPortHost, supervisorResults, type PortMainLike } from '../src/main/backend/results-port'
import { ResultClient, type PortMessageEvent, type ResultHandle, type WorkerLike } from '../src/renderer/src/results/ResultClient'
import { ResultsWorkerCore } from '../src/renderer/src/results/worker-core'
import type { WorkerRequest, WorkerResponse } from '../src/renderer/src/results/worker-protocol'
import type { PortMessage } from '../src/shared/ipc/port-messages'
import type { LiveProbeId } from '../src/shared/live/catalog'
import type { LiveSubscribeParams, LiveTick } from '../src/shared/live/schema'

// Main's whole live path over the fake backend's debug.synthetic source: the supervisor, the results port, and a worker
// stand-in that acknowledges each event as the page will once it has applied it; then the same path through the real
// worker core and ResultClient.

const supervisors: BackendSupervisor[] = []
afterEach(async () => { await Promise.all(supervisors.splice(0).map(value => value.stop())) })

class WorkerPort implements PortMainLike {
  readonly posted: PortMessage[] = []
  private listener: ((event: { data: unknown }) => void) | undefined
  /** Acknowledge each live event at once; while false, acknowledgements wait in `unacked`. */
  acking = true
  readonly unacked: { rid: number; bytes: number }[] = []
  postMessage(message: unknown): void {
    const value = structuredClone(message) as PortMessage
    this.posted.push(value)
    if (value.t !== 'live') return
    if (this.acking) queueMicrotask(() => this.send({ t: 'credit', rid: value.rid, bytes: value.bytes }))
    else this.unacked.push({ rid: value.rid, bytes: value.bytes })
  }
  on(event: 'message' | 'close', listener: never): unknown { if (event === 'message') this.listener = listener; return this }
  start(): void {}
  close(): void {}
  send(data: unknown): void { this.listener?.({ data }) }
  ticks(rid: number): LiveTick[] { return this.posted.flatMap(message => message.t === 'live' && message.rid === rid && message.event.type === 'live.tick' ? [message.event] : []) }
  end(rid: number) { return this.posted.find((message): message is Extract<PortMessage, { t: 'end' }> => message.t === 'end' && message.rid === rid) }
}

/** The fake backend's workbench mode behind main's supervisor and results port; with `custom`, the port is the caller's and
 *  opening it is left to the caller (a ResultClient asks for it); with `ready: false` it returns while the backend starts. */
async function workbench<P extends PortMainLike = WorkerPort>(custom?: P, o: { ready?: boolean } = {}) {
  const supervisor = new BackendSupervisor({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', resolve('tests/fixtures/backend.mjs'), 'workbench'], cwd: process.cwd(), packaged: false })
  supervisors.push(supervisor)
  const port = custom ?? new WorkerPort()
  const host = new ResultsPortHost({ backend: supervisorResults(supervisor), createChannel: () => ({ port1: port, port2: {} }), testSources: true })
  supervisor.onState(state => host.backendState(state))
  supervisor.start()
  if (o.ready !== false) await expect.poll(() => supervisor.state.status).toBe('ready')
  if (!custom) host.open({ postMessage: () => {} })
  return { supervisor, host, port: port as P }
}
const params = (args: Record<string, number>, probes = ['debug.synthetic.table', 'debug.synthetic.metrics', 'debug.synthetic.status']): LiveSubscribeParams => ({
  subscriptionId: crypto.randomUUID(), connectionId: crypto.randomUUID(), source: 'debug.synthetic', probes: probes.map(probe => ({ probe: probe as LiveProbeId, intervalMs: 1000 })), args
})
const latestTable = (port: WorkerPort, rid: number) => port.ticks(rid).flatMap(tick => tick.samples.flatMap(sample => sample.tables ?? [])).at(-1)!

describe('live subscriptions through main', () => {
  it('streams acknowledged ticks whose tables the renderer can read, pauses, resumes and cancels', async () => {
    const { host, port } = await workbench()
    const subscription = params({ tickMs: 30 })
    port.send({ t: 'live', rid: 1, generation: 1, params: subscription })
    await expect.poll(() => port.ticks(1).length).toBeGreaterThanOrEqual(3)
    const [first] = port.posted.filter(message => message.t === 'live')
    expect(first.t === 'live' && first.event).toMatchObject({ type: 'live.opened', seq: 0, source: 'debug.synthetic' })
    expect(port.ticks(1)[0].samples.map(sample => [sample.probe, sample.gap])).toEqual([['debug.synthetic.table', 'baseline'], ['debug.synthetic.metrics', 'baseline'], ['debug.synthetic.status', 'baseline']])
    const table = latestTable(port, 1)
    expect(table.descriptor).toMatchObject({ generation: 1, rowsAvailable: 3, state: 'complete' })
    port.send({ t: 'read', rid: 2, generation: 1, resultId: table.descriptor.resultId, firstRow: 0, maxRows: 10, credit: 65_536 })
    await expect.poll(() => port.end(2)).toMatchObject({ ok: true, result: { rows: 3, complete: true } })

    // Stop-and-wait end to end: without the acknowledgement, the source sends nothing more.
    port.acking = false
    await expect.poll(() => port.unacked.length).toBe(1)
    const held = port.ticks(1).length
    await new Promise(done => setTimeout(done, 300))
    expect(port.ticks(1).length).toBe(held)
    port.acking = true
    port.send({ t: 'credit', ...port.unacked.shift()! })
    await expect.poll(() => port.ticks(1).length).toBeGreaterThan(held + 1)

    port.send({ t: 'liveUpdate', rid: 3, generation: 1, params: { subscriptionId: subscription.subscriptionId, source: 'debug.synthetic', paused: true } })
    await expect.poll(() => port.end(3)).toMatchObject({ ok: true, result: { applied: true } })
    await new Promise(done => setTimeout(done, 100))
    const paused = port.ticks(1).length
    await new Promise(done => setTimeout(done, 200))
    expect(port.ticks(1).length).toBe(paused)
    port.send({ t: 'liveUpdate', rid: 4, generation: 1, params: { subscriptionId: subscription.subscriptionId, source: 'debug.synthetic', paused: false } })
    await expect.poll(() => port.ticks(1).length).toBeGreaterThan(paused)
    expect(port.ticks(1)[paused].samples.every(sample => sample.gap === 'resumed')).toBe(true)

    port.send({ t: 'cancel', rid: 1 })
    await expect.poll(() => port.end(1)).toMatchObject({ ok: true, result: { ended: 'cancelled' } })
    // Its results went with it.
    expect(host.owns(1, latestTable(port, 1).descriptor.resultId)).toBe(false)
    expect(host.liveCount).toBe(0)
  })

  it('keeps the last table of a source that ended until the renderer closes it', async () => {
    const { host, port } = await workbench()
    port.send({ t: 'live', rid: 1, generation: 1, params: params({ tickMs: 20, endAfterTicks: 3 }, ['debug.synthetic.table']) })
    await expect.poll(() => port.end(1)).toMatchObject({ ok: true, result: { ended: 'sourceEnded', ticks: 3 } })
    const tables = port.ticks(1).map(tick => tick.samples[0].tables![0])
    const end = port.end(1)!
    const kept = end.ok && 'kept' in end.result ? end.result.kept : undefined
    expect(kept).toEqual([tables[2].descriptor.resultId])
    expect(tables[2].retired).toEqual([tables[0].descriptor.resultId])
    expect([0, 1, 2].map(index => host.owns(1, tables[index].descriptor.resultId))).toEqual([false, false, true])
    port.send({ t: 'close', rid: 2, generation: 1, resultIds: kept })
    await expect.poll(() => port.end(2)).toMatchObject({ ok: true, result: { closed: 1 } })
    expect(host.ownedCount).toBe(0)
  })
})

/** Main's end of the port, delivering to the worker core in order, a task later, as structured clones (like a MessagePort). */
class LoopPort implements PortMainLike {
  core: ResultsWorkerCore | undefined
  private listener: ((event: { data: unknown }) => void) | undefined
  postMessage(message: unknown): void { const copy = structuredClone(message) as PortMessage; setTimeout(() => this.core?.receive(copy), 0) }
  on(event: 'message' | 'close', listener: never): unknown { if (event === 'message') this.listener = listener; return this }
  start(): void {}
  close(): void {}
  fromWorker(data: unknown): void { const copy = structuredClone(data); setTimeout(() => this.listener?.({ data: copy }), 0) }
}
/** The results worker in this thread: the real core between ResultClient and main's port. */
class LoopWorker implements WorkerLike {
  private readonly listeners: ((event: { data: WorkerResponse }) => void)[] = []
  readonly core = new ResultsWorkerCore({ post: message => { const copy = structuredClone(message); setTimeout(() => { for (const listener of this.listeners) listener({ data: copy }) }, 0) } })
  constructor(private readonly main: LoopPort) { main.core = this.core }
  postMessage(message: WorkerRequest): void {
    if (message.type === 'attach') this.core.attach({ postMessage: request => this.main.fromWorker(request) })
    else this.core.handle(message)
  }
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: never): void { if (type === 'message') this.listeners.push(listener) }
  terminate(): void {}
}

/** A ResultClient over the real worker core and main's port host, its port handed over as the preload does. */
function connect(host: ResultsPortHost, port: LoopPort) {
  const ports: MessagePort[] = []
  const window = { listener: undefined as ((event: PortMessageEvent) => void) | undefined, addEventListener(_type: 'message', listener: (event: PortMessageEvent) => void) { this.listener = listener }, removeEventListener() { this.listener = undefined } }
  let worker: LoopWorker | undefined
  const client = new ResultClient({
    // As the preload hands the port over: a message from the page's own window carrying one port.
    api: { openResultsPort: async () => {
      host.open({ postMessage: () => {} })
      const { port1 } = new MessageChannel()
      ports.push(port1)
      window.listener?.({ source: window, data: { type: 'varia:results-port' }, ports: [port1] })
      return { ok: true, value: undefined }
    } },
    window, createWorker: () => (worker = new LoopWorker(port)), schedule: callback => queueMicrotask(callback)
  })
  const close = () => {
    client.dispose()
    host.close()
    for (const item of ports) item.close()
  }
  return { client, worker: () => worker, close }
}

describe('live subscriptions through the results worker and ResultClient', () => {
  it('waits for a backend that is starting or restarting instead of reporting the view lost', async () => {
    const port = new LoopPort()
    const { supervisor, host } = await workbench(port, { ready: false })
    const { client, close } = connect(host, port)
    try {
      await client.ready()
      // A view restored with the workspace subscribes while the backend that will serve it is still starting.
      expect(supervisor.state.status).toBe('starting')
      const subscribe = () => {
        let ticks = 0
        const stream = client.live(params({ tickMs: 30 }, ['debug.synthetic.table']), (event, bytes) => {
          if (event.type === 'live.tick') ticks++
          stream.ack(bytes)
        })
        return { stream, ticks: () => ticks }
      }
      const first = subscribe()
      await expect.poll(() => first.ticks()).toBeGreaterThanOrEqual(2)
      expect(host.liveCount).toBe(1)

      // A restart loses the running stream; a resubscribe as soon as the page hears of the next generation (while it is
      // still starting) waits for it.
      let second: ReturnType<typeof subscribe> | undefined
      let status: string | undefined
      client.onGeneration(generation => {
        if (generation !== 2 || second) return
        status = supervisor.state.status
        second = subscribe()
      })
      void supervisor.restart('manual')
      expect(await first.stream.done).toMatchObject({ ok: false })
      await expect.poll(() => second?.ticks() ?? 0).toBeGreaterThanOrEqual(2)
      expect(status).toBe('starting')
      second!.stream.cancel()
      expect(await second!.stream.done).toMatchObject({ ok: true, value: { ended: 'cancelled' } })
    } finally {
      close()
    }
  })

  it('opens each table as a handle, paces the stream by the page\'s acknowledgements, and releases its results when it ends', async () => {
    const port = new LoopPort()
    const { host } = await workbench(port)
    const { client, worker, close } = connect(host, port)
    try {
      await client.ready()
      await expect.poll(() => client.backendGeneration).toBe(1)
      const handles: ResultHandle[] = [], held: number[] = []
      let acking = true, ticks = 0
      const stream = client.live(params({ tickMs: 30 }, ['debug.synthetic.table']), (event, bytes) => {
        if (event.type === 'live.tick') {
          ticks++
          for (const sample of event.samples) for (const table of sample.tables ?? []) handles.push(client.open(table.descriptor))
        }
        if (acking) stream.ack(bytes)
        else held.push(bytes)
      })
      await expect.poll(() => ticks).toBeGreaterThanOrEqual(4)
      // Retired revisions are released here as main takes them back, without a close.
      expect(handles[0].getSnapshot().state).toBe('released')
      expect(host.owns(1, handles[0].key.resultId)).toBe(false)

      // Stop-and-wait through the worker: an event the page has not acknowledged holds the stream, so the newest table stays.
      acking = false
      await expect.poll(() => held.length).toBe(1)
      const count = ticks
      await new Promise(done => setTimeout(done, 300))
      expect(ticks).toBe(count)
      const newest = handles.at(-1)!
      expect(newest.getSnapshot()).toMatchObject({ rowsAvailable: 3, state: 'complete' })
      const window_ = await newest.getWindow(0, 10)
      expect(window_.count).toBe(3)
      expect(window_.text.filter((_, index) => index % 3 === 0)).toEqual([0, 1, 2].map(offset => String(count + offset)))
      acking = true
      stream.ack(held.shift()!)
      await expect.poll(() => ticks).toBeGreaterThan(count + 1)

      const update = await stream.update({ paused: true })
      expect(update).toMatchObject({ ok: true, value: { applied: true, probes: [{ probe: 'debug.synthetic.table', paused: true }] } })
      stream.cancel()
      expect(await stream.done).toMatchObject({ ok: true, value: { ended: 'cancelled' } })
      expect(handles.every(handle => handle.getSnapshot().state === 'released')).toBe(true)
      expect([host.liveCount, host.ownedCount, client.liveStreams, worker()!.core.liveStreams]).toEqual([0, 0, 0, 0])
    } finally {
      close()
    }
  })
})
