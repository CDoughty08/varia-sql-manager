import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, DatabaseInfo, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { DatabaseListService } from '../src/renderer/src/services/database-list'
import { connectionInfo, connectionOptions } from './fixtures/workbench'

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const list = (...names: string[]): DatabaseInfo[] => names.map(name => ({ name, isSystem: name === 'master', isSnapshot: false }))

function fixture() {
  const answers: { connectionId: string; resolve: (result: ApiResult<DatabaseInfo[]>) => void }[] = []
  const api = { databases: vi.fn<VariaApi['databases']>(connectionId => new Promise(resolve => { answers.push({ connectionId, resolve }) })) }
  const connections = new ConnectionService(), events = new EventBus()
  const service = new DatabaseListService(api, connections, events)
  const answer = (index: number, result: ApiResult<DatabaseInfo[]>) => answers[index].resolve(result)
  return { api, connections, events, service, answers, answer }
}

describe('DatabaseListService', () => {
  it('loads a list for each connection as it is added', async () => {
    const f = fixture()
    f.connections.add(connectionInfo('server-a'), connectionOptions)
    f.connections.add(connectionInfo('server-b'), connectionOptions)
    expect(f.api.databases.mock.calls).toEqual([['server-a'], ['server-b']])
    f.answer(0, { ok: true, value: list('master', 'AppData') })
    await settle()
    expect(f.service.get('server-a').map(database => database.name)).toEqual(['master', 'AppData'])
    expect(f.service.get('server-b')).toEqual([])
    expect(f.service.get('unknown')).toEqual([])
  })
  it('runs one load at a time per connection, and loads once more for requests made meanwhile', async () => {
    const f = fixture()
    f.connections.add(connectionInfo('server-a'), connectionOptions)
    void f.service.reload('server-a')
    void f.service.reload('server-a')
    expect(f.api.databases).toHaveBeenCalledTimes(1)
    f.answer(0, { ok: true, value: list('old') })
    await settle()
    expect(f.api.databases).toHaveBeenCalledTimes(2)
    f.answer(1, { ok: true, value: list('new') })
    await settle()
    expect(f.service.get('server-a').map(database => database.name)).toEqual(['new'])
    expect(f.api.databases).toHaveBeenCalledTimes(2)
  })
  it('reloads when Object Explorer refreshes the server or a databases folder', async () => {
    const f = fixture()
    f.connections.add(connectionInfo('server-a'), connectionOptions)
    f.answer(0, { ok: true, value: list('master') })
    await settle()
    f.events.emit({ type: 'explorer.refreshed', connectionId: 'server-a', scope: 'other', nodeId: 1 })
    expect(f.api.databases).toHaveBeenCalledTimes(1)
    f.events.emit({ type: 'explorer.refreshed', connectionId: 'server-a', scope: 'databases', nodeId: 1 })
    f.answer(1, { ok: true, value: list('master', 'Added') })
    await settle()
    f.events.emit({ type: 'explorer.refreshed', connectionId: 'server-a', scope: 'server', nodeId: 1 })
    expect(f.api.databases).toHaveBeenCalledTimes(3)
    expect(f.service.get('server-a').map(database => database.name)).toEqual(['master', 'Added'])
    // Another connection's refresh, or one for a connection that is gone, loads nothing.
    f.events.emit({ type: 'explorer.refreshed', connectionId: 'gone', scope: 'server', nodeId: 1 })
    expect(f.api.databases).toHaveBeenCalledTimes(3)
  })
  it('keeps the previous list when a load fails', async () => {
    const f = fixture()
    f.connections.add(connectionInfo('server-a'), connectionOptions)
    f.answer(0, { ok: true, value: list('master') })
    await settle()
    const listener = vi.fn()
    f.service.subscribe(listener)
    void f.service.reload('server-a')
    f.answer(1, { ok: false, error: 'The connection broke.' })
    await settle()
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    void f.service.reload('server-a')
    f.answers[2].resolve(Promise.reject(new Error('IPC failed.')) as never)
    await settle()
    expect(report).toHaveBeenCalledTimes(1)
    report.mockRestore()
    expect(f.service.get('server-a').map(database => database.name)).toEqual(['master'])
    expect(listener).not.toHaveBeenCalled()
  })
  it('retains the exact handle cache through a failed disconnect and refresh without admitting work during teardown', async () => {
    const f = fixture(), targetId = '00000000-0000-4000-8000-000000000001', connectionId = '00000000-0000-4000-8000-000000000050'
    const attempt = f.connections.beginConnect(connectionOptions, 1, targetId)!
    f.connections.accept(connectionInfo(connectionId), connectionOptions, targetId, { principal: { provider: 'sqlserver', authentication: 'sql', id: 'reader' } }, attempt)
    f.answer(0, { ok: true, value: list('master', 'AppData') })
    await Promise.resolve()
    const cached = f.service.get(connectionId), refresh = f.service.reload(connectionId)
    expect(cached.map(database => database.name)).toEqual(['master', 'AppData'])
    const disconnect = f.connections.connectionTargets.beginDisconnect(targetId, crypto.randomUUID())!
    expect(f.service.get(connectionId)).toBe(cached)
    await f.service.reload(connectionId)
    expect(f.api.databases).toHaveBeenCalledTimes(2)
    f.connections.connectionTargets.failDisconnect(disconnect)
    f.answer(1, { ok: false, error: 'The refresh failed while disconnecting.' })
    await refresh
    expect(f.connections.isLive(connectionId)).toBe(true)
    expect(f.service.get(connectionId)).toBe(cached)
    expect(f.api.databases).toHaveBeenCalledTimes(2)
    const completed = f.connections.connectionTargets.beginDisconnect(targetId, crypto.randomUUID())!
    f.connections.connectionTargets.completeDisconnect(completed)
    expect(f.service.get(connectionId)).toEqual([])
    f.service.dispose()
    f.connections.dispose()
  })
  it('drops the lists of removed and lost connections, and ignores their late answers', async () => {
    const f = fixture()
    f.connections.add(connectionInfo('server-a', 1), connectionOptions)
    f.connections.add(connectionInfo('server-b', 2), connectionOptions)
    f.answer(0, { ok: true, value: list('a') })
    await settle()
    f.connections.remove('server-a')
    expect(f.service.get('server-a')).toEqual([])
    f.connections.markLostBefore(3)
    f.answer(1, { ok: true, value: list('b') })
    await settle()
    expect(f.service.getSnapshot().size).toBe(0)
    await f.service.reload('server-b')
    expect(f.api.databases).toHaveBeenCalledTimes(2)
    // A reconnect is a new connection with its own list.
    f.connections.replace('server-b', connectionInfo('server-c', 3), connectionOptions)
    expect(f.api.databases).toHaveBeenLastCalledWith('server-c')
  })
  it('stops loading and publishing when disposed', async () => {
    const f = fixture()
    f.connections.add(connectionInfo('server-a'), connectionOptions)
    const listener = vi.fn()
    f.service.subscribe(listener)
    f.service.dispose()
    f.answer(0, { ok: true, value: list('master') })
    f.connections.add(connectionInfo('server-b'), connectionOptions)
    f.events.emit({ type: 'explorer.refreshed', connectionId: 'server-a', scope: 'server', nodeId: 1 })
    await settle()
    expect(listener).not.toHaveBeenCalled()
    expect(f.api.databases).toHaveBeenCalledTimes(1)
  })
})
