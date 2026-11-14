import { describe, expect, it, vi } from 'vitest'
import type { ApiResult } from '../src/shared/contracts'
import type { ActionDescribeResult } from '../src/shared/actions/schema'
import { CustomDocumentTargets } from '../src/renderer/src/services/custom-document-targets'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { TableDesignerService } from '../src/renderer/src/designer/TableDesignerService'
import { SsisPropertiesService } from '../src/renderer/src/ssis/SsisPropertiesService'
import { documentFixture, deferred } from './fixtures/documents'
import type { SsisDescribeResult } from '../src/shared/ssis/schema'
import { connectionInfo, connectionOptions } from './fixtures/workbench'

describe('custom document exact target binding', () => {
  it('accepts replacement handles of the original target and rejects other accounts or settings', () => {
    const targetIds: Record<string, string> = { old: 'target-one', next: 'target-one', other: 'target-two' }
    const bindings = new CustomDocumentTargets({ targetIdOf: id => targetIds[id] })
    bindings.bind('document', 'old')
    delete targetIds.old
    expect(bindings.canFollowTarget('document', 'target-one')).toBe(true)
    expect(bindings.canFollowTarget('document', 'target-two')).toBe(false)
    expect(bindings.matchesConnection('document', 'next')).toBe(true)
    expect(bindings.matchesConnection('document', 'other')).toBe(false)
    expect(bindings.matchesConnection('document', undefined)).toBe(false)
    bindings.forget('document')
    expect(bindings.canFollowTarget('document', 'target-one')).toBe(false)
  })

  it('keeps legacy documents on the original live handle without inferring a durable target', () => {
    const bindings = new CustomDocumentTargets({})
    bindings.bind('document', 'old')
    expect(bindings.matchesConnection('document', 'old')).toBe(true)
    expect(bindings.matchesConnection('document', 'next')).toBe(false)
    expect(bindings.canFollowTarget('document', 'old')).toBe(false)
    bindings.clear()
    expect(bindings.matchesConnection('document', 'old')).toBe(false)
  })

  it('migrates only the existing exact binding after main proves canonical target equivalence', () => {
    const targetIds: Record<string, string> = { old: 'provisional', current: 'canonical' }
    const bindings = new CustomDocumentTargets({ targetIdOf: id => targetIds[id] })
    bindings.bind('document', 'old')
    expect(bindings.coalesceTarget('document', 'unrelated', 'canonical')).toBe(false)
    expect(bindings.canFollowTarget('document', 'provisional')).toBe(true)
    expect(bindings.coalesceTarget('document', 'provisional', 'canonical')).toBe(true)
    expect(bindings.canFollowTarget('document', 'provisional')).toBe(false)
    expect(bindings.matchesConnection('document', 'current')).toBe(true)
    bindings.bind('legacy', 'unknown')
    expect(bindings.coalesceTarget('legacy', 'provisional', 'canonical')).toBe(false)
  })

  it('preserves a designer draft, enables only its exact reconnected target, and refuses name-only reassociation', async () => {
    const { documents } = documentFixture()
    const connections = new ConnectionService()
    const targetIds: Record<string, string> = { old: 'target-one', next: 'target-one', other: 'target-two' }
    connections.add(connectionInfo('old'), connectionOptions)
    const api = {
      describeObject: vi.fn(async (): Promise<ApiResult<ActionDescribeResult>> => ({ ok: true, value: { elapsedMs: 1, tableDesigner: { database: 'AppData', band: 16, schemas: ['dbo'], schemasTruncated: false, defaultSchema: 'dbo', defaultFilegroup: 'PRIMARY', caseSensitiveNames: false, accentSensitiveNames: true, canCreate: true } } })),
      scriptObjectAction: vi.fn(), executeObjectAction: vi.fn(), cancelObjectActions: vi.fn(async () => ({ ok: true as const, value: { cancelled: 0 } }))
    }
    const designers = new TableDesignerService({ api, documents, connections, targetIdOf: id => targetIds[id], files: { saveCopy: async () => {} }, explorer: { reconcile: () => {} } })
    try {
      const id = designers.open({ id: 1, connectionId: 'old', kind: 'folder', folder: 'tables', label: 'Tables', lost: false, ref: { type: 'folder', owner: { kind: 'database', name: 'AppData' }, folder: 'tables' } })
      await vi.waitFor(() => expect(designers.get(id)?.phase).toBe('ready'))
      designers.setCell(id, 0, 'name', 'DraftId')
      const rows = designers.get(id)?.rows
      connections.markLostBefore(2)
      expect(designers.canSubmit(id)).toBe(false)
      connections.add({ ...connectionInfo('other', 2), server: 'old.example', login: 'other-account' }, connectionOptions)
      documents.update(id, { connectionId: 'other' })
      expect(designers.canSubmit(id)).toBe(false)
      expect(designers.follows(id, 'old.example')).toBe(false)
      expect(designers.canFollowTarget(id, 'target-two')).toBe(false)
      connections.add({ ...connectionInfo('next', 2), server: 'old.example' }, connectionOptions)
      documents.update(id, { connectionId: 'next' })
      expect(designers.canFollowTarget(id, 'target-one')).toBe(true)
      expect(designers.canSubmit(id)).toBe(true)
      expect(designers.get(id)?.rows).toEqual(rows)
      expect(documents.get(id)?.dirty).toBe(true)
    } finally { designers.dispose(); documents.dispose(); connections.dispose() }
  })

  it('cancels stale SSIS reads and enables refresh only after the original target reattaches', async () => {
    const { documents } = documentFixture(), connections = new ConnectionService()
    const targetIds: Record<string, string> = { old: 'target-one', next: 'target-one', other: 'target-two' }
    connections.add(connectionInfo('old'), connectionOptions)
    connections.add({ ...connectionInfo('other'), server: 'old.example' }, connectionOptions)
    const pending = deferred<ApiResult<SsisDescribeResult>>()
    const api = { describeSsis: vi.fn(async () => pending.promise), cancelSsis: vi.fn(async () => ({ ok: true as const, value: { cancelled: 0 } })) }
    const properties = new SsisPropertiesService({ documents, connections, api, targetIdOf: id => targetIds[id] })
    try {
      const id = properties.open({ id: 1, connectionId: 'old', kind: 'ssisFolder', label: 'Finance', lost: false, ref: { type: 'object', object: { kind: 'ssisFolder', name: 'Finance' } } })
      documents.update(id, { connectionId: 'other' })
      expect(api.cancelSsis).toHaveBeenCalled()
      pending.resolve({ ok: false, error: 'Stale response' })
      await vi.waitFor(() => expect(properties.get(id)?.loading).toBe(false))
      expect(properties.get(id)).toMatchObject({ connectionId: 'old', disconnected: true })
      expect(properties.get(id)?.error).toBeUndefined()
      expect(properties.canRefresh(id)).toBe(false)
      connections.add({ ...connectionInfo('next'), server: 'old.example' }, connectionOptions)
      api.describeSsis.mockResolvedValueOnce({ ok: false, error: 'Current response' })
      documents.update(id, { connectionId: 'next' })
      await vi.waitFor(() => expect(properties.get(id)?.error?.message).toBe('Current response'))
      expect(properties.get(id)).toMatchObject({ connectionId: 'next', disconnected: false })
      expect(properties.canRefresh(id)).toBe(true)
    } finally { properties.dispose(); documents.dispose(); connections.dispose() }
  })
})
