// SQL Server Agent Properties (AG-8a, docs/agent-plan.md › Alerts, operators… › SQL Server Agent Properties): what the dialog reads, what
// its OK and its "Delete old history now" send, their bounds (zod here, C# in ActionService.ValidateAgentProperties), and the pure
// arithmetic behind "What this keeps" and the purge's cut-off. One action, `agentProperties`, carries either the changed settings
// (msdb.dbo.sp_set_sqlagent_properties, sysadmin) or the server-wide purge (msdb.dbo.sp_purge_jobhistory @oldest_date), never both: the
// purge runs apart from OK, after its own confirmation, and is never stored. No React here.
import { z } from 'zod'
import { agentLimits } from '../agent/catalog.ts'
import type { ObjectRef } from '../explorer/refs.ts'
import { objectRefSchema } from '../explorer/schema.ts'

/** The purge's unit, as the backend's `CASE @unit` reads it: 1 days, 2 weeks, 3 months (DATEADD on the server, in its local time). */
export const agentPurgeUnits = [1, 2, 3] as const
export type AgentPurgeUnit = typeof agentPurgeUnits[number]
export const agentPurgeUnitLabels: { readonly [U in AgentPurgeUnit]: string } = { 1: 'days', 2: 'weeks', 3: 'months' }

/** The settings OK changes, only those that differ from the describe. `historyMaxRows` -1 is SSMS's cleared "Limit size of job history
 *  log" (no limit), which takes no rows per job. */
export interface AgentPropertiesChanges {
  readonly sqlserverRestart?: boolean
  readonly monitorAutostart?: boolean
  readonly historyMaxRows?: number
  readonly historyMaxRowsPerJob?: number
}
/** "Delete old history now": every job's history older than `count` days, weeks or months before the server's clock. */
export interface AgentHistoryPurge { readonly count: number; readonly unit: AgentPurgeUnit }
export interface AgentPropertiesRequest {
  readonly action: 'agentProperties'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef
  readonly agentProperties?: AgentPropertiesChanges; readonly agentPurge?: AgentHistoryPurge
}

/** What sp_get_sqlagent_properties says, as the dialog shows it. A value msdb leaves NULL is absent. */
export interface AgentPropertiesSettings {
  /** Agent starts with Windows (the service's start mode, read-only here). */
  readonly autoStart?: boolean
  /** The account the service runs as. */
  readonly startupAccount?: string
  readonly sqlserverRestart: boolean
  readonly monitorAutostart: boolean
  /** -1 for no limit. */
  readonly historyMaxRows: number
  readonly historyMaxRowsPerJob: number
  readonly errorLogFile?: string
  /** 1 errors, 2 warnings, 4 information (execution trace messages), as a mask. */
  readonly errorLoggingLevel?: number
}
/** One job's history: its rows now, and how many of them the last `agentLimits.retentionDays` days wrote. */
export interface AgentRetentionJob { readonly name: string; readonly rows: number; readonly recent: number }
/** Every job's history as sysadmin reads it from sysjobhistory: the total, the rows the last days wrote, the jobs with the most rows,
 *  and the rows by age in whole days (`days` capped at `agentLimits.historyAgeDays`, where older rows count too). */
export interface AgentHistoryFacts {
  readonly total: number; readonly recent: number
  readonly jobs: readonly AgentRetentionJob[]; readonly jobsTruncated: boolean
  readonly ages: readonly { readonly days: number; readonly rows: number }[]
}
export interface AgentPropertiesModel {
  readonly settings: AgentPropertiesSettings
  /** The server's clock as msdb's history uses it (local time, `yyyy-mm-ddThh:mm:ss`), and its offset from UTC in minutes. */
  readonly serverNow: string
  readonly serverOffsetMinutes: number
  /** Why nothing can change (Managed Instance, a login below sysadmin): the dialog opens read-only with Close. */
  readonly readOnly?: string
  /** Every job's history, for sysadmin; absent with `historyNote` saying why. */
  readonly history?: AgentHistoryFacts
  readonly historyNote?: string
}

/** The dialog's words, which the pages, the tests and the docs share. */
export const agentPropertiesText = {
  managedInstance: 'Managed Instance does not allow changing SQL Server Agent properties.',
  notSysadmin: 'Only sysadmin can change SQL Server Agent properties.',
  historyHidden: "Only sysadmin can read every job's history, so what these settings keep is not shown.",
  limit: 'Limit size of job history log',
  maxRows: 'Maximum job history log size (rows)',
  maxRowsPerJob: 'Maximum job history rows per job',
  perJobTooMany: (max: number) => `Maximum job history rows per job must be from 1 to ${max.toLocaleString('en-US')}, the log's size.`,
  maxRowsRange: `Maximum job history log size must be from 2 to ${agentLimits.historyMaxRows.toLocaleString('en-US')} rows.`,
  purgeRange: `Older than must be from 1 to ${agentLimits.purgeCount.toLocaleString('en-US')}.`,
  purgeNote: 'Not a setting: it runs once, now, separately from OK, and cannot be undone.',
  purgeConfirm: (server: string, cutoff: string, serverTime: boolean) =>
    `Delete the history of every job on ${server} from before ${cutoff}${serverTime ? ' (server time)' : ''}? This runs once, now, separately from OK, and cannot be undone.`,
  purged: 'Deleted the history.',
  noRuns: `no runs in the last ${agentLimits.retentionDays} days`,
  serverTighter: (max: number) => `The server limit of ${max.toLocaleString('en-US')} rows is the tighter one for some jobs: raise Maximum job history log size too, or their old rows go first, oldest across all jobs.`
} as const

const maxRowsSchema = z.union([z.literal(-1), z.number().int().min(2).max(agentLimits.historyMaxRows)])
export const agentPropertiesChangesSchema = z.object({
  sqlserverRestart: z.boolean().optional(), monitorAutostart: z.boolean().optional(),
  historyMaxRows: maxRowsSchema.optional(), historyMaxRowsPerJob: z.number().int().min(1).max(agentLimits.historyMaxRows).optional()
}).strict() satisfies z.ZodType<AgentPropertiesChanges>
export const agentHistoryPurgeSchema = z.object({
  count: z.number().int().min(1).max(agentLimits.purgeCount), unit: z.union([z.literal(1), z.literal(2), z.literal(3)])
}).strict() satisfies z.ZodType<AgentHistoryPurge>
export const agentPropertiesRequestSchema = z.object({
  action: z.literal('agentProperties'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema,
  agentProperties: agentPropertiesChangesSchema.optional(), agentPurge: agentHistoryPurgeSchema.optional()
}).strict()

/** Why a request cannot run whatever the server says (C#'s ValidateAgentProperties refuses the same): the Agent node as its target, exactly
 *  one of the changes and the purge, changes that change something, and rows per job only with a limit, never above it. */
export function agentPropertiesProblems(request: Pick<AgentPropertiesRequest, 'target' | 'agentProperties' | 'agentPurge'>): string[] {
  const problems: string[] = []
  if (request.target.kind !== 'agent' || Object.keys(request.target).length !== 1) problems.push('SQL Server Agent Properties acts on the SQL Server Agent node.')
  if ((request.agentProperties === undefined) === (request.agentPurge === undefined)) problems.push('Send either the changed settings or the purge.')
  const changes = request.agentProperties
  if (changes) {
    if (!Object.values(changes).some(value => value !== undefined)) problems.push('There is nothing to change.')
    if (changes.historyMaxRows === -1 && changes.historyMaxRowsPerJob !== undefined) problems.push('An unlimited log takes no rows per job.')
    // msdb checks rows per job against the log's size, so both are sent together.
    if (changes.historyMaxRows === undefined && changes.historyMaxRowsPerJob !== undefined) problems.push("Rows per job go with the log's size.")
    if (changes.historyMaxRows !== undefined && changes.historyMaxRows !== -1 && changes.historyMaxRowsPerJob !== undefined && changes.historyMaxRowsPerJob > changes.historyMaxRows)
      problems.push(agentPropertiesText.perJobTooMany(changes.historyMaxRows))
  }
  return problems
}

/** The dialog's draft: General's two boxes and History's limit, with the numbers as typed so a half-typed one can say what is wrong. */
export interface AgentPropertiesDraft {
  readonly sqlserverRestart: boolean; readonly monitorAutostart: boolean
  readonly limit: boolean; readonly maxRows: string; readonly maxRowsPerJob: string
  /** "Delete old history now": the count as typed, the unit, and whether its inline confirmation is showing. */
  readonly purgeCount: string; readonly purgeUnit: AgentPurgeUnit; readonly purgeConfirming: boolean
}
export function initialAgentPropertiesDraft(model: AgentPropertiesModel): AgentPropertiesDraft {
  const { settings } = model, limit = settings.historyMaxRows !== -1
  // SSMS's defaults when the log has no limit: 1,000 rows, 100 per job.
  return {
    sqlserverRestart: settings.sqlserverRestart, monitorAutostart: settings.monitorAutostart, limit,
    maxRows: String(limit ? settings.historyMaxRows : 1000), maxRowsPerJob: String(limit && settings.historyMaxRowsPerJob > 0 ? settings.historyMaxRowsPerJob : 100),
    purgeCount: '4', purgeUnit: 2, purgeConfirming: false
  }
}
const whole = (text: string): number | undefined => /^\s*[0-9]{1,9}\s*$/.test(text) ? Number(text) : undefined

/** The limit the draft asks for, or why it cannot be sent. */
export function draftLimits(draft: AgentPropertiesDraft): { readonly maxRows: number; readonly maxRowsPerJob?: number } | { readonly problem: string } {
  if (!draft.limit) return { maxRows: -1 }
  const maxRows = whole(draft.maxRows), perJob = whole(draft.maxRowsPerJob)
  if (maxRows === undefined || maxRows < 2 || maxRows > agentLimits.historyMaxRows) return { problem: agentPropertiesText.maxRowsRange }
  if (perJob === undefined || perJob < 1 || perJob > maxRows) return { problem: agentPropertiesText.perJobTooMany(maxRows) }
  return { maxRows, maxRowsPerJob: perJob }
}

/** What OK sends: only what differs from the describe (SSMS sends every setting; msdb leaves a NULL argument as it is), or nothing. */
export function agentPropertiesChanges(model: AgentPropertiesModel, draft: AgentPropertiesDraft): AgentPropertiesChanges | { readonly problem: string } | undefined {
  const limits = draftLimits(draft)
  if ('problem' in limits) return limits
  const { settings } = model, changes: { -readonly [K in keyof AgentPropertiesChanges]: AgentPropertiesChanges[K] } = {}
  if (draft.sqlserverRestart !== settings.sqlserverRestart) changes.sqlserverRestart = draft.sqlserverRestart
  if (draft.monitorAutostart !== settings.monitorAutostart) changes.monitorAutostart = draft.monitorAutostart
  if (limits.maxRows === -1) { if (settings.historyMaxRows !== -1) changes.historyMaxRows = -1 }
  else if (limits.maxRows !== settings.historyMaxRows || limits.maxRowsPerJob !== settings.historyMaxRowsPerJob) {
    // msdb checks rows per job against the log size it is given, or the stored one, so both go together.
    changes.historyMaxRows = limits.maxRows
    changes.historyMaxRowsPerJob = limits.maxRowsPerJob
  }
  return Object.keys(changes).length ? changes : undefined
}

/** The purge the draft asks for, or why it cannot be sent. */
export function draftPurge(draft: AgentPropertiesDraft): AgentHistoryPurge | { readonly problem: string } {
  const count = whole(draft.purgeCount)
  return count === undefined || count < 1 || count > agentLimits.purgeCount ? { problem: agentPropertiesText.purgeRange } : { count, unit: draft.purgeUnit }
}

// --- The server's clock --------------------------------------------------------------------------------------------------

/** A server-local `yyyy-mm-ddThh:mm:ss` as a Date whose UTC fields are those values (no zone is applied). */
function naive(text: string): Date | undefined {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})$/.exec(text)
  if (!match) return undefined
  const [, y, mo, d, h, mi, s] = match.map(Number)
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  return Number.isNaN(date.getTime()) ? undefined : date
}
const pad = (value: number) => String(value).padStart(2, '0')
const naiveText = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`

/** The cut-off as the backend's DATEADD computes it from the server's clock (a month back from the 31st lands on the month's last day),
 *  as `yyyy-mm-dd hh:mm:ss` server time; undefined when the clock is not readable. The server computes the real one when the purge runs. */
export function purgeCutoff(serverNow: string, purge: AgentHistoryPurge): string | undefined {
  const now = naive(serverNow)
  if (!now) return undefined
  const date = new Date(now)
  if (purge.unit === 3) {
    const day = date.getUTCDate()
    date.setUTCDate(1)
    date.setUTCMonth(date.getUTCMonth() - purge.count)
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
    date.setUTCDate(Math.min(day, last))
  } else date.setUTCDate(date.getUTCDate() - purge.count * (purge.unit === 2 ? 7 : 1))
  return naiveText(date)
}
/** Whether the confirmation labels the cut-off "(server time)": the server's offset from UTC differs from this computer's. */
export const serverTimeDiffers = (serverOffsetMinutes: number, localOffsetMinutes = -new Date().getTimezoneOffset()): boolean => serverOffsetMinutes !== localOffsetMinutes

/** About how many rows the purge deletes: those whole days older than the cut-off. Undefined without the history counts, or when the cut-off
 *  is older than the ages the describe counts separately. */
export function purgeRowsEstimate(model: AgentPropertiesModel, purge: AgentHistoryPurge): number | undefined {
  const history = model.history, now = naive(model.serverNow), cutoff = purgeCutoff(model.serverNow, purge)
  if (!history || !now || !cutoff) return undefined
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const cut = naive(cutoff.replace(' ', 'T'))!
  const days = Math.round((today - Date.UTC(cut.getUTCFullYear(), cut.getUTCMonth(), cut.getUTCDate())) / 86_400_000)
  if (days >= agentLimits.historyAgeDays) return undefined
  return history.ages.reduce((sum, age) => age.days > days ? sum + age.rows : sum, 0)
}

// --- What this keeps -----------------------------------------------------------------------------------------------------

/** About how long a span of days is, in words: "about 12 hours", "about 2½ days", "about 20 weeks". */
export function spanText(days: number): string {
  if (!Number.isFinite(days)) return 'everything'
  if (days < 1) return `about ${Math.max(1, Math.round(days * 24))} ${Math.round(days * 24) <= 1 ? 'hour' : 'hours'}`
  if (days < 14) {
    const halves = Math.round(days * 2) / 2, base = Math.floor(halves)
    return `about ${base}${halves > base ? '½' : ''} ${halves === 1 ? 'day' : 'days'}`
  }
  if (days < 7 * 26) return `about ${Math.round(days / 7)} weeks`
  if (days < 365 * 2) return `about ${Math.round(days / 30.4)} months`
  return `about ${Math.round(days / 365)} years`
}
/** A job's rate in words, from the rows it wrote in the measured days: "192 a day", "5 a week". */
export function rateText(recent: number): string {
  if (recent <= 0) return agentPropertiesText.noRuns
  const perDay = recent / agentLimits.retentionDays
  return perDay >= 1 ? `${Math.round(perDay).toLocaleString('en-US')} a day` : `${recent.toLocaleString('en-US')} ${agentLimits.retentionDays === 7 ? 'a week' : `in ${agentLimits.retentionDays} days`}`
}
/** How long a job's history lasts under a limit: rows per job over its rate, or the log's size over every job's rate where that is less
 *  (Agent then removes the oldest rows of any job). `server` says the log's size decided it. */
export function keptFor(job: AgentRetentionJob, history: AgentHistoryFacts, limits: { readonly maxRows: number; readonly maxRowsPerJob?: number }): { readonly text: string; readonly server: boolean } {
  if (limits.maxRows === -1) return { text: 'everything (no limit)', server: false }
  if (job.recent <= 0) return { text: '—', server: false }
  const perDay = job.recent / agentLimits.retentionDays, allPerDay = Math.max(history.recent, job.recent) / agentLimits.retentionDays
  const own = (limits.maxRowsPerJob ?? limits.maxRows) / perDay, shared = limits.maxRows / allPerDay
  return shared < own ? { text: `${spanText(shared)} (the log's size)`, server: true } : { text: spanText(own), server: false }
}
