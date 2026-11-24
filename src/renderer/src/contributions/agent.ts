import { agentBulkCommands, agentBulkFormVerbs, agentBulkVerbs } from '../../../shared/agent/jobs'
import type { LogViewerOpen } from '../agent/LogViewerService'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { windows } from '../core/windows'
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
 * Delete History act on the viewer whose header runs them, else the active document. The Error Logs folder's and its logs' View Agent Log
 * (AG-5b) opens the viewer on that log (Current from the folder) with no job checked, and their Recycle opens it on Current with Recycle's
 * confirmation; Recycle from the palette or the viewer's header asks in the viewer it runs on.
 */
export function agentContribution({ commands, jobActivity, logViewer, documents, connections, explorer, quickInput, jobDocuments, schedules, scripting }: Pick<Workbench, 'commands' | 'jobActivity' | 'logViewer' | 'documents' | 'connections' | 'explorer' | 'quickInput' | 'jobDocuments' | 'schedules'> & Partial<Pick<Workbench, 'scripting'>>,
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
  /** The error log an Error Logs menu names: a log node's archive number, else Current (the folder). */
  const errorLogOf = (args?: CommandArgs): number => {
    const node = explorerNodeOf(args)
    const archive = node?.kind === 'agentErrorLog' && node.ref.type === 'object' ? Number(node.ref.object.name) : 0
    return Number.isInteger(archive) && archive >= 0 ? archive : 0
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
  // The Schedules document (AG-6c): Manage Schedules and New Schedule… on a server picked as New Job's is; its verbs on the Schedules
  // document whose toolbar runs them, else the active one.
  const schedulesOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return schedules.get(id) ? id : undefined }
  const onSchedules = (when: (id: string) => boolean, run: (id: string) => unknown) => ({
    when: (args?: CommandArgs) => { const id = schedulesOf(args); return !!id && when(id) },
    run: async (args?: CommandArgs) => { const id = schedulesOf(args); if (id && when(id)) await run(id) }
  })
  const registrations = [
    commands.register('agent.schedules', {
      when: args => { const node = explorerNodeOf(args); return !node || (!node.lost && connections.isLiveSqlServer(node.connectionId)) },
      run: args => withServer(args, 'Manage Schedules', connectionId => report(() => schedules.open(connectionId), 'The Schedules document could not open.'))
    }),
    commands.register('agent.newSchedule', {
      when: args => { const node = explorerNodeOf(args); return !node || (!node.lost && connections.isLiveSqlServer(node.connectionId)) },
      run: args => withServer(args, 'New Schedule', connectionId => report(() => schedules.open(connectionId, true), 'New Schedule could not open.'))
    }),
    commands.register('agentSchedules.save', onSchedules(id => schedules.canSaveAll(id), id => schedules.save(id))),
    commands.register('agentSchedules.refresh', onSchedules(id => schedules.canRefresh(id), id => schedules.refresh(id))),
    commands.register('agentSchedules.delete', onSchedules(id => schedules.canDelete(id), id => schedules.askDelete(id))),
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
    commands.register('agent.viewAgentLog', {
      when: args => { const node = explorerNodeOf(args); return !node || (!node.lost && connections.isLiveSqlServer(node.connectionId)) },
      run: args => withServer(args, 'View Agent Log', connectionId => openHistory(connectionId, { errorLog: errorLogOf(args) }))
    }),
    commands.register('agent.recycleErrorLog', {
      when: args => {
        const node = explorerNodeOf(args)
        if (node) return !node.lost && node.engine === 'box' && connections.isLiveSqlServer(node.connectionId)
        const id = viewerOf(args)
        return id ? logViewer.canRecycle(id) : connections.liveSqlServer().length > 0
      },
      unavailable: args => { const id = explorerNodeOf(args) ? undefined : viewerOf(args); return id ? logViewer.recycleUnavailable(id) : undefined },
      run: args => {
        const id = explorerNodeOf(args) ? undefined : viewerOf(args)
        if (id) return logViewer.askRecycle(id)
        withServer(args, 'Recycle Agent Error Log', connectionId => openHistory(connectionId, { errorLog: 0, recycle: true }))
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
    })),
    // AG-3b: Change owner and Attach schedule open their form for the selected jobs.
    ...agentBulkFormVerbs.map(verb => commands.register(agentBulkCommands[verb], {
      when: args => { const id = monitorOf(args); return !!id && jobActivity.canBulk(id) },
      unavailable: args => { const id = monitorOf(args); return id ? jobActivity.bulkUnavailable(id) : undefined },
      run: async args => { const id = monitorOf(args); if (id) await jobActivity.openForm(id, verb) }
    }))
    ,
    commands.register('agent.openJob', {
      when: args => { const node = explorerNodeOf(args); return !node || (!node.lost && connections.isLiveSqlServer(node.connectionId)) },
      run: async args => {
        // From Job Activity Monitor (its Open, a double-click or Enter): the one job selected there.
        const monitor = monitorOf(args)
        if (monitor) {
          // Enter in the Last run grid below the list is about a history row, not the job.
          if (typeof document !== 'undefined' && windows.activeElement()?.closest('[data-live-table]:not([data-live-table="0"])')) return
          const selected = await jobActivity.settledSelection(monitor)
          const state = jobActivity.get(monitor), job = selected.length === 1 ? selected[0] : undefined
          if (!state?.connectionId || !job) { commands.reportError('Select one job to open it.'); return }
          return openJob(state.connectionId, job.name)
        }
        const node = explorerNodeOf(args)
        if (node?.ref.type === 'object' && node.ref.object.kind === 'agentJob' && node.ref.object.name !== undefined) return openJob(node.connectionId, node.ref.object.name)
        withServer(args, 'Open Job', pickJob)
      }
    }),
    // Script Job as CREATE (AG-10, the monitor's row menu): the one job selected there, through Object Explorer's Script As (ScriptingService), which
    // need not have loaded the job's node; it opens a new query window, as Script Job as › CREATE To › New Query Editor Window does.
    commands.register('agent.scriptJob', {
      when: args => { const id = monitorOf(args), state = id ? jobActivity.get(id) : undefined; return !!scripting && !!state?.connectionId && connections.isLiveSqlServer(state.connectionId) && state.selected.length === 1 },
      unavailable: args => { const id = monitorOf(args), state = id ? jobActivity.get(id) : undefined; return state && state.selected.length !== 1 ? 'Select one job to script it.' : undefined },
      run: async args => {
        const monitor = monitorOf(args)
        if (!monitor || !scripting) return
        const selected = await jobActivity.settledSelection(monitor)
        const state = jobActivity.get(monitor), job = selected.length === 1 ? selected[0] : undefined
        if (!state?.connectionId || !job) { commands.reportError('Select one job to script it.'); return }
        await scripting.run('create', 'newQuery', explorer.objectNode(state.connectionId, { kind: 'agentJob', name: job.name }, job.name))
      }
    }),
    ...(['agent.newJob', 'agent.newJobOnAgent'] as const).map(id => commands.register(id, {
      when: args => { const node = explorerNodeOf(args); return !node || (!node.lost && connections.isLiveSqlServer(node.connectionId)) },
      run: args => withServer(args, 'New Job', connectionId => report(() => jobDocuments.newJob(connectionId), 'New Job could not open.'))
    })),
    // Create Job Like This (AG-6e): the job of the menu's node, of Job Activity Monitor's one selected row, or of the active job document;
    // else the palette asks for a server and a job.
    commands.register('agent.createJobLike', {
      when: args => { const node = explorerNodeOf(args); return !node || (!node.lost && connections.isLiveSqlServer(node.connectionId)) },
      run: async args => {
        const like = (connectionId: string, name: string) => report(() => jobDocuments.createLike(connectionId, name), 'Create Job Like This could not open.')
        // A job's menu names its job, whichever document is active.
        const node = explorerNodeOf(args)
        if (node?.ref.type === 'object' && node.ref.object.kind === 'agentJob' && node.ref.object.name !== undefined) return like(node.connectionId, node.ref.object.name)
        const monitor = node ? undefined : monitorOf(args)
        if (monitor) {
          const selected = await jobActivity.settledSelection(monitor)
          const state = jobActivity.get(monitor), job = selected.length === 1 ? selected[0] : undefined
          if (!state?.connectionId || !job) { commands.reportError('Select one job to create a job like it.'); return }
          return like(state.connectionId, job.name)
        }
        const open = jobOf(args), job = open ? jobDocuments.get(open)?.model?.job : undefined, openConnection = open ? jobDocuments.connectionId(open) : undefined
        if (job && openConnection && connections.isLiveSqlServer(openConnection)) return like(openConnection, job.name)
        withServer(args, 'Create Job Like This', connectionId => quickInput.show({
          ariaLabel: 'Create Job Like This', placeholder: 'Select the job to copy', noun: 'jobs',
          items: async signal => (await jobDocuments.jobNames(connectionId, signal)).map(name => ({ id: name, label: name, icon: 'agent-job' as const })),
          onDidAccept: item => like(connectionId, item.id)
        }))
      }
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
    commands.register('agentJob.reload', onJob(id => jobDocuments.canReload(id), id => jobDocuments.reload(id))),
    commands.register('agentJob.moveStepUp', onJob(id => jobDocuments.canMoveSelectedStep(id, -1), id => jobDocuments.moveSelectedStep(id, -1))),
    commands.register('agentJob.moveStepDown', onJob(id => jobDocuments.canMoveSelectedStep(id, 1), id => jobDocuments.moveSelectedStep(id, 1)))
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
