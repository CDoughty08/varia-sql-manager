// A live SQL Server connection for live vitest files (*-live.test.ts): the Release backend behind main's real pipeline and the renderer's
// results worker, as tests/explorer-live.test.ts builds it, with `run` returning every row as the grid reads it. The caller passes its
// cleanups list, which its afterEach drains.
import { resolve } from 'node:path'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { BackendSupervisor } from '../../src/main/backend/supervisor'
import { ResultsPortHost, supervisorResults, type PortMainLike } from '../../src/main/backend/results-port'
import { ResultClient, type PortMessageEvent, type WindowLike, type WorkerLike } from '../../src/renderer/src/results/ResultClient'
import { ResultsWorkerCore } from '../../src/renderer/src/results/worker-core'
import { FLAG_NULL, type WorkerRequest, type WorkerResponse } from '../../src/renderer/src/results/worker-protocol'
import type { ConnectionOptions, QueryOptions, QueryResult } from '../../src/shared/contracts'
import type { PortMessage } from '../../src/shared/ipc/port-messages'

export const liveServer = process.env.VARIA_TEST_SQL_SERVER
const user = process.env.VARIA_TEST_SQL_USER
const server = liveServer

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

/** A script's outcome and every row of its result sets, as the grid reads them: SSMS display text, null for NULL. */
export interface ReadResult { status: QueryResult['status']; resultSets: { columns: { name: string }[]; rows: (string | null)[][] }[] }

/**
 * The Release backend behind main's real pipeline (BackendSupervisor, ResultsPortHost) and the renderer's (ResultClient
 * and the results worker), connected to the live SQL Server the .NET checks use.
 */
export async function connectLive(cleanups: (() => Promise<void> | void)[]) {
  const supervisor = new BackendSupervisor({ command: 'dotnet', args: [resolve('backend/Varia.Backend/bin/Release/net11.0/Varia.Backend.dll')], cwd: process.cwd(), packaged: false })
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
  const run = async (sql: string, database = 'master'): Promise<ReadResult> => {
    const { value: summary } = await execute({ connectionId: connection.id, sessionId, database, sql, queryId: crypto.randomUUID(), maxRows: 0, maxResultSets: 1000, timeoutSeconds: 30 })
    results.applySummary(summary)
    const resultSets: ReadResult['resultSets'] = []
    for (const descriptor of summary.resultSets) {
      const handle = results.open(descriptor), width = descriptor.columns.length, rows: (string | null)[][] = []
      for (let first = 0; first < descriptor.rowsAvailable;) {
        const window = await handle.getWindow(first, 4096)
        if (window.count === 0) break
        for (let row = 0; row < window.count; row++) rows.push(Array.from({ length: width }, (_, column) => window.flags[row * width + column] & FLAG_NULL ? null : window.text[row * width + column]))
        first += window.count
      }
      resultSets.push({ columns: descriptor.columns, rows })
      handle.dispose()
    }
    if (summary.resultSets.length > 0) await results.release(summary.resultSets)
    return { status: summary.status, resultSets }
  }
  cleanups.push(async () => {
    await supervisor.request('query.session.close', { sessionId })
    await supervisor.request('connections.disconnect', { connectionId: connection.id })
  })
  return { supervisor, connection, run, execute, sessionId, results }
}
