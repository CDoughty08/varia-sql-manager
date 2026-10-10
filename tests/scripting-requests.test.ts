import { describe, expect, it } from 'vitest'
import { ScriptingRequests, scriptingRequestLimits } from '../src/main/backend/scripting-requests'
import { ExplorerRequests } from '../src/main/backend/explorer-requests'
import { cancelReasons, type CancelReason } from '../src/shared/ipc/wire/protocol'
import { scriptLimits } from '../src/shared/scripting/catalog'

function fixture() {
  const cancels: [number, number, CancelReason][] = []
  let now = 0
  const requests = new ScriptingRequests({ cancel: (generation, id, reason) => { cancels.push([generation, id, reason]) } }, () => now)
  return { requests, cancels, advance: (ms: number) => { now += ms } }
}

describe('scripting cancellation in main', () => {
  it('uses the scripting limits: 64 ids per cancel, 256 running, 256 tombstones for 60 s', () => {
    expect(scriptingRequestLimits).toEqual({ tombstones: scriptLimits.tombstones, tombstoneMs: scriptLimits.tombstoneMs, running: scriptLimits.registered, cancelBatch: scriptLimits.cancelIds })
    expect(scriptingRequestLimits).toEqual({ tombstones: 256, tombstoneMs: 60_000, running: 256, cancelBatch: 64 })
  })
  it('turns a cancel of a sent script into one user CANCEL frame, and names scripting in its errors', () => {
    const { requests, cancels } = fixture()
    const script = requests.begin('a')
    script.sent(4, 2)
    expect(() => requests.begin('a')).toThrow(expect.objectContaining({ code: 'DUPLICATE_REQUEST', message: 'This scripting request is already running.' }))
    expect(requests.cancel(['a'])).toBe(1)
    expect(cancels).toEqual([[2, 4, cancelReasons.user]])
    script.end()
    expect(requests.running).toBe(0)
  })
  it('cancels at most 64 ids per call and refuses a script whose cancel came first', () => {
    const { requests, cancels, advance } = fixture()
    const ids = Array.from({ length: 65 }, (_, index) => `id${index}`)
    const sent = ids.map((id, index) => { const script = requests.begin(id); script.sent(index + 1, 1); return script })
    expect(requests.cancel(ids)).toBe(64)
    expect(cancels.map(([, id]) => id)).toEqual(ids.slice(0, 64).map((_, index) => index + 1))
    sent.forEach(script => script.end())
    expect(requests.cancel(['early'])).toBe(0)
    expect(() => requests.begin('early')).toThrow(expect.objectContaining({ code: 'CANCELLED' }))
    requests.cancel(['late'])
    advance(scriptingRequestLimits.tombstoneMs + 1)
    expect(() => requests.begin('late').end()).not.toThrow()
  })
  it('keeps at most 256 tombstones, forgetting the oldest', () => {
    const { requests } = fixture()
    requests.cancel(Array.from({ length: 64 }, (_, index) => `t${index}`))
    for (let batch = 1; batch < 5; batch++) requests.cancel(Array.from({ length: 64 }, (_, index) => `t${batch * 64 + index}`))
    expect(() => requests.begin('t0').end()).not.toThrow()
    expect(() => requests.begin('t319')).toThrow(expect.objectContaining({ code: 'CANCELLED' }))
  })
  it('keeps Object Explorer\'s registry separate, with its own limits and wording', () => {
    const explorer = new ExplorerRequests({ cancel: () => {} })
    const scripting = new ScriptingRequests({ cancel: () => {} })
    explorer.begin('same')
    expect(() => scripting.begin('same').end()).not.toThrow()
    expect(() => explorer.begin('same')).toThrow('This Object Explorer request is already running.')
    expect(explorer.limits.cancelBatch).toBe(256)
  })
})
