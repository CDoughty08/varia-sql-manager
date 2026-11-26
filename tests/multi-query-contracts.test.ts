import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, QueryEvent, ResultDescriptor } from '../src/shared/contracts'
import { methodAllows, optionsAllow, requestProvider } from '../src/shared/ipc/methods'
import { queryEventSchema, queryMultiResultSchema, type PortMessage, type PortRequest } from '../src/shared/ipc/port-messages'
import { requestSchemas } from '../src/main/validation'
import { sessionWriteSchema } from '../src/main/session-store'
import { recoveryWriteSchema } from '../src/main/recovery-store'
import { BackendSupervisor, type SupervisorDeps } from '../src/main/backend/supervisor'
import { BackendError, sentences } from '../src/main/backend/errors'
import { ResultClient, type PortMessageEvent, type WindowLike, type WorkerLike } from '../src/renderer/src/results/ResultClient'
import { ResultsWorkerCore } from '../src/renderer/src/results/worker-core'
import type { WorkerRequest, WorkerResponse } from '../src/renderer/src/results/worker-protocol'
import { FrameKind } from '../src/shared/ipc/wire/frames'
import { fakeSpawn, manualClock, type FakeBackend } from './fixtures/fake-process'

const supervisors: BackendSupervisor[] = []
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map(value => value.stop()))
})

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const sqlTarget = (n = 1) => ({ targetKey: `sql-${n}`, connectionId: uuid(n), label: `prod-sql-${n}`, database: 'master' })
const bqTarget = (n = 2) => ({ targetKey: `bq-${n}`, connectionId: uuid(n), label: `analytics-${n}`, dataset: 'sales' })
const baseSameEngine = () => ({
  queryId: uuid(100), sessionId: uuid(101), mode: 'transaction' as const,
  targets: [sqlTarget(1), sqlTarget(2)], sql: 'SELECT 1', timeoutSeconds: 30, maxRows: 1000
})
const baseCrossEngine = () => ({
  queryId: uuid(102), sessionId: uuid(103), mode: 'crossEngineReadOnly' as const,
  targets: [sqlTarget(1), bqTarget(2)], scripts: { sqlserver: 'SELECT 1', bigquery: 'SELECT 1' }, timeoutSeconds: 30, maxRows: 1000
})

describe('query.executeMulti validation and IPC policy', () => {
  const schema = requestSchemas['query.executeMulti']

  it('enforces cross-mode payload mutual exclusion and 3 MiB combined UTF-8 byte cap', () => {
    expect(schema.safeParse(baseSameEngine()).success).toBe(true)
    expect(schema.safeParse(baseCrossEngine()).success).toBe(true)
    expect(schema.safeParse({ ...baseSameEngine(), scripts: { sqlserver: 'SELECT 1', bigquery: 'SELECT 1' } }).success).toBe(false)
    expect(schema.safeParse({ ...baseSameEngine(), startLines: {} }).success).toBe(false)
    expect(schema.safeParse({ ...baseCrossEngine(), sql: 'SELECT 1' }).success).toBe(false)
    expect(schema.safeParse({ ...baseCrossEngine(), startLine: 1 }).success).toBe(false)
    expect(schema.safeParse({ ...baseCrossEngine(), startColumn: 1 }).success).toBe(false)
    // Multi-byte UTF-8 chars: 800_000 * 4 bytes = 3_200_000 > 3_000_000 even though char length <= 1_000_000.
    const emojiSql = `SELECT '${'😀'.repeat(400_000)}'`
    expect(schema.safeParse({ ...baseCrossEngine(), scripts: { sqlserver: emojiSql, bigquery: emojiSql } }).success).toBe(false)
  })

  it('rejects duplicate connections/keys, mixed target options, invalid modes, and control/bidi characters', () => {
    expect(schema.safeParse({ ...baseSameEngine(), targets: [sqlTarget(1), { ...sqlTarget(1), targetKey: 'sql-dup' }] }).success).toBe(false)
    expect(schema.safeParse({ ...baseSameEngine(), targets: [sqlTarget(1), { ...sqlTarget(2), targetKey: 'sql-1' }] }).success).toBe(false)
    expect(schema.safeParse({ ...baseSameEngine(), targets: [{ ...sqlTarget(1), dataset: 'sales' }] }).success).toBe(false)
    expect(schema.safeParse({ ...baseSameEngine(), sequential: true }).success).toBe(false)
    expect(schema.safeParse({ ...baseSameEngine(), stopOnError: true }).success).toBe(false)
    expect(schema.safeParse({ ...baseSameEngine(), mode: 'fireAndForget', sequential: true, stopOnError: true }).success).toBe(true)
    expect(schema.safeParse({ ...baseSameEngine(), targets: [{ ...sqlTarget(1), targetKey: 'bad\u202ekey' }] }).success).toBe(false)
    expect(schema.safeParse({ ...baseSameEngine(), targets: [{ ...sqlTarget(1), label: 'bad\nlabel' }] }).success).toBe(false)
  })

  it('routes requestProvider and optionsAllow accurately for multi-server requests', () => {
    const providers = new Map<string, 'sqlserver' | 'bigquery'>([[uuid(1), 'sqlserver'], [uuid(2), 'bigquery'], [uuid(3), 'sqlserver']])
    const lookup = (id: string) => providers.get(id)
    expect(requestProvider('query.executeMulti', { targets: [sqlTarget(1), sqlTarget(3)] }, lookup)).toBe('sqlserver')
    expect(requestProvider('query.executeMulti', { targets: [bqTarget(2)] }, lookup)).toBe('bigquery')
    expect(requestProvider('query.executeMulti', baseCrossEngine(), lookup)).toBeUndefined()
    expect(methodAllows('query.executeMulti', 'sqlserver')).toBe(true)
    expect(methodAllows('query.executeMulti', 'bigquery')).toBe(true)
    expect(optionsAllow('query.executeMulti', 'sqlserver', { ...baseSameEngine(), stopOnError: true, mode: 'fireAndForget' })).toBe(true)
    expect(optionsAllow('query.executeMulti', 'bigquery', { ...baseSameEngine(), mode: 'fireAndForget', targets: [bqTarget(2)], stopOnError: true })).toBe(false)
    expect(optionsAllow('query.executeMulti', 'sqlserver', { ...baseSameEngine(), preflightDryRun: true })).toBe(false)
  })

  it('validates new streaming queryEventSchema and queryMultiResultSchema payloads', () => {
    expect(queryEventSchema.safeParse({ type: 'resultSet.meta', resultId: 7, rolledBackPreview: true }).success).toBe(true)
    expect(queryEventSchema.safeParse({
      type: 'multiQuery.targetState', targetKey: 'sql-1', phase: 'committed',
      batchesCompleted: 2, batchesTotal: 2, rowsAffected: 10, resultSetCount: 1, elapsedMs: 120
    }).success).toBe(true)
    expect(queryEventSchema.safeParse({
      type: 'query.job', jobId: 'job-1', project: 'analytics-prod', location: 'US', state: 'running', auxiliary: false, transaction: 'none', targetKey: 'bq-1'
    }).success).toBe(true)
    expect(queryMultiResultSchema.safeParse({
      mode: 'transaction', status: 'completed', elapsedMs: 42,
      targets: [{ targetKey: 'sql-1', label: 'prod-sql-1', provider: 'sqlserver', status: 'succeeded', batchesCompleted: 1, batchesTotal: 1, rowsAffected: 1, resultSetIds: [1], elapsedMs: 40 }],
      resultSets: [], discardedResultSets: 0, messages: [], messagesTruncated: false,
      budget: { usedBytes: 0, globalBytes: 1024, queryBytes: 1024, seq: 1 }, completedAt: new Date().toISOString()
    }).success).toBe(true)
  })
})

describe('Hot Exit v4 and AutoRecover v3 multi-target invariants', () => {
  it('rejects mixed providers under multiMode=same and workspace target provider mismatches', () => {
    const sqlWsTarget = { id: uuid(10), options: { server: 'sql-1', database: 'master', authentication: 'windows' as const, trustServerCertificate: true, encrypt: true } }
    const mixedDoc = {
      name: 'Multi1.sql', kind: 'sql' as const, eol: 'lf' as const, dirty: true, text: 'SELECT 1',
      multiMode: 'same' as const,
      multiTargets: [
        { targetId: uuid(10), attachWanted: true, provider: 'sqlserver' as const, database: 'master', enabled: true },
        { provider: 'bigquery' as const, database: 'sales', enabled: true }
      ]
    }
    expect(sessionWriteSchema.safeParse({ documents: [mixedDoc], activeIndex: 0, workspace: { targets: [sqlWsTarget] } }).success).toBe(false)
    const providerMismatchDoc = {
      ...mixedDoc, multiMode: 'cross' as const,
      multiTargets: [
        { targetId: uuid(10), attachWanted: true, provider: 'bigquery' as const, database: 'sales', enabled: true }
      ]
    }
    expect(sessionWriteSchema.safeParse({ documents: [providerMismatchDoc], activeIndex: 0, workspace: { targets: [sqlWsTarget] } }).success).toBe(false)
    expect(recoveryWriteSchema.safeParse({
      id: uuid(20), name: 'Multi1.sql', kind: 'sql', eol: 'lf', text: 'SELECT 1',
      multiMode: 'same',
      multiTargets: [
        { provider: 'sqlserver', database: 'master', enabled: true },
        { provider: 'bigquery', database: 'sales', enabled: true }
      ]
    }).success).toBe(false)

    // 0-target multi-server / Cross-Engine tabs (e.g. opening a -- #Dialect file with 0 connected servers) are valid.
    expect(sessionWriteSchema.safeParse({
      documents: [{ name: 'Cross.sql', kind: 'sql', eol: 'lf', dirty: false, text: 'SELECT 1', multiMode: 'cross', crossView: 'split', multiTargets: [] }],
      activeIndex: 0
    }).success).toBe(true)
    expect(recoveryWriteSchema.safeParse({
      id: uuid(21), name: 'Cross.sql', kind: 'sql', eol: 'lf', text: 'SELECT 1',
      multiMode: 'cross', crossView: 'split', multiTargets: []
    }).success).toBe(true)
  })
})

function simulatedSupervisor(configure?: (backend: FakeBackend, index: number) => void, deps?: SupervisorDeps) {
  const { clock, advance } = manualClock()
  const processes = fakeSpawn(configure)
  const value = new BackendSupervisor({ command: 'fake', args: [], cwd: process.cwd(), packaged: false }, { clock, spawn: processes.spawn, ...deps })
  supervisors.push(value)
  return { value, clock, advance, backends: processes.backends }
}

async function failure(promise: Promise<unknown>): Promise<BackendError> {
  try { await promise } catch (error) { if (error instanceof BackendError) return error; throw error }
  throw new Error('Expected BackendError')
}

describe('BackendSupervisor multi-target validation and lifecycle', () => {
  it('distinguishes NOT_CONNECTED from CONNECTION_LOST, prioritizes BACKEND_UNAVAILABLE, and blocks provable mixed options pre-start', async () => {
    const { value, backends } = simulatedSupervisor()
    const sqlConn = await value.request('connections.connect', { server: 's1', database: 'master', authentication: 'windows', trustServerCertificate: true }) as { id: string }
    const bqConn = await value.request('connections.connect', { provider: 'bigquery', project: 'p1', authentication: 'gcloud', credential: { source: 'anonymous' } }) as { id: string }
    const unknownId = uuid(3)

    // Unknown/disconnected handle -> NOT_CONNECTED (not CONNECTION_LOST).
    const disconnectedError = await failure(value.request('query.executeMulti', {
      ...baseSameEngine(),
      targets: [{ targetKey: 'sql-1', connectionId: sqlConn.id, label: 's1', database: 'master' }, { targetKey: 'unknown', connectionId: unknownId, label: 'u', database: 'master' }]
    }))
    expect(disconnectedError.code).toBe('NOT_CONNECTED')

    // Provable mixed providers in transaction mode with a third unknown target -> UNSUPPORTED_PROVIDER immediately.
    const mixedError = await failure(value.request('query.executeMulti', {
      ...baseSameEngine(),
      targets: [
        { targetKey: 'sql-1', connectionId: sqlConn.id, label: 's1', database: 'master' },
        { targetKey: 'bq-1', connectionId: bqConn.id, label: 'p1', dataset: 'sales' },
        { targetKey: 'u', connectionId: unknownId, label: 'u' }
      ]
    }))
    expect(mixedError.code).toBe('UNSUPPORTED_PROVIDER')

    // Backend crash + stop -> BACKEND_UNAVAILABLE wins over CONNECTION_LOST.
    backends[0]!.exit(1)
    await value.stop()
    const unavailableError = await failure(value.request('query.executeMulti', {
      ...baseSameEngine(),
      targets: [{ targetKey: 'sql-1', connectionId: sqlConn.id, label: 's1', database: 'master' }]
    }))
    expect(unavailableError.code).toBe('BACKEND_UNAVAILABLE')
  })

  it('captures target providers before await sent.done so BACKEND_LOST carries mixed-engine wording and stamps resultSet.meta generation', async () => {
    const receivedEvents: QueryEvent[] = []
    const { value, backends } = simulatedSupervisor(backend => {
      backend.held.add('query.executeMulti')
    })
    const sqlConn = await value.request('connections.connect', { server: 's1', database: 'master', authentication: 'windows', trustServerCertificate: true }) as { id: string }
    const bqConn = await value.request('connections.connect', { provider: 'bigquery', project: 'p1', authentication: 'gcloud', credential: { source: 'anonymous' } }) as { id: string }
    const pending = value.request('query.executeMulti', {
      ...baseCrossEngine(),
      targets: [
        { targetKey: 'sql-1', connectionId: sqlConn.id, label: 's1', database: 'master' },
        { targetKey: 'bq-1', connectionId: bqConn.id, label: 'p1', dataset: 'sales' }
      ]
    }, { onEvent: event => receivedEvents.push(event) })
    await vi.waitFor(() => expect(backends[0]!.requests.some(r => r.method === 'query.executeMulti')).toBe(true))
    const req = backends[0]!.requests.find(r => r.method === 'query.executeMulti')!
    backends[0]!.send(FrameKind.EVENT, req.id, 0, { type: 'resultSet.meta', resultId: 9, rolledBackPreview: true })
    await vi.waitFor(() => expect(receivedEvents).toEqual([{ type: 'resultSet.meta', generation: 1, resultId: 9, rolledBackPreview: true }]))
    backends[0]!.exit(1)
    const lost = await failure(pending)
    expect(lost.code).toBe('BACKEND_LOST')
    expect(lost.message).toBe(sentences.lostMultiMixed)
  })
})

class FakeWorker implements WorkerLike {
  readonly listeners: { message: ((event: { data: WorkerResponse }) => void)[]; error: ((event: unknown) => void)[]; messageerror: ((event: unknown) => void)[] } = { message: [], error: [], messageerror: [] }
  readonly fromWorker: PortRequest[] = []
  readonly core = new ResultsWorkerCore({ post: message => queueMicrotask(() => { for (const listener of this.listeners.message) listener({ data: message }) }) })
  postMessage(message: WorkerRequest): void {
    if (message.type === 'attach') this.core.attach({ postMessage: request => { this.fromWorker.push(request as PortRequest) } })
    else this.core.handle(message)
  }
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: never): void { (this.listeners[type] as unknown[]).push(listener) }
  terminate(): void { /* noop */ }
  toWorker(message: PortMessage): void { this.core.receive(message) }
}

class FakeWindow implements WindowLike {
  readonly listeners = new Set<(event: PortMessageEvent) => void>()
  addEventListener(_type: 'message', listener: (event: PortMessageEvent) => void): void { this.listeners.add(listener) }
  removeEventListener(_type: 'message', listener: (event: PortMessageEvent) => void): void { this.listeners.delete(listener) }
  dispatch(event: PortMessageEvent): void { for (const listener of [...this.listeners]) listener(event) }
}

const descriptor = (patch: Partial<ResultDescriptor> = {}): ResultDescriptor => ({
  generation: 1, resultId: 3, index: 0, batchNumber: 1, iteration: 1, kind: 'rows',
  columns: [{ name: 'n', dataType: 'int', wire: 'text', nullable: true }],
  rowsRead: 5, rowsStored: 5, rowsAvailable: 5, bytesStored: 64, truncatedCells: 0, state: 'complete', incomplete: false, ...patch
})

describe('ResultClient and ResultsWorkerCore multi-query combine and resultSet.meta', () => {
  it('propagates resultSet.meta rolledBackPreview to open sorted ResultViews and closes orphaned combine results on abort', async () => {
    const worker = new FakeWorker()
    const win = new FakeWindow()
    const scheduled: (() => void)[] = []
    const client = new ResultClient({
      api: { openResultsPort: vi.fn(async (): Promise<ApiResult<void>> => ({ ok: true, value: undefined })) },
      window: win, createWorker: () => worker, now: () => 0, schedule: callback => { scheduled.push(callback) }
    })
    const ready = client.ready()
    win.dispatch({ source: win, data: { type: 'varia:results-port' }, ports: [new MessageChannel().port1] })
    await ready

    const base = client.open(descriptor({ resultId: 3, targetKey: 'sql-1' }))
    const sortPromise = base.sort([{ column: 0, descending: false, mode: 'value' }])
    await vi.waitFor(() => expect(worker.fromWorker.some(r => r.t === 'view')).toBe(true))
    const viewReq = worker.fromWorker.splice(0).find(r => r.t === 'view')!
    worker.toWorker({ t: 'end', rid: viewReq.rid, ok: true, result: { viewId: 11, rows: 5, baseRows: 5, complete: true, approximate: false, filters: [] } })
    const view = await sortPromise
    expect(view.getSnapshot().rolledBackPreview).toBeUndefined()

    // Emit resultSet.meta -> both base handle and open sorted view receive rolledBackPreview: true.
    worker.toWorker({ t: 'query', queryId: 'q1', event: { type: 'resultSet.meta', generation: 1, resultId: 3, rolledBackPreview: true } })
    await vi.waitFor(() => expect(base.getSnapshot().rolledBackPreview).toBe(true))
    expect(view.getSnapshot().rolledBackPreview).toBe(true)

    // Combine aborted mid-flight -> late result triggers orphan close on the port.
    const base2 = client.open(descriptor({ resultId: 4, targetKey: 'sql-2' }))
    const abort = new AbortController()
    const combinePromise = client.combine([base, base2], { signal: abort.signal })
    await vi.waitFor(() => expect(worker.fromWorker.some(r => r.t === 'combine')).toBe(true))
    const combineReq = worker.fromWorker.splice(0).find(r => r.t === 'combine')!
    abort.abort()
    await expect(combinePromise).rejects.toThrow()
    worker.toWorker({ t: 'end', rid: combineReq.rid, ok: true, result: { descriptor: descriptor({ resultId: 99, kind: 'combined' }) } })
    await vi.waitFor(() => expect(worker.fromWorker.some(r => r.t === 'close' && r.resultIds.includes(99))).toBe(true))
    client.dispose()
  })
})
