// The SQL Server Agent alert document (AG-7, docs/agent-plan.md › Alerts, docs/agent-ui-rethink.md › rx-alert, rx-alert-perf): what its
// describe reads, the draft the document edits on one screen (When / Then / Options, history in the header), what Save sends (one
// `agentAlert` action: New Alert's sp_add_alert, or an existing alert's sp_update_alert with only the changed arguments, each new inline
// operator's sp_add_operator first and each notification change's sp_add_, sp_update_ or sp_delete_notification after, in one transaction),
// the warnings it shows (never blocking), Add recommended alerts' set and request, and the commands. Bounds are zod here and C# in
// ActionService.ValidateAgentObjects. No React here.
import { z } from 'zod'
import { agentGateOpen, agentLimits, type AgentPlatform } from '../agent/catalog.ts'
import type { ObjectRef } from '../explorer/refs.ts'
import { ident } from '../explorer/schema.ts'
import { actionErrorCodes, actionLimits, type ActionErrorCode } from './catalog.ts'
import { mailProblem, pagerDuty, type AgentJobMail, type AgentJobOperator } from './agent-job.ts'

/** sysnotifications.notification_method and sysalerts.include_event_description bits. */
export const notifyEmail = 1
export const notifyPager = 2
export const notifyNetSend = 4

export type AgentAlertKind = 'event' | 'performance' | 'wmi'
/** sp_help_alert's type: 1 a SQL Server event, 2 a performance condition, 4 a WMI event. */
export const alertKindOf = (type: number): AgentAlertKind => type === 2 ? 'performance' : type === 4 ? 'wmi' : 'event'
export const alertKindLabels: { readonly [K in AgentAlertKind]: string } = { event: 'SQL Server event alert', performance: 'SQL Server performance condition alert', wmi: 'WMI event alert' }
export const alertKindGate = { event: 'eventAlerts', performance: 'performanceAlerts', wmi: 'wmiAlerts' } as const
export type AgentComparator = '>' | '<' | '='
export const alertComparators: readonly { readonly value: AgentComparator; readonly label: string }[] = [
  { value: '>', label: 'rises above' }, { value: '<', label: 'falls below' }, { value: '=', label: 'becomes equal to' }
]

/** An operator an alert notifies, and how (notifyEmail, notifyPager, notifyNetSend bits). */
export interface AgentAlertNotify { readonly operator: string; readonly methods: number }
/** A job an alert can run: its id (sysjobs.job_id) and name. */
export interface AgentAlertJob { readonly id: string; readonly name: string }
/** A performance counter as sys.dm_os_performance_counters names it (object_name and counter_name, trimmed). */
export interface AgentCounter { readonly object: string; readonly counter: string }
/** One instance's current value of a counter (agent.counterValues). */
export interface AgentCounterValue { readonly instance: string; readonly value: number }

/** The alert as sp_help_alert describes it. Dates are the server's local time (`yyyy-mm-ddThh:mm:ss`), absent when it never happened. */
export interface AgentAlertRecord {
  readonly id: number
  readonly name: string
  readonly enabled: boolean
  readonly kind: AgentAlertKind
  readonly messageId: number
  readonly severity: number
  /** '' for every database. */
  readonly database: string
  readonly keyword: string
  /** `object|counter|instance|comparator|value`, '' for an event alert. */
  readonly condition: string
  readonly wmiNamespace: string
  readonly wmiQuery: string
  /** '' when it runs no job. */
  readonly jobId: string
  readonly jobName: string
  readonly delay: number
  readonly includeIn: number
  readonly message: string
  readonly occurrences: number
  readonly lastOccurred?: string
  readonly lastResponse?: string
  readonly countReset?: string
}
export interface AgentAlertDocumentModel {
  /** Absent for New Alert. */
  readonly alert?: AgentAlertRecord
  readonly login: string
  readonly sysadmin: boolean
  readonly platform: AgentPlatform
  /** Why nothing can change: below sysadmin no Agent role may run sp_add_alert or sp_update_alert. */
  readonly readOnly?: string
  /** Absent when the login may not read operators. */
  readonly operators?: readonly AgentJobOperator[]
  readonly notifications: readonly AgentAlertNotify[]
  /** The jobs msdb lets the login see; absent when they could not be read. */
  readonly jobs?: readonly AgentAlertJob[]
  readonly databases: readonly string[]
  /** Absent without VIEW SERVER STATE: the performance fields are typed. */
  readonly counters?: readonly AgentCounter[]
  readonly countersTruncated?: boolean
  readonly mail: AgentJobMail
  /** sys.messages' text of the alert's error number (English), when it has one. */
  readonly messageText?: string
}

/** The editable fields, as the changes, the problems and the save's error mapping name them. */
export const agentAlertFields = ['name', 'enabled', 'when', 'database', 'keyword', 'job', 'notify', 'includeIn', 'message', 'delay', 'count'] as const
export type AgentAlertField = typeof agentAlertFields[number]

/** An operator the alert creates in place, saved with it (the inline New operator). */
export interface AgentNewOperator { readonly name: string; readonly email: string; readonly pager: string }
export interface AgentAlertDraft {
  readonly name: string
  readonly enabled: boolean
  readonly kind: AgentAlertKind
  readonly raiseOn: 'message' | 'severity'
  /** Typed, so a half-typed number stays as typed; the problems say when it is not one. */
  readonly messageId: string
  readonly severity: number
  readonly database: string
  readonly keyword: string
  readonly object: string
  readonly counter: string
  readonly instance: string
  readonly comparator: AgentComparator
  readonly value: string
  readonly jobId: string
  readonly notify: readonly AgentAlertNotify[]
  readonly newOperators: readonly AgentNewOperator[]
  readonly includeIn: number
  readonly message: string
  readonly delay: number
  readonly resetCount: boolean
}

/** A performance condition's parts, or undefined when it is not one. */
export function parseCondition(condition: string): { object: string; counter: string; instance: string; comparator: AgentComparator; value: string } | undefined {
  const parts = condition.split('|')
  if (parts.length !== 5 || !['>', '<', '='].includes(parts[3])) return undefined
  return { object: parts[0], counter: parts[1], instance: parts[2], comparator: parts[3] as AgentComparator, value: parts[4] }
}
export const conditionOf = (draft: Pick<AgentAlertDraft, 'object' | 'counter' | 'instance' | 'comparator' | 'value'>): string =>
  [draft.object.trim(), draft.counter.trim(), draft.instance.trim(), draft.comparator, draft.value.trim()].join('|')

/** What a new alert opens with: a job (the job document's New alert for this job) and the first operator nothing else. */
export interface AgentAlertPreset { readonly jobId?: string; readonly jobName?: string }
/** The draft a describe opens with: the alert as read, or New Alert's blank (an event alert on severity 17 for every database, SSMS's
 *  1-minute delay off, the job preset when there is one). */
export function initialAgentAlertDraft(model: Pick<AgentAlertDocumentModel, 'alert' | 'notifications'>, preset: AgentAlertPreset = {}): AgentAlertDraft {
  const alert = model.alert
  if (!alert) return {
    name: '', enabled: true, kind: 'event', raiseOn: 'severity', messageId: '', severity: 17, database: '', keyword: '', object: '', counter: '', instance: '', comparator: '>', value: '',
    jobId: preset.jobId ?? '', notify: [], newOperators: [], includeIn: notifyEmail, message: '', delay: 60, resetCount: false
  }
  const condition = parseCondition(alert.condition)
  return {
    name: alert.name, enabled: alert.enabled, kind: alert.kind, raiseOn: alert.messageId > 0 ? 'message' : 'severity', messageId: alert.messageId > 0 ? String(alert.messageId) : '',
    severity: alert.severity > 0 ? alert.severity : 17, database: alert.database, keyword: alert.keyword, object: condition?.object ?? '', counter: condition?.counter ?? '',
    instance: condition?.instance ?? '', comparator: condition?.comparator ?? '>', value: condition?.value ?? '', jobId: alert.jobId, notify: model.notifications.filter(entry => entry.methods > 0),
    newOperators: [], includeIn: alert.includeIn, message: alert.message, delay: alert.delay, resetCount: false
  }
}

const notifyKey = (notify: readonly AgentAlertNotify[]) => [...notify].filter(entry => entry.methods > 0).sort((a, b) => a.operator < b.operator ? -1 : a.operator > b.operator ? 1 : 0).map(entry => `${entry.operator}:${entry.methods}`).join(',')
function whenValue(draft: AgentAlertDraft): string {
  if (draft.kind === 'performance') return `p:${conditionOf(draft)}`
  if (draft.kind === 'wmi') return 'w'
  return draft.raiseOn === 'message' ? `m:${draft.messageId.trim()}` : `s:${draft.severity}`
}
function fieldValue(draft: AgentAlertDraft, field: AgentAlertField): string {
  switch (field) {
    case 'name': return draft.name.trim()
    case 'enabled': return String(draft.enabled)
    case 'when': return whenValue(draft)
    case 'database': return draft.kind === 'event' ? draft.database : ''
    case 'keyword': return draft.kind === 'event' ? draft.keyword : ''
    case 'job': return draft.jobId.toLowerCase()
    case 'notify': return notifyKey(draft.notify) + '|' + draft.newOperators.map(item => item.name).join(',')
    case 'includeIn': return String(draft.includeIn)
    case 'message': return draft.message
    case 'delay': return String(draft.delay)
    case 'count': return String(draft.resetCount)
  }
}
export function changedAgentAlertFields(base: AgentAlertDraft, draft: AgentAlertDraft): AgentAlertField[] {
  return agentAlertFields.filter(field => fieldValue(base, field) !== fieldValue(draft, field))
}

/** A notification change: one msdb call each (sp_add_, sp_update_ or sp_delete_notification). `name` is the other side's: the operator in
 *  an alert's save, the alert in an operator's. */
export interface AgentNotificationChange { readonly name: string; readonly methods: number; readonly change: 'add' | 'update' | 'delete' }
/** What changed between two notification lists, by name. */
export function notificationChanges(before: readonly { readonly name: string; readonly methods: number }[], after: readonly { readonly name: string; readonly methods: number }[]): AgentNotificationChange[] {
  const old = new Map(before.filter(entry => entry.methods > 0).map(entry => [entry.name, entry.methods]))
  const now = new Map(after.filter(entry => entry.methods > 0).map(entry => [entry.name, entry.methods]))
  const changes: AgentNotificationChange[] = []
  for (const [name, methods] of now) {
    const was = old.get(name)
    if (was === undefined) changes.push({ name, methods, change: 'add' })
    else if (was !== methods) changes.push({ name, methods, change: 'update' })
  }
  for (const name of old.keys()) if (!now.has(name)) changes.push({ name, methods: 0, change: 'delete' })
  return changes
}
const alertNotifyChanges = (base: AgentAlertDraft, draft: AgentAlertDraft) =>
  notificationChanges(base.notify.map(entry => ({ name: entry.operator, methods: entry.methods })), draft.notify.map(entry => ({ name: entry.operator, methods: entry.methods })))
/** "Save · n changes": each changed field, each notification change and each new operator in place of the one `notify` field. */
export function agentAlertChangeCount(base: AgentAlertDraft, draft: AgentAlertDraft): number {
  return changedAgentAlertFields(base, draft).reduce((count, field) => count + (field === 'notify' ? alertNotifyChanges(base, draft).length + draft.newOperators.length : 1), 0)
}

// --- What Save sends ---------------------------------------------------------------------------------------------------

/** What Save sends. An existing alert's carries only what changed (a rename as `name`); New Alert's every argument it sets. When an event
 *  alert's raise-on changes, the error number and the severity go together (one of them 0), as sp_update_alert needs. `jobId` '' detaches the
 *  job. `newOperators` are created first, `notifications` applied last, by the alert's name as saved. */
export interface AgentAlertSave {
  readonly name?: string
  readonly enabled?: boolean
  readonly messageId?: number
  readonly severity?: number
  readonly database?: string
  readonly keyword?: string
  readonly condition?: string
  readonly jobId?: string
  readonly delay?: number
  readonly includeIn?: number
  readonly message?: string
  readonly resetCount?: true
  readonly newOperators?: readonly { readonly name: string; readonly email?: string; readonly pager?: string }[]
  readonly notifications?: readonly AgentNotificationChange[]
}

/** The save the draft asks for: undefined when an existing alert's draft changes nothing. */
export function agentAlertSave(model: AgentAlertDocumentModel, draft: AgentAlertDraft): AgentAlertSave | undefined {
  const alert = model.alert
  const base = initialAgentAlertDraft(model)
  const save: { -readonly [K in keyof AgentAlertSave]: AgentAlertSave[K] } = {}
  const fields = alert ? changedAgentAlertFields(base, draft) : agentAlertFields.filter(field => field !== 'count')
  if (alert && fields.length === 0) return undefined
  for (const field of fields) {
    switch (field) {
      case 'name': save.name = draft.name.trim(); break
      case 'enabled': save.enabled = draft.enabled; break
      case 'when':
        if (draft.kind === 'performance') { save.condition = conditionOf(draft); if (!alert) { save.messageId = 0; save.severity = 0 } }
        else if (draft.kind === 'event') {
          const message = draft.raiseOn === 'message'
          save.messageId = message ? Number(draft.messageId.trim()) : 0
          save.severity = message ? 0 : draft.severity
        }
        break
      case 'database': if (draft.kind === 'event' && (alert || draft.database)) save.database = draft.database; break
      case 'keyword': if (draft.kind === 'event' && (alert || draft.keyword)) save.keyword = draft.keyword; break
      case 'job': if (alert || draft.jobId) save.jobId = draft.jobId; break
      case 'notify': {
        const changes = alertNotifyChanges(base, draft)
        if (changes.length) save.notifications = changes
        if (draft.newOperators.length) save.newOperators = draft.newOperators.map(item => ({ name: item.name.trim(), ...item.email.trim() ? { email: item.email.trim() } : {}, ...item.pager.trim() ? { pager: item.pager.trim() } : {} }))
        break
      }
      case 'includeIn': save.includeIn = draft.includeIn; break
      case 'message': if (alert || draft.message) save.message = draft.message; break
      case 'delay': save.delay = draft.delay; break
      case 'count': if (draft.resetCount) save.resetCount = true; break
    }
  }
  // New Alert always names itself and its raise-on, and an existing alert's save is never empty.
  if (!alert) save.name = draft.name.trim()
  return Object.keys(save).length ? save : undefined
}

const noNul = (what: string) => (value: string) => !value.includes('\u0000') || `${what} cannot contain U+0000.`
const text = (max: number, what: string) => z.string().max(max).refine(value => noNul(what)(value) === true, `${what} cannot contain U+0000.`)
const address = text(agentLimits.addressChars, 'An address')
const methods = z.number().int().min(0).max(7)
const guid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
export const notificationChangeSchema = z.object({ name: ident, methods, change: z.enum(['add', 'update', 'delete']) }).strict()
  .refine(value => (value.change === 'delete') === (value.methods === 0), 'A notification is deleted exactly when it has no method.')
export const agentAlertSaveSchema = z.object({
  name: ident.optional(),
  enabled: z.boolean().optional(),
  messageId: z.number().int().min(0).max(2_147_483_647).optional(),
  severity: z.number().int().min(0).max(25).optional(),
  database: z.union([z.literal(''), ident]).optional(),
  keyword: text(agentLimits.alertKeywordChars, 'A keyword').optional(),
  condition: text(agentLimits.conditionChars, 'A condition').refine(value => parseCondition(value) !== undefined, 'Not a performance condition.').optional(),
  jobId: z.union([z.literal(''), z.string().regex(guid)]).optional(),
  delay: z.number().int().min(0).max(agentLimits.alertDelaySeconds).optional(),
  includeIn: methods.optional(),
  message: text(agentLimits.alertMessageChars, 'A message').optional(),
  resetCount: z.literal(true).optional(),
  newOperators: z.array(z.object({ name: ident, email: address.optional(), pager: address.optional() }).strict()).min(1).max(agentLimits.newOperators).optional(),
  notifications: z.array(notificationChangeSchema).min(1).max(agentLimits.notificationChanges).optional()
}).strict() satisfies z.ZodType<AgentAlertSave>

/** Why a save cannot run whatever the server says (C#'s ValidateAgentObjects refuses the same). `create`: New Alert (target the Agent node). */
export function agentAlertSaveProblems(save: AgentAlertSave, create: boolean): string[] {
  const problems: string[] = []
  if (create) {
    if (save.name === undefined) problems.push('A new alert needs a name.')
    if (save.resetCount) problems.push('A new alert has no count to reset.')
    if (save.condition === undefined && save.messageId === undefined) problems.push('A new alert needs an error number, a severity or a performance condition.')
  } else if (!Object.values(save).some(value => value !== undefined)) problems.push('There is nothing to change.')
  if ((save.messageId === undefined) !== (save.severity === undefined)) problems.push('The error number and the severity go together.')
  if (save.messageId !== undefined && save.condition === undefined && (save.messageId === 0) === (save.severity === 0)) problems.push('An event alert raises on an error number or a severity, not both.')
  if (save.condition !== undefined && (save.messageId ?? 0) + (save.severity ?? 0) !== 0) problems.push('A performance condition alert has no error number or severity.')
  if (save.notifications && new Set(save.notifications.map(item => item.name)).size !== save.notifications.length) problems.push('An operator is notified twice.')
  if (save.newOperators && new Set(save.newOperators.map(item => item.name)).size !== save.newOperators.length) problems.push('A new operator is created twice.')
  for (const added of save.newOperators ?? []) if (!save.notifications?.some(item => item.name === added.name && item.change === 'add')) problems.push('A new operator is created to be notified.')
  return problems
}

// --- Problems ------------------------------------------------------------------------------------------------------------

export interface AgentAlertProblem { readonly field: AgentAlertField; readonly severity: 'error' | 'warning'; readonly message: string }

export const agentAlertText = {
  platformAlerts: 'SQL Server Agent alerts need SQL Server on Windows; this server has none.',
  readAlertsDenied: "This login cannot read the server's alerts.",
  tooManyChanges: `One save changes at most ${agentLimits.notificationChanges} notifications. Save some, then the rest.`,
  nameRequired: 'The alert needs a name.',
  messageRequired: 'Type the error number the alert raises on.',
  messageInvalid: 'An error number is a whole number of 1 or more.',
  severityRange: 'A severity is 1 to 25.',
  objectRequired: 'Choose the counter\'s object.',
  counterRequired: 'Choose the counter.',
  valueRequired: 'Type the value the counter is compared with.',
  valueInvalid: 'The value is a number.',
  conditionTooLong: `A performance condition holds at most ${agentLimits.conditionChars} characters.`,
  conditionPipe: 'An object, counter or instance cannot contain |.',
  messageTooLong: `The message holds at most ${agentLimits.alertMessageChars} characters.`,
  keywordTooLong: `"Message contains" holds at most ${agentLimits.alertKeywordChars} characters.`,
  delayRange: 'The delay is 0 to 86,400 seconds (a day).',
  noResponse: 'This alert runs no job and notifies no one, so it only counts occurrences.',
  readOnly: 'Read-only. SQL Server Agent\'s roles may view alerts, not change them; only sysadmin can.',
  wmiReadOnly: 'WMI event alerts are shown read-only: When cannot be changed here yet; Then and Options can.',
  kindFixed: 'An alert keeps its type: to change it, create a new alert.',
  newOperatorName: 'The new operator needs a name.',
  newOperatorTaken: (name: string) => `${name} is already an operator on this server.`,
  newOperatorEmail: (name: string) => `${name} is notified by e-mail but has no e-mail address.`,
  newOperatorPager: (name: string) => `${name} is notified by pager but has no pager address.`,
  newOperatorHint: 'Created when you save, with the alert.',
  resetPending: 'The count goes back to 0 when you save.',
  resetSysadmin: 'Only sysadmin can reset the count.',
  countersTyped: 'This login cannot read the server\'s performance counters (VIEW SERVER STATE), so type the object, counter and instance.',
  countersHint: 'From sys.dm_os_performance_counters, so you can pick a threshold against real numbers.',
  delayHint: 'So a burst of the same error sends one message, not hundreds.'
} as const

const pipe = (value: string) => value.includes('|')
/** The draft's problems: errors on what Save cannot send, warnings on notifications that would not reach anyone. */
export function agentAlertProblems(model: AgentAlertDocumentModel, draft: AgentAlertDraft): AgentAlertProblem[] {
  const problems: AgentAlertProblem[] = []
  const error = (field: AgentAlertField, message: string) => problems.push({ field, severity: 'error', message })
  const warning = (field: AgentAlertField, message: string) => problems.push({ field, severity: 'warning', message })
  if (!draft.name.trim()) error('name', agentAlertText.nameRequired)
  if (alertNotifyChanges(initialAgentAlertDraft(model), draft).length > agentLimits.notificationChanges) error('notify', agentAlertText.tooManyChanges)
  if (draft.kind === 'event') {
    if (draft.raiseOn === 'message') {
      const id = draft.messageId.trim()
      if (!id) error('when', agentAlertText.messageRequired)
      else if (!/^[0-9]{1,10}$/.test(id) || Number(id) < 1 || Number(id) > 2_147_483_647) error('when', agentAlertText.messageInvalid)
    } else if (!Number.isInteger(draft.severity) || draft.severity < 1 || draft.severity > 25) error('when', agentAlertText.severityRange)
    if (draft.keyword.length > agentLimits.alertKeywordChars) error('keyword', agentAlertText.keywordTooLong)
  } else if (draft.kind === 'performance') {
    if (!draft.object.trim()) error('when', agentAlertText.objectRequired)
    else if (!draft.counter.trim()) error('when', agentAlertText.counterRequired)
    else if (!draft.value.trim()) error('when', agentAlertText.valueRequired)
    else if (!Number.isFinite(Number(draft.value.trim()))) error('when', agentAlertText.valueInvalid)
    else if ([draft.object, draft.counter, draft.instance].some(pipe)) error('when', agentAlertText.conditionPipe)
    else if (conditionOf(draft).length > agentLimits.conditionChars) error('when', agentAlertText.conditionTooLong)
  }
  if (draft.delay !== initialAgentAlertDraft(model).delay && (!Number.isInteger(draft.delay) || draft.delay < 0 || draft.delay > agentLimits.alertDelaySeconds)) error('delay', agentAlertText.delayRange)
  if (draft.message.length > agentLimits.alertMessageChars) error('message', agentAlertText.messageTooLong)
  const known = model.operators
  for (const added of draft.newOperators) {
    const name = added.name.trim()
    const methods = draft.notify.find(entry => entry.operator === added.name)?.methods ?? 0
    if (!name) { error('notify', agentAlertText.newOperatorName); continue }
    if (known?.some(operator => operator.name === name)) error('notify', agentAlertText.newOperatorTaken(name))
    if (methods & notifyEmail && !added.email.trim()) warning('notify', agentAlertText.newOperatorEmail(name))
    if (methods & notifyPager && !added.pager.trim()) warning('notify', agentAlertText.newOperatorPager(name))
  }
  for (const entry of draft.notify) {
    if (draft.newOperators.some(added => added.name === entry.operator) || !known) continue
    const operator = known.find(candidate => candidate.name === entry.operator)
    if (!operator) { warning('notify', `${entry.operator} is not an operator on this server.`); continue }
    if (!operator.enabled) warning('notify', `${entry.operator} is disabled, so it is not notified.`)
    if (entry.methods & notifyEmail && !operator.email) warning('notify', `${entry.operator} has no e-mail address.`)
    if (entry.methods & notifyPager) {
      if (!operator.pager) warning('notify', `${entry.operator} has no pager address.`)
      else if (operator.pagerDays === 0) warning('notify', `${entry.operator} is never on pager duty, so a page would not be sent.`)
      else { const duty = pagerDuty(operator); if (duty) warning('notify', `${entry.operator}'s pager duty is ${duty}; a page outside those hours is not sent.`) }
    }
    if (entry.methods & notifyNetSend && !operator.netSend) warning('notify', `${entry.operator} has no net send address.`)
  }
  if (draft.notify.some(entry => entry.methods & notifyEmail)) { const mail = mailProblem(model.mail, model.platform); if (mail) warning('notify', mail) }
  if (!draft.jobId && !draft.notify.some(entry => entry.methods > 0)) warning('notify', agentAlertText.noResponse)
  return problems
}
export const agentAlertSavable = (problems: readonly AgentAlertProblem[]) => !problems.some(problem => problem.severity === 'error')

/** The alert kinds New Alert offers on the platform; an existing alert keeps its own. */
export const alertKindsOffered = (platform: AgentPlatform): AgentAlertKind[] =>
  (['event', 'performance'] as const).filter(kind => agentGateOpen(alertKindGate[kind], platform))

// --- Add recommended alerts --------------------------------------------------------------------------------------------

/** The community-standard set (docs/agent-ui-rethink.md › rx-alerts-recommended): severity 17 and 19 to 25, and errors 823 to 825. */
export const recommendedAlerts: readonly { readonly name: string; readonly messageId: number; readonly severity: number }[] = [
  { name: 'Severity 017 - Insufficient resources', messageId: 0, severity: 17 },
  { name: 'Severity 019 - Fatal error in resource', messageId: 0, severity: 19 },
  { name: 'Severity 020 - Fatal error in current process', messageId: 0, severity: 20 },
  { name: 'Severity 021 - Fatal error in database process', messageId: 0, severity: 21 },
  { name: 'Severity 022 - Table integrity suspect', messageId: 0, severity: 22 },
  { name: 'Severity 023 - Database integrity suspect', messageId: 0, severity: 23 },
  { name: 'Severity 024 - Fatal hardware error', messageId: 0, severity: 24 },
  { name: 'Severity 025 - Fatal error', messageId: 0, severity: 25 },
  { name: 'Error 823 - I/O error', messageId: 823, severity: 0 },
  { name: 'Error 824 - Logical consistency I/O error', messageId: 824, severity: 0 },
  { name: 'Error 825 - Read retry required', messageId: 825, severity: 0 }
]
/** An alert on the server, by what it raises on. */
export interface AgentAlertRaise { readonly name: string; readonly messageId: number; readonly severity: number }
/** Each recommended alert with whether the server already has it: an alert on the same error number or severity (any name, any database),
 *  or an alert with its name. Those are shown and left as they are. */
export function recommendedAlertStates(existing: readonly AgentAlertRaise[]): { readonly name: string; readonly messageId: number; readonly severity: number; readonly exists: boolean }[] {
  return recommendedAlerts.map(entry => ({
    ...entry,
    exists: existing.some(alert => alert.name === entry.name || (entry.messageId ? alert.messageId === entry.messageId : alert.messageId === 0 && alert.severity === entry.severity))
  }))
}
export interface AgentRecommendedSave {
  readonly alerts: readonly { readonly name: string; readonly messageId: number; readonly severity: number }[]
  /** The one operator every new alert notifies; absent for none (then `methods` is 0). */
  readonly operator?: string
  readonly methods: number
  readonly delay: number
}
export const agentRecommendedSchema = z.object({
  alerts: z.array(z.object({ name: ident, messageId: z.number().int().min(0).max(2_147_483_647), severity: z.number().int().min(0).max(25) }).strict()
    .refine(value => (value.messageId === 0) !== (value.severity === 0), 'An alert raises on an error number or a severity.')).min(1).max(agentLimits.recommendedAlerts),
  operator: ident.optional(),
  methods,
  delay: z.number().int().min(0).max(agentLimits.alertDelaySeconds)
}).strict().refine(value => (value.operator === undefined) === (value.methods === 0), 'An operator goes with its methods.')
  .refine(value => new Set(value.alerts.map(alert => alert.name)).size === value.alerts.length, 'An alert is created twice.') satisfies z.ZodType<AgentRecommendedSave>
export interface AddRecommendedAlertsRequest {
  readonly action: 'addRecommendedAlerts'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef
  readonly agentRecommended: AgentRecommendedSave
}
export const addRecommendedAlertsRequestSchema = z.object({
  action: z.literal('addRecommendedAlerts'), connectionId: z.uuid(), requestId: z.uuid(), target: z.object({ kind: z.literal('agent') }).strict(), agentRecommended: agentRecommendedSchema
}).strict() satisfies z.ZodType<AddRecommendedAlertsRequest>

// --- agent.counterValues -----------------------------------------------------------------------------------------------

export interface AgentCounterValuesRequest { readonly connectionId: string; readonly requestId: string; readonly object: string; readonly counter: string }
export interface AgentCounterValuesResult {
  readonly values?: readonly AgentCounterValue[]
  readonly truncated?: boolean
  /** The server's clock when it read them (`yyyy-mm-ddThh:mm:ss`). */
  readonly readAt?: string
  readonly elapsedMs: number
  readonly error?: { readonly code: ActionErrorCode; readonly message: string; readonly retryable: boolean }
}
export const counterNameChars = 128
export const agentCounterValuesSchema = z.object({
  connectionId: z.uuid(), requestId: z.uuid(), object: z.string().min(1).max(counterNameChars).refine(value => !value.includes('\u0000')), counter: z.string().min(1).max(counterNameChars).refine(value => !value.includes('\u0000'))
}).strict() satisfies z.ZodType<AgentCounterValuesRequest>
export const agentCounterValuesResultSchema = z.object({
  values: z.array(z.object({ instance: z.string().max(counterNameChars), value: z.number() }).strict()).max(agentLimits.counterInstances).optional(),
  truncated: z.boolean().optional(), readAt: z.string().max(19).optional(), elapsedMs: z.number().int().min(0),
  error: z.object({ code: z.enum(actionErrorCodes), message: z.string().max(actionLimits.messageChars), retryable: z.boolean() }).strict().optional()
}).strict() satisfies z.ZodType<AgentCounterValuesResult>

// --- Commands ------------------------------------------------------------------------------------------------------------

export type AgentAlertCommandId = 'agent.newAlert' | 'agent.newAlertOnAgent' | 'agent.openAlert' | 'agent.addRecommendedAlerts' | 'agentAlert.save' | 'agentAlert.reload'
export interface AgentObjectCommandEntry {
  readonly title: string
  readonly category: 'SQL Server Agent'
  readonly icon: 'go-to-file' | 'add' | 'save' | 'refresh' | 'bell' | 'agent-operator' | 'check'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly menus?: readonly { readonly menu: 'explorer.context' | 'explorer.new'; readonly group: string; readonly order: number; readonly mnemonic?: string; readonly title?: string; readonly when?: string }[]
}
const connected = 'agentEnabled && backendReady && hasConnection'
const connectFirst = 'Connect to a SQL Server whose SQL Server Agent you can see first.'
/** Alerts are SQL Server on Windows only (agentPlatformGates.alerts), and only sysadmin creates them. */
export const alertsMenuWhen = "explorerServerEngine == 'box' && !explorerServerLinux && !explorerServerLost"
/**
 * The alert document's commands, behind the release gate: New Alert… (the Agent node's New › Alert…, the Alerts folder and an alert's menus,
 * and the palette), Open Alert… and Add Recommended Alerts… (the Alerts folder), and the document's Save and Reload, which act on the alert
 * document whose header runs them (`tabId`), else the active one. Properties on an alert opens the document through the object actions.
 */
export function agentAlertCommandEntries(): { readonly [K in AgentAlertCommandId]: AgentObjectCommandEntry & { readonly palette?: false } } {
  return {
    'agent.newAlert': {
      title: 'New Alert…', category: 'SQL Server Agent', icon: 'add', keywords: ['agent', 'alert', 'create', 'add', 'error', 'severity', 'performance', 'sqlserveragent'],
      precondition: connected, unavailableHint: connectFirst,
      menus: [{ menu: 'explorer.context', group: '0_new', order: 1, mnemonic: 'n', when: `((explorerNode == 'folder' && explorerFolder == 'agentAlerts') || explorerNode == 'agentAlert') && !explorerServerLost` }]
    },
    // The Agent node's New › Alert…: a command of its own, as New › Job… is, so the context menu never lists New Alert twice.
    'agent.newAlertOnAgent': {
      title: 'Alert…', category: 'SQL Server Agent', icon: 'add', keywords: [], palette: false,
      precondition: connected, unavailableHint: connectFirst,
      menus: [{ menu: 'explorer.new', group: '1_agent', order: 2, mnemonic: 'a', when: `explorerNode == 'agent' && agentRole == 'sysadmin' && ${alertsMenuWhen}` }]
    },
    'agent.openAlert': {
      title: 'Open Alert…', category: 'SQL Server Agent', icon: 'go-to-file', keywords: ['agent', 'alert', 'properties', 'edit', 'sqlserveragent'],
      precondition: connected, unavailableHint: connectFirst
    },
    'agent.addRecommendedAlerts': {
      title: 'Add Recommended Alerts…', category: 'SQL Server Agent', icon: 'check', keywords: ['agent', 'alert', 'severity', 'corruption', 'practice', 'recommended', 'sqlserveragent'],
      precondition: connected, unavailableHint: connectFirst,
      menus: [{ menu: 'explorer.context', group: '0_new', order: 2, mnemonic: 'r', when: "explorerNode == 'folder' && explorerFolder == 'agentAlerts' && agentRole == 'sysadmin' && !explorerServerLost" }]
    },
    'agentAlert.save': {
      title: 'Save Alert', category: 'SQL Server Agent', icon: 'save', keywords: ['agent', 'alert', 'apply', 'ok', 'update'],
      precondition: 'agentEnabled && backendReady && activeDocumentIsAgentAlert', unavailableHint: 'Change the alert first; a read-only alert cannot be saved.'
    },
    'agentAlert.reload': {
      title: 'Reload Alert', category: 'SQL Server Agent', icon: 'refresh', keywords: ['agent', 'alert', 'refresh', 'read', 'discard'],
      precondition: 'agentEnabled && backendReady && activeDocumentIsAgentAlert', unavailableHint: 'Open an alert first (Properties on an alert in Object Explorer).'
    }
  }
}
/** The document's tab: SSMS's Alert Properties window, by the alert's name; New Alert until a new alert is saved. */
export const agentAlertTabName = (name: string | undefined): string => name === undefined ? 'New Alert' : `Alert Properties - ${name}`
