import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { BackendSupervisor } from '../src/main/backend/supervisor'
import { ResultsPortHost, supervisorResults, type PortMainLike } from '../src/main/backend/results-port'
import { ResultClient, type PortMessageEvent, type WindowLike, type WorkerLike } from '../src/renderer/src/results/ResultClient'
import { ResultsWorkerCore } from '../src/renderer/src/results/worker-core'
import { legacyExecute } from '../src/renderer/src/results/legacy'
import type { WorkerRequest, WorkerResponse } from '../src/renderer/src/results/worker-protocol'
import type { ConnectionOptions, DisplayQueryResult, QueryOptions } from '../src/shared/contracts'
import type { PortMessage } from '../src/shared/ipc/port-messages'
import { quoteName, selectTopRowsScript } from '../src/shared/sql/identifiers'
import { selectAll, toTsv } from '../src/renderer/src/grid/selection'

const server = process.env.VARIA_TEST_SQL_SERVER, user = process.env.VARIA_TEST_SQL_USER
// Permanent objects (graph tables cannot be temporary) go in a scratch database, created and dropped only when allowed.
const scratch = !!server && process.env.VARIA_TEST_SQL_SCRATCH === '1'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** Node's MessagePort as Electron's MessagePortMain. */
const portMain = (port: MessagePort): PortMainLike => ({
  postMessage: message => port.postMessage(message),
  on: ((event: 'message' | 'close', listener: (event?: { data: unknown }) => void) => event === 'message' ? port.on('message', data => listener({ data })) : port.on('close', () => listener())) as PortMainLike['on'],
  start: () => port.start(),
  close: () => port.close()
})

/** The results worker in this thread: the real core, attached to the port main hands over. */
class InlineWorker implements WorkerLike {
  private readonly listeners: ((event: { data: WorkerResponse }) => void)[] = []
  private port?: MessagePort
  private readonly core = new ResultsWorkerCore({ post: message => queueMicrotask(() => { for (const listener of this.listeners) listener({ data: message }) }) })
  postMessage(message: WorkerRequest): void {
    if (message.type !== 'attach') { this.core.handle(message); return }
    const port = this.port = message.port as unknown as MessagePort
    port.on('message', (data: PortMessage) => this.core.receive(data))
    this.core.attach(port)
  }
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: never): void { if (type === 'message') this.listeners.push(listener) }
  terminate(): void { this.port?.close() }
}

/**
 * The Release backend behind main's real pipeline (BackendSupervisor, ResultsPortHost) and the renderer's (ResultClient,
 * the results worker, the legacy table adapter), connected to the live SQL Server the .NET checks use. Rows reach the
 * test as the results grid shows and copies them: SSMS display text, null for NULL.
 */
async function connect() {
  const supervisor = new BackendSupervisor({ command: 'dotnet', args: [resolve('backend/Varia.Backend/bin/Release/net10.0/Varia.Backend.dll')], cwd: process.cwd(), packaged: false })
  const host = new ResultsPortHost({ backend: supervisorResults(supervisor), createChannel: () => { const { port1, port2 } = new MessageChannel(); return { port1: portMain(port1), port2 } } })
  supervisor.onState(state => host.backendState(state))
  const ready = new Promise<void>((done, fail) => supervisor.onState(state => { if (state.status === 'ready') done(); else if (state.status === 'failed') fail(new Error(state.message)) }))
  supervisor.start()
  cleanups.push(async () => { host.close(); await supervisor.stop() })
  await ready
  const listeners = new Set<(event: PortMessageEvent) => void>()
  const window: WindowLike = { addEventListener: (_type, listener) => { listeners.add(listener) }, removeEventListener: (_type, listener) => { listeners.delete(listener) } }
  const results = new ResultClient({
    window, createWorker: () => new InlineWorker(), schedule: callback => setTimeout(callback, 0),
    // As the preload does: main posts the port to the page's own window.
    api: { openResultsPort: async () => {
      host.open({ postMessage: (_channel, _message, transfer) => { for (const listener of [...listeners]) listener({ source: window, data: { type: 'varia:results-port' }, ports: transfer }) } })
      return { ok: true, value: undefined }
    } }
  })
  cleanups.push(() => results.dispose())
  const options: ConnectionOptions = user
    ? { server: server!, database: 'master', authentication: 'sql', username: user, password: process.env.VARIA_TEST_SQL_PASSWORD, trustServerCertificate: true }
    : { server: server!, database: 'master', authentication: 'windows', trustServerCertificate: true }
  const connection = await supervisor.request('connections.connect', options)
  const sessionId = crypto.randomUUID()
  // As main's varia:request handler runs a script: events to the port, then the results become this page's.
  const execute = async (query: QueryOptions) => {
    const summary = await supervisor.request('query.execute', query, { onEvent: event => host.queryEvent(query.queryId, event) })
    host.own(summary.resultSets)
    return { ok: true as const, value: summary }
  }
  const run = async (sql: string, database = 'master'): Promise<DisplayQueryResult> => {
    const result = await legacyExecute({ execute }, results, { connectionId: connection.id, sessionId, database, sql, queryId: crypto.randomUUID(), maxRows: 1000, timeoutSeconds: 30 })
    if (!result.ok) throw new Error(result.error)
    return result.value
  }
  cleanups.push(async () => {
    await supervisor.request('query.session.close', { sessionId })
    await supervisor.request('connections.disconnect', { connectionId: connection.id })
  })
  return { supervisor, connection, run }
}

describe.runIf(server)('Select Top 1000 Rows against SQL Server', () => {
  it('runs the generated script for a table whose names need quoting', async () => {
    const { run } = await connect()
    const name = `#v]ar'ia; menu ✓ ${crypto.randomUUID().slice(0, 8)}`
    const created = await run(`CREATE TABLE ${quoteName(name)} ([id] int, [na]]me] nvarchar(20) NULL); INSERT ${quoteName(name)} VALUES (1, N'a'), (2, NULL);`, 'tempdb')
    expect(created.status).toBe('completed')
    // The temporary table lives in this session, so the script runs there with the column list the menu would read.
    const script = selectTopRowsScript({ database: 'tempdb', schema: 'dbo', name, columns: [{ name: 'id' }, { name: 'na]me' }], truncated: false })
    expect(script).toContain('      ,[na]]me]')
    const result = await run(script, 'tempdb')
    expect(result.status).toBe('completed')
    expect(result.resultSets).toHaveLength(1)
    expect(result.resultSets[0].columns.map(column => column.name)).toEqual(['id', 'na]me'])
    expect(result.resultSets[0].rows).toEqual([['1', 'a'], ['2', null]])
    // What Copy with Headers puts on the clipboard for the whole grid.
    expect(toTsv(result.resultSets[0], selectAll(0), { headers: true, eol: '\n' })).toBe('id\tna]me\n1\ta\n2\tNULL')
  }, 90_000)
  it('lists a catalogue view\'s columns in order, and selects them by name', async () => {
    const { supervisor, connection, run } = await connect()
    const { columns, truncated } = await supervisor.request('tables.columns', { connectionId: connection.id, database: 'master', schema: 'sys', name: 'objects' })
    expect(truncated).toBe(false)
    expect(columns.slice(0, 2)).toEqual([{ name: 'name', dataType: 'sysname' }, { name: 'object_id', dataType: 'int' }])
    const result = await run(selectTopRowsScript({ database: 'master', schema: 'sys', name: 'objects', columns, truncated }))
    expect(result.status).toBe('completed')
    expect(result.resultSets[0].columns.map(column => column.name)).toEqual(columns.map(column => column.name))
    expect(result.resultSets[0].rows.length).toBeGreaterThan(0)
    await expect(supervisor.request('tables.columns', { connectionId: connection.id, database: 'master', schema: 'sys', name: 'objects]' })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Table was not found.' })
  }, 90_000)
  it.runIf(scratch)('leaves out graph tables\' internal columns, which cannot be selected, and keeps hidden period columns', async () => {
    const { supervisor, connection, run } = await connect()
    // Uniquely named and marked, so a leftover is recognisable.
    const database = 'varia_scratch_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12)
    const created = await run(`CREATE DATABASE ${quoteName(database)}; EXEC ${quoteName(database)}.sys.sp_addextendedproperty @name = N'varia_test_scratch', @value = N'explorer-live';`)
    expect(created.status).toBe('completed')
    try {
      const tables = await run([
        'CREATE TABLE dbo.Person (id int PRIMARY KEY, name nvarchar(20) NULL) AS NODE;',
        'CREATE TABLE dbo.Knows (since int NULL) AS EDGE;',
        'CREATE TABLE dbo.Account (id int PRIMARY KEY, valid_from datetime2 GENERATED ALWAYS AS ROW START HIDDEN NOT NULL, valid_to datetime2 GENERATED ALWAYS AS ROW END HIDDEN NOT NULL,',
        '  PERIOD FOR SYSTEM_TIME (valid_from, valid_to)) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.AccountHistory));',
        "INSERT dbo.Person (id, name) VALUES (1, N'a'), (2, N'b');",
        'INSERT dbo.Knows ($from_id, $to_id, since) VALUES ((SELECT $node_id FROM dbo.Person WHERE id = 1), (SELECT $node_id FROM dbo.Person WHERE id = 2), 2020);',
        'INSERT dbo.Account (id) VALUES (7);'
      ].join('\n'), database)
      expect(tables.status).toBe('completed')
      const expected: Record<string, RegExp[]> = {
        Person: [/^\$node_id_[0-9A-F]+$/, /^id$/, /^name$/],
        Knows: [/^\$edge_id_[0-9A-F]+$/, /^\$from_id_[0-9A-F]+$/, /^\$to_id_[0-9A-F]+$/, /^since$/],
        Account: [/^id$/, /^valid_from$/, /^valid_to$/]
      }
      for (const [name, patterns] of Object.entries(expected)) {
        const { columns, truncated } = await supervisor.request('tables.columns', { connectionId: connection.id, database, schema: 'dbo', name })
        expect(columns.map(column => column.name), name).toEqual(patterns.map(pattern => expect.stringMatching(pattern)))
        const result = await run(selectTopRowsScript({ database, schema: 'dbo', name, columns, truncated }), database)
        expect(result.status, name).toBe('completed')
        expect(result.resultSets[0].columns.map(column => column.name), name).toEqual(columns.map(column => column.name))
        expect(result.resultSets[0].rows, name).toHaveLength(name === 'Person' ? 2 : 1)
      }
    } finally {
      const dropped = await run(`ALTER DATABASE ${quoteName(database)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${quoteName(database)};`)
      expect(dropped.status).toBe('completed')
    }
  }, 120_000)
})
