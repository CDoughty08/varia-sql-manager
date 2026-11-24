// SQL Server Agent's overview and health checks (AG-15, docs/sql-server-agent.md › Agent overview; mock `rx-agent-overview`): the
// `agent.overview` live source's ids, the facts its one probe sends (Agent/AgentOverviewReader.cs gathers them; nothing here runs SQL),
// the pure rules that turn those facts into checks and tiles, and the document's commands. Every check is a read; each fix opens an
// existing editor, document or confirmation, so the overview adds no write of its own.
import { recommendedAlertStates } from '../actions/agent-alert.ts'
import { mailProblem } from '../actions/agent-job.ts'
import { agentGateOpen, runningExecutionStatuses, type AgentPlatform } from './catalog.ts'
import { agentAvailability, agentBanner, startupDisabled, type AgentAvailability } from './jobs.ts'

export const agentOverviewSource = 'agent.overview' as const
export const agentOverviewProbe = 'agent.overview.read' as const

/** The reads the probe records, in order (Agent/AgentOverviewReader.cs Reads). */
export const overviewReads = ['facts', 'state', 'clock', 'jobs', 'properties', 'alerts', 'profiles', 'owners', 'history', 'schedules', 'mail', 'service'] as const
export type OverviewRead = typeof overviewReads[number]
/** A read's outcome: read (`ok`), not run below sysadmin (`role`), not run on this platform (`platform`), or the live error code it failed with. */
export interface OverviewReadState { readonly state: string; readonly message?: string; readonly truncated?: boolean }

/** `sp_help_job`'s notify levels: 2 on failure, 3 on completion; 0 never and 1 on success notify no one of a failure. */
const failureLevels = [2, 3]
/** A job's owner's login, from the owners read: 0 can log in, 1 disabled, 2 no login has the owner's SID, 3 denied CONNECT SQL. */
export const ownerStates = { ok: 0, disabled: 1, missing: 2, denied: 3 } as const

export interface OverviewJob {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly owner: string
  readonly category: string
  /** `last_run_outcome`: 0 failed, 1 succeeded, 3 canceled, 5 unknown. */
  readonly outcome?: number
  /** The last run's start, server local (yyyy-mm-ddThh:mm:ss); absent when it never ran. */
  readonly lastRun?: string
  readonly status?: number
  readonly notifyEmail: number
  readonly notifyPage: number
  readonly notifyNetsend: number
  readonly scheduled: boolean
  /** Absent where the owners read did not run or did not list the job. */
  readonly ownerState?: number
  /** Absent where the history read did not run. */
  readonly historyRows?: number
  readonly historyRuns?: number
  readonly historyOldest?: string
}
export interface OverviewAlert { readonly name: string; readonly enabled: boolean; readonly messageId: number; readonly severity: number; readonly lastOccurred?: string; readonly notifies: boolean }
export interface OverviewSchedule { readonly id: number; readonly name: string; readonly enabled: boolean; readonly jobs: number }

/** One sample's facts. Undefined members were not read (refused, not run, or not on this server). */
export interface OverviewFacts {
  readonly platform?: AgentPlatform
  readonly productVersion?: string
  readonly sysadmin?: boolean
  readonly agentXps?: number
  readonly serviceState?: number
  readonly startupType?: number
  readonly serviceAccount?: string
  readonly serverNow?: string
  readonly historyMaxRows?: number
  readonly historyMaxRowsPerJob?: number
  readonly mailXps?: number
  readonly mailProfiles?: number
  readonly useDatabaseMail?: number
  readonly agentProfile?: string
  readonly agentProfileFound?: number
  readonly jobs: readonly OverviewJob[]
  readonly alerts: readonly OverviewAlert[]
  readonly schedules: readonly OverviewSchedule[]
  readonly reads: Partial<Record<OverviewRead, OverviewReadState>>
}

const numberStatuses = ['agentXps', 'serviceState', 'startupType', 'historyMaxRows', 'historyMaxRowsPerJob', 'mailXps', 'mailProfiles', 'useDatabaseMail', 'agentProfileFound'] as const
/** The status values a sample carries, as facts (the tables are added by the caller from their rows). */
export function overviewStatus(status: readonly { readonly id: string; readonly value: number | string }[]): Omit<OverviewFacts, 'jobs' | 'alerts' | 'schedules' | 'reads'> {
  const value = (id: string) => status.find(item => item.id === id)?.value
  const text = (id: string) => { const found = value(id); return typeof found === 'string' && found ? found : undefined }
  const facts: Record<string, unknown> = {}
  for (const id of numberStatuses) { const found = value(id); if (typeof found === 'number') facts[id] = found }
  const platform = text('platform')
  if (platform === 'windows' || platform === 'linux' || platform === 'managedInstance') facts.platform = platform
  const sysadmin = value('isSysadmin')
  if (typeof sysadmin === 'number') facts.sysadmin = sysadmin === 1
  for (const id of ['productVersion', 'serviceAccount', 'serverNow', 'agentProfile'] as const) { const found = text(id); if (found) facts[id] = found }
  return facts as Omit<OverviewFacts, 'jobs' | 'alerts' | 'schedules' | 'reads'>
}

/** A server-local stamp (yyyy-mm-ddThh:mm:ss) as milliseconds on one clock; only differences between two of them mean anything. */
export function stampMs(stamp: string | undefined): number | undefined {
  const match = stamp ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(stamp) : null
  if (!match) return undefined
  const [, y, mo, d, h, mi, s] = match.map(Number)
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!)
}
const hourMs = 3_600_000, dayMs = 24 * hourMs
/** How long a span is, in words: "less than an hour", "about 12 hours", "about 3 days". */
export function spanText(ms: number): string {
  if (ms < hourMs) return 'less than an hour'
  if (ms < 48 * hourMs) { const hours = Math.round(ms / hourMs); return `about ${hours} hour${hours === 1 ? '' : 's'}` }
  return `about ${Math.round(ms / dayMs)} days`
}
const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
/** Names in a sentence: "A", "A and B", "A, B and 3 more". */
export function namesText(names: readonly string[], shown = 3): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length <= shown) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`
}

// --- Checks ----------------------------------------------------------------------------------------------------------

export type OverviewCheckId = 'service' | 'failedJobs' | 'owners' | 'notify' | 'history' | 'alerts' | 'mail' | 'schedules'
/** error and warning need attention, info is worth knowing, ok passed, unread could not be checked by this login or on this server. */
export type OverviewSeverity = 'error' | 'warning' | 'info' | 'ok' | 'unread'
/** What a check's button does; the renderer runs each through an existing surface (no write of the overview's own). */
export type OverviewFix =
  | { readonly kind: 'failedJobs' }
  | { readonly kind: 'changeOwner'; readonly jobs: readonly { readonly id: string; readonly name: string; readonly owner: string }[] }
  | { readonly kind: 'notifications'; readonly job: string }
  | { readonly kind: 'agentProperties' }
  | { readonly kind: 'recommendedAlerts' }
  | { readonly kind: 'schedules' }
  | { readonly kind: 'startAgent' }
export interface OverviewObject { readonly kind: 'job' | 'schedule'; readonly name: string }
export interface OverviewCheck {
  readonly id: OverviewCheckId
  readonly severity: OverviewSeverity
  readonly title: string
  readonly detail: string
  /** The objects it names, each a link (a job opens its document, a schedule the Schedules document). */
  readonly objects: readonly OverviewObject[]
  readonly fix?: { readonly label: string; readonly action: OverviewFix }
}
export const overviewCheckTitles: { readonly [C in OverviewCheckId]: string } = {
  service: 'SQL Server Agent service', failedJobs: 'Failed jobs', owners: 'Job owners', notify: 'Failure notifications', history: 'History retention',
  alerts: 'Recommended alerts', mail: 'Agent mail', schedules: 'Unused schedules'
}
/** A failed job counts when its last run started within this window of the server's clock. */
export const failedWindowMs = dayMs
/** History that covers less than this for a job whose history is at a cap is flagged. */
export const historyWindowMs = 7 * dayMs
/** An alert fired "this week" when it last occurred within this window. */
export const alertWeekMs = 7 * dayMs

/** Why a check could not be read, by its read's state. */
export function unreadText(read: OverviewReadState | undefined, what: string): string {
  if (!read) return `Varia has not read ${what} yet.`
  if (read.state === 'role') return `Only sysadmin can read ${what}; this login sees the checks its role can read.`
  if (read.state === 'platform') return `SQL Server Agent on this server has no ${what}.`
  if (read.state === 'AGENT_DISABLED') return `${what[0]!.toUpperCase()}${what.slice(1)} cannot be read while SQL Server Agent's extended procedures are off.`
  return read.message ?? `${what[0]!.toUpperCase()}${what.slice(1)} could not be read (${read.state}).`
}
const readOk = (facts: OverviewFacts, read: OverviewRead) => facts.reads[read]?.state === 'ok'
const unread = (id: OverviewCheckId, facts: OverviewFacts, read: OverviewRead, what: string): OverviewCheck =>
  ({ id, severity: 'unread', title: overviewCheckTitles[id], detail: unreadText(facts.reads[read], what), objects: [] })

/** Agent's state, as Job Activity Monitor reads it. */
export function overviewAvailability(facts: OverviewFacts): AgentAvailability {
  if (facts.reads.state === undefined) return 'pending'
  if (facts.agentXps === undefined) return 'unknown'
  return agentAvailability({ agentXps: facts.agentXps, ...facts.serviceState !== undefined ? { serviceState: facts.serviceState } : {}, ...facts.startupType !== undefined ? { startupType: facts.startupType } : {} })
}

/** The service check, only while Agent cannot run jobs (the header shows a running Agent): Start only for sysadmin on Windows, never Disabled. */
export function serviceCheck(facts: OverviewFacts): OverviewCheck | undefined {
  const availability = overviewAvailability(facts)
  if (availability === 'running' || availability === 'pending') return undefined
  const canStart = facts.sysadmin === true && facts.platform === 'windows' && facts.startupType !== startupDisabled
  const banner = agentBanner(availability, facts, canStart, facts.platform === 'linux')
  return {
    id: 'service', severity: 'error', title: availability === 'stopped' ? 'SQL Server Agent is not running' : 'SQL Server Agent cannot run jobs now', detail: banner?.text ?? '', objects: [],
    ...banner?.start ? { fix: { label: 'Start SQL Server Agent…', action: { kind: 'startAgent' } } } : {}
  }
}

/** Jobs whose last run failed and started within a day of the server's clock (any failed last run when the clock was not read). */
export function failedJobs(facts: OverviewFacts): OverviewJob[] {
  const now = stampMs(facts.serverNow)
  return facts.jobs.filter(job => {
    if (job.outcome !== 0) return false
    if (now === undefined) return true
    const at = stampMs(job.lastRun)
    return at !== undefined && now - at <= failedWindowMs
  })
}
export function failedCheck(facts: OverviewFacts): OverviewCheck {
  if (!readOk(facts, 'jobs')) return unread('failedJobs', facts, 'jobs', 'the jobs')
  const failed = failedJobs(facts)
  const window = facts.serverNow ? ' in the last 24 hours' : ''
  if (!failed.length) return { id: 'failedJobs', severity: 'ok', title: `No job failed${window}`, detail: `${count(facts.jobs.length, 'job', 'jobs')} checked by their last run.`, objects: [] }
  const named = failed.map(job => job.status === 3 ? `${job.name} (retrying)` : job.name)
  return {
    id: 'failedJobs', severity: 'error', title: `${count(failed.length, 'job', 'jobs')} failed${window}`, detail: `${namesText(named, 5)}.`,
    objects: failed.map(job => ({ kind: 'job', name: job.name })), fix: { label: 'Show them', action: { kind: 'failedJobs' } }
  }
}

const ownerWords: Record<number, string> = { [ownerStates.disabled]: 'a disabled login', [ownerStates.missing]: 'a login that no longer exists', [ownerStates.denied]: 'a login denied CONNECT SQL' }
/** Jobs whose owner cannot log in (the owners read, sysadmin only). */
export function ownerCheck(facts: OverviewFacts): OverviewCheck {
  if (!readOk(facts, 'owners')) return unread('owners', facts, 'owners', 'the job owners\' logins')
  const bad = facts.jobs.filter(job => job.ownerState !== undefined && job.ownerState !== ownerStates.ok && ownerWords[job.ownerState])
  if (!bad.length) return { id: 'owners', severity: 'ok', title: 'Every job\'s owner can log in', detail: 'No job is owned by a disabled, missing or denied login.', objects: [] }
  const states = new Set(bad.map(job => job.ownerState))
  const what = states.size === 1 ? ownerWords[bad[0]!.ownerState!]! : 'a login that cannot log in'
  const title = bad.length === 1 ? `1 job is owned by ${what}` : `${count(bad.length, 'job', 'jobs')} are owned by ${states.size === 1 ? what.replace(/^a /, '').replace('login', 'logins') : 'logins that cannot log in'}`
  const detail = bad.slice(0, 3).map(job => `${job.name} is owned by ${job.owner || 'an unknown login'}${states.size === 1 ? '' : ` (${ownerWords[job.ownerState!]!.replace(/^a /, '')})`}.`).join(' ')
    + (bad.length > 3 ? ` And ${bad.length - 3} more.` : '') + ' A job whose owner cannot log in fails when it starts.'
  return {
    id: 'owners', severity: 'warning', title, detail, objects: bad.map(job => ({ kind: 'job', name: job.name })),
    fix: { label: 'Change owner…', action: { kind: 'changeOwner', jobs: bad.map(job => ({ id: job.id, name: job.name, owner: job.owner })) } }
  }
}

/** Enabled jobs that notify no operator (e-mail, pager or net send) when they fail; the event log is not someone. */
export function silentJobs(facts: OverviewFacts): OverviewJob[] {
  return facts.jobs.filter(job => job.enabled && ![job.notifyEmail, job.notifyPage, job.notifyNetsend].some(level => failureLevels.includes(level)))
}
export function notifyCheck(facts: OverviewFacts): OverviewCheck {
  if (!readOk(facts, 'jobs')) return unread('notify', facts, 'jobs', 'the jobs')
  const silent = silentJobs(facts)
  if (!silent.length) return { id: 'notify', severity: 'ok', title: 'Every enabled job notifies someone when it fails', detail: 'Each one e-mails, pages or net-sends an operator on failure.', objects: [] }
  return {
    id: 'notify', severity: 'warning', title: `${count(silent.length, 'job notifies', 'jobs notify')} no one when ${silent.length === 1 ? 'it fails' : 'they fail'}`,
    detail: `${namesText(silent.map(job => job.name), 5)}.`, objects: silent.map(job => ({ kind: 'job', name: job.name })),
    fix: { label: 'Set notifications…', action: { kind: 'notifications', job: silent[0]!.name } }
  }
}

export interface HistoryShortfall { readonly job: OverviewJob; readonly coveredMs: number; readonly rowsPerRun: number }
/**
 * Jobs whose history is at a cap and covers less than a week: a job's rows within one run of the per-job cap, or every job's rows within the
 * largest run of the total cap (Agent then purges the oldest rows across jobs). Unlimited history (-1) caps nothing.
 */
export function historyShortfalls(facts: OverviewFacts): HistoryShortfall[] {
  const max = facts.historyMaxRows, perJob = facts.historyMaxRowsPerJob, now = stampMs(facts.serverNow)
  if (max === undefined || perJob === undefined || max < 0 || now === undefined) return []
  const ran = facts.jobs.filter(job => (job.historyRuns ?? 0) > 0 && job.historyRows !== undefined)
  const perRun = (job: OverviewJob) => Math.max(1, Math.ceil((job.historyRows ?? 0) / (job.historyRuns ?? 1)))
  const total = ran.reduce((sum, job) => sum + job.historyRows!, 0)
  const totalFull = total + Math.max(0, ...ran.map(perRun)) > max
  return ran.flatMap(job => {
    const oldest = stampMs(job.historyOldest)
    if (oldest === undefined) return []
    const capped = totalFull || job.historyRows! + perRun(job) > perJob
    const covered = Math.max(0, now - oldest)
    return capped && covered < historyWindowMs ? [{ job, coveredMs: covered, rowsPerRun: perRun(job) }] : []
  }).sort((a, b) => a.coveredMs - b.coveredMs)
}
export function historyCheck(facts: OverviewFacts): OverviewCheck {
  if (!readOk(facts, 'history')) return unread('history', facts, 'history', 'the job history counts')
  if (facts.historyMaxRows === undefined || facts.historyMaxRowsPerJob === undefined) return unread('history', facts, 'properties', 'Agent\'s history settings')
  if (facts.historyMaxRows < 0) return { id: 'history', severity: 'ok', title: 'History is not limited by size', detail: 'SQL Server Agent keeps every history row until it is deleted.', objects: [] }
  const short = historyShortfalls(facts)
  const caps = `History is capped at ${count(facts.historyMaxRows, 'row', 'rows')}, ${facts.historyMaxRowsPerJob.toLocaleString('en-US')} per job.`
  if (!short.length) return { id: 'history', severity: 'ok', title: 'History keeps at least a week for every job', detail: caps, objects: [] }
  const first = short[0]!
  const title = short.length === 1 ? `History keeps only ${spanText(first.coveredMs)} for ${first.job.name}` : `History keeps less than a week for ${count(short.length, 'job', 'jobs')}`
  const detail = `${caps} ${first.job.name} writes about ${count(first.rowsPerRun, 'row', 'rows')} a run, so its history covers ${spanText(first.coveredMs)}.`
    + (short.length > 1 ? ` Also ${namesText(short.slice(1).map(item => item.job.name))}.` : '')
  return { id: 'history', severity: 'warning', title, detail, objects: short.map(item => ({ kind: 'job', name: item.job.name })), fix: { label: 'History settings…', action: { kind: 'agentProperties' } } }
}

const raisedText = (entries: readonly { readonly messageId: number; readonly severity: number }[]): string => {
  const severities = entries.filter(entry => entry.severity).map(entry => String(entry.severity).padStart(3, '0'))
  const errors = entries.filter(entry => entry.messageId).map(entry => String(entry.messageId))
  return [severities.length ? `severity ${namesText(severities, 12)}` : '', errors.length ? `${errors.length === 1 ? 'error' : 'errors'} ${namesText(errors, 12)}` : ''].filter(Boolean).join(', and ')
}
/** The community-standard alert set (AG-7's recommendedAlerts) against the server's alerts; Windows only (agentPlatformGates.alerts). */
export function alertsCheck(facts: OverviewFacts): OverviewCheck {
  if (facts.platform && !agentGateOpen('alerts', facts.platform)) return unread('alerts', facts, 'alerts', 'alerts')
  if (!readOk(facts, 'alerts')) return unread('alerts', facts, 'alerts', 'the alerts')
  const states = recommendedAlertStates(facts.alerts.map(alert => ({ name: alert.name, messageId: alert.messageId, severity: alert.severity })))
  const missing = states.filter(state => !state.exists), present = states.filter(state => state.exists)
  if (!missing.length) return { id: 'alerts', severity: 'ok', title: 'Recommended alerts are in place', detail: `Alerts on ${raisedText(present)} exist.`, objects: [] }
  const text = raisedText(missing)
  const detail = `Missing: ${text}.${present.length ? ` ${raisedText(present).replace(/^./, first => first.toUpperCase())} ${present.length === 1 ? 'exists' : 'exist'}.` : ''}`
    + (facts.sysadmin ? '' : ' A sysadmin adds them.')
  return { id: 'alerts', severity: 'warning', title: 'Recommended alerts are missing', detail, objects: [], ...facts.sysadmin ? { fix: { label: 'Add recommended alerts…', action: { kind: 'recommendedAlerts' } } } : {} }
}

/** Agent's Database Mail (sysadmin): the job document's mail problem, plus a profile Agent names that no longer exists. A warning while a job
 *  or alert notifies someone, else worth knowing. */
export function mailCheck(facts: OverviewFacts): OverviewCheck {
  // Agent's own mail settings may fail to read (sp_get_sqlagent_properties sends no use_databasemail or databasemail_profile on
  // the servers checked so far): Database Mail XPs and the profiles still say whether mail can work, and the detail says what was not read.
  const agentUnread = facts.reads.mail !== undefined && facts.reads.mail.state !== 'ok' && facts.reads.mail.state !== 'role' && readOk(facts, 'profiles') && facts.mailXps !== undefined
  if (!readOk(facts, 'mail') && !agentUnread) return unread('mail', facts, 'mail', 'Agent\'s mail settings')
  const platform = facts.platform ?? 'windows'
  const problem = mailProblem({
    checked: true, sysadmin: true, ...facts.mailXps !== undefined ? { xps: facts.mailXps === 1 } : {}, ...facts.mailProfiles !== undefined ? { profiles: facts.mailProfiles } : {},
    ...facts.useDatabaseMail !== undefined ? { useDatabaseMail: facts.useDatabaseMail === 1 } : {}, ...facts.agentProfile ? { agentProfile: facts.agentProfile } : {}
  }, platform) ?? (facts.agentProfileFound === 0 ? `SQL Server Agent's mail profile ${facts.agentProfile} is not a Database Mail profile any more.` : undefined)
  if (!problem && agentUnread) return { id: 'mail', severity: 'ok', title: 'Database Mail is set up', detail: `Database Mail is on with ${count(facts.mailProfiles ?? 0, 'profile', 'profiles')}. Varia could not read which profile SQL Server Agent uses: Agent Properties › Alert System in SSMS shows it.`, objects: [] }
  if (!problem) return { id: 'mail', severity: 'ok', title: 'Agent mail is set up', detail: facts.agentProfile ? `Database Mail profile ${facts.agentProfile}.` : 'Database Mail is on.', objects: [] }
  const used = facts.jobs.some(job => job.enabled && job.notifyEmail > 0) || facts.alerts.some(alert => alert.notifies)
  return {
    id: 'mail', severity: used ? 'warning' : 'info', title: 'Agent mail is not set up',
    detail: `${problem} Varia does not set up Database Mail yet: use Database Mail Configuration, then Agent Properties › Alert System, in SSMS.`, objects: []
  }
}

/** Schedules no job uses (sysadmin: below it a schedule's job count is not a reliable answer). */
export function schedulesCheck(facts: OverviewFacts): OverviewCheck {
  if (!readOk(facts, 'schedules')) return unread('schedules', facts, 'schedules', 'which jobs use each schedule')
  const unused = facts.schedules.filter(schedule => schedule.jobs === 0)
  if (!unused.length) return { id: 'schedules', severity: 'ok', title: 'Every schedule is used by a job', detail: `${count(facts.schedules.length, 'schedule', 'schedules')} checked.`, objects: [] }
  return {
    id: 'schedules', severity: 'info', title: `${count(unused.length, 'schedule is', 'schedules are')} unused`, detail: `${namesText(unused.map(schedule => schedule.name), 5)}.`,
    objects: unused.map(schedule => ({ kind: 'schedule', name: schedule.name })), fix: { label: 'Open Schedules', action: { kind: 'schedules' } }
  }
}

/** Every check, in the order the overview lists them (the service check only while Agent cannot run jobs). */
export function overviewChecks(facts: OverviewFacts): OverviewCheck[] {
  const service = serviceCheck(facts)
  return [...service ? [service] : [], failedCheck(facts), ownerCheck(facts), notifyCheck(facts), historyCheck(facts), alertsCheck(facts), mailCheck(facts), schedulesCheck(facts)]
}
/** The checks that need attention (error or warning), for the section's "n of m checks". */
export const needsAttention = (checks: readonly OverviewCheck[]): number => checks.filter(check => check.severity === 'error' || check.severity === 'warning').length

// --- Tiles -----------------------------------------------------------------------------------------------------------

export interface OverviewTile { readonly id: 'jobs' | 'failed' | 'running' | 'alerts'; readonly label: string; readonly value: string; readonly detail: string; readonly tone?: 'error' | 'accent' }
export function overviewTiles(facts: OverviewFacts): OverviewTile[] {
  const jobsRead = readOk(facts, 'jobs')
  const failed = jobsRead ? failedJobs(facts) : []
  const running = facts.jobs.filter(job => job.status !== undefined && (runningExecutionStatuses as readonly number[]).includes(job.status))
  const now = stampMs(facts.serverNow)
  const fired = facts.alerts.filter(alert => { const at = stampMs(alert.lastOccurred); return now !== undefined && at !== undefined && now - at <= alertWeekMs })
  const alertsRead = readOk(facts, 'alerts')
  return [
    { id: 'jobs', label: 'Jobs', value: jobsRead ? String(facts.jobs.length) : '—', detail: jobsRead ? `${facts.jobs.filter(job => job.enabled).length} enabled` : '' },
    { id: 'failed', label: facts.serverNow ? 'Failed, last 24 h' : 'Last run failed', value: jobsRead ? String(failed.length) : '—', detail: namesText(failed.map(job => job.name), 2), ...failed.length ? { tone: 'error' as const } : {} },
    { id: 'running', label: 'Running', value: jobsRead ? String(running.length) : '—', detail: namesText(running.map(job => job.name), 2), ...running.length ? { tone: 'accent' as const } : {} },
    { id: 'alerts', label: 'Alerts', value: alertsRead ? String(facts.alerts.length) : '—', detail: alertsRead ? `${fired.length} fired this week` : '' }
  ]
}

/** The header's facts: the service's words, startup type and account. */
export function serviceWords(facts: OverviewFacts): { readonly state: string; readonly tone: 'ok' | 'error' | 'muted'; readonly startup?: string } {
  const availability = overviewAvailability(facts)
  const state = availability === 'running' ? 'Running' : availability === 'stopped' ? 'Stopped' : availability === 'xpsOff' ? 'Agent XPs off' : availability === 'pending' ? 'Reading…' : 'Unknown'
  const startup = facts.startupType === 2 ? 'Starts automatically' : facts.startupType === 3 ? 'Starts manually' : facts.startupType === startupDisabled ? 'Disabled' : undefined
  return { state, tone: availability === 'running' ? 'ok' : availability === 'pending' || availability === 'unknown' ? 'muted' : 'error', ...startup ? { startup } : {} }
}

// --- Commands --------------------------------------------------------------------------------------------------------

export const agentOverviewTitle = 'SQL Server Agent Overview'
/** The document's tab: the overview and its server. */
export const agentOverviewTabName = (server: string): string => `Agent Overview - ${server}`
export type AgentOverviewCommandId = 'agent.overview' | 'agent.refreshOverview'
export interface AgentOverviewCommandEntry {
  readonly title: string
  readonly category: 'SQL Server Agent'
  readonly icon: 'agent' | 'refresh'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly menus?: readonly { readonly menu: 'explorer.context'; readonly group: string; readonly order: number; readonly mnemonic?: string; readonly when?: string }[]
}
/** The overview on the Agent node's menu (and its default action) and in the palette, and Check again for the active overview. */
export function agentOverviewCommandEntries(): { readonly [K in AgentOverviewCommandId]: AgentOverviewCommandEntry } {
  return {
    'agent.overview': {
      title: 'Agent Overview', category: 'SQL Server Agent', icon: 'agent', keywords: ['agent', 'overview', 'health', 'checks', 'best', 'practice', 'sqlserveragent', 'summary', 'status'],
      precondition: 'agentEnabled && backendReady && hasConnection', unavailableHint: 'Connect to a SQL Server whose SQL Server Agent you can see first.',
      menus: [{ menu: 'explorer.context', group: '1_monitor', order: 4, mnemonic: 'w', when: "explorerNode == 'agent' && !explorerServerLost" }]
    },
    'agent.refreshOverview': {
      title: 'Refresh Agent Overview', category: 'SQL Server Agent', icon: 'refresh', keywords: ['agent', 'overview', 'health', 'checks', 'refresh', 'again', 'now'],
      precondition: 'agentEnabled && backendReady && activeDocumentIsAgentOverview', unavailableHint: 'Open the Agent overview first (SQL Server Agent: Agent Overview).'
    }
  }
}
