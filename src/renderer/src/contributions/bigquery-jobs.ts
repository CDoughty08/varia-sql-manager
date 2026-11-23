import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf } from '../menus/targets'
import { serverItems } from './query'

/**
 * BigQuery Job History's commands (BQ-9, docs/bigquery.md, Job History). Job History opens one document per BigQuery
 * connection: the connection of the Object Explorer node its menu runs on (the server node, or the billing project's: an
 * extra project's history is not offered, since jobs belong to the billing project), a Messages job id's tab or the records
 * dialog (`bigQueryJobs`, filtered to those jobs), else the active document's, else the selected node's, else the one live
 * BigQuery connection or the one picked from several. The row actions act on the job selected in the document whose menu or
 * header runs them (`tabId`), else the active one.
 */
export function bigQueryJobsContribution({ commands, jobHistory, documents, connections, explorer, quickInput }: Pick<Workbench, 'commands' | 'jobHistory' | 'documents' | 'connections' | 'explorer' | 'quickInput'>): Disposable {
  const live = (id: string | undefined) => id !== undefined && connections.isLiveBigQuery(id) ? id : undefined
  /** An Object Explorer node's connection, when Job History applies to it: the server node, or its billing project. */
  const nodeConnection = (args?: CommandArgs): string | undefined | false => {
    const node = explorerNodeOf(args)
    if (!node) return undefined
    if (node.lost || !live(node.connectionId)) return false
    if (node.kind === 'bqProject') {
      const options = connections.get(node.connectionId)?.options
      const billing = options && 'provider' in options && options.provider === 'bigquery' ? options.project : undefined
      return !!billing && (node.ref.type === 'object' ? node.ref.object.name : undefined) === billing ? node.connectionId : false
    }
    return node.kind === 'server' ? node.connectionId : false
  }
  const target = (args?: CommandArgs): string | undefined => {
    if (args?.bigQueryJobs) return live(args.bigQueryJobs.connectionId)
    const node = nodeConnection(args)
    if (node !== undefined) return node || undefined
    return live(documents.active?.connectionId) ?? live(explorer.menuNode(explorer.getSnapshot().selected)?.connectionId)
  }
  const open = (connectionId: string, args?: CommandArgs) => {
    try {
      jobHistory.open(connectionId, args?.bigQueryJobs?.jobs)
      documents.focusActive()
    } catch (error) { commands.reportError(error instanceof Error ? error.message : 'Job History could not open.') }
  }
  const documentOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return jobHistory.get(id) ? id : undefined }
  const on = (action: (id: string) => unknown, when: (id: string) => boolean = id => jobHistory.usable(id)) => ({
    when: (args?: CommandArgs) => { const id = documentOf(args); return !!id && when(id) },
    run: async (args?: CommandArgs) => { const id = documentOf(args); if (id && when(id)) await action(id) }
  })
  const registrations = [
    commands.register('bigquery.jobHistory', {
      // An extra project's node offers it greyed: its jobs are the billing project's.
      when: args => nodeConnection(args) !== false,
      run: args => {
        const connectionId = target(args)
        if (connectionId) return open(connectionId, args)
        if (args?.bigQueryJobs || explorerNodeOf(args)) { commands.reportError('Connect to BigQuery first.'); return }
        const choices = connections.liveBigQuery()
        if (choices.length === 1) return open(choices[0].id, args)
        if (!choices.length) { commands.reportError('Connect to BigQuery first.'); return }
        quickInput.show({ ariaLabel: 'Job History', placeholder: 'Select a BigQuery connection', noun: 'connections', items: serverItems(choices), onDidAccept: item => open(item.id, args) })
      }
    }),
    commands.register('bigquery.openJobResults', on(id => jobHistory.attach(id, 'openResults'))),
    commands.register('bigquery.reattachJob', on(id => jobHistory.attach(id, 'reattach'))),
    commands.register('bigquery.openJobSql', on(id => jobHistory.openSql(id, false))),
    commands.register('bigquery.rerunJob', on(id => jobHistory.openSql(id, true))),
    commands.register('bigquery.cancelJob', on(id => jobHistory.requestCancel(id))),
    commands.register('bigquery.copyJobId', on(id => jobHistory.copy(id, 'id'))),
    commands.register('bigquery.copyJobLink', on(id => jobHistory.copy(id, 'link'))),
    commands.register('bigquery.jobDetails', on(id => jobHistory.toggleDetails(id), () => true)),
    commands.register('bigquery.refreshJobs', on(id => jobHistory.refresh(id), id => jobHistory.refreshable(id))),
    commands.register('bigquery.pauseJobs', on(id => jobHistory.togglePause(id), id => jobHistory.pausable(id)))
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
