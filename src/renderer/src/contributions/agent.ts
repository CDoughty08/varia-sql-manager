import { agentBulkCommands, agentBulkVerbs } from '../../../shared/agent/jobs'
import type { LogViewerOpen } from '../agent/LogViewerService'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf } from '../menus/targets'
import { serverItems } from './query'

/**
 * SQL Server Agent's Job Activity Monitor commands (AG-3, docs/sql-server-agent.md), registered only behind the release gate
 * (agentEnabled) so neither the palette nor a menu offers them without it. Job Activity Monitor opens one per connection: the
 * server of the Object Explorer node its menu (or Enter on the Job Activity Monitor node) runs it on, else the active
 * document's, else the selected node's, else the one live connection or the one picked from several. Refresh and the bulk
 * verbs act on the monitor whose header or bar runs them (`tabId`), else the active document. View History (AG-5a) opens the Log
 * File Viewer, one per connection, on the same server: a job's menu checks that job, Job Activity Monitor (its tab active or its
 * bar's button) the jobs selected there, and the Agent node, the Jobs folder and the palette every job. Refresh History and
 * Delete History act on the viewer whose header runs them, else the active document.
 */
export function agentContribution({ commands, jobActivity, logViewer, documents, connections, explorer, quickInput }: Pick<Workbench, 'commands' | 'jobActivity' | 'logViewer' | 'documents' | 'connections' | 'explorer' | 'quickInput'>,
  options: { readonly agentEnabled?: boolean } = {}): Disposable {
  if (!options.agentEnabled) return { dispose: () => {} }
  const live = (id: string | undefined) => id !== undefined && connections.isLiveSqlServer(id) ? id : undefined
  const target = (args?: CommandArgs): string | undefined => {
    const node = explorerNodeOf(args)
    if (node) return node.lost ? undefined : live(node.connectionId)
    return live(documents.active?.connectionId) ?? live(explorer.menuNode(explorer.getSnapshot().selected)?.connectionId)
  }
  const open = (connectionId: string) => {
    try { jobActivity.open(connectionId) } catch (error) { commands.reportError(error instanceof Error ? error.message : 'Job Activity Monitor could not open.') }
  }
  const openHistory = (connectionId: string, where: LogViewerOpen) => {
    try { logViewer.open(connectionId, where) } catch (error) { commands.reportError(error instanceof Error ? error.message : 'The Log File Viewer could not open.') }
  }
  /** Which jobs View History checks: a job node's, else Job Activity Monitor's selection (its tab given or active), else all. */
  const historyWhere = (args?: CommandArgs): LogViewerOpen => {
    const node = explorerNodeOf(args)
    if (node) return node.kind === 'agentJob' ? { jobName: node.label } : {}
    const monitor = jobActivity.get(args?.tabId ?? documents.getSnapshot().activeId)
    return monitor?.selected.length ? { jobs: monitor.selected.map(job => job.id) } : {}
  }
  const viewerOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return logViewer.get(id) ? id : undefined }
  const monitorOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return jobActivity.get(id) ? id : undefined }
  const registrations = [
    commands.register('agent.jobActivity', {
      when: args => { const node = explorerNodeOf(args); return !node || (!node.lost && connections.isLiveSqlServer(node.connectionId)) },
      run: args => {
        const connectionId = target(args)
        if (connectionId) return open(connectionId)
        const choices = connections.liveSqlServer()
        if (choices.length === 1) return open(choices[0].id)
        if (!choices.length) { commands.reportError('Connect to a SQL Server first.'); return }
        quickInput.show({ ariaLabel: 'Job Activity Monitor', placeholder: 'Select a server', noun: 'servers', items: serverItems(choices), onDidAccept: item => open(item.id) })
      }
    }),
    commands.register('agent.viewHistory', {
      when: args => { const node = explorerNodeOf(args); return !node || (!node.lost && connections.isLiveSqlServer(node.connectionId)) },
      run: args => {
        const where = historyWhere(args)
        const connectionId = target(args)
        if (connectionId) return openHistory(connectionId, where)
        const choices = connections.liveSqlServer()
        if (choices.length === 1) return openHistory(choices[0].id, where)
        if (!choices.length) { commands.reportError('Connect to a SQL Server first.'); return }
        quickInput.show({ ariaLabel: 'View History', placeholder: 'Select a server', noun: 'servers', items: serverItems(choices), onDidAccept: item => openHistory(item.id, where) })
      }
    }),
    commands.register('agent.refreshHistory', {
      when: args => { const id = viewerOf(args); return !!id && logViewer.isLive(id) },
      run: args => { const id = viewerOf(args); if (id) logViewer.refresh(id) }
    }),
    commands.register('agent.deleteHistory', {
      when: args => { const id = viewerOf(args); return !!id && logViewer.canDelete(id) },
      unavailable: args => { const id = viewerOf(args); return id ? logViewer.deleteUnavailable(id) : undefined },
      run: args => { const id = viewerOf(args); if (id) logViewer.askDelete(id) }
    }),
    commands.register('agent.refreshJobs', {
      when: args => { const id = monitorOf(args); return !!id && jobActivity.isLive(id) },
      run: args => { const id = monitorOf(args); if (id) jobActivity.refresh(id) }
    }),
    ...agentBulkVerbs.map(verb => commands.register(agentBulkCommands[verb], {
      when: args => { const id = monitorOf(args); return !!id && jobActivity.canBulk(id) },
      unavailable: args => { const id = monitorOf(args); return id ? jobActivity.bulkUnavailable(id) : undefined },
      run: async args => { const id = monitorOf(args); if (id) await jobActivity.runBulk(id, verb) }
    }))
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
