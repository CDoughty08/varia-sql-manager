// Job Activity Monitor and the status bar's running job (AG-3, docs/sql-server-agent.md): the `agent.jobs` live source's
// args, the view chips and tiles, and the pure rules both surfaces follow (Agent's state from agent.jobs.service, the watched
// job's text). The backend builds the rows (Agent/AgentJobsReader.cs); this decides only what the renderer shows.
import { z } from 'zod'
import { agentLimits, executionStatuses, lastRunOutcomes, runningExecutionStatuses } from './catalog.ts'
import { agentWatchedFields } from '../live/catalog.ts'

export const agentJobsSource = 'agent.jobs' as const
export const agentJobsProbe = 'agent.jobs.list' as const
export const agentServiceProbe = 'agent.jobs.service' as const
export const agentWatchedProbe = 'agent.jobs.watched' as const

/** The list's columns a column value filter may name (the faceted ones). */
export const agentJobFilterColumns = ['status', 'lastOutcome', 'category'] as const
export type AgentJobFilterColumn = typeof agentJobFilterColumns[number]
/** Bounds of the column value filters: values per filter and characters per value. */
export const agentJobFilterLimits = { values: 64, chars: 128 } as const

export const agentJobColumnFilterSchema = z.object({
  column: z.enum(agentJobFilterColumns),
  values: z.array(z.string().max(agentJobFilterLimits.chars)).max(agentJobFilterLimits.values).optional(),
  blanks: z.boolean().optional(),
  nonBlanks: z.boolean().optional(),
  exclude: z.boolean().optional()
}).strict().superRefine((filter, context) => {
  // The backend's rules (AgentJobsArgs.Check), as Activity Monitor's column filters have them.
  if (!filter.values?.length && !filter.blanks && !filter.nonBlanks) context.addIssue({ code: 'custom', message: 'A column filter needs a value, (Blanks) or (Non-blanks).' })
  if (filter.exclude && (!filter.values?.length || filter.nonBlanks)) context.addIssue({ code: 'custom', message: 'An excluding filter names values, without (Non-blanks).' })
})
export type AgentJobColumnFilter = z.infer<typeof agentJobColumnFilterSchema>

/** `agent.jobs`' args: the job whose last run the list reads, the jobs the status bar watches (slots by order), and the list's
 *  column value filters. Each args replaces the last whole. The backend checks them again (AgentJobsArgs.Check). */
export const agentJobsArgsSchema = z.object({
  // msdb's job ids are any GUID (the backend parses them as Guid "D"), not only RFC 9562 UUIDs.
  expand: z.guid().optional(),
  watch: z.array(z.guid()).min(1).max(agentLimits.watchedJobs).refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length, 'A job is watched once.').optional(),
  filters: z.array(agentJobColumnFilterSchema).max(agentJobFilterColumns.length).refine(filters => new Set(filters.map(filter => filter.column)).size === filters.length, 'A column is filtered once.').optional()
}).strict()
export type AgentJobsArgs = z.infer<typeof agentJobsArgsSchema>

// --- View chips and tiles -------------------------------------------------------------------------------------------

export type AgentJobView = 'all' | 'running' | 'failed' | 'disabled'
export interface AgentJobViewSpec { readonly id: AgentJobView; readonly label: string; readonly series?: 'running' | 'failed' | 'disabled' }
/** The view chips (a radiogroup): All, then the probe's views; each counts the jobs its series counts. */
export const agentJobViewSpecs: readonly AgentJobViewSpec[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running', series: 'running' },
  { id: 'failed', label: 'Failed', series: 'failed' },
  { id: 'disabled', label: 'Disabled', series: 'disabled' }
]
export type AgentJobTileId = 'running' | 'failed' | 'betweenRetries' | 'disabled'
export interface AgentJobTile {
  readonly id: AgentJobTileId
  readonly label: string
  /** Its index in agent.jobs.list's series. */
  readonly series: number
  readonly tone: 'accent' | 'error' | 'warning' | 'muted'
  /** What pressing it applies: its view chip, or (Between retries, which has no chip) a Status value filter. */
  readonly applies: { readonly view: Exclude<AgentJobView, 'all'> } | { readonly status: string }
  /** It counts what Agent is doing now, which no one can read while Agent cannot be used. */
  readonly live: boolean
}
const statusLabel = (code: number) => executionStatuses.find(status => status.code === code)!.label
export const agentJobTiles: readonly AgentJobTile[] = [
  { id: 'running', label: 'Running', series: 0, tone: 'accent', applies: { view: 'running' }, live: true },
  { id: 'failed', label: 'Last run failed', series: 1, tone: 'error', applies: { view: 'failed' }, live: false },
  { id: 'betweenRetries', label: 'Between retries', series: 2, tone: 'warning', applies: { status: statusLabel(3) }, live: true },
  { id: 'disabled', label: 'Disabled', series: 3, tone: 'muted', applies: { view: 'disabled' }, live: false }
]

// --- Agent's state ------------------------------------------------------------------------------------------------

/** `sys.dm_server_services.status`: 1 stopped, 4 running, the rest pending or paused. */
export const serviceStates = { stopped: 1, running: 4 } as const
/** `sys.dm_server_services.startup_type`: 4 is Disabled. */
export const startupDisabled = 4

/** What agent.jobs.service's last sample says (undefined members: not read, so unknown). */
export interface AgentServiceSample { readonly agentXps?: number; readonly serviceState?: number; readonly startupType?: number }
/**
 * Whether Agent can run jobs now, by agent.jobs.service: `running` (XPs on and the service running or unreadable), `stopped`
 * (the service reads stopped), `xpsOff` (XPs 0 while the service runs), `unknown` (XPs 0 and the service state unreadable,
 * the usual case for User and Reader logins), or `pending` before the first sample.
 */
export type AgentAvailability = 'pending' | 'running' | 'stopped' | 'xpsOff' | 'unknown'
export function agentAvailability(sample: AgentServiceSample | undefined): AgentAvailability {
  if (!sample || sample.agentXps === undefined) return 'pending'
  if (sample.serviceState === serviceStates.stopped) return 'stopped'
  if (sample.agentXps === 1) return 'running'
  return sample.serviceState === undefined ? 'unknown' : 'xpsOff'
}

export interface AgentBanner { readonly text: string; readonly start: boolean }
/**
 * Job Activity Monitor's warning banner while Agent cannot run jobs (never an error), worded by the service's state; Start
 * Agent… only for sysadmin on Windows (the service rules decide, `canStart`) and never for a Disabled service.
 */
export function agentBanner(availability: AgentAvailability, sample: AgentServiceSample | undefined, canStart: boolean, linux: boolean): AgentBanner | undefined {
  const configure = linux ? 'mssql-conf' : 'sp_configure'
  switch (availability) {
    case 'stopped': return sample?.startupType === startupDisabled
      ? { text: 'SQL Server Agent is not running and its service is Disabled, so it cannot be started from Varia. A Windows administrator sets its startup type in SQL Server Configuration Manager.', start: false }
      : { text: 'SQL Server Agent is not running, so no job starts on schedule. Last outcomes are from msdb; Next Run is not current while Agent is stopped.', start: canStart }
    case 'xpsOff': return { text: `The Agent XPs option is 0, so msdb's Agent procedures cannot run while SQL Server Agent is running. A sysadmin turns it on with ${configure}; this view resumes by itself when it is on.`, start: false }
    case 'unknown': return { text: 'SQL Server Agent is stopped or the Agent XPs option is 0, so job state cannot be read. This login cannot read the service state, so no Start is offered; this view resumes by itself when Agent can be used again.', start: false }
    default: return undefined
  }
}
/** What every Status cell reads while Agent cannot run jobs (the list's own Status is stale then). */
export function agentStatusOverride(availability: AgentAvailability): string | undefined {
  return availability === 'stopped' ? 'Agent stopped' : availability === 'xpsOff' ? 'Unknown (Agent XPs off)' : availability === 'unknown' ? 'Unknown' : undefined
}
/** A tile's value: its count, 0 for a live tile while Agent is stopped, unknown ("—") while Agent's state cannot be read. */
export function tileValue(tile: AgentJobTile, count: number | null | undefined, availability: AgentAvailability): number | '—' | undefined {
  if (tile.live && availability === 'stopped') return 0
  if (tile.live && (availability === 'xpsOff' || availability === 'unknown')) return '—'
  return count ?? undefined
}

/** A view chip's count: what its tile shows, so Running reads 0 or nothing (unknown) while Agent cannot run jobs. */
export function viewCount(series: AgentJobViewSpec['series'], counts: readonly (number | null)[] | undefined, availability: AgentAvailability): number | undefined {
  const tile = agentJobTiles.find(item => item.id === series)
  const value = tile && tileValue(tile, counts?.[tile.series], availability)
  return typeof value === 'number' ? value : undefined
}

// --- Bulk actions -------------------------------------------------------------------------------------------------

export type AgentBulkVerb = 'startJob' | 'stopJob' | 'enable' | 'disable'
export const agentBulkVerbs: readonly AgentBulkVerb[] = ['startJob', 'stopJob', 'enable', 'disable']
export const agentBulkTitles: { readonly [V in AgentBulkVerb]: { readonly button: string; readonly dialog: string; readonly line: string } } = {
  startJob: { button: 'Start', dialog: 'Start Jobs', line: 'Start' },
  stopJob: { button: 'Stop', dialog: 'Stop Jobs', line: 'Stop' },
  enable: { button: 'Enable', dialog: 'Enable Jobs', line: 'Enable' },
  disable: { button: 'Disable', dialog: 'Disable Jobs', line: 'Disable' }
}
/** Why a bulk verb is not offered for a selection, or undefined when it is. */
export function bulkUnavailable(selected: number): string | undefined {
  if (selected === 0) return 'Select one or more jobs.'
  if (selected > agentLimits.startJobs) return `Select at most ${agentLimits.startJobs} jobs: each one is its own request.`
  return undefined
}

// --- The status bar's watched job ---------------------------------------------------------------------------------

/** One watched slot's series values, in agentWatchedFields' order. */
export interface WatchedSample { readonly status?: number; readonly step?: number; readonly steps?: number; readonly started?: number; readonly lastOutcome?: number; readonly lastRun?: number }
/** The slot's values out of a sample's metrics (agent.jobs.watched's series order). */
export function watchedSlot(metrics: readonly (number | null)[] | undefined, slot: number): WatchedSample | undefined {
  if (!metrics) return undefined
  const at = slot * agentWatchedFields.length
  const value = (index: number) => metrics[at + index] ?? undefined
  if (value(0) === undefined) return undefined
  return { status: value(0), step: value(1), steps: value(2), started: value(3), lastOutcome: value(4), lastRun: value(5) }
}
/** A watched slot's status for a job msdb no longer has (AgentJobsReader.GoneStatus); a slot with no status was not read. */
export const watchedGoneStatus = -1
/** How many samples in a row may read the job idle with an older last run before following gives up: before it runs (sp_start_job
 *  only posts the request) and after (Agent may show it idle a sample before it writes the run's outcome). */
export const watchStartSamples = 3

export type WatchedPhase =
  | { readonly phase: 'starting' }
  | { readonly phase: 'running'; readonly step?: number; readonly steps?: number; readonly retrying: boolean }
  | { readonly phase: 'ended'; readonly outcome: number; readonly lastRun: number }
  | { readonly phase: 'unknown'; readonly reason: 'agentStopped' | 'xpsOff' | 'unreadable' | 'gone' }

export interface WatchedJob {
  /** The job's last run start (yyyymmddhhmmss) before this window started it; 0 when it never ran. A run counts only above it. */
  readonly before: number
  /** Samples seen since the start that read the job idle with no newer run. */
  readonly idleSamples: number
  /** The job was seen running since the start. */
  readonly seenRunning: boolean
}
/**
 * The watched job's phase after a sample: Starting… until it is seen running or an idle sample carries a run newer than the
 * one before the start; running while its status is 1, 2, 3 or 7; ended with that run's outcome; and, after
 * watchStartSamples idle samples in a row with no newer run (it never started, or Agent stopped mid-run and left no outcome),
 * outcome unknown. While Agent
 * cannot be used it says why instead (agent.jobs.service): the service stopped means the job ended without an outcome.
 */
export function watchedPhase(job: WatchedJob, sample: WatchedSample | undefined, availability: AgentAvailability): { readonly phase: WatchedPhase; readonly job: WatchedJob } {
  if (availability === 'stopped') return { phase: { phase: 'unknown', reason: 'agentStopped' }, job }
  if (availability === 'xpsOff') return { phase: { phase: 'unknown', reason: 'xpsOff' }, job }
  if (availability === 'unknown') return { phase: { phase: 'unknown', reason: 'unreadable' }, job }
  if (sample?.status === watchedGoneStatus) return { phase: { phase: 'unknown', reason: 'gone' }, job }
  // A slot not read this sample (a refused read) changes nothing yet, but counts toward giving up, so it never waits forever.
  if (!sample) {
    const next = { ...job, idleSamples: job.idleSamples + 1 }
    if (next.idleSamples > watchStartSamples) return { phase: { phase: 'unknown', reason: 'gone' }, job: next }
    return { phase: job.seenRunning ? { phase: 'running', retrying: false } : { phase: 'starting' }, job: next }
  }
  const status = sample.status ?? 4
  if ((runningExecutionStatuses as readonly number[]).includes(status)) {
    return { phase: { phase: 'running', step: sample.step || undefined, steps: sample.steps || undefined, retrying: status === 3 }, job: { ...job, seenRunning: true, idleSamples: 0 } }
  }
  const lastRun = sample.lastRun ?? 0
  if (lastRun > job.before && sample.lastOutcome !== undefined) return { phase: { phase: 'ended', outcome: sample.lastOutcome, lastRun }, job }
  // An idle read without a newer run is not yet an end: msdb may show the job idle a sample before its last run is written.
  const next = { ...job, idleSamples: job.idleSamples + 1 }
  if (next.idleSamples > watchStartSamples) return { phase: { phase: 'unknown', reason: 'gone' }, job: next }
  return { phase: job.seenRunning ? { phase: 'running', retrying: false } : { phase: 'starting' }, job: next }
}

/** yyyymmddhhmmss (server local time) as "hh:mm:ss", with the date when it is not `today` (yyyymmdd). */
export function stampText(stamp: number, today?: number): string {
  const text = String(Math.trunc(stamp)).padStart(14, '0')
  const time = `${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}`
  return today !== undefined && Math.trunc(stamp / 1_000_000) === today ? time : `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} ${time}`
}

/** The status bar item's words for a watched job ("Index maintenance: running step 2 of 4"). */
export function watchedText(name: string, phase: WatchedPhase, today?: number): string {
  switch (phase.phase) {
    case 'starting': return `${name}: Starting…`
    case 'running': return `${name}: ${phase.retrying ? 'between retries' : 'running'}${phase.step ? ` step ${phase.step}${phase.steps ? ` of ${phase.steps}` : ''}` : ''}`
    case 'ended': {
      const outcome = lastRunOutcomes.find(item => item.code === phase.outcome)?.label ?? 'Unknown'
      return `${name}: ${outcome} (started ${stampText(phase.lastRun, today)}, server time)`
    }
    case 'unknown': return phase.reason === 'agentStopped' ? `${name}: Agent stopped, job outcome unknown`
      : phase.reason === 'xpsOff' ? `${name}: Agent XPs off, job progress unavailable`
      : phase.reason === 'unreadable' ? `${name}: Agent stopped or Agent XPs off, job progress unavailable`
      : `${name}: job outcome unknown`
  }
}

// --- Commands -----------------------------------------------------------------------------------------------------

export const jobActivityTitle = 'Job Activity Monitor'
/** The document's tab: the monitor and its server, as SSMS names its window. */
export const jobActivityTabName = (server: string): string => `${jobActivityTitle} - ${server}`

export type JobActivityCommandId = 'agent.jobActivity' | 'agent.refreshJobs' | 'agent.startJobs' | 'agent.stopJobs' | 'agent.enableJobs' | 'agent.disableJobs'
/** Each bulk verb's command. */
export const agentBulkCommands: { readonly [V in AgentBulkVerb]: JobActivityCommandId } = { startJob: 'agent.startJobs', stopJob: 'agent.stopJobs', enable: 'agent.enableJobs', disable: 'agent.disableJobs' }
/** A command catalogue entry, in the shape of `CommandDescriptor`. */
export interface JobActivityCommandEntry {
  readonly title: string
  readonly category: 'SQL Server Agent'
  readonly icon: 'agent-activity' | 'refresh' | 'play' | 'debug-stop' | 'pass' | 'circle-slash'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly menus?: readonly { readonly menu: 'explorer.context'; readonly group: string; readonly order: number; readonly mnemonic?: string; readonly when?: string }[]
}
const openJobActivity = 'Open Job Activity Monitor first (SQL Server Agent: Job Activity Monitor).'
/**
 * Job Activity Monitor's commands, all behind the release gate (agentEnabled; the renderer registers none without it): the
 * monitor on the Agent node's and the Job Activity Monitor node's menus and in the palette, and its Refresh and bulk verbs,
 * which act on the jobs selected in the active monitor.
 */
export function jobActivityCommandEntries(): { readonly [K in JobActivityCommandId]: JobActivityCommandEntry } {
  const bulk = (verb: AgentBulkVerb, icon: JobActivityCommandEntry['icon'], keywords: readonly string[]): JobActivityCommandEntry => ({
    title: agentBulkTitles[verb].dialog, category: 'SQL Server Agent', icon, keywords: ['agent', 'job', 'jobs', ...keywords],
    precondition: 'agentEnabled && backendReady && activeDocumentIsJobActivity', unavailableHint: 'Select jobs in Job Activity Monitor first.'
  })
  return {
    'agent.jobActivity': {
      title: jobActivityTitle, category: 'SQL Server Agent', icon: 'agent-activity', keywords: ['agent', 'jobs', 'activity', 'monitor', 'running', 'sqlserveragent', 'live'],
      precondition: 'agentEnabled && backendReady && hasConnection', unavailableHint: 'Connect to a SQL Server whose SQL Server Agent you can see first.',
      menus: [{ menu: 'explorer.context', group: '1_monitor', order: 1, mnemonic: 'j', when: "(explorerNode == 'agent' || explorerNode == 'agentJobActivity') && !explorerServerLost" }]
    },
    'agent.refreshJobs': {
      title: 'Refresh Jobs', category: 'SQL Server Agent', icon: 'refresh', keywords: ['agent', 'jobs', 'activity', 'reload', 'now'],
      precondition: 'agentEnabled && backendReady && activeDocumentIsJobActivity', unavailableHint: openJobActivity
    },
    'agent.startJobs': bulk('startJob', 'play', ['start', 'run', 'execute']),
    'agent.stopJobs': bulk('stopJob', 'debug-stop', ['stop', 'cancel']),
    'agent.enableJobs': bulk('enable', 'pass', ['enable']),
    'agent.disableJobs': bulk('disable', 'circle-slash', ['disable'])
  }
}
