import { describe, expect, it } from 'vitest'
import { validateRequest } from '../src/main/validation'
import { portRequestSchema, queryEventSchema } from '../src/shared/ipc/port-messages'
import { explorerCancelParamsSchema } from '../src/shared/explorer/schema'
import { methodPolicies } from '../src/shared/ipc/methods'
import { scriptCancelSchema } from '../src/shared/scripting/schema'
import { defaultScriptingOptions } from '../src/shared/scripting/options'

describe('IPC validation', () => {
  it('rejects arbitrary or inherited backend method names', () => {
    for (const method of ['shell.execute', 'toString', '__proto__']) expect(() => validateRequest(method, {})).toThrow('Unsupported backend method')
  })
  it('rejects extra connection string fields and invalid authentication', () => {
    const valid = { server: 'localhost', database: 'master', authentication: 'windows', trustServerCertificate: false }
    expect(validateRequest('connections.connect', valid)).toEqual(valid)
    expect(() => validateRequest('connections.connect', { ...valid, connectionString: 'unexpected' })).toThrow('Invalid request')
    expect(() => validateRequest('connections.connect', { ...valid, authentication: 'sql' })).toThrow('Invalid request')
  })
  it('enforces the query timeout, ID, and row limits', () => {
    const valid = { connectionId: crypto.randomUUID(), sessionId: crypto.randomUUID(), queryId: crypto.randomUUID(), database: 'master', sql: 'SELECT 1', maxRows: 1000, timeoutSeconds: 30 }
    expect(validateRequest('query.execute', valid)).toEqual(valid)
    expect(validateRequest('query.execute', { ...valid, timeoutSeconds: 0 })).toMatchObject({ timeoutSeconds: 0 })
    // maxRows 0 stores up to the memory budget only; maxResultSets keeps 1 to 1000 result sets.
    for (const patch of [{ maxRows: 0 }, { maxRows: 2 ** 31 - 1 }, { maxResultSets: 1 }, { maxResultSets: 1000 }]) expect(validateRequest('query.execute', { ...valid, ...patch })).toEqual({ ...valid, ...patch })
    for (const patch of [{ maxRows: -1 }, { maxRows: 2 ** 31 }, { maxRows: 1.5 }, { maxResultSets: 0 }, { maxResultSets: 1001 }, { timeoutSeconds: -1 }, { timeoutSeconds: 86401 }, { queryId: 'invalid' }, { sessionId: 'invalid' }, { startLine: 0 }, { sql: '' }]) expect(() => validateRequest('query.execute', { ...valid, ...patch })).toThrow('Invalid request')
  })
  it('passes identifiers verbatim and explains oversized scripts', () => {
    const connectionId = crypto.randomUUID()
    const table = { connectionId, database: ' padded ', schema: 'dbo', name: 'Orders' }
    expect(validateRequest('tables.columns', table)).toEqual(table)
    expect(() => validateRequest('tables.columns', { ...table, database: '   ' })).toThrow('Invalid request')
    // IPC can deliver a cloneable non-string whose property key coerces to a real method name.
    expect(() => validateRequest(['tables.columns'] as unknown as string, table)).toThrow('Unsupported backend method')
    const query = { connectionId, sessionId: crypto.randomUUID(), queryId: crypto.randomUUID(), database: 'master', sql: 'x'.repeat(1_000_001), maxRows: 1000, timeoutSeconds: 30 }
    expect(() => validateRequest('query.execute', query)).toThrow('too large to execute')
  })
  it('takes a table\'s columns by connection, database, schema, and name only', () => {
    const valid = { connectionId: crypto.randomUUID(), database: 'AppData', schema: 'dbo', name: "Order ]Lines'" }
    expect(validateRequest('tables.columns', valid)).toEqual(valid)
    for (const patch of [{ name: '' }, { name: ' ' }, { schema: 'x'.repeat(129) }, { database: '' }, { connectionId: 'server-a' }, { sql: 'SELECT 1' }]) {
      expect(() => validateRequest('tables.columns', { ...valid, ...patch }), JSON.stringify(patch)).toThrow('Invalid request')
    }
    expect(validateRequest('tables.columns', { ...valid, name: 'x'.repeat(128) })).toMatchObject({ name: 'x'.repeat(128) })
  })
  it('rejects the v1 catalog and table script methods that Object Explorer and Script As replaced', () => {
    const connectionId = crypto.randomUUID()
    expect(() => validateRequest('tables.list', { connectionId, database: 'master' })).toThrow('Unsupported backend method')
    expect(() => validateRequest('server.objects.list', { connectionId, kind: 'logins' })).toThrow('Unsupported backend method')
    expect(() => validateRequest('tables.script', { connectionId, database: 'master', schema: 'dbo', name: 'Orders' })).toThrow('Unsupported backend method')
    for (const method of ['tables.list', 'server.objects.list', 'tables.script']) expect(Object.hasOwn(methodPolicies, method), method).toBe(false)
  })
  it('takes Object Explorer loads only in their strict catalogue shape', () => {
    const connectionId = crypto.randomUUID(), requestId = crypto.randomUUID()
    const valid = { connectionId, requestId, node: { type: 'folder', owner: { kind: 'database', name: ' Sales ' }, folder: 'tables' }, pageSize: 2000, filter: { name: { op: 'contains', value: '50%_' } } }
    expect(validateRequest('explorer.children', valid)).toEqual(valid)
    for (const patch of [
      { node: { type: 'folder', owner: { kind: 'server' }, folder: 'tables' } }, { node: { type: 'object', object: { kind: 'table', database: 'x', name: 'y' } } },
      { requestId: 'r1' }, { pageSize: 2001 }, { cursor: 'v1.logins.AQ' }, { filter: { owner: { op: 'equals', value: 'dbo' }, created: { op: 'between', value: '2020-01-01' } } },
      { sql: 'SELECT 1' }, { node: { type: 'object', object: { kind: 'server' } }, subtype: 'history' }
    ]) expect(() => validateRequest('explorer.children', { ...valid, ...patch }), JSON.stringify(patch)).toThrow('Invalid request')
    // Loads run on the explorer lane under the backend's own gates; main keeps the default 45 s deadline.
    expect(methodPolicies['explorer.children']).toEqual({ kind: 'unary', lane: 'explorer', deadlineMs: 45_000 })
    // Cancellation is main's own channel (varia:explorer-cancel), not a backend method.
    expect(() => validateRequest('explorer.cancel', { requestIds: [requestId] })).toThrow('Unsupported backend method')
    expect(explorerCancelParamsSchema.parse({ requestIds: [requestId] })).toEqual({ requestIds: [requestId] })
    for (const params of [{ requestIds: [] }, { requestIds: [requestId, requestId] }, { requestIds: Array.from({ length: 257 }, () => crypto.randomUUID()) }, { requestIds: ['x'] }, { requestIds: [requestId], extra: 1 }])
      expect(explorerCancelParamsSchema.safeParse(params).success, JSON.stringify(params).slice(0, 80)).toBe(false)
  })
  it('takes Script As requests for one scriptable object, a verb it offers, and every option', () => {
    const valid = { connectionId: crypto.randomUUID(), requestId: crypto.randomUUID(), targets: [{ kind: 'view', database: 'Sales', schema: 'dbo', name: ' v]1 ' }], verb: 'alter', options: defaultScriptingOptions }
    expect(validateRequest('scripting.script', valid)).toEqual(valid)
    expect(validateRequest('scripting.script', { ...valid, targets: [{ kind: 'trigger', database: 'd', name: 't', parent: { kind: 'view', schema: 'dbo', name: 'v' } }] })).toBeTruthy()
    const { scriptOwner: _, ...missing } = defaultScriptingOptions
    for (const patch of [
      { targets: [] }, { targets: [valid.targets[0], valid.targets[0]] }, { targets: [{ ...valid.targets[0], name: 'x'.repeat(129) }] }, { targets: [{ ...valid.targets[0], name: 'a\u0000b' }] },
      { targets: [{ kind: 'certificate', database: 'd', name: 'c' }] }, { targets: [{ kind: 'column', database: 'd', name: 'c', parent: { kind: 'table', schema: 'dbo', name: 't' } }] },
      { targets: [{ kind: 'index', database: 'd', name: 'i', parent: { kind: 'tableType', schema: 'dbo', name: 't' } }] }, { verb: 'execute' }, { verb: 'Create' },
      { options: missing }, { options: { ...defaultScriptingOptions, extra: true } }, { options: { ...defaultScriptingOptions, targetServerVersion: '120' } }, { options: { ...defaultScriptingOptions, includeHeaders: 'true' } },
      { requestId: 'r1' }, { extra: 1 }
    ]) expect(() => validateRequest('scripting.script', { ...valid, ...patch }), JSON.stringify(patch).slice(0, 80)).toThrow('Invalid request')
    // SMO can run for a while: a 60 s deadline around the backend's own 55 s budget, on the metadata lane.
    expect(methodPolicies['scripting.script']).toEqual({ kind: 'unary', lane: 'metadata', deadlineMs: 60_000 })
    // Cancellation is main's own channel (varia:scripting-cancel), not a backend method.
    expect(() => validateRequest('scripting.cancel', { requestIds: [valid.requestId] })).toThrow('Unsupported backend method')
    expect(scriptCancelSchema.parse({ requestIds: [valid.requestId] })).toEqual({ requestIds: [valid.requestId] })
    for (const params of [{ requestIds: [] }, { requestIds: [valid.requestId, valid.requestId] }, { requestIds: Array.from({ length: 65 }, () => crypto.randomUUID()) }, { requestIds: ['x'] }, { requestIds: [valid.requestId], extra: 1 }])
      expect(scriptCancelSchema.safeParse(params).success, JSON.stringify(params).slice(0, 80)).toBe(false)
  })
  it('validates results port requests strictly', () => {
    const read = { t: 'read', rid: 1, generation: 1, resultId: 1, firstRow: 0, maxRows: 65_536, credit: 16 * 1024 * 1024 }
    expect(portRequestSchema.parse(read)).toEqual(read)
    for (const message of [{ t: 'credit', rid: 2 ** 31 - 1, bytes: 1 }, { t: 'cancel', rid: 1 }, { t: 'close', rid: 1, generation: 3, resultIds: Array.from({ length: 1024 }, (_, index) => index + 1) }]) expect(portRequestSchema.safeParse(message).success).toBe(true)
    for (const message of [
      { ...read, extra: 1 }, { ...read, rid: 0 }, { ...read, rid: 2 ** 31 }, { ...read, generation: 0 }, { ...read, resultId: 2 ** 32 }, { ...read, firstRow: Number.MAX_SAFE_INTEGER + 1 },
      { ...read, maxRows: 0 }, { ...read, maxRows: 65_537 }, { ...read, credit: 65_535 }, { ...read, credit: 16 * 1024 * 1024 + 1 }, { ...read, firstRow: 1.5 },
      { t: 'credit', rid: 1, bytes: 0 }, { t: 'cancel', rid: 1, reason: 3 }, { t: 'close', rid: 1, generation: 1, resultIds: [] }, { t: 'close', rid: 1, generation: 1, resultIds: Array.from({ length: 1025 }, (_, index) => index + 1) },
      { t: 'invoke', rid: 1 }, null, 'read'
    ]) expect(portRequestSchema.safeParse(message).success, JSON.stringify(message)).toBe(false)
  })
  it('validates query events from the backend strictly', () => {
    expect(queryEventSchema.safeParse({ type: 'messages', messages: ['a'] }).success).toBe(true)
    expect(queryEventSchema.safeParse({ type: 'messages', messages: [] }).success).toBe(false)
    expect(queryEventSchema.safeParse({ type: 'progress', completedBatches: 0, totalBatches: 1, batchNumber: 1, iteration: 1, results: [], extra: true }).success).toBe(false)
    expect(queryEventSchema.safeParse({ type: 'resultSet.opened', descriptor: { resultId: 1, generation: 1 } }).success).toBe(false)
  })
})
