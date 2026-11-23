import { SnapshotStore } from '../core/store'
import type { EntryKey, ResultsService } from './ResultsService'
import { rowBytesOf } from './sample'

/** Load sample's dialog while it is open: the windowed result it samples, its rows (BigQuery's total), a row's projected size
 *  in memory and the result memory free when it opened. */
export interface SampleRequest {
  readonly tabId: string; readonly key: EntryKey; readonly name: string; readonly resultId: number; readonly generation: number
  readonly total: number; readonly rowBytes?: number; readonly freeBytes?: number
}

/** Load sample's dialog (docs/bigquery.md, Load a sample); App mounts it while a request is set. */
export class SampleDialogService extends SnapshotStore<{ readonly request?: SampleRequest }> {
  private readonly unsubscribe: () => void
  constructor(private readonly results: Pick<ResultsService, 'sampleSource' | 'subscribe'>) {
    super({})
    // Closed once its result can no longer be sampled (closed, its tab closed or run again), so Load seldom goes nowhere; a
    // lost backend leaves it open, and Load then says the result is unavailable.
    this.unsubscribe = results.subscribe(() => {
      const request = this.getSnapshot().request
      if (request && !this.results.sampleSource(request.tabId, request.key)) this.close()
    })
  }
  /** Opens the dialog for a windowed result that can be sampled now; false (nothing opens) otherwise. */
  open(tabId: string, key: EntryKey): boolean {
    const source = this.results.sampleSource(tabId, key)
    if (!source) return false
    const rowBytes = rowBytesOf(source.projectedBytes, source.total)
    this.publish({ request: { tabId, key, name: source.name, resultId: source.resultId, generation: source.generation, total: source.total, ...rowBytes ? { rowBytes } : {}, ...source.freeBytes === undefined ? {} : { freeBytes: source.freeBytes } } })
    return true
  }
  close(): void { if (this.getSnapshot().request) this.publish({}) }
  dispose(): void { this.unsubscribe(); this.publish({}); this.clearListeners() }
}
