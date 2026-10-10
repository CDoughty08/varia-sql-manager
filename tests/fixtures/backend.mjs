// A fake backend that speaks protocol v2 through the real wire code (Node 24 type stripping), so tests exercise main's
// real pipeline against misbehaviour the .NET backend never produces. Usage: node backend.mjs <mode> [argument].
// Mode `workbench` answers every method well enough for the Electron smoke tests (main selects it with
// VARIA_TEST_BACKEND): scripts return the fixtures below as stored results, which results.read serves as real pages
// (encodePage) within the stream's credit. A script whose first line is `-- varia-fake: sets=W1*200000@50000,N1*100
// messages=40 errors=2 memory=0.92 hold` streams synthetic sets instead (backend/shapes.mjs). results.copy and
// results.export format text with backend/text-writer.mjs, the C# ResultTextWriter's twin. Its control directory,
// VARIA_TEST_BACKEND_DIR, holds:
//   calls.jsonl         one { generation, method, params } line per request, passwords redacted
//   hold/<method>       the method waits while this file exists; a directive with `hold` waits after its sets and
//                       messages, and results.export after each page (so a test can cancel it mid-save)
//   allow/audits        explorer.children may list audits (otherwise they fail as a permission error would)
//   crash-next          the next query.execute crashes the backend (GOAWAY BACKEND_CRASH, exit 70); the file is removed
//   silent-<generation> that generation stops answering PING, as a hung backend would
//   ignore-eof          stdin EOF does not end the process, as with a backend too wedged to read it; only a kill does
//   ignore-eof-<generation>  the same for that generation only
//   spawns.jsonl        one { pid } line per process started
import { appendFileSync, existsSync, rmSync } from 'node:fs'
import { access, appendFile, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { FrameKind, FrameParser, encodeFrame } from '../../src/shared/ipc/wire/frames.ts'
import { decodeControl, encodeControl } from '../../src/shared/ipc/wire/msgpack.ts'
import { decodePage, encodePage } from '../../src/shared/ipc/wire/pages.ts'
import { copyText, exportText } from './backend/text-writer.mjs'
import { parseDirective, shapes } from './backend/shapes.mjs'
import { backendMethods } from '../../src/shared/ipc/methods.ts'
import { folderSpecs, kindSpecs, staticChildren } from '../../src/shared/explorer/catalog.ts'

const [mode = 'echo', argument] = process.argv.slice(2)
const parser = new FrameParser({ maxBody: 4 * 1024 * 1024, direction: 'toBackend' })
const cancels = []
const streams = new Map()
// Requests a CANCEL frame named (an export stops at its next page), and directive scripts query.cancel stopped.
const cancelled = new Set()
const runningDirectives = new Set()
const cancelledQueries = new Set()
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
    cancelled.add(frame.id)
    if ((mode === 'echo' || mode === 'workbench') && streams.has(frame.id)) { streams.delete(frame.id); fail(frame.id, 'CANCELLED', 'The operation was cancelled.') }
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
      write(FrameKind.EVENT, id, 0, { type: 'messages', messages: [{ text: 'first', kind: 'info' }] })
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
// Stored results of this process (one backend generation), by resultId, as the real result store keeps them. Rows come
// from `rowAt`; pages are encoded per block of `pageRows` when first read (a few are kept), so a million-row set costs
// nothing until it is read. While a set streams, only whole blocks are readable, like the real store's sealed pages.
const stored = new Map()
let nextResultId = 1
const globalBytes = 256 * 1024 * 1024
// The memory a directive's `memory=` pretends its results hold, until results.close frees the last of them.
let held = { bytes: 0, results: new Set() }
const column = (name, dataType) => ({ name, dataType, wire: 'text', nullable: true })
const available = result => result.complete ? result.read : Math.floor(result.read / result.pageRows) * result.pageRows
const describe = result => ({
  resultId: result.resultId, index: result.index, batchNumber: result.batchNumber, iteration: result.iteration, kind: result.kind, columns: result.columns,
  rowsRead: result.read, rowsStored: result.read, rowsAvailable: available(result), bytesStored: available(result) * 100, truncatedCells: 0,
  state: result.complete ? 'complete' : 'open', incomplete: result.incomplete ?? false
})
function storeResult(set, index) {
  const result = {
    resultId: nextResultId++, index, batchNumber: set.batchNumber ?? 1, iteration: set.iteration ?? 1, kind: set.kind ?? 'rows', columns: set.columns,
    rowAt: set.rowAt ?? (row => set.rows[row]), pageRows: set.pageRows ?? 64, read: set.read ?? set.rows.length, complete: set.complete ?? true, pages: new Map()
  }
  stored.set(result.resultId, result)
  return result
}
/** The page of block `block`, encoded on first use; at most 64 are kept. */
function pageOf(result, block) {
  let page = result.pages.get(block)
  if (!page) {
    const first = block * result.pageRows, rows = Math.min(result.pageRows, available(result) - first)
    page = { firstRow: first, rows, body: encodePage({ resultId: result.resultId, firstRow: first, columns: result.columns, rows: Array.from({ length: rows }, (_, i) => result.rowAt(first + i)) }) }
    if (result.complete || rows === result.pageRows) {
      result.pages.set(block, page)
      if (result.pages.size > 64) result.pages.delete(result.pages.keys().next().value)
    }
  }
  return page
}
const decodedPageAt = result => row => decodePage(pageOf(result, Math.floor(row / result.pageRows)).body, result.columns)
/** Stores result sets ({ columns, rows, batchNumber?, iteration?, kind? }) and reports them as the real backend does. */
function storeResults(id, sets) {
  return sets.map((set, index) => {
    const result = storeResult(set, index)
    write(FrameKind.EVENT, id, 0, { type: 'resultSet.opened', descriptor: { ...describe(result), state: 'open' } })
    write(FrameKind.EVENT, id, 0, { type: 'resultSet.closed', descriptor: describe(result) })
    return describe(result)
  })
}
const info = text => ({ text, kind: 'info' })
const summary = (id, database, sets, patch = {}) => ({
  resultSets: storeResults(id, sets), discardedResultSets: 0, messages: [], recordsAffected: -1, elapsedMs: 1, status: 'completed', completedBatches: 1, totalBatches: 1,
  database, messagesTruncated: false, budget: { usedBytes: 0, globalBytes, queryBytes: globalBytes / 2 }, completedAt: new Date().toISOString().replace('Z', '0000+00:00'), ...patch
})
const missing = (id, resultId) => fail(id, resultId < nextResultId ? 'RESULT_RELEASED' : 'RESULT_NOT_FOUND', resultId < nextResultId ? 'These results were closed. Execute the query again to see them.' : 'These results do not exist.')
/** Sends `bodies` as DATA while credit lasts, then answers with `done()`. */
function streamBodies(id, credit, bodies, done) {
  let budget = credit, sent = 0
  const pump = () => {
    while (budget > 0 && sent < bodies.length) {
      const body = bodies[sent++]
      budget -= body.length
      process.stdout.write(encodeFrame(FrameKind.DATA, id, sent, body))
    }
    if (sent === bodies.length && streams.delete(id)) respond(id, done())
  }
  streams.set(id, { grant: more => { budget += more; pump() } })
  pump()
}
/** results.read: the stored pages overlapping the range, while credit lasts, then the terminal RESPONSE. */
function readResults(id, credit, { resultId, firstRow, maxRows }) {
  const result = stored.get(resultId)
  if (!result) return missing(id, resultId)
  const end = Math.min(firstRow + maxRows, available(result))
  const pages = []
  for (let block = Math.floor(firstRow / result.pageRows); block * result.pageRows < end; block++) pages.push(pageOf(result, block))
  const next = pages.length ? pages.at(-1).firstRow + pages.at(-1).rows : firstRow
  streamBodies(id, credit, pages.map(page => page.body), () => ({ nextRow: next, rowsAvailable: available(result), complete: result.complete && next >= result.read, pages: pages.length, rows: pages.reduce((sum, page) => sum + page.rows, 0) }))
}
/** results.copy: the text_writer.mjs text in DATA chunks of 1 MiB within credit; TOO_LARGE before any DATA. */
async function copyResults(id, credit, { resultId, parts, headers, eol, maxBytes }) {
  const result = stored.get(resultId)
  if (!result) return missing(id, resultId)
  let copied
  try { copied = await copyText({ columns: result.columns, pageAt: decodedPageAt(result), available: available(result), parts, headers, crlf: eol === 'crlf' }) }
  catch { return fail(id, 'INVALID_PARAMS', 'The copy request is invalid.') }
  if (copied.bytes > maxBytes) return fail(id, 'TOO_LARGE', `The selection is too large to copy (${Math.ceil(copied.bytes / 1048576)} MB; the limit is ${Math.floor(maxBytes / 1048576)} MB). Use Save Results As instead.`)
  const chunks = []
  for (let at = 0; at < copied.text.length; at += 1024 * 1024) chunks.push(copied.text.subarray(at, at + 1024 * 1024))
  write(FrameKind.EVENT, id, 0, { type: 'job.progress', rowsDone: copied.rows, rowsTotal: copied.rows, bytes: copied.bytes })
  streamBodies(id, credit, chunks, () => ({ rows: copied.rows, bytes: copied.bytes, truncatedCells: copied.truncatedCells, partial: !result.complete }))
}
/** results.export: a temporary file renamed over the target; hold/results.export pauses it after each page, and a
 *  CANCEL frame stops it (the temporary file is removed). */
async function exportResults(id, { resultId, path, format, headers, nullText, temporaryId }) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || !['csv', 'tsv', 'json'].includes(format) || !['empty', 'NULL'].includes(nullText)
    || typeof temporaryId !== 'string' || !/^[0-9a-f]{32}$/.test(temporaryId)) return fail(id, 'INVALID_PARAMS', 'The export request is invalid.')
  const result = stored.get(resultId)
  if (!result) return missing(id, resultId)
  if (!result.complete) return fail(id, 'RESULT_OPEN', 'Save the results after this result set finishes loading.')
  if (!await access(dirname(path)).then(() => true, () => false)) return fail(id, 'EXPORT_FAILED', 'NOT_FOUND')
  if (await stat(path).then(entry => entry.isDirectory(), () => false)) return fail(id, 'EXPORT_FAILED', 'IS_DIRECTORY')
  const temporary = join(dirname(path), `.varia-${temporaryId}.tmp`)
  const file = await open(temporary, 'wx')
  let last = Date.now()
  try {
    const writer = await exportText({ columns: result.columns, pageAt: decodedPageAt(result), rows: result.read, format, headers, nullText }, async writer => {
      for (const chunk of writer.out.take()) await file.write(chunk)
      if (Date.now() - last >= 250) { last = Date.now(); write(FrameKind.EVENT, id, 0, { type: 'job.progress', rowsDone: writer.rows, rowsTotal: result.read, bytes: writer.bytes }) }
      while (!cancelled.has(id) && await controlled(join('hold', 'results.export'))) await sleep(25)
      if (cancelled.has(id)) throw new Error('cancelled')
    })
    writer.out.seal()
    for (const chunk of writer.out.take()) await file.write(chunk)
    await file.sync()
    await file.close()
    await rename(temporary, path)
    respond(id, { rows: writer.rows, bytes: writer.bytes, truncatedCells: writer.truncatedCells, partial: false })
  } catch {
    fail(id, cancelled.has(id) ? 'CANCELLED' : 'EXPORT_FAILED', cancelled.has(id) ? 'The operation was cancelled.' : 'IO')
  } finally {
    await file.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    cancelled.delete(id)
  }
}

/** A script with a `-- varia-fake:` first line (shapes.mjs): its sets stream at their rates, then messages, then the summary. */
async function runDirective(id, params, directive) {
  const results = [], discarded = []
  const maxSets = params.maxResultSets ?? 10
  const queryId = params.queryId
  runningDirectives.add(queryId)
  if (directive.memory !== undefined) {
    held = { bytes: Math.round(directive.memory * globalBytes), results: new Set() }
    write(FrameKind.EVENT, 0, 0, { type: 'results.memory', usedBytes: held.bytes, globalBytes })
  }
  let status = 'completed'
  try {
    for (const [index, set] of directive.sets.entries()) {
      const shape = shapes[set.shape]
      if (index >= maxSets) { discarded.push(set); continue }
      const result = storeResult({ columns: shape.columns, rowAt: shape.row, pageRows: shape.pageRows, read: set.rate === undefined ? set.rows : 0, complete: false }, index)
      results.push(result)
      if (directive.memory !== undefined) held.results.add(result.resultId)
      write(FrameKind.EVENT, id, 0, { type: 'resultSet.opened', descriptor: describe(result) })
      while (result.read < set.rows) {
        if (cancelledQueries.has(queryId)) { status = 'cancelled'; result.incomplete = true; break }
        await sleep(100)
        result.read = Math.min(set.rows, result.read + Math.max(1, Math.round(set.rate / 10)))
        write(FrameKind.EVENT, id, 0, { type: 'progress', completedBatches: 0, totalBatches: 1, batchNumber: 1, iteration: 1, results: [{ resultId: result.resultId, rowsRead: result.read, rowsStored: result.read, rowsAvailable: available(result), bytesStored: available(result) * 100 }] })
      }
      result.complete = true
      write(FrameKind.EVENT, id, 0, { type: 'resultSet.closed', descriptor: describe(result) })
      if (status === 'cancelled') break
    }
    const messages = [
      ...Array.from({ length: directive.messages }, (_, i) => info(`Message ${i + 1}`)),
      ...Array.from({ length: directive.errors }, (_, i) => ({ text: `Msg 50000, Level 16, State 1, Line ${i + 1}\nFake error ${i + 1}.`, kind: 'error' }))
    ].slice(0, 1000)
    if (status === 'cancelled') messages.push({ text: 'The script was cancelled. Remaining batches were not executed.', kind: 'error' })
    if (messages.length) write(FrameKind.EVENT, id, 0, { type: 'messages', messages })
    while (directive.hold && !cancelledQueries.has(queryId) && await controlled(join('hold', 'query.execute'))) await sleep(25)
    if (status === 'completed' && cancelledQueries.has(queryId)) status = 'cancelled'
    const failed = status === 'completed' && directive.errors > 0
    respond(id, {
      resultSets: results.map(describe), discardedResultSets: discarded.length, messages, recordsAffected: -1, elapsedMs: 1, status: failed ? 'failed' : status,
      ...failed ? { error: { code: 'SQL_ERROR', message: messages.find(message => message.kind === 'error').text, batchNumber: 1, iteration: 1 } } : {},
      ...status === 'cancelled' ? { error: { code: 'CANCELLED', message: 'The script was cancelled. Remaining batches were not executed.', batchNumber: 1, iteration: 1 } } : {},
      completedBatches: status === 'completed' && !failed ? 1 : 0, totalBatches: 1, database: params.database, messagesTruncated: false,
      budget: { usedBytes: Math.round((directive.memory ?? 0) * globalBytes), globalBytes, queryBytes: globalBytes / 2 }, completedAt: new Date().toISOString().replace('Z', '0000+00:00')
    })
  } finally {
    runningDirectives.delete(queryId)
    cancelledQueries.delete(queryId)
  }
}

const fixtures = {
  BATCH_STATS_FIXTURE: (id, params) => summary(id, params.database, [{ columns: [column('retained', 'int')], rows: [['42']], batchNumber: 1, iteration: 1 }], {
    // As the real backend logs them: statistics, then the batch's error in SSMS's two-line form.
    messages: [info('SQL Server Execution Times: CPU time = 1 ms, elapsed time = 2 ms.'), info("Table '#temp'. Scan count 1, logical reads 2."),
      { text: 'Msg 137, Level 15, State 2, Line 8\nMust declare the scalar variable.', kind: 'error' }], elapsedMs: 3, status: 'failed',
    error: { code: 'SQL_ERROR', message: 'Msg 137, Level 15, State 2, Line 8\nMust declare the scalar variable.', batchNumber: 2, iteration: 1 }, completedBatches: 1, totalBatches: 3
  }),
  // scripts/menus-smoke.mjs: Select Top 1000 Rows on dbo.Orders, a grid to select and copy, and a grid with a plan.
  SelectTopNRows: (id, params) => summary(id, params.database, [{ columns: [column('Id', 'int'), column('CustomerName', 'nvarchar')], rows: [['1', 'Contoso']] }]),
  MENUS_GRID_FIXTURE: (id, params) => summary(id, params.database, [{ columns: [column('Id', 'int'), column('', 'nvarchar'), column('Note', 'nvarchar')], rows: [['1', 'a', null], ['2', 'b', 'n2'], ['3', 'c', 'n3']] }], {
    messages: [info('(3 rows affected)')], recordsAffected: 3
  }),
  MENUS_PLAN_FIXTURE: (id, params) => summary(id, params.database, [
    { columns: [column('Id', 'int'), column('CustomerName', 'nvarchar')], rows: [['1', 'Contoso']] },
    { columns: [{ ...column('Microsoft SQL Server 2005 XML Showplan', 'nvarchar'), role: 'plan' }], rows: [['<ShowPlanXML Version="1.6"><BatchSequence /></ShowPlanXML>']], kind: 'executionPlan' }
  ]),
  XML_PLAN_FIXTURE: (id, params) => summary(id, params.database, [
    { columns: [column('answer', 'int')], rows: [['1']], batchNumber: 2 },
    { columns: [{ ...column('Microsoft SQL Server 2005 XML Showplan', 'nvarchar'), role: 'plan' }], rows: [['<ShowPlanXML><BatchSequence><Batch /></BatchSequence></ShowPlanXML>']], kind: 'executionPlan', batchNumber: 2 }
  ], { completedBatches: 3, totalBatches: 3 }),
  // FOR XML output joined into one value (role xml), as ForXmlCollector stores it, and an xml cast.
  FOR_XML_FIXTURE: (id, params) => summary(id, params.database, [
    { columns: [{ ...column('XML_F52E2B61-18A1-11d1-B105-00805F49916B', 'ntext'), role: 'xml' }], rows: [['<objects><o><name>Orders</name><object_id>1</object_id></o><o><name>Customers</name><object_id>2</object_id></o></objects>']] }
  ]),
  XML_CAST_FIXTURE: (id, params) => summary(id, params.database, [{ columns: [{ ...column('doc', 'xml'), role: 'xml' }], rows: [['<a><b>1</b><b>2</b></a>']] }])
}

async function workbench(id, method, params, credit) {
  if (controlDirectory) {
    const line = JSON.stringify({ generation, method, params: params?.password === undefined ? params : { ...params, password: '<redacted>' } }) + '\n'
    const entry = logged.then(() => appendFile(join(controlDirectory, 'calls.jsonl'), line))
    logged = entry.catch(() => {})
    await entry
  }
  // A directive's `hold` and an export's hold apply later, after their first output.
  const directive = method === 'query.execute' ? parseDirective(params.sql) : undefined
  if (!directive?.hold && method !== 'results.export') while (await controlled(join('hold', method))) await sleep(25)
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
      if (runningDirectives.has(params.queryId)) cancelledQueries.add(params.queryId)
      return respond(id, { cancelled: !!script || runningDirectives.has(params.queryId) })
    }
    case 'results.read': return credit === undefined ? fail(id, 'INVALID_REQUEST', 'Result pages are read as a stream with credit.') : readResults(id, credit, params)
    case 'results.copy': return credit === undefined ? fail(id, 'INVALID_REQUEST', 'Copied text is sent as a stream with credit.') : copyResults(id, credit, params)
    case 'results.export': return exportResults(id, params)
    case 'results.close': {
      let closed = 0
      for (const resultId of params.resultIds) if (stored.delete(resultId)) closed++
      // As the real backend does, the fall goes out as an event before the answer.
      if (params.resultIds.filter(resultId => held.results.delete(resultId)).length && held.results.size === 0 && held.bytes > 0) {
        held.bytes = 0
        write(FrameKind.EVENT, 0, 0, { type: 'results.memory', usedBytes: 0, globalBytes })
      }
      return respond(id, { closed, usedBytes: held.bytes })
    }
  }
  const connection = workbenchConnections.get(params.connectionId)
  if (!connection) return fail(id, 'NOT_CONNECTED', 'Connect to a SQL Server first.')
  switch (method) {
    case 'databases.list': return respond(id, workbenchDatabases)
    case 'tables.script': return respond(id, { sql: 'CREATE TABLE dbo.Orders (Id int);' })
    case 'tables.columns': return respond(id, { columns: [{ name: 'Id', dataType: 'int' }, { name: 'CustomerName', dataType: 'nvarchar' }], truncated: false })
    case 'explorer.children': return respond(id, await explorerChildren(params))
    case 'query.execute': {
      // As the real backend's crash handler does: a best-effort GOAWAY, then exit 70.
      if (await controlled('crash-next', true)) return exitAfter(encodeFrame(FrameKind.GOAWAY, 0, 0, encodeControl({ code: 'BACKEND_CRASH', message: 'The SQL backend failed unexpectedly (Exception).' })), 70)
      if (directive) return runDirective(id, params, directive)
      if (params.sql.includes('WAIT_FOR_CANCEL')) { waitingScripts.set(params.queryId, { id, database: params.database }); return }
      const fixture = Object.keys(fixtures).find(name => params.sql.includes(name))
      if (fixture) return respond(id, fixtures[fixture](id, params))
      return respond(id, summary(id, params.database, [{ columns: [column('server', 'nvarchar'), column('generation', 'int'), column('database', 'nvarchar')], rows: [[connection.server, String(generation), params.database]] }]))
    }
  }
  return fail(id, 'METHOD_NOT_FOUND', 'The fake backend does not know ' + method + '.')
}
