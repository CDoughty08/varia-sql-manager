// Test mode only (start.tsx): opens Restore Database, or Restore Files and Filegroups, on the first live connection without
// Object Explorer, so smoke suites reach it at once; the Databases folder's items and a database's Tasks › Restore submenu open
// them for the user (D1f, D1g).
import type { ExternalStore } from '../core/types'
import type { LiveConnection } from '../services/connections'
import type { RestoreService } from './RestoreService'

export interface RestoreTestHook {
  /** The new document's id, or undefined without a live connection. */
  open(database?: string, mode?: 'database' | 'files'): string | undefined
}

export function restoreTestHook(service: RestoreService, connections: ExternalStore<readonly LiveConnection[]>): RestoreTestHook {
  return {
    open(database, mode) {
      const connection = connections.getSnapshot().find(item => !item.lost)
      if (!connection || (database !== undefined && (typeof database !== 'string' || database.length > 128))) return undefined
      if (mode !== undefined && mode !== 'database' && mode !== 'files') return undefined
      return service.open(connection.id, database, undefined, mode)
    }
  }
}
