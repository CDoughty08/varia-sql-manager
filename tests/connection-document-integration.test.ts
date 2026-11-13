import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionAuthentication } from '../src/shared/connection-targets'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { ConnectionTargetService } from '../src/renderer/src/services/connection-targets'
import { CustomDocumentTargets } from '../src/renderer/src/services/custom-document-targets'
import { TargetService } from '../src/renderer/src/services/targets'
import { ObjectSearchService } from '../src/renderer/src/search/ObjectSearchService'
import { defaultSettings } from '../src/shared/settings/catalog'
import type { CustomDocumentProvider } from '../src/renderer/src/services/documents'
import { documentFixture } from './fixtures/documents'
import { connectionInfo, connectionOptions } from './fixtures/workbench'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const cleanups: (() => void)[] = []
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose() })

function fixture() {
  const registry = new ConnectionTargetService(), connections = new ConnectionService(registry)
  let targets!: TargetService
  const docs = documentFixture({ target: connectionId => targets.targetForConnection(connectionId) })
  const queries = { isRunning: () => false, mayHaveTransaction: async () => false, confirmSessions: vi.fn(async () => new Map()), sessionEnded: vi.fn() }
  targets = new TargetService(docs.documents, queries, connections, { clearError: vi.fn(), reportError: vi.fn() }, registry)
  const bindings = new CustomDocumentTargets({ targetIdOf: connectionId => targets.targetForConnection(connectionId) })
  const provider: CustomDocumentProvider = {
    kind: 'tableDesigner', inSaveAll: true, save: async () => true, canClose: () => undefined, revision: () => 1,
    focus: () => {}, closed: id => bindings.forget(id), follows: () => false,
    canFollowTarget: (id, targetId) => bindings.canFollowTarget(id, targetId),
    coalesceTarget: (id, from, to) => bindings.coalesceTarget(id, from, to)
  }
  docs.documents.registerProvider(provider)
  const accept = (targetId: string, handleId: string, generation = 1) => {
    const attempt = connections.beginConnect(connectionOptions, generation, targetId)!
    const authentication: ConnectionAuthentication = { principal: { provider: 'sqlServer', authentication: 'sql', id: 'reader' } }
    expect(connections.accept(connectionInfo(handleId, generation), connectionOptions, targetId, authentication, attempt).status).toBe('accepted')
  }
  const custom = (handleId: string) => {
    const document = docs.documents.openCustom('tableDesigner', 'Draft table', handleId, 'Sales')
    bindings.bind(document.id, handleId)
    docs.documents.setDirty(document.id, true)
    return document
  }
  cleanups.push(() => { docs.documents.dispose(); connections.dispose(); registry.dispose() })
  return { ...docs, registry, connections, targets, queries, accept, custom, bindings }
}

describe('integrated document connection associations', () => {
  it('detaches exact queries and custom drafts only after the matching transport disconnects', () => {
    const f = fixture(), targetId = uuid(1), handleId = uuid(50)
    f.accept(targetId, handleId)
    const query = f.documents.create('Query.sql', 'SELECT 1', 'Sales', handleId, true)
    const draft = f.custom(handleId)
    const offline = f.documents.create('Offline.sql', 'SELECT 2', 'Accounts')
    f.documents.update(offline.id, { targetId, attachWanted: false })
    const other = f.documents.create('Other account.sql', '', 'Audit', handleId)
    f.documents.update(other.id, { targetId: uuid(2) })
    const operation = f.registry.beginDisconnect(targetId, uuid(10))!
    expect(f.registry.completeDisconnect(operation)).toBe(true)
    f.targets.detached(targetId, { id: handleId, generation: 2 })
    expect(f.documents.get(query.id)?.connectionId).toBe(handleId)
    f.targets.detached(targetId, { id: handleId, generation: 1 })
    expect(f.documents.get(query.id)).toMatchObject({ targetId, connectionId: undefined, database: 'Sales', attachWanted: true, dirty: true })
    expect(f.documents.get(draft.id)).toMatchObject({ targetId, connectionId: undefined, database: 'Sales', dirty: true })
    expect(f.documents.get(offline.id)).toMatchObject({ targetId, connectionId: undefined, database: 'Accounts', attachWanted: false })
    expect(f.documents.get(other.id)?.connectionId).toBe(handleId)
    expect(f.queries.sessionEnded).toHaveBeenCalledExactlyOnceWith(query.id)
    expect(f.model(query.id).getValue()).toBe('SELECT 1')
  })

  it('keeps custom subscriptions detached on background reconnect and reattaches only by explicit exact target', () => {
    const f = fixture(), targetId = uuid(1), oldId = uuid(50), nextId = uuid(51)
    f.accept(targetId, oldId)
    const query = f.documents.create('Query.sql', '', 'Sales', oldId), draft = f.custom(oldId)
    const operation = f.registry.beginDisconnect(targetId, uuid(10))!
    f.registry.completeDisconnect(operation)
    f.targets.detached(targetId, { id: oldId, generation: 1 })
    f.accept(targetId, nextId)
    f.targets.attachTarget(targetId, nextId)
    expect(f.documents.get(query.id)).toMatchObject({ connectionId: nextId, database: 'Sales', sessionNotice: 'restarted' })
    expect(f.documents.get(draft.id)?.connectionId).toBeUndefined()
    f.targets.attachTarget(targetId, nextId, true)
    expect(f.documents.get(draft.id)?.connectionId).toBe(nextId)
    f.targets.detached(targetId, { id: oldId, generation: 1 })
    expect(f.documents.get(draft.id)?.connectionId).toBe(nextId)
  })

  it('canonicalizes only a main-proven offline target while preserving databases, query intent and custom bindings', () => {
    const f = fixture(), from = uuid(1), to = uuid(2), oldId = uuid(50), nextId = uuid(51)
    f.accept(from, oldId)
    const query = f.documents.create('Wanted.sql', 'SELECT 1', 'Sales', oldId), draft = f.custom(oldId)
    const offline = f.documents.create('Detached.sql', 'SELECT 2', 'Accounts')
    f.documents.update(offline.id, { targetId: from, attachWanted: false })
    f.connections.markLostBefore(2)
    f.accept(to, nextId, 2)
    f.targets.coalesceTarget(from, to, nextId)
    expect(f.documents.get(query.id)).toMatchObject({ targetId: to, connectionId: nextId, database: 'Sales', attachWanted: true })
    expect(f.documents.get(offline.id)).toMatchObject({ targetId: to, connectionId: undefined, database: 'Accounts', attachWanted: false })
    expect(f.documents.get(draft.id)).toMatchObject({ targetId: to, connectionId: undefined, database: 'Sales', dirty: true })
    expect(f.bindings.canFollowTarget(draft.id, from)).toBe(false)
    expect(f.bindings.canFollowTarget(draft.id, to)).toBe(true)
    f.targets.attachTarget(to, nextId, true)
    expect(f.documents.get(draft.id)?.connectionId).toBe(nextId)
    expect(f.model(query.id).getValue()).toBe('SELECT 1')
    expect(f.model(offline.id).getValue()).toBe('SELECT 2')
  })

  it('does not migrate sessions of a live source or move a custom document without provider consent', () => {
    const f = fixture(), from = uuid(1), to = uuid(2), oldId = uuid(50), nextId = uuid(51)
    f.accept(from, oldId)
    const query = f.documents.create('Live.sql', '', 'Sales', oldId)
    f.accept(to, nextId)
    f.targets.coalesceTarget(from, to, nextId, true)
    expect(f.documents.get(query.id)).toMatchObject({ targetId: from, connectionId: oldId })
    const draft = f.custom(oldId)
    f.documents.update(draft.id, { targetId: to, connectionId: undefined })
    f.targets.attachTarget(to, nextId, true)
    expect(f.documents.get(draft.id)?.connectionId).toBeUndefined()
  })

  it('closes the fully approved query set locally, without session RPC, and refuses stale or custom entries atomically', async () => {
    const f = fixture(), targetId = uuid(1), handleId = uuid(50)
    f.accept(targetId, handleId)
    const first = f.documents.create('First.sql', 'SELECT 1', 'Sales', handleId)
    const second = f.documents.create('Second.sql', 'SELECT 2', 'Sales', handleId), draft = f.custom(handleId)
    const approved = [first, second].map(document => ({ id: document.id, revision: f.documents.revision(document.id) }))
    const closed: string[] = []
    f.events.subscribe(event => { if (event.type === 'documents.closed') closed.push(event.tabId) })
    f.model(second.id).edit('SELECT 3')
    await f.documents.runTask(async () => {
      expect(() => f.documents.closeDisconnectedQueries(approved)).toThrow(/All tabs stayed open/)
      expect(f.documents.get(first.id)).toBeDefined()
      expect(f.documents.get(second.id)).toBeDefined()
      expect(() => f.documents.closeDisconnectedQueries([{ id: draft.id, revision: 1 }])).toThrow()
      f.documents.closeDisconnectedQueries([first, second].map(document => ({ id: document.id, revision: f.documents.revision(document.id) })))
    })
    expect(closed).toEqual([first.id, second.id])
    expect(f.api.closeQuerySession).not.toHaveBeenCalled()
    expect(f.documents.getSnapshot().documents.map(document => document.id)).toEqual([draft.id])
  })

  it('keeps Search Objects scope associations exact and preserves filter drafts on explicit target reconnect', () => {
    const f = fixture(), targetId = uuid(1), oldId = uuid(50), nextId = uuid(51), otherId = uuid(52), otherTarget = uuid(2)
    f.accept(targetId, oldId)
    const search = new ObjectSearchService({
      documents: f.documents, connections: f.connections, targetIdOf: connectionId => f.targets.targetForConnection(connectionId),
      settings: { get: key => defaultSettings[key] },
      api: {
        explorerIndex: vi.fn(async () => ({ ok: false as const, error: 'No fixture index.' })),
        explorerSearch: vi.fn(async () => ({ ok: false as const, error: 'No fixture search.' })),
        explorerCancel: vi.fn(async () => ({ ok: true as const, value: { cancelled: 0 } })),
        onExplorerIndexProgress: () => () => {}
      }
    })
    cleanups.unshift(() => search.dispose())
    const id = search.open(oldId, undefined, false, 'Sales')!
    search.setQuery(id, { caseSensitive: true, scope: 'definitions' })
    const disconnect = f.registry.beginDisconnect(targetId, uuid(10))!
    f.registry.completeDisconnect(disconnect)
    f.targets.detached(targetId, { id: oldId, generation: 1 })
    f.accept(targetId, nextId)
    f.targets.attachTarget(targetId, nextId)
    expect(f.documents.get(id)?.connectionId).toBeUndefined()
    f.targets.attachTarget(targetId, nextId, true)
    expect(search.getSnapshot().documents[id]).toMatchObject({ connectionId: nextId, database: 'Sales', caseSensitive: true, scope: 'definitions' })
    f.accept(otherTarget, otherId)
    search.setConnection(id, otherId)
    expect(f.documents.get(id)).toMatchObject({ connectionId: otherId, targetId: otherTarget })
    search.setAllServers(id)
    expect(f.documents.get(id)).toMatchObject({ connectionId: undefined, targetId: undefined })
    expect(search.canFollowTarget(id, otherTarget)).toBe(false)
  })
})
