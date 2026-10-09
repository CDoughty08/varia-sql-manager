import type { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { selectAll, type GridSelection } from '../grid/selection'

export type ResultSelections = Readonly<Record<string, GridSelection>>

/**
 * The selected cells of each query's results grid, kept outside React so the output menu and its commands read the
 * same selection the grid shows. A new run, a finished run, and closing the query clear it; a selection made in
 * another result set of the query does not apply to the one showing.
 */
export class ResultSelectionService extends SnapshotStore<ResultSelections> implements Disposable {
  private readonly subscription: Disposable
  constructor(events: EventBus) {
    super({})
    this.subscription = events.subscribe(event => {
      if (event.type === 'query.started' || event.type === 'query.finished' || event.type === 'documents.closed') this.clear(event.tabId)
    })
  }
  /** The query's selection; with `resultIndex`, only when it is in that result set. */
  get(tabId: string, resultIndex?: number): GridSelection | undefined {
    const selection = Object.hasOwn(this.getSnapshot(), tabId) ? this.getSnapshot()[tabId] : undefined
    return selection && (resultIndex === undefined || selection.resultIndex === resultIndex) ? selection : undefined
  }
  set(tabId: string, selection: GridSelection): void { if (this.getSnapshot()[tabId] !== selection) this.publish({ ...this.getSnapshot(), [tabId]: selection }) }
  selectAll(tabId: string, resultIndex: number): void { this.set(tabId, selectAll(resultIndex)) }
  clear(tabId: string): void {
    if (!Object.hasOwn(this.getSnapshot(), tabId)) return
    const next = { ...this.getSnapshot() }
    delete next[tabId]
    this.publish(next)
  }
  dispose(): void { this.subscription.dispose(); this.clearListeners(); this.publish({}) }
}
