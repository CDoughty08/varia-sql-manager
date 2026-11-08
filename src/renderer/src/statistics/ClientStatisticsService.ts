import type { QueryResult } from '../../../shared/contracts'
import type { ClientStatisticsSample } from '../../../shared/client-statistics'
import { clientStatisticsHistoryLimit } from '../../../shared/client-statistics'
import { SnapshotStore } from '../core/store'

export interface StatisticsRun {
  readonly queryId: string
  readonly sequence: number
  readonly scope: number
  readonly database: string
  readonly server?: string
  readonly actualPlan: boolean
  readonly livePlan?: boolean
  readonly status: QueryResult['status'] | 'running' | 'unavailable'
  readonly sample?: ClientStatisticsSample
}
/** Small, renderer-only history, independent of result buffers. Reset also excludes an already-started run. */
export class ClientStatisticsService extends SnapshotStore<Readonly<Record<string, readonly StatisticsRun[]>>> {
  private scopes = new Map<string, { key: string; scope: number; sequence: number }>()
  constructor() { super({}) }
  begin(tabId: string, queryId: string, connectionId: string, database: string, actualPlan: boolean, server?: string, livePlan = false): void {
    const key = JSON.stringify([connectionId, database, actualPlan, livePlan]), previous = this.scopes.get(tabId)
    const context = { key, scope: previous ? previous.scope + (previous.key === key ? 0 : 1) : 1, sequence: (previous?.sequence ?? 0) + 1 }
    this.scopes.set(tabId, context)
    const run: StatisticsRun = { queryId, sequence: context.sequence, scope: context.scope, database, server, actualPlan, livePlan, status: 'running' }
    this.publish({ ...this.getSnapshot(), [tabId]: [...this.getSnapshot()[tabId] ?? [], run].slice(-clientStatisticsHistoryLimit) })
  }
  finish(tabId: string, queryId: string, summary?: QueryResult): void {
    const runs = this.getSnapshot()[tabId]
    if (!runs?.some(run => run.queryId === queryId && run.status === 'running')) return
    this.publish({ ...this.getSnapshot(), [tabId]: runs.map(run => run.queryId !== queryId ? run : {
      ...run, status: summary?.status ?? 'unavailable', sample: summary?.clientStatistics ?? { counters: {}, unavailable: 'No statistics summary was returned. The backend or session may have ended.' }
    }) })
  }
  sessionEnded(tabId: string): void {
    const context = this.scopes.get(tabId)
    if (context) this.scopes.set(tabId, { ...context, key: '' })
  }
  reset(tabId: string): void {
    const next = { ...this.getSnapshot() }; delete next[tabId]; this.scopes.delete(tabId); this.publish(next)
  }
  dispose(): void { this.scopes.clear(); this.publish({}); this.clearListeners() }
}

/** Compare only successful runs from the selected session/database/capture context. Partial runs never dilute averages. */
export function statisticsPeers(runs: readonly StatisticsRun[], selected: StatisticsRun): readonly StatisticsRun[] {
  return runs.filter(run => run.scope === selected.scope && run.status === 'completed' && run.sample && !run.sample.unavailable)
}
export function metricAverage(runs: readonly StatisticsRun[], value: (sample: ClientStatisticsSample) => number | undefined): number | undefined {
  const values = runs.flatMap(run => { const n = run.sample && value(run.sample); return n === undefined ? [] : [n] })
  return values.length ? values.reduce((sum, n) => sum + n / values.length, 0) : undefined
}
