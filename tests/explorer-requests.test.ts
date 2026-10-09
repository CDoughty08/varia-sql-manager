import { describe, expect, it } from 'vitest'
import { ExplorerRequests, explorerRequestLimits } from '../src/main/backend/explorer-requests'
import { cancelReasons, type CancelReason } from '../src/shared/ipc/wire/protocol'
import { explorerLimits } from '../src/shared/explorer/catalog'

function fixture(start = 0) {
  const cancels: [number, number, CancelReason][] = []
  let now = start
  const requests = new ExplorerRequests({ cancel: (generation, id, reason) => { cancels.push([generation, id, reason]) } }, () => now)
  return { requests, cancels, advance: (ms: number) => { now += ms } }
}

describe('Object Explorer cancellation in main', () => {
  it('turns a cancel of a sent load into one user CANCEL frame for its generation and id', () => {
    const { requests, cancels } = fixture()
    const load = requests.begin('a')
    load.sent(7, 3)
    expect(requests.cancel(['a', 'a'])).toBe(1)
    expect(cancels).toEqual([[3, 7, cancelReasons.user]])
    expect(requests.cancel(['a'])).toBe(0)
    load.end()
    expect(requests.running).toBe(0)
  })
  it('sends the CANCEL as soon as a load cancelled before it was written goes out', () => {
    const { requests, cancels } = fixture()
    const load = requests.begin('a')
    expect(requests.cancel(['a'])).toBe(1)
    expect(cancels).toEqual([])
    load.sent(12, 2)
    expect(cancels).toEqual([[2, 12, cancelReasons.user]])
  })
  it('refuses a load whose cancel arrived first, for 60 seconds', () => {
    const { requests, advance } = fixture()
    expect(requests.cancel(['early'])).toBe(0)
    expect(() => requests.begin('early')).toThrow(expect.objectContaining({ code: 'CANCELLED' }))
    // A tombstone is used once.
    expect(() => requests.begin('early').end()).not.toThrow()
    requests.cancel(['late'])
    advance(explorerRequestLimits.tombstoneMs + 1)
    expect(() => requests.begin('late').end()).not.toThrow()
  })
  it('bounds tombstones, oldest first', () => {
    const { requests } = fixture()
    for (let i = 0; i <= explorerRequestLimits.tombstones; i++) requests.cancel(['t' + i])
    expect(() => requests.begin('t0').end()).not.toThrow()
    expect(() => requests.begin('t1')).toThrow(expect.objectContaining({ code: 'CANCELLED' }))
  })
  it('refuses a requestId that is already running, and accepts it again once it ends', () => {
    const { requests } = fixture()
    const load = requests.begin('a')
    expect(() => requests.begin('a')).toThrow(expect.objectContaining({ code: 'DUPLICATE_REQUEST' }))
    load.end()
    expect(() => requests.begin('a').end()).not.toThrow()
  })
  it('cancels at most one batch of ids per call', () => {
    const { requests, cancels } = fixture()
    const ids = Array.from({ length: explorerLimits.cancelBatch + 10 }, (_, index) => 'id' + index)
    ids.forEach((id, index) => requests.begin(id).sent(index + 1, 1))
    expect(requests.cancel(ids)).toBe(explorerLimits.cancelBatch)
    expect(cancels).toHaveLength(explorerLimits.cancelBatch)
  })
  it('a stale end never removes a newer load with the same id', () => {
    const { requests, cancels } = fixture()
    const first = requests.begin('a')
    first.end()
    const second = requests.begin('a')
    first.end()
    second.sent(5, 1)
    expect(requests.cancel(['a'])).toBe(1)
    expect(cancels).toEqual([[1, 5, cancelReasons.user]])
  })
})
