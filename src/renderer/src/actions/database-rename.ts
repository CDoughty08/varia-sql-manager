// D3c: what a database's rename reads of Varia's own query windows before it asks to close connections (critic A7), and what
// follows the new name once SQL Server has it. Every connection to the database's server counts, as the backend moves every
// connection to that server that was opened in the database (SqlService.DatabaseChanged).
import { isQueryDocument } from '../documents'
import type { ExternalStore } from '../core/types'
import type { LiveConnection } from '../services/connections'
import type { DocumentService } from '../services/documents'
import type { QueryService } from '../services/queries'
import type { TargetService } from '../services/targets'

/** Query windows a rename's prompt reads the open transaction of: the rest are counted, not read. */
export const ownTabReads = 16

/** Varia's query windows in a database: how many hold a session there, and the names of those with an open transaction. */
export interface OwnTabs { readonly count: number; readonly withTransactions: readonly string[] }
export interface DatabaseRenameHooks {
  /** The query windows with a session in the database, through any connection to the connection's server. */
  tabs(connectionId: string, database: string): Promise<OwnTabs>
  /** SQL Server renamed the database: query windows and Database Properties documents on that server follow the new name. */
  renamed(connectionId: string, database: string, newName: string): void
}
export interface DatabaseRenameHookOptions {
  readonly documents: Pick<DocumentService, 'getSnapshot'>
  readonly queries: Pick<QueryService, 'getSnapshot' | 'transactionState'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly targets: Pick<TargetService, 'changeDatabase'>
  readonly properties: { databaseRenamed(connectionId: string, database: string, newName: string): void }
}

const serverKey = (server: string) => server.trim().toLowerCase()

export function databaseRenameHooks(options: DatabaseRenameHookOptions): DatabaseRenameHooks {
  /** The connections to the connection's server, lost ones included: a Reconnect moves their windows to a new connection. */
  const sameServer = (connectionId: string): ReadonlySet<string> => {
    const connections = options.connections.getSnapshot(), server = connections.find(connection => connection.id === connectionId)?.server
    return new Set(server === undefined ? [connectionId] : connections.filter(connection => serverKey(connection.server) === serverKey(server)).map(connection => connection.id))
  }
  const queriesIn = (connectionId: string, database: string) => {
    const ids = sameServer(connectionId)
    return options.documents.getSnapshot().documents.filter(document => isQueryDocument(document) && document.connectionId !== undefined && ids.has(document.connectionId) && document.database === database)
  }
  return {
    async tabs(connectionId, database) {
      const queries = options.queries.getSnapshot()
      // A window with no session (never run, closed or lost) is no one's connection to close.
      const tabs = queriesIn(connectionId, database).filter(document => queries[document.id]?.session || queries[document.id]?.running)
      const found = await Promise.all(tabs.slice(0, ownTabReads).map(async tab => {
        try { const state = await options.queries.transactionState(tab.id); return state.transactions > 0 || state.unchecked ? [tab.name] : [] } catch { return [tab.name] }
      }))
      return { count: tabs.length, withTransactions: found.flat() }
    },
    renamed(connectionId, database, newName) {
      for (const document of queriesIn(connectionId, database)) options.targets.changeDatabase(document.id, newName)
      options.properties.databaseRenamed(connectionId, database, newName)
    }
  }
}
