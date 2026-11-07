import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { DocumentService } from '../services/documents'
import type { PaneService } from '../services/panes'
import type { QueryService } from '../services/queries'
import type { LiveHandle, LiveService } from '../live/LiveService'
import type { ResultsService } from '../results/ResultsService'
import { applyLivePlan, emptyLivePlan, idleLivePlan, type LivePlanModel } from './live-model'

export interface QueryPlanState { readonly queryId: string; readonly model: LivePlanModel; readonly running: boolean; readonly note: string; readonly issue?: string }
interface Run { handle: LiveHandle; stops: Disposable[] }
export const maxRetainedLivePlans = 8
/** Per-run ownership outlives the mounted output. A hidden plan has no SQL sampling and retains only its last sample. */
export class QueryPlansService extends SnapshotStore<Readonly<Record<string, QueryPlanState>>> implements Disposable {
  private readonly runs = new Map<string, Run>()
  private readonly stops: (() => void)[]
  constructor(private live: Pick<LiveService, 'open'>, private documents: Pick<DocumentService, 'get' | 'getSnapshot' | 'subscribe'>,
    private queries: Pick<QueryService, 'getSnapshot' | 'subscribe'>, private panes: Pick<PaneService, 'getSnapshot' | 'subscribe' | 'location'>,
    private results: Pick<ResultsService, 'getSnapshot' | 'subscribe'>) {
    super({})
    this.stops = [queries.subscribe(() => this.sync()), documents.subscribe(() => this.sync()), results.subscribe(() => this.sync())]
  }
  private set(tab: string, state: QueryPlanState): void {
    const next = { ...this.getSnapshot(), [tab]: state }
    const cached = Object.keys(next).filter(id => next[id].model.statements.length)
    // A per-run bound alone lets many completed tabs exhaust the renderer. Prefer evicting finished, inactive
    // snapshots; their captured actual data still belongs to ResultsService and stays available.
    while (cached.length > maxRetainedLivePlans) {
      const inactive = cached.filter(id => id !== tab && id !== this.documents.getSnapshot().activeId)
      const victim = inactive.find(id => !next[id].running) ?? inactive[0] ?? cached.find(id => id !== tab)!
      this.end(victim)
      next[victim] = { ...next[victim], model: emptyLivePlan, note: 'This live snapshot was released to free memory. Captured actual plans remain available.' }
      cached.splice(cached.indexOf(victim), 1)
    }
    this.publish(next)
  }
  private end(tab: string): void {
    const run = this.runs.get(tab)
    if (!run) return
    this.runs.delete(tab)
    for (const stop of run.stops) stop.dispose()
    run.handle.dispose()
  }
  private sync(): void {
    for (const [tab, state] of Object.entries(this.getSnapshot())) {
      const query = this.queries.getSnapshot()[tab]
      if (!this.documents.get(tab) || query?.livePlan?.queryId !== state.queryId || this.results.getSnapshot()[tab]?.status === 'closed') {
        this.end(tab)
        const next = { ...this.getSnapshot() }; delete next[tab]; this.publish(next)
      } else if (!query.running && state.running) {
        this.end(tab)
        const status = query.summary?.status
        const outcome = query.error ? query.error + ' Retained live statistics are partial.' : status === 'completed' || status === 'completedWithErrors'
          ? `Execution completed${status === 'completedWithErrors' ? ' with errors' : ''}. Captured actual plans replace transient statistics where available.`
          : 'Execution stopped. Retained live statistics are partial; captured actual plans are available for completed statements.'
        this.set(tab, { ...state, running: false, model: idleLivePlan(state.model),
          note: [outcome, state.issue].filter(Boolean).join(' ') })
      }
    }
    for (const [tab, query] of Object.entries(this.queries.getSnapshot())) {
      if (!query.running || !query.livePlan || this.getSnapshot()[tab] || this.results.getSnapshot()[tab]?.status === 'closed') continue
      const { queryId, connectionId } = query.livePlan
      this.set(tab, { queryId, model: emptyLivePlan, running: true, note: 'Waiting for a profiled statement. Short statements may complete between samples.' })
      const handle = this.live.open({ source: 'query.plan', connectionId, args: { queryId }, probes: [{ probe: 'query.plan.operators', intervalMs: 1000 }] }, {
        key: 'query-plan:' + tab,
        visible: () => this.documents.getSnapshot().activeId === tab && this.panes.getSnapshot().plan,
        popout: () => this.panes.location('plan') === 'window',
        closed: () => !this.documents.get(tab),
        connectionId: () => this.documents.get(tab)?.connectionId,
        subscribe: listener => { const a = this.documents.subscribe(listener), b = this.panes.subscribe(listener); return () => { a(); b() } }
      })
      const changed = () => {
        const state = this.getSnapshot()[tab]
        if (state?.queryId !== queryId) return
        const snapshot = handle.getSnapshot(), probe = snapshot.probes['query.plan.operators']
        const issue = snapshot.error?.message ?? probe?.error?.message ?? probe?.note
        const note = issue ?? (snapshot.status === 'paused' ? 'Live Plan paused while this view is hidden.' : undefined)
        if (note && note !== state.note) this.set(tab, { ...state, note, issue: issue ?? state.issue, model: idleLivePlan(state.model) })
      }
      const tick = handle.onTick(({ tick }) => {
        const state = this.getSnapshot()[tab]
        if (state?.queryId !== queryId) return
        const frame = tick.samples.find(s => s.probe === 'query.plan.operators')?.plan
        if (frame) {
          const model = applyLivePlan(state.model, frame)
          this.set(tab, { ...state, model, issue: undefined, note: model === state.model ? 'The retained live plan reached its display limit. Actual plans are collected separately.' : 'Live statistics are partial. Highlighted operators produced rows since the previous sample.' })
        } else if (tick.samples.length) this.set(tab, { ...state, model: idleLivePlan(state.model), note: 'Waiting for a profiled statement. Short statements may complete between samples.' })
      })
      this.runs.set(tab, { handle, stops: [tick, { dispose: handle.subscribe(changed) }] })
      changed()
    }
  }
  dispose(): void { for (const stop of this.stops) stop(); for (const tab of this.runs.keys()) this.end(tab); this.clearListeners() }
}
