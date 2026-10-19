import { describe, expect, it } from 'vitest'
import { requestSchemas, resultsCopyRequestSchema, resultsSaveRequestSchema, validateRequest } from '../src/main/validation'
import { jobProgressSchema, portRequestSchema, queryEventSchema, queryResultSchema } from '../src/shared/ipc/port-messages'
import { explorerCancelParamsSchema } from '../src/shared/explorer/schema'
import { deadlineFor, mainOnlyMethods, methodPolicies } from '../src/shared/ipc/methods'
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
    // stopOnError (SQLCMD's :on error exit) is an optional boolean; without it the next batch runs after an error.
    for (const patch of [{ maxRows: 0 }, { maxRows: 2 ** 31 - 1 }, { maxResultSets: 1 }, { maxResultSets: 1000 }, { stopOnError: true }, { stopOnError: false }]) expect(validateRequest('query.execute', { ...valid, ...patch })).toEqual({ ...valid, ...patch })
    for (const patch of [{ maxRows: -1 }, { maxRows: 2 ** 31 }, { maxRows: 1.5 }, { maxResultSets: 0 }, { maxResultSets: 1001 }, { timeoutSeconds: -1 }, { timeoutSeconds: 86401 }, { queryId: 'invalid' }, { sessionId: 'invalid' }, { startLine: 0 }, { sql: '' }, { stopOnError: 'true' }, { stopOnError: 1 }, { stopOnError: null }]) expect(() => validateRequest('query.execute', { ...valid, ...patch })).toThrow('Invalid request')
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
    expect(queryEventSchema.safeParse({ type: 'messages', messages: [{ text: 'a', kind: 'info' }, { text: 'Msg 8134, Level 16, State 1, Line 1\nDivide by zero error encountered.', kind: 'error' }] }).success).toBe(true)
    for (const messages of [[], ['a'], [{ text: 'a', kind: 'warning' }], [{ text: 'a', kind: 'info', extra: 1 }], [{ text: 'x'.repeat(1_000_001), kind: 'info' }]])
      expect(queryEventSchema.safeParse({ type: 'messages', messages }).success, JSON.stringify(messages).slice(0, 60)).toBe(false)
    expect(queryEventSchema.safeParse({ type: 'progress', completedBatches: 0, totalBatches: 1, batchNumber: 1, iteration: 1, results: [], extra: true }).success).toBe(false)
    expect(queryEventSchema.safeParse({ type: 'resultSet.opened', descriptor: { resultId: 1, generation: 1 } }).success).toBe(false)
  })
  it('accepts a summary with message entries and its completion time, and nothing looser', () => {
    const summary = {
      resultSets: [], discardedResultSets: 0, messages: [{ text: '(1 row affected)', kind: 'info' }], recordsAffected: 1, elapsedMs: 1, status: 'completed', completedBatches: 1, totalBatches: 1,
      database: 'master', messagesTruncated: false, budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1, seq: 1 }, completedAt: '2026-10-09T12:34:56.1234567+02:00'
    }
    expect(queryResultSchema.safeParse(summary).success).toBe(true)
    // The session's smallint @@SPID and login name, read when it opened. No transaction count: the session is not asked
    // after a script, only when it is about to end (query.session.state).
    expect(queryResultSchema.safeParse({ ...summary, spid: 32767, login: 'x'.repeat(128) }).success).toBe(true)
    for (const patch of [{ transactionCount: 0 }, { spid: 32768 }, { spid: 1.5 }, { login: 'x'.repeat(129) }, { login: 1 }])
      expect(queryResultSchema.safeParse({ ...summary, ...patch }).success, JSON.stringify(patch)).toBe(false)
    // The budget's seq orders it with the results.memory events; main adds the generation.
    for (const patch of [{ completedAt: undefined }, { completedAt: 'x'.repeat(41) }, { messages: ['(1 row affected)'] }, { budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1 } },
      { budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1, seq: 1, generation: 1 } }, { budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1, seq: -1 } }])
      expect(queryResultSchema.safeParse({ ...summary, ...patch }).success, JSON.stringify(patch).slice(0, 60)).toBe(false)
  })
  it('ends a query session plainly, or with its transaction committed or rolled back', () => {
    const sessionId = crypto.randomUUID()
    for (const transaction of [undefined, 'commit', 'rollback']) expect(validateRequest('query.session.close', { sessionId, ...transaction ? { transaction } : {} })).toEqual({ sessionId, ...transaction ? { transaction } : {} })
    for (const params of [{ sessionId, transaction: 'save' }, { sessionId, transaction: null }, { sessionId, commit: true }]) expect(() => validateRequest('query.session.close', params)).toThrow()
    expect(deadlineFor('query.session.close', { sessionId, transaction: 'commit' }).deadlineMs).toBe(60_000)
    expect(deadlineFor('query.session.close', { sessionId, transaction: 'rollback' }).deadlineMs).toBe(10_000)
  })
  it('reads a query session\'s transaction with only its id, on the control lane, within a short deadline', () => {
    const sessionId = crypto.randomUUID()
    expect(validateRequest('query.session.state', { sessionId })).toEqual({ sessionId })
    for (const params of [{}, { sessionId: 'tab-1' }, { sessionId, transaction: 'commit' }, { sessionId: 'x'.repeat(4096) }]) expect(() => validateRequest('query.session.state', params)).toThrow()
    expect(methodPolicies['query.session.state']).toMatchObject({ kind: 'unary', lane: 'control' })
    expect(deadlineFor('query.session.state', { sessionId })).toEqual({ deadlineMs: 5000, backstopMs: 10_000 })
  })
  it('validates copy and save requests strictly', () => {
    const copy = { jobId: crypto.randomUUID(), generation: 1, resultId: 7, headers: true, parts: [{ rows: [[0, 9], [20, Number.MAX_SAFE_INTEGER]], columns: [[0, 0], [2, 4095]] }] }
    expect(resultsCopyRequestSchema.parse(copy)).toEqual(copy)
    const part = copy.parts[0]
    for (const patch of [
      { jobId: 'x' }, { generation: 0 }, { resultId: 2 ** 32 }, { headers: 'yes' }, { parts: [] }, { parts: Array.from({ length: 65 }, () => part) }, { extra: 1 },
      { parts: [{ ...part, rows: [[5, 4]] }] }, { parts: [{ ...part, rows: [[0, 9], [9, 12]] }] }, { parts: [{ ...part, rows: [[10, 12], [0, 2]] }] },
      { parts: [{ ...part, rows: [[0, Number.MAX_SAFE_INTEGER + 1]] }] }, { parts: [{ ...part, columns: [[0, 4096]] }] }, { parts: [{ ...part, columns: [] }] },
      { parts: [{ ...part, rows: Array.from({ length: 65 }, (_, i) => [2 * i, 2 * i]) }] }, { parts: [{ ...part, rows: [[0.5, 1]] }] }, { parts: [{ ...part, extra: 1 }] }
    ]) expect(resultsCopyRequestSchema.safeParse({ ...copy, ...patch }).success, JSON.stringify(patch).slice(0, 80)).toBe(false)
    const save = { jobId: crypto.randomUUID(), generation: 1, resultId: 7, format: 'csv', suggestedName: 'Query1-Result1' }
    expect(resultsSaveRequestSchema.parse(save)).toEqual(save)
    expect(resultsSaveRequestSchema.safeParse({ ...save, format: undefined }).success).toBe(true)
    for (const patch of [{ format: 'xlsx' }, { suggestedName: '' }, { suggestedName: 'x'.repeat(129) }, { path: '/tmp/x.csv' }, { generation: 2 ** 31 }])
      expect(resultsSaveRequestSchema.safeParse({ ...save, ...patch }).success, JSON.stringify(patch)).toBe(false)
    expect(jobProgressSchema.safeParse({ type: 'job.progress', rowsDone: 1, rowsTotal: 2, bytes: 3 }).success).toBe(true)
    expect(jobProgressSchema.safeParse({ type: 'job.progress', rowsDone: -1, rowsTotal: 2, bytes: 3 }).success).toBe(false)
  })
  it('keeps the methods only main sends out of every renderer and port schema', () => {
    for (const method of mainOnlyMethods) {
      expect(Object.hasOwn(requestSchemas, method), method).toBe(false)
      expect(() => validateRequest(method, {}), method).toThrow('Unsupported backend method')
      expect(portRequestSchema.safeParse({ t: method, rid: 1 }).success).toBe(false)
    }
    expect(methodPolicies['results.copy']).toMatchObject({ kind: 'stream', lane: 'results', deadlineMs: 120_000 })
    expect(methodPolicies['results.export']).toMatchObject({ kind: 'unary', lane: 'results', deadlineMs: 0 })
  })
})
