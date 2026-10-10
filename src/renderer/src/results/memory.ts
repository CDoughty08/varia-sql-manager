import type { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { ResultClient } from './ResultClient'

export interface ResultMemory { readonly usedBytes: number; readonly globalBytes: number }

/** The memory the backend holds for query results, and its budget: pushed by the backend (checked once a second and after each close),
 *  reported with each summary, and 0 once a new backend replaces a lost one. */
export class ResultMemoryService extends SnapshotStore<ResultMemory> implements Disposable {
  private readonly subscriptions: Disposable[]
  constructor(client: Pick<ResultClient, 'onMemory'>, events: EventBus) {
    super({ usedBytes: 0, globalBytes: 0 })
    this.subscriptions = [
      client.onMemory(memory => this.update(memory)),
      events.subscribe(event => { if (event.type === 'query.finished' && event.summary) this.update(event.summary.budget) })
    ]
  }
  update(memory: { usedBytes: number; globalBytes: number }): void {
    const current = this.getSnapshot()
    const next = { usedBytes: Math.max(0, memory.usedBytes), globalBytes: memory.globalBytes > 0 ? memory.globalBytes : current.globalBytes }
    if (next.usedBytes !== current.usedBytes || next.globalBytes !== current.globalBytes) this.publish(next)
  }
  dispose(): void { this.subscriptions.forEach(subscription => subscription.dispose()); this.clearListeners() }
}

/** The warning shows from 90 % of the budget, when new results are about to be truncated. */
export const memoryWarning = (memory: ResultMemory): boolean => memory.globalBytes > 0 && memory.usedBytes >= 0.9 * memory.globalBytes
