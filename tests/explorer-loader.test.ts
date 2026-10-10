import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, ExplorerChildrenResult, VariaApi } from '../src/shared/contracts'
import type { ExplorerChildrenParams } from '../src/shared/explorer/refs'
import { envelopeOutcome, ExplorerLoader, queueFullMessage, type LoaderLimits, type LoadOutcome, type LoadPriority, type LoadTask } from '../src/renderer/src/explorer/loader'
import { manualTimers } from './fixtures/workbench'

const page: ExplorerChildrenResult = { nodes: [], elapsedMs: 1 }
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function fixture(limits: Partial<LoaderLimits> = {}) {
  const sent: { params: ExplorerChildrenParams; resolve: (result: ApiResult<ExplorerChildrenResult>) => void; reject: (error: unknown) => void }[] = []
  const api = {
    explorerChildren: vi.fn<VariaApi['explorerChildren']>(params => new Promise((resolve, reject) => { sent.push({ params, resolve, reject }) })),
    explorerCancel: vi.fn<VariaApi['explorerCancel']>(async ids => ({ ok: true, value: { cancelled: ids.length } }))
  }
  const ticks: (() => void)[] = []
  const { timers, advance } = manualTimers()
  let ids = 0
  const pendingChanges = vi.fn()
  const loader = new ExplorerLoader({ api, timers, schedule: callback => { ticks.push(callback) }, newId: () => `req-${++ids}`, limits, onPendingChange: pendingChanges })
  const outcomes = new Map<string, LoadOutcome>()
  const enqueue = (connectionId: string, nodeId: number, priority: LoadPriority = 'user', cursor?: string, generation = 0): LoadTask => {
    const task: LoadTask = loader.enqueue({ connectionId, nodeId, generation, params: { node: { type: 'object', object: { kind: 'server' } }, ...cursor ? { cursor } : {} } }, priority, outcome => outcomes.set(task.requestId, outcome))
    return task
  }
  /** Request ids sent so far, in order. */
  const requests = () => sent.map(entry => entry.params.requestId)
  const answer = (requestId: string, result: ApiResult<ExplorerChildrenResult> = { ok: true, value: page }) => sent.find(entry => entry.params.requestId === requestId)!.resolve(result)
  const tick = () => ticks.splice(0).forEach(callback => callback())
  return { loader, api, sent, requests, answer, enqueue, outcomes, tick, advance, pendingChanges }
}

describe('ExplorerLoader', () => {
  it('runs at most 4 loads per connection and 8 in all, oldest first', async () => {
    const f = fixture()
    const tasks = ['a', 'b', 'c'].flatMap(connection => Array.from({ length: 6 }, (_, index) => f.enqueue(connection, index + 1)))
    const byConnection = () => f.sent.reduce<Record<string, number>>((counts, entry) => ({ ...counts, [entry.params.connectionId]: (counts[entry.params.connectionId] ?? 0) + 1 }), {})
    expect(f.requests()).toHaveLength(8)
    expect(byConnection()).toEqual({ a: 4, b: 4 })
    expect(f.loader.inFlight).toBe(8)
    expect(f.loader.pending).toBe(18)
    // A freed slot goes to the oldest waiting load whose connection has room.
    f.answer(tasks[0].requestId)
    await settle()
    expect(f.requests().at(-1)).toBe(tasks[4].requestId)
    f.answer(tasks[6].requestId)
    await settle()
    expect(f.requests().at(-1)).toBe(tasks[10].requestId)
    expect(f.outcomes.get(tasks[0].requestId)).toEqual({ ok: true, result: page })
    expect(f.sent[0].params).toEqual({ node: { type: 'object', object: { kind: 'server' } }, connectionId: 'a', requestId: tasks[0].requestId })
  })
  it('runs user loads before background ones, first in first out within each', async () => {
    const f = fixture({ inFlightTotal: 1 })
    const first = f.enqueue('a', 1, 'background')
    const background = [f.enqueue('a', 2, 'background'), f.enqueue('b', 3, 'background')]
    const user = [f.enqueue('b', 4, 'user'), f.enqueue('a', 5, 'user')]
    const order = [first.requestId]
    for (let step = 0; step < 4; step++) { f.answer(order.at(-1)!); await settle(); order.push(f.requests().at(-1)!) }
    expect(order).toEqual([first, ...user, ...background].map(task => task.requestId))
  })
  it('deduplicates by node, cursor and generation, moving a waiting duplicate up to user priority', async () => {
    const f = fixture({ inFlightTotal: 1 })
    const running = f.enqueue('a', 1)
    const waiting = f.enqueue('a', 2, 'background', 'v1.tables.x')
    const other = f.enqueue('a', 3, 'user')
    expect(f.enqueue('a', 1)).toBe(running)
    expect(f.enqueue('a', 2, 'user', 'v1.tables.x')).toBe(waiting)
    expect(waiting.priority).toBe('user')
    expect(f.enqueue('a', 2, 'user', 'v1.tables.y')).not.toBe(waiting)
    expect(f.enqueue('a', 1, 'user', undefined, 1)).not.toBe(running)
    expect(f.loader.pending).toBe(5)
    f.answer(running.requestId)
    await settle()
    expect(f.requests()[1]).toBe(waiting.requestId)
    expect(other.state).toBe('queued')
  })
  it('drops background loads first when a connection has 512 waiting, then refuses', async () => {
    const f = fixture({ inFlightPerConnection: 1, queuePerConnection: 3 })
    f.enqueue('a', 1)
    const background = [f.enqueue('a', 2, 'background'), f.enqueue('a', 3, 'background')]
    f.enqueue('a', 4, 'user')
    const refusedBackground = f.enqueue('a', 5, 'background')
    const user = f.enqueue('a', 6, 'user')
    const user2 = f.enqueue('a', 7, 'user')
    const refusedUser = f.enqueue('a', 8, 'user')
    // Another connection has its own queue.
    const other = f.enqueue('b', 9, 'background')
    await settle()
    const refused = { ok: false, error: { code: 'REQUEST_FAILED', message: queueFullMessage, retryable: true }, connectionLost: false }
    for (const task of [refusedBackground, background[0], background[1], refusedUser]) expect(f.outcomes.get(task.requestId), String(task.nodeId)).toEqual(refused)
    expect([user.state, user2.state, other.state]).toEqual(['queued', 'queued', 'running'])
    expect(f.loader.pending).toBe(5)
    expect(f.api.explorerChildren).toHaveBeenCalledTimes(2)
  })
  it('aborts waiting loads without IPC, and batches running aborts into one cancel per tick', async () => {
    const f = fixture({ inFlightTotal: 300, inFlightPerConnection: 300 })
    const running = Array.from({ length: 300 }, (_, index) => f.enqueue('a', index + 1))
    const queued = f.enqueue('a', 1000)
    expect(queued.state).toBe('queued')
    f.loader.abort(queued)
    f.loader.abort(queued)
    expect(f.loader.abortWhere(task => task.nodeId <= 300)).toBe(300)
    expect(f.api.explorerCancel).not.toHaveBeenCalled()
    expect(f.loader.pending).toBe(0)
    f.tick()
    expect(f.api.explorerCancel.mock.calls.map(([ids]) => ids.length)).toEqual([256, 44])
    expect(f.api.explorerCancel.mock.calls.flatMap(([ids]) => ids)).toEqual(running.map(task => task.requestId))
    expect(f.requests()).not.toContain(queued.requestId)
    // Aborted loads never settle; their slots come back when the backend answers.
    for (const task of running) f.answer(task.requestId, { ok: false, error: 'The operation was cancelled.', code: 'CANCELLED' })
    await settle()
    expect(f.outcomes.size).toBe(0)
    expect(f.loader.inFlight).toBe(0)
  })
  it('flushes cancels on a microtask by default, calling queueMicrotask as the browser requires', async () => {
    // Chromium's queueMicrotask throws "Illegal invocation" unless called on the global object.
    const real = globalThis.queueMicrotask
    vi.stubGlobal('queueMicrotask', function (this: unknown, callback: () => void) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
      real(callback)
    })
    try {
      const api = {
        explorerChildren: vi.fn<VariaApi['explorerChildren']>(() => new Promise(() => {})),
        explorerCancel: vi.fn<VariaApi['explorerCancel']>(async ids => ({ ok: true, value: { cancelled: ids.length } }))
      }
      let ids = 0
      const loader = new ExplorerLoader({ api, timers: manualTimers().timers, newId: () => `req-${++ids}` })
      const request = { connectionId: 'a', generation: 0, params: { node: { type: 'object', object: { kind: 'server' } } } } as const
      const first = loader.enqueue({ ...request, nodeId: 1 }, 'user', () => {}), second = loader.enqueue({ ...request, nodeId: 2 }, 'user', () => {})
      loader.abort(first)
      loader.abort(second)
      await settle()
      expect(api.explorerCancel.mock.calls).toEqual([[['req-1', 'req-2']]])
      // The next abort is sent too: a failed schedule would have left the batch closed for good.
      loader.abort(loader.enqueue({ ...request, nodeId: 3 }, 'user', () => {}))
      await settle()
      expect(api.explorerCancel.mock.calls).toEqual([[['req-1', 'req-2']], [['req-3']]])
      loader.dispose()
    } finally { vi.unstubAllGlobals() }
  })
  it('times a load out after 60 seconds: it is cancelled, settles as TIMEOUT and frees its slot', async () => {
    const f = fixture({ inFlightTotal: 1 })
    const slow = f.enqueue('a', 1), next = f.enqueue('a', 2)
    f.advance(59_999)
    expect(f.outcomes.size).toBe(0)
    f.advance(1)
    await settle()
    expect(f.outcomes.get(slow.requestId)).toEqual({ ok: false, error: { code: 'TIMEOUT', message: 'Object Explorer did not answer within 60 seconds.', retryable: true }, connectionLost: false })
    f.tick()
    expect(f.api.explorerCancel).toHaveBeenCalledWith([slow.requestId])
    expect(f.requests()).toEqual([slow.requestId, next.requestId])
    // A late answer changes nothing.
    f.answer(slow.requestId)
    await settle()
    expect(f.outcomes.get(slow.requestId)?.ok).toBe(false)
    expect(f.loader.inFlight).toBe(1)
    // An aborted load's watchdog still gives its slot back.
    f.loader.abort(next)
    f.advance(60_000)
    expect(f.loader.inFlight).toBe(0)
  })
  it('maps failed envelopes: lost connections mark the server, everything else is an error row', async () => {
    expect(envelopeOutcome({ error: 'Connect to a SQL Server first.', code: 'NOT_CONNECTED' })).toEqual({ ok: false, error: { code: 'CONNECTION_LOST', message: 'Connect to a SQL Server first.', retryable: true }, connectionLost: true })
    for (const code of ['BACKEND_LOST', 'BACKEND_UNAVAILABLE', 'CONNECTION_LOST']) expect(envelopeOutcome({ error: 'x', code }).connectionLost, code).toBe(true)
    expect(envelopeOutcome({ error: 'Too slow.', code: 'TIMEOUT' }).error).toEqual({ code: 'TIMEOUT', message: 'Too slow.', retryable: true })
    expect(envelopeOutcome({ error: 'Bad ref.', code: 'INVALID_PARAMS' })).toEqual({ ok: false, error: { code: 'REQUEST_FAILED', message: 'Bad ref.', retryable: true }, connectionLost: false })
    expect(envelopeOutcome({ error: 'Odd.' }).error.code).toBe('REQUEST_FAILED')
    const f = fixture()
    const failed = f.enqueue('a', 1), thrown = f.enqueue('a', 2)
    f.answer(failed.requestId, { ok: false, error: 'Connect to a SQL Server first.', code: 'NOT_CONNECTED' })
    f.sent[1].reject(new Error('IPC failed.'))
    await settle()
    expect(f.outcomes.get(failed.requestId)).toMatchObject({ ok: false, connectionLost: true })
    expect(f.outcomes.get(thrown.requestId)).toEqual({ ok: false, error: { code: 'REQUEST_FAILED', message: 'IPC failed.', retryable: true }, connectionLost: false })
  })
  it('reports pending changes and settles every load exactly once, asynchronously', async () => {
    const f = fixture()
    const task = f.enqueue('a', 1)
    expect(f.pendingChanges).toHaveBeenCalledTimes(1)
    f.answer(task.requestId)
    f.answer(task.requestId)
    expect(f.outcomes.size).toBe(0)
    await settle()
    expect(f.outcomes.size).toBe(1)
    expect(f.pendingChanges).toHaveBeenCalledTimes(2)
    expect(f.loader.pending).toBe(0)
  })
  it('cancels running loads at once when disposed and accepts nothing after', async () => {
    const f = fixture()
    const running = f.enqueue('a', 1), second = f.enqueue('a', 2)
    f.loader.dispose()
    expect(f.api.explorerCancel).toHaveBeenCalledWith([running.requestId, second.requestId])
    expect(f.enqueue('a', 3).state).toBe('aborted')
    expect(f.api.explorerChildren).toHaveBeenCalledTimes(2)
    f.answer(running.requestId)
    await settle()
    expect(f.outcomes.size).toBe(0)
  })
})
