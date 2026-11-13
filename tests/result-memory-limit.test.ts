import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BackendState } from '../src/shared/contracts'
import { ResultMemoryLimit, resultMemoryLimitParams } from '../src/main/backend/result-memory'
import { resultsMemoryLimitSchema } from '../src/main/validation'
import { mainOnlyMethods, methodPolicies } from '../src/shared/ipc/methods'
import { settingDef } from '../src/shared/settings/catalog'

const ready = (generation: number): BackendState => ({ status: 'ready', generation, pid: 1, runtime: 'test', platform: 'test' })

/** A supervisor's state and request, with each request answered by hand. */
function harness(initial: unknown = 0) {
  let value = initial
  const listeners = new Set<(state: BackendState) => void>()
  const sent: { limitGiB: number; generation: number }[] = []
  const pending: ((ok: boolean) => void)[] = []
  const limit = new ResultMemoryLimit({
    request: (params, generation) => new Promise((resolve, reject) => {
      sent.push({ ...params, generation })
      pending.push(ok => ok ? resolve({}) : reject(new Error('lost')))
    }),
    onState: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    read: () => value
  })
  // Settles the sender's promise chain (an answer, its then, the loop's next turn) without a timer.
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  return {
    limit, sent,
    state: (state: BackendState) => { for (const listener of listeners) listener(state) },
    set: (next: unknown) => { value = next; limit.settingsChanged() },
    /** Answers the oldest request still open. */
    answer: async (ok = true) => { pending.shift()?.(ok); await flush() },
    requests: () => [...sent],
    flush
  }
}

describe('result memory limit (results.setMemoryLimit)', () => {
  it('applies at once now, not at the next backend start', () => {
    expect(settingDef('queryResults.grid.memoryLimitGiB')).toMatchObject({ applies: 'immediately', min: 0, max: 1024 })
  })

  it('is a main-only control method with a strict 0 to 1024 GiB schema, and main clamps the setting as at launch', () => {
    expect(mainOnlyMethods).toContain('results.setMemoryLimit')
    expect(methodPolicies['results.setMemoryLimit']).toMatchObject({ kind: 'unary', lane: 'control', deadlineMs: 10_000 })
    for (const limitGiB of [0, 1, 8, 1024]) expect(resultsMemoryLimitSchema.parse({ limitGiB })).toEqual({ limitGiB })
    for (const params of [{ limitGiB: -1 }, { limitGiB: 1025 }, { limitGiB: 1.5 }, { limitGiB: '4' }, { limitGiB: Number.NaN }, {}, { limitGiB: 4, extra: 1 }])
      expect(resultsMemoryLimitSchema.safeParse(params).success, JSON.stringify(params)).toBe(false)
    expect(resultMemoryLimitParams(8)).toEqual({ limitGiB: 8 })
    expect(resultMemoryLimitParams(4096)).toEqual({ limitGiB: 1024 })
    for (const value of [0, -1, 1.5, Number.NaN, '8', undefined, null]) expect(resultMemoryLimitParams(value), String(value)).toEqual({ limitGiB: 0 })
  })

  it('sends the limit as each backend generation becomes ready, and not again while it stays ready', async () => {
    const h = harness(8)
    h.state({ status: 'starting', generation: 1 })
    expect(h.requests()).toEqual([])
    h.state(ready(1))
    expect(h.requests()).toEqual([{ limitGiB: 8, generation: 1 }])
    await h.answer()
    h.state({ status: 'unresponsive', generation: 1, silentMs: 9000 })
    h.state(ready(1))
    expect(h.requests()).toHaveLength(1)
    h.state({ status: 'restarting', generation: 1, retryInMs: 500 })
    h.state(ready(2))
    expect(h.requests()).toEqual([{ limitGiB: 8, generation: 1 }, { limitGiB: 8, generation: 2 }])
  })

  it('sends the limit when the setting changes, only when it differs, and waits for a ready backend', async () => {
    const h = harness(0)
    h.set(4)
    expect(h.requests()).toEqual([])
    h.state(ready(1))
    expect(h.requests()).toEqual([{ limitGiB: 4, generation: 1 }])
    await h.answer()
    h.set(4)
    await h.flush()
    expect(h.requests()).toHaveLength(1)
    h.set(0)
    await h.flush()
    expect(h.requests().at(-1)).toEqual({ limitGiB: 0, generation: 1 })
  })

  it('keeps one request in flight, so the last value set is the one applied', async () => {
    const h = harness(0)
    h.state(ready(1))
    h.set(2)
    h.set(6)
    expect(h.requests()).toEqual([{ limitGiB: 0, generation: 1 }])
    await h.answer()
    expect(h.requests()).toEqual([{ limitGiB: 0, generation: 1 }, { limitGiB: 6, generation: 1 }])
    await h.answer()
    expect(h.requests()).toHaveLength(2)
  })

  it('sends again after a failure at the next change, and gives a new generation its own request', async () => {
    const h = harness(3)
    h.state(ready(1))
    await h.answer(false)
    expect(h.requests()).toHaveLength(1)
    h.set(3)
    await h.flush()
    expect(h.requests()).toEqual([{ limitGiB: 3, generation: 1 }, { limitGiB: 3, generation: 1 }])
    // The backend restarts while a request is in flight: the new generation is sent the limit once that one settles.
    h.state({ status: 'restarting', generation: 1, retryInMs: 500 })
    h.state(ready(2))
    await h.answer(false)
    expect(h.requests().at(-1)).toEqual({ limitGiB: 3, generation: 2 })
    h.limit.dispose()
  })

  it('sends a value set while a request was in flight even when that request fails', async () => {
    const h = harness(0)
    h.state(ready(1))
    await h.answer()
    h.set(4)
    h.set(8)
    await h.answer(false)
    expect(h.requests()).toEqual([{ limitGiB: 0, generation: 1 }, { limitGiB: 4, generation: 1 }, { limitGiB: 8, generation: 1 }])
  })

  it('sends a value whose request failed again when the backend recovers from unresponsive', async () => {
    const h = harness(0)
    h.state(ready(1))
    await h.answer()
    h.set(4)
    h.state({ status: 'unresponsive', generation: 1, silentMs: 9000 })
    await h.answer(false)
    expect(h.requests()).toHaveLength(2)
    h.state(ready(1))
    expect(h.requests().at(-1)).toEqual({ limitGiB: 4, generation: 1 })
    await h.answer()
    h.state(ready(1))
    expect(h.requests()).toHaveLength(3)
  })

  it('sends nothing once disposed', async () => {
    const h = harness(0)
    h.limit.dispose()
    h.state(ready(1))
    h.set(4)
    await h.flush()
    expect(h.requests()).toEqual([])
  })

  it('is applied by main when the first settings read finishes, which fires no change of its own', () => {
    const source = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
    expect(source).toMatch(/loaded\.then\(\(\) => memoryLimit\.settingsChanged\(\)/)
    expect(source).toMatch(/settings\.onDidChange\([^]*?memoryLimit\.settingsChanged\(\)/)
  })
})
