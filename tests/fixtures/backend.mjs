// A fake backend that speaks protocol v2 through the real wire code (Node 24 type stripping), so tests exercise main's
// real pipeline against misbehaviour the .NET backend never produces. Usage: node backend.mjs <mode> [argument].
// Mode `workbench` answers every method well enough for the Electron smoke tests (main selects it with
// VARIA_TEST_BACKEND): scripts return the fixtures below as stored results, which results.read serves as real pages
// (encodePage) within the stream's credit. A script whose first line is `-- varia-fake: sets=W1*200000@50000,N1*100
// messages=40 errors=2 memory=0.92 hold` streams synthetic sets instead (backend/shapes.mjs). results.copy and
// results.export format text with backend/text-writer.mjs, the C# ResultTextWriter's twin. Its control directory,
// VARIA_TEST_BACKEND_DIR, holds:
//   calls.jsonl         one { generation, method, params } line per request, passwords (and entra.cache.import's data)
//                       redacted
//   reject-passwords    server 'password-check' refuses every login (18456), as after a password change; otherwise it
//                       accepts only the password correct-horse-marker
//   untrusted-certificate  server 'password-check' refuses a connect without Trust server certificate, as a self-signed
//                       certificate does (reason 'certificate')
//   hold/<method>       the method waits while this file exists; a directive with `hold` waits after its sets and
//                       messages, and results.export after each page (so a test can cancel it mid-save)
//   allow/audits        explorer.children may list audits (otherwise they fail as a permission error would)
//   extra/<folder>      explorer.children lists one more row in that folder (`explorerExtras`), as after a CREATE; for
//                       ssisFolders and ssisProjects the SSIS catalog probe's fingerprints change with it, as after a
//                       deployment elsewhere
//   crash-next          the next query.execute crashes the backend (GOAWAY BACKEND_CRASH, exit 70); the file is removed
//   fail-commit         query.session.close with transaction commit fails as SQL Server's would, and the session stays
//   ssis/missing        ssis.describe answers NOT_FOUND, as for an object deleted elsewhere
//   ssis/fail           ssis.describe answers a retryable TIMEOUT
//   ssis/many           ssis.describe gives the project as many packages, parameters and references as one read returns
//   silent-<generation> that generation stops answering PING, as a hung backend would
//   ignore-eof          stdin EOF does not end the process, as with a backend too wedged to read it; only a kill does
//   ignore-eof-<generation>  the same for that generation only
//   spawns.jsonl        one { pid } line per process started
//   cancels.jsonl       one { method } line per entra-wait request a CANCEL frame ended
// Server 'entra-wait' connects (and lists databases) as a Microsoft Entra MFA sign-in waiting for the browser does: only a
// CANCEL frame (the Connect dialog's Stop) ends it, answered CANCELLED.
// live.subscribe for debug.synthetic (docs/ipc.md, Live subscriptions) runs as the real backend's test source does, with
// stop-and-wait credit: live.opened, then a live.tick per wake only once the previous one is acknowledged, a snapshot
// table stored per sample (two revisions alive), live.update for pause, intervals, refresh, sort, tracking and args, and
// an end on CANCEL (cancelled or shutdown), a disconnect (disconnected) or args.endAfterTicks (sourceEnded). It implements
// the metrics, table and status probes only, and refuses the others (INVALID_PARAMS) rather than send frames main would
// count as protocol violations. Object Explorer's `explorer` source runs only while the control directory holds
// explorer-status.json, `{ databases?: [name, state, userAccess, readOnly, standby][], progress?: [name, command, percent][],
// jobs?: number, groups?: [name, health, role][] }`, read again at every sample; without it the source is refused as an
// unknown one, so suites that do not look at status chips see one refused subscription per connection and nothing else.
// The activity source (the Activity Monitor) runs no SQL either: its overview samples every series of the catalogue from
// a slow wave (blocked sessions only with the control file activity-blocked; with activity-failing each sample fails as
// BLOCKED, as a probe that waited out its lock timeout does), the resources probe opens unavailable as the
// real one does until it is sampled, and on server 'no-permission' the overview opens unavailable (PERMISSION_DENIED);
// a connection to that server reports its login, as the server profile does, so the monitor offers Copy GRANT statement.
// The SSIS tree's ssis.catalog source samples every 200 ms whatever its interval, its fingerprints counting the extra/ssis*
// rows.
// live.subscribe for ssis.operations shows each connection's fake SSIS catalog (`ssisCatalogOf`): eight operations, and a
// new running execution every fourth sample (none while ssis-quiet is in the control directory); its args filter them as the real source's do (kinds, statuses, names exactly
// or by prefix, caller, limit), and new args replace the old ones whole. ssis.execute's stopOperation turns a running or
// pending execution or validation Stopping (stopped by FAKE\smoke) and the next sample Canceled; anything else answers as the
// real preflight does (ALREADY_FINAL, NOT_STARTED, NOT_SUPPORTED, NOT_FOUND). A connection to server 'no-ssisdb' has no
// catalog: its first tick reports CATALOG_MISSING, and the subscription ends failed; one to 'ssis-denied' does the same with PERMISSION_DENIED.
// Echo-mode live.subscribe sends live.opened and `ticks` (default 3) status ticks, each after the previous one's credit;
// modes live-overrun (a tick before the opened frame's credit), live-data (a DATA frame), live-big (a 300 KiB EVENT) and
// live-seq-gap (tick 2 after the opened frame's credit) break the protocol on purpose.
// A tab's session counts BEGIN TRAN, COMMIT and ROLLBACK in its scripts, and notes SET NOEXEC, PARSEONLY, FMTONLY and
// SHOWPLAN_* ON and OFF: every summary carries its spid and login, query.session.state answers its @@TRANCOUNT (unchecked
// while such an option is ON, SESSION_BUSY while a script waits in it, SESSION_CLOSED for none), and query.session.close
// commits or rolls back what is open.
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { access, appendFile, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { FrameKind, FrameParser, encodeFrame } from '../../src/shared/ipc/wire/frames.ts'
import { decodeControl, encodeControl } from '../../src/shared/ipc/wire/msgpack.ts'
import { decodePage, encodePage } from '../../src/shared/ipc/wire/pages.ts'
import { copyText, exportText } from './backend/text-writer.mjs'
import { parseDirective, shapes } from './backend/shapes.mjs'
import { backendMethods } from '../../src/shared/ipc/methods.ts'
import { folderSpecs, kindSpecs, staticChildren } from '../../src/shared/explorer/catalog.ts'
import { liveProbes } from '../../src/shared/live/catalog.ts'
import { pendingProbes } from '../../src/shared/activity/catalog.ts'
import { openStatuses, operationKindSpecs, operationStatuses, operationTiles, operationTypes } from '../../src/shared/ssis/catalog.ts'

const [mode = 'echo', argument] = process.argv.slice(2)
const parser = new FrameParser({ maxBody: 4 * 1024 * 1024, direction: 'toBackend' })
const cancels = []
const streams = new Map()
// Requests a CANCEL frame named (an export stops at its next page), and directive scripts query.cancel stopped.
const cancelled = new Set()
// Live subscriptions by request id.
const lives = new Map()
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
    if (lives.has(frame.id)) { endLive(lives.get(frame.id), frame.arg === 4 ? 'shutdown' : 'cancelled'); return }
    if ((mode === 'echo' || mode === 'workbench') && streams.has(frame.id)) { streams.delete(frame.id); fail(frame.id, 'CANCELLED', 'The operation was cancelled.') }
    return
  }
  if (frame.kind === FrameKind.CREDIT) { (lives.get(frame.id) ?? streams.get(frame.id))?.grant(frame.arg); return }
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
    // connections.connect fails with details (docs/ipc.md); server 'long' sends a server name over the 256-character bound.
    case 'error-details':
      if (method === 'connections.connect' && params.server === 'certificate') return write(FrameKind.RESPONSE, id, 0, { error: { code: 'SQL_ERROR', message: 'The certificate chain was issued by an authority that is not trusted.', details: { number: -2146893019, state: 0, class: 20, server: 'certificate', reason: 'certificate' } } })
      if (method === 'connections.connect' && params.server === 'crash') return write(FrameKind.RESPONSE, id, 0, { error: { code: 'BACKEND_ERROR', message: 'The backend operation failed.', details: { exception: 'System.DllNotFoundException (0x80131524)' } } })
      // Out of bounds: a reason main does not know, and an exception summary longer than 512 characters.
      if (method === 'connections.connect' && params.server === 'reason') return write(FrameKind.RESPONSE, id, 0, { error: { code: 'SQL_ERROR', message: 'Failed.', details: { reason: 'firewall' } } })
      if (method === 'connections.connect' && params.server === 'exception') return write(FrameKind.RESPONSE, id, 0, { error: { code: 'BACKEND_ERROR', message: 'Failed.', details: { exception: 'x'.repeat(513) } } })
      if (method === 'connections.connect') return write(FrameKind.RESPONSE, id, 0, { error: { code: 'AUTH_KERBEROS', message: 'Your Kerberos ticket has expired.', details: params.server === 'long' ? { number: 0, server: 'x'.repeat(257) } : { number: 0, state: 0, class: 11, server: params.server } } })
      break
    case 'events':
      // Global events (id 0) are advisory: an undecodable one is dropped, not a violation.
      write(FrameKind.EVENT, 0, 0, { type: 'results.memory', usedBytes: 1, globalBytes: 2 })
      process.stdout.write(encodeFrame(FrameKind.EVENT, 0, 0, Uint8Array.of(0xc1)))
      write(FrameKind.EVENT, id, 0, { type: 'messages', messages: [{ text: 'first', kind: 'info' }] })
      process.stdout.write(encodeFrame(FrameKind.EVENT, id, 0, Uint8Array.of(0xc1)))
      return
  }
  if (method === 'live.subscribe') return liveEcho(id, credit, params)
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

const syntheticProbes = ['debug.synthetic.metrics', 'debug.synthetic.table', 'debug.synthetic.status']
const opened = (probes, source = 'debug.synthetic') => ({ type: 'live.opened', seq: 0, source, probes: probes.map(probe => ({ probe, intervalMs: 1000, minIntervalMs: 1000, maxIntervalMs: 3_600_000, state: 'ok' })) })
const statusTick = (seq, sample = seq) => ({ type: 'live.tick', seq, sampledAt: Date.now(), samples: [{ probe: 'debug.synthetic.status', costMs: 0, effectiveIntervalMs: 1000, status: [{ id: 'samples', value: sample }] }] })
/** Echo-mode live.subscribe: protocol tests of main's credited-EVENT rule. */
function liveEcho(id, credit = 65_536, params = {}) {
  const event = value => process.stdout.write(encodeFrame(FrameKind.EVENT, id, 0, encodeControl(value)))
  // The opened frame reports the probes asked for (main refuses any other set); ticks sample the status probe.
  const probes = Array.isArray(params.probes) ? params.probes.map(probe => probe.probe) : syntheticProbes
  switch (mode) {
    case 'live-overrun': event(opened(probes)); event(statusTick(1)); return
    case 'live-data': event(opened(probes)); process.stdout.write(encodeFrame(FrameKind.DATA, id, 1, new Uint8Array(16))); return
    case 'live-big': event({ ...opened(probes), padding: 'x'.repeat(300 * 1024) }); return
  }
  const ticks = params.ticks ?? 3
  const live = { id, initial: credit, available: credit, seq: 0 }
  const send = value => { const body = encodeControl(value); live.available -= body.length; process.stdout.write(encodeFrame(FrameKind.EVENT, id, 0, body)) }
  live.grant = more => {
    live.available += more
    if (live.available < live.initial || !lives.has(id)) return
    if (live.seq < ticks) return send(statusTick(++live.seq + (mode === 'live-seq-gap' ? 1 : 0)))
    lives.delete(id)
    respond(id, { ended: 'sourceEnded', kept: [], ticks, elapsedMs: 1 })
  }
  live.end = ended => respond(id, { ended, ticks: live.seq, elapsedMs: 1 })
  lives.set(id, live)
  send(opened(probes))
}
function endLive(live, ended) {
  lives.delete(live.id)
  if (live.end) return live.end(ended)
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
// Each tab's session: its SPID, open transaction count and compile-only options, until query.session.close or its
// connection's disconnect.
const sessions = new Map()
let nextSpid = 51
/** Applies a script's BEGIN TRAN, COMMIT and ROLLBACK to its session, as SQL Server would count them in @@TRANCOUNT. */
function runInSession({ sessionId, connectionId, sql }) {
  const session = sessions.get(sessionId) ?? { spid: nextSpid++, connectionId, transactions: 0, compileOnly: new Set() }
  sessions.set(sessionId, session)
  for (const [, option, value] of sql.matchAll(/\bSET\s+(NOEXEC|PARSEONLY|FMTONLY|SHOWPLAN_\w+)\s+(ON|OFF)\b/gi)) session.compileOnly[value.toUpperCase() === 'ON' ? 'add' : 'delete'](option.toUpperCase())
  for (const [statement] of sql.matchAll(/\b(BEGIN\s+TRAN(?:SACTION)?|COMMIT(?:\s+TRAN(?:SACTION)?)?|ROLLBACK(?:\s+TRAN(?:SACTION)?)?)\b/gi)) {
    const verb = statement.slice(0, 1).toUpperCase()
    session.transactions = verb === 'B' ? session.transactions + 1 : verb === 'C' ? Math.max(0, session.transactions - 1) : 0
  }
}
/** The session's SPID and login, which SqlService adds to every summary while the session is open. */
const probe = sessionId => { const session = sessions.get(sessionId); return session ? { spid: session.spid, login: 'fake' } : {} }
const workbenchDatabases = [
  { name: 'master', isSystem: true, isSnapshot: false }, { name: 'model', isSystem: true, isSnapshot: false }, { name: 'msdb', isSystem: true, isSnapshot: false },
  { name: 'tempdb', isSystem: true, isSnapshot: false }, { name: 'AppData', isSystem: false, isSnapshot: false }, { name: 'AppData_Snapshot', isSystem: false, isSnapshot: true }
]
// With the spaced-databases cue, names that differ only in their spaces, as SQL Server allows: a list that took an
// option's text, whose spaces are collapsed and trimmed, would name another database or none.
const spacedDatabases = ['Sales  2024', 'Sales 2024', ' lead', 'tab\there'].map(name => ({ name, isSystem: false, isSnapshot: false }))
const databaseRows = async () => await controlled('spaced-databases') ? [...workbenchDatabases, ...spacedDatabases] : workbenchDatabases
const serverRoles = ['##MS_DatabaseConnector##', '##MS_LoginManager##', 'bulkadmin', 'dbcreator', 'public', 'securityadmin', 'serveradmin', 'sysadmin']
// Object Explorer's fixture tree (explorer.children), on a SQL Server 2022 box: the catalogue's static folders, and
// these rows in the folders (and kinds) that list them. Every database has dbo.Orders; Audits fails until allow/audits
// exists. The SSIS Catalog has one folder, Finance, with the project Loads (an entry point and a child package) and the
// environment Test.
const explorerProfile = { band: 16, engine: 'box' }
const explorerRows = {
  systemDatabases: () => ['master', 'model', 'msdb', 'tempdb'].map(name => explorerObject({ kind: 'database', name }, name, { subtype: 'system', hasChildren: true })),
  databaseSnapshots: () => [explorerObject({ kind: 'database', name: 'AppData_Snapshot' }, 'AppData_Snapshot', { subtype: 'snapshot', icon: 'device-camera', hasChildren: true })],
  databases: () => [explorerObject({ kind: 'database', name: 'AppData' }, 'AppData', { hasChildren: true })],
  tables: owner => [explorerObject({ kind: 'table', database: owner.name, schema: 'dbo', name: 'Orders' }, 'dbo.Orders', { hasChildren: true, created: '2024-05-01T09:30:00' })],
  columns: owner => [
    explorerObject({ kind: 'column', database: owner.database, parent: { kind: owner.kind, schema: owner.schema, name: owner.name }, name: 'Id' }, 'Id', { sublabel: '(PK, int, not null)', icon: 'key' }),
    explorerObject({ kind: 'column', database: owner.database, parent: { kind: owner.kind, schema: owner.schema, name: owner.name }, name: 'CustomerName' }, 'CustomerName', { sublabel: '(nvarchar(100), null)' })
  ],
  logins: () => [explorerObject({ kind: 'login', name: 'sa' }, 'sa')],
  serverRoles: () => serverRoles.map(name => explorerObject({ kind: 'serverRole', name }, name)),
  cryptographicProviders: () => [explorerObject({ kind: 'cryptographicProvider', name: 'Test EKM Provider' }, 'Test EKM Provider')],
  audits: () => [explorerObject({ kind: 'audit', name: 'LoginAudit' }, 'LoginAudit')],
  serverAuditSpecifications: () => [explorerObject({ kind: 'serverAuditSpecification', name: 'LoginAuditSpec' }, 'LoginAuditSpec')],
  integrationServicesCatalogs: () => [explorerObject({ kind: 'ssisCatalog', name: 'SSISDB' }, 'SSISDB', { hasChildren: true })],
  ssisFolders: () => [explorerObject({ kind: 'ssisFolder', name: 'Finance' }, 'Finance', { hasChildren: true })],
  ssisProjects: owner => [explorerObject({ kind: 'ssisProject', ssisFolder: owner.name, name: 'Loads' }, 'Loads', { hasChildren: true, sublabel: '(Deployed 2026-10-21 14:05)' })],
  ssisEnvironments: owner => [explorerObject({ kind: 'ssisEnvironment', ssisFolder: owner.name, name: 'Test' }, 'Test', { sublabel: '(2 variables)' })],
  ssisPackages: owner => [
    explorerObject({ kind: 'ssisPackage', ssisFolder: owner.ssisFolder, ssisProject: owner.name, name: 'Daily.dtsx' }, 'Daily.dtsx', { subtype: 'entryPoint' }),
    explorerObject({ kind: 'ssisPackage', ssisFolder: owner.ssisFolder, ssisProject: owner.name, name: 'Child.dtsx' }, 'Child.dtsx', { subtype: 'child', icon: 'symbol-file' })
  ]
}
// What extra/<folder> adds: a role or table created since the folder was first listed.
const explorerExtras = {
  serverRoles: () => explorerObject({ kind: 'serverRole', name: 'VariaAuditors' }, 'VariaAuditors'),
  tables: owner => explorerObject({ kind: 'table', database: owner.name, schema: 'dbo', name: 'Shipments' }, 'dbo.Shipments', { hasChildren: true }),
  ssisFolders: () => explorerObject({ kind: 'ssisFolder', name: 'Sales' }, 'Sales', { hasChildren: true }),
  ssisProjects: owner => explorerObject({ kind: 'ssisProject', ssisFolder: owner.name, name: 'Nightly' }, 'Nightly', { hasChildren: true, sublabel: '(Deployed 2026-10-22 09:30)' })
}
/** The SSIS catalog probe's fingerprints: each view's count 1 and checksum 100, and one more row per extra/ssis* cue. */
function catalogFingerprints() {
  const extra = folder => !!controlDirectory && existsSync(join(controlDirectory, 'extra', folder))
  const views = ['folders', 'projects', 'packages', 'environments', 'variables', 'references', 'parameters', 'properties']
  const more = { folders: extra('ssisFolders') ? 1 : 0, projects: extra('ssisProjects') ? 1 : 0 }
  return views.flatMap(view => [{ id: view + 'Count', value: 1 + (more[view] ?? 0) }, { id: view + 'Checksum', value: 100 + 7 * (more[view] ?? 0) }])
}
function explorerObject(object, label, fields = {}) { return { ref: { type: 'object', object }, label, icon: kindSpecs[object.kind].icon, hasChildren: false, ...fields } }
async function explorerChildren({ node, subtype }) {
  const owner = node.type === 'object' ? node.object : node.owner
  const statics = staticChildren(node.type === 'object' ? { kind: node.object.kind, subtype } : { folder: node.folder }, explorerProfile)
    .map(folder => ({ ref: { type: 'folder', owner, folder }, label: folderSpecs[folder].label, icon: 'folder', hasChildren: true }))
  if (node.type === 'folder' && node.folder === 'audits' && !await controlled(join('allow', 'audits'))) {
    return { nodes: statics, elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to view Audits.', retryable: true } }
  }
  // A folder lists its rows; an object whose kind lists rows (the SSIS catalog's folders) lists them after its folders.
  const list = node.type === 'folder' ? node.folder : kindSpecs[node.object.kind].list
  const extra = node.type === 'folder' && explorerExtras[node.folder] && await controlled(join('extra', node.folder)) ? [explorerExtras[node.folder](owner)] : []
  const nodes = [...statics, ...(list ? explorerRows[list]?.(owner) ?? [] : []), ...extra]
  return { nodes, total: nodes.length, elapsedMs: 1 }
}
// Stored results of this process (one backend generation), by resultId, as the real result store keeps them. Rows come
// from `rowAt`; pages are encoded per block of `pageRows` when first read (a few are kept), so a million-row set costs
// nothing until it is read. While a set streams, only whole blocks are readable, like the real store's sealed pages.
const stored = new Map()
let nextResultId = 1
const globalBytes = 256 * 1024 * 1024
// The bytes each result pretends to hold: a directive's `memory=` share of the budget, split across its result sets. They
// count until results.close releases them or the tab's next script replaces them (as ResultStore.BeginQuery does), and
// usage is their sum across tabs.
const heldBytes = new Map()
const sessionResults = new Map()
const usedBytes = () => { let used = 0; for (const bytes of heldBytes.values()) used += bytes; return used }
/** A new script on a session releases that session's earlier results. */
function beginQuery(sessionId) {
  for (const resultId of sessionResults.get(sessionId) ?? []) heldBytes.delete(resultId)
  sessionResults.set(sessionId, [])
}
// What the status bar was last shown, by an event or a summary. As SqlService.ReportMemory does, an event goes out only
// for a new band (50, 75, 90, 100 %), a 64 MiB rise, or any fall below it. Events and summary budgets share one sequence.
let reported = { bytes: -1, band: 0 }
let memorySeq = 0
const band = used => used >= globalBytes ? 4 : used * 10 >= globalBytes * 9 ? 3 : used * 4 >= globalBytes * 3 ? 2 : used * 2 >= globalBytes ? 1 : 0
function reportMemory() {
  const used = usedBytes()
  if (reported.bytes < 0 ? used === 0 : used >= reported.bytes && band(used) === reported.band && used - reported.bytes < 64 * 1024 * 1024) return
  reported = { bytes: used, band: band(used) }
  write(FrameKind.EVENT, 0, 0, { type: 'results.memory', usedBytes: used, globalBytes, seq: ++memorySeq })
}
/** A summary's budget, which counts as reported (SqlService.SummaryBudget). */
function summaryBudget() {
  const used = usedBytes()
  reported = { bytes: used, band: band(used) }
  return { usedBytes: used, globalBytes, queryBytes: globalBytes / 2, seq: ++memorySeq }
}
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
// What a script printed (PRINT, RAISERROR), and SQL Server's other messages (STATISTICS, warnings), as the real backend marks them.
const print = text => ({ text, kind: 'print' })
const server = text => ({ text, kind: 'server' })
const summary = (id, database, sets, patch = {}) => ({
  resultSets: storeResults(id, sets), discardedResultSets: 0, messages: [], recordsAffected: -1, elapsedMs: 1, status: 'completed', completedBatches: 1, totalBatches: 1,
  database, messagesTruncated: false, budget: summaryBudget(), completedAt: new Date().toISOString().replace('Z', '0000+00:00'), ...patch
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
  // The share is split across the sets kept; the first takes the remainder, so the sum is exact.
  const share = Math.round((directive.memory ?? 0) * globalBytes), kept = Math.min(directive.sets.length, maxSets)
  let status = 'completed'
  try {
    for (const [index, set] of directive.sets.entries()) {
      const shape = shapes[set.shape]
      if (index >= maxSets) { discarded.push(set); continue }
      const result = storeResult({ columns: shape.columns, rowAt: shape.row, pageRows: shape.pageRows, read: set.rate === undefined ? set.rows : 0, complete: false }, index)
      results.push(result)
      if (share > 0) {
        heldBytes.set(result.resultId, Math.floor(share / kept) + (index === 0 ? share % kept : 0))
        sessionResults.get(params.sessionId)?.push(result.resultId)
        reportMemory()
      }
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
      ...Array.from({ length: directive.messages }, (_, i) => print(`Message ${i + 1}`)),
      ...Array.from({ length: directive.errors }, (_, i) => ({ text: `Msg 50000, Level 16, State 1, Line ${i + 1}\nFake error ${i + 1}.`, kind: 'error' }))
    ].slice(0, 1000)
    if (status === 'cancelled') messages.push({ text: 'The script was cancelled. Remaining batches were not executed.', kind: 'error' })
    if (messages.length) write(FrameKind.EVENT, id, 0, { type: 'messages', messages })
    while (directive.hold && !cancelledQueries.has(queryId) && await controlled(join('hold', 'query.execute'))) await sleep(25)
    if (status === 'completed' && cancelledQueries.has(queryId)) status = 'cancelled'
    // Its one batch ran to its end, so errors leave the run completed with errors, as SqlService reports one.
    const failed = status === 'completed' && directive.errors > 0
    respond(id, {
      resultSets: results.map(describe), discardedResultSets: discarded.length, messages, recordsAffected: -1, elapsedMs: 1, status: failed ? 'completedWithErrors' : status,
      ...failed ? { error: { code: 'SQL_ERROR', message: messages.find(message => message.kind === 'error').text, batchNumber: 1, iteration: 1 } } : {},
      ...status === 'cancelled' ? { error: { code: 'CANCELLED', message: 'The script was cancelled. Remaining batches were not executed.', batchNumber: 1, iteration: 1 } } : {},
      completedBatches: status === 'completed' ? 1 : 0, totalBatches: 1, database: params.database, messagesTruncated: false,
      budget: summaryBudget(), completedAt: new Date().toISOString().replace('Z', '0000+00:00'), ...probe(params.sessionId)
    })
  } finally {
    runningDirectives.delete(queryId)
    cancelledQueries.delete(queryId)
  }
}

const fixtures = {
  BATCH_STATS_FIXTURE: (id, params) => summary(id, params.database, [{ columns: [column('retained', 'int')], rows: [['42']], batchNumber: 1, iteration: 1 }], {
    // As the real backend logs them: statistics, then the batch's error in SSMS's two-line form, and the third batch still runs.
    messages: [server('SQL Server Execution Times: CPU time = 1 ms, elapsed time = 2 ms.'), server("Table '#temp'. Scan count 1, logical reads 2."),
      { text: 'Msg 137, Level 15, State 2, Line 8\nMust declare the scalar variable.', kind: 'error' }, info('Batch 2 raised an error; execution continued with the next batch.'),
      print('third batch')], elapsedMs: 3, status: 'completedWithErrors',
    error: { code: 'SQL_ERROR', message: 'Msg 137, Level 15, State 2, Line 8\nMust declare the scalar variable.', batchNumber: 2, iteration: 1 }, completedBatches: 3, totalBatches: 3
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

/** Workbench live.subscribe for debug.synthetic's metrics, table and status probes, as Live/SyntheticSampler.cs behaves, and for ssis.operations. */
function liveSubscribe(id, credit, params) {
  if (credit === undefined) return fail(id, 'INVALID_PARAMS', 'A live subscription is a stream: it needs credit.')
  const explorer = params.source === 'explorer' && Array.isArray(params.probes) && explorerStatus() !== undefined, ssis = params.source === 'ssis.catalog'
  const operations = params.source === 'ssis.operations'
  if ((params.source !== 'debug.synthetic' && params.source !== 'activity' && !explorer && !ssis && !operations) || !Array.isArray(params.probes)) return fail(id, 'INVALID_PARAMS', 'Unknown live source.')
  if (!explorer && params.probes.some(probe => !(params.source === 'activity' ? liveProbes[probe.probe]?.source === 'activity' : ssis ? probe.probe === 'ssis.catalogProbe' : operations ? probe.probe === ssisOperationsProbe : syntheticProbes.includes(probe.probe)))) return fail(id, 'INVALID_PARAMS', 'The fake backend does not implement this probe.')
  if (explorer && !workbenchConnections.has(params.connectionId)) return fail(id, 'NOT_CONNECTED', 'Connect to a SQL Server first.')
  if ([...lives.values()].some(live => live.subscriptionId === params.subscriptionId)) return fail(id, 'DUPLICATE_REQUEST', 'This live view is already open.')
  const now = Date.now()
  const live = {
    id, subscriptionId: params.subscriptionId, connectionId: params.connectionId, initial: credit, available: credit, args: { ...params.args }, paused: false,
    probes: new Map(params.probes.map(probe => [probe.probe, { ...probe, dueAt: now, last: -1, resumed: false, samples: 0, tracks: new Map() }])),
    seq: 0, ticks: 0, revisions: [], previous: new Map(), timer: undefined, started: now, sampledAt: 0, source: params.source, kept: new Map(),
    // As the real source does when the catalog's database does not exist: its first tick reports it, and the view ends.
    missing: operations ? ssisFailures[workbenchConnections.get(params.connectionId)?.server] : undefined
  }
  live.grant = more => { live.available += more; wakeLive(live) }
  live.end = (ended, error) => {
    clearTimeout(live.timer)
    const kept = ended === 'sourceEnded' ? live.revisions.slice(-1) : []
    for (const resultId of live.revisions) if (!kept.includes(resultId)) stored.delete(resultId)
    for (const ids of live.kept.values()) for (const resultId of ids) stored.delete(resultId)
    respond(id, { ended, ...error, ...(ended === 'sourceEnded' ? { kept } : {}), ticks: live.ticks, elapsedMs: Date.now() - live.started })
  }
  lives.set(id, live)
  if (params.source === 'activity') {
    const denied = workbenchConnections.get(params.connectionId)?.server === 'no-permission'
    const states = new Map([...live.probes.keys()].map(probe => [probe, pendingProbes[probe] ? { state: 'unavailable', reason: 'NOT_SUPPORTED', note: pendingProbes[probe] }
      : denied && liveProbes[probe].permission === 'serverState' ? { state: 'unavailable', reason: 'PERMISSION_DENIED', note: 'The login lacks VIEW SERVER PERFORMANCE STATE.' } : { state: 'ok' }]))
    for (const [probe, state] of states) if (state.state === 'unavailable') live.probes.get(probe).unavailable = true
    sendLive(live, { type: 'live.opened', seq: 0, source: 'activity', probes: [...live.probes.values()].map(probe => ({ probe: probe.probe, intervalMs: probe.intervalMs, minIntervalMs: liveProbes[probe.probe].intervalMs.min, maxIntervalMs: liveProbes[probe.probe].intervalMs.max, ...states.get(probe.probe) })) })
  } else sendLive(live, explorer ? explorerOpened([...live.probes.keys()])
    : operations ? { ...opened([...live.probes.keys()], params.source), isolation: 'readUncommitted', probes: [...live.probes.values()].map(probe => ({ probe: probe.probe, intervalMs: probe.intervalMs, minIntervalMs: 1000, maxIntervalMs: 60_000, state: 'ok' })) }
    : opened([...live.probes.keys()], params.source))
  wakeLive(live)
}
const explorerOpened = probes => ({ type: 'live.opened', seq: 0, source: 'explorer', probes: probes.map(probe => ({ probe, intervalMs: liveProbes[probe].intervalMs.default, minIntervalMs: liveProbes[probe].intervalMs.min, maxIntervalMs: liveProbes[probe].intervalMs.max, state: 'ok' })) })
/** explorer-status.json, or undefined while there is none (or it does not parse). */
function explorerStatus() {
  if (!controlDirectory) return undefined
  try { return JSON.parse(readFileSync(join(controlDirectory, 'explorer-status.json'), 'utf8')) } catch { return undefined }
}
/** One explorer probe's sample: its table as a new stored revision (two kept per probe), or the Agent count. */
function explorerSample(live, probe) {
  const status = explorerStatus() ?? {}
  if (probe.probe === 'explorer.agent') return { metrics: [status.jobs ?? 0] }
  const rows = (probe.probe === 'explorer.databases' ? status.databases : probe.probe === 'explorer.progress' ? status.progress : status.groups) ?? []
  const columns = liveProbes[probe.probe].tables[0].columns.map(column => ({ name: column.name, dataType: column.dataType, wire: 'text', nullable: true }))
  const result = storeResult({ columns, rows: rows.map(row => row.map(cell => String(cell))) }, 0)
  const kept = live.kept.get(probe.probe) ?? []
  kept.push(result.resultId)
  const retired = kept.length > 2 ? [kept.shift()] : undefined
  if (retired) stored.delete(retired[0])
  live.kept.set(probe.probe, kept)
  return { tables: [{ table: 0, descriptor: describe(result), revision: probe.samples, ...(retired ? { retired } : {}) }] }
}
/** An overview sample: every series of the catalogue, a rate's first sample (and the first after a pause) without a value. */
function overviewMetrics(n, first) {
  const blocked = !!controlDirectory && existsSync(join(controlDirectory, 'activity-blocked'))
  const wave = Math.sin(n / 3)
  const values = {
    cpuPercent: 35 + 20 * wave, schedulerDelay: 4 + wave, waitingTasks: 2_100 + 400 * wave, ioMegabytes: (3 + wave) * 1_048_576, readLatency: 4, writeLatency: 2, batchRequests: 950 + 50 * wave,
    compilations: 12, recompilations: 1, blockedSessions: blocked ? 2 : 0, longestBlock: blocked ? 41_200 : 0, activeRequests: 12, userSessions: 87, logins: 3, runnablePerScheduler: 0.4,
    workQueue: 0, grantsPending: 0, grantsOutstanding: 2, pageLifeExpectancy: 5_412, deadlocks: 0, lockWaits: 1
  }
  return liveProbes['activity.overview'].series.map(series => first && series.counter !== 'gauge' ? null : values[series.id] ?? null)
}
function sendLive(live, value) {
  const body = encodeControl(value)
  live.available -= body.length
  process.stdout.write(encodeFrame(FrameKind.EVENT, live.id, 0, body))
}
const periodOf = (live, probe) => probe.probe === 'ssis.catalogProbe' ? 200 : live.args.tickMs ?? probe.intervalMs
function wakeLive(live) {
  clearTimeout(live.timer)
  if (!lives.has(live.id)) return
  const active = live.paused ? [] : [...live.probes.values()].filter(probe => !probe.paused && !probe.unavailable)
  if (active.length === 0) return
  const now = Date.now(), next = Math.min(...active.map(probe => probe.dueAt))
  if (next > now) { live.timer = setTimeout(() => wakeLive(live), next - now); return }
  // Stop-and-wait: nothing is sampled while the previous frame is unacknowledged; its CREDIT wakes the source again.
  if (live.available < live.initial) return
  const samples = [], errors = []
  for (const probe of active.filter(item => item.dueAt <= now)) {
    const period = periodOf(live, probe), missed = Math.floor((now - probe.dueAt) / period)
    const sample = {
      probe: probe.probe, costMs: 0, effectiveIntervalMs: probe.intervalMs, ...(probe.last >= 0 ? { elapsedMs: now - probe.last } : {}),
      ...(probe.last < 0 ? { gap: 'baseline' } : probe.resumed ? { gap: 'resumed' } : missed > 0 ? { gap: 'late' } : {}), ...(missed > 0 ? { skipped: missed } : {})
    }
    probe.dueAt += (missed + 1) * period
    probe.last = now
    probe.resumed = false
    const n = ++probe.samples
    if (live.source === 'explorer') samples.push({ ...sample, ...explorerSample(live, probe) })
    else if (probe.probe === 'activity.overview' && controlDirectory && existsSync(join(controlDirectory, 'activity-failing'))) errors.push({ probe: probe.probe, code: 'BLOCKED', message: 'The overview waited too long for a lock and will try again.', retryInMs: probe.intervalMs, terminal: false })
    else if (probe.probe === 'activity.overview') samples.push({ ...sample, metrics: overviewMetrics(n, sample.gap === 'baseline' || sample.gap === 'resumed') })
    else if (live.source === 'activity') samples.push(sample)
    else if (probe.probe === 'debug.synthetic.metrics') samples.push({ ...sample, metrics: [n, 50 + 50 * Math.sin(n / 4), sample.elapsedMs === undefined || sample.gap === 'resumed' ? null : (50 + 50 * Math.sin(n / 4)) * 1000 / Math.max(1, sample.elapsedMs)] })
    else if (probe.probe === ssisOperationsProbe && live.missing) errors.push({ probe: probe.probe, ...live.missing, retryInMs: 0, terminal: true })
    else if (probe.probe === ssisOperationsProbe) samples.push({ ...sample, ...ssisSample(live, probe, n) })
    else if (probe.probe === 'debug.synthetic.status') samples.push({ ...sample, status: [{ id: 'phase', value: n % 2 === 0 ? 'even' : 'odd' }, { id: 'samples', value: n }] })
    else if (probe.probe === 'ssis.catalogProbe') { const { gap, ...rest } = sample; samples.push({ ...rest, ...gap === 'late' ? { gap } : {}, status: catalogFingerprints() }) }
    else if (live.args.errorEvery && n % live.args.errorEvery === 0) errors.push({ probe: probe.probe, code: 'SQL_ERROR', message: 'The synthetic source failed this sample, as the test asked.', retryInMs: probe.intervalMs, terminal: false })
    else samples.push({ ...sample, tables: [liveTable(live, probe, n)] })
  }
  live.sampledAt = Math.max(live.sampledAt + 1, Date.now())
  sendLive(live, { type: 'live.tick', seq: ++live.seq, sampledAt: live.sampledAt, samples, ...(errors.length ? { errors } : {}) })
  live.ticks++
  if (live.args.endAfterTicks && live.ticks >= live.args.endAfterTicks) { lives.delete(live.id); return live.end('sourceEnded') }
  if (live.missing) { lives.delete(live.id); return live.end('failed', live.missing) }
  wakeLive(live)
}
/** One snapshot revision: ids n … n + rows − 1, sorted as asked (the id breaks ties), stored as a result. */
function liveTable(live, probe, n) {
  let rows = Array.from({ length: live.args.rows ?? 3 }, (_, offset) => ({ id: n + offset, label: 'Row ' + (n + offset), value: (n + offset) * 37 % 100 + n % 7 }))
  if (probe.sort) rows = rows.sort((a, b) => { for (const key of probe.sort) { const left = a[key.column], right = b[key.column]; if (left !== right) return (left < right ? -1 : 1) * (key.descending ? -1 : 1) } return a.id - b.id })
  const columns = [['id', 'int'], ['label', 'nvarchar'], ['value', 'int']].map(([name, dataType]) => ({ name, dataType, wire: 'text', nullable: false }))
  const result = storeResult({ columns, rows: rows.map(row => [String(row.id), row.label, String(row.value)]) }, 0)
  live.revisions.push(result.resultId)
  const retired = live.revisions.length > 2 ? [live.revisions.shift()] : undefined
  if (retired) stored.delete(retired[0])
  const current = new Map(rows.map(row => [row.id, row.value]))
  const diff = { added: [...current.keys()].filter(key => !live.previous.has(key)).length, removed: [...live.previous.keys()].filter(key => !current.has(key)).length, changed: [...current].filter(([key, value]) => live.previous.has(key) && live.previous.get(key) !== value).length }
  live.previous = current
  const track = probe.tracks.get(0)
  const tracked = track && { seq: track.seq, rows: track.keys.map(key => rows.findIndex(row => String(row.id) === key)) }
  return { table: 0, descriptor: describe(result), revision: n, ...(retired ? { retired } : {}), diff, ...(tracked ? { tracked } : {}) }
}
const ssisOperationsProbe = 'ssis.operations.list'
/** Servers whose catalog a subscription cannot open, and how its first tick says so before the view ends (as the real source's terminal probe errors do). */
const ssisFailures = {
  'no-ssisdb': { code: 'CATALOG_MISSING', message: 'This server has no SSIS Catalog (it may have been deleted).' },
  'ssis-denied': { code: 'PERMISSION_DENIED', message: 'This login cannot read the SSIS Catalog. Ask for access to the catalog\'s database, or connect with a login that has it.' }
}
const ssisColumns = liveProbes[ssisOperationsProbe].tables[0].columns.map(spec => ({ name: spec.name, dataType: spec.dataType, wire: 'text', nullable: true, ...spec.role ? { role: spec.role } : {} }))
const ssisCatalogs = new Map()
const operationTime = date => date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +00:00')
/** A connection's fake catalog: eight operations of every kind, newest last; a running execution, a pending validation. */
function ssisCatalogOf(connectionId) {
  let catalog = ssisCatalogs.get(connectionId)
  if (catalog) return catalog
  const at = minutes => operationTime(new Date(Date.UTC(2026, 9, 27, 9, 0) + minutes * 60_000))
  const operation = (id, type, status, folder, project, name, started, minutes, caller = 'CORP\\etl') => ({ id, type, status, folder, project, package: name, object: project, start: at(started), end: openStatuses.includes(status) ? null : at(started + minutes), caller, stoppedBy: null })
  catalog = { next: 109, samples: 0, operations: [
    operation(101, 101, 7, null, 'Loads', null, 0, 1, 'CORP\\dba'), operation(102, 200, 7, 'Finance', 'Loads', 'Daily.dtsx', 5, 3), operation(103, 200, 4, 'Finance', 'Loads', 'Daily.dtsx', 10, 2),
    operation(104, 300, 7, 'Finance', 'Loads', null, 15, 1), operation(105, 200, 3, 'Finance', 'Loads', 'Hourly.dtsx', 20, 4), operation(106, 1000, 7, null, 'SSISDB', null, 25, 1, 'CORP\\dba'),
    operation(107, 301, 5, 'Finance', 'Loads', 'Daily.dtsx', 30, 0), operation(108, 200, 2, 'Finance', 'Loads', 'Daily.dtsx', 35, 0)
  ] }
  ssisCatalogs.set(connectionId, catalog)
  return catalog
}
const ssisLabel = (codes, code) => codes.find(item => item.code === code)?.label ?? `Unknown (${code})`
const ssisKindOf = type => Object.entries(operationKindSpecs).find(([, spec]) => spec.types.includes(type))?.[0] ?? 'other'
function ssisPasses(args, operation) {
  const name = (filter, value) => filter === undefined || (value !== null && (args.prefix ? value.startsWith(filter) : value === filter))
  return (!args.kinds || args.kinds.includes(ssisKindOf(operation.type))) && (!args.statuses || args.statuses.includes(operation.status))
    && name(args.folder, operation.folder) && name(args.project, operation.project) && name(args.package, operation.package) && (args.caller === undefined || operation.caller === args.caller)
}
/** One sample: stops on their way end Canceled, every fourth sample starts a new execution, then the window as a snapshot, the tiles and the newest id. */
function ssisSample(live, probe, n) {
  const catalog = ssisCatalogOf(live.connectionId)
  catalog.samples++
  for (const operation of catalog.operations) if (operation.status === 8 && operation.stopSample < catalog.samples) { operation.status = 3; operation.end = operation.start }
  // ssis-quiet in the control directory stops the arrivals, so a test can click a row that stays put.
  if (catalog.samples % 4 === 0 && !(controlDirectory && existsSync(join(controlDirectory, 'ssis-quiet')))) catalog.operations.push({ id: catalog.next++, type: 200, status: 2, folder: 'Finance', project: 'Loads', package: 'Hourly.dtsx', object: 'Loads', start: operationTime(new Date()), end: null, caller: 'CORP\\etl', stoppedBy: null })
  const rows = catalog.operations.filter(operation => ssisPasses(live.args, operation)).sort((a, b) => b.id - a.id).slice(0, live.args.limit ?? 1000)
  const tone = status => operationStatuses.find(item => item.code === status)?.tone ?? null
  const text = operation => [String(operation.id), ssisLabel(operationTypes, operation.type), ssisLabel(operationStatuses, operation.status), operation.folder, operation.project, operation.package,
    operation.object, operation.start, operation.end, operation.end ? '0:01:00.000' : '0:00:30.000', operation.caller, operation.stoppedBy, 'SQL01', 'SQL01', tone(operation.status)]
  const result = storeResult({ columns: ssisColumns, rows: rows.map(text) }, 0)
  live.revisions.push(result.resultId)
  const retired = live.revisions.length > 2 ? [live.revisions.shift()] : undefined
  if (retired) stored.delete(retired[0])
  const current = new Map(rows.map(operation => [operation.id, operation.status]))
  const diff = { added: [...current.keys()].filter(key => !live.previous.has(key)).length, removed: [...live.previous.keys()].filter(key => !current.has(key)).length, changed: [...current].filter(([key, value]) => live.previous.has(key) && live.previous.get(key) !== value).length }
  live.previous = current
  const track = probe.tracks.get(0)
  const tracked = track && { seq: track.seq, rows: track.keys.map(key => rows.findIndex(operation => String(operation.id) === key)) }
  const counts = operationTiles.map(tile => catalog.operations.filter(operation => tile.statuses.includes(operation.status)).length)
  return { metrics: counts, status: [{ id: 'newest', value: rows[0]?.id ?? 0 }], tables: [{ table: 0, descriptor: describe(result), revision: n, ...(retired ? { retired } : {}), diff, ...(tracked ? { tracked } : {}) }] }
}
/** ssis.execute's stopOperation against the fake catalog, as SsisActionService's preflight and the catalog answer. */
function ssisExecute(params) {
  const operationId = params.action.operationId, subject = `Operation ${operationId}`
  const error = (code, message) => ({ steps: [], elapsedMs: 1, error: { code, message, retryable: false } })
  const catalog = ssisCatalogOf(params.connectionId)
  const operation = catalog.operations.find(item => item.id === operationId)
  if (!operation) return error('NOT_FOUND', subject + ' does not exist, or you may not read it.')
  if (![200, 300, 301].includes(operation.type)) return error('NOT_SUPPORTED', subject + ' cannot be stopped: only executions and validations can be stopped.')
  if (operation.status === 8) return error('ALREADY_FINAL', subject + ' is already stopping.')
  if (!openStatuses.includes(operation.status)) return error('ALREADY_FINAL', subject + ' has already ended (' + ssisLabel(operationStatuses, operation.status) + ').')
  if (operation.status === 1) return error('NOT_STARTED', subject + ' was created but has not been started, so there is nothing to stop.')
  // Stopping for the next sample, which shows it; Canceled from the one after.
  Object.assign(operation, { status: 8, stoppedBy: 'FAKE\\smoke', stopSample: catalog.samples + 1 })
  return { steps: [{ status: 'done' }], elapsedMs: 1 }
}
function liveUpdate(id, params) {
  const live = [...lives.values()].find(item => item.subscriptionId === params.subscriptionId && item.grant && item.probes)
  if (!live) return fail(id, 'NOT_FOUND', 'This live view has ended.')
  const now = Date.now()
  const resume = probe => { probe.dueAt = now; probe.resumed = probe.last >= 0 }
  for (const patch of params.probes ?? []) {
    const probe = live.probes.get(patch.probe)
    if (!probe) return fail(id, 'INVALID_PARAMS', 'The probe is not part of this subscription.')
    if (patch.intervalMs !== undefined) probe.intervalMs = patch.intervalMs
    if (patch.paused !== undefined) { if (probe.paused && !patch.paused) resume(probe); probe.paused = patch.paused }
    if (patch.sort !== undefined) probe.sort = patch.sort
    if (patch.clear?.includes('sort')) probe.sort = undefined
  }
  for (const track of params.track ?? []) live.probes.get(track.probe)?.tracks.set(track.table, track)
  if (params.args) live.args = live.source === 'ssis.operations' ? { ...params.args } : { ...live.args, ...params.args }
  if (params.paused !== undefined) { if (live.paused && !params.paused) for (const probe of live.probes.values()) resume(probe); live.paused = params.paused }
  if (params.refresh) for (const probe of live.probes.values()) if (!probe.paused) probe.dueAt = Math.min(probe.dueAt, now)
  respond(id, { applied: true, probes: [...live.probes.values()].map(probe => ({ probe: probe.probe, intervalMs: probe.intervalMs, effectiveIntervalMs: probe.intervalMs, paused: live.paused || !!probe.paused })) })
  wakeLive(live)
}

// The SSIS Catalog's objects in the explorer fixture, as ssis.describe reads them: the folder Finance, its project Loads (the
// entry point Daily.dtsx and Child.dtsx) and its environment Test. Times keep the catalog's own offset (+02:00), and a
// sensitive parameter or variable has no value, as the backend never reads one. ssis/missing makes every object
// NOT_FOUND, as when it was deleted elsewhere, and ssis/fail fails every read with a retryable TIMEOUT; ssis/many fills the
// project's three lists to the 2,048 rows one read returns, with long descriptions, as a truncated answer; hold/ssis.describe
// holds a read until the file goes or a CANCEL frame ends it (logged to cancels.jsonl).
const ssisTime = '2026-10-21T14:05:06.1234567+02:00'
const ssisParameter = (name, fields = {}) => ({ name, dataType: 'String', required: false, sensitive: false, valueType: 'V', valueSet: false, ...fields })
const ssisModels = {
  folder: target => ({ view: 'folder', id: 1, name: target.name, description: 'Nightly finance loads', createdBy: 'CONTOSO\\etl', created: ssisTime, projects: 1, environments: 1 }),
  project: target => ({
    view: 'project', id: 3, folder: target.ssisFolder, name: target.name, description: 'Loads the ledger', formatVersion: 1, deployedBy: 'CONTOSO\\etl', deployed: ssisTime, created: ssisTime,
    versionLsn: 42, validationStatus: 'N', packages: [{ name: 'Daily.dtsx', entryPoint: true, version: '1.0.7' }, { name: 'Child.dtsx', entryPoint: false, version: '1.0.2', description: 'Called by Daily' }],
    parameters: [ssisParameter('Server', { required: true, designDefault: 'localhost', value: 'sql01', valueSet: true }), ssisParameter('Password', { sensitive: true, valueSet: true }),
      ssisParameter('Port', { dataType: 'Int32', valueType: 'R', valueSet: true, variable: 'Port' })],
    references: [{ id: 7, type: 'R', environment: 'Test', validationStatus: 'N' }], truncated: false
  }),
  package: target => ({
    view: 'package', id: 11, folder: target.ssisFolder, project: target.ssisProject, name: target.name, formatVersion: 8, version: '1.0.7', versionComments: 'Adds the ledger step',
    entryPoint: target.name !== 'Child.dtsx', validationStatus: 'N', parameters: [ssisParameter('Rows', { dataType: 'Int64', designDefault: '9000000000' })], truncated: false
  }),
  environment: target => ({
    view: 'environment', id: 5, folder: target.ssisFolder, name: target.name, description: 'Test servers', createdBy: 'CONTOSO\\etl', created: ssisTime,
    variables: [{ name: 'Port', type: 'Int32', sensitive: false, value: '1433' }, { name: 'Secret', type: 'String', sensitive: true, description: 'Never read' }], truncated: false
  })
}
/** The project at the cap of every list (ssisLimits.rows), each row with a 200-character description or value. */
const ssisMany = (model, rows = 2048) => ({
  ...model, truncated: true,
  packages: Array.from({ length: rows }, (_, index) => ({ name: `Package ${index + 1}.dtsx`, entryPoint: index % 7 === 0, version: `1.0.${index}`, description: `Package ${index + 1} `.padEnd(200, 'x') })),
  parameters: Array.from({ length: rows }, (_, index) => ssisParameter(`Parameter ${index + 1}`, { valueSet: true, ...index % 5 === 0 ? { sensitive: true } : { value: `Value ${index + 1} `.padEnd(200, 'v') } })),
  references: Array.from({ length: rows }, (_, index) => ({ id: index + 1, type: index % 2 ? 'A' : 'R', ...index % 2 ? { folder: 'Shared' } : {}, environment: `Environment ${index + 1}`, validationStatus: 'N' }))
})
async function ssisDescribe(id, { view, target }) {
  while (await controlled(join('hold', 'ssis.describe'))) {
    if (cancelled.delete(id)) {
      if (controlDirectory) appendFileSync(join(controlDirectory, 'cancels.jsonl'), JSON.stringify({ method: 'ssis.describe' }) + '\n')
      return fail(id, 'CANCELLED', 'The operation was cancelled.')
    }
    await sleep(25)
  }
  if (await controlled(join('ssis', 'fail'))) return respond(id, { elapsedMs: 1, error: { code: 'TIMEOUT', message: 'The SSIS Catalog did not answer in time.', retryable: true } })
  if (await controlled(join('ssis', 'missing'))) return respond(id, { elapsedMs: 1, error: { code: 'NOT_FOUND', message: `The ${view} ${target.name} no longer exists in the SSIS Catalog.`, retryable: false } })
  const model = ssisModels[view](target)
  return respond(id, { model: view === 'project' && await controlled(join('ssis', 'many')) ? ssisMany(model) : model, revision: 'a'.repeat(64), elapsedMs: 1 })
}

/** A sign-in waiting for the browser: the request ends only when a CANCEL frame names it (logged to cancels.jsonl). */
async function entraWait(id, method) {
  while (!cancelled.has(id)) await sleep(25)
  cancelled.delete(id)
  if (controlDirectory) appendFileSync(join(controlDirectory, 'cancels.jsonl'), JSON.stringify({ method }) + '\n')
  fail(id, 'CANCELLED', 'The operation was cancelled.')
}

async function workbench(id, method, params, credit) {
  if (controlDirectory) {
    const redacted = params?.password === undefined ? params : { ...params, password: '<redacted>' }
    const line = JSON.stringify({ generation, method, params: method === 'entra.cache.import' && redacted?.data !== undefined ? { ...redacted, data: '<redacted>' } : redacted }) + '\n'
    const entry = logged.then(() => appendFile(join(controlDirectory, 'calls.jsonl'), line))
    logged = entry.catch(() => {})
    await entry
  }
  // A directive's `hold` and an export's hold apply later, after their first output.
  const directive = method === 'query.execute' ? parseDirective(params.sql) : undefined
  if (!directive?.hold && method !== 'results.export' && method !== 'ssis.describe') while (await controlled(join('hold', method))) await sleep(25)
  switch (method) {
    case 'system.health': return respond(id, { protocolVersion: 2, runtime: 'fake', platform: process.platform, smoVersion: 'fake', sqlClientVersion: 'fake' })
    case 'connections.connect': {
      if (params.server === 'entra-wait') return entraWait(id, method)
      if (params.server === 'password-check' && !params.trustServerCertificate && await controlled('untrusted-certificate')) {
        return write(FrameKind.RESPONSE, id, 0, { error: { code: 'SQL_ERROR', message: 'The certificate chain was issued by an authority that is not trusted.', details: { number: -2146893019, state: 0, class: 20, server: params.server, reason: 'certificate' } } })
      }
      if (params.server === 'password-check' && (params.password !== 'correct-horse-marker' || await controlled('reject-passwords'))) return write(FrameKind.RESPONSE, id, 0, { error: { code: 'SQL_ERROR', message: "Login failed for user 'reader'.", details: { number: 18456, state: 1, class: 14, server: params.server } } })
      // The name and colour come back as the backend echoes them; the environment stays in the renderer's options.
      const info = { id: crypto.randomUUID(), server: params.server, database: params.database || 'master', serverVersion: '16.0.fake', commandTimeout: params.advanced?.commandTimeout ?? 0, ...params.displayName ? { displayName: params.displayName } : {}, ...params.color ? { color: params.color } : {},
        ...params.server === 'no-permission' && params.username ? { login: params.username } : {} }
      workbenchConnections.set(info.id, info)
      return respond(id, info)
    }
    case 'connections.databases':
      if (params.server === 'entra-wait') return entraWait(id, method)
      if (params.server === 'password-check' && (params.password !== 'correct-horse-marker' || await controlled('reject-passwords'))) return write(FrameKind.RESPONSE, id, 0, { error: { code: 'SQL_ERROR', message: "Login failed for user 'reader'.", details: { number: 18456, state: 1, class: 14, server: params.server } } })
      return respond(id, await databaseRows())
    case 'connections.discover': return respond(id, { servers: [] })
    case 'entra.cache.clear': return respond(id, { cleared: true })
    case 'live.subscribe': return liveSubscribe(id, credit, params)
    case 'live.update': return liveUpdate(id, params)
    case 'connections.preview': return respond(id, { connectionString: 'Data Source=' + params.server })
    case 'connections.disconnect':
      for (const [sessionId, session] of sessions) if (session.connectionId === params.connectionId) sessions.delete(sessionId)
      for (const live of [...lives.values()]) if (live.connectionId === params.connectionId) endLive(live, 'disconnected')
      return respond(id, { disconnected: workbenchConnections.delete(params.connectionId) })
    case 'query.session.close': {
      if (params.transaction === 'commit' && sessions.get(params.sessionId)?.transactions && await controlled('fail-commit')) {
        return fail(id, 'SQL_ERROR', 'The transaction was not committed, and the query stays open. Msg 3930, Level 16, State 1\nThe current transaction cannot be committed.')
      }
      return respond(id, { closed: sessions.delete(params.sessionId) })
    }
    case 'query.session.state': {
      const session = sessions.get(params.sessionId)
      if (!session) return fail(id, 'SESSION_CLOSED', 'This query has no open SQL session.')
      if ([...waitingScripts.values()].some(script => script.sessionId === params.sessionId)) return fail(id, 'SESSION_BUSY', 'A query is running in this tab.')
      return respond(id, session.compileOnly.size ? { transactionCount: 0, checked: false } : { transactionCount: session.transactions, checked: true })
    }
    case 'query.cancel': {
      const script = waitingScripts.get(params.queryId)
      waitingScripts.delete(params.queryId)
      if (script) respond(script.id, summary(script.id, script.database, [], { status: 'cancelled', ...probe(script.sessionId) }))
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
      for (const resultId of params.resultIds) heldBytes.delete(resultId)
      if (closed) reportMemory()
      return respond(id, { closed, usedBytes: usedBytes() })
    }
  }
  const connection = workbenchConnections.get(params.connectionId)
  if (!connection) return fail(id, 'NOT_CONNECTED', 'Connect to a SQL Server first.')
  switch (method) {
    case 'databases.list': return respond(id, await databaseRows())
    case 'scripting.script': return respond(id, { text: 'CREATE TABLE dbo.Orders (Id int);', database: params.targets[0].database ?? 'master', warnings: [], commands: 1, elapsedMs: 1 })
    // Object actions: Delete Object's row for the target, its DROP script, and one done step.
    case 'actions.describe':
      switch (params.dialog) {
        // Database Properties: a small user database with its options as tokens.
        case 'databaseProperties': return respond(id, { databaseProperties: {
          general: { name: params.target.name, status: 'ONLINE', standby: false, owner: 'sa', created: '2026-01-01T00:00:00.000', sizeMb: 16, users: 4, collation: 'Latin1_General_CI_AS' },
          options: { collation: 'Latin1_General_CI_AS', recoveryModel: 'FULL', compatibilityLevel: '160', containmentType: 'NONE', autoClose: 'false', readOnly: 'false', restrictAccess: 'MULTI_USER' },
          scoped: { maxDop: '0', maxDopForSecondary: 'PRIMARY' }, compatibilityLevels: [100, 110, 120, 130, 140, 150, 160], collations: ['Latin1_General_CI_AS'], logins: ['sa'],
          files: [], filesTruncated: false, filegroups: [], filegroupsTruncated: false,
          server: { level: 16, sysadmin: true, filestreamLevel: 0, pathSeparator: '\\', edition: 3, containedAuthentication: false }, sessions: 0
        }, elapsedMs: 1 })
        // The table designer: the database's schemas and default filegroup.
        case 'tableDesigner': return respond(id, { tableDesigner: { database: params.target.name, band: 16, schemas: ['dbo', 'sales'], schemasTruncated: false, defaultSchema: 'dbo', defaultFilegroup: 'PRIMARY', caseSensitiveNames: false, accentSensitiveNames: true, canCreate: true }, elapsedMs: 1 })
        default: return respond(id, { deleteTarget: { name: [params.target.schema, params.target.name].filter(Boolean).join('.'), type: 'Table', owner: 'dbo', warnings: [], dependentsTruncated: false }, elapsedMs: 1 })
      }
    case 'actions.script':
      switch (params.action) {
        case 'createTable': return respond(id, { text: `CREATE TABLE ${params.design.schema}.${params.design.name}\r\n\t(\r\n\t)  ON [PRIMARY]\r\nGO\r\n`, database: params.target.name, warnings: [] })
        case 'properties': return respond(id, { text: `USE [master]\r\nGO\r\nALTER DATABASE [${params.target.name}] SET RECOVERY SIMPLE WITH NO_WAIT\r\nGO\r\n`, database: 'master', warnings: [] })
        default: return respond(id, { text: 'DROP TABLE [dbo].[Orders]', database: params.target.database ?? 'master', warnings: [] })
      }
    case 'actions.execute': return respond(id, { steps: [{ status: 'done' }], messages: [], elapsedMs: 1 })
    case 'tables.columns': return respond(id, { columns: [{ name: 'Id', dataType: 'int' }, { name: 'CustomerName', dataType: 'nvarchar' }], truncated: false })
    case 'explorer.children': return respond(id, await explorerChildren(params))
    case 'ssis.describe': return ssisDescribe(id, params)
    case 'ssis.execute': return respond(id, ssisExecute(params))
    case 'query.execute': {
      // As the real backend's crash handler does: a best-effort GOAWAY, then exit 70.
      if (await controlled('crash-next', true)) return exitAfter(encodeFrame(FrameKind.GOAWAY, 0, 0, encodeControl({ code: 'BACKEND_CRASH', message: 'The SQL backend failed unexpectedly (Exception).' })), 70)
      beginQuery(params.sessionId)
      runInSession(params)
      if (directive) return runDirective(id, params, directive)
      if (params.sql.includes('WAIT_FOR_CANCEL')) { waitingScripts.set(params.queryId, { id, database: params.database, sessionId: params.sessionId }); return }
      const fixture = Object.keys(fixtures).find(name => params.sql.includes(name))
      if (fixture) return respond(id, { ...fixtures[fixture](id, params), ...probe(params.sessionId) })
      return respond(id, summary(id, params.database, [{ columns: [column('server', 'nvarchar'), column('generation', 'int'), column('database', 'nvarchar')], rows: [[connection.server, String(generation), params.database]] }], probe(params.sessionId)))
    }
  }
  return fail(id, 'METHOD_NOT_FOUND', 'The fake backend does not know ' + method + '.')
}
