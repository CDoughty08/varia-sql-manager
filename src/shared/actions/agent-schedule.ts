// SQL Server Agent schedules as the documents edit them (AG-6c, docs/agent-plan.md › Schedules, docs/agent-ui-rethink.md › rx-job-schedules,
// rx-schedule-pick, rx-schedule-remove, rx-schedules-doc): what the `agentSchedules` describe reads, the job document's schedule entries
// (in place: new, edited, picked from the shared ones, or removed with detach or delete), what the job's Save sends for them, and the
// standalone schedule save the Schedules document and New › Schedule… run (action `agentSchedule`). Bounds are zod here and C# in
// ActionService.ValidateSchedule*. The encoding, sentences and runs are in ../agent/schedule.ts. No React here.
import { z } from 'zod'
import { agentLimits, type AgentPlatform } from '../agent/catalog.ts'
import {
  effectiveEndTime, freq, normalizedTiming, sameTiming, scheduleProblems, timingKeys, validDate, validTime, type AgentMoment, type AgentScheduleFields, type AgentScheduleTiming, type ScheduleProblem, type ScheduleServer
} from '../agent/schedule.ts'
import { ident } from '../explorer/schema.ts'

/** A schedule as msdb lists it (sp_help_schedule, sp_help_jobschedule) with its owner, version and modified date from
 *  sysschedules_localserver_view. Owner is absent where the login cannot see the owner's login; version and modified are absent when
 *  the view did not list the schedule (then it cannot be changed through Varia). */
export interface AgentScheduleRecord extends AgentScheduleFields {
  readonly id: number
  /** The jobs that use it, all of them (sp_help_schedule counts sysjobschedules whoever owns the jobs). */
  readonly jobCount: number
  readonly owner?: string
  readonly version?: number
  /** yyyy-mm-ddThh:mm:ss.fff, server time. */
  readonly modified?: string
}
/** A job as the Schedules document lists it (sp_help_job; jobs in a schedule from sp_help_jobs_in_schedule), with what a guarded attach or
 *  detach names. */
export interface AgentScheduleJob { readonly id: string; readonly name: string; readonly enabled: boolean; readonly owner: string; readonly version: number }
/** A job's usual duration: the median of its last successful runs, in seconds. */
export interface AgentJobDuration { readonly jobId: string; readonly seconds: number }
/** Which job uses which schedule (sysjobschedules, sysadmin only). */
export interface AgentScheduleLink { readonly scheduleId: number; readonly jobId: string }
/** The `agentSchedules` describe (target the SQL Server Agent node). With a `schedule` id it reads only that schedule's jobs. */
export interface AgentSchedulesModel {
  readonly login: string
  readonly sysadmin: boolean
  readonly platform: AgentPlatform
  /** The server's clock when it was read, yyyy-mm-ddThh:mm:ss: next runs count from it. */
  readonly now: string
  /** sysadmin only: whether SQL Server Agent has an idle CPU condition (Agent Properties › Advanced). */
  readonly idleDefined?: boolean
  readonly schedules: readonly AgentScheduleRecord[]
  /** More schedules than agentLimits.listRows. */
  readonly truncated?: boolean
  /** The jobs msdb lets the login see (Attach a job, and names for links). */
  readonly jobs?: readonly AgentScheduleJob[]
  /** Absent below sysadmin (sysjobschedules is sysadmin's only); then a schedule's jobs are read one schedule at a time. */
  readonly links?: readonly AgentScheduleLink[]
  readonly durations?: readonly AgentJobDuration[]
  /** With a `schedule` id: its jobs (SQLAgentUserRole sees only its own). */
  readonly scheduleJobs?: readonly AgentScheduleJob[]
}

/** yyyy-mm-ddThh:mm:ss as a moment. */
export function momentOfText(text: string): AgentMoment | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(text)
  if (!match) return undefined
  return { date: Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3]), time: Number(match[4]) * 10_000 + Number(match[5]) * 100 + Number(match[6]) }
}
/** A record's fields, without its identity. */
export const scheduleFieldsOf = (record: AgentScheduleRecord): AgentScheduleFields => {
  const { id: _id, jobCount: _jobs, owner: _owner, version: _version, modified: _modified, ...fields } = record
  return fields
}
/** Whether the login owns a schedule (msdb lets only the owner and sysadmin change or delete it). An owner Varia cannot see is not the login. */
export const ownsSchedule = (record: Pick<AgentScheduleRecord, 'owner'>, login: string) => record.owner !== undefined && record.owner.toLowerCase() === login.toLowerCase()

// --- The job document's schedules ------------------------------------------------------------------------------------------

/** A schedule on the job document: one of the job's (`id`), one picked from the shared schedules in this draft (`attached`), or a new one
 *  (no `id`). `remove` marks one of the job's for Save: detach it, or detach it and delete it when no job uses it. */
export interface JobScheduleEntry {
  readonly key: string
  readonly id?: number
  readonly attached?: true
  /** A picked schedule as the pick read it: its guard and the fields its edits compare with. */
  readonly base?: AgentScheduleRecord
  readonly fields: AgentScheduleFields
  readonly remove?: 'detach' | 'delete'
}
export const scheduleKey = (id: number) => `s:${id}`
/** The job's schedules as read. */
export const initialJobSchedules = (schedules: readonly AgentScheduleRecord[] = []): JobScheduleEntry[] => schedules.map(record => ({ key: scheduleKey(record.id), id: record.id, fields: scheduleFieldsOf(record) }))
/** The entries as one comparable value (the draft's change detection). */
export const jobSchedulesValue = (entries: readonly JobScheduleEntry[]) =>
  JSON.stringify(entries.map(entry => [entry.key, entry.id ?? null, entry.attached ?? false, entry.remove ?? '', entry.fields.name, entry.fields.enabled, ...timingKeys.map(key => normalizedTiming(entry.fields)[key])]))

/** A schedule the save names with what its describe read: the guard checks both, else STALE. */
export interface AgentScheduleGuard { readonly id: number; readonly version: number; readonly modified: string }
/** What a save sets on a schedule: its name, enabled and timing (all of it whenever any of it changes). */
export interface AgentScheduleValues { readonly name?: string; readonly enabled?: boolean; readonly timing?: AgentScheduleTiming }
export interface AgentScheduleUpdate extends AgentScheduleGuard, AgentScheduleValues {}
export interface AgentScheduleDetach { readonly id: number; readonly deleteUnused: boolean }
/** The schedule part of a job's Save, run in the job's transaction in this order: detach (sp_detach_schedule, @delete_unused_schedule when
 *  chosen), attach (guard, sp_attach_schedule), update (guard, sp_update_schedule), add (sp_add_jobschedule). Attach before update: it
 *  leaves the schedule's version as it is, so a picked schedule edited in the same save passes both guards. */
export interface AgentJobSchedulesSave {
  readonly detach?: readonly AgentScheduleDetach[]
  readonly update?: readonly AgentScheduleUpdate[]
  readonly attach?: readonly AgentScheduleGuard[]
  readonly add?: readonly (Required<Pick<AgentScheduleValues, 'name' | 'enabled' | 'timing'>>)[]
}

/** A record's changes as a save sends them: the name and enabled when they differ, and every timing field whenever one differs. */
function scheduleValues(record: AgentScheduleFields, fields: AgentScheduleFields): AgentScheduleValues {
  return {
    ...fields.name.trim() !== record.name ? { name: fields.name.trim() } : {},
    ...fields.enabled !== record.enabled ? { enabled: fields.enabled } : {},
    ...!sameTiming(record, fields) ? { timing: timingOf(fields) } : {}
  }
}
/** The timing fields alone, normalized as msdb stores them. */
export function timingOf(fields: AgentScheduleTiming): AgentScheduleTiming {
  const timing = normalizedTiming(fields)
  return Object.fromEntries(timingKeys.map(key => [key, timing[key]])) as unknown as AgentScheduleTiming
}
const guardOf = (record: AgentScheduleRecord): AgentScheduleGuard | undefined => record.version !== undefined && record.modified ? { id: record.id, version: record.version, modified: record.modified } : undefined

/** The schedule part of a job's save: undefined when the entries change nothing. `records` are the job's schedules as read. */
export function jobSchedulesSave(records: readonly AgentScheduleRecord[], entries: readonly JobScheduleEntry[]): AgentJobSchedulesSave | undefined {
  const detach: AgentScheduleDetach[] = [], update: AgentScheduleUpdate[] = [], attach: AgentScheduleGuard[] = []
  const add: Required<Pick<AgentScheduleValues, 'name' | 'enabled' | 'timing'>>[] = []
  for (const entry of entries) {
    if (entry.id === undefined) { if (!entry.remove) add.push({ name: entry.fields.name.trim(), enabled: entry.fields.enabled, timing: timingOf(entry.fields) }); continue }
    const record = entry.attached ? entry.base : records.find(item => item.id === entry.id)
    if (!record) continue
    if (entry.remove) { if (!entry.attached) detach.push({ id: entry.id, deleteUnused: entry.remove === 'delete' }); continue }
    const guard = guardOf(record)
    if (entry.attached && guard) attach.push(guard)
    const values = scheduleValues(record, entry.fields)
    if (guard && Object.keys(values).length) update.push({ ...guard, ...values })
  }
  const save = { ...detach.length ? { detach } : {}, ...update.length ? { update } : {}, ...attach.length ? { attach } : {}, ...add.length ? { add } : {} }
  return Object.keys(save).length ? save : undefined
}
/** How many changes the entries make against the job's as read (`base`), for "Save · n changes": each new, picked, edited or removed schedule. */
export function jobScheduleChangeCount(base: readonly JobScheduleEntry[], entries: readonly JobScheduleEntry[]): number {
  return entries.filter(entry => {
    if (entry.id === undefined || entry.attached) return !entry.remove
    if (entry.remove) return true
    const before = base.find(item => item.key === entry.key)
    return !before || Object.keys(scheduleValues(before.fields, entry.fields)).length > 0
  }).length
}

export const jobScheduleText = {
  readOnly: (owner: string) => `Owned by ${owner}: only its owner and sysadmin can change it. Copy it for this job to change when this job runs.`,
  unknownOwner: 'Owned by another login: only its owner and sysadmin can change it. Copy it for this job to change when this job runs.',
  shared: (count: number) => `Shared: a change here changes when ${count === 1 ? 'the other job runs' : `the other ${count} jobs run`} too. To change only this job, copy the schedule first.`,
  copy: 'Copy for this job only',
  copyName: (name: string) => `${name} (copy)`.slice(0, agentLimits.nameChars),
  removed: 'removed from this job',
  detachKeep: 'Detach it and keep the schedule',
  detachDelete: 'Detach it, and delete the schedule if no other job uses it',
  removeHint: 'Happens when you save the job. msdb deletes the schedule only if no job uses it, including jobs you cannot see; otherwise it only detaches, so the save never fails on it.',
  removeOwnerOnly: 'Only the schedule\'s owner and sysadmin may delete it, so this offers detach only.',
  undoHint: 'No confirmation dialog: the choice sits on the removed schedule, and Undo restores it until the job is saved.',
  searchHint: 'Name or when it runs, for example “night” or “every 15 minutes”.',
  pickHint: 'Matches names and when they run. Schedules already on this job are left out; only ones you may use are listed.',
  noMatch: 'No shared schedule matches.',
  tooMany: `Varia adds schedules to a job only while it holds at most ${agentLimits.schedulesPerJob}.`,
  tooManyRemoved: `One save removes at most ${agentLimits.schedulesPerJob} schedules: save, then remove the rest.`,
  unguarded: 'This schedule\'s version could not be read, so it cannot be attached. Search again, or reload the job.',
  onlyYourJobs: 'Only your own jobs are listed.',
  jobsReadFailed: 'Which jobs use it could not be read.',
  attachHint: 'Attaching adds it to this job when you save; nothing changes on the server until then.',
  noneYet: 'This job has no schedule, so it runs only when started.',
  listFailed: 'The shared schedules could not be read, so only New schedule is offered.'
} as const

/** The schedule entries' problems, by entry key: errors stop Save. A job may already hold more than agentLimits.schedulesPerJob (msdb
 *  sets no limit); only adding one past it is refused. A picked schedule without the version its guard names cannot be attached. */
export function jobScheduleProblems(entries: readonly JobScheduleEntry[], now?: AgentMoment, records: readonly AgentScheduleRecord[] = [], server?: ScheduleServer): { readonly key?: string; readonly problem: ScheduleProblem }[] {
  const out: { key?: string; problem: ScheduleProblem }[] = []
  const kept = entries.filter(entry => !entry.remove)
  if (kept.length > agentLimits.schedulesPerJob && kept.some(entry => entry.id === undefined || entry.attached)) out.push({ problem: { field: 'name', severity: 'error', message: jobScheduleText.tooMany } })
  if (entries.filter(entry => entry.remove && entry.id !== undefined && !entry.attached).length > agentLimits.schedulesPerJob) out.push({ problem: { field: 'name', severity: 'error', message: jobScheduleText.tooManyRemoved } })
  for (const entry of kept) {
    if (entry.attached && (!entry.base || !guardOf(entry.base))) out.push({ key: entry.key, problem: { field: 'name', severity: 'error', message: jobScheduleText.unguarded } })
    // One of the job's own schedules as read is the server's business (made in T-SQL, perhaps by another login): only a change is checked.
    const read = !entry.attached && entry.id !== undefined ? records.find(record => record.id === entry.id) : undefined
    if (read && !Object.keys(scheduleValues(read, entry.fields)).length) continue
    for (const problem of scheduleProblems(entry.fields, now, server)) out.push({ key: entry.key, problem })
  }
  return out
}

/**
 * Reload and keep my changes for picked schedules: each takes the shared schedule as read now (`current`) as its guard, keeping the
 * fields the user changed and the schedule's new values for the rest (name, Enabled and timing each on its own). Without this a picked schedule someone changed stays STALE after
 * every reload. One no longer listed keeps its old guard, so its save still reports it.
 */
export function refreshPickedSchedules(entries: readonly JobScheduleEntry[], current: readonly AgentScheduleRecord[]): readonly JobScheduleEntry[] {
  let changed = false
  const out = entries.map(entry => {
    if (!entry.attached || !entry.base) return entry
    const base = entry.base
    const record = current.find(item => item.id === entry.id)
    if (!record || (record.version === base.version && record.modified === base.modified)) return entry
    changed = true
    return { ...entry, base: record, fields: rebaseScheduleFields(base, record, entry.fields) }
  })
  return changed ? out : entries
}

/**
 * Reload and keep my changes for the schedules: the job's schedules as read now, with the draft's own edits on top. Each schedule keeps
 * what the draft changed (name, Enabled, timing) and takes the server's values for the rest; one gone from the job since is dropped with
 * its edit or removal; picked and new entries stay.
 */
export function rebaseJobSchedules(opened: readonly AgentScheduleRecord[], current: readonly AgentScheduleRecord[], entries: readonly JobScheduleEntry[]): JobScheduleEntry[] {
  const out: JobScheduleEntry[] = []
  for (const record of current) {
    const mine = entries.find(entry => entry.id === record.id && !entry.attached)
    const before = opened.find(item => item.id === record.id)
    if (!mine || !before) { out.push(...initialJobSchedules([record])); continue }
    out.push({ ...mine, fields: rebaseScheduleFields(before, record, mine.fields) })
  }
  for (const entry of entries) if (entry.id === undefined || (entry.attached && !current.some(record => record.id === entry.id))) out.push(entry)
  return out
}

// --- The standalone schedule save (the Schedules document, New › Schedule…) ----------------------------------------------------

export const scheduleOps = ['create', 'update', 'enable', 'disable', 'delete'] as const
export type AgentScheduleOp = typeof scheduleOps[number]
/** A job a standalone save attaches the schedule to or detaches it from, guarded by the job's version_number (sysjobs_view). */
export interface AgentScheduleJobChange { readonly jobId: string; readonly version: number; readonly attach: boolean }
/**
 * The `agentSchedule` action, on the SQL Server Agent node: create (sp_add_schedule, then each attach), update (guard, sp_update_schedule
 * with what changed, then each attach or detach), enable or disable (guard, sp_update_schedule @enabled only), or delete (guard,
 * sp_delete_schedule without @force_delete, so a schedule a job uses is refused as IN_USE). One transaction.
 */
export interface AgentScheduleSave extends AgentScheduleValues {
  readonly op: AgentScheduleOp
  readonly schedule?: AgentScheduleGuard
  readonly jobs?: readonly AgentScheduleJobChange[]
}

const int = (low: number, high: number) => z.number().int().min(low).max(high)
const modifiedPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$/
const modified = z.string().max(23).regex(modifiedPattern).refine(text => { const date = new Date(text + 'Z'); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 23) === text }, 'not a date')
const scheduleId = int(1, 2_147_483_647)
/** The timing as msdb takes it: each field in the range sp_verify_schedule accepts for some type (an INT where msdb sets no upper bound on
 *  intervals and recurrence factors); the combination is checked below. */
export const scheduleTimingSchema = z.object({
  freqType: z.union(Object.values(freq).map(code => z.literal(code)) as unknown as [z.ZodLiteral<1>, z.ZodLiteral<4>]),
  freqInterval: int(0, 2_147_483_647),
  freqSubdayType: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
  freqSubdayInterval: int(0, 2_147_483_647),
  freqRelativeInterval: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
  freqRecurrenceFactor: int(0, 2_147_483_647),
  activeStartDate: z.number().int().refine(validDate, 'not a date'),
  activeEndDate: z.number().int().refine(validDate, 'not a date'),
  activeStartTime: z.number().int().refine(validTime, 'not a time'),
  activeEndTime: z.number().int().refine(validTime, 'not a time')
}).strict() satisfies z.ZodType<AgentScheduleTiming>
const guardSchema = z.object({ id: scheduleId, version: int(0, 2_147_483_647), modified }).strict() satisfies z.ZodType<AgentScheduleGuard>
const valuesShape = { name: ident.optional(), enabled: z.boolean().optional(), timing: scheduleTimingSchema.optional() }
export const jobSchedulesSaveSchema = z.object({
  detach: z.array(z.object({ id: scheduleId, deleteUnused: z.boolean() }).strict()).min(1).max(agentLimits.schedulesPerJob).optional(),
  update: z.array(guardSchema.extend(valuesShape).strict()).min(1).max(agentLimits.schedulesPerJob).optional(),
  attach: z.array(guardSchema).min(1).max(agentLimits.schedulesPerJob).optional(),
  add: z.array(z.object({ name: ident, enabled: z.boolean(), timing: scheduleTimingSchema }).strict()).min(1).max(agentLimits.schedulesPerJob).optional()
}).strict() satisfies z.ZodType<AgentJobSchedulesSave>
export const scheduleSaveSchema = z.object({
  op: z.enum(scheduleOps), schedule: guardSchema.optional(), ...valuesShape,
  jobs: z.array(z.object({ jobId: z.guid(), version: int(0, 2_147_483_647), attach: z.boolean() }).strict()).min(1).max(agentLimits.scheduleJobChanges).optional()
}).strict() satisfies z.ZodType<AgentScheduleSave>

/** Whether a timing is a combination sp_verify_schedule accepts (C#'s ScheduleTimingValid refuses the same). */
export function timingProblem(timing: AgentScheduleTiming): string | undefined {
  const t = timing
  if (t.activeEndDate < t.activeStartDate) return 'The end date is before the start date.'
  switch (t.freqType) {
    case freq.once: case freq.agentStart: case freq.idle:
      return t.freqInterval || t.freqSubdayType || t.freqSubdayInterval || t.freqRelativeInterval || t.freqRecurrenceFactor ? 'A one-time, autostart or idle schedule has no frequency.' : undefined
    case freq.daily: if (t.freqInterval < 1 || t.freqRecurrenceFactor !== 0) return 'A daily schedule runs every 1 or more days.'; break
    case freq.weekly: if (t.freqInterval < 1 || t.freqInterval > 127 || t.freqRecurrenceFactor < 1) return 'A weekly schedule names days and every how many weeks.'; break
    case freq.monthly: if (t.freqInterval < 1 || t.freqInterval > 31 || t.freqRecurrenceFactor < 1) return 'A monthly schedule names a day from 1 to 31 and every how many months.'; break
    case freq.relative: if (t.freqInterval < 1 || t.freqInterval > 10 || t.freqRelativeInterval < 1 || t.freqRecurrenceFactor < 1) return 'A relative monthly schedule names which day and every how many months.'; break
  }
  if (t.freqType !== freq.relative && t.freqRelativeInterval !== 0) return 'Only a relative monthly schedule has a relative interval.'
  if (t.freqSubdayType === 1 || t.freqSubdayType === 0) return t.freqSubdayInterval ? 'A schedule that runs once a day has no daily interval.' : undefined
  if (t.freqSubdayInterval < 1 || (t.freqSubdayType === 2 && t.freqSubdayInterval < 10)) return 'A daily interval is at least 1 (10 seconds).'
  if (t.activeStartTime === effectiveEndTime(t.activeEndTime)) return 'A repeating schedule needs different start and end times.'
  return undefined
}

/** Why a job's schedule save cannot run whatever the server says (C# refuses the same): a schedule named twice, a bad timing, an update
 *  that changes nothing, or more than agentLimits.schedulesPerJob changes in all. */
export function jobSchedulesSaveProblems(save: AgentJobSchedulesSave): string[] {
  const problems: string[] = []
  const ids = [...(save.detach ?? []).map(item => item.id), ...(save.attach ?? []).map(item => item.id)]
  if (new Set(ids).size !== ids.length) problems.push('A schedule is attached or detached twice.')
  const updated = (save.update ?? []).map(item => item.id)
  if (new Set(updated).size !== updated.length) problems.push('A schedule is updated twice.')
  if (updated.some(id => (save.detach ?? []).some(item => item.id === id))) problems.push('A detached schedule is not updated.')
  const total = (save.detach?.length ?? 0) + (save.update?.length ?? 0) + (save.attach?.length ?? 0) + (save.add?.length ?? 0)
  if (total > agentLimits.schedulesPerJob * 2) problems.push('Too many schedule changes in one save.')
  for (const item of save.update ?? []) if (item.name === undefined && item.enabled === undefined && item.timing === undefined) problems.push('A schedule update changes nothing.')
  for (const timing of [...(save.update ?? []).map(item => item.timing), ...(save.add ?? []).map(item => item.timing)]) {
    const problem = timing && timingProblem(timing)
    if (problem) problems.push(problem)
  }
  return problems
}

/** Why a standalone schedule save cannot run whatever the server says (C#'s ValidateSchedule refuses the same). */
export function scheduleSaveProblems(save: AgentScheduleSave): string[] {
  const problems: string[] = []
  const values = save.name !== undefined || save.enabled !== undefined || save.timing !== undefined
  switch (save.op) {
    case 'create':
      if (save.schedule) problems.push('A new schedule has no identity.')
      if (save.name === undefined || save.enabled === undefined || save.timing === undefined) problems.push('A new schedule names its name, enabled and timing.')
      if (save.jobs?.some(job => !job.attach)) problems.push('A new schedule has no job to detach.')
      break
    case 'update':
      if (!save.schedule) problems.push('A schedule\'s save names the version it read.')
      if (!values && !save.jobs) problems.push('There is nothing to change.')
      break
    default:
      if (!save.schedule) problems.push('The schedule is named with the version it read.')
      if (values || save.jobs) problems.push(`${save.op} takes only the schedule.`)
  }
  if (save.timing) { const problem = timingProblem(save.timing); if (problem) problems.push(problem) }
  if (save.jobs && new Set(save.jobs.map(job => job.jobId.toLowerCase())).size !== save.jobs.length) problems.push('A job is named twice.')
  return problems
}

/** The Schedules document's editor: the save for a schedule's draft (undefined when it changes nothing), or New schedule's create. */
export function scheduleDraftSave(record: AgentScheduleRecord | undefined, fields: AgentScheduleFields, jobs: readonly AgentScheduleJobChange[] = []): AgentScheduleSave | undefined {
  if (!record) return { op: 'create', name: fields.name.trim(), enabled: fields.enabled, timing: timingOf(fields), ...jobs.length ? { jobs } : {} }
  const guard = guardOf(record)
  if (!guard) return undefined
  const values = scheduleValues(record, fields)
  if (!Object.keys(values).length && !jobs.length) return undefined
  return { op: 'update', schedule: guard, ...values, ...jobs.length ? { jobs } : {} }
}

/** Keep my changes after a STALE save: the schedule as read now (`current`) with the fields the user changed from `base` (what their
 *  draft was read as) on top; what they left alone takes the new values. */
export function rebaseScheduleFields(base: AgentScheduleRecord, current: AgentScheduleRecord, fields: AgentScheduleFields): AgentScheduleFields {
  const now = scheduleFieldsOf(current)
  return {
    ...sameTiming(base, fields) ? now : { ...now, ...timingOf(fields) },
    name: fields.name.trim() !== base.name ? fields.name : now.name,
    enabled: fields.enabled !== base.enabled ? fields.enabled : now.enabled
  }
}

// --- Commands --------------------------------------------------------------------------------------------------------------

export type AgentScheduleCommandId = 'agent.schedules' | 'agent.newSchedule' | 'agent.newJobOnAgent' | 'agentSchedules.save' | 'agentSchedules.refresh' | 'agentSchedules.delete'
export interface AgentScheduleCommandEntry {
  readonly title: string
  readonly category: 'SQL Server Agent'
  readonly icon: 'agent-schedule' | 'agent-job' | 'add' | 'save' | 'refresh' | 'trash'
  readonly palette?: false
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly menus?: readonly { readonly menu: 'explorer.context' | 'explorer.new'; readonly group: string; readonly order: number; readonly mnemonic?: string; readonly title?: string; readonly when?: string }[]
}
const inSchedules = 'agentEnabled && backendReady && activeDocumentIsAgentSchedules'
const connected = 'agentEnabled && backendReady && hasConnection'
const connectFirst = 'Connect to a SQL Server whose SQL Server Agent you can see first.'
/**
 * The Schedules document's commands, all behind the release gate: Manage Schedules (the Jobs folder's menu, as SSMS, and the palette)
 * opens the Schedules document that replaces SSMS's Manage Schedules dialog; New Schedule… (the Agent node's New ›, and the palette)
 * opens it with a new schedule in its editor. The Agent node's New › Job… is New Job under a command of its own, since macOS's context
 * menus show placements by command id and agent.newJob's own placement would show beside the submenu (the palette has New Job…). Save, Refresh and Delete act on the Schedules document whose toolbar runs them, else the
 * active one.
 */
export function agentScheduleCommandEntries(): { readonly [K in AgentScheduleCommandId]: AgentScheduleCommandEntry } {
  return {
    'agent.schedules': {
      title: 'Manage Schedules', category: 'SQL Server Agent', icon: 'agent-schedule', keywords: ['agent', 'schedule', 'schedules', 'shared', 'timing', 'sqlserveragent'],
      precondition: connected, unavailableHint: connectFirst,
      menus: [{ menu: 'explorer.context', group: '1_monitor', order: 3, mnemonic: 'm', when: "explorerNode == 'folder' && explorerFolder == 'agentJobs' && !explorerServerLost" }]
    },
    'agent.newSchedule': {
      title: 'New Schedule…', category: 'SQL Server Agent', icon: 'add', keywords: ['agent', 'schedule', 'create', 'add', 'sqlserveragent'],
      precondition: connected, unavailableHint: connectFirst,
      menus: [{ menu: 'explorer.new', group: '2_agent', order: 5, mnemonic: 's', title: 'Schedule…', when: "explorerNode == 'agent' && !explorerServerLost" }]
    },
    'agent.newJobOnAgent': {
      title: 'Job…', category: 'SQL Server Agent', icon: 'agent-job', palette: false, keywords: ['agent', 'job', 'create', 'add', 'sqlserveragent'],
      precondition: connected, unavailableHint: connectFirst,
      menus: [{ menu: 'explorer.new', group: '2_agent', order: 1, mnemonic: 'j', when: "explorerNode == 'agent' && !explorerServerLost" }]
    },
    'agentSchedules.save': { title: 'Save Schedule', category: 'SQL Server Agent', icon: 'save', keywords: ['agent', 'schedule', 'apply', 'update'], precondition: inSchedules, unavailableHint: 'Change the selected schedule first; a read-only schedule cannot be saved.' },
    'agentSchedules.refresh': { title: 'Refresh Schedules', category: 'SQL Server Agent', icon: 'refresh', keywords: ['agent', 'schedule', 'reload', 'read'], precondition: inSchedules, unavailableHint: 'Open Manage Schedules first.' },
    'agentSchedules.delete': { title: 'Delete Schedule', category: 'SQL Server Agent', icon: 'trash', keywords: ['agent', 'schedule', 'remove', 'drop'], precondition: inSchedules, unavailableHint: 'Select a schedule you own (sysadmin: any) first.' }
  }
}
export const agentSchedulesTabName = 'Schedules'
