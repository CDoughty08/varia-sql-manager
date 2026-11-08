import type { QueryStatus } from '../../../shared/contracts'
import { planLimits } from '../../../shared/plans'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

/** UTF-16 payload accounting, including SQL and metadata; separate from parsed/layout/GPU caches. */
export const retainedPlanLimits = { entries: 32, bytes: 64 * 1024 * 1024, documentsPerRun: 64, acquisitions: 2, acquisitionMs: 5_000 } as const
export interface PlanExecutionContext {
  readonly executionId: string; readonly tabId: string; readonly name: string; readonly file?: string
  readonly connectionId: string; readonly server?: string; readonly database: string
  readonly sql: string; readonly startLine: number; readonly sqlScope: 'selection' | 'document'
  readonly startedAt: number; readonly includeActualPlan: boolean; readonly includeLivePlan: boolean
}
export interface PlanOutcome {
  readonly status: QueryStatus | 'lost'; readonly endedAt: number; readonly completedAt?: string
  readonly elapsedMs?: number; readonly database?: string; readonly spid?: number; readonly login?: string
  readonly completedBatches?: number; readonly totalBatches?: number; readonly error?: string
}
export type PlanCaptureType = 'actual' | 'estimated' | 'query-returned'
export interface SnapshotSource {
  readonly key: string; readonly label: string; readonly captureType: PlanCaptureType
  readonly batchNumber: number; readonly iteration: number; readonly generation?: number; readonly resultId?: number; readonly row?: number
  readonly incomplete?: boolean
  read(signal: AbortSignal): Promise<{ text: string; truncated?: boolean }>
}
export interface RetainedPlan {
  readonly id: string; readonly sourceKey: string; readonly label: string; readonly captureType: PlanCaptureType
  readonly batchNumber: number; readonly iteration: number; readonly generation?: number; readonly resultId?: number; readonly row?: number
  readonly context: PlanExecutionContext; readonly outcome: PlanOutcome; readonly xml: string
  /** A whole plan from a stopped run is distinct from an incomplete/truncated XML document. */
  readonly partialExecution: boolean; readonly incomplete: boolean; readonly xmlTruncated: boolean
  readonly bytes: number; readonly pinned: boolean
}
export interface PlanHistoryState { readonly entries: readonly RetainedPlan[]; readonly bytes: number; readonly pending: number; readonly notice: string }

/** Owns original immutable XML only. Closing query/results/viewers never clears this window's history. */
export class RetainedPlansService extends SnapshotStore<PlanHistoryState> implements Disposable {
  private readonly pending = new Set<AbortController>()
  /** A stopped acquisition still occupies its slot until its last underlying reader settles. */
  private readonly acquisitions = new Set<AbortController>()
  private disposed = false
  constructor(private readonly limits: Readonly<{ entries: number; bytes: number; documentsPerRun: number; acquisitions: number; acquisitionMs: number }> = retainedPlanLimits) {
    super(Object.freeze({ entries: Object.freeze([]), bytes: 0, pending: 0, notice: '' }))
  }
  private change(patch: Partial<PlanHistoryState>): void {
    if (!this.disposed) this.publish(Object.freeze({ ...this.getSnapshot(), ...patch }))
  }
  /** Only two documents can be in flight at once (one per acquisition), each bounded by planLimits.characters.
   * Callers keep their originating handles alive until this settles. Reset aborts pending reads before publishing. */
  async capture(context: PlanExecutionContext, outcome: PlanOutcome, sources: readonly SnapshotSource[], omittedSources = 0): Promise<void> {
    if (this.disposed || !sources.length) return
    if (this.acquisitions.size >= this.limits.acquisitions) { this.change({ notice: 'Plan history is busy copying or stopping earlier XML reads. This execution was not retained.' }); return }
    const stop = new AbortController()
    const immutableContext = Object.freeze({ ...context }), immutableOutcome = Object.freeze({ ...outcome })
    this.pending.add(stop)
    this.acquisitions.add(stop)
    this.change({ pending: this.pending.size, notice: '' })
    const timer = setTimeout(() => stop.abort(new Error('The plan history copy exceeded its time budget.')), this.limits.acquisitionMs)
    let reading: ReturnType<SnapshotSource['read']> | undefined
    let skipped = omittedSources + Math.max(0, sources.length - this.limits.documentsPerRun), reason = skipped ? 'The per-execution document limit was reached.' : ''
    try {
      for (const source of sources.slice(0, this.limits.documentsPerRun)) {
        if (stop.signal.aborted) break
        try {
          const { key: sourceKey, read: _read, ...metadata } = source
          const request = source.read(stop.signal)
          reading = request
          const settled = () => {
            if (reading === request) reading = undefined
            if (!this.pending.has(stop)) this.acquisitions.delete(stop)
          }
          void request.then(settled, settled)
          // A racing backend loss/reset must settle this acquisition even if a reader ignores AbortSignal.
          const value = await abortable(request, stop.signal)
          if (stop.signal.aborted || this.disposed) break
          if (!value.text.length || value.text.length > planLimits.characters) throw new Error('The XML is empty or exceeds the plan document limit.')
          const id = crypto.randomUUID()
          // Include source/id strings and a conservative allowance for each entry's object bookkeeping.
          const bytes = 1024 + 2 * (value.text.length + JSON.stringify({ id, sourceKey, ...metadata, context: immutableContext, outcome: immutableOutcome }).length)
          const entry: RetainedPlan = Object.freeze({ ...metadata, id, sourceKey,
            context: immutableContext, outcome: immutableOutcome, xml: value.text, bytes, pinned: false,
            partialExecution: immutableOutcome.status !== 'completed', incomplete: !!metadata.incomplete, xmlTruncated: !!value.truncated })
          if (!this.add(entry)) { skipped++; reason = 'The history budget is full. Remove or unpin entries to retain more plans.' }
        } catch (error) {
          if (stop.signal.aborted) break
          skipped++; reason = error instanceof Error ? error.message.slice(0, 512) : 'The original XML could not be read.'
        }
      }
      if (stop.signal.aborted && this.pending.has(stop)) this.change({ notice: 'Plan history copying stopped. Already copied snapshots remain available; unread sources were not retained.' })
      else if (!stop.signal.aborted && skipped) this.change({ notice: `${skipped} plan document(s) were not retained. ${reason}` })
    } finally {
      clearTimeout(timer)
      this.pending.delete(stop)
      if (!reading) this.acquisitions.delete(stop)
      this.change({ pending: this.pending.size })
    }
  }
  private add(entry: RetainedPlan): boolean {
    const current = this.getSnapshot()
    // Reject atomically; an oversized document or pinned history must not evict useful entries on failure.
    const pinned = current.entries.filter(item => item.pinned)
    if (entry.bytes > this.limits.bytes || pinned.length >= this.limits.entries || pinned.reduce((sum, item) => sum + item.bytes, 0) + entry.bytes > this.limits.bytes) return false
    const entries = [...current.entries]
    let bytes = current.bytes
    while (entries.length >= this.limits.entries || bytes + entry.bytes > this.limits.bytes) {
      const at = entries.findLastIndex(item => !item.pinned)
      bytes -= entries[at].bytes; entries.splice(at, 1)
    }
    this.change({ entries: Object.freeze([entry, ...entries]), bytes: bytes + entry.bytes })
    return true
  }
  pin(id: string, pinned: boolean): void {
    this.change({ entries: Object.freeze(this.getSnapshot().entries.map(entry => entry.id === id ? Object.freeze({ ...entry, pinned }) : entry)) })
  }
  remove(id: string): void {
    const entries = this.getSnapshot().entries.filter(entry => entry.id !== id)
    this.change({ entries: Object.freeze(entries), bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) })
  }
  /** Both clears invalidate pending acquisitions, preventing delayed responses from resurrecting cleared history. */
  clear(includePinned = false): void {
    for (const stop of this.pending) stop.abort()
    this.pending.clear()
    const entries = includePinned ? [] : this.getSnapshot().entries.filter(entry => entry.pinned)
    this.change({ entries: Object.freeze(entries), bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), pending: 0, notice: '' })
  }
  dispose(): void { this.clear(true); this.disposed = true; this.clearListeners() }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
