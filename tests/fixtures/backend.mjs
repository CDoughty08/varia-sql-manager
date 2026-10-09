// A fake backend that speaks protocol v2 through the real wire code (Node 24 type stripping), so tests exercise main's
// real pipeline against misbehaviour the .NET backend never produces. Usage: node backend.mjs <mode> [argument].
// Mode `workbench` answers every method well enough for the Electron smoke tests (main selects it with
// VARIA_TEST_BACKEND): scripts return the fixtures below as stored results, which results.read serves as real pages
// (encodePage) within the stream's credit. Its control directory, VARIA_TEST_BACKEND_DIR, holds:
//   calls.jsonl         one { generation, method, params } line per request, passwords redacted
//   hold/<method>       the method waits while this file exists
//   allow/audits        server.objects.list may list audits (otherwise it fails as a permission error would)
//   crash-next          the next query.execute crashes the backend (GOAWAY BACKEND_CRASH, exit 70); the file is removed
//   silent-<generation> that generation stops answering PING, as a hung backend would
//   ignore-eof          stdin EOF does not end the process, as with a backend too wedged to read it
//   spawns.jsonl        one { pid } line per process started
import { appendFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { FrameKind, FrameParser, encodeFrame } from '../../src/shared/ipc/wire/frames.ts'
import { decodeControl, encodeControl } from '../../src/shared/ipc/wire/msgpack.ts'
import { encodePage } from '../../src/shared/ipc/wire/pages.ts'
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
process.stdin.on('end', () => { if (!control('ignore-eof')) process.exit(0) })
if (controlDirectory) appendFileSync(join(controlDirectory, 'spawns.jsonl'), JSON.stringify({ pid: process.pid }) + '\n')

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
    case 'workbench': workbench(id, method, params, credit).catch(() => fail(id, 'BACKEND_ERROR', 'The fake backend failed.')); return
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
      // Global events (id 0) are advisory: an undecodable one is dropped, not a violation.
      write(FrameKind.EVENT, 0, 0, { type: 'results.memory', usedBytes: 1, globalBytes: 2 })
      process.stdout.write(encodeFrame(FrameKind.EVENT, 0, 0, Uint8Array.of(0xc1)))
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
const workbenchDatabases = [
  { name: 'master', isSystem: true, isSnapshot: false }, { name: 'model', isSystem: true, isSnapshot: false }, { name: 'msdb', isSystem: true, isSnapshot: false },
  { name: 'tempdb', isSystem: true, isSnapshot: false }, { name: 'AppData', isSystem: false, isSnapshot: false }, { name: 'AppData_Snapshot', isSystem: false, isSnapshot: true }
]
const serverObjects = {
  logins: [{ name: 'sa', description: 'SQL_LOGIN' }],
  serverRoles: ['##MS_DatabaseConnector##', '##MS_LoginManager##', 'bulkadmin', 'dbcreator', 'public', 'securityadmin', 'serveradmin', 'sysadmin'].map(name => ({ name, description: 'Fixed server role' })),
  credentials: [],
  cryptographicProviders: [{ name: 'Test EKM Provider', description: 'Enabled' }],
  audits: [{ name: 'LoginAudit', description: 'FILE · Enabled' }],
  serverAuditSpecifications: [{ name: 'LoginAuditSpec', description: 'Enabled' }]
}
// Stored results of this process (one backend generation), by resultId, as the real result store keeps them.
const stored = new Map()
let nextResultId = 1
const pageRows = 64
const column = (name, dataType) => ({ name, dataType, wire: 'text', nullable: true })
const describe = result => ({
  resultId: result.resultId, index: result.index, batchNumber: result.batchNumber, iteration: result.iteration, kind: result.kind, columns: result.columns,
  rowsRead: result.rows.length, rowsStored: result.rows.length, rowsAvailable: result.rows.length, bytesStored: result.bytes, truncatedCells: 0, state: 'complete', incomplete: false
})
/** Stores result sets ({ columns, rows, batchNumber?, iteration?, kind? }) and reports them as the real backend does. */
function storeResults(id, sets) {
  return sets.map((set, index) => {
    const result = { resultId: nextResultId++, index, batchNumber: set.batchNumber ?? 1, iteration: set.iteration ?? 1, kind: set.kind ?? 'rows', columns: set.columns, rows: set.rows, pages: [], bytes: 0 }
    for (let first = 0; first < result.rows.length; first += pageRows) {
      const page = encodePage({ resultId: result.resultId, firstRow: first, columns: result.columns, rows: result.rows.slice(first, first + pageRows) })
      result.pages.push({ firstRow: first, rows: Math.min(pageRows, result.rows.length - first), body: page })
      result.bytes += page.length
    }
    stored.set(result.resultId, result)
    write(FrameKind.EVENT, id, 0, { type: 'resultSet.opened', descriptor: { ...describe(result), state: 'open' } })
    write(FrameKind.EVENT, id, 0, { type: 'resultSet.closed', descriptor: describe(result) })
    return describe(result)
  })
}
const summary = (id, database, sets, patch = {}) => ({
  resultSets: storeResults(id, sets), discardedResultSets: 0, messages: [], recordsAffected: -1, elapsedMs: 1, status: 'completed', completedBatches: 1, totalBatches: 1,
  database, messagesTruncated: false, budget: { usedBytes: 0, globalBytes: 256 * 1024 * 1024, queryBytes: 128 * 1024 * 1024 }, ...patch
})
/** results.read: the stored pages overlapping the range, while credit lasts, then the terminal RESPONSE. */
function readResults(id, credit, { resultId, firstRow, maxRows }) {
  const result = stored.get(resultId)
  if (!result) return fail(id, resultId < nextResultId ? 'RESULT_RELEASED' : 'RESULT_NOT_FOUND', 'These results do not exist.')
  const pages = result.pages.filter(page => page.firstRow < firstRow + maxRows && page.firstRow + page.rows > firstRow)
  let available = credit, sent = 0, next = firstRow, rows = 0
  const pump = () => {
    while (available > 0 && sent < pages.length) {
      const page = pages[sent++]
      available -= page.body.length
      next = page.firstRow + page.rows
      rows += page.rows
      process.stdout.write(encodeFrame(FrameKind.DATA, id, sent, page.body))
    }
    if (sent === pages.length && streams.delete(id)) respond(id, { nextRow: next, rowsAvailable: result.rows.length, complete: next >= result.rows.length, pages: sent, rows })
  }
  streams.set(id, { grant: more => { available += more; pump() } })
  pump()
}
const fixtures = {
  BATCH_STATS_FIXTURE: (id, params) => summary(id, params.database, [{ columns: [column('retained', 'int')], rows: [['42']], batchNumber: 1, iteration: 1 }], {
    messages: ['SQL Server Execution Times: CPU time = 1 ms, elapsed time = 2 ms.', "Table '#temp'. Scan count 1, logical reads 2."], elapsedMs: 3, status: 'failed',
    error: { code: 'SQL_ERROR', message: 'Msg 137, Level 15, State 2, Line 8: Must declare the scalar variable.', batchNumber: 2, iteration: 1 }, completedBatches: 1, totalBatches: 3
  }),
  XML_PLAN_FIXTURE: (id, params) => summary(id, params.database, [
    { columns: [column('answer', 'int')], rows: [['1']], batchNumber: 2 },
    { columns: [{ ...column('Microsoft SQL Server 2005 XML Showplan', 'nvarchar'), role: 'plan' }], rows: [['<ShowPlanXML><BatchSequence><Batch /></BatchSequence></ShowPlanXML>']], kind: 'executionPlan', batchNumber: 2 }
  ], { completedBatches: 3, totalBatches: 3 })
}

async function workbench(id, method, params, credit) {
  if (controlDirectory) appendFileSync(join(controlDirectory, 'calls.jsonl'), JSON.stringify({ generation, method, params: params?.password === undefined ? params : { ...params, password: '<redacted>' } }) + '\n')
  while (control(join('hold', method))) await sleep(25)
  switch (method) {
    case 'system.health': return respond(id, { protocolVersion: 2, runtime: 'fake', platform: process.platform, smoVersion: 'fake', sqlClientVersion: 'fake' })
    case 'connections.connect': {
      const info = { id: crypto.randomUUID(), server: params.server, database: params.database || 'master', serverVersion: '16.0.fake', commandTimeout: params.advanced?.commandTimeout ?? 0 }
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
      if (script) respond(script.id, summary(script.id, script.database, [], { status: 'cancelled' }))
      return respond(id, { cancelled: !!script })
    }
    case 'results.read': return credit === undefined ? fail(id, 'INVALID_REQUEST', 'Result pages are read as a stream with credit.') : readResults(id, credit, params)
    case 'results.close': {
      let closed = 0
      for (const resultId of params.resultIds) if (stored.delete(resultId)) closed++
      return respond(id, { closed, usedBytes: 0 })
    }
  }
  const connection = workbenchConnections.get(params.connectionId)
  if (!connection) return fail(id, 'NOT_CONNECTED', 'Connect to a SQL Server first.')
  switch (method) {
    case 'databases.list': return respond(id, workbenchDatabases)
    case 'server.objects.list':
      if (params.kind === 'audits' && !control(join('allow', 'audits'))) return fail(id, 'SQL_ERROR', 'Test permission denied for server audits.')
      return respond(id, serverObjects[params.kind])
    case 'tables.list': return respond(id, [{ schema: 'dbo', name: 'Orders' }])
    case 'tables.script': return respond(id, { sql: 'CREATE TABLE dbo.Orders (Id int);' })
    case 'query.execute': {
      // As the real backend's crash handler does: a best-effort GOAWAY, then exit 70.
      if (control('crash-next', true)) return exitAfter(encodeFrame(FrameKind.GOAWAY, 0, 0, encodeControl({ code: 'BACKEND_CRASH', message: 'The SQL backend failed unexpectedly (Exception).' })), 70)
      if (params.sql.includes('WAIT_FOR_CANCEL')) { waitingScripts.set(params.queryId, { id, database: params.database }); return }
      const fixture = Object.keys(fixtures).find(name => params.sql.includes(name))
      if (fixture) return respond(id, fixtures[fixture](id, params))
      return respond(id, summary(id, params.database, [{ columns: [column('server', 'nvarchar'), column('generation', 'int'), column('database', 'nvarchar')], rows: [[connection.server, String(generation), params.database]] }]))
    }
  }
  return fail(id, 'METHOD_NOT_FOUND', 'The fake backend does not know ' + method + '.')
}
