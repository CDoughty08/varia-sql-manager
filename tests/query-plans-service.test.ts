import { describe, expect, it, vi } from 'vitest'
import { maxRetainedLivePlans, QueryPlansService } from '../src/renderer/src/plans/QueryPlansService'
import { SnapshotStore } from '../src/renderer/src/core/store'
import { PaneService } from '../src/renderer/src/services/panes'
import type { QuerySnapshot } from '../src/renderer/src/services/queries'
import type { ResultsService, TabResults } from '../src/renderer/src/results/ResultsService'
import type { AppliedTick, LiveHandle, LiveOwner, LiveService, LiveSnapshot } from '../src/renderer/src/live/LiveService'
import type { LivePlanFrame } from '../src/shared/plans'
import type { QueryResult } from '../src/shared/contracts'
import { documentFixture } from './fixtures/documents'

class Store<T> extends SnapshotStore<T> { set(value: T) { this.publish(value) } }
const frame: LivePlanFrame = { batch: 1, iteration: 1, revision: 1, document: { version: '', build: '', notices: [], statements: [
  { id: 's0', statementId: '1', text: 'SELECT 1', type: 'SELECT', estimatedCost: 1, warnings: [], nodes: [
    { id: 'n1', nodeId: '0', parentId: null, physicalOp: 'Scan', logicalOp: '', object: '', estimatedRows: 100, estimatedCost: 1, actualRows: 10, elapsedMs: null, cpuMs: null, executions: 1, warnings: [], properties: [] }
  ] }
] }, counters: [{ id: 'n1', rows: 10, elapsedMs: null, cpuMs: null, executions: 1 }] }

function fixture() {
  const docs = documentFixture(), tab = docs.documents.create('Live.sql', 'SELECT 1', 'master', 'connection')
  const queries = new Store<QuerySnapshot>({}), results = new Store<ReturnType<ResultsService['getSnapshot']>>({}), panes = new PaneService()
  const handles: { state: Store<LiveSnapshot>; owner: LiveOwner; dispose: ReturnType<typeof vi.fn>; tick(): void }[] = []
  const live = { open: vi.fn<LiveService['open']>((_spec, owner) => {
    const state = new Store<LiveSnapshot>({ connectionId: 'connection', status: 'live', probes: {} })
    const ticks = new Set<(tick: AppliedTick) => void>(), dispose = vi.fn()
    const tick = () => { for (const listener of ticks) listener({ subscriptionId: 'subscription', tick: { type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'query.plan.operators', costMs: 1, effectiveIntervalMs: 1000, plan: frame }] } }) }
    handles.push({ state, owner, dispose, tick })
    return { getSnapshot: state.getSnapshot, subscribe: state.subscribe, dispose, onTick: (listener: (tick: AppliedTick) => void) => { ticks.add(listener); return { dispose: () => ticks.delete(listener) } } } as unknown as LiveHandle
  }) }
  const service = new QueryPlansService(live, docs.documents, queries, panes, results)
  const running = (queryId: string): QuerySnapshot => ({ [tab.id]: { running: { queryId, connectionId: 'connection', startedAt: 1 }, livePlan: { queryId, connectionId: 'connection' } } })
  return { ...docs, tab, queries, results, panes, handles, service, running }
}

describe('query plan lifecycle', () => {
  it('does not open live sampling for an estimate that retains the preceding execution identity', () => {
    const f = fixture()
    f.queries.set({ [f.tab.id]: { livePlan: { queryId: 'old-run', connectionId: 'connection' }, running: { queryId: 'estimate', connectionId: 'connection', startedAt: 1, kind: 'estimate' } } })
    expect(f.handles).toHaveLength(0)
    expect(f.service.getSnapshot()[f.tab.id]).toBeUndefined()
    f.service.dispose(); f.documents.dispose(); f.panes.dispose()
  })
  it('reports a completed script with batch errors as completed, rather than stopped', () => {
    const f = fixture()
    f.queries.set(f.running('run'))
    f.handles[0].tick()
    f.queries.set({ [f.tab.id]: { livePlan: { queryId: 'run', connectionId: 'connection' }, summary: { status: 'completedWithErrors' } as QueryResult } })
    expect(f.service.getSnapshot()[f.tab.id].note).toMatch(/^Execution completed with errors\./)
    expect(f.handles[0].dispose).toHaveBeenCalledOnce()
    f.service.dispose(); f.documents.dispose(); f.panes.dispose()
  })
  it('keeps its last sample while hidden and stops its subscription on completion', () => {
    const f = fixture()
    f.queries.set(f.running('run'))
    const handle = f.handles[0]
    expect(handle.owner.visible()).toBe(false)
    f.panes.set({ ...f.panes.getSnapshot(), plan: true })
    expect(handle.owner.visible()).toBe(true)
    handle.tick()
    f.documents.create('Other.sql', '', 'master', 'connection')
    expect(handle.owner.visible()).toBe(false)
    expect(f.service.getSnapshot()[f.tab.id].model.statements).toHaveLength(1)
    f.queries.set({ [f.tab.id]: { livePlan: { queryId: 'run', connectionId: 'connection' }, error: 'Cancelled' } })
    expect(handle.dispose).toHaveBeenCalledOnce()
    const ended = f.service.getSnapshot()[f.tab.id]
    expect(ended.running).toBe(false)
    expect(ended.model.statements[0].nodes[0].liveActivity).toBe(false)
    expect(ended.note).toContain('partial')
    f.service.dispose(); f.documents.dispose(); f.panes.dispose()
  })
  it('preserves partial data but clears activity on backend loss, then releases it when results close', () => {
    const f = fixture()
    f.queries.set(f.running('run'))
    f.handles[0].tick()
    f.handles[0].state.set({ status: 'lost', connectionId: 'connection', probes: {}, error: { code: 'BACKEND_LOST', message: 'The backend stopped.' } })
    const lost = f.service.getSnapshot()[f.tab.id]
    expect(lost.note).toBe('The backend stopped.')
    expect(lost.model.statements[0].nodes[0]).toMatchObject({ actualRows: 10, liveActivity: false })
    f.results.set({ [f.tab.id]: { status: 'closed' } as TabResults })
    expect(f.service.getSnapshot()[f.tab.id]).toBeUndefined()
    expect(f.handles[0].dispose).toHaveBeenCalledOnce()
    f.service.dispose(); f.documents.dispose(); f.panes.dispose()
  })
  it('replaces run ownership and ignores ticks from the previous query', () => {
    const f = fixture()
    f.queries.set(f.running('first'))
    f.handles[0].tick()
    f.queries.set(f.running('second'))
    expect(f.handles[0].dispose).toHaveBeenCalledOnce()
    f.handles[0].tick()
    expect(f.service.getSnapshot()[f.tab.id]).toMatchObject({ queryId: 'second', model: { statements: [] } })
    f.service.dispose(); f.documents.dispose(); f.panes.dispose()
    expect(f.handles[1].dispose).toHaveBeenCalledOnce()
  })
  it('keeps the unavailable/permission reason after the query ends', () => {
    const f = fixture()
    f.queries.set(f.running('run'))
    f.handles[0].state.set({ status: 'ended', connectionId: 'connection', probes: {}, error: { code: 'PERMISSION_DENIED', message: 'Live Plan requires server performance state.' } })
    f.queries.set({ [f.tab.id]: { livePlan: { queryId: 'run', connectionId: 'connection' } } })
    expect(f.service.getSnapshot()[f.tab.id].note).toContain('Live Plan requires server performance state.')
    f.service.dispose(); f.documents.dispose(); f.panes.dispose()
  })
  it('bounds retained live snapshots across many completed query tabs', () => {
    const f = fixture()
    let snapshot: QuerySnapshot = {}
    for (let index = 0; index <= maxRetainedLivePlans; index++) {
      const tab = f.documents.create('Run.sql', 'SELECT 1', 'master', 'connection')
      const livePlan = { queryId: 'run-' + index, connectionId: 'connection' }
      snapshot = { ...snapshot, [tab.id]: { livePlan, running: { ...livePlan, startedAt: 1 } } }
      f.queries.set(snapshot)
      f.handles.at(-1)!.tick()
      snapshot = { ...snapshot, [tab.id]: { livePlan } }
      f.queries.set(snapshot)
    }
    const retained = Object.values(f.service.getSnapshot())
    expect(retained.filter(s => s.model.statements.length)).toHaveLength(maxRetainedLivePlans)
    expect(retained[0].model.statements).toHaveLength(0)
    f.service.dispose(); f.documents.dispose(); f.panes.dispose()
  })
})
