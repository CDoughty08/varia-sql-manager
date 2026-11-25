// The Agent overview's fixes (AG-15): each check's fix runs through the surface that owns it, and the overview itself writes nothing. A fix
// that cannot run throws a sentence, which the overview shows as its notice.
import { agentLimits } from '../../../shared/agent/catalog'
import type { CommandService } from '../core/commands'
import type { ObjectDialogService } from '../dialogs/ObjectDialogService'
import type { ExplorerService } from '../explorer/ExplorerService'
import { selectSection } from '../kit/document-frame'
import type { OperatorsDocumentService } from './AlertOperatorDocumentService'
import type { AgentOverviewFixes } from './AgentOverviewService'
import type { JobActivityService } from './JobActivityService'
import { jobSections, type JobDocumentService } from './JobDocumentService'
import type { SchedulesService } from './SchedulesService'

export interface AgentOverviewFixDeps {
  readonly jobActivity: Pick<JobActivityService, 'open' | 'setView' | 'openForm'>
  readonly jobDocuments: Pick<JobDocumentService, 'openJob' | 'get' | 'setFrame'>
  readonly dialogs: Pick<ObjectDialogService, 'open' | 'setPage'>
  readonly operatorsDocuments: Pick<OperatorsDocumentService, 'open' | 'setAsk'>
  readonly schedules: Pick<SchedulesService, 'open'>
  readonly explorer: Pick<ExplorerService, 'agentNodeOf'>
  /** The command service, read when a fix runs (the workbench creates it after the overview). */
  readonly commands: () => Pick<CommandService, 'isEnabled' | 'unavailableReason' | 'execute'>
}

export const agentOverviewFixText = {
  noAgentNode: 'Expand the server in Object Explorer until its SQL Server Agent node shows, then try again.',
  cannotStart: 'SQL Server Agent cannot be started from Varia now: use the SQL Server Agent node in Object Explorer, which says why.',
  firstJobs: (shown: number, all: number) => `Change owner… opened for the first ${shown} of ${all} jobs, as each is its own request; check again once they are done.`
}

export function createAgentOverviewFixes(deps: AgentOverviewFixDeps): AgentOverviewFixes {
  const { jobActivity, jobDocuments, dialogs, operatorsDocuments, schedules, explorer } = deps
  const agentNode = (connectionId: string) => {
    const node = explorer.agentNodeOf(connectionId)
    if (!node) throw new Error(agentOverviewFixText.noAgentNode)
    return node
  }
  return {
    failedJobs: connectionId => { const id = jobActivity.open(connectionId); jobActivity.setView(id, 'failed') },
    changeOwner: async (connectionId, jobs) => {
      const id = jobActivity.open(connectionId), first = jobs.slice(0, agentLimits.startJobs)
      const refused = await jobActivity.openForm(id, 'changeOwner', first.map(job => ({ id: job.id, name: job.name, status: '', lastRun: '', owner: job.owner })))
      if (refused) throw new Error(refused)
      if (first.length < jobs.length) throw new Error(agentOverviewFixText.firstJobs(first.length, jobs.length))
    },
    openJob: (connectionId, name, section) => {
      const id = jobDocuments.openJob(connectionId, name)
      const state = jobDocuments.get(id)
      if (section && state) jobDocuments.setFrame(id, selectSection(state.frame, jobSections, section))
    },
    agentProperties: (connectionId, page) => { dialogs.open('agentProperties', agentNode(connectionId)); if (page) dialogs.setPage(page) },
    recommendedAlerts: connectionId => { const id = operatorsDocuments.open(connectionId, { kind: 'agent' }); operatorsDocuments.setAsk(id, 'recommended') },
    schedules: connectionId => { schedules.open(connectionId) },
    // Start is the Agent node's own command, with its rules (Varia on Windows, not clustered, not already starting): one it refuses says why.
    startAgent: async connectionId => {
      const commands = deps.commands(), args = { target: { kind: 'explorer' as const, node: agentNode(connectionId) } }
      if (!commands.isEnabled('explorer.startAgent', args)) throw new Error(commands.unavailableReason('explorer.startAgent', args) ?? agentOverviewFixText.cannotStart)
      if (!await commands.execute('explorer.startAgent', args, 'toolbar')) throw new Error(agentOverviewFixText.cannotStart)
    }
  }
}
