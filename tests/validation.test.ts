import { describe, expect, it } from 'vitest'
import { validateRequest } from '../src/main/validation'
import { serverObjectKinds } from '../src/shared/contracts'

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
    for (const patch of [{ maxRows: 5001 }, { timeoutSeconds: -1 }, { timeoutSeconds: 86401 }, { queryId: 'invalid' }, { sessionId: 'invalid' }, { startLine: 0 }, { sql: '' }]) expect(() => validateRequest('query.execute', { ...valid, ...patch })).toThrow('Invalid request')
  })
  it('passes identifiers verbatim and explains oversized scripts', () => {
    const connectionId = crypto.randomUUID()
    expect(validateRequest('tables.list', { connectionId, database: ' padded ' })).toEqual({ connectionId, database: ' padded ' })
    expect(() => validateRequest('tables.list', { connectionId, database: '   ' })).toThrow('Invalid request')
    // IPC can deliver a cloneable non-string whose property key coerces to a real method name.
    expect(() => validateRequest(['tables.list'] as unknown as string, { connectionId, database: 'master' })).toThrow('Unsupported backend method')
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
  it('allowlists server object categories and rejects SQL or extra fields', () => {
    const connectionId = crypto.randomUUID()
    for (const kind of serverObjectKinds) expect(validateRequest('server.objects.list', { connectionId, kind })).toEqual({ connectionId, kind })
    for (const params of [
      { connectionId, kind: 'sys.credentials; DROP TABLE anything' },
      { connectionId, kind: 'serverRoles', sql: 'SELECT 1' },
      { connectionId: 'invalid', kind: 'logins' }
    ]) expect(() => validateRequest('server.objects.list', params)).toThrow('Invalid request')
  })
})
