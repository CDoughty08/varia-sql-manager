// A fake backend that speaks protocol v2 through the real wire code (Node 24 type stripping), so tests exercise main's
// real pipeline against misbehaviour the .NET backend never produces. Usage: node backend.mjs <mode> [argument].
// Mode `workbench` answers every method well enough for the Electron smoke tests (main selects it with
// VARIA_TEST_BACKEND). Its control directory, VARIA_TEST_BACKEND_DIR, holds:
//   calls.jsonl         one { generation, method, params } line per request, passwords redacted
//   hold/<method>       the method waits while this file exists
//   crash-next          the next query.execute crashes the backend (GOAWAY BACKEND_CRASH, exit 70); the file is removed
//   silent-<generation> that generation stops answering PING, as a hung backend would
import { appendFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { FrameKind, FrameParser, encodeFrame } from '../../src/shared/ipc/wire/frames.ts'
import { decodeControl, encodeControl } from '../../src/shared/ipc/wire/msgpack.ts'
import { backendMethods } from '../../src/shared/ipc/methods.ts'

const [mode = 'echo', argument] = process.argv.slice(2)
const parser = new FrameParser({ maxBody: 4 * 1024 * 1024, direction: 'toBackend' })
const cancels = []
const streams = new Map()
const controlDirectory = process.env.VARIA_TEST_BACKEND_DIR
let answered = 0
let generation = 0

const write = (kind, id, arg, value) => process.stdout.write(encodeFrame(kind, id, arg, value === undefined ? undefined : encodeControl(value)))
const respond = (id, result) => write(FrameKind.RESPONSE, id, 0, { result })
const fail = (id, code, message) => write(FrameKind.RESPONSE, id, 0, { error: { code, message } })
// Exit only once the bytes are written: pipe writes are asynchronous on Windows.
const exitAfter = (bytes, code) => process.stdout.write(bytes, () => process.exit(code))

if (mode === 'v1') {
  // A protocol 1 backend reads lines: the magic's LF ends the line "V", which it answers as an invalid request.
  process.stdin.once('data', () => process.stdout.write(JSON.stringify({ id: null, error: { code: 'INVALID_REQUEST', message: 'Invalid JSON request or parameters.' } }) + '\n'))
} else {
  process.stdin.on('data', chunk => { for (const frame of parser.push(chunk)) handle(frame) })
}
process.stdin.on('end', () => process.exit(0))

function handle(frame) {
  if (frame.kind === FrameKind.HELLO) return hello(decodeControl(frame.body))
  if (frame.kind === FrameKind.PING) { if (mode !== 'unresponsive' && !control(`silent-${generation}`)) write(FrameKind.PONG, 0, frame.arg); return }
  if (frame.kind === FrameKind.CANCEL) {
    cancels.push({ id: frame.id, reason: frame.arg })
    if (mode === 'echo' && streams.has(frame.id)) { streams.delete(frame.id); fail(frame.id, 'CANCELLED', 'The operation was cancelled.') }
    return
  }
  if (frame.kind === FrameKind.CREDIT) { streams.get(frame.id)?.grant(frame.arg); return }
  if (frame.kind === FrameKind.REQUEST && !frame.oversize) request(frame.id, frame.arg, decodeControl(frame.body))
}

function hello(value) {
  generation = value.generation
  if (mode === 'no-hello') return
  if (mode === 'no-read') process.stdin.pause()
  const methods = mode === 'missing-method' ? backendMethods.filter(method => method !== 'tables.script') : backendMethods
  write(FrameKind.HELLO, 0, 0, { version: mode === 'wrong-version' ? 3 : 2, generation: value.generation, pid: process.pid, runtime: 'fake', platform: process.platform, sqlClientVersion: '0', maxFrameBytes: 4 * 1024 * 1024, methods })
}

function request(id, deadline, { method, params, credit }) {
  answered++
  switch (mode) {
    case 'workbench': workbench(id, method, params).catch(() => fail(id, 'BACKEND_ERROR', 'The fake backend failed.')); return
    case 'silent': case 'unresponsive': case 'no-read': return
    case 'exit': process.exit(1); return
    case 'crash-after':
      if (answered > Number(argument ?? 0)) return exitAfter(encodeFrame(FrameKind.GOAWAY, 0, 0, encodeControl({ code: 'BACKEND_CRASH', message: 'The SQL backend failed unexpectedly (Exception).' })), 70)
      break
    case 'bad-magic': process.stdout.write(Uint8Array.of(0x00, 0x01, 0x02)); return
    case 'truncated': return exitAfter(encodeFrame(FrameKind.RESPONSE, id, 0, encodeControl({ result: 1 })).subarray(0, 10), 0)
    case 'unknown-id': return respond(id + 1000, {})
    case 'contained': process.stdout.write(encodeFrame(FrameKind.RESPONSE, id, 0, Uint8Array.of(0xc1))); return
    case 'oversize':
      if (answered === 1) {
        // A RESPONSE header announcing more than main accepts, followed by that many bytes.
        const header = encodeFrame(FrameKind.RESPONSE, id, 0, Uint8Array.of(0))
        new DataView(header.buffer).setUint32(4, 16 * 1024 * 1024 + 1, true)
        process.stdout.write(header.subarray(0, 16))
        process.stdout.write(new Uint8Array(16 * 1024 * 1024 + 1))
        return
      }
      break
    // Only the first answer is late, so a later request can report the CANCEL frames seen.
    case 'late':
      if (answered === 1) { setTimeout(() => respond(id, { late: true }), Number(argument ?? 300)); return }
      break
    case 'events':
      write(FrameKind.EVENT, id, 0, { type: 'messages', messages: ['first'] })
      process.stdout.write(encodeFrame(FrameKind.EVENT, id, 0, Uint8Array.of(0xc1)))
      return
  }
  if (credit !== undefined) return stream(id, credit, params)
  if (method === 'system.health') return respond(id, { protocolVersion: 2, pid: process.pid, cancels, deadline })
  if (method === 'query.cancel') return respond(id, { cancelled: false })
  respond(id, { method, params })
}

// A stream request: `pages` DATA bodies of `bytes` each, sent while credit is positive, then the terminal RESPONSE.
function stream(id, credit, { pages = 4, bytes = 40 * 1024 } = {}) {
  if (mode === 'seq-gap') {
    process.stdout.write(encodeFrame(FrameKind.DATA, id, 1, new Uint8Array(bytes)))
    process.stdout.write(encodeFrame(FrameKind.DATA, id, 3, new Uint8Array(bytes)))
    return
  }
  if (mode === 'credit-overrun') {
    for (let seq = 1; seq * bytes <= credit + 2 * bytes; seq++) process.stdout.write(encodeFrame(FrameKind.DATA, id, seq, new Uint8Array(bytes)))
    return
  }
  let available = credit
  let sent = 0
  const pump = () => {
    while (available > 0 && sent < pages) {
      available -= bytes
      sent++
      process.stdout.write(encodeFrame(FrameKind.DATA, id, sent, new Uint8Array(bytes).fill(sent)))
    }
    if (sent === pages && streams.delete(id)) respond(id, { pages: sent })
  }
  streams.set(id, { grant: more => { available += more; pump() } })
  pump()
}

/** Whether a control file exists; `consume` also removes it. */
function control(name, consume = false) {
  if (!controlDirectory) return false
  const path = join(controlDirectory, name)
  if (!existsSync(path)) return false
  if (consume) rmSync(path, { force: true })
  return true
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const workbenchConnections = new Map()
const waitingScripts = new Map()
const workbenchDatabases = [{ name: 'master', isSystem: true, isSnapshot: false }, { name: 'tempdb', isSystem: true, isSnapshot: false }, { name: 'AppData', isSystem: false, isSnapshot: false }]
const summary = (database, resultSets, status = 'completed') => ({ resultSets, messages: [], recordsAffected: -1, elapsedMs: 1, status, completedBatches: 1, totalBatches: 1, database, messagesTruncated: false })

async function workbench(id, method, params) {
  if (controlDirectory) appendFileSync(join(controlDirectory, 'calls.jsonl'), JSON.stringify({ generation, method, params: params?.password === undefined ? params : { ...params, password: '<redacted>' } }) + '\n')
  while (control(join('hold', method))) await sleep(25)
  switch (method) {
    case 'system.health': return respond(id, { protocolVersion: 2, runtime: 'fake', platform: process.platform, smoVersion: 'fake', sqlClientVersion: 'fake' })
    case 'connections.connect': {
      const info = { id: crypto.randomUUID(), server: params.server, database: params.database || 'master', serverVersion: '16.0.fake', commandTimeout: params.advanced?.commandTimeout ?? 30 }
      workbenchConnections.set(info.id, info)
      return respond(id, info)
    }
    case 'connections.databases': return respond(id, workbenchDatabases)
    case 'connections.discover': return respond(id, { servers: [] })
    case 'connections.preview': return respond(id, { connectionString: 'Data Source=' + params.server })
    case 'connections.disconnect': return respond(id, { disconnected: workbenchConnections.delete(params.connectionId) })
    case 'query.session.close': return respond(id, { closed: true })
    case 'query.cancel': {
      const script = waitingScripts.get(params.queryId)
      waitingScripts.delete(params.queryId)
      if (script) respond(script.id, summary(script.database, [], 'cancelled'))
      return respond(id, { cancelled: !!script })
    }
  }
  const connection = workbenchConnections.get(params.connectionId)
  if (!connection) return fail(id, 'NOT_CONNECTED', 'Connect to a SQL Server first.')
  switch (method) {
    case 'databases.list': return respond(id, workbenchDatabases)
    case 'server.objects.list': return respond(id, [])
    case 'tables.list': return respond(id, [{ schema: 'dbo', name: 'Orders' }])
    case 'tables.script': return respond(id, { sql: 'CREATE TABLE dbo.Orders (Id int);' })
    case 'query.execute':
      // As the real backend's crash handler does: a best-effort GOAWAY, then exit 70.
      if (control('crash-next', true)) return exitAfter(encodeFrame(FrameKind.GOAWAY, 0, 0, encodeControl({ code: 'BACKEND_CRASH', message: 'The SQL backend failed unexpectedly (Exception).' })), 70)
      if (params.sql.includes('WAIT_FOR_CANCEL')) { waitingScripts.set(params.queryId, { id, database: params.database }); return }
      return respond(id, summary(params.database, [{ columns: [{ name: 'server', dataType: 'nvarchar' }, { name: 'generation', dataType: 'int' }], rows: [[connection.server, generation]], truncated: false }]))
  }
  return fail(id, 'METHOD_NOT_FOUND', 'The fake backend does not know ' + method + '.')
}
