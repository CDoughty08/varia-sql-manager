import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { BackendSupervisor } from '../src/main/backend/supervisor'
import { ResultsPortHost, supervisorResults, type PortMainLike } from '../src/main/backend/results-port'
import type { PortMessage } from '../src/shared/ipc/port-messages'
import type { LiveTick } from '../src/shared/live/schema'

// Main's whole live path over the fake backend's debug.synthetic source: the supervisor, the results port, and a worker
// stand-in that acknowledges each event as the page will once it has applied it.

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

async function workbench() {
  const supervisor = new BackendSupervisor({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', resolve('tests/fixtures/backend.mjs'), 'workbench'], cwd: process.cwd(), packaged: false })
  supervisors.push(supervisor)
  const port = new WorkerPort()
  const host = new ResultsPortHost({ backend: supervisorResults(supervisor), createChannel: () => ({ port1: port, port2: {} }), testSources: true })
  supervisor.onState(state => host.backendState(state))
  supervisor.start()
  await expect.poll(() => supervisor.state.status).toBe('ready')
  host.open({ postMessage: () => {} })
  return { supervisor, host, port }
}
const params = (args: Record<string, number>, probes = ['debug.synthetic.table', 'debug.synthetic.metrics', 'debug.synthetic.status']) => ({
  subscriptionId: crypto.randomUUID(), connectionId: crypto.randomUUID(), source: 'debug.synthetic', probes: probes.map(probe => ({ probe, intervalMs: 1000 })), args
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
