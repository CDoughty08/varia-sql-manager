import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { spawn } from 'node:child_process'
import { BackendConnection, type ConnectionDeps, type Loss } from '../src/main/backend/connection'
import { BackendError, sentences } from '../src/main/backend/errors'
import { FrameKind, FrameParser, encodeFrame, type Frame } from '../src/shared/ipc/wire/frames'
import { decodeControl, encodeControl, encodeSensitiveControl } from '../src/shared/ipc/wire/msgpack'
import { backendMethods } from '../src/shared/ipc/methods'

const connections: BackendConnection[] = []
function fake(mode: string, deps: ConnectionDeps = {}, argument?: string): BackendConnection {
  const args = ['--disable-warning=ExperimentalWarning', resolve('tests/fixtures/backend.mjs'), mode, ...(argument === undefined ? [] : [argument])]
  const connection = new BackendConnection({ command: process.execPath, args, cwd: process.cwd(), packaged: false }, 1, deps)
  connections.push(connection)
  return connection
}
afterEach(async () => { await Promise.all(connections.splice(0).map(connection => connection.close(500))) })

const health = (connection: BackendConnection, deadlineMs = 10_000, backstopMs?: number) => connection.send('system.health', {}, { deadlineMs, backstopMs }).done as Promise<{ pid: number; deadline: number; cancels: { id: number; reason: number }[] }>
const lossOf = (connection: BackendConnection) => new Promise<Loss>(done => connection.onLoss(done))
async function failure(promise: Promise<unknown>): Promise<BackendError> {
  try { await promise } catch (error) { if (error instanceof BackendError) return error; throw error }
  throw new Error('The request succeeded.')
}
const exited = (pid: number) => { try { process.kill(pid, 0); return false } catch { return true } }
const query = (sql: string) => ({ connectionId: crypto.randomUUID(), sessionId: crypto.randomUUID(), database: 'master', sql, queryId: crypto.randomUUID(), maxRows: 1000, timeoutSeconds: 0 })

describe('BackendConnection handshake', () => {
  it('completes HELLO, then correlates concurrent requests and passes the header deadline', async () => {
    const connection = fake('echo')
    const pending = Array.from({ length: 4 }, (_, index) => health(connection, 1000 + index))
    const hello = await connection.ready
    expect(hello).toMatchObject({ version: 2, generation: 1, pid: connection.pid })
    expect(hello.methods).toEqual(expect.arrayContaining([...backendMethods]))
    expect((await Promise.all(pending)).map(value => value.deadline)).toEqual([1000, 1001, 1002, 1003])
  })
  it('detects a protocol 1 backend from the JSON line it answers the magic with', async () => {
    const connection = fake('v1')
    const pending = health(connection)
    expect(await lossOf(connection)).toMatchObject({ reason: 'incompatible', detail: 'protocol 1, expected 2' })
    await expect(connection.ready).rejects.toMatchObject({ reason: 'incompatible' })
    expect(await failure(pending)).toMatchObject({ code: 'BACKEND_LOST' })
  })
  it('refuses a backend speaking another protocol version', async () => {
    expect(await lossOf(fake('wrong-version'))).toMatchObject({ reason: 'incompatible', detail: 'protocol 3, expected 2' })
  })
  it('refuses a stale build that lacks a method main may call', async () => {
    expect(await lossOf(fake('missing-method'))).toMatchObject({ reason: 'incompatible', detail: 'protocol 2, expected 2; missing: tables.script' })
  })
  it('gives up on a backend that never says HELLO, and kills it', async () => {
    const connection = fake('no-hello', { limits: { helloMs: 300 } })
    expect(await lossOf(connection)).toMatchObject({ reason: 'helloTimeout' })
    await expect.poll(() => exited(connection.pid!)).toBe(true)
  })
  it('reports a missing executable as a spawn failure', async () => {
    const connection = new BackendConnection({ command: 'varia-command-that-does-not-exist', args: [], cwd: process.cwd(), packaged: false }, 1)
    connections.push(connection)
    expect(await lossOf(connection)).toMatchObject({ reason: 'spawn', detail: 'ENOENT' })
  })
})

describe('BackendConnection malformed input', () => {
  it('treats broken framing as fatal and fails every pending request', async () => {
    const connection = fake('bad-magic')
    const loss = lossOf(connection)
    expect(await failure(health(connection))).toMatchObject({ code: 'BACKEND_LOST', message: sentences.lost })
    expect(await loss).toMatchObject({ reason: 'protocol', detail: expect.stringMatching(/^BAD_MAGIC at \d+$/) })
    await expect.poll(() => exited(connection.pid!)).toBe(true)
  })
  it('treats a frame for an id it never issued as fatal', async () => {
    const connection = fake('unknown-id')
    void health(connection).catch(() => {})
    expect(await lossOf(connection)).toMatchObject({ reason: 'protocol', detail: 'RESPONSE for unissued id 1001' })
  })
  it('treats output that ends inside a frame as fatal', async () => {
    const connection = fake('truncated')
    void health(connection).catch(() => {})
    expect(await lossOf(connection)).toMatchObject({ reason: 'protocol', detail: expect.stringMatching(/^TRUNCATED at \d+$/) })
  })
  it('skips an oversized body, fails only that request, and stays in sync', async () => {
    const connection = fake('oversize')
    expect(await failure(health(connection))).toMatchObject({ code: 'STREAM_PROTOCOL', message: sentences.invalid })
    expect((await health(connection)).pid).toBe(connection.pid)
    expect(connection.lost).toBeUndefined()
  })
  it('contains malformed responses until the eighth, which is fatal', async () => {
    const connection = fake('contained')
    for (let index = 0; index < 7; index++) expect(await failure(health(connection))).toMatchObject({ code: 'STREAM_PROTOCOL' })
    expect(connection.lost).toBeUndefined()
    const loss = lossOf(connection)
    expect(await failure(health(connection))).toMatchObject({ code: 'STREAM_PROTOCOL' })
    expect(await loss).toMatchObject({ reason: 'protocol', detail: '8 contained violations' })
  })
  it('passes query events to their request and contains an undecodable one', async () => {
    const connection = fake('events')
    const events: unknown[] = []
    const { done } = connection.send('query.execute', query('SELECT 1'), { deadlineMs: 0, onEvent: event => events.push(event) })
    expect(await failure(done)).toMatchObject({ code: 'STREAM_PROTOCOL' })
    expect(events).toEqual([{ type: 'messages', messages: ['first'] }])
  })
})

describe('BackendConnection lifetime', () => {
  it('fails pending requests when the backend exits, with the never-re-run sentence for scripts', async () => {
    const connection = fake('exit')
    await connection.ready
    const loss = lossOf(connection)
    const script = connection.send('query.execute', query('SELECT 1'), { deadlineMs: 0 }).done
    expect(await failure(script)).toMatchObject({ code: 'BACKEND_LOST', message: sentences.lostQuery })
    expect(await loss).toMatchObject({ reason: 'exit', exitCode: 1 })
    expect(await failure(health(connection))).toMatchObject({ code: 'BACKEND_LOST' })
  })
  it('reports a backend crash from its GOAWAY', async () => {
    const connection = fake('crash-after', {}, '1')
    await health(connection)
    const loss = lossOf(connection)
    expect(await failure(health(connection))).toMatchObject({ code: 'BACKEND_LOST' })
    expect(await loss).toMatchObject({ reason: 'crash', detail: 'GOAWAY BACKEND_CRASH' })
  })
  it('cancels a request at its backstop and drops the late answer', async () => {
    const connection = fake('late', {}, '1500')
    expect(await failure(health(connection, 0, 1000))).toMatchObject({ code: 'TIMEOUT', message: sentences.timeout(1) })
    await expect.poll(() => connection.lateFrames, { timeout: 5000 }).toBe(1)
    expect((await health(connection)).cancels).toEqual([{ id: 1, reason: 2 }])
    expect(connection.lost).toBeUndefined()
  })
  it('pings, so only a silent backend accumulates silence', async () => {
    const quiet = fake('echo', { limits: { pingMs: 50 } })
    const stuck = fake('unresponsive', { limits: { pingMs: 50 } })
    await Promise.all([quiet.ready, stuck.ready])
    await new Promise(done => setTimeout(done, 600))
    expect(quiet.silentMs).toBeLessThan(400)
    expect(stuck.silentMs).toBeGreaterThanOrEqual(550)
  })
  it('closes gracefully: pending requests fail with the given error and the process ends', async () => {
    const connection = fake('silent')
    await connection.ready
    const pending = failure(health(connection))
    await connection.close(2000, new BackendError('BACKEND_LOST', sentences.reloaded))
    expect(await pending).toMatchObject({ code: 'BACKEND_LOST', message: sentences.reloaded })
    expect(exited(connection.pid!)).toBe(true)
  })
})

describe('BackendConnection limits', () => {
  it('caps pending requests at 256, keeping 32 more for control methods', async () => {
    const connection = fake('silent')
    await connection.ready
    const outstanding = Array.from({ length: 256 }, () => connection.send('databases.list', { connectionId: crypto.randomUUID() }, { deadlineMs: 0 }).done.catch(() => {}))
    expect(await failure(connection.send('databases.list', { connectionId: crypto.randomUUID() }, { deadlineMs: 0 }).done)).toMatchObject({ code: 'TOO_MANY_REQUESTS', message: sentences.tooMany })
    const control = Array.from({ length: 32 }, () => connection.send('query.cancel', { queryId: crypto.randomUUID() }, { deadlineMs: 0 }).done.catch(() => {}))
    expect(connection.pendingCount).toBe(288)
    expect(await failure(connection.send('query.cancel', { queryId: crypto.randomUUID() }, { deadlineMs: 0 }).done)).toMatchObject({ code: 'TOO_MANY_REQUESTS' })
    await connection.close(500)
    await Promise.all([...outstanding, ...control])
  })
  it('refuses a body over 4 MiB before writing it; every 1,000,000-character script fits', async () => {
    const connection = fake('silent')
    for (const sql of ['"'.repeat(1_000_000), '€'.repeat(1_000_000), '😀'.repeat(500_000)]) void connection.send('query.execute', query(sql), { deadlineMs: 0 }).done.catch(() => {})
    expect(connection.pendingCount).toBe(3)
    expect(await failure(connection.send('query.execute', query('€'.repeat(1_400_000)), { deadlineMs: 0 }).done)).toMatchObject({ code: 'TOO_LARGE', message: sentences.tooLarge })
    expect(connection.pendingCount).toBe(3)
  })
  it('bounds the bytes queued for a backend that stops reading at 32 MiB', async () => {
    const connection = fake('no-read')
    await connection.ready
    let accepted = 0
    for (; accepted < 20; accepted++) {
      const { id, done } = connection.send('query.execute', query('€'.repeat(1_000_000)), { deadlineMs: 0 })
      done.catch(() => {})
      if (id === 0) { expect(await failure(done)).toMatchObject({ code: 'TOO_MANY_REQUESTS' }); break }
    }
    expect(accepted).toBeGreaterThanOrEqual(9)
    expect(accepted).toBeLessThanOrEqual(12)
  })
})

describe('BackendConnection streams', () => {
  it('delivers DATA in sequence, within credit plus one frame, and settles with the RESPONSE', async () => {
    const connection = fake('echo')
    const pages: { seq: number; body: ArrayBuffer }[] = []
    const { id, done } = connection.send('system.health', { pages: 4, bytes: 40 * 1024 } as never, { deadlineMs: 0, credit: 64 * 1024, stream: { data: (seq, body) => pages.push({ seq, body }) } })
    await expect.poll(() => pages.length).toBe(2)
    await new Promise(settle => setTimeout(settle, 100))
    expect(pages).toHaveLength(2)
    connection.credit(id, 64 * 1024)
    expect(await done).toEqual({ pages: 4 })
    expect(pages.map(page => page.seq)).toEqual([1, 2, 3, 4])
    expect(pages.every(page => page.body.byteLength === 40 * 1024 && new Uint8Array(page.body)[0] === page.seq)).toBe(true)
  })
  it('fails a stream with a sequence gap and cancels it with reason 3', async () => {
    const connection = fake('seq-gap')
    const { done } = connection.send('system.health', {} as never, { deadlineMs: 0, credit: 1024 * 1024, stream: { data: () => {} } })
    expect(await failure(done)).toMatchObject({ code: 'STREAM_PROTOCOL' })
    expect((await health(connection)).cancels).toEqual([{ id: 1, reason: 3 }])
  })
  it('fails a stream that overruns its credit', async () => {
    const connection = fake('credit-overrun')
    const { done } = connection.send('system.health', { bytes: 40 * 1024 } as never, { deadlineMs: 0, credit: 64 * 1024, stream: { data: () => {} } })
    expect(await failure(done)).toMatchObject({ code: 'STREAM_PROTOCOL' })
  })
})

describe('BackendConnection secrets', () => {
  it('encodes a sensitive body exactly like any other control body', () => {
    const value = { method: 'connections.connect', params: { server: 'localhost', password: 'p'.repeat(5000) + '€😀' } }
    expect(encodeSensitiveControl(value)).toEqual(encodeControl(value))
  })
  it('zeroes a request frame that carries a password once it is written', async () => {
    const writes: { chunk: Uint8Array; copy: Uint8Array }[] = []
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      pid: 4242, exitCode: null, signalCode: null, kill: () => true, stdout, stderr: new PassThrough(),
      stdin: new Writable({
        write(chunk: Buffer, _encoding, callback) { writes.push({ chunk, copy: Uint8Array.from(chunk) }); setImmediate(callback) },
        final(callback) { callback(); setImmediate(() => child.emit('close', 0, null)) }
      })
    })
    queueMicrotask(() => child.emit('spawn'))
    const connection = new BackendConnection({ command: 'unused', args: [], cwd: '.', packaged: false }, 1, { spawn: (() => child) as unknown as typeof spawn })
    connections.push(connection)
    const request = connection.send('connections.connect', { server: 'localhost', database: '', authentication: 'sql', username: 'sa', password: 'private-marker', trustServerCertificate: true }, { deadlineMs: 0 })
    request.done.catch(() => {})
    const hello = new FrameParser({ maxBody: 1 << 20, direction: 'toBackend' }).push(writes[0].copy)[0] as Frame
    const generation = (decodeControl(hello.body) as { generation: number }).generation
    stdout.write(encodeFrame(FrameKind.HELLO, 0, 0, encodeControl({ version: 2, generation, pid: 4242, runtime: 'fake', platform: 'fake', sqlClientVersion: '0', maxFrameBytes: 4 << 20, methods: [...backendMethods] })))
    await connection.ready
    await expect.poll(() => writes.length).toBe(2)
    const marker = Buffer.from('private-marker')
    const contains = (bytes: Uint8Array) => Buffer.from(bytes).includes(marker)
    expect(contains(writes[1].copy)).toBe(true)
    await expect.poll(() => writes[1].chunk.every(byte => byte === 0)).toBe(true)
    expect(contains(writes[1].chunk)).toBe(false)
  })
})
