import { agentLimits } from '../../../shared/agent/catalog'
import { agentBulkCommands, agentBulkFormVerbs, agentBulkVerbs, bulkUnavailable } from '../../../shared/agent/jobs'
import type { LogViewerOpen } from '../agent/LogViewerService'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { windows } from '../core/windows'
import { agentStepOf, explorerNodeOf } from '../menus/targets'
import { stepTypeShort } from '../../../shared/agent/steps'
import { stepActionChoices } from '../agent/step-menus'
import { serverItems } from './query'

/**
 * SQL Server Agent's Job Activity Monitor commands (AG-3, docs/sql-server-agent.md). Job Activity Monitor opens one per connection: the
 * server of the Object Explorer node its menu (or Enter on the Job Activity Monitor node) runs it on, else the active
 * document's, else the selected node's, else the one live connection or the one picked from several. Refresh and the bulk
 * verbs act on the monitor whose header or bar runs them (`tabId`), else the active document. View History (AG-5a) opens the Log
 * File Viewer, one per connection, on the same server: a job's menu checks that job, Job Activity Monitor (its tab active or its
 * bar's button) the jobs selected there, and the Agent node, the Jobs folder and the palette every job. Refresh History and
 * Delete History act on the viewer whose header runs them, else the active document. The Error Logs folder's and its logs' View Agent Log
 * (AG-5b) opens the viewer on that log (Current from the folder) with no job checked, and their Recycle opens it on Current with Recycle's
 * confirmation; Recycle from the palette or the viewer's header asks in the viewer it runs on.
 */
export function agentContribution({ commands, jobActivity, logViewer, documents, connections, explorer, quickInput, jobDocuments, schedules, scripting, agentOverview }: Pick<Workbench, 'commands' | 'jobActivity' | 'logViewer' | 'documents' | 'connections' | 'explorer' | 'quickInput' | 'jobDocuments' | 'schedules' | 'agentOverview'> & Partial<Pick<Workbench, 'scripting'>>): Disposable {
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
  const historyWhere = async (args?: CommandArgs): Promise<LogViewerOpen> => {
    const node = explorerNodeOf(args)
    if (node) return node.kind === 'agentJob' ? { jobName: node.label } : {}
    const monitor = monitorOf(args)
    // The rows a click just before selected (a right-click on another job) are read first.
    const selected = monitor ? await jobActivity.settledSelection(monitor) : []
    return selected.length ? { jobs: selected.map(job => job.id) } : {}
  }
  /** From Job Activity Monitor's own bar and row menu (which name its tab), View History needs its selection: one job up to the bulk
   *  cap (the over-cap rows are not all read). The palette keeps opening every job when none is selected. */
  const historyUnavailable = (args?: CommandArgs): string | undefined => {
    const id = explorerNodeOf(args) || !args?.tabId ? undefined : monitorOf(args)
    if (!id) return undefined
    const count = jobActivity.selectedCount(id)
    return count === 0 ? 'Select one or more jobs to view their history.' : count > agentLimits.startJobs ? bulkUnavailable(count) : undefined
  }
  const viewerOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return logViewer.get(id) ? id : undefined }
  /** The error log an Error Logs menu names: a log node's archive number, else Current (the folder). */
  const errorLogOf = (args?: CommandArgs): number => {
    const node = explorerNodeOf(args)
    const archive = node?.kind === 'agentErrorLog' && node.ref.type === 'object' ? Number(node.ref.object.name) : 0
    return Number.isInteger(archive) && archive >= 0 ? archive : 0
  }
  const monitorOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return jobActivity.get(id) ? id : undefined }
  // Run from Job Activity Monitor, a one-job verb (Open, Create Job Like This) needs exactly one job selected there (AG-10, its row menu).
  const oneInMonitor = (args?: CommandArgs): boolean => { const id = explorerNodeOf(args) ? undefined : monitorOf(args); return !id || jobActivity.selectedCount(id) === 1 }
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
  // A Steps › Flow step menu's step (right-click selected it), else the job document's selected step (Enter and Delete on the graph).
  const stepOf = (args?: CommandArgs): { readonly id: string; readonly key: string } | undefined => {
    const menu = agentStepOf(args)
    if (menu) return jobDocuments.get(menu.tabId)?.draft?.steps.steps.some(step => step.key === menu.key) ? { id: menu.tabId, key: menu.key } : undefined
    const id = jobOf(args), key = id ? jobDocuments.selectedStep(id)?.key : undefined
    return id && key ? { id, key } : undefined
  }
  const onStep = (when: (id: string, key: string, args?: CommandArgs) => boolean, run: (id: string, key: string, args?: CommandArgs) => unknown) => ({
    when: (args?: CommandArgs) => { const step = stepOf(args); return !!step && when(step.id, step.key, args) },
    run: async (args?: CommandArgs) => { const step = stepOf(args); if (step && when(step.id, step.key, args)) await run(step.id, step.key, args) }
  })
  // macOS's pickers for On success…, On failure… and Add step after… (and a Flow port dropped on empty space): the submenus' lists.
  const pickAction = (which: 'success' | 'fail') => onStep(id => jobDocuments.canEditSteps(id), (id, key, args) => {
    const draft = jobDocuments.get(id)?.draft?.steps
    if (!draft) return
    const choices = stepActionChoices(draft, key, which), at = draft.steps.findIndex(step => step.key === key) + 1
    const title = `Step ${at}: ${which === 'success' ? 'On success' : 'On failure'}`
    quickInput.show({
      ariaLabel: title, title, placeholder: 'Select what the step does next', noun: 'actions', sort: 'none', ...args?.anchor ? { anchor: args.anchor } : {},
      items: choices.map(choice => ({ id: choice.id, label: choice.label, ...choice.checked ? { description: 'Current' } : {} })),
      onDidAccept: item => { const choice = choices.find(entry => entry.id === item.id); if (choice) jobDocuments.setStepAction(id, key, which, choice.action, choice.target) }
    })
  })
  // The Schedules document (AG-6c): Manage Schedules and New Schedule… on a server picked as New Job's is; its verbs on the Schedules
  // document whose toolbar runs them, else the active one.
  const schedulesOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return schedules.get(id) ? id : undefined }
  const onSchedules = (when: (id: string) => boolean, run: (id: string) => unknown) => ({
    when: (args?: CommandArgs) => { const id = schedulesOf(args); return !!id && when(id) },
    run: async (args?: CommandArgs) => { const id = schedulesOf(args); if (id && when(id)) await run(id) }
  })
  // The Agent overview (AG-15): on a server picked as Job Activity Monitor's is; Check again on the overview whose header runs it, else the active one.
  const overviewOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return agentOverview.get(id) ? id : undefined }
  const registrations = [
    commands.register('agent.overview', {
      when: args => { const node = explorerNodeOf(args); return !node || (!node.lost && connections.isLiveSqlServer(node.connectionId)) },
      run: args => withServer(args, 'Agent Overview', connectionId => report(() => agentOverview.open(connectionId), 'The Agent overview could not open.'))
    }),
    commands.register('agent.refreshOverview', {
      when: args => { const id = overviewOf(args); return !!id && agentOverview.isLive(id) },
      run: args => { const id = overviewOf(args); if (id) agentOverview.refresh(id) }
    }),
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
      when: args => { const node = explorerNodeOf(args); return (!node || (!node.lost && connections.isLiveSqlServer(node.connectionId))) && !historyUnavailable(args) },
      unavailable: historyUnavailable,
      run: async args => {
        const where = await historyWhere(args)
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
      when: args => { const node = explorerNodeOf(args); return (!node || (!node.lost && connections.isLiveSqlServer(node.connectionId))) && oneInMonitor(args) },
      unavailable: args => oneInMonitor(args) ? undefined : 'Select one job to open it.',
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
      when: args => { const id = monitorOf(args), state = id ? jobActivity.get(id) : undefined; return !!scripting && !!state?.connectionId && connections.isLiveSqlServer(state.connectionId) && !!id && jobActivity.selectedCount(id) === 1 },
      unavailable: args => { const id = monitorOf(args), state = id ? jobActivity.get(id) : undefined; return id && state && jobActivity.selectedCount(id) !== 1 ? 'Select one job to script it.' : undefined },
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
      when: args => { const node = explorerNodeOf(args); return (!node || (!node.lost && connections.isLiveSqlServer(node.connectionId))) && oneInMonitor(args) },
      unavailable: args => oneInMonitor(args) ? undefined : 'Select one job to create a job like it.',
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
    commands.register('agentJob.moveStepDown', onJob(id => jobDocuments.canMoveSelectedStep(id, 1), id => jobDocuments.moveSelectedStep(id, 1))),
    commands.register('agentJob.editStep', onStep(() => true, (id, key) => jobDocuments.openStepEditor(id, key))),
    commands.register('agentJob.startAtThisStep', onStep((id, key) => jobDocuments.canStartAtStep(id, key), (id, key) => jobDocuments.startAtStep(id, key))),
    commands.register('agentJob.makeStartStep', onStep((id, key) => jobDocuments.canEditSteps(id) && jobDocuments.get(id)?.draft?.steps.startKey !== key, (id, key) => jobDocuments.setStartStep(id, key))),
    commands.register('agentJob.setStepAction', onStep((id, _key, args) => jobDocuments.canEditSteps(id) && !!args?.agentStep?.which && !!args.agentStep.action, (id, key, args) => {
      const choice = args!.agentStep!
      jobDocuments.setStepAction(id, key, choice.which!, choice.action!, choice.target)
    })),
    commands.register('agentJob.pickStepOnSuccess', pickAction('success')),
    commands.register('agentJob.pickStepOnFailure', pickAction('fail')),
    commands.register('agentJob.addStepAfter', onStep((id, _key, args) => jobDocuments.canAddStep(id) && !!args?.agentStep?.subsystem, (id, key, args) => jobDocuments.addStepAfter(id, key, args!.agentStep!.subsystem!))),
    commands.register('agentJob.pickStepToAdd', onStep(id => jobDocuments.canAddStep(id), (id, key, args) => {
      const at = (jobDocuments.get(id)?.draft?.steps.steps.findIndex(step => step.key === key) ?? 0) + 1
      quickInput.show({
        ariaLabel: `Add a step after step ${at}`, title: `Add a step after step ${at}`, placeholder: 'Select the type of the new step', noun: 'step types', sort: 'none', ...args?.anchor ? { anchor: args.anchor } : {},
        items: jobDocuments.stepTypes(id).map(subsystem => ({ id: subsystem, label: stepTypeShort(subsystem) })),
        onDidAccept: item => jobDocuments.addStepAfter(id, key, item.id)
      })
    })),
    commands.register('agentJob.deleteStep', onStep(id => jobDocuments.canEditSteps(id), (id, key) => jobDocuments.deleteStepOf(id, key)))
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
