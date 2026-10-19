import type { MemoryOrder } from '../../../shared/contracts'
import type { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { ResultClient } from './ResultClient'

export interface ResultMemory { readonly usedBytes: number; readonly globalBytes: number }

/** The memory the backend holds for query results, and its budget: pushed by the backend (checked once a second and after each close),
 *  reported with each summary, and 0 once a new backend replaces a lost one. */
export class ResultMemoryService extends SnapshotStore<ResultMemory> implements Disposable {
  private readonly subscriptions: Disposable[]
  private shown: MemoryOrder = { generation: 0, seq: 0 }
  constructor(client: Pick<ResultClient, 'onMemory'>, events: EventBus) {
    super({ usedBytes: 0, globalBytes: 0 })
    this.subscriptions = [
      client.onMemory(memory => this.update(memory)),
      events.subscribe(event => { if (event.type === 'query.finished' && event.summary) this.update(event.summary.budget) })
    ]
  }
  /** Applies a report newer than the one shown: from a later backend generation, or later in the same one. A summary is
   *  sent after its figure is taken, so an event sent meanwhile (a close in another tab) can arrive first, and events and
   *  summaries reach the page by different paths; the older figure is dropped. Seq 0 is the client's own report that a
   *  backend holds nothing yet; generation 0 (no backend) also drops whatever the last one still sends. */
  update(memory: ResultMemory & MemoryOrder): void {
    const { generation, seq } = memory, shown = this.shown
    if (seq === 0) this.shown = generation === 0 ? { generation: shown.generation, seq: Number.MAX_SAFE_INTEGER } : { generation, seq: 0 }
    else if (generation > shown.generation || (generation === shown.generation && seq > shown.seq)) this.shown = { generation, seq }
    else return
    const current = this.getSnapshot()
    const next = { usedBytes: Math.max(0, memory.usedBytes), globalBytes: memory.globalBytes > 0 ? memory.globalBytes : current.globalBytes }
    if (next.usedBytes !== current.usedBytes || next.globalBytes !== current.globalBytes) this.publish(next)
  }
  dispose(): void { this.subscriptions.forEach(subscription => subscription.dispose()); this.clearListeners() }
}

/** The warning shows from 90 % of the budget, when new results are about to be truncated. */
export const memoryWarning = (memory: ResultMemory): boolean => memory.globalBytes > 0 && memory.usedBytes >= 0.9 * memory.globalBytes
