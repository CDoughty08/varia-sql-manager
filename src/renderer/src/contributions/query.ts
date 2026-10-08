import type { ApiResult, ConnectionInfo, DatabaseInfo, VariaApi } from '../../../shared/contracts'
import type { Workbench } from '../core/workbench'
import type { Disposable } from '../core/types'
import type { QuickPickItem } from '../quickinput/QuickInputService'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }

/** One server picker row per live connection; `running` disables servers with a query in progress. */
export function serverItems(connections: readonly ConnectionInfo[], running?: (id: string) => boolean): QuickPickItem[] {
  return connections.map(connection => ({
    id: connection.id, label: connection.displayName || connection.server, icon: 'server',
    description: connection.displayName ? `${connection.server} · ${connection.serverVersion}` : connection.serverVersion,
    ...running?.(connection.id) ? { disabled: true, disabledHint: 'A query is running on this server.' } : {}
  }))
}
const databaseGroups = ['system databases', 'databases', 'database snapshots'] as const
/**
 * Database picker rows: system databases, then user databases, then snapshots, each in the server's order. The few
 * system databases come first (Object Explorer also lists them first), so a server with more databases than the picker
 * shows at once never hides master or tempdb.
 */
export function databaseItems(databases: readonly DatabaseInfo[]): QuickPickItem[] {
  const rank = (database: DatabaseInfo) => database.isSnapshot ? 2 : database.isSystem ? 0 : 1
  return [...databases].sort((a, b) => rank(a) - rank(b)).map(database => ({ id: database.name, label: database.name, icon: 'database', group: databaseGroups[rank(database)] }))
}

export function queryContribution({ commands, queries, documents, connections, targets, quickInput }: Pick<Workbench, 'commands' | 'queries' | 'documents' | 'connections' | 'targets' | 'quickInput'>,
  api: Pick<VariaApi, 'databases'>): Disposable {
  const registrations = [
    commands.register('query.execute', { when: () => queries.canExecute(), run: () => queries.execute() }),
    commands.register('query.cancel', { run: () => queries.cancel() }),
    commands.register('query.changeConnection', { run: () => {
      const tab = documents.active
      if (!tab) return
      const tabId = tab.id
      quickInput.show({
        ariaLabel: 'Change Connection', placeholder: 'Select a server for this query', noun: 'servers', activeId: tab.connectionId ?? '',
        items: [{ id: '', label: 'Disconnected', icon: 'debug-disconnect' }, ...serverItems(connections.getSnapshot())],
        // The query may have started running while the picker was open.
        onDidAccept: item => queries.isRunning(tabId) ? undefined : targets.changeConnection(tabId, item.id || undefined)
      })
    } }),
    commands.register('query.changeDatabase', { run: () => {
      const tab = documents.active, connectionId = tab?.connectionId
      if (!tab || !connectionId) return
      const tabId = tab.id
      quickInput.show({
        ariaLabel: 'Change Database', placeholder: 'Select a database for this query', noun: 'databases', activeId: tab.database,
        items: async () => databaseItems(unwrap(await api.databases(connectionId))),
        onDidAccept: item => {
          // The query may have moved to another server, started running, or be saving while the list loaded.
          if (documents.get(tabId)?.connectionId !== connectionId || queries.isRunning(tabId) || documents.getSnapshot().busy) return
          targets.changeDatabase(tabId, item.id)
        }
      })
    } })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
