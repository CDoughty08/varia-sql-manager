import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionTargetOptions, type ConnectionAuthentication } from '../src/shared/connection-targets'
import { ConnectionTargetService } from '../src/renderer/src/services/connection-targets'
import { TargetService } from '../src/renderer/src/services/targets'
import { queryConnectionPresentation } from '../src/renderer/src/query-connection'
import { queryContextModel } from '../src/renderer/src/query-context'
import { queryStatusModel } from '../src/renderer/src/results/query-status'
import { defaultSettings } from '../src/shared/settings/catalog'
import { connectionInfo, connectionOptions, workbenchFixture } from './fixtures/workbench'
import { deferred } from './fixtures/documents'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const proof: ConnectionAuthentication = { principal: { provider: 'sqlServer', authentication: 'sql', id: 'reader' } }
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
function fixture() {
  const workbench = workbenchFixture(), registry = new ConnectionTargetService()
  cleanups.push(workbench.dispose)
  registry.markLostBefore(1)
  for (const value of [1, 2]) registry.add({ id: id(value), options: connectionTargetOptions(connectionOptions), details: { displayName: 'Reporting', environment: 'Production', color: '#123456', autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true })
  const handle = id(10), operation = registry.beginConnect(id(1), 1, id(20))!
  registry.completeConnect(operation, { id: handle, generation: 1 }, proof)
  workbench.connections.add({ ...connectionInfo(handle), generation: 1 }, connectionOptions)
  const targets = new TargetService(workbench.documents, workbench.queries, workbench.connections, workbench.files, registry)
  return { ...workbench, registry, targets, handle }
}

describe('exact query target associations', () => {
  it('attaches only queries wanting the authenticated target, preserving each database and restarted notice', () => {
    const { documents, targets, handle } = fixture()
    const queries = ['Orders', 'Audit', 'Missing'].map(database => documents.create(`${database}.sql`, '', database))
    queries.forEach((query, index) => documents.update(query.id, { targetId: id(index === 2 ? 2 : 1), attachWanted: true }))
    const detached = documents.create('detached.sql', '', 'Personal')
    documents.update(detached.id, { targetId: id(1), attachWanted: false })
    targets.attachTarget(id(1), handle)
    expect(queries.map(query => documents.get(query.id)?.connectionId)).toEqual([handle, handle, undefined])
    expect(queries.map(query => documents.get(query.id)?.database)).toEqual(['Orders', 'Audit', 'Missing'])
    expect(documents.get(queries[0].id)?.sessionNotice).toBe('restarted')
    expect(documents.get(detached.id)?.connectionId).toBeUndefined()
    targets.attachTarget(id(2), handle)
    expect(documents.get(queries[2].id)?.connectionId).toBeUndefined()
  })
  it('keeps the target and database through server disconnect, and query-only disconnect prevents attachment', async () => {
    const { documents, targets, handle } = fixture()
    const query = documents.create('query.sql', '', 'Orders', handle)
    targets.rememberConnection(handle, id(1))
    targets.disconnectTarget(id(1), handle)
    expect(documents.get(query.id)).toMatchObject({ targetId: id(1), attachWanted: true, database: 'Orders', connectionId: undefined })
    await targets.changeConnection(query.id, undefined)
    targets.attachTarget(id(1), handle)
    expect(documents.get(query.id)).toMatchObject({ targetId: id(1), attachWanted: false, database: 'Orders', connectionId: undefined })
    await targets.changeConnection(query.id, handle)
    expect(documents.get(query.id)).toMatchObject({ targetId: id(1), attachWanted: true, database: 'Orders', connectionId: handle })
  })
  it('never infers an association or remembered database from a matching legacy server name', async () => {
    const { documents, targets, connections, handle } = fixture()
    const query = documents.create('legacy.sql', '', 'OldDatabase')
    documents.update(query.id, { lastServer: connections.get(handle)!.server })
    targets.attachTarget(id(1), handle)
    expect(documents.get(query.id)?.connectionId).toBeUndefined()
    await targets.changeConnection(query.id, handle)
    expect(documents.get(query.id)?.database).toBe(connections.get(handle)!.database)
  })
  it('shows remembered target details offline in the query picker and status without a live login or session', () => {
    const { registry } = fixture(), target = registry.get(id(2))!
    const document = { targetId: id(2), lastServer: 'obsolete' }
    expect(queryConnectionPresentation(document, undefined, target)).toMatchObject({ label: 'Reporting (server.example) Disconnected', environment: 'Production', color: '#123456', disconnected: true })
    const model = queryContextModel({ ...document, target, connectionId: undefined, database: 'Unavailable', connections: [], databases: [], query: true, running: false, busy: false })
    expect(model.servers.at(-1)).toMatchObject({ label: 'Reporting (server.example) Disconnected', disabled: true })
    expect(model).toMatchObject({ database: 'Unavailable', databaseDisabled: true, environment: 'Production' })
    const status = queryStatusModel({ connection: { server: 'localhost', disconnected: true }, database: 'Unavailable', session: { login: 'old', spid: 99 }, running: false, now: 0, settings: defaultSettings })
    expect(status.place).toBe('localhost Disconnected | Unavailable')
    expect(status.segments.some(segment => segment.key === 'login')).toBe(false)
  })
  it('honors cleared target details instead of falling back to old live or profile details', () => {
    const { registry, connections, handle } = fixture()
    registry.setDetails(id(1), { autoReconnect: 'inherit' })
    const target = registry.get(id(1))!, connection = {
      ...connections.get(handle)!, displayName: 'Old profile name', color: '#ff0000',
      options: { ...connectionOptions, environment: 'Production' }
    }
    const presentation = queryConnectionPresentation({ targetId: id(1) }, connection, target)
    expect(presentation).toMatchObject({ label: 'server.example', disconnected: false })
    expect(presentation.displayName).toBeUndefined()
    expect(presentation.environment).toBeUndefined()
    expect(presentation.color).toBeUndefined()
    const context = queryContextModel({ connectionId: handle, targetId: id(1), target, database: 'Orders', connections: [connection], databases: [], query: true, running: false, busy: false })
    expect(context.serverName).toBe('server.example')
    expect(context.environment).toBeUndefined()
    expect(context.color).toBeUndefined()
  })
  it.each([
    { id: id(10), generation: 0 },
    { id: id(10), generation: 2 },
    { id: id(11), generation: 1 }
  ])('does not present an adapter handle $id in generation $generation as the remembered target', handle => {
    const { registry, connections } = fixture(), target = registry.get(id(1))!
    const connection = { ...connections.get(id(10))!, ...handle }
    const presentation = queryConnectionPresentation({ targetId: id(1) }, connection, target)
    expect(presentation).toMatchObject({ disconnected: true, label: 'Reporting (server.example) Disconnected' })
    const context = queryContextModel({ connectionId: connection.id, targetId: id(1), target, database: 'Orders', connections: [connection], databases: [{ name: 'master', isSystem: true, isSnapshot: false }], query: true, running: false, busy: false })
    expect(context).toMatchObject({ live: false, databaseDisabled: true, databases: ['Orders'], database: 'Orders' })
  })
  it('does not attach remembered queries through a handle from a different backend generation', () => {
    const { documents, targets, connections, handle } = fixture()
    const query = documents.create('query.sql', '', 'Orders')
    documents.update(query.id, { targetId: id(1), attachWanted: true })
    connections.replace(handle, { ...connectionInfo(handle), generation: 2 }, connectionOptions)
    expect(targets.targetForConnection(handle)).toBeUndefined()
    targets.attachTarget(id(1), handle)
    expect(documents.get(query.id)).toMatchObject({ database: 'Orders', targetId: id(1), attachWanted: true })
    expect(documents.get(query.id)?.connectionId).toBeUndefined()
  })
  it('does not claim an adapter handle is live after its authoritative target disconnects', () => {
    const { registry, connections, handle } = fixture()
    const operation = registry.beginDisconnect(id(1), id(21))!
    registry.completeDisconnect(operation)
    const connection = connections.get(handle)!, target = registry.get(id(1))!
    expect(connection.lost).toBeUndefined()
    expect(queryConnectionPresentation({ targetId: id(1) }, connection, target).disconnected).toBe(true)
    const context = queryContextModel({ connectionId: handle, targetId: id(1), target, database: 'Orders', connections: [connection], databases: [], query: true, running: false, busy: false })
    expect(context).toMatchObject({ live: false, databaseDisabled: true })
  })
  it('clears the old exact association when an App-style update chooses an unbound connection', () => {
    const { documents, targets, connections, handle } = fixture()
    const query = documents.create('query.sql', '', 'Orders', handle)
    targets.rememberConnection(handle, id(1))
    const unbound = id(30)
    connections.add(connectionInfo(unbound), connectionOptions)
    targets.update(query.id, { connectionId: unbound, database: 'master' })
    expect(documents.get(query.id)).toMatchObject({ connectionId: unbound, database: 'master' })
    expect(documents.get(query.id)?.targetId).toBeUndefined()
    expect(documents.get(query.id)?.attachWanted).toBeUndefined()
    targets.attachTarget(id(1), handle)
    expect(documents.get(query.id)?.connectionId).toBe(unbound)
  })
  it('preserves each restored query database when App-style connect completion supplies the target home database', () => {
    const { documents, targets, handle } = fixture()
    const queries = ['Orders', 'Audit', 'Unavailable'].map(database => documents.create(`${database}.sql`, '', database))
    for (const query of queries) {
      documents.update(query.id, { targetId: id(1), attachWanted: true, sessionNotice: 'restarted' })
      targets.update(query.id, { connectionId: handle, database: 'master' })
    }
    expect(queries.map(query => documents.get(query.id)?.database)).toEqual(['Orders', 'Audit', 'Unavailable'])
    expect(queries.every(query => documents.get(query.id)?.connectionId === handle)).toBe(true)
    expect(queries.every(query => documents.get(query.id)?.sessionNotice === 'restarted')).toBe(true)
  })
  it('leaves the prior query target intact if the backend is lost while Change Connection asks about sessions', async () => {
    const { documents, targets, registry, connections, queries, files, api, handle } = fixture()
    const query = documents.create('query.sql', '', 'Orders', handle)
    targets.rememberConnection(handle, id(1))
    const nextHandle = id(30), operation = registry.beginConnect(id(2), 1, id(31))!
    registry.completeConnect(operation, { id: nextHandle, generation: 1 }, proof)
    connections.add(connectionInfo(nextHandle), connectionOptions)
    const entered = deferred<void>(), plan = deferred<Awaited<ReturnType<typeof queries.confirmSessions>>>()
    vi.spyOn(queries, 'confirmSessions').mockImplementationOnce(() => { entered.resolve(); return plan.promise })
    const changing = targets.changeConnection(query.id, nextHandle)
    await entered.promise
    registry.markLostBefore(2)
    connections.markLostBefore(2)
    plan.resolve(new Map())
    await changing
    expect(api.closeQuerySession).toHaveBeenCalledWith(query.id)
    expect(documents.get(query.id)).toMatchObject({ connectionId: handle, targetId: id(1), attachWanted: true, database: 'Orders' })
    expect(files.getSnapshot().error).toBe('The selected connection changed while ending the query session. Choose its connection again.')
    expect(documents.getSnapshot().busy).toBe(false)
  })
})
