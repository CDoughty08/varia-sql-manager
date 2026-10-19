import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { newSessionMessage } from '../src/renderer/src/services/queries'
import { connectionInfo, connectionOptions, queryOutput, readyBackend, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
function fixture() {
  const value = workbenchFixture()
  cleanups.push(value.dispose)
  return value
}

describe('ConnectionService', () => {
  it('keeps connection settings without the password', () => {
    const connections = new ConnectionService()
    connections.add(connectionInfo('server-a'), connectionOptions)
    connections.replace('server-a', connectionInfo('server-b', 2), { ...connectionOptions, password: 'another-secret' })
    connections.add(connectionInfo('server-c'), connectionOptions)
    connections.markLostBefore(3)
    for (const connection of connections.getSnapshot()) {
      expect(connection.options).toEqual({ server: 'server.example', database: 'master', authentication: 'sql', username: 'reader', trustServerCertificate: false })
      expect(JSON.stringify(connection)).not.toMatch(/password|secret|never-keep/)
    }
  })
  it('marks connections of earlier generations lost, once, including answers that arrive late', () => {
    const connections = new ConnectionService()
    connections.add(connectionInfo('server-a', 1), connectionOptions)
    connections.add(connectionInfo('server-b', 2), connectionOptions)
    const before = connections.getSnapshot()
    connections.markLostBefore(1)
    expect(connections.getSnapshot()).toBe(before)
    connections.markLostBefore(2)
    expect(connections.getSnapshot().map(connection => [connection.id, !!connection.lost])).toEqual([['server-a', true], ['server-b', false]])
    expect(connections.live().map(connection => connection.id)).toEqual(['server-b'])
    // An older generation number never brings a connection back.
    connections.markLostBefore(1)
    expect(connections.get('server-a')?.lost).toBe(true)
    connections.add(connectionInfo('server-c', 1), connectionOptions)
    expect(connections.get('server-c')?.lost).toBe(true)
  })
  it('puts a reconnected connection where the lost one was', () => {
    const connections = new ConnectionService()
    for (const id of ['server-a', 'server-b', 'server-c']) connections.add(connectionInfo(id), connectionOptions)
    connections.markLostBefore(2)
    connections.replace('server-b', connectionInfo('server-b2', 2), connectionOptions)
    expect(connections.getSnapshot().map(connection => [connection.id, !!connection.lost])).toEqual([['server-a', true], ['server-b2', false], ['server-c', true]])
    connections.remove('server-a')
    expect(connections.getSnapshot().map(connection => connection.id)).toEqual(['server-b2', 'server-c'])
  })
})

describe('reconnecting queries', () => {
  it('retargets only the lost connection\'s queries and keeps their results', async () => {
    const { connect, connections, documents, queries, targets, api } = fixture()
    api.push(readyBackend())
    connect(connectionInfo('server-a'))
    connect(connectionInfo('server-b'))
    const lostTab = documents.create('lost.sql', 'SELECT 1', 'Sales', 'server-a')
    api.execute.mockResolvedValueOnce({ ok: true, value: { ...queryOutput, database: 'Sales' } })
    await queries.execute()
    const otherTab = documents.create('other.sql', 'SELECT 1', 'master', 'server-b')
    api.push({ status: 'restarting', generation: 1, retryInMs: 0, lost: { generation: 1, reason: 'exit', connections: 2, queries: 0 } })
    expect(connections.live()).toEqual([])
    documents.activate(lostTab.id)
    expect(queries.canExecute()).toBe(false)
    connections.replace('server-a', connectionInfo('server-a2', 2), connectionOptions)
    targets.retarget('server-a', 'server-a2')
    expect(documents.get(lostTab.id)).toMatchObject({ connectionId: 'server-a2', database: 'Sales', sessionNotice: true })
    expect(documents.get(otherTab.id)).toMatchObject({ connectionId: 'server-b' })
    expect(documents.get(otherTab.id)?.sessionNotice).toBeUndefined()
    expect(queries.getSnapshot()[lostTab.id]?.summary).toBeDefined()
    expect(queries.canExecute()).toBe(true)
  })
  it('says the first execution after a reconnect runs in a new session, then never again', async () => {
    const { connect, connections, documents, queries, targets, api, results } = fixture()
    connect(connectionInfo('server-a'))
    const tab = documents.create('query.sql', 'SELECT 1', 'master', 'server-a')
    connections.markLostBefore(2)
    connections.replace('server-a', connectionInfo('server-a2', 2), connectionOptions)
    targets.retarget('server-a', 'server-a2')
    // A failure with no result never reached a session, so the notice waits for the next run.
    api.execute.mockResolvedValueOnce({ ok: false, error: 'Connect to a SQL Server first.', code: 'NOT_CONNECTED' })
    await queries.execute()
    expect(documents.get(tab.id)?.sessionNotice).toBe(true)
    api.execute.mockResolvedValueOnce({ ok: true, value: { ...queryOutput, messages: [{ text: '(1 row affected)', kind: 'info' }] } })
    await queries.execute()
    expect(results.getSnapshot()[tab.id]?.messages).toEqual([{ text: newSessionMessage, kind: 'info' }, { text: '(1 row affected)', kind: 'info' }])
    expect(documents.get(tab.id)?.sessionNotice).toBe(false)
    await queries.execute()
    expect(results.getSnapshot()[tab.id]?.messages).toEqual([])
  })
})
