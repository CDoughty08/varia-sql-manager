import { actionLimits } from '../../shared/actions/catalog.ts'
import { RendererRequests, type CancelTarget } from './renderer-requests'

export const actionRequestLimits = {
  tombstones: actionLimits.tombstones, tombstoneMs: actionLimits.tombstoneMs, running: actionLimits.registered, cancelBatch: actionLimits.cancelIds
} as const

/** Object action requests (describe, script and execute), cancelled through varia:actions-cancel (see RendererRequests). */
export class ActionRequests extends RendererRequests {
  constructor(backend: CancelTarget, now: () => number = Date.now) {
    super(backend, actionRequestLimits, 'object action', now)
  }
}
