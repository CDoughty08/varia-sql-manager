import type { MemoryOrder, ResultMemoryDetail } from '../../../shared/contracts'
import type { MemoryFeature, MemoryReport } from '../../../shared/ipc/port-messages'
import type { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { MetricRing } from '../live/ring'
import type { ResultClient } from './ResultClient'

/** A budget's figures. Results also has what the store holds (`detail`, from the backend's events; a summary's budget keeps
 *  the last one) and the backend generation it came from, whose result ids it names. */
export type MemoryUsage = Pick<MemoryReport, 'usedBytes' | 'globalBytes'> & { readonly detail?: ResultMemoryDetail; readonly generation?: number }
const unavailable: MemoryUsage = { usedBytes: 0, globalBytes: 0 }
/** Samples of the share of rows compression gave back the Nerd metrics sparkline keeps, one per event with a new detail:
 *  ten minutes, its window, at the busiest pace events come (about one a second while results stream). */
export const savedHistorySamples = 600
/** The share of the rows as read that compression gave back, in percent (the sparkline's value). */
export const savedPercent = (detail: ResultMemoryDetail): number =>
  detail.logicalBytes > 0 ? 100 * Math.max(0, detail.logicalBytes - detail.storedBytes - detail.cacheBytes) / detail.logicalBytes : 0

/** A backend memory budget and its usage. Results also updates from query summaries. */
export class MemoryUsageService extends SnapshotStore<MemoryUsage> implements Disposable {
  /** Results' saved share at each event that brought a new detail, for the Nerd metrics sparkline: filled only by the
   *  backend's pushes (no timer), and emptied with the backend. */
  get history(): MetricRing { return this.ring }
  private ring = new MetricRing(savedHistorySamples, 1)
  private readonly subscriptions: Disposable[]
  private shown: MemoryOrder = { generation: 0, seq: 0 }
  constructor(client: Pick<ResultClient, 'onMemory'>, feature: MemoryFeature, events?: EventBus, private readonly now: () => number = Date.now) {
    super(unavailable)
    this.subscriptions = [client.onMemory(memory => this.update(memory), feature)]
    if (feature === 'results' && events)
      this.subscriptions.push(events.subscribe(event => { if (event.type === 'query.finished' && event.summary) this.update(event.summary.budget) }))
  }
  /** Applies a report newer than the one shown: from a later backend generation, or later in the same one. A summary is
   *  sent after its figure is taken, so an event sent meanwhile (a close in another tab) can arrive first, and events and
   *  summaries reach the page by different paths; the older figure is dropped. Seq 0 is the client's own report that a
   *  backend holds nothing yet; generation 0 (no backend) also drops whatever the last one still sends. */
  update(memory: MemoryReport): void {
    const { generation, seq } = memory, shown = this.shown
    if (seq === 0) this.shown = generation === 0 ? { generation: shown.generation, seq: Number.MAX_SAFE_INTEGER } : { generation, seq: 0 }
    else if (generation > shown.generation || (generation === shown.generation && seq > shown.seq)) this.shown = { generation, seq }
    else return
    const current = this.getSnapshot()
    const detail = seq === 0 ? undefined : memory.detail ?? (current.generation === generation ? current.detail : undefined)
    const next: MemoryUsage = seq === 0 ? unavailable
      : { usedBytes: Math.max(0, memory.usedBytes), globalBytes: memory.globalBytes > 0 ? memory.globalBytes : current.globalBytes, ...detail ? { detail, generation } : {} }
    if (seq === 0 && this.ring.length > 0) this.ring = new MetricRing(savedHistorySamples, 1)
    if (memory.detail && detail === memory.detail) this.ring.push(this.now(), [savedPercent(memory.detail)])
    if (next.usedBytes !== current.usedBytes || next.globalBytes !== current.globalBytes || next.detail !== current.detail) this.publish(next)
  }
  dispose(): void { this.subscriptions.forEach(subscription => subscription.dispose()); this.clearListeners() }
}

export function memoryLevel({ usedBytes, globalBytes }: MemoryUsage, feature: MemoryFeature): 'unavailable' | 'normal' | 'warning' | 'critical' {
  if (globalBytes <= 0) return 'unavailable'
  const fraction = usedBytes / globalBytes
  if (fraction >= 0.95) return 'critical'
  return fraction >= (feature === 'index' ? 0.75 : 0.9) ? 'warning' : 'normal'
}
