import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { backendConnectionBindingChangeSchema, connectionBindingsChangedSchema } from '../src/shared/connection-bindings'
import { actionExecuteResultSchema } from '../src/shared/actions/schema'
import { connectionTargetOptions } from '../src/shared/connection-targets'

const backendChange = () => ({ connectionId: randomUUID(), bindingRevision: 1, passwordChanged: true as const })
const rendererChange = () => ({
  targetId: randomUUID(), handle: { id: randomUUID(), generation: 3 }, revision: 1,
  options: connectionTargetOptions({ server: 'server', database: 'Sales', authentication: 'sql', username: 'reader', trustServerCertificate: false }),
  authentication: { principal: { provider: 'sqlServer' as const, authentication: 'sql' as const, id: 'sid:01020304' }, credential: null }
})

describe('authoritative connection binding contracts', () => {
  it('bounds backend action receipts and requires exact revisions, deltas, unique handles and completion status', () => {
    const base = { steps: [], messages: [], elapsedMs: 1 }, change = backendChange()
    expect(actionExecuteResultSchema.safeParse({ ...base, bindingChanges: [], bindingChangesComplete: true }).success).toBe(true)
    expect(actionExecuteResultSchema.safeParse({ ...base, bindingChanges: Array.from({ length: 256 }, backendChange), bindingChangesComplete: false }).success).toBe(true)
    for (const value of [
      { ...base, bindingChanges: [change] }, { ...base, bindingChangesComplete: true },
      { ...base, bindingChanges: [change, change], bindingChangesComplete: true },
      { ...base, bindingChanges: Array.from({ length: 257 }, backendChange), bindingChangesComplete: true }
    ]) expect(actionExecuteResultSchema.safeParse(value).success).toBe(false)
    for (const value of [{ ...change, bindingRevision: 0 }, { ...change, bindingRevision: Number.MAX_SAFE_INTEGER + 1 },
      { connectionId: change.connectionId, bindingRevision: 1 }, { ...change, password: 'never a receipt field' }, { ...change, newDatabase: 'a'.repeat(129) }])
      expect(backendConnectionBindingChangeSchema.safeParse(value).success).toBe(false)
  })

  it('limits renderer updates to nonsecret exact-generation target snapshots and a bounded warning', () => {
    const change = rendererChange(), event = { generation: 3, changes: [change] }
    expect(connectionBindingsChangedSchema.safeParse(event).success).toBe(true)
    expect(connectionBindingsChangedSchema.safeParse({ ...event, changes: Array.from({ length: 200 }, rendererChange) }).success).toBe(true)
    for (const value of [{ ...event, changes: [] }, { ...event, changes: Array.from({ length: 201 }, rendererChange) },
      { ...event, generation: 4 }, { ...event, warning: 'a'.repeat(513) },
      { ...event, changes: [{ ...change, options: { ...change.options, password: 'never forwarded' } }] },
      { ...event, changes: [{ ...change, revision: 0 }] }]) expect(connectionBindingsChangedSchema.safeParse(value).success).toBe(false)
  })
})
