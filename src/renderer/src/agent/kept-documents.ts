// Hot exit and AutoRecover for SQL Server Agent documents (AG-6g, docs/hot-exit.md › SQL Server Agent documents): what the Agent document
// services share to reopen a kept state. The state's format and its checks are in shared/agent/kept.ts.
import type { ExternalStore } from '../core/types'
import type { LiveConnection } from '../services/connections'

/** A live connection to `targetId`, which a document reopened while its target is already connected takes at once. */
export function liveConnectionOn(connections: ExternalStore<readonly LiveConnection[]>, targetIdOf: ((connectionId: string) => string | undefined) | undefined, targetId: string | undefined): string | undefined {
  if (!targetId || !targetIdOf) return undefined
  return connections.getSnapshot().find(connection => !connection.lost && (!connection.lifecycle || connection.lifecycle.state === 'connected') && targetIdOf(connection.id) === targetId)?.id
}
