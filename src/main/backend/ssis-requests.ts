import { ssisLimits } from '../../shared/ssis/catalog.ts'
import { RendererRequests, type CancelTarget } from './renderer-requests'

export const ssisRequestLimits = {
  tombstones: ssisLimits.tombstones, tombstoneMs: ssisLimits.tombstoneMs, running: ssisLimits.registered, cancelBatch: ssisLimits.cancelIds
} as const

/** SSIS Catalog requests (ssis.*), cancelled through varia:ssis-cancel (see RendererRequests). */
export class SsisRequests extends RendererRequests {
  constructor(backend: CancelTarget, now: () => number = Date.now) {
    super(backend, ssisRequestLimits, 'Integration Services', now)
  }
}
