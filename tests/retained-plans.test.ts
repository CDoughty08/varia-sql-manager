import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionInfo, VariaApi } from '../src/shared/contracts'
import { planLimits } from '../src/shared/plans'
import type { CellValue } from '../src/renderer/src/results/ResultClient'
import { retainedPlanLimits, RetainedPlansService, type PlanExecutionContext, type PlanOutcome, type SnapshotSource } from '../src/renderer/src/plans/RetainedPlansService'
import { ResultsService } from '../src/renderer/src/results/ResultsService'
import { QueryService } from '../src/renderer/src/services/queries'
import { deferred, documentFixture } from './fixtures/documents'
import { descriptor, fakeResultClient, summaryOf } from './fixtures/results'

const context: PlanExecutionContext = { executionId: 'execution', tabId: 'tab', name: 'Query.sql', connectionId: 'server', server: 'localhost', database: 'master',
  sql: 'SELECT 1', startLine: 3, sqlScope: 'selection', startedAt: 100, includeActualPlan: true, includeLivePlan: false }
const outcome: PlanOutcome = { status: 'completed', endedAt: 200, spid: 51, login: 'reader' }
const source = (key = '1:1:0', xml = '<ShowPlanXML/>'): SnapshotSource => ({ key, label: key, captureType: 'actual', batchNumber: 1, iteration: 2, generation: 1, resultId: 1, row: 0, read: async () => ({ text: xml }) })
const cell = (text = '<ShowPlanXML/>'): CellValue => ({ text, isNull: false, truncated: false, error: false, formatted: false })
const services: { dispose(): void }[] = []
function history(limits: Partial<typeof retainedPlanLimits> | { entries?: number; bytes?: number; documentsPerRun?: number; acquisitions?: number; acquisitionMs?: number } = {}) {
  const service = new RetainedPlansService({ ...retainedPlanLimits, ...limits }); services.push(service); return service
}
afterEach(() => { for (const service of services.splice(0).reverse()) service.dispose(); vi.useRealTimers() })

describe('immutable bounded retained XML', () => {
  it('copies context and provenance with stable source identity, independent of later source edits', async () => {
    const service = history(), original = { ...context }, end = { ...outcome }, input = source('7:42:0', '<original/>')
    await service.capture(original, end, [input])
    original.sql = 'SELECT changed'; original.database = 'elsewhere'; end.status = 'cancelled'
    const entry = service.getSnapshot().entries[0]
    expect(entry).toMatchObject({ sourceKey: '7:42:0', captureType: 'actual', batchNumber: 1, iteration: 2, xml: '<original/>', partialExecution: false,
      context: { sql: 'SELECT 1', startLine: 3, sqlScope: 'selection', database: 'master' }, outcome: { status: 'completed', spid: 51 } })
    expect(Object.isFrozen(entry)).toBe(true); expect(Object.isFrozen(entry.context)).toBe(true); expect(Object.isFrozen(entry.outcome)).toBe(true)
    expect(entry).not.toHaveProperty('read')
  })
  it('evicts oldest unpinned entries by count and keeps pinning inside the same budget', async () => {
    const service = history({ entries: 2 })
    await service.capture(context, outcome, [source('old')]); const old = service.getSnapshot().entries[0]
    service.pin(old.id, true)
    await service.capture(context, outcome, [source('middle'), source('new')])
    expect(service.getSnapshot().entries.map(e => e.sourceKey)).toEqual(['new', 'old'])
    service.pin(service.getSnapshot().entries[0].id, true)
    const before = service.getSnapshot().entries
    await service.capture(context, outcome, [source('refused')])
    expect(service.getSnapshot().entries).toBe(before)
    expect(service.getSnapshot().notice).toContain('budget is full')
    service.pin(old.id, false)
    await service.capture(context, outcome, [source('fits')])
    expect(service.getSnapshot().entries.map(e => e.sourceKey)).toEqual(['fits', 'new'])
  })
  it('freezes outcome and source metadata before a pending original-XML read completes', async () => {
    const service = history(), waiting = deferred<{ text: string }>(), end = { ...outcome }
    const input = { ...source('original-key'), read: () => waiting.promise }
    const pending = service.capture(context, end, [input])
    end.status = 'cancelled'; input.key = 'changed-key'; input.incomplete = true
    waiting.resolve({ text: '<original/>' }); await pending
    expect(service.getSnapshot().entries[0]).toMatchObject({ sourceKey: 'original-key', incomplete: false, partialExecution: false, outcome: { status: 'completed' } })
  })
  it('accounts XML, SQL and metadata bytes and rejects oversize entries atomically', async () => {
    const reference = history(); await reference.capture(context, outcome, [source()])
    const bytes = reference.getSnapshot().bytes
    expect(bytes).toBeGreaterThan(2 * ('<ShowPlanXML/>'.length + context.sql.length))
    const service = history({ bytes: bytes * 2 })
    await service.capture(context, outcome, [source('1:1:0'), source('1:2:0'), source('1:3:0')])
    expect(service.getSnapshot().entries).toHaveLength(2)
    expect(service.getSnapshot().bytes).toBe(bytes * 2)
    const before = service.getSnapshot().entries
    await service.capture(context, outcome, [source('too big', 'x'.repeat(bytes * 2))])
    expect(service.getSnapshot().entries).toBe(before)
    service.remove(before[0].id)
    expect(service.getSnapshot().bytes).toBe(bytes)
    const pinned = history({ bytes: bytes * 2 - 1 })
    await pinned.capture(context, outcome, [source()]); pinned.pin(pinned.getSnapshot().entries[0].id, true)
    await pinned.capture(context, outcome, [source()])
    expect(pinned.getSnapshot().entries).toHaveLength(1)
    expect(pinned.getSnapshot().entries[0].pinned).toBe(true)
    expect(pinned.getSnapshot().notice).toContain('budget is full')
    await service.capture(context, outcome, [source('over-document-limit', 'x'.repeat(planLimits.characters + 1))])
    expect(service.getSnapshot().bytes).toBe(bytes)
    expect(service.getSnapshot().notice).toContain('plan document limit')
  })
  it('bounds documents and concurrency, without queuing unbounded work', async () => {
    const service = history({ documentsPerRun: 2, acquisitions: 1 }), waiting = deferred<{ text: string }>(), read = vi.fn(() => waiting.promise)
    const pending = service.capture(context, outcome, [{ ...source(), read }])
    const refused = vi.fn(async () => ({ text: '<unused/>' }))
    await service.capture(context, outcome, [{ ...source(), read: refused }])
    expect(refused).not.toHaveBeenCalled(); expect(service.getSnapshot().pending).toBe(1)
    waiting.resolve({ text: '<copied/>' }); await pending
    const third = vi.fn(async () => ({ text: '<unused/>' }))
    await service.capture(context, outcome, [source('one'), source('two'), { ...source('three'), read: third }])
    expect(third).not.toHaveBeenCalled(); expect(service.getSnapshot().notice).toContain('per-execution document limit')
    await service.capture(context, outcome, [source('one')], 200)
    expect(service.getSnapshot().notice).toContain('200 plan document(s)')
  })
  it('ends hung acquisition at its deadline and preserves copied documents after a read/backend failure', async () => {
    vi.useFakeTimers()
    const service = history({ acquisitionMs: 100 }), waiting = deferred<{ text: string }>()
    const pending = service.capture(context, outcome, [source('copied'), { ...source('lost'), read: () => waiting.promise }])
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(service.getSnapshot()).toMatchObject({ pending: 0, entries: [{ sourceKey: 'copied' }] })
    expect(service.getSnapshot().notice).toContain('unread sources were not retained')
    waiting.resolve({ text: '<late/>' }); await Promise.resolve()
    expect(service.getSnapshot().entries).toHaveLength(1)
    await service.capture(context, { ...outcome, status: 'lost' }, [source('available'), { ...source('lost'), read: async () => { throw new Error('Backend lost') } }])
    expect(service.getSnapshot().entries[0].partialExecution).toBe(true)
    expect(service.getSnapshot().notice).toContain('Backend lost')
  })
  it('keeps cancelled reads inside the concurrency budget until the reader acknowledges cancellation', async () => {
    vi.useFakeTimers()
    const service = history({ acquisitions: 1, acquisitionMs: 100 }), waiting = deferred<{ text: string }>()
    const pending = service.capture(context, outcome, [{ ...source('hung'), read: () => waiting.promise }])
    await vi.advanceTimersByTimeAsync(100); await pending
    service.clear(true)
    const read = vi.fn(async () => ({ text: '<new/>' }))
    await service.capture(context, outcome, [{ ...source('next'), read }])
    expect(read).not.toHaveBeenCalled()
    expect(service.getSnapshot().notice).toContain('busy')
    waiting.resolve({ text: '<late/>' }); await Promise.resolve()
    await service.capture(context, outcome, [{ ...source('next'), read }])
    expect(read).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot().entries).toMatchObject([{ sourceKey: 'next' }])
  })
  it('clear keeps pins, aborts pending reads, and a late completion cannot repopulate cleared/disposed history', async () => {
    const service = history(), waiting = deferred<{ text: string }>()
    await service.capture(context, outcome, [source('pin')]); const id = service.getSnapshot().entries[0].id
    service.pin(id, true)
    const pending = service.capture(context, outcome, [{ ...source('pending'), read: () => waiting.promise }])
    service.clear(); await pending
    expect(service.getSnapshot()).toMatchObject({ entries: [{ id, pinned: true }], pending: 0, notice: '' })
    waiting.resolve({ text: '<late/>' }); await Promise.resolve()
    expect(service.getSnapshot().entries).toHaveLength(1)
    service.clear(true); expect(service.getSnapshot()).toMatchObject({ entries: [], bytes: 0 })
    service.dispose(); await service.capture(context, outcome, [source()]); expect(service.getSnapshot().entries).toEqual([])
  })
  it.each(['cancelled', 'timedOut', 'failed', 'completedWithErrors', 'lost'] as const)('preserves %s execution provenance separately from XML completeness', async status => {
    const service = history()
    await service.capture(context, { ...outcome, status }, [source('whole'), { ...source('prefix'), incomplete: true, read: async () => ({ text: '<prefix', truncated: true }) }])
    expect(service.getSnapshot().entries).toMatchObject([{ partialExecution: true, incomplete: true, xmlTruncated: true, outcome: { status } }, { partialExecution: true, incomplete: false, xmlTruncated: false }])
  })
})

function executionFixture() {
  const docs = documentFixture(), client = fakeResultClient(), retainedPlans = history()
  const results = new ResultsService({ client, retainedPlans, events: docs.events, frame: callback => callback(), documents: docs.documents,
    api: { copyResults: vi.fn(), saveResults: vi.fn(), cancelResultsJob: vi.fn(), onResultsJob: () => () => {} } })
  const connection: ConnectionInfo & { lost?: true } = { id: 'server', server: 'localhost', database: 'master', serverVersion: '17', commandTimeout: 0, generation: 1 }
  const api = { execute: vi.fn<VariaApi['execute']>(async () => ({ ok: true, value: summaryOf([], { planSets: [plan] }) })),
    estimatePlan: vi.fn<VariaApi['estimatePlan']>(async () => ({ ok: true, value: { plans: [{ xml: '<estimated/>', batchNumber: 2, iteration: 3 }], database: 'tempdb' } })),
    cancel: vi.fn(), querySessionState: vi.fn(), confirmSessions: vi.fn() }
  const queries = new QueryService(docs.documents, api, () => connection, docs.events, results, undefined, undefined, undefined, retainedPlans)
  const tab = docs.documents.create('Selected.sql', 'SELECT unused;\nSELECT chosen;', 'master', connection.id)
  docs.documents.update(tab.id, { includeActualPlan: true })
  const plan = descriptor(42, { kind: 'executionPlan', rowsAvailable: 1, rowsStored: 1 })
  client.open(plan); client.handle(42)!.getCell.mockResolvedValue(cell('<actual/>'))
  services.push(results, queries, docs.documents)
  return { ...docs, client, retainedPlans, results, api, queries, tab, plan, connection }
}
describe('normal execution retention lifecycle', () => {
  it('clearing history as completion is published cancels acquisition rather than scheduling a late resurrection', async () => {
    const f = executionFixture()
    const stop = f.results.subscribe(() => { if (f.results.getSnapshot()[f.tab.id]?.status === 'completed') f.retainedPlans.clear(true) })
    await f.queries.execute(); stop()
    expect(f.retainedPlans.getSnapshot()).toMatchObject({ entries: [], pending: 0 })
  })
  it('holds Execute and result release until copying settles; pins outlive re-execute, Close Results and Close Tab', async () => {
    const f = executionFixture(), waiting = deferred<CellValue>()
    f.client.handle(42)!.getCell.mockReturnValueOnce(waiting.promise)
    vi.spyOn(f.documents, 'getExecuteText').mockReturnValue({ sql: 'SELECT chosen;', startLine: 2 })
    const run = f.queries.execute()
    await vi.waitFor(() => expect(f.client.handle(42)!.getCell).toHaveBeenCalled())
    expect(f.queries.canExecute()).toBe(false)
    await f.queries.execute(); expect(f.api.execute).toHaveBeenCalledTimes(1)
    f.documents.update(f.tab.id, { name: 'Renamed.sql', database: 'changed' }); f.model(f.tab.id).edit('SELECT edited;')
    f.results.closeResults(f.tab.id)
    expect(f.client.released()).not.toContain(42)
    waiting.resolve(cell('<original/>')); await run
    const snapshot = f.retainedPlans.getSnapshot().entries[0]
    f.retainedPlans.pin(snapshot.id, true)
    expect(snapshot).toMatchObject({ xml: '<original/>', context: { name: 'Selected.sql', database: 'master', sql: 'SELECT chosen;', sqlScope: 'selection', startLine: 2 } })
    expect(f.client.released()).toContain(42)
    f.api.execute.mockResolvedValue({ ok: true, value: summaryOf([]) })
    await f.queries.execute()
    await f.documents.runTask(() => f.documents.close(f.tab.id, 'rollback'))
    expect(f.retainedPlans.getSnapshot().entries[0]).toMatchObject({ id: snapshot.id, xml: '<original/>', pinned: true })
    expect(f.results.getSnapshot()[f.tab.id]).toBeUndefined()
  })
  it('closing a tab during acquisition finishes copying without resurrecting query/results state', async () => {
    const f = executionFixture(), waiting = deferred<CellValue>()
    f.client.handle(42)!.getCell.mockReturnValueOnce(waiting.promise)
    const run = f.queries.execute()
    await vi.waitFor(() => expect(f.client.handle(42)!.getCell).toHaveBeenCalled())
    await f.documents.runTask(() => f.documents.close(f.tab.id, 'rollback'))
    f.queries.forget(f.tab.id)
    expect(f.client.released()).not.toContain(42)
    waiting.resolve(cell('<after-close/>')); await run
    expect(f.retainedPlans.getSnapshot().entries[0].xml).toBe('<after-close/>')
    expect(f.queries.getSnapshot()[f.tab.id]).toBeUndefined()
    expect(f.results.getSnapshot()[f.tab.id]).toBeUndefined()
    expect(f.client.released()).toContain(42)
  })
  it('backend loss during copying keeps acquired XML and does not restore a dead execution session', async () => {
    const f = executionFixture(), waiting = deferred<CellValue>()
    await f.retainedPlans.capture(context, outcome, [source('already-copied')])
    f.client.handle(42)!.getCell.mockReturnValueOnce(waiting.promise)
    f.api.execute.mockResolvedValue({ ok: true, value: summaryOf([], { planSets: [f.plan], spid: 51, login: 'reader' }) })
    const run = f.queries.execute()
    await vi.waitFor(() => expect(f.client.handle(42)!.getCell).toHaveBeenCalled())
    f.connection.lost = true; f.client.lose(); f.events.emit({ type: 'session.ended', tabId: f.tab.id })
    waiting.resolve({ ...cell(), error: true }); await run
    expect(f.queries.getSnapshot()[f.tab.id].session).toBeUndefined()
    expect(f.retainedPlans.getSnapshot().entries).toMatchObject([{ sourceKey: 'already-copied' }])
    expect(f.retainedPlans.getSnapshot().notice).toContain('unavailable')
  })
  it('retains an estimated request with its original selected SQL when later estimates/results replace it', async () => {
    const f = executionFixture(), waiting = deferred<Awaited<ReturnType<VariaApi['estimatePlan']>>>()
    f.documents.update(f.tab.id, { includeLivePlan: true })
    f.api.estimatePlan.mockReturnValueOnce(waiting.promise)
    vi.spyOn(f.documents, 'getExecuteText').mockReturnValue({ sql: 'SELECT chosen;', startLine: 2 })
    const run = f.queries.estimate()
    f.model(f.tab.id).edit('SELECT edited;')
    waiting.resolve({ ok: true, value: { plans: [{ xml: '<original-estimate/>', batchNumber: 1, iteration: 2 }], database: 'tempdb' } }); await run
    const snapshot = f.retainedPlans.getSnapshot().entries[0]
    f.retainedPlans.pin(snapshot.id, true)
    await f.queries.estimate()
    expect(f.retainedPlans.getSnapshot().entries.find(e => e.id === snapshot.id)).toMatchObject({ captureType: 'estimated', xml: '<original-estimate/>',
      sourceKey: f.api.estimatePlan.mock.calls[0][0].requestId + ':0', context: { sql: 'SELECT chosen;', startLine: 2, includeActualPlan: false, includeLivePlan: false }, outcome: { database: 'tempdb' } })
  })
  it('closing a still-running tab before completion abandons output and does not retain late summary plans', async () => {
    const f = executionFixture(), waiting = deferred<Awaited<ReturnType<VariaApi['execute']>>>()
    f.api.execute.mockReturnValueOnce(waiting.promise)
    const run = f.queries.execute()
    await f.documents.runTask(() => f.documents.close(f.tab.id, 'rollback'))
    waiting.resolve({ ok: true, value: summaryOf([], { planSets: [f.plan] }) }); await run
    expect(f.retainedPlans.getSnapshot().entries).toEqual([])
    expect(f.client.released()).toContain(42)
    expect(f.client.handle(42)!.getCell).not.toHaveBeenCalled()
  })
  it('does not mislabel manual Showplan as actual and preserves cancelled capture batch/GO order', async () => {
    const f = executionFixture()
    const manual = descriptor(43, { kind: 'executionPlan', batchNumber: 1, iteration: 2, rowsAvailable: 1, rowsStored: 1 })
    f.client.open(manual); f.client.handle(43)!.getCell.mockResolvedValue(cell('<manual/>'))
    f.api.execute.mockResolvedValue({ ok: true, value: summaryOf([manual], { planSets: [f.plan], status: 'cancelled', completedBatches: 1, totalBatches: 2 }) })
    await f.queries.execute()
    expect(f.retainedPlans.getSnapshot().entries).toMatchObject([
      { captureType: 'query-returned', batchNumber: 1, iteration: 2, partialExecution: true, xml: '<manual/>', outcome: { status: 'cancelled' } },
      { captureType: 'actual', batchNumber: 1, iteration: 1, partialExecution: true, xml: '<actual/>' }
    ])
  })
})
