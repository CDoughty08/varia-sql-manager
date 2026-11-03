// Test mode only (start.tsx): opens Restore Database on the first live connection without Object Explorer, so smoke suites
// reach it at once; the Databases folder's Restore Database… and Tasks › Restore › Database… open it for the user (D1f).
import type { ExternalStore } from '../core/types'
import type { LiveConnection } from '../services/connections'
import type { RestoreService } from './RestoreService'

export interface RestoreTestHook {
  /** The new document's id, or undefined without a live connection. */
  open(database?: string): string | undefined
}

export function restoreTestHook(service: RestoreService, connections: ExternalStore<readonly LiveConnection[]>): RestoreTestHook {
  return {
    open(database) {
      const connection = connections.getSnapshot().find(item => !item.lost)
      if (!connection || (database !== undefined && (typeof database !== 'string' || database.length > 128))) return undefined
      return service.open(connection.id, database)
    }
  }
}
