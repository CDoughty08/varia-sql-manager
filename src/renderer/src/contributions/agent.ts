import { agentBulkCommands, agentBulkVerbs } from '../../../shared/agent/jobs'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf } from '../menus/targets'
import { serverItems } from './query'

/**
 * SQL Server Agent's Job Activity Monitor commands (AG-3, docs/sql-server-agent.md), registered only behind the release gate
 * (agentEnabled) so neither the palette nor a menu offers them without it. Job Activity Monitor opens one per connection: the
 * server of the Object Explorer node its menu (or Enter on the Job Activity Monitor node) runs it on, else the active
 * document's, else the selected node's, else the one live connection or the one picked from several. Refresh and the bulk
 * verbs act on the monitor whose header or bar runs them (`tabId`), else the active document.
 */
export function agentContribution({ commands, jobActivity, documents, connections, explorer, quickInput, jobDocuments }: Pick<Workbench, 'commands' | 'jobActivity' | 'documents' | 'connections' | 'explorer' | 'quickInput' | 'jobDocuments'>,
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
  const monitorOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return jobActivity.get(id) ? id : undefined }
  // The job document (AG-6a): Open Job and New Job on a server picked as Job Activity Monitor's is, and the document's verbs on the
  // job document whose header runs them, else the active one.
  const withServer = (args: CommandArgs | undefined, title: string, then: (connectionId: string) => void) => {
    const connectionId = target(args)
    if (connectionId) return then(connectionId)
    const choices = connections.liveSqlServer()
    if (choices.length === 1) return then(choices[0].id)
    if (!choices.length) { commands.reportError('Connect to a SQL Server first.'); return }
    quickInput.show({ ariaLabel: title, placeholder: 'Select a server', noun: 'servers', items: serverItems(choices), onDidAccept: item => then(item.id) })
  }
  const report = (run: () => void, fallback: string) => { try { run() } catch (error) { commands.reportError(error instanceof Error ? error.message : fallback) } }
  const openJob = (connectionId: string, name: string) => report(() => jobDocuments.openJob(connectionId, name), 'The job could not be opened.')
  const pickJob = (connectionId: string) => quickInput.show({
    ariaLabel: 'Open Job', placeholder: 'Select a job', noun: 'jobs',
    items: async signal => (await jobDocuments.jobNames(connectionId, signal)).map(name => ({ id: name, label: name, icon: 'agent-job' as const })),
    onDidAccept: item => openJob(connectionId, item.id)
  })
  const jobOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return jobDocuments.get(id) ? id : undefined }
  const onJob = (when: (id: string) => boolean, run: (id: string, args?: CommandArgs) => unknown) => ({
    when: (args?: CommandArgs) => { const id = jobOf(args); return !!id && when(id) },
    run: async (args?: CommandArgs) => { const id = jobOf(args); if (id && when(id)) await run(id, args) }
  })
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
    commands.register('agent.refreshJobs', {
      when: args => { const id = monitorOf(args); return !!id && jobActivity.isLive(id) },
      run: args => { const id = monitorOf(args); if (id) jobActivity.refresh(id) }
    }),
    ...agentBulkVerbs.map(verb => commands.register(agentBulkCommands[verb], {
      when: args => { const id = monitorOf(args); return !!id && jobActivity.canBulk(id) },
      unavailable: args => { const id = monitorOf(args); return id ? jobActivity.bulkUnavailable(id) : undefined },
      run: async args => { const id = monitorOf(args); if (id) await jobActivity.runBulk(id, verb) }
    }))
    ,
    commands.register('agent.openJob', {
      when: args => { const node = explorerNodeOf(args); return !node || (!node.lost && connections.isLiveSqlServer(node.connectionId)) },
      run: args => {
        // From Job Activity Monitor (its Open, a double-click or Enter): the one job selected there.
        const monitor = monitorOf(args)
        if (monitor) {
          const state = jobActivity.get(monitor), job = state?.selected.length === 1 ? state.selected[0] : undefined
          if (!state?.connectionId || !job) { commands.reportError('Select one job to open it.'); return }
          return openJob(state.connectionId, job.name)
        }
        const node = explorerNodeOf(args)
        if (node?.ref.type === 'object' && node.ref.object.kind === 'agentJob' && node.ref.object.name !== undefined) return openJob(node.connectionId, node.ref.object.name)
        withServer(args, 'Open Job', pickJob)
      }
    }),
    commands.register('agent.newJob', {
      when: args => { const node = explorerNodeOf(args); return !node || (!node.lost && connections.isLiveSqlServer(node.connectionId)) },
      run: args => withServer(args, 'New Job', connectionId => report(() => jobDocuments.newJob(connectionId), 'New Job could not open.'))
    }),
    commands.register('agentJob.save', onJob(id => jobDocuments.canSave(id), id => jobDocuments.save(id))),
    commands.register('agentJob.start', onJob(id => jobDocuments.canStart(id), id => jobDocuments.start(id))),
    commands.register('agentJob.startAtStep', onJob(id => jobDocuments.canStart(id) && jobDocuments.steps(id).length > 0, (id, args) => {
      const steps = jobDocuments.steps(id)
      quickInput.show({
        ariaLabel: 'Start once at step', title: 'Start once at step', placeholder: 'Select the step to start at (the Start step is not changed)', noun: 'steps', sort: 'none',
        items: steps.map(step => ({ id: String(step.id), label: `${step.id}. ${step.name}`, description: step.subsystem })), ...args?.anchor ? { anchor: args.anchor } : {},
        onDidAccept: item => { const step = steps.find(entry => String(entry.id) === item.id); if (step) void jobDocuments.start(id, step.name) }
      })
    })),
    commands.register('agentJob.stop', onJob(id => jobDocuments.canStop(id), id => jobDocuments.stop(id))),
    commands.register('agentJob.reload', onJob(id => jobDocuments.canReload(id), id => jobDocuments.reload(id)))
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
