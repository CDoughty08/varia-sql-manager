import { describe, expect, it, vi } from 'vitest'
import { connectionTargetOptions, type PersistedConnectionTarget } from '../src/shared/connection-targets'
import { ConnectionTargetService } from '../src/renderer/src/services/connection-targets'
import { bindConnectionPruning } from '../src/renderer/src/services/connection-pruning'
import { deferred, documentFixture } from './fixtures/documents'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const record = (value: number): PersistedConnectionTarget => ({ id: id(value), options: connectionTargetOptions({ server: 'sql', database: 'Sales', authentication: 'windows', trustServerCertificate: false }), details: { autoReconnect: 'inherit' }, inExplorer: false, resumeWanted: false })

describe('connection target collection', () => {
  it('waits for restored references, retaining detached query and custom-document targets before releasing main pins', async () => {
    const registry = new ConnectionTargetService(), { documents } = documentFixture(), ready = deferred<void>()
    registry.restore({ version: 1, targets: [record(1), record(2), record(3)] })
    const api = { pruneConnectionTargets: vi.fn(async (ids: readonly string[]) => ({ ok: true as const, value: { pruned: ids.length } })) }
    const binding = bindConnectionPruning({ registry, documents, api, ready: ready.promise })
    try {
      expect(registry.getSnapshot()).toHaveLength(3)
      const query = documents.create('offline.sql', 'SELECT 1', 'Sales')
      documents.update(query.id, { targetId: id(1), attachWanted: false })
      documents.registerProvider({ kind: 'activityMonitor', inSaveAll: false, save: async () => true, canClose: () => undefined, revision: () => 0, focus() {}, closed() {}, follows: () => false })
      const custom = documents.openCustom('activityMonitor', 'Activity Monitor', undefined, 'master')
      documents.update(custom.id, { targetId: id(2), attachWanted: false })
      ready.resolve()
      await Promise.resolve()
      expect(registry.getSnapshot().map(target => target.id)).toEqual([id(1), id(2)])
      expect(api.pruneConnectionTargets).toHaveBeenCalledExactlyOnceWith([id(3)])
      documents.update(query.id, { targetId: undefined })
      expect(registry.getSnapshot().map(target => target.id)).toEqual([id(2)])
      expect(api.pruneConnectionTargets).toHaveBeenLastCalledWith([id(1)])
    } finally { binding.dispose(); documents.dispose(); registry.dispose() }
  })

  it('keeps collection paused while close is taking a snapshot and stops observing on dispose', async () => {
    const registry = new ConnectionTargetService(), { documents } = documentFixture(), ready = deferred<void>(), blocked = deferred<void>()
    const api = { pruneConnectionTargets: vi.fn(async (ids: readonly string[]) => ({ ok: true as const, value: { pruned: ids.length } })) }
    const binding = bindConnectionPruning({ registry, documents, api, ready: ready.promise })
    try {
      const closing = documents.runTask(() => blocked.promise)
      registry.add(record(1))
      ready.resolve()
      await Promise.resolve()
      expect(api.pruneConnectionTargets).not.toHaveBeenCalled()
      blocked.resolve()
      await closing
      expect(api.pruneConnectionTargets).toHaveBeenCalledExactlyOnceWith([id(1)])
      binding.dispose()
      registry.add(record(2))
      expect(registry.get(id(2))).toBeDefined()
      expect(api.pruneConnectionTargets).toHaveBeenCalledTimes(1)
    } finally { binding.dispose(); documents.dispose(); registry.dispose() }
  })
})
