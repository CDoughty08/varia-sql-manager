import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { BackendClient } from '../src/main/backend-client'
import { serverObjectKinds, type ServerObjectKind } from '../src/shared/contracts'

const clients: BackendClient[] = []
function backend(): BackendClient {
  const client = new BackendClient('dotnet', [resolve('backend/Varia.Backend/bin/Release/net10.0/Varia.Backend.dll')], process.cwd())
  clients.push(client)
  return client
}
function fixture(mode: string): BackendClient {
  const client = new BackendClient(process.execPath, [resolve('tests/fixtures/backend.mjs'), mode], process.cwd())
  clients.push(client)
  return client
}
afterEach(() => { clients.splice(0).forEach(client => client.stop()) })

describe('real .NET sidecar', () => {
  it('previews the effective provider string without exposing passwords', async () => {
    const value = await backend().request('connections.preview', { server: 'localhost', database: '', authentication: 'sql', username: 'reader', password: 'super-secret', trustServerCertificate: true, encrypt: 'strict', advanced: { commandTimeout: 0, networkProtocol: 'tcp', applicationIntent: 'ReadOnly' } }, 0)
    expect(value.connectionString).toContain('tcp:localhost')
    expect(value.connectionString).toContain('ReadOnly')
    expect(value.connectionString).toContain('Encrypt=Strict')
    expect(value.connectionString).not.toContain('super-secret')
    expect(value.connectionString).toContain('Trust Server Certificate=False')
  })
  it('rejects invalid enclave and discovery settings before connecting', async () => {
    const client = backend()
    await expect(client.request('connections.preview', { server: 'localhost', database: '', authentication: 'windows', trustServerCertificate: false, advanced: { columnEncryption: false, secureEnclaves: true } })).rejects.toThrow('Secure enclaves require Always Encrypted')
    await expect(client.request('connections.discover', { scope: 'bad' as 'local' })).rejects.toThrow('Unsupported server discovery scope')
  })
  it('loads the runtime, SMO, and SqlClient without a SQL Server', async () => {
    const health = await backend().request('system.health', {})
    expect(health.protocolVersion).toBe(1)
    expect(health.runtime).toMatch(/\.NET 10\./)
    expect(health.smoVersion).toMatch(/^\d+\./)
    expect(health.sqlClientVersion).toMatch(/^\d+\./)
  })
  it('correlates concurrent requests', async () => {
    const client = backend()
    const responses = await Promise.all(Array.from({ length: 4 }, () => client.request('system.health', {})))
    expect(responses.every(health => health.protocolVersion === 1)).toBe(true)
  })
  it('returns a connection error when no connection exists', async () => {
    await expect(backend().request('databases.list', { connectionId: crypto.randomUUID() })).rejects.toThrow('Connect to a SQL Server first.')
  })
  it('validates authentication without attempting a connection', async () => {
    await expect(backend().request('connections.connect', { server: 'localhost', database: 'master', authentication: 'invalid' as 'sql', trustServerCertificate: false })).rejects.toThrow('Unsupported authentication mode.')
  })
  it('dispatches server catalogs and rejects unsupported categories before connecting', async () => {
    const client = backend()
    const connectionId = crypto.randomUUID()
    for (const kind of serverObjectKinds) await expect(client.request('server.objects.list', { connectionId, kind })).rejects.toThrow('Connect to a SQL Server first.')
    await expect(client.request('server.objects.list', { connectionId, kind: 'sys.credentials' as ServerObjectKind })).rejects.toThrow('Unsupported server object category.')
  })
  it('handles cancellation of a completed or unknown query', async () => {
    await expect(backend().request('query.cancel', { queryId: crypto.randomUUID() })).resolves.toEqual({ cancelled: false })
  })
  it('closes an unused tab session and validates its ID in the real sidecar', async () => {
    const client = backend()
    await expect(client.request('query.session.close', { sessionId: crypto.randomUUID() })).resolves.toEqual({ closed: false })
    await expect(client.request('query.session.close', { sessionId: 'invalid' })).rejects.toThrow('A valid session ID is required.')
  })
  it('rejects malformed GO with the selected source line before connection lookup', async () => {
    await expect(backend().request('query.execute', { connectionId: crypto.randomUUID(), sessionId: crypto.randomUUID(), database: 'master', sql: 'SELECT 1;\nGO 0', startLine: 20, queryId: crypto.randomUUID(), maxRows: 1000, timeoutSeconds: 30 })).rejects.toThrow('Line 21:')
  })
  it('echoes the request id when rejecting an oversized line, so the caller is never left waiting', async () => {
    const child = spawn('dotnet', [resolve('backend/Varia.Backend/bin/Release/net10.0/Varia.Backend.dll')], { stdio: 'pipe' })
    const id = crypto.randomUUID()
    try {
      const line = await new Promise<string>(done => {
        createInterface({ input: child.stdout }).once('line', done)
        child.stdin.write(JSON.stringify({ id, method: 'system.health', params: { padding: 'x'.repeat(1_200_000) } }) + '\n')
      })
      expect(JSON.parse(line)).toEqual({ id, error: { code: 'INVALID_REQUEST', message: expect.stringContaining('size limit') } })
    } finally { child.kill() }
  })
  it('rejects an invalid query before it reaches SQL Server', async () => {
    await expect(backend().request('query.execute', { connectionId: crypto.randomUUID(), sessionId: crypto.randomUUID(), database: 'master', sql: 'SELECT 1', queryId: crypto.randomUUID(), maxRows: 100000, timeoutSeconds: 30 })).rejects.toThrow('Query text, ID, session, timeout, or row limit is invalid.')
  })
})

describe('bridge lifecycle', () => {
  it('times out a backend that does not answer', async () => {
    await expect(fixture('silent').request('system.health', {}, 100)).rejects.toThrow('timed out')
  })
  it('rejects pending requests if the backend exits', async () => {
    await expect(fixture('exit').request('system.health', {})).rejects.toThrow('backend stopped')
  })
  it('tolerates blank lines and a CR split from its LF', async () => {
    await expect(fixture('framing').request('system.health', {})).resolves.toEqual({ protocolVersion: 1 })
  })
  it('rejects a request that JSON escaping pushes past the backend line limit before sending it', async () => {
    const params = { connectionId: crypto.randomUUID(), sessionId: crypto.randomUUID(), database: 'master', sql: '"'.repeat(600_000), queryId: crypto.randomUUID(), maxRows: 1000, timeoutSeconds: 0 }
    await expect(fixture('silent').request('query.execute', params, 0)).rejects.toThrow('too large')
  })
  it('ends the old process and starts a fresh one after a renderer reload', async () => {
    const client = fixture('pid')
    const before = (await client.request('system.health', {}) as unknown as { pid: number }).pid
    client.restart()
    const after = (await client.request('system.health', {}) as unknown as { pid: number }).pid
    expect(after).not.toBe(before)
    await expect.poll(() => { try { process.kill(before, 0); return 'running' } catch { return 'exited' } }).toBe('exited')
  })
  it('rejects requests abandoned by a restart', async () => {
    const client = fixture('silent')
    const abandoned = client.request('system.health', {}, 0)
    client.restart()
    await expect(abandoned).rejects.toThrow('reloaded')
  })
  it('keeps cancellation available when the pending-request cap is reached', async () => {
    const client = fixture('silent')
    const outstanding = Array.from({ length: 256 }, () => client.request('system.health', {}, 0).catch(() => {}))
    await expect(client.request('system.health', {}, 100)).rejects.toThrow('Too many pending')
    await expect(client.request('query.cancel', { queryId: crypto.randomUUID() }, 100)).rejects.toThrow('timed out')
    client.stop()
    await Promise.all(outstanding)
  })
  it('fails on malformed protocol output', async () => {
    await expect(fixture('malformed').request('system.health', {})).rejects.toThrow('invalid protocol message')
  })
  it('provides an actionable startup error', async () => {
    const client = new BackendClient('varia-command-that-does-not-exist', [], process.cwd())
    clients.push(client)
    await expect(client.request('system.health', {})).rejects.toThrow('Could not start the .NET backend')
  })
})
