import { z } from 'zod'

/**
 * Re-attaching to BigQuery jobs (docs/bigquery.md, Re-attaching to jobs): the job key every BigQuery query tab carries, the
 * job references and records main keeps in WorkbenchSession/jobs.json, query.attach's parameters, and the main-only
 * methods that end idle sessions and cancel jobs without a connection. C# holds the same bounds (BigQueryJobLimits).
 */
export const jobLimits = {
  /** BigQuery's job ids, and the connection model's location and project bounds. */
  jobId: 1024, location: 64, project: 128,
  /** Records per tab (job key) and in all; past them the oldest finished records go first. */
  perKey: 64, records: 1024,
  /** Job keys bigquery.endIdleSessions and session.cancelRestoredJobs take; jobs bigquery.cancelJobs cancels at once. */
  keys: 1024, cancel: 64,
  /** A record expires this long after main first heard of its job (about when it was created): the result table's lifetime. */
  lifetimeMs: 24 * 60 * 60 * 1000
} as const

export const jobKeySchema = z.uuid()
export const jobIdSchema = z.string().min(1).max(jobLimits.jobId).regex(/^[\w-]+$/)
export const jobLocationSchema = z.string().min(1).max(jobLimits.location).regex(/^[A-Za-z\d-]+$/)
export const jobProjectSchema = z.string().min(1).max(jobLimits.project).regex(/^(?:[a-z\d][a-z\d.-]{0,61}[a-z\d]:)?[a-z][a-z\d-]{4,28}[a-z\d]$/)
export const jobTransactionSchema = z.enum(['none', 'open', 'unknown'])
export type JobTransaction = z.infer<typeof jobTransactionSchema>

/** A job as a tab's references and the restore payload name it: no credentials, no SQL text. */
export const jobReferenceSchema = z.object({ jobId: jobIdSchema, location: jobLocationSchema.optional(), project: jobProjectSchema }).strict()
export type JobReference = z.infer<typeof jobReferenceSchema>

/** query.attach's parameters (docs/ipc.md): the tab, its job key and the job; `adoptSession` takes over the job's session
 *  with the record's `transaction`; `detached` only holds the session's queue until DONE and reads no results. */
export const queryAttachParamsSchema = z.object({
  connectionId: z.uuid(), sessionId: z.uuid(), queryId: z.uuid(), jobKey: jobKeySchema, jobId: jobIdSchema, project: jobProjectSchema, location: jobLocationSchema.optional(),
  maxRows: z.number().int().min(0).max(2_147_483_647), maxResultSets: z.number().int().min(1).max(1000), adoptSession: z.boolean(),
  transaction: jobTransactionSchema.optional(), detached: z.boolean().optional(), residence: z.enum(['automatic', 'memory', 'windowed']).optional(),
  windowCacheMiB: z.number().int().min(16).max(4096).optional(), prices: z.boolean().optional()
}).strict()
export type QueryAttachParams = z.infer<typeof queryAttachParamsSchema>

/**
 * One record in WorkbenchSession/jobs.json: a BigQuery request's top-level job under its tab's job key, with the saved
 * profile it ran on (absent for an ad-hoc connection), when main first heard of it, whether it is still running, auxiliary
 * (reserved: no job event sets it yet) or detached (Leave it running on Close Results), and the session's tracked transaction as
 * it started (decision 54). No secrets and no SQL text: a job id is useless without the principal's credentials.
 */
export const jobRecordSchema = z.object({
  jobKey: jobKeySchema, jobId: jobIdSchema, project: jobProjectSchema, location: jobLocationSchema.optional(), profileId: z.string().min(1).max(128).optional(),
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), state: z.enum(['running', 'done']), auxiliary: z.boolean(), detached: z.boolean().optional(),
  transaction: jobTransactionSchema
}).strict()
export type JobRecord = z.infer<typeof jobRecordSchema>
/** A tab's job as a restore hands it back (hot exit or AutoRecover): its record without the key or profile, newest last.
 *  Auxiliary jobs are left out, since a sort or filter outlives no tab state. */
export type RestoredJob = Pick<JobRecord, 'jobId' | 'project' | 'location' | 'state' | 'transaction' | 'detached' | 'createdAt'>
export function restoredJobs(records: readonly JobRecord[]): RestoredJob[] {
  return records.filter(record => !record.auxiliary).sort((a, b) => a.createdAt - b.createdAt)
    .map(({ jobId, project, location, state, transaction, detached, createdAt }) => ({ jobId, project, ...location ? { location } : {}, state, transaction, ...detached ? { detached } : {}, createdAt }))
}
export const jobRecordsFileSchema = z.object({ version: z.literal(1), records: z.array(jobRecordSchema).max(jobLimits.records) }).strict()
export type JobRecordsFile = z.infer<typeof jobRecordsFileSchema>

/** bigquery.endIdleSessions' answer: the idle sessions whose ABORT_SESSION failed. */
export const endIdleResultSchema = z.object({ failedAborts: z.number().int().min(0).max(2 ** 31 - 1) }).strict()
const noteSchema = z.object({
  code: z.enum(['commitNotApplied', 'committedBeforeCancel', 'outcomeUnknown', 'abortFailed', 'sessionExpired']),
  message: z.string().max(2001).optional(), jobId: z.string().min(1).max(jobLimits.jobId).optional()
}).strict()
/** bigquery.cancelJobs' answer: per job, whether jobs.cancel was accepted, what the close found, or BigQuery's refusal. */
export const cancelJobsResultSchema = z.object({
  jobs: z.array(z.object({ jobId: jobIdSchema, cancelled: z.boolean(), note: noteSchema.optional(), error: z.string().max(16_385).optional() }).strict()).max(jobLimits.cancel)
}).strict()
export type CancelJobsResult = z.infer<typeof cancelJobsResultSchema>
/** Cancelling jobs from their records (session.cancelRestoredJobs, the records dialog, deleting a profile): each job's
 *  outcome, and the jobs whose profile cannot cancel without a connection (an ad-hoc connection, a key file picked for one
 *  run), listed by id for BigQuery's job history. */
export interface RecordedJobsCancel { readonly jobs: CancelJobsResult['jobs']; readonly uncancellable: readonly string[] }
/** The records dialog's outcome: what was asked about, what Cancel Jobs did, and the jobs Show in Job History lists, by project. */
export interface JobsWithoutTabReview {
  readonly answer: 'cancel' | 'keep' | 'show'; readonly jobIds: readonly string[]; readonly cancel?: RecordedJobsCancel
  readonly show?: readonly JobsShowProject[]
}
/**
 * One project's jobs for Show in Job History. A project the page has no connection to names the saved connection that
 * opens it (`profileId`: the newest of its records whose profile still exists), or says why it cannot be shown.
 */
export interface JobsShowProject {
  readonly project: string; readonly jobs: readonly { readonly jobId: string; readonly location?: string }[]
  readonly profileId?: string; readonly unavailable?: string
}
/** What the records dialog offers the page: Show in Job History only when some project can be shown (connected or with a saved connection). */
export const jobsWithoutTabRequestSchema = z.object({ keys: z.array(jobKeySchema).max(jobLimits.keys), liveProjects: z.array(jobProjectSchema).max(jobLimits.keys) }).strict()
export type JobsWithoutTabRequest = z.infer<typeof jobsWithoutTabRequestSchema>
export const jobsUnavailableText = (project: string, unreadable = false) => unreadable
  ? `Varia could not read the saved connections, so it cannot connect to BigQuery project ${project} for you. Connect to ${project} to see its jobs in Job History.`
  : `The saved connection that started the jobs in BigQuery project ${project} was removed. Connect to ${project} to see them in Job History.`
/** Show in Job History's jobs, grouped by their billing project, at most 64 a project (Job History's pinned jobs). Without
 *  `profiles` (the saved connections' ids, each with its project; null when they could not be read) and `live` (the page's
 *  connected projects), every project is just listed. A saved connection since edited to another project is not used. */
export function jobsByProject(records: readonly (Pick<JobRecord, 'jobId' | 'project' | 'location'> & Partial<Pick<JobRecord, 'profileId' | 'createdAt'>>)[], profiles?: ReadonlyMap<string, string> | null, live?: ReadonlySet<string>): JobsShowProject[] {
  const projects = new Map<string, { jobs: { jobId: string; location?: string }[]; profileId?: string; newest: number }>()
  for (const record of records) {
    const entry = projects.get(record.project) ?? { jobs: [], newest: -1 }
    if (entry.jobs.length < 64) entry.jobs.push({ jobId: record.jobId, ...record.location ? { location: record.location } : {} })
    if (record.profileId && profiles?.get(record.profileId) === record.project && (record.createdAt ?? 0) > entry.newest) { entry.profileId = record.profileId; entry.newest = record.createdAt ?? 0 }
    projects.set(record.project, entry)
  }
  return [...projects].map(([project, { jobs, profileId }]) => {
    if (profiles === undefined || live?.has(project)) return { project, jobs }
    return profileId ? { project, jobs, profileId } : { project, jobs, unavailable: jobsUnavailableText(project, profiles === null) }
  })
}
