import type { ApiResult, ConnectionInfo, DatabaseInfo, VariaApi } from '../../../shared/contracts'
import type { Workbench } from '../core/workbench'
import type { Disposable } from '../core/types'
import type { QuickPickItem } from '../quickinput/QuickInputService'
import { isQueryDocument } from '../documents'
import { executeMultiTab } from '../services/multi-execute'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }

/** One server picker row per connection; `busy` says why one cannot be chosen now (a query running on it), which greys it with that hint. */
export function serverItems(connections: readonly ConnectionInfo[], busy?: (id: string) => string | undefined): QuickPickItem[] {
  return connections.map(connection => {
    const hint = busy?.(connection.id)
    return {
      id: connection.id, label: connection.displayName || connection.server, icon: 'server',
      description: connection.displayName ? `${connection.server} · ${connection.serverVersion}` : connection.serverVersion,
      ...hint ? { disabled: true, disabledHint: hint } : {}
    }
  })
}
const databaseGroups = ['system databases', 'databases', 'database snapshots'] as const
/**
 * Database picker rows: system databases, then user databases, then snapshots, each in the server's order. The few
 * system databases come first (Object Explorer also lists them first), so a server with more databases than the picker
 * shows at once never hides master or tempdb.
 */
export function databaseItems(databases: readonly DatabaseInfo[], datasets = false): QuickPickItem[] {
  // A BigQuery query's datasets, with no default dataset first as a choice (the query bar's box offers it too).
  if (datasets) return [{ id: '', label: noDefaultDataset, icon: 'circle-slash' }, ...databases.map((database): QuickPickItem => ({ id: database.name, label: database.name, icon: 'database', group: 'datasets' }))]
  const rank = (database: DatabaseInfo) => database.isSnapshot ? 2 : database.isSystem ? 0 : 1
  return [...databases].sort((a, b) => rank(a) - rank(b)).map(database => ({ id: database.name, label: database.name, icon: 'database', group: databaseGroups[rank(database)] }))
}
export const noDefaultDataset = '<no default dataset>'

export function queryContribution(
  { commands, queries, documents, connections, targets, quickInput, events, backend, settings, costOptOut, costPrompts, multiExecutePrompts, notifications }:
    Pick<Workbench, 'commands' | 'queries' | 'documents' | 'connections' | 'targets' | 'quickInput' | 'events' | 'backend'>
    & Partial<Pick<Workbench, 'settings' | 'costOptOut' | 'costPrompts' | 'multiExecutePrompts' | 'notifications'>>,
  api: Pick<VariaApi, 'databases'> & Partial<Pick<VariaApi, 'bigQueryDryRun'>>
): Disposable {
  const targetTab = (tabId?: string) => tabId ? documents.get(tabId) : documents.active
  /** Only an idle single-server query may request explicit connection. Multi-target tabs never fall through here. */
  const connectsFirst = (tabId?: string) => {
    const tab = targetTab(tabId)
    if (!tab || !isQueryDocument(tab) || tab.multiMode || queries.isRunning(tab.id) || documents.getSnapshot().busy || backend.getSnapshot().state.status !== 'ready') return false
    const target = tab.targetId ? connections.connectionTargets.get(tab.targetId) : undefined
    if (target?.lifecycle.state === 'connecting' || target?.lifecycle.state === 'disconnecting') return false
    // An obsolete handle without a canonical target is not enough evidence to choose a reconnect identity.
    return !tab.connectionId || target?.lifecycle.state === 'disconnected' || target?.lifecycle.state === 'lost'
  }
  const inFlightMulti = new Map<string, AbortController>()
  const abortInFlightMulti = (tabId: string) => {
    const controller = inFlightMulti.get(tabId)
    if (!controller) return
    inFlightMulti.delete(tabId)
    controller.abort()
  }
  const eventsSubscription = events.subscribe(event => {
    if (event.type === 'documents.closed') abortInFlightMulti(event.tabId)
  })
  const canExecuteMulti = (tabId?: string) => {
    const tab = targetTab(tabId)
    return !!tab && isQueryDocument(tab) && !!tab.multiMode
      && !inFlightMulti.has(tab.id)
      && !queries.isRunning(tab.id) && !documents.getSnapshot().busy
      && backend.getSnapshot().state.status === 'ready'
  }
  const executesAttached = (tabId?: string) => {
    const tab = targetTab(tabId)
    return !!tab && !tab.multiMode && !!tab.connectionId && connections.isLive(tab.connectionId) && queries.canExecute(tab.id)
  }
  const registrations = [
    // SSMS's F5 on a disconnected single-server query opens Connect, then runs the query on the server chosen.
    // Multi-server and Cross-Engine tabs route exclusively through executeMultiTab (never single-server connectsFirst).
    commands.register('query.execute', {
      when: args => canExecuteMulti(args?.tabId) || executesAttached(args?.tabId) || connectsFirst(args?.tabId),
      run: args => {
        const tab = targetTab(args?.tabId)
        if (!tab) return
        if (tab.multiMode) {
          if (!canExecuteMulti(tab.id) || !settings || !costOptOut || !costPrompts || !multiExecutePrompts) return
          const controller = new AbortController()
          inFlightMulti.set(tab.id, controller)
          return executeMultiTab(tab.id, {
            documents,
            connections,
            queries,
            settings,
            api: { bigQueryDryRun: api.bigQueryDryRun ?? (async () => ({ ok: false as const, error: 'BigQuery dry run is unavailable.' })) },
            optOut: costOptOut,
            costPrompts,
            multiExecutePrompts,
            notify: (message, severity = 'warning') => { notifications?.notify({ severity, message }) },
            disableIncompleteWarning: () => settings.choose('queryExecution.bigQuery.incompleteEstimateWarning', false)
          }, controller.signal).finally(() => {
            if (inFlightMulti.get(tab.id) === controller) inFlightMulti.delete(tab.id)
          }).then(() => undefined)
        }
        if (executesAttached(tab.id)) return queries.execute(tab.id)
        if (connectsFirst(tab.id)) events.emit({ type: 'query.connectRequested', tabId: tab.id })
      }
    }),
    // A results strip's Stop query and a split group's query bar name their own tab; menus, keys and the classic toolbar cancel the active one.
    commands.register('query.cancel', { run: args => {
      const tab = targetTab(args?.tabId)
      if (tab) abortInFlightMulti(tab.id)
      return queries.cancel(args?.tabId)
    } }),
    commands.register('query.estimatePlan', {
      when: args => executesAttached(args?.tabId),
      run: args => { if (executesAttached(args?.tabId)) return queries.estimate(args?.tabId) }
    }),
    commands.register('query.estimateSessionPlan', {
      when: args => executesAttached(args?.tabId),
      run: args => { if (executesAttached(args?.tabId)) return queries.estimate(args?.tabId, 'session') }
    }),
    commands.register('query.includeActualPlan', {
      when: args => { const tab = targetTab(args?.tabId); return !!tab && isQueryDocument(tab) && !tab.multiMode },
      run: args => {
        const tab = targetTab(args?.tabId)
        if (tab && isQueryDocument(tab) && !tab.multiMode) documents.update(tab.id, { includeActualPlan: !tab.includeActualPlan })
      }
    }),
    commands.register('query.includeLivePlan', {
      when: args => { const tab = targetTab(args?.tabId); return !!tab && isQueryDocument(tab) && !tab.multiMode },
      run: args => {
        const tab = targetTab(args?.tabId)
        if (tab && isQueryDocument(tab) && !tab.multiMode) documents.update(tab.id, { includeLivePlan: !tab.includeLivePlan })
      }
    }),
    commands.register('query.includeClientStatistics', {
      when: args => { const tab = targetTab(args?.tabId); return !!tab && isQueryDocument(tab) && !tab.multiMode },
      run: args => {
        const tab = targetTab(args?.tabId)
        if (tab && isQueryDocument(tab) && !tab.multiMode) {
          documents.update(tab.id, { includeClientStatistics: !tab.includeClientStatistics })
          if (!tab.includeClientStatistics) void commands.execute('window.statistics', undefined, 'toolbar')
        }
      }
    }),
    commands.register('query.resetClientStatistics', { run: () => { const tab = documents.active; if (tab) queries.statistics.reset(tab.id) } }),
    commands.register('query.changeConnection', { run: () => {
      const tab = documents.active
      if (!tab) return
      const tabId = tab.id
      quickInput.show({
        ariaLabel: 'Change Connection', placeholder: 'Select a server for this query', noun: 'servers', activeId: tab.connectionId ?? '',
        items: [{ id: '', label: 'Disconnected', icon: 'debug-disconnect' }, ...serverItems(connections.live())],
        // The query may have started running while the picker was open.
        onDidAccept: item => queries.isRunning(tabId) ? undefined : targets.changeConnection(tabId, item.id || undefined)
      })
    } }),
    // Ends the query's session first, as Change Connection… → Disconnected does.
    commands.register('query.disconnect', { run: async () => { const tab = documents.active; if (tab && !queries.isRunning(tab.id)) await targets.changeConnection(tab.id, undefined) } }),
    commands.register('query.disconnectAll', { run: () => targets.disconnectAll() }),
    commands.register('query.changeDatabase', { run: () => {
      const tab = documents.active, connectionId = tab?.connectionId
      if (!tab || !connectionId) return
      const tabId = tab.id, datasets = connections.get(connectionId)?.providerId === 'bigquery'
      quickInput.show({
        ariaLabel: 'Change Database', placeholder: datasets ? 'Select a default dataset for this query' : 'Select a database for this query', noun: datasets ? 'datasets' : 'databases', activeId: tab.database,
        items: async () => databaseItems(unwrap(await api.databases(connectionId)), datasets),
        onDidAccept: item => {
          // The query may have moved to another server, started running, or be saving while the list loaded.
          if (documents.get(tabId)?.connectionId !== connectionId || queries.isRunning(tabId) || documents.getSnapshot().busy) return
          targets.changeDatabase(tabId, item.id)
        }
      })
    } })
  ]
  return {
    dispose: () => {
      eventsSubscription.dispose()
      for (const controller of inFlightMulti.values()) controller.abort()
      inFlightMulti.clear()
      registrations.forEach(registration => registration.dispose())
    }
  }
}
