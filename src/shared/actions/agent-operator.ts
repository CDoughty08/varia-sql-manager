// The SQL Server Agent operator document and the Operators and notifications grid (AG-7, docs/agent-plan.md › Operators,
// docs/agent-ui-rethink.md › rx-operators, rx-operator-delete): what their describes read, the operator draft and what Save sends (one
// `agentOperator` action: New Operator's sp_add_operator, or an existing operator's sp_update_operator with only the changed arguments, then
// each notification change, in one transaction), the grid's changes (one `agentAlert` save per changed alert), Delete with Reassign to
// (sp_delete_operator @reassign_to_operator), Send test e-mail (sp_notify_operator through Agent's own profile) and the commands. Bounds are zod
// here and C# in ActionService.ValidateAgentObjects. No React here.
import { z } from 'zod'
import { agentLimits, type AgentPlatform } from '../agent/catalog.ts'
import type { ObjectRef } from '../explorer/refs.ts'
import { ident } from '../explorer/schema.ts'
import { mailProblem, type AgentDutyHours, type AgentJobMail } from './agent-job.ts'
import { agentAlertText, notificationChangeSchema, notificationChanges, notifyEmail, notifyNetSend, notifyPager, type AgentAlertKind, type AgentNotificationChange, type AgentObjectCommandEntry } from './agent-alert.ts'

/** An operator as sp_help_operator describes it. Last notified dates are the server's local time, absent when never. */
export interface AgentOperatorRecord {
  readonly id: number
  readonly name: string
  readonly enabled: boolean
  readonly email: string
  readonly pager: string
  readonly netSend: string
  /** sysoperators.pager_days: Sunday 1, Monday 2, … Saturday 64. */
  readonly pagerDays: number
  readonly weekday: AgentDutyHours
  readonly saturday: AgentDutyHours
  readonly sunday: AgentDutyHours
  readonly lastEmail?: string
  readonly lastPager?: string
  readonly lastNetSend?: string
}
/** An alert as the grid and an operator's Notifications list show it. */
export interface AgentAlertRow { readonly id: number; readonly name: string; readonly enabled: boolean; readonly kind: AgentAlertKind; readonly messageId: number; readonly severity: number }
/** One sysnotifications row: an alert that notifies an operator, and how. */
export interface AgentNotificationRow { readonly alertId: number; readonly operatorId: number; readonly methods: number }
/** A job that notifies operators when it completes (sysjobs' notify columns, an operator only with its level above 0). */
export interface AgentJobNotifyRow { readonly id: string; readonly name: string; readonly email: string; readonly page: string; readonly netSend: string }

export interface AgentOperatorDocumentModel {
  /** Absent for New Operator. */
  readonly operator?: AgentOperatorRecord
  readonly login: string
  readonly sysadmin: boolean
  readonly platform: AgentPlatform
  /** Why nothing can change: below sysadmin no Agent role may run sp_add_operator or sp_update_operator. */
  readonly readOnly?: string
  /** Absent where the login may not read alerts (below SQLAgentOperatorRole) or the platform has none. */
  readonly alerts?: readonly AgentAlertRow[]
  readonly alertsTruncated?: boolean
  readonly notifications: readonly AgentNotificationRow[]
  /** The jobs that notify this operator, where the login may read them. */
  readonly jobs?: readonly AgentJobNotifyRow[]
  readonly mail: AgentJobMail
}

/** The Operators and notifications grid's describe. */
export interface AgentOperatorsModel {
  readonly login: string
  readonly sysadmin: boolean
  readonly platform: AgentPlatform
  readonly readOnly?: string
  readonly operators: readonly AgentOperatorRecord[]
  readonly operatorsTruncated?: boolean
  readonly alerts?: readonly AgentAlertRow[]
  readonly alertsTruncated?: boolean
  readonly notifications: readonly AgentNotificationRow[]
  readonly jobs?: readonly AgentJobNotifyRow[]
  readonly mail: AgentJobMail
}

export const agentOperatorFields = ['name', 'enabled', 'email', 'pager', 'netSend', 'duty', 'notify'] as const
export type AgentOperatorField = typeof agentOperatorFields[number]

/** Pager duty as the document edits it: hhmmss integers in server time, as sysoperators keeps them. */
export interface AgentOperatorDraft {
  readonly name: string
  readonly enabled: boolean
  readonly email: string
  readonly pager: string
  readonly netSend: string
  readonly pagerDays: number
  readonly weekday: AgentDutyHours
  readonly saturday: AgentDutyHours
  readonly sunday: AgentDutyHours
  /** The alerts that notify it, by alert name. */
  readonly notify: readonly { readonly alert: string; readonly methods: number }[]
}

/** SSMS's New Operator: enabled, on pager duty every day 08:00 to 18:00. */
const defaultDuty: AgentDutyHours = { start: 80_000, end: 180_000 }
export function initialAgentOperatorDraft(model: Pick<AgentOperatorDocumentModel, 'operator' | 'alerts' | 'notifications'>): AgentOperatorDraft {
  const operator = model.operator
  if (!operator) return { name: '', enabled: true, email: '', pager: '', netSend: '', pagerDays: 127, weekday: defaultDuty, saturday: defaultDuty, sunday: defaultDuty, notify: [] }
  const alertName = new Map((model.alerts ?? []).map(alert => [alert.id, alert.name]))
  return {
    name: operator.name, enabled: operator.enabled, email: operator.email, pager: operator.pager, netSend: operator.netSend, pagerDays: operator.pagerDays,
    weekday: operator.weekday, saturday: operator.saturday, sunday: operator.sunday,
    notify: model.notifications.filter(row => row.operatorId === operator.id && row.methods > 0 && alertName.has(row.alertId)).map(row => ({ alert: alertName.get(row.alertId)!, methods: row.methods }))
  }
}

const hours = (value: AgentDutyHours) => `${value.start}-${value.end}`
function fieldValue(draft: AgentOperatorDraft, field: AgentOperatorField): string {
  switch (field) {
    case 'name': return draft.name.trim()
    case 'enabled': return String(draft.enabled)
    case 'email': return draft.email
    case 'pager': return draft.pager
    case 'netSend': return draft.netSend
    case 'duty': return `${draft.pagerDays}|${hours(draft.weekday)}|${hours(draft.saturday)}|${hours(draft.sunday)}`
    case 'notify': return [...draft.notify].filter(entry => entry.methods > 0).sort((a, b) => a.alert < b.alert ? -1 : a.alert > b.alert ? 1 : 0).map(entry => `${entry.alert}:${entry.methods}`).join(',')
  }
}
export function changedAgentOperatorFields(base: AgentOperatorDraft, draft: AgentOperatorDraft): AgentOperatorField[] {
  return agentOperatorFields.filter(field => fieldValue(base, field) !== fieldValue(draft, field))
}
const operatorNotifyChanges = (base: AgentOperatorDraft, draft: AgentOperatorDraft) =>
  notificationChanges(base.notify.map(entry => ({ name: entry.alert, methods: entry.methods })), draft.notify.map(entry => ({ name: entry.alert, methods: entry.methods })))
export function agentOperatorChangeCount(base: AgentOperatorDraft, draft: AgentOperatorDraft): number {
  return changedAgentOperatorFields(base, draft).reduce((count, field) => count + (field === 'notify' ? operatorNotifyChanges(base, draft).length : 1), 0)
}

/** What Save sends: an existing operator's changed arguments (a rename as `name`, '' clears an address), New Operator's every one it sets.
 *  Duty goes as all seven values together. `notifications` name the alerts. */
export interface AgentOperatorSave {
  readonly name?: string
  readonly enabled?: boolean
  readonly email?: string
  readonly pager?: string
  readonly netSend?: string
  readonly pagerDays?: number
  readonly weekdayStart?: number; readonly weekdayEnd?: number
  readonly saturdayStart?: number; readonly saturdayEnd?: number
  readonly sundayStart?: number; readonly sundayEnd?: number
  readonly notifications?: readonly AgentNotificationChange[]
}
export function agentOperatorSave(model: AgentOperatorDocumentModel, draft: AgentOperatorDraft): AgentOperatorSave | undefined {
  const existing = model.operator !== undefined
  const base = initialAgentOperatorDraft(model)
  const fields = existing ? changedAgentOperatorFields(base, draft) : agentOperatorFields
  if (existing && fields.length === 0) return undefined
  const save: { -readonly [K in keyof AgentOperatorSave]: AgentOperatorSave[K] } = {}
  for (const field of fields) {
    switch (field) {
      case 'name': save.name = draft.name.trim(); break
      case 'enabled': save.enabled = draft.enabled; break
      case 'email': if (existing || draft.email.trim()) save.email = draft.email.trim(); break
      case 'pager': if (existing || draft.pager.trim()) save.pager = draft.pager.trim(); break
      case 'netSend': if (existing || draft.netSend.trim()) save.netSend = draft.netSend.trim(); break
      case 'duty':
        Object.assign(save, { pagerDays: draft.pagerDays, weekdayStart: draft.weekday.start, weekdayEnd: draft.weekday.end, saturdayStart: draft.saturday.start, saturdayEnd: draft.saturday.end, sundayStart: draft.sunday.start, sundayEnd: draft.sunday.end })
        break
      case 'notify': { const changes = operatorNotifyChanges(base, draft); if (changes.length) save.notifications = changes; break }
    }
  }
  return Object.keys(save).length ? save : undefined
}

const noNul = (value: string) => !value.includes('\u0000')
const address = z.string().max(agentLimits.addressChars).refine(noNul, 'An address cannot contain U+0000.')
const time = z.number().int().min(0).max(235_959).refine(value => value % 100 < 60 && Math.floor(value / 100) % 100 < 60, 'Not a time of day.')
export const agentOperatorSaveSchema = z.object({
  name: ident.optional(), enabled: z.boolean().optional(), email: address.optional(), pager: address.optional(), netSend: address.optional(),
  pagerDays: z.number().int().min(0).max(127).optional(),
  weekdayStart: time.optional(), weekdayEnd: time.optional(), saturdayStart: time.optional(), saturdayEnd: time.optional(), sundayStart: time.optional(), sundayEnd: time.optional(),
  notifications: z.array(notificationChangeSchema).min(1).max(agentLimits.notificationChanges).optional()
}).strict() satisfies z.ZodType<AgentOperatorSave>
const dutyKeys = ['pagerDays', 'weekdayStart', 'weekdayEnd', 'saturdayStart', 'saturdayEnd', 'sundayStart', 'sundayEnd'] as const
export function agentOperatorSaveProblems(save: AgentOperatorSave, create: boolean): string[] {
  const problems: string[] = []
  if (create && save.name === undefined) problems.push('A new operator needs a name.')
  if (!create && !Object.values(save).some(value => value !== undefined)) problems.push('There is nothing to change.')
  const duty = dutyKeys.filter(key => save[key] !== undefined).length
  if (duty !== 0 && duty !== dutyKeys.length) problems.push('Pager duty goes as its days and all six times together.')
  if (save.notifications && new Set(save.notifications.map(item => item.name)).size !== save.notifications.length) problems.push('An alert is changed twice.')
  return problems
}

// --- Problems ------------------------------------------------------------------------------------------------------------

export interface AgentOperatorProblem { readonly field: AgentOperatorField; readonly severity: 'error' | 'warning'; readonly message: string }
export const agentOperatorText = {
  nameRequired: 'The operator needs a name.',
  addressTooLong: `An address holds at most ${agentLimits.addressChars} characters.`,
  noAddress: 'This operator has no address, so nothing can reach it.',
  netSendRetired: 'Net send was removed from Windows; SQL Server Agent cannot deliver it.',
  noDuty: 'Pager duty is on no day, so a page is never sent.',
  dutyOrder: (day: string) => `${day}'s duty ends before it starts; SQL Server Agent treats that as overnight.`,
  readOnly: 'Read-only. SQL Server Agent\'s roles may view operators, not change them; only sysadmin can.',
  emailMissing: (alert: string) => `${alert} notifies by e-mail, but there is no e-mail address.`,
  pagerMissing: (alert: string) => `${alert} notifies by pager, but there is no pager address.`,
  testSent: (name: string) => `Test e-mail queued for ${name}. Database Mail sends it; its log says whether it arrived.`,
  testNeedsEmail: 'Give the operator an e-mail address and save first.',
  testMailOff: 'Database Mail is off on this server (Database Mail XPs), so the test e-mail cannot be sent.',
  testDisabled: 'Enable the operator and save first: SQL Server Agent sends nothing to a disabled operator.',
  testNeedsProfile: 'SQL Server Agent has no Database Mail profile, so it cannot send e-mail. Set one in SQL Server Agent Properties › Alert System.',
  testSysadmin: 'Only sysadmin can send a test e-mail through SQL Server Agent\'s profile.',
  testUnsaved: 'Save the operator first: the test goes to the address on the server.',
  deleteTitle: (name: string) => `Delete operator ${name}?`,
  deleteUses: (alerts: number, jobs: number) => `It is notified by ${alerts} alert${alerts === 1 ? '' : 's'} and ${jobs} job${jobs === 1 ? '' : 's'}.`,
  deleteUnused: 'Nothing notifies it.',
  reassign: 'Move its notifications to',
  dropAll: 'Drop them (nobody is notified in its place)',
  deleteNow: 'Delete runs at once: it is not part of Save.'
} as const
const dayNames = { weekday: 'Weekdays', saturday: 'Saturday', sunday: 'Sunday' } as const
export function agentOperatorProblems(model: AgentOperatorDocumentModel, draft: AgentOperatorDraft): AgentOperatorProblem[] {
  const problems: AgentOperatorProblem[] = []
  const error = (field: AgentOperatorField, message: string) => problems.push({ field, severity: 'error', message })
  const warning = (field: AgentOperatorField, message: string) => problems.push({ field, severity: 'warning', message })
  if (!draft.name.trim()) error('name', agentOperatorText.nameRequired)
  if (operatorNotifyChanges(initialAgentOperatorDraft(model), draft).length > agentLimits.notificationChanges) error('notify', agentAlertText.tooManyChanges)
  for (const field of ['email', 'pager', 'netSend'] as const) if (draft[field].length > agentLimits.addressChars) error(field, agentOperatorText.addressTooLong)
  if (!draft.email.trim() && !draft.pager.trim() && !draft.netSend.trim()) warning('email', agentOperatorText.noAddress)
  if (draft.netSend.trim()) warning('netSend', agentOperatorText.netSendRetired)
  if (draft.pager.trim()) {
    if (draft.pagerDays === 0) warning('duty', agentOperatorText.noDuty)
    for (const day of ['weekday', 'saturday', 'sunday'] as const) if (draft[day].end < draft[day].start) warning('duty', agentOperatorText.dutyOrder(dayNames[day]))
  }
  for (const entry of draft.notify) {
    if (entry.methods & notifyEmail && !draft.email.trim()) warning('notify', agentOperatorText.emailMissing(entry.alert))
    if (entry.methods & notifyPager && !draft.pager.trim()) warning('notify', agentOperatorText.pagerMissing(entry.alert))
  }
  if (draft.email.trim()) { const mail = mailProblem(model.mail, model.platform); if (mail) warning('email', mail) }
  return problems
}
export const agentOperatorSavable = (problems: readonly AgentOperatorProblem[]) => !problems.some(problem => problem.severity === 'error')

// --- The grid ------------------------------------------------------------------------------------------------------------

/** The grid's cells: alert name → operator name → methods. */
export type AgentNotifyMatrix = ReadonlyMap<string, ReadonlyMap<string, number>>
export function notifyMatrix(model: Pick<AgentOperatorsModel, 'operators' | 'alerts' | 'notifications'>): AgentNotifyMatrix {
  const operatorName = new Map(model.operators.map(operator => [operator.id, operator.name]))
  const matrix = new Map<string, Map<string, number>>((model.alerts ?? []).map(alert => [alert.name, new Map()]))
  const alertName = new Map((model.alerts ?? []).map(alert => [alert.id, alert.name]))
  for (const row of model.notifications) {
    const alert = alertName.get(row.alertId), operator = operatorName.get(row.operatorId)
    if (alert !== undefined && operator !== undefined && row.methods > 0) matrix.get(alert)!.set(operator, row.methods)
  }
  return matrix
}
export const withCell = (matrix: AgentNotifyMatrix, alert: string, operator: string, methods: number): AgentNotifyMatrix => {
  const next = new Map(matrix)
  const row = new Map(next.get(alert) ?? [])
  if (methods > 0) row.set(operator, methods); else row.delete(operator)
  next.set(alert, row)
  return next
}
/** Each changed alert's notification changes, in the grid's alert order. */
export function matrixChanges(model: AgentOperatorsModel, base: AgentNotifyMatrix, draft: AgentNotifyMatrix): { readonly alert: AgentAlertRow; readonly changes: AgentNotificationChange[] }[] {
  return (model.alerts ?? []).flatMap(alert => {
    const before = [...(base.get(alert.name) ?? new Map()).entries()].map(([name, methods]) => ({ name, methods }))
    const after = [...(draft.get(alert.name) ?? new Map()).entries()].map(([name, methods]) => ({ name, methods }))
    const changes = notificationChanges(before, after)
    return changes.length ? [{ alert, changes }] : []
  })
}
/** An alert row whose changes one save cannot carry (each alert's changes are one request). */
export const matrixProblems = (model: AgentOperatorsModel, draft: AgentNotifyMatrix) => matrixChanges(model, notifyMatrix(model), draft)
  .filter(entry => entry.changes.length > agentLimits.notificationChanges).map(entry => ({ severity: 'error' as const, message: `${entry.alert.name}: ${agentAlertText.tooManyChanges}` }))
export const matrixChangeCount = (model: AgentOperatorsModel, base: AgentNotifyMatrix, draft: AgentNotifyMatrix) => matrixChanges(model, base, draft).reduce((count, entry) => count + entry.changes.length, 0)
/** A cell's text: E, P and N for e-mail, pager and net send. */
export const cellText = (methods: number) => `${methods & notifyEmail ? 'E' : ''}${methods & notifyPager ? 'P' : ''}${methods & notifyNetSend ? 'N' : ''}`
/** What one operator is notified by: alert count and job count. */
export function operatorUses(model: Pick<AgentOperatorsModel, 'notifications' | 'jobs'>, operator: AgentOperatorRecord): { alerts: number; jobs: number } {
  return {
    alerts: model.notifications.filter(row => row.operatorId === operator.id && row.methods > 0).length,
    jobs: (model.jobs ?? []).filter(job => job.email === operator.name || job.page === operator.name || job.netSend === operator.name).length
  }
}

// --- Send test e-mail ----------------------------------------------------------------------------------------------------

export interface NotifyOperatorRequest {
  readonly action: 'notifyOperator'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef
  readonly agentObjectId: number
}
export const notifyOperatorRequestSchema = z.object({
  action: z.literal('notifyOperator'), connectionId: z.uuid(), requestId: z.uuid(), target: z.object({ kind: z.literal('agentOperator'), name: ident }).strict(),
  agentObjectId: z.number().int().min(1).max(2_147_483_647)
}).strict() satisfies z.ZodType<NotifyOperatorRequest>

// --- Commands ------------------------------------------------------------------------------------------------------------

export type AgentOperatorCommandId = 'agent.newOperator' | 'agent.newOperatorOnAgent' | 'agent.openOperator' | 'agent.operators' | 'agentOperator.save' | 'agentOperator.reload' | 'agentOperator.sendTest'
  | 'agentOperators.save' | 'agentOperators.reload'
const connected = 'agentEnabled && backendReady && hasConnection'
const connectFirst = 'Connect to a SQL Server whose SQL Server Agent you can see first.'
/**
 * The operator document's and the grid's commands, behind the release gate: New Operator… (the Agent node's New › Operator…, the Operators
 * folder and an operator's menus), New › Job… on the Agent node (a command of its own, as explorer.newLoginOnSecurity is, so macOS context
 * menus do not show New Job twice), Operators and Notifications… (the Operators and Alerts folders), and the documents' Save, Reload and Send
 * test e-mail.
 */
export function agentOperatorCommandEntries(): { readonly [K in AgentOperatorCommandId]: AgentObjectCommandEntry & { readonly palette?: false } } {
  return {
    'agent.newOperator': {
      title: 'New Operator…', category: 'SQL Server Agent', icon: 'add', keywords: ['agent', 'operator', 'create', 'add', 'notify', 'email', 'pager', 'sqlserveragent'],
      precondition: connected, unavailableHint: connectFirst,
      menus: [{ menu: 'explorer.context', group: '0_new', order: 1, mnemonic: 'n', when: "((explorerNode == 'folder' && explorerFolder == 'agentOperators') || explorerNode == 'agentOperator') && !explorerServerLost" }]
    },
    'agent.newOperatorOnAgent': {
      title: 'Operator…', category: 'SQL Server Agent', icon: 'add', keywords: [], palette: false,
      precondition: connected, unavailableHint: connectFirst,
      menus: [{ menu: 'explorer.new', group: '2_agent', order: 3, mnemonic: 'o', when: "explorerNode == 'agent' && agentRole == 'sysadmin' && !explorerServerLost" }]
    },
    'agent.openOperator': {
      title: 'Open Operator…', category: 'SQL Server Agent', icon: 'go-to-file', keywords: ['agent', 'operator', 'properties', 'edit', 'sqlserveragent'],
      precondition: connected, unavailableHint: connectFirst
    },
    'agent.operators': {
      title: 'Operators and Notifications…', category: 'SQL Server Agent', icon: 'bell', keywords: ['agent', 'operator', 'alert', 'notification', 'grid', 'who', 'email', 'pager', 'sqlserveragent'],
      precondition: connected, unavailableHint: connectFirst,
      menus: [{ menu: 'explorer.context', group: '0_new', order: 3, mnemonic: 'o', when: "explorerNode == 'folder' && (explorerFolder == 'agentOperators' || explorerFolder == 'agentAlerts') && !explorerServerLost" }]
    },
    'agentOperator.save': {
      title: 'Save Operator', category: 'SQL Server Agent', icon: 'save', keywords: ['agent', 'operator', 'apply', 'ok', 'update'],
      precondition: 'agentEnabled && backendReady && activeDocumentIsAgentOperator', unavailableHint: 'Change the operator first; a read-only operator cannot be saved.'
    },
    'agentOperator.reload': {
      title: 'Reload Operator', category: 'SQL Server Agent', icon: 'refresh', keywords: ['agent', 'operator', 'refresh', 'read', 'discard'],
      precondition: 'agentEnabled && backendReady && activeDocumentIsAgentOperator', unavailableHint: 'Open an operator first (Properties on an operator in Object Explorer).'
    },
    'agentOperator.sendTest': {
      title: 'Send Test E-mail', category: 'SQL Server Agent', icon: 'agent-operator', keywords: ['agent', 'operator', 'mail', 'test', 'databasemail', 'notify'],
      precondition: 'agentEnabled && backendReady && activeDocumentIsAgentOperator', unavailableHint: 'Open an operator with an e-mail address first.'
    },
    'agentOperators.save': {
      title: 'Save Notifications', category: 'SQL Server Agent', icon: 'save', keywords: ['agent', 'operator', 'alert', 'notification', 'apply'],
      precondition: 'agentEnabled && backendReady && activeDocumentIsAgentOperators', unavailableHint: 'Change a notification first.'
    },
    'agentOperators.reload': {
      title: 'Reload Notifications', category: 'SQL Server Agent', icon: 'refresh', keywords: ['agent', 'operator', 'alert', 'notification', 'refresh'],
      precondition: 'agentEnabled && backendReady && activeDocumentIsAgentOperators', unavailableHint: 'Open Operators and Notifications first.'
    }
  }
}
export const agentOperatorTabName = (name: string | undefined): string => name === undefined ? 'New Operator' : `Operator Properties - ${name}`
export const agentOperatorsTabName = 'Operators and Notifications'
