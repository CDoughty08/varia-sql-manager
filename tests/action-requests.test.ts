import { describe, expect, it } from 'vitest'
import { ActionRequests, actionRequestLimits } from '../src/main/backend/action-requests'
import { cancellableRequests } from '../src/main/backend/renderer-requests'
import { ScriptingRequests } from '../src/main/backend/scripting-requests'
import { methodPolicies } from '../src/shared/ipc/methods'
import { actionLimits } from '../src/shared/actions/catalog'
import { cancelReasons, type CancelReason } from '../src/shared/ipc/wire/protocol'

function fixture() {
  const cancels: [number, number, CancelReason][] = []
  let now = 0
  const requests = new ActionRequests({ cancel: (generation, id, reason) => { cancels.push([generation, id, reason]) } }, () => now)
  return { requests, cancels, advance: (ms: number) => { now += ms } }
}

describe('object action cancellation in main', () => {
  it('routes every action method, and only the cancellable methods, to their cancel channel, so Stop reaches DDL', () => {
    const channels = { explorer: 'explorer', scripting: 'scripting', actions: 'actions', ssis: 'ssis', connections: 'connections' }
    const routed = Object.fromEntries(Object.keys(methodPolicies).flatMap(method => { const channel = cancellableRequests(method, channels); return channel ? [[method, channel]] : [] }))
    expect(routed).toEqual({ 'explorer.children': 'explorer', 'scripting.script': 'scripting', 'actions.describe': 'actions', 'actions.script': 'actions', 'actions.execute': 'actions', 'ssis.describe': 'ssis', 'ssis.execute': 'ssis', 'ssis.catalogSetup': 'ssis' })
  })
  it('routes a connect and Load databases to the Connect dialog Stop only when they carry a requestId', () => {
    const channels = { explorer: 'explorer', scripting: 'scripting', actions: 'actions', ssis: 'ssis', connections: 'connections' }
    const id = crypto.randomUUID()
    const routed = Object.fromEntries(Object.keys(methodPolicies).flatMap(method => { const channel = cancellableRequests(method, channels, id); return channel ? [[method, channel]] : [] }))
    expect(routed).toEqual({ 'connections.connect': 'connections', 'connections.databases': 'connections', 'explorer.children': 'explorer', 'scripting.script': 'scripting', 'actions.describe': 'actions', 'actions.script': 'actions', 'actions.execute': 'actions', 'ssis.describe': 'ssis', 'ssis.execute': 'ssis', 'ssis.catalogSetup': 'ssis' })
  })
  it('uses the action limits: 16 ids per cancel, 128 running, 64 tombstones for 60 s', () => {
    expect(actionRequestLimits).toEqual({ tombstones: actionLimits.tombstones, tombstoneMs: actionLimits.tombstoneMs, running: actionLimits.registered, cancelBatch: actionLimits.cancelIds })
    expect(actionRequestLimits).toEqual({ tombstones: 64, tombstoneMs: 60_000, running: 128, cancelBatch: 16 })
  })
  it('turns Stop on a sent action into one user CANCEL frame, and names object actions in its errors', () => {
    const { requests, cancels } = fixture()
    const action = requests.begin('a')
    action.sent(7, 3)
    expect(() => requests.begin('a')).toThrow(expect.objectContaining({ code: 'DUPLICATE_REQUEST', message: 'This object action request is already running.' }))
    expect(requests.cancel(['a'])).toBe(1)
    expect(requests.cancel(['a'])).toBe(0)
    expect(cancels).toEqual([[3, 7, cancelReasons.user]])
    action.end()
    expect(requests.running).toBe(0)
  })
  it('sends a Stop that came before the request was written as soon as it is', () => {
    const { requests, cancels } = fixture()
    const action = requests.begin('b')
    expect(requests.cancel(['b'])).toBe(1)
    expect(cancels).toEqual([])
    action.sent(2, 1)
    expect(cancels).toEqual([[1, 2, cancelReasons.user]])
  })
  it('cancels at most 16 ids per call, refuses an action whose Stop came first, and forgets that after 60 s', () => {
    const { requests, cancels, advance } = fixture()
    const ids = Array.from({ length: 17 }, (_, index) => `id${index}`)
    const sent = ids.map((id, index) => { const action = requests.begin(id); action.sent(index + 1, 1); return action })
    expect(requests.cancel(ids)).toBe(16)
    expect(cancels).toHaveLength(16)
    sent.forEach(action => action.end())
    requests.cancel(['early'])
    expect(() => requests.begin('early')).toThrow(expect.objectContaining({ code: 'CANCELLED' }))
    requests.cancel(['late'])
    advance(actionRequestLimits.tombstoneMs + 1)
    expect(() => requests.begin('late').end()).not.toThrow()
  })
  it('keeps at most 64 tombstones, forgetting the oldest', () => {
    const { requests } = fixture()
    for (let batch = 0; batch < 5; batch++) requests.cancel(Array.from({ length: 16 }, (_, index) => `t${batch * 16 + index}`))
    expect(() => requests.begin('t0').end()).not.toThrow()
    expect(() => requests.begin('t79')).toThrow(expect.objectContaining({ code: 'CANCELLED' }))
  })
  it('refuses more than 128 running actions, and keeps its registry apart from scripting\'s', () => {
    const { requests } = fixture()
    for (let index = 0; index < 128; index++) requests.begin(`r${index}`)
    expect(() => requests.begin('one more')).toThrow(expect.objectContaining({ code: 'TOO_MANY_REQUESTS' }))
    const scripting = new ScriptingRequests({ cancel: () => {} })
    expect(() => scripting.begin('r0').end()).not.toThrow()
  })
})
