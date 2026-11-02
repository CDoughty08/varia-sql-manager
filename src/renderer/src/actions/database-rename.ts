// D3c: what a database's rename reads of Varia's own query windows before it asks to close connections (critic A7), and what
// follows the new name once SQL Server has it. Every connection to the database's server counts, as the backend moves every
// connection to that server that was opened in the database (SqlService.DatabaseChanged): those the describe names, by the
// server's own name (another alias of one instance included), and those opened under the same server name, lost ones included.
import type { DatabaseIdentity } from '../../../shared/actions/schema'
import { isQueryDocument } from '../documents'
import type { ExternalStore } from '../core/types'
import type { ConnectionService, LiveConnection } from '../services/connections'
import type { DocumentService } from '../services/documents'
import type { QueryService } from '../services/queries'
import type { TargetService } from '../services/targets'

/** Query windows a rename's prompt reads the open transaction of: the rest are counted, not read. */
export const ownTabReads = 16

/** Varia's query windows in a database: how many hold a session there, and the names of those with an open transaction. */
export interface OwnTabs { readonly count: number; readonly withTransactions: readonly string[] }
export interface DatabaseRenameHooks {
  /** The query windows with a session in the database, through any connection to the connection's server (`connections`: the describe's). */
  tabs(connectionId: string, database: string, connections?: readonly string[]): Promise<OwnTabs>
  /**
   * SQL Server renamed the database: query windows, the connections opened in it (their home database, as the backend's
   * DatabaseChanged moves them) and Database Properties documents on that server follow the new name; `identity` is the database's
   * under it, from the rename's reply.
   */
  renamed(connectionId: string, database: string, newName: string, connections?: readonly string[], identity?: DatabaseIdentity): void
}
export interface DatabaseRenameHookOptions {
  readonly documents: Pick<DocumentService, 'getSnapshot'>
  readonly queries: Pick<QueryService, 'getSnapshot' | 'transactionState'>
  readonly connections: ExternalStore<readonly LiveConnection[]> & Pick<ConnectionService, 'rehome'>
  readonly targets: Pick<TargetService, 'changeDatabase'>
  readonly properties: { databaseRenamed(connectionId: string, database: string, newName: string, connections?: readonly string[], identity?: DatabaseIdentity): void }
}

const serverKey = (server: string) => server.trim().toLowerCase()

export function databaseRenameHooks(options: DatabaseRenameHookOptions): DatabaseRenameHooks {
  /** The connections to the connection's server, lost ones included: a Reconnect moves their windows to a new connection. */
  const sameServer = (connectionId: string, named: readonly string[]): ReadonlySet<string> => {
    const connections = options.connections.getSnapshot(), server = connections.find(connection => connection.id === connectionId)?.server
    const spelled = server === undefined ? [connectionId] : connections.filter(connection => serverKey(connection.server) === serverKey(server)).map(connection => connection.id)
    return new Set([...spelled, ...named])
  }
  const queriesIn = (connectionId: string, database: string, named: readonly string[]) => {
    const ids = sameServer(connectionId, named)
    return options.documents.getSnapshot().documents.filter(document => isQueryDocument(document) && document.connectionId !== undefined && ids.has(document.connectionId) && document.database === database)
  }
  return {
    async tabs(connectionId, database, connections = []) {
      const queries = options.queries.getSnapshot()
      // A window with no session (never run, closed or lost) is no one's connection to close.
      const tabs = queriesIn(connectionId, database, connections).filter(document => queries[document.id]?.session || queries[document.id]?.running)
      const found = await Promise.all(tabs.slice(0, ownTabReads).map(async tab => {
        try { const state = await options.queries.transactionState(tab.id); return state.transactions > 0 || state.unchecked ? [tab.name] : [] } catch { return [tab.name] }
      }))
      return { count: tabs.length, withTransactions: found.flat() }
    },
    renamed(connectionId, database, newName, connections = [], identity) {
      for (const document of queriesIn(connectionId, database, connections)) options.targets.changeDatabase(document.id, newName)
      // New Query on the server node opens in the connection's home, which must not name a database that is gone.
      options.connections.rehome(sameServer(connectionId, connections), database, newName)
      options.properties.databaseRenamed(connectionId, database, newName, connections, identity)
    }
  }
}
