// The strict zod schema of the Activity Monitor's filter: Processes' view chip and toggles, the filter box and the column
// value filters. The live layer carries it as `args.activity` (L2b); the backend re-checks every bound and column id against
// the catalogue (Activity/ActivityFilter.cs) and filters the snapshot in memory, so the SQL never changes. Below it, the
// session actions' requests (main's requestSchemas) and answers; Activity/SessionActions.cs re-checks the same bounds.
import { z } from 'zod'
import type { LiveErrorCode } from '../live/schema.ts'
import { activityLimits, activityTables, detailsTexts, tableSpecs, viewChips, waitToggles, type ActivityTable, type DetailsSection, type DetailsText, type KillOutcome, type ViewChip } from './catalog.ts'

export interface ActivityColumnFilter {
  readonly column: string
  /** Rows whose cell text equals one of these (exactly, as the facets list them). */
  readonly values?: readonly string[]
  /** Rows whose cell is empty or NULL. */
  readonly blanks?: boolean
  /** Rows whose cell is not empty. */
  readonly nonBlanks?: boolean
}
export interface ActivityFilter {
  readonly table: ActivityTable
  /** Processes only. */
  readonly view?: ViewChip
  /** Processes only: SQL Server's own sessions, and Varia's pool sessions (query tabs always show). */
  readonly showSystem?: boolean
  readonly showVaria?: boolean
  /** Resource Waits' tables only: leave out benign rows (on when absent). */
  readonly hideBenign?: boolean
  /** Matched case-insensitively against the table's text columns. */
  readonly text?: string
  /** One per column; within one, any choice matches, and every column must match. */
  readonly columnFilters?: readonly ActivityColumnFilter[]
}

const processesOnly = ['view', 'showSystem', 'showVaria'] as const

export const activityColumnFilterSchema = z.object({
  column: z.string().min(1).max(64),
  values: z.array(z.string().max(activityLimits.columnFilterChars)).max(activityLimits.columnFilterValues).optional(),
  blanks: z.boolean().optional(),
  nonBlanks: z.boolean().optional()
}).strict()

export const activityFilterSchema = z.object({
  table: z.enum(activityTables),
  view: z.enum(viewChips).optional(),
  showSystem: z.boolean().optional(),
  showVaria: z.boolean().optional(),
  hideBenign: z.boolean().optional(),
  text: z.string().max(activityLimits.filterText).optional(),
  columnFilters: z.array(activityColumnFilterSchema).max(activityLimits.columnFilters).optional()
}).strict().superRefine((filter, context) => {
  const spec = tableSpecs[filter.table]
  if (filter.table !== 'sessions') {
    for (const key of processesOnly) if (filter[key] !== undefined) context.addIssue({ code: 'custom', path: [key], message: `Only Processes takes ${key}.` })
  }
  if (filter.hideBenign !== undefined && !(waitToggles.hideBenign.tables as readonly ActivityTable[]).includes(filter.table)) context.addIssue({ code: 'custom', path: ['hideBenign'], message: 'Only Resource Waits takes hideBenign.' })
  const seen = new Set<string>()
  filter.columnFilters?.forEach((columnFilter, index) => {
    if (!spec.facetColumns?.includes(columnFilter.column)) context.addIssue({ code: 'custom', path: ['columnFilters', index, 'column'], message: `${spec.title} has no value filter on ${columnFilter.column}.` })
    if (seen.has(columnFilter.column)) context.addIssue({ code: 'custom', path: ['columnFilters', index, 'column'], message: 'One filter per column.' })
    seen.add(columnFilter.column)
    if (!columnFilter.values?.length && !columnFilter.blanks && !columnFilter.nonBlanks) context.addIssue({ code: 'custom', path: ['columnFilters', index], message: 'A column filter needs a value, (Blanks) or (Non-blanks).' })
  })
}) satisfies z.ZodType<ActivityFilter>

export interface ActivityLiveArgs {
  /** One per table; an update replaces only the tables it names. */
  readonly filters?: readonly ActivityFilter[]
  /** The session the sessions probe's focus series follow (the Details flyout); 0 follows none. */
  readonly focusSession?: number
}

/** The live layer's `args.activity` (src/shared/live/schema.ts): bounded, strict, one filter per table. */
export const activityLiveArgsSchema = z.object({
  filters: z.array(activityFilterSchema).min(1).max(activityTables.length).optional(),
  focusSession: z.number().int().min(0).max(activityLimits.sessionId).optional()
}).strict().superRefine((args, context) => {
  const tables = args.filters?.map(filter => filter.table) ?? []
  if (new Set(tables).size !== tables.length) context.addIssue({ code: 'custom', path: ['filters'], message: 'One filter per table.' })
  if (args.filters === undefined && args.focusSession === undefined) context.addIssue({ code: 'custom', message: 'The args change nothing.' })
}) satisfies z.ZodType<ActivityLiveArgs>
// --- Session actions: activity.details and activity.kill ----------------------------------------------------------------

/** A session's login time as sys.dm_exec_sessions has it (server local time, no offset): `2026-10-22T06:50:12.347`. With
 *  the session id it identifies a session, since SQL Server reuses ids. The backend compares it at datetime precision. */
export const loginTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?$/
const loginTime = z.string().max(40).regex(loginTimePattern)
const sessionId = z.number().int().min(1).max(activityLimits.sessionId)

export interface ActivityDetailsRequest {
  readonly requestId: string
  readonly connectionId: string
  readonly sessionId: number
  readonly loginTime: string
  /** Only this text, whole (up to detailsChars), for Open in Query Editor; without it every section comes back with texts cut at detailsPreviewChars. */
  readonly text?: DetailsText
  /** Also read the session's locks (costly; the flyout's Load locks). Not with `text`. */
  readonly locks?: boolean
}
export const activityDetailsRequestSchema = z.object({
  requestId: z.uuid(), connectionId: z.uuid(), sessionId, loginTime, text: z.enum(detailsTexts).optional(), locks: z.boolean().optional()
}).strict().refine(request => !(request.text && request.locks), 'Details reads locks only with every section, not with one text.') satisfies z.ZodType<ActivityDetailsRequest>

/** A text as Details read it: `chars` is its whole length, `truncated` when `text` holds fewer. */
export interface ActivityText { readonly text: string; readonly chars: number; readonly truncated: boolean }
export interface ActivitySessionDetails {
  readonly sessionId: number
  readonly loginTime: string
  readonly isUserProcess: boolean
  readonly login: string
  readonly originalLogin?: string
  readonly hostName?: string
  readonly hostProcessId?: number
  readonly application?: string
  readonly interface?: string
  readonly netAddress?: string
  readonly transport?: string
  readonly encrypted?: boolean
  readonly authScheme?: string
  /** ReadUncommitted, ReadCommitted, RepeatableRead, Serializable, Snapshot or Unspecified. */
  readonly isolationLevel: string
  readonly database?: string
  /** The request's status, else the session's. */
  readonly status: string
  readonly command?: string
  readonly requestId?: number
  /** The session's requests (MARS sessions have several). */
  readonly requestCount: number
  readonly waitType?: string
  readonly waitTimeMs?: number
  readonly waitResource?: string
  readonly blockedBy?: number
  readonly elapsedMs?: number
  /** The session's CPU since login plus its running requests'. */
  readonly cpuMs: number
  readonly logicalReads: number
  readonly reads: number
  readonly writes: number
  readonly percentComplete?: number
  readonly dop?: number
  readonly grantedMemoryKb?: number
  readonly memoryKb: number
  readonly openTransactions: number
  readonly lastRequestStart?: string
  readonly lastRequestEnd?: string
}
export interface ActivityInputBuffer { readonly eventType?: string; readonly parameters?: number; readonly text: ActivityText }
export interface ActivitySessionWait { readonly waitType: string; readonly waitingTasks: number; readonly waitTimeMs: number; readonly maxWaitTimeMs: number; readonly signalWaitTimeMs: number }
export interface ActivityTransaction {
  readonly transactionId: number
  readonly name?: string
  readonly beginTime?: string
  /** readWrite, readOnly, system or distributed. */
  readonly type: string
  readonly state: string
  readonly userTransaction: boolean
  readonly database?: string
  readonly logBytesUsed?: number
  readonly logBytesReserved?: number
}
/** tempdb pages the session's objects and its running tasks hold now, in KB. */
export interface ActivityTempdb { readonly userObjectsKb: number; readonly internalObjectsKb: number }
export interface ActivityLock { readonly resourceType: string; readonly database?: string; readonly databaseId?: number; readonly mode: string; readonly status: string; readonly count: number }
export type ActivityErrorCode = LiveErrorCode
/** A failure as a value, as Object Explorer's are; envelope errors are only INVALID_PARAMS, NOT_CONNECTED, BUSY and CANCELLED. */
export interface ActivityError { readonly code: ActivityErrorCode; readonly message: string; readonly retryable: boolean }
export interface ActivitySectionError { readonly section: DetailsSection; readonly code: ActivityErrorCode; readonly message: string }
export interface ActivityDetailsResult {
  readonly sessionId: number
  /** present: the session the row showed. ended: no session has the id (or the login cannot see it). changed: another
   *  session has the id now; nothing else is read. unknown: `error` says why nothing could be read. */
  readonly state: 'present' | 'ended' | 'changed' | 'unknown'
  readonly session?: ActivitySessionDetails
  readonly statement?: ActivityText
  readonly batch?: ActivityText
  readonly inputBuffer?: ActivityInputBuffer
  readonly waits?: readonly ActivitySessionWait[]
  readonly transactions?: readonly ActivityTransaction[]
  readonly transactionsTruncated?: boolean
  readonly tempdb?: ActivityTempdb
  readonly locks?: readonly ActivityLock[]
  readonly locksTruncated?: boolean
  /** Sections a permission, a lock or an error kept out; the others came back. */
  readonly sectionErrors?: readonly ActivitySectionError[]
  /** The server's clock when the session was read (ISO 8601 with offset). */
  readonly readAt?: string
  readonly elapsedMs: number
  readonly error?: ActivityError
}

export interface ActivityKillSession {
  readonly sessionId: number
  readonly loginTime: string
  /** The row's Host PID; null when the session has none. */
  readonly hostProcessId: number | null
}
export interface ActivityKillRequest { readonly connectionId: string; readonly sessions: readonly ActivityKillSession[] }
export const activityKillRequestSchema = z.object({
  connectionId: z.uuid(),
  sessions: z.array(z.object({ sessionId, loginTime, hostProcessId: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable() }).strict()).min(1).max(activityLimits.killSessions)
    .refine(sessions => new Set(sessions.map(session => session.sessionId)).size === sessions.length, 'Each session may be named once.')
}).strict() satisfies z.ZodType<ActivityKillRequest>
export interface ActivityKillResult {
  /** One per session tried, in the request's order; a session missing from it was not tried (see `error`). */
  readonly results: readonly { readonly sessionId: number; readonly outcome: KillOutcome; readonly message?: string }[]
  readonly elapsedMs: number
  /** Why the rest were not tried: the connection could not open or broke, or the request ran out of time. */
  readonly error?: ActivityError
}

/** varia:activity-cancel: closing Details cancels its read by the requestId it carried. */
export const activityCancelSchema = z.object({ requestIds: z.array(z.uuid()).min(1).max(activityLimits.cancelIds) }).strict()
