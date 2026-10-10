import { scriptLimits } from '../../shared/scripting/catalog.ts'
import { RendererRequests, type CancelTarget } from './renderer-requests'

export const scriptingRequestLimits = {
  tombstones: scriptLimits.tombstones, tombstoneMs: scriptLimits.tombstoneMs, running: scriptLimits.registered, cancelBatch: scriptLimits.cancelIds
} as const

/** Script As requests, cancelled through varia:scripting-cancel (see RendererRequests). */
export class ScriptingRequests extends RendererRequests {
  constructor(backend: CancelTarget, now: () => number = Date.now) {
    super(backend, scriptingRequestLimits, 'scripting', now)
  }
}
