// SQL Server Agent's dialogs from Object Explorer (AG-2): Start Job at Step on a job, and the Agent node's Start, Stop and Restart
// confirmations, which stay open on their steps as SSMS's service progress dialog does. No React here (definitions.ts).
import type { AgentServiceAction } from '../../../shared/actions/catalog.ts'
import type { AgentJobFacts, AgentServiceFacts, AgentServiceStateName } from '../../../shared/actions/schema.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import type { BuiltRequest, ObjectDialogDefinition } from './definitions'

/** Start Job at Step's choice: the step it starts at, by id (the first step unless chosen), and the job's creation time as the tree listed
 *  it, when it did. */
export interface StartJobDraft { readonly step: number; readonly listed?: string }
/** The service dialogs have nothing to choose. */
export type AgentServiceDraft = Readonly<Record<never, never>>

/** The dialogs' words, which the pages, the tests and the docs share. */
export const agentDialogText = {
  startStep: 'Start at step',
  noSteps: 'This job has no steps, so SQL Server Agent cannot start it.',
  disabled: 'The job is disabled. SQL Server Agent starts it all the same when asked.',
  running: 'The job is already running.',
  replaced: 'This job was deleted and created again since Object Explorer listed it. Refresh Object Explorer.',
  started: (label: string) => `Started the job ${label}.`,
  stopped: (label: string) => `Asked SQL Server Agent to stop the job ${label}.`,
  enabled: (label: string) => `Enabled the job ${label}.`,
  disabledJob: (label: string) => `Disabled the job ${label}.`,
  /** The service dialogs' question, as SSMS asks it before it starts, stops or restarts a service. */
  confirm: (action: AgentServiceAction, service: string, machine: string) =>
    `Are you sure you want to ${action === 'startAgent' ? 'start' : action === 'stopAgent' ? 'stop' : 'restart'} the ${service} service on ${machine}?`,
  stopNote: 'Jobs that are running stop with it, and schedules and alerts do not run until it starts again.',
  restartNote: 'Jobs that are running stop with it.',
  state: (state: AgentServiceStateName) => ({
    stopped: 'Stopped', startPending: 'Starting', stopPending: 'Stopping', running: 'Running', continuePending: 'Resuming', pausePending: 'Pausing', paused: 'Paused', unreadable: 'Unknown (this account may not read it)'
  })[state]
} as const

/** Why Start Job at Step cannot run: a job created since the tree listed the row (so not the one chosen), one with no steps, or one
 *  already running. */
export function startJobBlocked(model: AgentJobFacts, draft?: StartJobDraft): string | undefined {
  if (draft?.listed && draft.listed !== model.agentIdentity.created) return agentDialogText.replaced
  if (!model.steps.length) return agentDialogText.noSteps
  if (model.running) return agentDialogText.running
  return undefined
}

/**
 * Start Job at Step (SSMS's Start Job at Step…): a job with one step starts as the dialog opens, as SSMS's does; one with more lists
 * its steps, the first chosen. sp_start_job always gets the chosen step by name: without one it starts at the job's start step, which
 * need not be the first.
 */
export const startJobAtStepDefinition: ObjectDialogDefinition<AgentJobFacts, StartJobDraft> = {
  dialog: 'startJobAtStep',
  modelOf: result => result.agentJob,
  initialDraft: model => ({ step: model.steps[0]?.id ?? 1 }),
  request: (target, model, draft) => {
    const chosen = model.steps.find(step => step.id === draft.step)
    return { action: 'startJob', target, agentIdentity: model.agentIdentity, ...(chosen ? { stepName: chosen.name } : {}) }
  },
  blocked: startJobBlocked,
  runOnOpen: model => model.steps.length === 1 && !model.running,
  okLabel: () => 'Start',
  // The Jobs folder's row says nothing about running; the notice says it started.
  afterSuccess: (effects, _request, subject) => effects.notify(agentDialogText.started(displayText(subject.label)))
}

const serviceDefinition = (dialog: AgentServiceAction, label: string): ObjectDialogDefinition<AgentServiceFacts, AgentServiceDraft> => ({
  dialog,
  modelOf: result => result.agentService,
  initialDraft: () => ({}),
  request: target => ({ action: dialog, target }) as unknown as BuiltRequest,
  okLabel: () => label,
  noScript: true,
  keepOpen: true,
  longRun: dialog,
  // The Agent node's state (which greys its verbs) is sampled again at once rather than at the next interval, after a run that
  // finished or stopped part way (a Restart whose Start was refused leaves the service stopped); nothing reloads.
  afterSuccess: effects => effects.refreshStatus?.(),
  afterPartial: effects => effects.refreshStatus?.()
})
export const startAgentDefinition = serviceDefinition('startAgent', 'Start')
export const stopAgentDefinition = serviceDefinition('stopAgent', 'Stop')
export const restartAgentDefinition = serviceDefinition('restartAgent', 'Restart')
