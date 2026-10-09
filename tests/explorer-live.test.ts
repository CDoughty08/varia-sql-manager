import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { BackendClient } from '../src/main/backend-client'
import type { ConnectionOptions, QueryOptions } from '../src/shared/contracts'
import { quoteName, selectTopRowsScript } from '../src/shared/sql/identifiers'
import { selectAll, toTsv } from '../src/renderer/src/grid/selection'

const server = process.env.VARIA_TEST_SQL_SERVER, user = process.env.VARIA_TEST_SQL_USER
// Permanent objects (graph tables cannot be temporary) go in a scratch database, created and dropped only when allowed.
const scratch = !!server && process.env.VARIA_TEST_SQL_SCRATCH === '1'
const clients: BackendClient[] = []
afterEach(() => { clients.splice(0).forEach(client => client.stop()) })

/** The Release backend, connected to the live SQL Server the .NET checks use; only session-local objects are created. */
async function connect() {
  const client = new BackendClient('dotnet', [resolve('backend/Varia.Backend/bin/Release/net10.0/Varia.Backend.dll')], process.cwd())
  clients.push(client)
  const options: ConnectionOptions = user
    ? { server: server!, database: 'master', authentication: 'sql', username: user, password: process.env.VARIA_TEST_SQL_PASSWORD, trustServerCertificate: true }
    : { server: server!, database: 'master', authentication: 'windows', trustServerCertificate: true }
  const connection = await client.request('connections.connect', options, 60_000)
  const sessionId = crypto.randomUUID()
  const run = (sql: string, database = 'master') => {
    const query: QueryOptions = { connectionId: connection.id, sessionId, database, sql, queryId: crypto.randomUUID(), maxRows: 1000, timeoutSeconds: 30 }
    return client.request('query.execute', query, 60_000)
  }
  const close = async () => {
    await client.request('query.session.close', { sessionId })
    await client.request('connections.disconnect', { connectionId: connection.id })
  }
  return { client, connection, run, close }
}

describe.runIf(server)('Select Top 1000 Rows against SQL Server', () => {
  it('runs the generated script for a table whose names need quoting', async () => {
    const { run, close } = await connect()
    try {
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
      expect(result.resultSets[0].rows).toEqual([[1, 'a'], [2, null]])
      // What Copy with Headers puts on the clipboard for the whole grid.
      expect(toTsv(result.resultSets[0], selectAll(0), { headers: true, eol: '\n' })).toBe('id\tna]me\n1\ta\n2\tNULL')
    } finally { await close() }
  }, 90_000)
  it('lists a catalogue view\'s columns in order, and selects them by name', async () => {
    const { client, connection, run, close } = await connect()
    try {
      const { columns, truncated } = await client.request('tables.columns', { connectionId: connection.id, database: 'master', schema: 'sys', name: 'objects' })
      expect(truncated).toBe(false)
      expect(columns.slice(0, 2)).toEqual([{ name: 'name', dataType: 'sysname' }, { name: 'object_id', dataType: 'int' }])
      const result = await run(selectTopRowsScript({ database: 'master', schema: 'sys', name: 'objects', columns, truncated }))
      expect(result.status).toBe('completed')
      expect(result.resultSets[0].columns.map(column => column.name)).toEqual(columns.map(column => column.name))
      expect(result.resultSets[0].rows.length).toBeGreaterThan(0)
      await expect(client.request('tables.columns', { connectionId: connection.id, database: 'master', schema: 'sys', name: 'objects]' })).rejects.toThrow('Table was not found.')
    } finally { await close() }
  }, 90_000)
  it.runIf(scratch)('leaves out graph tables\' internal columns, which cannot be selected, and keeps hidden period columns', async () => {
    const { client, connection, run, close } = await connect()
    // Uniquely named and marked, so a leftover is recognisable.
    const database = 'varia_scratch_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12)
    try {
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
          const { columns, truncated } = await client.request('tables.columns', { connectionId: connection.id, database, schema: 'dbo', name })
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
    } finally { await close() }
  }, 120_000)
})
