import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendState } from '../src/shared/contracts'
import { BackendStateService, liveGeneration } from '../src/renderer/src/services/backend'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { noticeText } from '../src/renderer/src/BackendBanner'
import { backendApi, connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
function fixture() {
  const value = workbenchFixture()
  cleanups.push(value.dispose)
  return value
}
const restarting = (generation: number, reason: 'exit' | 'manual' | 'reload' | 'crash', connections: number, queries = 0): BackendState =>
  ({ status: 'restarting', generation, retryInMs: 0, lost: { generation, reason, connections, queries } })

describe('BackendStateService', () => {
  it('loads the state, then follows main\'s pushes', async () => {
    const api = backendApi(readyBackend(3))
    const service = new BackendStateService(api, new ConnectionService())
    cleanups.push(() => service.dispose())
    expect(service.getSnapshot().state.status).toBe('starting')
    await vi.waitFor(() => expect(service.getSnapshot().state).toEqual(readyBackend(3)))
    api.push({ status: 'unresponsive', generation: 3, silentMs: 15_000 })
    expect(service.getSnapshot().state.status).toBe('unresponsive')
    service.dispose()
    expect(api.listeners.size).toBe(0)
  })
  it('adds up undismissed losses, once each, and says when any was unexpected', () => {
    const service = new BackendStateService(backendApi(), new ConnectionService())
    cleanups.push(() => service.dispose())
    service.receive(restarting(1, 'manual', 0))
    expect(service.getSnapshot().notice).toBeUndefined()
    service.receive(restarting(2, 'manual', 2))
    service.receive(restarting(2, 'manual', 2))
    expect(service.getSnapshot().notice).toEqual({ unexpected: false, connections: 2, queries: 0 })
    service.receive({ status: 'failed', reason: 'crashLoop', message: 'm', details: 'd', lost: { generation: 3, reason: 'crash', connections: 1, queries: 1 } })
    expect(service.getSnapshot().notice).toEqual({ unexpected: true, connections: 3, queries: 1 })
    service.dismiss()
    expect(service.getSnapshot().notice).toBeUndefined()
    // A reload replaced the page that owned the connections; this page has nothing to reconnect.
    service.receive(restarting(4, 'reload', 2))
    expect(service.getSnapshot().notice).toBeUndefined()
  })
  it('marks the connections of every ended generation lost', () => {
    expect([readyBackend(2), { status: 'starting', generation: 2 }, { status: 'unresponsive', generation: 2, silentMs: 1 }, restarting(1, 'exit', 0)].map(state => liveGeneration(state as BackendState))).toEqual([2, 2, 2, 2])
    expect(liveGeneration({ status: 'failed', reason: 'spawn', message: '', details: '' })).toBe(0)
    expect(liveGeneration({ status: 'failed', reason: 'crashLoop', message: '', details: '', lost: { generation: 4, reason: 'exit', connections: 0, queries: 0 } })).toBe(5)
    const connections = new ConnectionService()
    const service = new BackendStateService(backendApi(), connections)
    cleanups.push(() => service.dispose())
    connections.add(connectionInfo('server-a', 1), { server: 'a', database: '', authentication: 'windows', trustServerCertificate: false })
    service.receive(readyBackend(1))
    expect(connections.live()).toHaveLength(1)
    // A page that missed the restart push still learns from the next generation's state.
    service.receive({ status: 'starting', generation: 2 })
    expect(connections.get('server-a')?.lost).toBe(true)
  })
  it('words the banner for unexpected and manual restarts', () => {
    expect(noticeText({ unexpected: true, connections: 2, queries: 1 })).toBe('The SQL backend stopped unexpectedly and was restarted. 2 connections were lost and 1 running script was stopped; nothing was re-run.')
    expect(noticeText({ unexpected: true, connections: 1, queries: 0 })).toBe('The SQL backend stopped unexpectedly and was restarted. 1 connection was lost and 0 running scripts were stopped; nothing was re-run.')
    expect(noticeText({ unexpected: false, connections: 3, queries: 0 })).toBe('The SQL backend was restarted. 3 connections were closed.')
  })
})

describe('backend context keys and commands', () => {
  it('derive readiness and lost connections from the backend state', () => {
    const { context, api, connect, documents } = fixture()
    expect(context.getState()).toMatchObject({ backendStatus: 'starting', backendReady: false })
    api.push(readyBackend())
    connect(connectionInfo('server-a'))
    documents.create('a.sql', '', 'master', 'server-a')
    expect(context.getState()).toMatchObject({ backendStatus: 'ready', backendReady: true, hasConnection: true, activeDocumentConnected: true, hasLostConnection: false, activeConnectionLost: false })
    api.push({ status: 'unresponsive', generation: 1, silentMs: 15_000 })
    expect(context.getState()).toMatchObject({ backendStatus: 'unresponsive', backendReady: false, hasConnection: true })
    api.push(restarting(1, 'crash', 1, 0))
    expect(context.getState()).toMatchObject({ backendStatus: 'restarting', hasConnection: false, activeDocumentConnected: false, hasLostConnection: true, activeConnectionLost: true })
    documents.create('b.sql', '', 'master')
    expect(context.getState()).toMatchObject({ hasLostConnection: true, activeConnectionLost: false })
  })
  it('offer Reconnect only for a lost connection on a ready backend, and Restart always', async () => {
    const { commands, api, connect, documents, host, quickInput } = fixture()
    expect(commands.isEnabled('backend.restart')).toBe(true)
    await commands.execute('backend.restart', undefined, 'palette')
    expect(api.restartBackend).toHaveBeenCalledOnce()
    api.push(readyBackend())
    connect(connectionInfo('server-a'))
    connect(connectionInfo('server-b'))
    expect(commands.isEnabled('connection.reconnect')).toBe(false)
    api.push(restarting(1, 'exit', 2))
    expect(commands.isEnabled('connection.reconnect')).toBe(false)
    api.push(readyBackend(2))
    expect(commands.isEnabled('connection.reconnect')).toBe(true)
    // The active query's connection first.
    documents.create('a.sql', '', 'master', 'server-b')
    await commands.execute('connection.reconnect', undefined, 'menu')
    expect(host.reconnect).toHaveBeenCalledWith('server-b')
    // Otherwise a picker over the lost connections only.
    documents.create('b.sql', '', 'master')
    connect(connectionInfo('server-c', 2))
    await commands.execute('connection.reconnect', undefined, 'palette')
    expect(quickInput.getSnapshot()).toMatchObject({ visible: true, ariaLabel: 'Reconnect' })
    expect(quickInput.getSnapshot().rows.map(row => row.item.id)).toEqual(['server-a', 'server-b'])
    api.restartBackend.mockResolvedValueOnce({ ok: false, error: 'Untrusted IPC sender.' })
    quickInput.hide('cancel')
    await commands.execute('backend.restart', undefined, 'palette')
    expect(commands.getSnapshot().error).toContain('Untrusted IPC sender.')
  })
  it('leave lost connections out of the server pickers', async () => {
    const { commands, api, connect, documents, quickInput } = fixture()
    api.push(readyBackend())
    connect(connectionInfo('server-a'))
    api.push(restarting(1, 'exit', 1))
    api.push(readyBackend(2))
    connect(connectionInfo('server-b', 2))
    documents.create('a.sql', '', 'master')
    await commands.execute('query.changeConnection', undefined, 'palette')
    expect(quickInput.getSnapshot().rows.map(row => row.item.id)).toEqual(['', 'server-b'])
    quickInput.hide('cancel')
    await commands.execute('connection.disconnect', undefined, 'palette')
    expect(quickInput.getSnapshot().rows.map(row => row.item.id)).toEqual(['server-b'])
  })
})
