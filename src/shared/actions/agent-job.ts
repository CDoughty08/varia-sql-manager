// The SQL Server Agent job document (AG-6a, docs/agent-plan.md › Jobs, docs/agent-ui-rethink.md › rx-job-*): what its describe reads,
// the draft the document edits, what Save sends (one `agentJob` action: New Job's sp_add_job and sp_add_jobserver, or an existing job's
// sp_update_job with only the changed arguments and a sp_update_alert per removed alert, in one transaction under the STALE guard), the
// warnings it shows (never blocking), and the field-by-field compare a STALE refusal opens. Bounds are zod here and C# in
// ActionService.ValidateAgentJob. Steps, Schedules and History are later lanes (AG-6b, AG-6c, AG-6d). No React here.
import { z } from 'zod'
import { agentGateOpen, agentLimits, notifyLevels, type AgentPlatform } from '../agent/catalog.ts'
import { ident } from '../explorer/schema.ts'
import { initialJobSchedules, jobScheduleChangeCount, jobScheduleProblems, jobSchedulesSave, jobSchedulesSaveProblems, jobSchedulesSaveSchema, jobSchedulesValue, momentOfText, ownsSchedule, rebaseJobSchedules,
  type AgentJobSchedulesSave, type AgentScheduleRecord, type JobScheduleEntry } from './agent-schedule.ts'

/** sp_help_job's notify and delete levels: 0 never, 1 on success, 2 on failure, 3 on completion. */
export type AgentNotifyLevel = 0 | 1 | 2 | 3
export const agentNotifyLevels = [0, 1, 2, 3] as const satisfies readonly AgentNotifyLevel[]
export const notifyLevelLabel = (level: AgentNotifyLevel): string => notifyLevels.find(entry => entry.code === level)?.label ?? 'Never'
/** The category msdb gives a job with none (sp_add_job's default). */
export const uncategorizedCategory = '[Uncategorized (Local)]'

/** One pager on-duty window, as `hhmmss` integers in server time (sysoperators). */
export interface AgentDutyHours { readonly start: number; readonly end: number }
/** An operator as the Notifications section offers it: whether it has each address, and its pager's on-duty days and hours. */
export interface AgentJobOperator {
  readonly name: string
  readonly enabled: boolean
  readonly email: boolean
  readonly pager: boolean
  readonly netSend: boolean
  /** sysoperators.pager_days: Sunday 1, Monday 2, … Saturday 64. */
  readonly pagerDays: number
  readonly weekday: AgentDutyHours
  readonly saturday: AgentDutyHours
  readonly sunday: AgentDutyHours
}
/** An alert that runs this job (sp_help_alert, filtered by job_id). */
export interface AgentJobAlert { readonly id: number; readonly name: string; readonly enabled: boolean; readonly severity: number; readonly messageId: number }
export interface AgentJobStep { readonly id: number; readonly name: string; readonly subsystem: string }
/** The job as sp_help_job describes it. `created` is the identity (date_created to the second); `modified` (to the millisecond) and
 *  `version` are what the STALE guard compares. Dates are the server's local time, as msdb stores them. */
export interface AgentJobRecord {
  readonly jobId: string
  readonly name: string
  readonly enabled: boolean
  readonly description: string
  readonly category: string
  readonly owner: string
  readonly emailLevel: AgentNotifyLevel; readonly emailOperator: string
  readonly pageLevel: AgentNotifyLevel; readonly pageOperator: string
  readonly netSendLevel: AgentNotifyLevel; readonly netSendOperator: string
  readonly eventLogLevel: AgentNotifyLevel
  readonly deleteLevel: AgentNotifyLevel
  readonly created: string
  readonly modified: string
  readonly version: number
  readonly startStepId: number
  /** `yyyy-mm-ddThh:mm:ss`, server time; absent when it never ran. */
  readonly lastRun?: string
  /** sp_help_job's last_run_outcome: 0 failed, 1 succeeded, 3 canceled, 5 unknown. */
  readonly lastOutcome?: number
}
/** Whether SQL Server Agent can send e-mail (docs/agent-plan.md › Database Mail). `checked` is false where the login may not read
 *  Database Mail (below sysadmin and DatabaseMailUserRole): then nothing is said. `agentProfile` is read for sysadmin only. */
export interface AgentJobMail {
  readonly checked: boolean
  readonly xps?: boolean
  readonly profiles?: number
  readonly sysadmin: boolean
  readonly useDatabaseMail?: boolean
  readonly agentProfile?: string
}
export interface AgentJobDocumentModel {
  /** Absent for New Job. */
  readonly job?: AgentJobRecord
  /** The login the document runs as (SUSER_SNAME()), New Job's default owner. */
  readonly login: string
  readonly sysadmin: boolean
  readonly platform: AgentPlatform
  /** Why nothing can change: another owner's job below sysadmin. The document opens read-only. */
  readonly readOnly?: string
  readonly categories: readonly string[]
  /** Absent when the login may not read operators. */
  readonly operators?: readonly AgentJobOperator[]
  /** Logins the owner picker offers (sysadmin only; the owner can still be typed). */
  readonly owners?: readonly string[]
  readonly steps: readonly AgentJobStep[]
  /** Absent where the section is hidden: below SQLAgentOperatorRole, or on a platform without alerts. */
  readonly alerts?: readonly AgentJobAlert[]
  /** Remove is sysadmin's only: sp_update_alert is granted to no Agent role. */
  readonly alertsEditable: boolean
  readonly mail: AgentJobMail
  /** New Job only: the jobs msdb lets the login see, by name, which Copy an existing job picks from. */
  readonly jobs?: readonly string[]
  /** New Job only: each listed job's id (sysjobs job_id), in `jobs`' order, so a document can find its job again after a rename elsewhere. */
  readonly jobIds?: readonly string[]
  /** The job's schedules (AG-6c; sp_help_jobschedule with each one's owner, version and modified date). Empty for New Job. */
  readonly schedules?: readonly AgentScheduleRecord[]
  /** The server's clock when the describe ran (yyyy-mm-ddThh:mm:ss): the Schedules section's next runs count from it. */
  readonly now?: string
}

/** The editable fields, as the document, the changes, the compare and the save's error mapping name them. */
export const agentJobFields = ['name', 'owner', 'category', 'description', 'enabled', 'email', 'page', 'netSend', 'eventLog', 'delete', 'alerts', 'schedules'] as const
export type AgentJobField = typeof agentJobFields[number]
export type AgentJobSection = 'general' | 'notifications' | 'targets' | 'alerts' | 'schedules'
export const agentJobFieldSection: { readonly [F in AgentJobField]: AgentJobSection } = {
  name: 'general', owner: 'general', category: 'general', description: 'general', enabled: 'general',
  email: 'notifications', page: 'notifications', netSend: 'notifications', eventLog: 'notifications', delete: 'notifications', alerts: 'alerts', schedules: 'schedules'
}

export interface AgentJobDraft {
  readonly name: string
  readonly owner: string
  readonly category: string
  readonly description: string
  readonly enabled: boolean
  readonly emailLevel: AgentNotifyLevel; readonly emailOperator: string
  readonly pageLevel: AgentNotifyLevel; readonly pageOperator: string
  readonly netSendLevel: AgentNotifyLevel; readonly netSendOperator: string
  readonly eventLogLevel: AgentNotifyLevel
  readonly deleteLevel: AgentNotifyLevel
  /** Alert ids Remove took off this job (saved with it). */
  readonly removeAlerts: readonly number[]
  /** The Schedules section's entries (AG-6c): the job's, picked, new, and removed ones. */
  readonly schedules: readonly JobScheduleEntry[]
}

/** The draft a describe opens with: the job as read, or New Job's blank (owner the login, SSMS's defaults). */
export function initialAgentJobDraft(model: Pick<AgentJobDocumentModel, 'job' | 'login' | 'schedules'>): AgentJobDraft {
  const job = model.job
  if (!job) return {
    name: '', owner: model.login, category: uncategorizedCategory, description: '', enabled: true,
    emailLevel: 0, emailOperator: '', pageLevel: 0, pageOperator: '', netSendLevel: 0, netSendOperator: '', eventLogLevel: 0, deleteLevel: 0, removeAlerts: [], schedules: []
  }
  return {
    name: job.name, owner: job.owner, category: job.category, description: job.description, enabled: job.enabled,
    emailLevel: job.emailLevel, emailOperator: job.emailOperator, pageLevel: job.pageLevel, pageOperator: job.pageOperator,
    netSendLevel: job.netSendLevel, netSendOperator: job.netSendOperator, eventLogLevel: job.eventLogLevel, deleteLevel: job.deleteLevel, removeAlerts: [],
    schedules: initialJobSchedules(model.schedules)
  }
}

/** A notification as one value: never (no operator) or a level with its operator. */
const notifyValue = (level: AgentNotifyLevel, operator: string) => level === 0 ? '0' : `${level}:${operator}`
function fieldValue(draft: AgentJobDraft, field: AgentJobField): string {
  switch (field) {
    case 'name': return draft.name
    case 'owner': return draft.owner
    case 'category': return draft.category
    case 'description': return draft.description
    case 'enabled': return String(draft.enabled)
    case 'email': return notifyValue(draft.emailLevel, draft.emailOperator)
    case 'page': return notifyValue(draft.pageLevel, draft.pageOperator)
    case 'netSend': return notifyValue(draft.netSendLevel, draft.netSendOperator)
    case 'eventLog': return String(draft.eventLogLevel)
    case 'delete': return String(draft.deleteLevel)
    case 'alerts': return [...draft.removeAlerts].sort((a, b) => a - b).join(',')
    case 'schedules': return jobSchedulesValue(draft.schedules)
  }
}

/** The fields the draft changed from `base` (the job as read; New Job's blank). */
export function changedAgentJobFields(base: AgentJobDraft, draft: AgentJobDraft): AgentJobField[] {
  return agentJobFields.filter(field => fieldValue(base, field) !== fieldValue(draft, field))
}
/** "Save · n changes": each changed field, and each removed alert. */
export function agentJobChangeCount(base: AgentJobDraft, draft: AgentJobDraft): number {
  return changedAgentJobFields(base, draft).reduce((count, field) => count + (field === 'alerts' ? draft.removeAlerts.length : field === 'schedules' ? Math.max(1, jobScheduleChangeCount(base.schedules, draft.schedules)) : 1), 0)
}

// --- What Save sends ---------------------------------------------------------------------------------------------------

/** An alert Remove detaches from the job: its id (the guard checks it still runs this job) and its name (sp_update_alert's key). */
export interface AgentAlertRef { readonly id: number; readonly name: string }
/** What Save sends. An existing job's carries the version and modified date its describe read (the STALE guard) and only what changed; a
 *  notification goes as its level and operator together ('' with level 0). New Job's carries every field it sets and no version. */
export interface AgentJobSave {
  readonly version?: number
  readonly modified?: string
  readonly name?: string
  readonly enabled?: boolean
  readonly description?: string
  readonly category?: string
  readonly owner?: string
  readonly emailLevel?: AgentNotifyLevel; readonly emailOperator?: string
  readonly pageLevel?: AgentNotifyLevel; readonly pageOperator?: string
  readonly netSendLevel?: AgentNotifyLevel; readonly netSendOperator?: string
  readonly eventLogLevel?: AgentNotifyLevel
  readonly deleteLevel?: AgentNotifyLevel
  readonly removeAlerts?: readonly AgentAlertRef[]
  /** The Schedules section's changes (AG-6c), run after the job's own calls in the same transaction. */
  readonly schedules?: AgentJobSchedulesSave
}

/** The save the draft asks for: undefined when an existing job's draft changes nothing. */
export function agentJobSave(model: AgentJobDocumentModel, draft: AgentJobDraft): AgentJobSave | undefined {
  const job = model.job
  const base = initialAgentJobDraft(model)
  const save: { -readonly [K in keyof AgentJobSave]: AgentJobSave[K] } = job ? { version: job.version, modified: job.modified } : {}
  const fields = job ? changedAgentJobFields(base, draft) : agentJobFields.filter(field => field !== 'alerts' && (field !== 'schedules' || draft.schedules.length > 0))
  if (job && fields.length === 0) return undefined
  for (const field of fields) {
    switch (field) {
      // msdb trims a job's name (sp_add_job, sp_update_job), so the save sends it as msdb will keep it.
      case 'name': save.name = draft.name.trim(); break
      case 'owner': if (job || draft.owner !== model.login) save.owner = draft.owner; break
      case 'category': save.category = draft.category; break
      case 'description': save.description = draft.description; break
      case 'enabled': save.enabled = draft.enabled; break
      case 'email': save.emailLevel = draft.emailLevel; save.emailOperator = draft.emailLevel ? draft.emailOperator : ''; break
      case 'page': save.pageLevel = draft.pageLevel; save.pageOperator = draft.pageLevel ? draft.pageOperator : ''; break
      case 'netSend': save.netSendLevel = draft.netSendLevel; save.netSendOperator = draft.netSendLevel ? draft.netSendOperator : ''; break
      case 'eventLog': save.eventLogLevel = draft.eventLogLevel; break
      case 'delete': save.deleteLevel = draft.deleteLevel; break
      case 'alerts': {
        const alerts = model.alerts ?? []
        save.removeAlerts = draft.removeAlerts.flatMap(id => alerts.filter(alert => alert.id === id).map(alert => ({ id: alert.id, name: alert.name })))
        break
      }
      case 'schedules': { const schedules = jobSchedulesSave(model.schedules ?? [], draft.schedules); if (schedules) save.schedules = schedules; break }
    }
  }
  // Schedule entries that send nothing (a new one added and removed again) leave an existing job's save empty.
  if (job && Object.keys(save).length === 2) return undefined
  return save
}

const level = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
/** An operator name, or '' with level 0. */
const operatorName = z.string().max(agentLimits.nameChars).refine(value => !value.includes('\u0000'), 'A name cannot contain U+0000.')
const modifiedPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$/
export const agentJobSaveSchema = z.object({
  version: z.number().int().min(0).max(2_147_483_647).optional(),
  modified: z.string().max(23).regex(modifiedPattern).refine(text => { const date = new Date(text + 'Z'); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 23) === text }, 'not a date').optional(),
  name: ident.optional(),
  enabled: z.boolean().optional(),
  description: z.string().max(agentLimits.descriptionChars).refine(value => !value.includes('\u0000'), 'A description cannot contain U+0000.').optional(),
  category: ident.optional(),
  owner: ident.optional(),
  emailLevel: level.optional(), emailOperator: operatorName.optional(),
  pageLevel: level.optional(), pageOperator: operatorName.optional(),
  netSendLevel: level.optional(), netSendOperator: operatorName.optional(),
  eventLogLevel: level.optional(),
  deleteLevel: level.optional(),
  removeAlerts: z.array(z.object({ id: z.number().int().min(1).max(2_147_483_647), name: ident }).strict()).min(1).max(agentLimits.jobAlerts).optional(),
  schedules: jobSchedulesSaveSchema.optional()
}).strict() satisfies z.ZodType<AgentJobSave>

/** Why a save cannot run whatever the server says (C#'s ValidateAgentJob refuses the same). `create`: New Job (target the Agent node, no
 *  identity). An existing job's names its version and modified date and changes something; New Job's has a name and no version, and
 *  removes no alert. Each notification goes as its level and operator together, an operator exactly with a level above 0. */
export function agentJobSaveProblems(save: AgentJobSave, create: boolean): string[] {
  const problems: string[] = []
  if (create) {
    if (save.version !== undefined || save.modified !== undefined) problems.push('A new job has no version.')
    if (save.name === undefined) problems.push('A new job needs a name.')
    if (save.removeAlerts !== undefined) problems.push('A new job has no alerts.')
    if (save.schedules?.detach || save.schedules?.update?.some(update => !save.schedules?.attach?.some(attach => attach.id === update.id))) problems.push('A new job has no schedule of its own to detach or change.')
  } else {
    if (save.version === undefined || save.modified === undefined) problems.push("A job's save names the version it read.")
    const { version: _version, modified: _modified, ...changes } = save
    if (!Object.values(changes).some(value => value !== undefined)) problems.push('There is nothing to change.')
  }
  for (const [levelKey, operatorKey] of [['emailLevel', 'emailOperator'], ['pageLevel', 'pageOperator'], ['netSendLevel', 'netSendOperator']] as const) {
    const sent = save[levelKey], operator = save[operatorKey]
    if ((sent === undefined) !== (operator === undefined)) problems.push('A notification goes as its level and operator together.')
    else if (sent !== undefined && (sent === 0) !== (operator === '')) problems.push('A notification names an operator exactly when it is sent.')
  }
  if (save.removeAlerts && new Set(save.removeAlerts.map(alert => alert.id)).size !== save.removeAlerts.length) problems.push('An alert is removed twice.')
  if (save.schedules) problems.push(...jobSchedulesSaveProblems(save.schedules))
  return problems
}

// --- Problems: field, section and header; they warn, and only a missing or too long value stops Save ----------------------

export interface AgentJobProblem { readonly field: AgentJobField; readonly severity: 'error' | 'warning'; readonly message: string }

export const agentJobText = {
  nameRequired: 'The job needs a name.',
  ownerRequired: 'The job needs an owner.',
  operatorRequired: 'Choose the operator to notify.',
  descriptionTooLong: `A description holds at most ${agentLimits.descriptionChars} characters.`,
  readOnly: (owner: string) => `Read-only. Owned by ${owner}: only its owner and sysadmin can change it.`,
  ownerSysadmin: "Only sysadmin can change the owner. The job's T-SQL steps run as this login unless a step says otherwise.",
  targetLocal: (server: string) => `This server (${server})`,
  targetLater: 'Multi-server targets (MSX/TSX) come later.',
  startStepElsewhere: 'Changed on Steps',
  noSteps: 'This job has no steps yet, so it does nothing when it runs. Steps are added on the Steps section, coming in a later version; SSMS can add them meanwhile.',
  mailOff: 'Database Mail is off on this server (Database Mail XPs), so e-mail notifications are not sent.',
  mailNoProfile: 'No Database Mail profile exists on this server, so e-mail notifications are not sent.',
  mailAgentProfile: 'SQL Server Agent has no Database Mail profile set (SQL Server Agent Properties › Alert System), so it sends no e-mail. Set one in SSMS, then restart SQL Server Agent.',
  mailManagedInstance: 'On Managed Instance, SQL Server Agent sends e-mail only through the Database Mail profile AzureManagedInstance_dbmail_profile.',
  mailReady: (profile: string) => `SQL Server Agent sends mail through Database Mail profile ${profile}.`,
  operatorDisabled: (name: string) => `${name} is disabled, so it is not notified.`,
  operatorNoEmail: (name: string) => `${name} has no e-mail address.`,
  operatorNoPager: (name: string) => `${name} has no pager address.`,
  operatorNoNetSend: (name: string) => `${name} has no net send address.`,
  pagerNeverOnDuty: (name: string) => `${name} is never on pager duty, so a page would not be sent. Set its duty days and hours on the operator, or pick another operator.`,
  pagerDuty: (name: string, duty: string) => `${name}'s pager duty is ${duty}. A page outside those hours is not sent. A warning only; Save still works.`,
  operatorUnknown: (name: string) => `${name} is not an operator on this server.`,
  alertsReadOnly: 'Only sysadmin can change which alerts run a job: SQL Server Agent\'s roles may view alerts, not change them.',
  alertsNewLater: 'New alerts for this job come with the Alerts lane; create one in SSMS meanwhile.',
  alertsNewJob: 'Save the job first, then add alerts.',
  alertsNone: 'No alert runs this job.',
  stale: (count: number) => `Not saved: someone changed this job after you opened it. Your ${count} ${count === 1 ? 'change is' : 'changes are'} kept.`,
  staleHint: 'The save checked the job\'s version first, so nothing was sent and the server\'s version is intact.',
  staleNoConflict: 'No field was changed by both, so Reload and keep my changes re-reads the job and applies your edits on top; you still press Save.',
  staleConflict: 'A field changed by both is listed first: choose which to keep for each. Reload and keep my changes then applies your choices; you still press Save.',
  reloadKeep: 'Reload and keep my changes',
  reloadDiscard: 'Discard mine and reload',
  denied: (part: string) => `Not saved: permission denied on ${part}. Nothing was sent; your changes are kept.`,
  failed: 'Not saved: nothing was changed; your changes are kept.',
  startOnce: 'Start once at step',
  startOnceNote: "Runs once from that step; the job's Start step is not changed. Steps before it are skipped.",
  startStep: 'Start step',
  netSendDeprecated: 'Net send is deprecated and does nothing on current Windows; it shows only so a job that still has it set reads as in SSMS.',
  deleteJob: 'Removes the job and its history after the run; no undo.',
  newBlank: 'Blank job',
  newBlankHint: 'Name it, then save; steps and schedules come with their own sections.',
  newCopy: 'Copy an existing job…',
  newCopyHint: 'Pick a job; its General and Notifications fill this new job. Nothing is created until Save.',
  newHint: 'Nothing is created until Save, and everything stays editable.'
} as const

const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const hhmm = (time: number) => `${String(Math.floor(time / 10000)).padStart(2, '0')}:${String(Math.floor(time / 100) % 100).padStart(2, '0')}`
const allDay = (hours: AgentDutyHours) => hours.start === 0 && hours.end >= 235900
/** The pager's duty in words ("weekdays 08:00–18:00, Saturday 09:00–13:00"), or undefined when it is on duty all day every day. */
export function pagerDuty(operator: AgentJobOperator): string | undefined {
  const on = (day: number) => (operator.pagerDays & (1 << day)) !== 0
  const hoursOf = (day: number) => day === 0 ? operator.sunday : day === 6 ? operator.saturday : operator.weekday
  if (days.every((_, day) => on(day) && allDay(hoursOf(day)))) return undefined
  const parts: string[] = []
  const weekdays = [1, 2, 3, 4, 5].filter(on)
  const span = (hours: AgentDutyHours) => allDay(hours) ? 'all day' : `${hhmm(hours.start)}–${hhmm(hours.end)}`
  if (weekdays.length === 5) parts.push(`weekdays ${span(operator.weekday)}`)
  else if (weekdays.length) parts.push(`${weekdays.map(day => days[day]).join(', ')} ${span(operator.weekday)}`)
  if (on(6)) parts.push(`Saturday ${span(operator.saturday)}`)
  if (on(0)) parts.push(`Sunday ${span(operator.sunday)}`)
  return parts.join(', ')
}

/** What the Notifications section says about Database Mail, or undefined when it says nothing (not checked, or ready). */
export function mailProblem(mail: AgentJobMail, platform: AgentPlatform): string | undefined {
  if (!mail.checked) return undefined
  if (mail.xps === false) return agentJobText.mailOff
  if (mail.profiles === 0) return agentJobText.mailNoProfile
  if (!mail.sysadmin) return undefined
  if (mail.useDatabaseMail === false || (mail.useDatabaseMail !== undefined && !mail.agentProfile)) return agentJobText.mailAgentProfile
  if (platform === 'managedInstance' && mail.agentProfile !== undefined && mail.agentProfile !== 'AzureManagedInstance_dbmail_profile') return agentJobText.mailManagedInstance
  return undefined
}

/** The draft's problems: errors on a missing name, owner or operator or a too long description (Save cannot send those), and warnings on
 *  notifications that would not reach anyone. Nothing else blocks Save. */
export function agentJobProblems(model: AgentJobDocumentModel, draft: AgentJobDraft): AgentJobProblem[] {
  const problems: AgentJobProblem[] = []
  if (!draft.name.trim()) problems.push({ field: 'name', severity: 'error', message: agentJobText.nameRequired })
  if (!draft.owner.trim()) problems.push({ field: 'owner', severity: 'error', message: agentJobText.ownerRequired })
  if (draft.description.length > agentLimits.descriptionChars) problems.push({ field: 'description', severity: 'error', message: agentJobText.descriptionTooLong })
  const operators = model.operators
  const check = (field: 'email' | 'page' | 'netSend', levelValue: AgentNotifyLevel, name: string) => {
    if (levelValue === 0) return
    if (!name) { problems.push({ field, severity: 'error', message: agentJobText.operatorRequired }); return }
    if (!operators) return
    const operator = operators.find(candidate => candidate.name === name)
    if (!operator) { problems.push({ field, severity: 'warning', message: agentJobText.operatorUnknown(name) }); return }
    if (!operator.enabled) problems.push({ field, severity: 'warning', message: agentJobText.operatorDisabled(name) })
    if (field === 'email' && !operator.email) problems.push({ field, severity: 'warning', message: agentJobText.operatorNoEmail(name) })
    if (field === 'netSend' && !operator.netSend) problems.push({ field, severity: 'warning', message: agentJobText.operatorNoNetSend(name) })
    if (field === 'page') {
      if (!operator.pager) problems.push({ field, severity: 'warning', message: agentJobText.operatorNoPager(name) })
      else if (operator.pagerDays === 0) problems.push({ field, severity: 'warning', message: agentJobText.pagerNeverOnDuty(name) })
      else { const duty = pagerDuty(operator); if (duty) problems.push({ field, severity: 'warning', message: agentJobText.pagerDuty(name, duty) }) }
    }
  }
  check('email', draft.emailLevel, draft.emailOperator)
  check('page', draft.pageLevel, draft.pageOperator)
  check('netSend', draft.netSendLevel, draft.netSendOperator)
  if (draft.emailLevel !== 0) { const mail = mailProblem(model.mail, model.platform); if (mail) problems.push({ field: 'email', severity: 'warning', message: mail }) }
  const now = model.now ? momentOfText(model.now) : undefined
  for (const { key, problem } of jobScheduleProblems(draft.schedules, now, model.schedules)) {
    const name = draft.schedules.find(entry => entry.key === key)?.fields.name.trim()
    problems.push({ field: 'schedules', severity: problem.severity, message: name ? `${name}: ${problem.message}` : problem.message })
  }
  return problems
}
/** Whether Save can send the draft: no error-level problem. */
export const agentJobSavable = (problems: readonly AgentJobProblem[]) => !problems.some(problem => problem.severity === 'error')

/** The notification kinds the platform offers (the others show disabled with the reason). */
export function notificationGates(platform: AgentPlatform): { readonly email: boolean; readonly page: boolean; readonly netSend: boolean; readonly eventLog: boolean } {
  return { email: agentGateOpen('emailNotifications', platform), page: agentGateOpen('pagerNotifications', platform), netSend: agentGateOpen('netSendNotifications', platform), eventLog: agentGateOpen('eventLogNotifications', platform) }
}
export const gateClosedText = (title: string) => `${title} is not available on this server's platform.`

// --- STALE: the field-by-field compare and Reload and keep my changes -------------------------------------------------------

export const agentJobFieldLabels: { readonly [F in AgentJobField]: string } = {
  name: 'Name', owner: 'Owner', category: 'Category', description: 'Description', enabled: 'Enabled', email: 'E-mail', page: 'Page', netSend: 'Net send',
  eventLog: 'Windows event log', delete: 'Delete the job', alerts: 'Alerts', schedules: 'Schedules'
}
/** A field as the compare shows it. */
export function agentJobFieldText(draft: AgentJobDraft, field: AgentJobField, alerts: readonly AgentJobAlert[] = []): string {
  const notify = (levelValue: AgentNotifyLevel, operator: string) => levelValue === 0 ? 'Never' : `${notifyLevelLabel(levelValue)} · ${operator}`
  switch (field) {
    case 'enabled': return draft.enabled ? 'Enabled' : 'Disabled'
    case 'email': return notify(draft.emailLevel, draft.emailOperator)
    case 'page': return notify(draft.pageLevel, draft.pageOperator)
    case 'netSend': return notify(draft.netSendLevel, draft.netSendOperator)
    case 'eventLog': return notifyLevelLabel(draft.eventLogLevel)
    case 'delete': return notifyLevelLabel(draft.deleteLevel)
    case 'alerts': return draft.removeAlerts.length ? `Remove ${draft.removeAlerts.map(id => alerts.find(alert => alert.id === id)?.name ?? `#${id}`).join(', ')}` : 'not changed'
    case 'schedules': return draft.schedules.filter(entry => !entry.remove).map(entry => entry.fields.name).join(', ') || '(none)'
    default: return fieldValue(draft, field) || '(none)'
  }
}
export interface AgentJobCompareRow {
  readonly field: AgentJobField
  /** The server's value when the server changed it since the document opened. */
  readonly server?: string
  /** The draft's value when the user changed it. */
  readonly yours?: string
  /** Both changed it, to different values: the user chooses. */
  readonly conflict: boolean
}
/** What each side changed since the document opened: `opened` is the job the describe read then, `current` the job read now. Conflicts first. */
export function agentJobCompare(opened: AgentJobDocumentModel, current: AgentJobDocumentModel, draft: AgentJobDraft): AgentJobCompareRow[] {
  const base = initialAgentJobDraft(opened), server = initialAgentJobDraft(current)
  const mine = new Set(changedAgentJobFields(base, draft)), theirs = new Set(changedAgentJobFields(base, server))
  const alerts = [...(opened.alerts ?? []), ...(current.alerts ?? [])]
  const rows = agentJobFields.filter(field => mine.has(field) || theirs.has(field)).map((field): AgentJobCompareRow => ({
    field,
    ...(theirs.has(field) ? { server: agentJobFieldText(server, field, alerts) } : {}),
    ...(mine.has(field) ? { yours: agentJobFieldText(draft, field, alerts) } : {}),
    conflict: mine.has(field) && theirs.has(field) && fieldValue(server, field) !== fieldValue(draft, field)
  }))
  return [...rows.filter(row => row.conflict), ...rows.filter(row => !row.conflict)]
}
/** Reload and keep my changes: the job as read now, with each field the user changed applied on top, except conflicts the user chose the
 *  server's value for (`keepServer`). Removed alerts that no longer run this job are dropped. */
export function rebaseAgentJobDraft(opened: AgentJobDocumentModel, current: AgentJobDocumentModel, draft: AgentJobDraft, keepServer: ReadonlySet<AgentJobField> = new Set()): AgentJobDraft {
  const base = initialAgentJobDraft(opened)
  let next: { -readonly [K in keyof AgentJobDraft]: AgentJobDraft[K] } = { ...initialAgentJobDraft(current) }
  for (const field of changedAgentJobFields(base, draft)) {
    if (keepServer.has(field)) continue
    switch (field) {
      case 'email': next = { ...next, emailLevel: draft.emailLevel, emailOperator: draft.emailOperator }; break
      case 'page': next = { ...next, pageLevel: draft.pageLevel, pageOperator: draft.pageOperator }; break
      case 'netSend': next = { ...next, netSendLevel: draft.netSendLevel, netSendOperator: draft.netSendOperator }; break
      case 'eventLog': next.eventLogLevel = draft.eventLogLevel; break
      case 'delete': next.deleteLevel = draft.deleteLevel; break
      case 'alerts': next.removeAlerts = draft.removeAlerts.filter(id => (current.alerts ?? []).some(alert => alert.id === id)); break
      case 'schedules': next.schedules = rebaseJobSchedules(opened.schedules ?? [], current.schedules ?? [], draft.schedules); break
      case 'enabled': next.enabled = draft.enabled; break
      default: next[field] = draft[field]
    }
  }
  return next
}

/** New Job's "Copy an existing job": the copied job's General and Notifications as a new job's draft, named "Copy of …" (cut to fit). */
export function copiedAgentJobDraft(source: AgentJobDocumentModel, login: string, sysadmin: boolean): AgentJobDraft {
  const from = initialAgentJobDraft(source)
  const name = `Copy of ${from.name}`.slice(0, agentLimits.nameChars)
  // Create from… shares the source's schedules (the owner's 2026-11-18 decision) where the login may attach them; others are copied as new.
  const schedules = (source.schedules ?? []).map((record, index): JobScheduleEntry => sysadmin || ownsSchedule(record, login)
    ? { key: `s:${record.id}`, id: record.id, attached: true, base: record, fields: from.schedules[index]?.fields ?? record }
    : { key: `n:copy:${record.id}`, fields: from.schedules[index]?.fields ?? record })
  return { ...from, name, owner: sysadmin ? from.owner : login, removeAlerts: [], schedules }
}

// --- Commands ----------------------------------------------------------------------------------------------------------

export type AgentJobCommandId = 'agent.openJob' | 'agent.newJob' | 'agentJob.save' | 'agentJob.start' | 'agentJob.startAtStep' | 'agentJob.stop' | 'agentJob.reload'
/** A command catalogue entry, in the shape of `CommandDescriptor`. */
export interface AgentJobCommandEntry {
  readonly title: string
  readonly category: 'SQL Server Agent'
  readonly icon: 'go-to-file' | 'add' | 'save' | 'play' | 'list-ordered' | 'debug-stop' | 'refresh'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly keybindings?: readonly { readonly key: string; readonly when: string }[]
  readonly menus?: readonly { readonly menu: 'explorer.context'; readonly group: string; readonly order: number; readonly mnemonic?: string; readonly when?: string }[]
}
const inJob = 'agentEnabled && backendReady && activeDocumentIsAgentJob'
const openJobFirst = 'Open a job first (SQL Server Agent: Open Job…, or Properties on a job in Object Explorer).'
/**
 * The job document's commands, all behind the release gate (agentEnabled; the renderer registers none without it): Open Job… and
 * New Job… (on the Jobs folder's menu and in the palette; Open Job opens the job selected in Job Activity Monitor when run from it), and the document's own verbs, which act on the job document whose header
 * runs them (`tabId`), else the active one. Properties on a job opens the document through the object actions' Properties.
 */
export function agentJobCommandEntries(): { readonly [K in AgentJobCommandId]: AgentJobCommandEntry } {
  return {
    'agent.openJob': {
      title: 'Open Job…', category: 'SQL Server Agent', icon: 'go-to-file', keywords: ['agent', 'job', 'properties', 'edit', 'sqlserveragent'],
      precondition: 'agentEnabled && backendReady && hasConnection', unavailableHint: 'Connect to a SQL Server whose SQL Server Agent you can see first.',
      // Enter in Job Activity Monitor's list opens the selected job, as a double-click does.
      keybindings: [{ key: 'enter', when: 'activeDocumentIsJobActivity && outputGridFocus' }]
    },
    'agent.newJob': {
      title: 'New Job…', category: 'SQL Server Agent', icon: 'add', keywords: ['agent', 'job', 'create', 'add', 'copy', 'sqlserveragent'],
      precondition: 'agentEnabled && backendReady && hasConnection', unavailableHint: 'Connect to a SQL Server whose SQL Server Agent you can see first.',
      menus: [{ menu: 'explorer.context', group: '0_new', order: 1, mnemonic: 'n', when: "((explorerNode == 'folder' && explorerFolder == 'agentJobs') || explorerNode == 'agentJob') && !explorerServerLost" }]
    },
    'agentJob.save': {
      title: 'Save Job', category: 'SQL Server Agent', icon: 'save', keywords: ['agent', 'job', 'apply', 'ok', 'update'],
      precondition: inJob, unavailableHint: 'Change the job first; a read-only job cannot be saved.'
    },
    'agentJob.start': {
      title: 'Start Job', category: 'SQL Server Agent', icon: 'play', keywords: ['agent', 'job', 'run', 'execute', 'start'],
      precondition: inJob, unavailableHint: openJobFirst
    },
    'agentJob.startAtStep': {
      title: 'Start Job at Step…', category: 'SQL Server Agent', icon: 'list-ordered', keywords: ['agent', 'job', 'run', 'step', 'once'],
      precondition: inJob, unavailableHint: 'The job needs a step first.'
    },
    'agentJob.stop': {
      title: 'Stop Job', category: 'SQL Server Agent', icon: 'debug-stop', keywords: ['agent', 'job', 'cancel', 'stop'],
      precondition: inJob, unavailableHint: 'The job is not running.'
    },
    'agentJob.reload': {
      title: 'Reload Job', category: 'SQL Server Agent', icon: 'refresh', keywords: ['agent', 'job', 'refresh', 'read', 'discard'],
      precondition: inJob, unavailableHint: openJobFirst
    }
  }
}
/** The document's tab: SSMS's Job Properties window, by the job's name; New Job until a new job is saved. */
export const agentJobTabName = (name: string | undefined): string => name === undefined ? 'New Job' : `Job Properties - ${name}`
