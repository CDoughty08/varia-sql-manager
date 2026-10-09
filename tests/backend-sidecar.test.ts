import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { BackendConnection } from '../src/main/backend/connection'
import { BackendError } from '../src/main/backend/errors'
import { backendMethods, deadlineFor } from '../src/shared/ipc/methods'
import { FrameKind, FrameParser, encodeFrame, type Frame } from '../src/shared/ipc/wire/frames'
import { decodeControl, encodeControl } from '../src/shared/ipc/wire/msgpack'
import type { BackendMethod, BackendMethods, ResultDescriptor } from '../src/shared/contracts'
import { decodePage } from '../src/shared/ipc/wire/pages'
import { cellText } from '../src/shared/ipc/wire/cells'
import { fuzzSeed, mulberry32 } from './fuzz/prng'

// The Release build, as CI checks it: npm run check builds it before vitest runs.
const dll = resolve('backend/Varia.Backend/bin/Release/net10.0/Varia.Backend.dll')
const connections: BackendConnection[] = []
const processes: ChildProcessWithoutNullStreams[] = []
afterEach(async () => {
  processes.splice(0).forEach(child => child.kill())
  await Promise.all(connections.splice(0).map(connection => connection.close()))
})

/** `env` adds variables for the backend, such as its test hooks. */
function backend(env?: Record<string, string>): BackendConnection {
  const connection = new BackendConnection({ command: 'dotnet', args: [dll], cwd: process.cwd(), env: env && { ...process.env, ...env }, packaged: false }, 1)
  connections.push(connection)
  return connection
}
function call<M extends BackendMethod>(connection: BackendConnection, method: M, params: BackendMethods[M]['params']): Promise<BackendMethods[M]['result']> {
  return connection.send(method, params, deadlineFor(method, params)).done as Promise<BackendMethods[M]['result']>
}

/** The backend process spoken to frame by frame, for what BackendConnection would never send. */
function raw(env?: Record<string, string>) {
  const child = spawn('dotnet', [dll], { stdio: 'pipe', env: env && { ...process.env, ...env } })
  processes.push(child)
  const parser = new FrameParser({ maxBody: 16 * 1024 * 1024, direction: 'toMain' })
  const frames: Frame[] = []
  const output: Uint8Array[] = []
  let notify = () => {}
  child.stdout.on('data', (chunk: Buffer) => {
    output.push(Uint8Array.from(chunk))
    for (const frame of parser.push(chunk)) if (!frame.oversize) frames.push(frame)
    notify()
  })
  child.stderr.resume()
  const exit = new Promise<number | null>(done => child.on('close', code => done(code)))
  const write = (bytes: Uint8Array) => { child.stdin.write(bytes) }
  async function next(kind?: FrameKind, timeoutMs = 10_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const index = frames.findIndex(frame => kind === undefined || frame.kind === kind)
      if (index >= 0) return frames.splice(index, 1)[0]
      if (Date.now() > deadline) throw new Error('No frame of kind ' + kind)
      await new Promise<void>(done => { notify = done; setTimeout(done, 50) })
    }
  }
  async function hello(versions = [2, 2]): Promise<Record<string, unknown>> {
    write(encodeFrame(FrameKind.HELLO, 0, 0, encodeControl({ versions, generation: 9, maxFrameBytes: 16 * 1024 * 1024, app: 'test' })))
    return decodeControl((await next(FrameKind.HELLO)).body) as Record<string, unknown>
  }
  const request = (id: number, value: unknown, deadline = 0) => write(encodeFrame(FrameKind.REQUEST, id, deadline, encodeControl(value)))
  return { child, frames, output, exit, write, next, hello, request }
}
const body = (frame: Frame) => decodeControl(frame.body) as Record<string, unknown>
/** A header with any field, valid or not. */
function header(kind: number, length: number, id = 1, arg = 0, flags = 0, magic = [0x56, 0x0a]): Uint8Array {
  const bytes = new Uint8Array(16 + length)
  const view = new DataView(bytes.buffer)
  bytes.set(magic)
  bytes[2] = kind
  bytes[3] = flags
  view.setUint32(4, length, true)
  view.setUint32(8, id, true)
  view.setUint32(12, arg, true)
  return bytes
}
const requestFrame = (id: number, value: unknown) => encodeFrame(FrameKind.REQUEST, id, 0, encodeControl(value))

describe('real .NET sidecar over protocol v2', () => {
  it('announces itself in HELLO with every method main may call', async () => {
    const hello = await backend().ready
    expect(hello).toMatchObject({ version: 2, generation: 1, maxFrameBytes: 4 * 1024 * 1024, sqlClientVersion: expect.stringMatching(/^\d+\./) })
    expect(hello.runtime).toMatch(/\.NET 10\./)
    expect(hello.methods).toEqual(expect.arrayContaining([...backendMethods]))
    expect(hello.resultBudget!.globalBytes).toBeGreaterThanOrEqual(256 * 1024 * 1024)
    expect(hello.resultBudget!.queryBytes).toBe(hello.resultBudget!.globalBytes / 2)
  })
  it('previews the effective provider string without exposing passwords', async () => {
    const value = await call(backend(), 'connections.preview', { server: 'localhost', database: '', authentication: 'sql', username: 'reader', password: 'super-secret', trustServerCertificate: true, encrypt: 'strict', advanced: { commandTimeout: 0, networkProtocol: 'tcp', applicationIntent: 'ReadOnly' } })
    expect(value.connectionString).toContain('tcp:localhost')
    expect(value.connectionString).toContain('ReadOnly')
    expect(value.connectionString).toContain('Encrypt=Strict')
    expect(value.connectionString).not.toContain('super-secret')
    expect(value.connectionString).toContain('Trust Server Certificate=False')
  })
  it('rejects invalid enclave and discovery settings before connecting', async () => {
    const connection = backend()
    await expect(call(connection, 'connections.preview', { server: 'localhost', database: '', authentication: 'windows', trustServerCertificate: false, advanced: { columnEncryption: false, secureEnclaves: true } })).rejects.toThrow('Secure enclaves require Always Encrypted')
    await expect(call(connection, 'connections.discover', { scope: 'bad' as 'local' })).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: 'Unsupported server discovery scope.' })
  })
  it('loads the runtime, SMO, and SqlClient without a SQL Server', async () => {
    const health = await call(backend(), 'system.health', {})
    expect(health.protocolVersion).toBe(2)
    expect(health.runtime).toMatch(/\.NET 10\./)
    expect(health.smoVersion).toMatch(/^\d+\./)
    expect(health.sqlClientVersion).toMatch(/^\d+\./)
  })
  it('correlates concurrent requests', async () => {
    const connection = backend()
    const responses = await Promise.all(Array.from({ length: 4 }, () => call(connection, 'system.health', {})))
    expect(responses.every(health => health.protocolVersion === 2)).toBe(true)
  })
  it('returns a connection error when no connection exists', async () => {
    await expect(call(backend(), 'databases.list', { connectionId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'NOT_CONNECTED', message: 'Connect to a SQL Server first.' })
  })
  it('validates authentication without attempting a connection', async () => {
    await expect(call(backend(), 'connections.connect', { server: 'localhost', database: 'master', authentication: 'invalid' as 'sql', trustServerCertificate: false })).rejects.toThrow('Unsupported authentication mode.')
  })
  it('no longer offers the v1 catalog methods that explorer.children replaced', async () => {
    const backend = raw()
    const hello = await backend.hello()
    const retired = ['tables.list', 'server.objects.list']
    expect((hello.methods as string[]).filter(method => retired.includes(method))).toEqual([])
    backend.request(1, { method: 'tables.list', params: { connectionId: crypto.randomUUID(), database: 'master' } })
    backend.request(2, { method: 'server.objects.list', params: { connectionId: crypto.randomUUID(), kind: 'logins' } })
    for (let index = 0; index < 2; index++) expect(body(await backend.next(FrameKind.RESPONSE))).toMatchObject({ error: { code: 'METHOD_NOT_FOUND' } })
  })
  it('reads a table\'s columns on the metadata lane, checking names before the connection', async () => {
    const connection = backend()
    const table = { connectionId: crypto.randomUUID(), database: 'master', schema: 'dbo' }
    await expect(call(connection, 'tables.columns', { ...table, name: 'x'.repeat(129) })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(call(connection, 'tables.columns', { ...table, name: 'Orders' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
    expect(deadlineFor('tables.columns', { ...table, name: 'Orders' })).toEqual({ deadlineMs: 45_000, backstopMs: 50_000 })
  })
  it('checks Object Explorer refs against the catalogue before the connection', async () => {
    const connection = backend()
    const base = { connectionId: crypto.randomUUID(), requestId: crypto.randomUUID() }
    const folder = { type: 'folder', owner: { kind: 'database', name: 'master' }, folder: 'tables' } as const
    // Shapes zod would also refuse reach the backend only through tests; it re-checks them on its own.
    for (const node of [{ type: 'folder', owner: { kind: 'server' }, folder: 'tables' }, { type: 'object', object: { kind: 'table', database: 'x', name: 'y' } }, { type: 'object', object: { kind: 'nope' } }])
      await expect(call(connection, 'explorer.children', { ...base, node } as never)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(call(connection, 'explorer.children', { ...base, node: folder, cursor: 'v1.tables.AQ' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(call(connection, 'explorer.children', { ...base, node: folder, extra: 1 } as never)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(call(connection, 'explorer.children', { ...base, node: folder })).rejects.toMatchObject({ code: 'NOT_CONNECTED', message: 'Connect to a SQL Server first.' })
    await expect(call(connection, 'explorer.children', { ...base, node: { type: 'object', object: { kind: 'server' } } })).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
    expect(deadlineFor('explorer.children', { ...base, node: folder })).toEqual({ deadlineMs: 45_000, backstopMs: 50_000 })
  })
  it('handles cancellation of a completed or unknown query', async () => {
    await expect(call(backend(), 'query.cancel', { queryId: crypto.randomUUID() })).resolves.toEqual({ cancelled: false })
  })
  it('closes an unused tab session and validates its ID', async () => {
    const connection = backend()
    await expect(call(connection, 'query.session.close', { sessionId: crypto.randomUUID() })).resolves.toEqual({ closed: false })
    await expect(call(connection, 'query.session.close', { sessionId: 'invalid' })).rejects.toThrow('A valid session ID is required.')
  })
  it('rejects malformed GO with the selected source line before connection lookup', async () => {
    await expect(call(backend(), 'query.execute', { connectionId: crypto.randomUUID(), sessionId: crypto.randomUUID(), database: 'master', sql: 'SELECT 1;\nGO 0', startLine: 20, queryId: crypto.randomUUID(), maxRows: 1000, timeoutSeconds: 30 })).rejects.toThrow('Line 21:')
  })
  it('rejects an invalid query before it reaches SQL Server', async () => {
    await expect(call(backend(), 'query.execute', { connectionId: crypto.randomUUID(), sessionId: crypto.randomUUID(), database: 'master', sql: 'SELECT 1', queryId: crypto.randomUUID(), maxRows: -1, timeoutSeconds: 30 })).rejects.toThrow('Query text, ID, session, timeout, or row limit is invalid.')
  })
  it('rejects unknown parameters as INVALID_PARAMS without failing the process', async () => {
    const connection = backend()
    await expect(call(connection, 'query.cancel', { queryId: crypto.randomUUID(), extra: 1 } as never)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(call(connection, 'system.health', {})).resolves.toMatchObject({ protocolVersion: 2 })
  })
  it('answers PING with PONG', async () => {
    const connection = new BackendConnection({ command: 'dotnet', args: [dll], cwd: process.cwd(), packaged: false }, 1, { limits: { pingMs: 50 } })
    connections.push(connection)
    await connection.ready
    await new Promise(done => setTimeout(done, 500))
    expect(connection.silentMs).toBeLessThan(400)
  })
})

describe('real .NET sidecar frame handling', () => {
  it('answers a 5 MiB REQUEST with TOO_LARGE for its id, and the next request succeeds', async () => {
    const backend = raw()
    await backend.hello()
    backend.write(requestFrame(7, { method: 'system.health', params: { padding: 'x'.repeat(5 * 1024 * 1024) } }))
    backend.request(8, { method: 'system.health', params: {} })
    const tooLarge = await backend.next(FrameKind.RESPONSE)
    expect(tooLarge.id).toBe(7)
    expect(body(tooLarge)).toEqual({ error: { code: 'TOO_LARGE', message: expect.stringContaining('too large') } })
    const next = await backend.next(FrameKind.RESPONSE)
    expect(next.id).toBe(8)
    expect(body(next)).toMatchObject({ result: { protocolVersion: 2 } })
  })
  it('exits 65 with PROTOCOL_UNSUPPORTED when no protocol version is shared', async () => {
    const backend = raw()
    backend.write(encodeFrame(FrameKind.HELLO, 0, 0, encodeControl({ versions: [3, 4], generation: 1, maxFrameBytes: 16 * 1024 * 1024 })))
    expect(body(await backend.next(FrameKind.GOAWAY))).toMatchObject({ code: 'PROTOCOL_UNSUPPORTED', versions: [2, 2] })
    expect(await backend.exit).toBe(65)
  })
  it('sends GOAWAY PROTOCOL_ERROR and exits 64 for each malformed frame from main', async () => {
    const tooLongMethod = 'm'.repeat(65)
    const cases: { name: string; bytes: Uint8Array; beforeHello?: true }[] = [
      { name: 'bad first magic byte', bytes: header(FrameKind.PING, 0, 0, 1, 0, [0x57, 0x0a]) },
      { name: 'bad second magic byte', bytes: header(FrameKind.PING, 0, 0, 1, 0, [0x56, 0x0d]) },
      { name: 'kind 0', bytes: header(0, 0) },
      { name: 'kind 11', bytes: header(11, 0) },
      { name: 'RESPONSE from main', bytes: header(FrameKind.RESPONSE, 1) },
      { name: 'EVENT from main', bytes: header(FrameKind.EVENT, 1) },
      { name: 'DATA from main', bytes: header(FrameKind.DATA, 1) },
      { name: 'PONG from main', bytes: header(FrameKind.PONG, 0, 0) },
      { name: 'GOAWAY from main', bytes: header(FrameKind.GOAWAY, 1, 0) },
      { name: 'nonzero flags', bytes: header(FrameKind.PING, 0, 0, 1, 1) },
      { name: 'empty REQUEST', bytes: header(FrameKind.REQUEST, 0) },
      { name: 'CANCEL with a body', bytes: header(FrameKind.CANCEL, 1, 1, 1) },
      { name: 'second HELLO', bytes: encodeFrame(FrameKind.HELLO, 0, 0, encodeControl({ versions: [2, 2], generation: 1 })) },
      { name: 'envelope that is not a map', bytes: requestFrame(1, ['system.health', {}]) },
      { name: 'envelope with an unknown key', bytes: requestFrame(1, { method: 'system.health', params: {}, extra: 1 }) },
      { name: 'envelope without params', bytes: requestFrame(1, { method: 'system.health' }) },
      { name: 'request id 0', bytes: requestFrame(0, { method: 'system.health', params: {} }) },
      { name: 'method name over 64 bytes', bytes: requestFrame(1, { method: tooLongMethod, params: {} }) },
      { name: 'CREDIT of 0 bytes', bytes: encodeFrame(FrameKind.CREDIT, 1, 0) },
      { name: 'CANCEL reason 9', bytes: encodeFrame(FrameKind.CANCEL, 1, 9) },
      { name: 'REQUEST before HELLO', bytes: requestFrame(1, { method: 'system.health', params: {} }), beforeHello: true },
      { name: 'undecodable HELLO', bytes: encodeFrame(FrameKind.HELLO, 0, 0, Uint8Array.of(0xc1)), beforeHello: true }
    ]
    const failures: string[] = []
    async function run(item: typeof cases[number]): Promise<void> {
      const backend = raw()
      if (!item.beforeHello) await backend.hello()
      const started = Date.now()
      backend.write(item.bytes)
      try {
        const goAway = body(await backend.next(FrameKind.GOAWAY))
        const code = await backend.exit
        // Before HELLO the measured time includes the runtime's own startup.
        const limit = item.beforeHello ? 10_000 : 2000
        if (goAway.code !== 'PROTOCOL_ERROR' || code !== 64 || Date.now() - started > limit) failures.push(`${item.name}: ${String(goAway.code)}, exit ${code}, ${Date.now() - started} ms`)
      } catch (error) { failures.push(`${item.name}: ${error instanceof Error ? error.message : 'failed'}`) }
    }
    for (let index = 0; index < cases.length; index += 4) await Promise.all(cases.slice(index, index + 4).map(run))
    expect(failures).toEqual([])
  }, 120_000)
  it('answers 2,000 random requests with errors and stays up', async () => {
    const seed = fuzzSeed()
    const random = mulberry32(seed)
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]
    const value = (depth: number): unknown => {
      const choice = Math.floor(random() * (depth > 2 ? 5 : 7))
      if (choice === 0) return null
      if (choice === 1) return random() < 0.5
      if (choice === 2) return Math.floor(random() * 2 ** 40) - 2 ** 39
      if (choice === 3) return random() * 1e6
      if (choice === 4) return 'v'.repeat(Math.floor(random() * 40))
      if (choice === 5) return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1))
      return Object.fromEntries(Array.from({ length: Math.floor(random() * 4) }, (_, index) => ['k' + index, value(depth + 1)]))
    }
    // Every params map has a member no record declares, so nothing reaches a server or the network.
    const methods = [...backendMethods.filter(method => method !== 'system.health'), 'unknown.method', 'debug.results.synthesize', 'system.health.extra']
    const backend = raw()
    await backend.hello()
    const total = 2000
    const chunks: Uint8Array[] = []
    for (let id = 1; id <= total; id++) chunks.push(requestFrame(id, { method: pick(methods), params: { ['unexpected' + Math.floor(random() * 1000)]: value(0), ...(random() < 0.5 ? { connectionId: value(0) } : {}) } }))
    backend.write(Buffer.concat(chunks))
    const seen = new Map<number, number>()
    while (seen.size < total) {
      const frame = await backend.next(FrameKind.RESPONSE, 60_000)
      seen.set(frame.id, (seen.get(frame.id) ?? 0) + 1)
      expect(body(frame), `seed ${seed}, id ${frame.id}`).toHaveProperty('error')
    }
    expect([...seen.values()].every(count => count === 1)).toBe(true)
    backend.request(total + 1, { method: 'system.health', params: {} })
    expect(body(await backend.next(FrameKind.RESPONSE))).toMatchObject({ result: { protocolVersion: 2 } })
  }, 120_000)
  it('writes nothing but frames to stdout and exits 0 when stdin ends', async () => {
    const backend = raw()
    await backend.hello()
    backend.request(1, { method: 'system.health', params: {} })
    backend.request(2, { method: 'unknown.method', params: {} })
    backend.request(3, { method: 'databases.list', params: { connectionId: crypto.randomUUID() } })
    backend.write(encodeFrame(FrameKind.PING, 0, 42))
    for (let index = 0; index < 3; index++) await backend.next(FrameKind.RESPONSE)
    expect((await backend.next(FrameKind.PONG)).arg).toBe(42)
    backend.child.stdin.end()
    expect(await backend.exit).toBe(0)
    const parser = new FrameParser({ maxBody: 16 * 1024 * 1024, direction: 'toMain' })
    const kinds = backend.output.flatMap(chunk => parser.push(chunk)).map(frame => frame.kind)
    expect(() => parser.end()).not.toThrow()
    expect(kinds.filter(kind => kind === FrameKind.RESPONSE)).toHaveLength(3)
    expect(kinds[0]).toBe(FrameKind.HELLO)
  })
  it('keeps running when main stops reading stdout, and exits 0 only when stdin ends', async () => {
    // .NET's console stdout swallows broken-pipe errors, so stdin EOF is the backend's only signal that main is gone.
    const backend = raw()
    await backend.hello()
    backend.child.stdout.destroy()
    for (let index = 0; index < 10; index++) {
      backend.write(encodeFrame(FrameKind.PING, 0, index))
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(backend.child.exitCode).toBeNull()
    backend.child.stdin.end()
    expect(await backend.exit).toBe(0)
  })
  it('surfaces backend error codes on BackendError', async () => {
    const error = await call(backend(), 'tables.script', { connectionId: crypto.randomUUID(), database: 'master', schema: 'dbo', name: 'Orders' }).catch(value => value)
    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject({ code: 'NOT_CONNECTED' })
  })
})

describe('real .NET sidecar results (test hooks)', () => {
  const hooks = { VARIA_BACKEND_TEST_HOOKS: '1' }
  const w1 = ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'].map(wire => ({ wire: wire as 'text' }))
  /** Reads a result as the worker would: credit back after each page, checking the backend never runs ahead of it. */
  async function readAll(connection: BackendConnection, resultId: number, credit: number) {
    const pages: { seq: number; firstRow: number; rows: number; first: string }[] = []
    let granted = credit, received = 0, worstOverdraft = 0
    const sent = connection.send('results.read', { resultId, firstRow: 0, maxRows: 65_536 }, { ...deadlineFor('results.read', { resultId, firstRow: 0, maxRows: 65_536 }), credit, stream: {
      data: (seq, body) => {
        received += body.byteLength
        worstOverdraft = Math.max(worstOverdraft, received - granted - body.byteLength)
        const view = decodePage(body, w1)
        pages.push({ seq, firstRow: view.firstRow, rows: view.rowCount, first: cellText(view, 0, 0).text })
        granted += body.byteLength
        connection.credit(sent.id, body.byteLength)
      }
    } })
    const result = await sent.done
    return { pages, result, worstOverdraft }
  }

  it('stores synthetic rows and streams their pages in order, within credit', async () => {
    const connection = backend(hooks)
    expect((await connection.ready).methods).toContain('debug.results.synthesize')
    const stored = await call(connection, 'debug.results.synthesize', { shape: 'W1', rows: 20_000 }) as ResultDescriptor
    expect(stored).toMatchObject({ resultId: 1, rowsRead: 20_000, rowsStored: 20_000, rowsAvailable: 20_000, state: 'complete', kind: 'rows', incomplete: false })
    expect(stored.truncated).toBeUndefined()
    const { pages, result, worstOverdraft } = await readAll(connection, stored.resultId, 64 * 1024)
    expect(pages.map(page => page.seq)).toEqual(pages.map((_, index) => index + 1))
    expect(pages.every((page, index) => page.firstRow === (index === 0 ? 0 : pages[index - 1].firstRow + pages[index - 1].rows) && page.first === String(page.firstRow))).toBe(true)
    expect(pages.reduce((sum, page) => sum + page.rows, 0)).toBe(20_000)
    expect(worstOverdraft).toBeLessThanOrEqual(0)
    expect(result).toEqual({ nextRow: 20_000, rowsAvailable: 20_000, complete: true, pages: pages.length, rows: 20_000 })
    expect(await call(connection, 'results.close', { resultIds: [stored.resultId] })).toEqual({ closed: 1, usedBytes: 0 })
    await expect(call(connection, 'results.read', { resultId: stored.resultId, firstRow: 0, maxRows: 10 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const released = connection.send('results.read', { resultId: stored.resultId, firstRow: 0, maxRows: 10 }, { deadlineMs: 60_000, credit: 65_536, stream: { data: () => {} } })
    await expect(released.done).rejects.toMatchObject({ code: 'RESULT_RELEASED' })
  }, 60_000)

  it('cancels a stream that is waiting for credit', async () => {
    const connection = backend(hooks)
    const stored = await call(connection, 'debug.results.synthesize', { shape: 'B1', rows: 2000 }) as ResultDescriptor
    let pages = 0
    const sent = connection.send('results.read', { resultId: stored.resultId, firstRow: 0, maxRows: 2000 }, { deadlineMs: 60_000, credit: 64 * 1024, stream: { data: () => { pages++ } } })
    await new Promise(resolve => setTimeout(resolve, 300))
    connection.cancel(sent.id, 1)
    await expect(sent.done).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(pages).toBe(1)
    await expect(call(connection, 'system.health', {})).resolves.toMatchObject({ protocolVersion: 2 })
  }, 60_000)

  it('truncates at the result budget (VARIA_RESULT_BUDGET_BYTES) and frees it on close', async () => {
    const connection = backend({ ...hooks, VARIA_RESULT_BUDGET_BYTES: String(4 * 1024 * 1024) })
    expect((await connection.ready).resultBudget).toEqual({ globalBytes: 4 * 1024 * 1024, queryBytes: 2 * 1024 * 1024 })
    const results: ResultDescriptor[] = []
    for (let index = 0; index < 3; index++) results.push(await call(connection, 'debug.results.synthesize', { shape: 'W1', rows: 50_000 }) as ResultDescriptor)
    expect(results.map(result => result.truncated)).toEqual(['queryBudget', 'queryBudget', 'globalBudget'])
    expect(results.every(result => result.rowsRead === 50_000 && result.rowsStored < 50_000 && result.rowsAvailable === result.rowsStored)).toBe(true)
    expect(await call(connection, 'results.close', { resultIds: results.map(result => result.resultId) })).toEqual({ closed: 3, usedBytes: 0 })
  }, 60_000)

  it.runIf(process.platform === 'linux')('returns the memory of closed results to the operating system', async () => {
    const connection = backend({ ...hooks, VARIA_RESULT_BUDGET_BYTES: String(1024 * 1024 * 1024) })
    await connection.ready
    const rss = () => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${connection.pid}/status`, 'utf8'))?.[1] ?? 0) * 1024
    const stored = await call(connection, 'debug.results.synthesize', { shape: 'W1', rows: 1_000_000 }) as ResultDescriptor
    const peak = rss()
    expect(await call(connection, 'results.close', { resultIds: [stored.resultId] })).toEqual({ closed: 1, usedBytes: 0 })
    let after = rss()
    for (let waited = 0; waited < 5000 && peak - after < stored.bytesStored / 2; waited += 100) {
      await new Promise(resolve => setTimeout(resolve, 100))
      after = rss()
    }
    expect(peak - after, `RSS ${peak >> 20} MiB with ${stored.bytesStored >> 20} MiB stored, ${after >> 20} MiB after closing`).toBeGreaterThan(stored.bytesStored / 2)
  }, 60_000)

  it('answers PING while every metadata slot runs a synthetic result', async () => {
    // Every request stores its rows, so each keeps a thread-pool thread busy (8 at a time, on the metadata slots).
    const backend = raw({ ...hooks, VARIA_RESULT_BUDGET_BYTES: String(1024 * 1024 * 1024) })
    await backend.hello()
    for (let id = 1; id <= 64; id++) backend.request(id, { method: 'debug.results.synthesize', params: { shape: 'W1', rows: 25_000 } })
    await new Promise(resolve => setTimeout(resolve, 100))
    const started = Date.now()
    backend.write(encodeFrame(FrameKind.PING, 0, 77))
    expect((await backend.next(FrameKind.PONG, 5000)).arg).toBe(77)
    const elapsed = Date.now() - started
    const answered = backend.frames.filter(frame => frame.kind === FrameKind.RESPONSE).length
    expect(elapsed, `PONG after ${elapsed} ms with ${answered} of 64 answered`).toBeLessThan(1000)
    expect(answered).toBeLessThan(64)
  }, 60_000)
})
