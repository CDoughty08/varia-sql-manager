import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionTargetOptions, type ConnectionAuthentication } from '../src/shared/connection-targets'
import type { FolderId } from '../src/shared/explorer/catalog'
import { operationsPresetSpecs } from '../src/shared/ssis/operations'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(dispose => dispose()))
const proof: ConnectionAuthentication = { principal: { provider: 'sqlServer', authentication: 'sql', id: 'reader' } }

function fixture() {
  const value = workbenchFixture({ settings: { 'objectExplorer.search.indexOnConnect': false } })
  cleanups.push(value.dispose)
  value.api.push(readyBackend())
  const targetId = crypto.randomUUID(), handle = crypto.randomUUID()
  value.connectionTargets.add({ id: targetId, options: connectionTargetOptions(connectionOptions), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true })
  const attempt = value.connections.beginConnect(connectionOptions, 1, targetId)!
  expect(value.connections.accept(connectionInfo(handle), connectionOptions, targetId, proof, attempt).status).toBe('accepted')
  return { ...value, targetId, handle }
}

describe('connection lifecycle consumers', () => {
  it('offers no empty Explorer recovery picker for a hidden offline target, but permits its own query to reconnect', async () => {
    const f = fixture()
    const query = f.documents.create('remembered.sql', '', 'master', f.handle)
    f.targets.rememberConnection(f.handle, f.targetId)
    const operation = f.connectionTargets.beginDisconnect(f.targetId, crypto.randomUUID())!
    f.connectionTargets.completeDisconnect(operation)
    f.targets.detached(f.targetId, { id: f.handle, generation: 1 })
    f.connections.remove(f.targetId)
    f.documents.create('other.sql', '', 'master')
    expect(f.connections.get(f.targetId)?.inExplorer).toBe(false)
    expect(f.commands.isEnabled('connection.reconnect')).toBe(false)
    expect(f.commands.isEnabled('connection.removeFromExplorer')).toBe(false)
    expect(await f.commands.execute('connection.reconnect', undefined, 'palette')).toBe(false)
    f.documents.activate(query.id)
    expect(f.commands.isEnabled('connection.reconnect')).toBe(true)
    expect(f.commands.isEnabled('connection.removeFromExplorer')).toBe(false)
    await f.commands.execute('connection.reconnect', undefined, 'palette')
    expect(f.host.reconnect).toHaveBeenCalledWith(f.connections.get(f.targetId)!.id)
  })

  it('blocks new query, search and server actions as soon as disconnect begins', async () => {
    const f = fixture(), query = f.documents.create('query.sql', '', 'master', f.handle)
    f.targets.rememberConnection(f.handle, f.targetId)
    const folder = (folder: FolderId): ExplorerMenuNode => ({ id: 100, connectionId: f.handle, kind: 'folder', label: folder, folder, lost: false, engine: 'box', ref: { type: 'folder', owner: { kind: 'server' }, folder } })
    const args = (name: FolderId) => ({ target: { kind: 'explorer' as const, node: folder(name) } })
    const commands = [['explorer.newLogin', 'logins'], ['explorer.newDatabase', 'databases'], ['explorer.createCatalog', 'integrationServicesCatalogs']] as const
    expect(f.queries.canExecute(query.id)).toBe(true)
    for (const [command, name] of commands) expect(f.commands.canRun(command, args(name)), command).toBe(true)
    expect(f.commands.canRun(operationsPresetSpecs.active.command)).toBe(true)
    f.connectionTargets.beginDisconnect(f.targetId, crypto.randomUUID())
    expect(f.connections.isLive(f.handle)).toBe(false)
    expect(f.queries.canExecute(query.id)).toBe(false)
    expect(f.targets.targetForConnection(f.handle)).toBeUndefined()
    expect(() => f.objectSearch.open(f.handle)).toThrow('Connect to a server')
    const builds = vi.mocked(f.api.explorerIndex).mock.calls.length
    f.objectSearch.build(f.handle)
    expect(f.api.explorerIndex).toHaveBeenCalledTimes(builds)
    for (const [command, name] of commands) expect(f.commands.canRun(command, args(name)), command).toBe(false)
    expect(f.commands.canRun(operationsPresetSpecs.active.command)).toBe(false)
    const databaseReads = vi.mocked(f.api.databases).mock.calls.length
    await f.databaseList.reload(f.handle)
    expect(f.api.databases).toHaveBeenCalledTimes(databaseReads)
  })

  it('does not turn an unavailable picker choice into a query disconnect or end its existing session', async () => {
    const f = fixture(), other = crypto.randomUUID()
    f.connect(connectionInfo(other))
    const query = f.documents.create('query.sql', '', 'Personal', other)
    f.connectionTargets.beginDisconnect(f.targetId, crypto.randomUUID())
    const close = vi.spyOn(f.documents, 'endSession')
    await f.targets.changeConnection(query.id, f.handle)
    expect(close).not.toHaveBeenCalled()
    expect(f.documents.get(query.id)).toMatchObject({ connectionId: other, database: 'Personal' })
    expect(f.files.getSnapshot().error).toContain('not connected')
  })
})
