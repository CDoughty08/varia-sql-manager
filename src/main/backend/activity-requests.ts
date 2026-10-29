import { activityLimits } from '../../shared/activity/catalog.ts'
import { RendererRequests, type CancelTarget } from './renderer-requests'

export const activityRequestLimits = {
  tombstones: activityLimits.cancelTombstones, tombstoneMs: activityLimits.cancelTombstoneMs, running: activityLimits.detailsRunning, cancelBatch: activityLimits.cancelIds
} as const

/** Activity Monitor Details reads, cancelled through varia:activity-cancel when the flyout closes (see RendererRequests).
 *  Kill Process is not registered: it carries no requestId, answers within its own budget, and is never cancelled. */
export class ActivityRequests extends RendererRequests {
  constructor(backend: CancelTarget, now: () => number = Date.now) {
    super(backend, activityRequestLimits, 'Activity Monitor details', now)
  }
}
