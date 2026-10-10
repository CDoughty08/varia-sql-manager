// A fake backend that speaks protocol v2 through the real wire code (Node 24 type stripping), so tests exercise main's
// real pipeline against misbehaviour the .NET backend never produces. Usage: node backend.mjs <mode> [argument].
// Mode `workbench` answers every method well enough for the Electron smoke tests (main selects it with
// VARIA_TEST_BACKEND): scripts return the fixtures below as stored results, which results.read serves as real pages
// (encodePage) within the stream's credit. Its control directory, VARIA_TEST_BACKEND_DIR, holds:
//   calls.jsonl         one { generation, method, params } line per request, passwords redacted
//   hold/<method>       the method waits while this file exists
//   allow/audits        explorer.children may list audits (otherwise they fail as a permission error would)
//   crash-next          the next query.execute crashes the backend (GOAWAY BACKEND_CRASH, exit 70); the file is removed
//   silent-<generation> that generation stops answering PING, as a hung backend would
//   ignore-eof          stdin EOF does not end the process, as with a backend too wedged to read it; only a kill does
//   ignore-eof-<generation>  the same for that generation only
//   spawns.jsonl        one { pid } line per process started
import { appendFileSync, existsSync, rmSync } from 'node:fs'
import { access, appendFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { FrameKind, FrameParser, encodeFrame } from '../../src/shared/ipc/wire/frames.ts'
import { decodeControl, encodeControl } from '../../src/shared/ipc/wire/msgpack.ts'
import { encodePage } from '../../src/shared/ipc/wire/pages.ts'
import { backendMethods } from '../../src/shared/ipc/methods.ts'
import { folderSpecs, kindSpecs, staticChildren } from '../../src/shared/explorer/catalog.ts'

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
process.stdin.on('end', () => {
  if (!control('ignore-eof') && !control(`ignore-eof-${generation}`)) process.exit(0)
  // Nothing else keeps the event loop alive once stdin has ended, and a wedged backend does not exit by itself.
  else setInterval(() => {}, 1 << 30)
})
if (controlDirectory) appendFileSync(join(controlDirectory, 'spawns.jsonl'), JSON.stringify({ pid: process.pid }) + '\n')

function handle(frame) {
  if (frame.kind === FrameKind.HELLO) return hello(decodeControl(frame.body))
  if (frame.kind === FrameKind.PING) { if (mode !== 'unresponsive' && !silent) write(FrameKind.PONG, 0, frame.arg); return }
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
  const methods = mode === 'missing-method' ? backendMethods.filter(method => method !== 'scripting.script') : backendMethods
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

/** Whether a control file exists; `consume` also removes it. Only for startup and exit: see `controlled`. */
function control(name, consume = false) {
  if (!controlDirectory) return false
  const path = join(controlDirectory, name)
  if (!existsSync(path)) return false
  if (consume) rmSync(path, { force: true })
  return true
}
/**
 * `control` for the frame loop. A synchronous check there would hold every frame behind a slow disk, PONGs included
 * (opening a file takes seconds at times on Windows runners), and main would count the backend as hung.
 */
async function controlled(name, consume = false) {
  if (!controlDirectory) return false
  const path = join(controlDirectory, name)
  try { await access(path) } catch { return false }
  if (consume) await rm(path, { force: true })
  return true
}
// PING is answered from memory; silent-<generation> is looked for every 50 ms.
let silent = false
if (controlDirectory) {
  const look = () => { void controlled(`silent-${generation}`).then(value => { silent = value }, () => {}).finally(() => setTimeout(look, 50).unref()) }
  look()
}
// calls.jsonl lines are written in request order, each before its request is handled.
let logged = Promise.resolve()

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const workbenchConnections = new Map()
const waitingScripts = new Map()
const workbenchDatabases = [
  { name: 'master', isSystem: true, isSnapshot: false }, { name: 'model', isSystem: true, isSnapshot: false }, { name: 'msdb', isSystem: true, isSnapshot: false },
  { name: 'tempdb', isSystem: true, isSnapshot: false }, { name: 'AppData', isSystem: false, isSnapshot: false }, { name: 'AppData_Snapshot', isSystem: false, isSnapshot: true }
]
const serverRoles = ['##MS_DatabaseConnector##', '##MS_LoginManager##', 'bulkadmin', 'dbcreator', 'public', 'securityadmin', 'serveradmin', 'sysadmin']
// Object Explorer's fixture tree (explorer.children), on a SQL Server 2022 box: the catalogue's static folders, and
// these rows in the folders that list them. Every database has dbo.Orders; Audits fails until allow/audits exists.
const explorerProfile = { band: 16, engine: 'box' }
const explorerRows = {
  systemDatabases: () => ['master', 'model', 'msdb', 'tempdb'].map(name => explorerObject({ kind: 'database', name }, name, { subtype: 'system', hasChildren: true })),
  databaseSnapshots: () => [explorerObject({ kind: 'database', name: 'AppData_Snapshot' }, 'AppData_Snapshot', { subtype: 'snapshot', icon: 'device-camera', hasChildren: true })],
  databases: () => [explorerObject({ kind: 'database', name: 'AppData' }, 'AppData', { hasChildren: true })],
  tables: owner => [explorerObject({ kind: 'table', database: owner.name, schema: 'dbo', name: 'Orders' }, 'dbo.Orders', { hasChildren: true, created: '2024-05-01T09:30:00' })],
  columns: owner => [
    explorerObject({ kind: 'column', database: owner.database, parent: { kind: owner.kind, schema: owner.schema, name: owner.name }, name: 'Id' }, 'Id', { sublabel: '(PK, int, not null)', icon: 'svg:key' }),
    explorerObject({ kind: 'column', database: owner.database, parent: { kind: owner.kind, schema: owner.schema, name: owner.name }, name: 'CustomerName' }, 'CustomerName', { sublabel: '(nvarchar(100), null)' })
  ],
  logins: () => [explorerObject({ kind: 'login', name: 'sa' }, 'sa')],
  serverRoles: () => serverRoles.map(name => explorerObject({ kind: 'serverRole', name }, name)),
  cryptographicProviders: () => [explorerObject({ kind: 'cryptographicProvider', name: 'Test EKM Provider' }, 'Test EKM Provider')],
  audits: () => [explorerObject({ kind: 'audit', name: 'LoginAudit' }, 'LoginAudit')],
  serverAuditSpecifications: () => [explorerObject({ kind: 'serverAuditSpecification', name: 'LoginAuditSpec' }, 'LoginAuditSpec')]
}
function explorerObject(object, label, fields = {}) { return { ref: { type: 'object', object }, label, icon: kindSpecs[object.kind].icon, hasChildren: false, ...fields } }
async function explorerChildren({ node, subtype }) {
  const owner = node.type === 'object' ? node.object : node.owner
  const statics = staticChildren(node.type === 'object' ? { kind: node.object.kind, subtype } : { folder: node.folder }, explorerProfile)
    .map(folder => ({ ref: { type: 'folder', owner, folder }, label: folderSpecs[folder].label, icon: 'folder', hasChildren: true }))
  if (node.type === 'folder' && node.folder === 'audits' && !await controlled(join('allow', 'audits'))) {
    return { nodes: statics, elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to view Audits.', retryable: true } }
  }
  const nodes = [...statics, ...(node.type === 'folder' ? explorerRows[node.folder]?.(owner) ?? [] : [])]
  return { nodes, total: nodes.length, elapsedMs: 1 }
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
  // scripts/menus-smoke.mjs: Select Top 1000 Rows on dbo.Orders, a grid to select and copy, and a grid with a plan.
  SelectTopNRows: (id, params) => summary(id, params.database, [{ columns: [column('Id', 'int'), column('CustomerName', 'nvarchar')], rows: [['1', 'Contoso']] }]),
  MENUS_GRID_FIXTURE: (id, params) => summary(id, params.database, [{ columns: [column('Id', 'int'), column('', 'nvarchar'), column('Note', 'nvarchar')], rows: [['1', 'a', null], ['2', 'b', 'n2'], ['3', 'c', 'n3']] }], {
    messages: ['(3 rows affected)'], recordsAffected: 3
  }),
  MENUS_PLAN_FIXTURE: (id, params) => summary(id, params.database, [
    { columns: [column('Id', 'int'), column('CustomerName', 'nvarchar')], rows: [['1', 'Contoso']] },
    { columns: [{ ...column('Microsoft SQL Server 2005 XML Showplan', 'nvarchar'), role: 'plan' }], rows: [['<ShowPlanXML Version="1.6"><BatchSequence /></ShowPlanXML>']], kind: 'executionPlan' }
  ]),
  XML_PLAN_FIXTURE: (id, params) => summary(id, params.database, [
    { columns: [column('answer', 'int')], rows: [['1']], batchNumber: 2 },
    { columns: [{ ...column('Microsoft SQL Server 2005 XML Showplan', 'nvarchar'), role: 'plan' }], rows: [['<ShowPlanXML><BatchSequence><Batch /></BatchSequence></ShowPlanXML>']], kind: 'executionPlan', batchNumber: 2 }
  ], { completedBatches: 3, totalBatches: 3 })
}

async function workbench(id, method, params, credit) {
  if (controlDirectory) {
    const line = JSON.stringify({ generation, method, params: params?.password === undefined ? params : { ...params, password: '<redacted>' } }) + '\n'
    const entry = logged.then(() => appendFile(join(controlDirectory, 'calls.jsonl'), line))
    logged = entry.catch(() => {})
    await entry
  }
  while (await controlled(join('hold', method))) await sleep(25)
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
    case 'scripting.script': return respond(id, { text: 'CREATE TABLE dbo.Orders (Id int);', database: params.targets[0].database ?? 'master', warnings: [], commands: 1, elapsedMs: 1 })
    case 'tables.columns': return respond(id, { columns: [{ name: 'Id', dataType: 'int' }, { name: 'CustomerName', dataType: 'nvarchar' }], truncated: false })
    case 'explorer.children': return respond(id, await explorerChildren(params))
    case 'query.execute': {
      // As the real backend's crash handler does: a best-effort GOAWAY, then exit 70.
      if (await controlled('crash-next', true)) return exitAfter(encodeFrame(FrameKind.GOAWAY, 0, 0, encodeControl({ code: 'BACKEND_CRASH', message: 'The SQL backend failed unexpectedly (Exception).' })), 70)
      if (params.sql.includes('WAIT_FOR_CANCEL')) { waitingScripts.set(params.queryId, { id, database: params.database }); return }
      const fixture = Object.keys(fixtures).find(name => params.sql.includes(name))
      if (fixture) return respond(id, fixtures[fixture](id, params))
      return respond(id, summary(id, params.database, [{ columns: [column('server', 'nvarchar'), column('generation', 'int'), column('database', 'nvarchar')], rows: [[connection.server, String(generation), params.database]] }]))
    }
  }
  return fail(id, 'METHOD_NOT_FOUND', 'The fake backend does not know ' + method + '.')
}
