import { useSyncExternalStore } from 'react'
import { actionLimits } from '../../../shared/actions/catalog.ts'
import type { ActionProgress } from '../../../shared/actions/schema.ts'
import type { VariaApi } from '../../../shared/contracts'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

/** A long action's latest progress: the step it is on and that step's STATS percent. */
export interface StepProgress { readonly step: number; readonly percent: number }
/** The latest progress of each tracked request, by request id. */
export type ActionProgressSnapshot = ReadonlyMap<string, StepProgress>

/**
 * The latest progress of the long object actions this window runs (a restore's or backup's STATS percent, main's
 * varia:actions-progress). A run tracks its request id before it sends the request and forgets it once the reply came;
 * progress for an id nobody tracks is ignored, so the map stays bounded by the tracked requests (actionLimits.registered).
 * Events are droppable and only the latest value counts, so a late event for an earlier step never moves a bar back.
 */
export class ActionProgressService extends SnapshotStore<ActionProgressSnapshot> implements Disposable {
  private readonly tracked = new Set<string>()
  private readonly unsubscribe: () => void

  constructor(api: Pick<VariaApi, 'onActionProgress'>) {
    super(new Map())
    this.unsubscribe = api.onActionProgress(progress => this.apply(progress))
  }

  /** Starts keeping `requestId`'s progress; false when actionLimits.registered requests are already tracked. */
  track(requestId: string): boolean {
    if (this.tracked.has(requestId)) return true
    if (this.tracked.size >= actionLimits.registered) return false
    this.tracked.add(requestId)
    return true
  }

  /** Stops keeping `requestId`'s progress and drops what it had. */
  forget(requestId: string): void {
    if (!this.tracked.delete(requestId)) return
    const snapshot = this.getSnapshot()
    if (!snapshot.has(requestId)) return
    const next = new Map(snapshot)
    next.delete(requestId)
    this.publish(next)
  }

  latest(requestId: string): StepProgress | undefined { return this.getSnapshot().get(requestId) }

  dispose(): void {
    this.unsubscribe()
    this.tracked.clear()
    this.clearListeners()
  }

  private apply({ requestId, step, percent }: ActionProgress): void {
    if (!this.tracked.has(requestId)) return
    const current = this.getSnapshot().get(requestId)
    if (current && (step < current.step || (step === current.step && percent === current.percent))) return
    this.publish(new Map(this.getSnapshot()).set(requestId, { step, percent }))
  }
}

/** The StepList progress slot for step `index` of a run: its bar and spoken value while that step reports STATS progress. */
export function stepProgress(progress: StepProgress | undefined, index: number): { readonly progress?: number; readonly progressText?: string } {
  return progress && progress.step === index ? { progress: progress.percent, progressText: `${progress.percent} percent processed` } : {}
}

/** A request's latest progress for a component; undefined until its first event, or with no request. */
export function useActionProgress(service: ActionProgressService, requestId: string | undefined): StepProgress | undefined {
  return useSyncExternalStore(service.subscribe, () => requestId === undefined ? undefined : service.latest(requestId))
}
