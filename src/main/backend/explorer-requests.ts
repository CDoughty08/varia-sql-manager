import { explorerLimits } from '../../shared/explorer/catalog.ts'
import { RendererRequests, type CancelTarget } from './renderer-requests'

export type { CancelTarget } from './renderer-requests'

export const explorerRequestLimits = { tombstones: 1024, tombstoneMs: 60_000, running: 1024 } as const

/** Object Explorer's loads, cancelled through varia:explorer-cancel (see RendererRequests). */
export class ExplorerRequests extends RendererRequests {
  constructor(backend: CancelTarget, now: () => number = Date.now) {
    super(backend, { ...explorerRequestLimits, cancelBatch: explorerLimits.cancelBatch }, 'Object Explorer', now)
  }
}
