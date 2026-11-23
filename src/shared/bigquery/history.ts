// BigQuery's Job History (docs/bigquery.md, Job History): the `bigquery.jobs` live source's args, bigquery.jobs.get and
// bigquery.jobs.cancel with their bounds (zod here, C# in BigQueryJobHistory.Check), and the pure rules the document follows:
// the qualified job id, the console link, and what each row action may do. The backend lists and
// derives the jobs (BigQuery/BigQueryService.History.cs); this decides only what the renderer sends and shows. No React here.
import { z } from 'zod'
import { jobIdSchema, jobLimits, jobLocationSchema, jobProjectSchema } from './jobs'
import {
  jobHistoryDefaultHours, jobHistoryLimits, jobHistoryRanges, jobHistoryStates, jobHistoryTypes, type JobHistoryState, type JobHistoryType
} from './history-catalog'

export * from './history-catalog'

/** A job a view names: its id and, when known, its location (jobs.get outside the US and EU multi-regions needs it). */
export const historyJobRefSchema = z.object({ jobId: jobIdSchema, location: jobLocationSchema.optional() }).strict()
export type HistoryJobRef = z.infer<typeof historyJobRefSchema>
const statementSchema = z.string().min(1).max(jobHistoryLimits.statementChars).regex(/^[A-Z_]+$/)
const epochMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const unique = <T>(key: (item: T) => string) => (items: readonly T[]) => new Set(items.map(key)).size === items.length
const retentionMs = jobHistoryLimits.retentionDays * 24 * 60 * 60 * 1000

/**
 * `bigquery.jobs`'s args, the document's scope and filters. `scope` mine lists the principal's jobs; all lists the project's
 * (`allUsers`). The time range is `hours` back from now or a custom `from`/`to` (epoch ms, at most 180 days apart; the backend
 * also keeps `from` within BigQuery's 180-day retention). `states`, `types` and `statements` keep only those (absent: all);
 * `varia` keeps jobs Varia started; `jobs` pins the view to named jobs (a Messages link, records without a tab), read whatever
 * their age; `expand` lists the scripts whose children the grid shows under them; `prices` writes the Cost column (Show cost
 * as Bytes only leaves it empty). Each args replaces the last whole; a change of scope or filters lists again from scratch.
 */
export const jobHistoryArgsSchema = z.object({
  scope: z.enum(['mine', 'all']),
  hours: z.literal(jobHistoryRanges.map(range => range.hours)).optional(),
  from: epochMs.optional(), to: epochMs.optional(),
  states: z.array(z.enum(jobHistoryStates)).min(1).max(jobHistoryStates.length).refine(unique<string>(state => state), 'A state is named once.').optional(),
  types: z.array(z.enum(jobHistoryTypes)).min(1).max(jobHistoryTypes.length).refine(unique<string>(type => type), 'A type is named once.').optional(),
  statements: z.array(statementSchema).min(1).max(jobHistoryLimits.statements).refine(unique<string>(statement => statement), 'A statement type is named once.').optional(),
  varia: z.literal(true).optional(),
  jobs: z.array(historyJobRefSchema).min(1).max(jobHistoryLimits.pinned).refine(unique<HistoryJobRef>(job => job.jobId), 'A job is named once.').optional(),
  expand: z.array(historyJobRefSchema).min(1).max(jobHistoryLimits.expanded).refine(unique<HistoryJobRef>(job => job.jobId), 'A script is expanded once.').optional(),
  prices: z.boolean().optional()
}).strict()
  .refine(args => !(args.hours !== undefined && (args.from !== undefined || args.to !== undefined)), 'A range is hours or from and to, not both.')
  .refine(args => (args.from === undefined) === (args.to === undefined), 'A custom range names from and to.')
  .refine(args => args.from === undefined || args.to === undefined || args.from < args.to && args.to - args.from <= retentionMs, 'A custom range is at most 180 days.')
export type JobHistoryArgs = z.infer<typeof jobHistoryArgsSchema>

/** bigquery.jobs.get and bigquery.jobs.cancel: one job of the connection's billing project. */
export const jobHistoryJobParamsSchema = z.object({ connectionId: z.uuid(), jobId: jobIdSchema, location: jobLocationSchema.optional() }).strict()
export type JobHistoryJobParams = z.infer<typeof jobHistoryJobParamsSchema>
/** bigquery.jobs.get's parameters: `allUsers` lists another user's script's children with allUsers. */
export const jobHistoryGetParamsSchema = jobHistoryJobParamsSchema.extend({ allUsers: z.boolean().optional() }).strict()
export type JobHistoryGetParams = z.infer<typeof jobHistoryGetParamsSchema>

const line = (max: number) => z.string().max(max)
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
/** The details pane's full SQL: the Search Objects pane's shownChars, BigQuery's own 1 MB query limit. */
export const jobHistoryDetailsChars = 1_000_000
/** A job's error: BigQuery's reason, its message and where it points (a [line:column] in the message, or a location field). */
export const jobHistoryErrorSchema = z.object({ reason: line(64).optional(), message: line(16_384), location: line(1024).optional() }).strict()
const stateSchema = z.enum(jobHistoryStates)
const typeSchema = z.enum([...jobHistoryTypes, 'other'])
/** A script's child as the details pane lists it, in statement order. */
export const jobHistoryChildSchema = z.object({
  jobId: jobIdSchema, location: jobLocationSchema.optional(), state: stateSchema, statement: statementSchema.optional(), created: epochMs.optional(),
  durationMs: count.optional(), processed: count.optional(), billed: count.optional(), slotMs: count.optional(), cacheHit: z.boolean().optional(),
  sql: line(jobHistoryLimits.previewChars).optional(), error: line(jobHistoryLimits.errorChars).optional(), hidden: z.boolean()
}).strict()
export type JobHistoryChild = z.infer<typeof jobHistoryChildSchema>
/**
 * bigquery.jobs.get's answer: the job as jobs.get reads it, and a script's children (jobs.list?parentJobId, at most
 * jobHistoryLimits.children; `childrenMore` says more exist). `hidden`: BigQuery left out the job's configuration, as it does
 * for another user's job without bigquery.jobs.listAll; the pane then shows only what came back.
 */
export const jobHistoryDetailsSchema = z.object({
  job: z.object({
    jobId: jobIdSchema, project: jobProjectSchema, location: jobLocationSchema.optional(), state: stateSchema, type: typeSchema, statement: statementSchema.optional(),
    user: line(320).optional(), created: epochMs.optional(), started: epochMs.optional(), ended: epochMs.optional(),
    sql: line(jobHistoryDetailsChars).optional(), sqlTruncated: z.boolean().optional(),
    dataset: line(2048).optional(), destination: line(2048).optional(), maximumBytesBilled: count.optional(), session: z.boolean().optional(),
    labels: z.array(z.object({ key: line(63), value: line(63) }).strict()).max(64),
    processed: count.optional(), billed: count.optional(), slotMs: count.optional(), cacheHit: z.boolean().optional(), rowsAffected: count.optional(),
    error: jobHistoryErrorSchema.optional(), parentJobId: jobIdSchema.optional(), childCount: count.optional(), varia: z.boolean(), hidden: z.boolean()
  }).strict(),
  children: z.array(jobHistoryChildSchema).max(jobHistoryLimits.children),
  childrenMore: z.boolean().optional(),
  /** The children could not be read (a refusal or a failure); the job itself was. */
  childrenError: line(2000).optional()
}).strict()
export type JobHistoryDetails = z.infer<typeof jobHistoryDetailsSchema>
/** bigquery.jobs.cancel's answer: BigQuery accepted the request (it answers at once; the job ends shortly) and the state it
 *  reported then. */
export const jobHistoryCancelResultSchema = z.object({ cancelled: z.boolean(), state: stateSchema.optional() }).strict()
export type JobHistoryCancelResult = z.infer<typeof jobHistoryCancelResultSchema>

/** The fully qualified job id BigQuery's tools and Varia's Messages use: `project:LOCATION.job_id` (SqlService.JobName). */
export function qualifiedJobId(project: string, jobId: string, location?: string): string { return `${project}:${location ? location + '.' : ''}${jobId}` }

/**
 * The job's address in the BigQuery console, which Varia copies as text and never opens. Google does not document the
 * console's URL format: this is the form the console itself links jobs with (tests pin it), so Copy Job ID is always
 * offered beside it.
 */
export function consoleJobLink(project: string, jobId: string, location?: string): string {
  const query = new URLSearchParams({ project, j: `bq:${location ?? 'US'}:${jobId}`, page: 'queryresults' })
  return `https://console.cloud.google.com/bigquery?${query.toString()}`
}

/** The document's filters as it holds them, and the args they send. */
export interface JobHistoryFilters {
  readonly scope: 'mine' | 'all'
  readonly hours?: 1 | 24 | 168 | 720
  readonly custom?: { readonly from: number; readonly to: number }
  readonly states: readonly JobHistoryState[]
  readonly types: readonly JobHistoryType[]
  readonly statements: readonly string[]
  readonly varia: boolean
  readonly jobs?: readonly HistoryJobRef[]
}
export const defaultJobHistoryFilters: JobHistoryFilters = { scope: 'mine', hours: jobHistoryDefaultHours, states: [], types: [], statements: [], varia: false }

/** The args a document's filters, expanded scripts and price setting send: only what applies, each within the schema's bounds. */
export function jobHistoryArgs(filters: JobHistoryFilters, expanded: readonly HistoryJobRef[], prices: boolean): JobHistoryArgs {
  const range = filters.custom ? { from: filters.custom.from, to: filters.custom.to } : { hours: filters.hours ?? jobHistoryDefaultHours }
  return {
    scope: filters.scope, ...range,
    ...filters.states.length && filters.states.length < jobHistoryStates.length ? { states: [...new Set(filters.states)] } : {},
    ...filters.types.length && filters.types.length < jobHistoryTypes.length ? { types: [...new Set(filters.types)] } : {},
    ...filters.statements.length ? { statements: [...new Set(filters.statements)].slice(0, jobHistoryLimits.statements) } : {},
    ...filters.varia ? { varia: true as const } : {},
    ...filters.jobs?.length ? { jobs: dedupe(filters.jobs).slice(0, jobHistoryLimits.pinned) } : {},
    ...expanded.length ? { expand: dedupe(expanded).slice(-jobHistoryLimits.expanded) } : {},
    prices
  }
}
const dedupe = (jobs: readonly HistoryJobRef[]): HistoryJobRef[] => [...new Map(jobs.map(job => [job.jobId, job])).values()]

/** The statement filter's text ("select, merge") as statement types: upper-cased, those BigQuery could name, each once, at
 *  most jobHistoryLimits.statements. */
export function parseStatements(text: string): string[] {
  const kept = new Set<string>()
  for (const word of text.slice(0, 2048).split(/[\s,;]+/)) {
    const statement = word.toUpperCase()
    if (statementSchema.safeParse(statement).success) kept.add(statement)
    if (kept.size === jobHistoryLimits.statements) break
  }
  return [...kept]
}

/** A custom range as the schema takes it: from before to, at most 180 days long and starting no earlier than BigQuery's
 *  retention; undefined when it cannot be one (the field keeps the range that applies). */
export function customRange(from: number, to: number, now: number): { from: number; to: number } | undefined {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined
  const start = Math.max(Math.round(from), now - retentionMs, 0), end = Math.min(Math.round(to), Number.MAX_SAFE_INTEGER)
  return start < end && end - start <= retentionMs ? { from: start, to: end } : undefined
}

/** How many filters Clear Filters resets: the range (from its default), states, types, statements, Varia only and pinned jobs. */
export const jobHistoryActiveFilters = (filters: JobHistoryFilters): number =>
  (filters.custom || (filters.hours ?? jobHistoryDefaultHours) !== jobHistoryDefaultHours ? 1 : 0) + (filters.states.length ? 1 : 0) + (filters.types.length ? 1 : 0)
  + (filters.statements.length ? 1 : 0) + (filters.varia ? 1 : 0) + (filters.jobs?.length ? 1 : 0)

/** A grid row as the document's actions read it (the probe's identity columns). */
export interface JobHistoryRow {
  readonly jobId: string
  readonly location?: string
  readonly state: JobHistoryState
  readonly type: JobHistoryType | 'other'
  readonly statement?: string
  readonly user?: string
  readonly created?: string
  readonly parentJobId?: string
  readonly mine: boolean
  readonly hidden: boolean
  readonly children: number
}
export type JobHistoryAction = 'openResults' | 'reattach' | 'openSql' | 'rerun' | 'cancel' | 'copyId' | 'copyLink' | 'details'
/** Whether an action applies to a row, and if not, why (the menu's tooltip). Open Results and Re-attach read the job's
 *  anonymous result table, which only its creator may; Cancel needs a running or pending job and, for another user's, the
 *  permission the connection has not been refused; Open SQL and Re-run need the SQL BigQuery may hide. */
export function jobHistoryActionState(action: JobHistoryAction, row: JobHistoryRow, refused: { readonly cancel?: string; readonly get?: string }): { enabled: boolean; reason?: string } {
  const open = row.state === 'running' || row.state === 'pending'
  const others = 'Only the job\'s creator can read its result table.'
  switch (action) {
    case 'openResults':
      if (!row.mine) return { enabled: false, reason: others }
      if (row.type !== 'query') return { enabled: false, reason: 'Only a query job has results to open.' }
      if (open) return { enabled: false, reason: 'The job is still running: Re-attach to follow it.' }
      if (row.state !== 'done') return { enabled: false, reason: 'The job did not finish, so it has no results.' }
      return { enabled: true }
    case 'reattach':
      if (!row.mine) return { enabled: false, reason: others }
      if (row.type !== 'query') return { enabled: false, reason: 'Only a query job can be re-attached.' }
      if (!open) return { enabled: false, reason: 'The job has finished: Open Results instead.' }
      if (row.parentJobId) return { enabled: false, reason: 'Re-attach to the script, not one of its statements.' }
      return { enabled: true }
    case 'openSql':
    case 'rerun':
      if (row.type !== 'query') return { enabled: false, reason: 'Only a query job has SQL.' }
      if (row.hidden) return { enabled: false, reason: 'BigQuery hides this job\'s details.' }
      if (!row.mine && refused.get) return { enabled: false, reason: refused.get }
      if (row.parentJobId && action === 'rerun') return { enabled: false, reason: 'Re-run the script, not one of its statements.' }
      return { enabled: true }
    case 'cancel':
      if (!open) return { enabled: false, reason: 'Only a running or pending job can be cancelled.' }
      if (!row.mine && refused.cancel) return { enabled: false, reason: refused.cancel }
      return { enabled: true }
    default:
      return { enabled: true }
  }
}

/** "Cancel job varia_1f2e… started by ana@example.com 12 minutes ago?": the cancel prompt's question. */
export function cancelQuestion(row: Pick<JobHistoryRow, 'jobId' | 'user' | 'mine'>, startedAgo?: string): string {
  const id = row.jobId.length > 40 ? row.jobId.slice(0, 39) + '…' : row.jobId
  const by = row.mine ? '' : row.user ? ` started by ${row.user}` : ' started by another user'
  return `Cancel job ${id}${by}${startedAgo ? ` ${startedAgo}` : ''}?`
}

/** "12 minutes ago": how long ago a job was created, for the cancel prompt. */
export function agoText(createdMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - createdMs) / 1000))
  if (seconds < 60) return seconds <= 1 ? 'just now' : `${seconds} seconds ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  return `${Math.round(hours / 24)} days ago`
}

/** Main's and the backend's bounds on the job reference (jobLimits), repeated here for the docs. */
export const jobHistoryReferenceLimits = { jobId: jobLimits.jobId, location: jobLimits.location } as const
