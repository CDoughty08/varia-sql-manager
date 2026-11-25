// Job Activity Monitor's bulk Change owner and Attach schedule (AG-3b, docs/sql-server-agent.md): what each sends for one job, and
// the pure rules for which selected jobs get a request. Change owner is its own job verb (`changeJobOwner`: AG-2's identity guard,
// then sp_update_job @owner_login_name; bounds are zod here and C# in ActionService.ValidateAgent); Attach schedule is AG-6c's
// `agentSchedule` update with one guarded job attach, so each job is its own request with its own result. No React here.
import { z } from 'zod'
import type { ObjectRef } from '../explorer/refs.ts'
import { ident } from '../explorer/schema.ts'
import type { AgentScheduleJob, AgentScheduleLink, AgentScheduleRecord, AgentScheduleSave } from '../actions/agent-schedule.ts'

/** actions.execute's Change owner of one job: the job by name and the identity Job Activity Monitor listed, and the new owner's login. */
export interface ChangeJobOwnerRequest {
  readonly action: 'changeJobOwner'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef
  readonly agentIdentity: { readonly jobId: string }
  readonly jobOwner: string
}
export const changeJobOwnerRequestSchema = z.object({
  action: z.literal('changeJobOwner'), connectionId: z.uuid(), requestId: z.uuid(),
  target: z.object({ kind: z.literal('agentJob'), name: ident }).strict(),
  agentIdentity: z.object({ jobId: z.guid() }).strict(),
  jobOwner: ident
}).strict() satisfies z.ZodType<ChangeJobOwnerRequest>

export const agentBulkText = {
  ownerTitle: (jobs: number) => `Change the owner of ${jobs} ${jobs === 1 ? 'job' : 'jobs'}`,
  scheduleTitle: (jobs: number) => `Attach a schedule to ${jobs} ${jobs === 1 ? 'job' : 'jobs'}`,
  ownerSysadmin: "Only a sysadmin can change a job's owner: msdb refuses everyone else.",
  ownerHint: 'The login each job runs as for T-SQL steps, and whose jobs it is. One request per job; a refusal stops only that job.',
  ownerEmpty: 'Choose a login.',
  ownerSame: (owner: string) => `Already owned by ${owner}`,
  ownerDone: (owner: string) => `Owner set to ${owner}`,
  scheduleHint: 'Each job uses the schedule as it is: the schedule is shared, not copied. One request per job; a refusal stops only that job.',
  scheduleNone: 'Choose a schedule.',
  scheduleUnguarded: "This schedule's version could not be read, so it cannot be attached. Refresh the list and try again.",
  scheduleAlready: 'Already uses this schedule',
  scheduleDone: (name: string) => `Attached ${name}`,
  jobUnread: "Not sent: Varia could not read this job's version (msdb may hide it from this login). Refresh and try again.",
  readFailed: 'Varia could not read what this needs.',
  ownJobsOnly: 'Below sysadmin, msdb attaches schedules only to jobs this login owns.',
  formUnavailable: 'Job Activity Monitor cannot reach the server now: reconnect, then try again.',
  formBusy: 'Job Activity Monitor is running a bulk action: wait for it to finish, then try again.'
} as const

/** One selected job's plan: send a request, or a result decided without one (already so, or not sendable). */
export type BulkJobPlan<T> = { readonly send: T } | { readonly state: 'done' | 'failed'; readonly message: string }

/** Change owner for one job: nothing to send when the list already shows exactly that owner. Only an exact match skips: on a
 *  case-sensitive server 'Ops' and 'ops' can be two logins, and sending the same owner again is a harmless no-op. */
export function ownerPlan(job: { readonly owner?: string }, owner: string): BulkJobPlan<string> {
  if (job.owner === owner) return { state: 'done', message: agentBulkText.ownerSame(job.owner) }
  return { send: owner }
}

/** Attach schedule for one job: the `agentSchedule` save (the schedule's guard and the job's version_number guard), or the job's result
 *  when the read shows it already uses the schedule or does not list the job's version. */
export function attachPlan(jobId: string, record: AgentScheduleRecord, jobs: readonly AgentScheduleJob[] | undefined, links: readonly AgentScheduleLink[] | undefined): BulkJobPlan<AgentScheduleSave> {
  const id = jobId.toLowerCase()
  if (links?.some(link => link.scheduleId === record.id && link.jobId.toLowerCase() === id)) return { state: 'done', message: agentBulkText.scheduleAlready }
  const job = jobs?.find(item => item.id.toLowerCase() === id)
  if (!job || record.version === undefined || !record.modified) return { state: 'failed', message: job ? agentBulkText.scheduleUnguarded : agentBulkText.jobUnread }
  return { send: { op: 'update', schedule: { id: record.id, version: record.version, modified: record.modified }, jobs: [{ jobId: job.id, version: job.version, attach: true }] } }
}

/** Why Change owner's Change is not offered, or undefined when it is. */
export function ownerUnavailable(input: { readonly sysadmin?: boolean; readonly owner: string }): string | undefined {
  if (input.sysadmin === false) return agentBulkText.ownerSysadmin
  if (!input.owner.trim()) return agentBulkText.ownerEmpty
  return undefined
}
