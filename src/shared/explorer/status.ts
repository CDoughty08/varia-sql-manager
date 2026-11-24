// Object Explorer's status chips (docs/object-explorer.md, Live status and Login status): what the `explorer` live source's
// probes (src/shared/live/catalog.ts) report, turned into the chips a node shows, and a login's static chip from its listing.
// Only a probe's own rows or the listing's own columns make a chip; nothing here guesses. Erasable TypeScript (no enums), so Node's type stripping can load it as well.
import type { IconId } from '../icons.ts'
import type { StatusTone } from '../theme/tones.ts'
import type { NodeStatus } from './catalog.ts'

/** A database's runtime state: sys.databases' state, user_access, is_read_only and is_in_standby. A database node's listing
 *  carries it (`ExplorerNode.database`), and so does each live status row. */
export interface DatabaseRuntime { readonly state: number; readonly userAccess: number; readonly readOnly: boolean; readonly standby: boolean }
/** A row of `explorer.databases`: a database that is not plainly online and open to everyone. */
export interface DatabaseStatusRow extends DatabaseRuntime { readonly name: string }
const plainlyOnline: DatabaseRuntime = Object.freeze({ state: 0, userAccess: 0, readOnly: false, standby: false })
/**
 * A database's runtime state now: the live sample when it was taken after the listing (`at` and `listedAt` in epoch ms),
 * else the listing's. The probe reports only databases that are not plainly online and open to everyone, so a newer
 * complete sample without a row for the database means exactly that. A sample cut at its row cap (`complete` false, as
 * ExplorerStatusService tracks it) says nothing about a database it has no row for: the listing stands. Neither known:
 * undefined.
 */
export function currentDatabaseRuntime(listed: DatabaseRuntime | undefined, listedAt: number | undefined, sample?: { readonly at: number; readonly row: DatabaseStatusRow | undefined; readonly complete: boolean }): DatabaseRuntime | undefined {
  if (!sample || listed && listedAt !== undefined && sample.at <= listedAt) return listed
  const row = sample.row
  if (row) return { state: row.state, userAccess: row.userAccess, readOnly: row.readOnly, standby: row.standby }
  return sample.complete ? plainlyOnline : listed
}
/** A row of `explorer.progress`: a restore or a recovery that is running, and how far it has come. */
export interface ProgressRow { readonly name: string; readonly command: string; readonly percent: number }
/** A row of `explorer.availability`: an availability group's synchronization health and this replica's role. */
export interface GroupRow { readonly name: string; readonly health: number; readonly role: number }

/** One chip: its word on the node (`label`), the same for a screen reader (`words`, in the row's accessible name), and a
 *  sentence for its tooltip. `value`, the end or start of the label that a narrow row never cuts (a percentage, a count).
 *  `icon` undefined takes the tone's glyph. */
export interface StatusChip { readonly id: string; readonly tone: StatusTone; readonly label: string; readonly value?: string; readonly words: string; readonly title: string; readonly icon?: IconId | null }

/** sys.databases.state values that have a chip of their own; ONLINE (0) has none. Unknown future values say their number. */
const states: Readonly<Record<number, { label: string; words: string; tone: StatusTone; title: string }>> = {
  1: { label: 'RESTORING', words: 'Restoring', tone: 'running', title: 'The database is being restored, or waits for more backups to restore (WITH NORECOVERY).' },
  2: { label: 'RECOVERING', words: 'Recovering', tone: 'running', title: 'The database is recovering. It comes online when recovery ends.' },
  3: { label: 'RECOVERY PENDING', words: 'Recovery pending', tone: 'critical', title: 'Recovery could not start (a file or resource is missing). The database is not available.' },
  4: { label: 'SUSPECT', words: 'Suspect', tone: 'critical', title: 'Recovery failed: the database may be damaged and is not available.' },
  5: { label: 'EMERGENCY', words: 'Emergency', tone: 'critical', title: 'The database is in emergency mode: read-only, single user, for members of sysadmin.' },
  6: { label: 'OFFLINE', words: 'Offline', tone: 'warning', title: 'The database is offline. Bring it online to use it.' },
  7: { label: 'COPYING', words: 'Copying', tone: 'running', title: 'The database is being copied (Azure SQL Database copy).' },
  10: { label: 'OFFLINE', words: 'Offline', tone: 'warning', title: 'The database is an offline secondary.' }
}
const access: Readonly<Record<number, { label: string; words: string; title: string }>> = {
  1: { label: 'SINGLE USER', words: 'Single user', title: 'Only one connection at a time can use the database.' },
  2: { label: 'RESTRICTED USER', words: 'Restricted user', title: 'Only members of db_owner, dbcreator and sysadmin can use the database.' }
}
const percentText = (value: number) => `${Math.max(0, Math.min(100, Math.trunc(value)))} %`

/** A database's chips, in order: its state (with the progress of a running restore or recovery), read-only or standby,
 *  then user access. None when it is online, writable and open to everyone. */
export function databaseChips(row: DatabaseStatusRow | undefined, progress?: ProgressRow): StatusChip[] {
  const chips: StatusChip[] = []
  const state = row?.state ?? 0
  if (state !== 0 || progress) {
    const known = states[state]
    // A restore of a database another session holds RESTORING shows its progress; so does a recovery at startup.
    const base = known ?? (state === 0 ? (progress && /^RESTORE/.test(progress.command) ? states[1] : states[2]) : { label: `STATE ${state}`, words: `State ${state}`, tone: 'neutral' as const, title: `The database's state is ${state}.` })
    const running = progress ? percentText(progress.percent) : undefined
    // The running glyph turns only while a request makes progress: a database left RESTORING WITH NORECOVERY (a log-shipping
    // or mirroring secondary) can wait for months, and nothing is running then.
    chips.push({
      id: 'state', tone: base.tone, label: running ? `${base.label} ${running}` : base.label, words: running ? `${base.words} ${running}` : base.words,
      title: running ? `${base.title} ${progress!.command}: ${running} done.` : base.title, ...running ? { value: running } : base.tone === 'running' ? { icon: 'history' as const } : {}
    })
  }
  if (row?.standby) chips.push({ id: 'readOnly', tone: 'warning', label: 'STANDBY', words: 'Standby, read-only', title: 'The database is a log-shipping standby: read-only between log restores.', icon: 'lock' })
  else if (row?.readOnly) chips.push({ id: 'readOnly', tone: 'warning', label: 'READ-ONLY', words: 'Read-only', title: 'The database is read-only.', icon: 'lock' })
  const user = row ? access[row.userAccess] : undefined
  if (user) chips.push({ id: 'access', tone: 'warning', label: user.label, words: user.words, title: user.title, icon: 'person' })
  return chips
}

/** A login row's chips, static: the Logins listing's status (logins.ts loginStatusOf) and denial, never a probe's. Calm Pro
 *  states them in words beside the badge, and Connect denied looks different from Disabled. */
const loginStates = {
  disabled: { id: 'disabled', tone: 'neutral', label: 'DISABLED', words: 'Disabled', title: 'The login is disabled: new connections are refused; open sessions continue.', icon: 'arrow-small-down' },
  noAccess: { id: 'connectDenied', tone: 'warning', label: 'CONNECT DENIED', words: 'Permission to connect denied', title: 'CONNECT SQL is denied: the login cannot connect.', icon: 'circle-slash' }
} as const satisfies Readonly<Record<string, StatusChip>>
/** A login's chips: CONNECT DENIED for one denied permission to connect (status `noAccess`, or `disabled` with
 *  `connectDenied` when it is both: Enable alone would not let it connect), then DISABLED for a disabled login, none
 *  otherwise. The denial comes first because a narrow pane shows only the first chip, and a disabled login's badge already
 *  says Disabled. */
export function loginChips(status: string | undefined, connectDenied = false): StatusChip[] {
  const chips: StatusChip[] = []
  if (status === 'noAccess' || connectDenied) chips.push(loginStates.noAccess)
  if (status === 'disabled') chips.push(loginStates.disabled)
  return chips
}
/** Every chip a login can show, for docs/object-explorer.md. */
export const loginChipDocs: readonly { readonly status: string; readonly chip: string; readonly tone: string; readonly words: string; readonly title: string }[] =
  (Object.keys(loginStates) as (keyof typeof loginStates)[]).map(status => ({ status, chip: loginStates[status].label, tone: loginStates[status].tone, words: loginStates[status].words, title: loginStates[status].title }))

/** At most this many groups are named in the availability chip's tooltip. */
export const maxGroupLines = 10
const healthWords = ['not healthy', 'partially healthy', 'healthy'] as const
const roleWords = ['resolving', 'primary', 'secondary'] as const
const healthTones: readonly StatusTone[] = ['critical', 'warning', 'success']

/** The server's chips: running Agent jobs (none while no job runs), then availability group health (none without groups),
 *  summed up by the least healthy group. Group names are the server's own text; the renderer shows them through
 *  displayText. */
export function serverChips(runningJobs: number | null | undefined, groups: readonly GroupRow[] | undefined): StatusChip[] {
  const chips: StatusChip[] = []
  if (runningJobs !== null && runningJobs !== undefined && runningJobs > 0) {
    const count = Math.trunc(runningJobs), number = count.toLocaleString('en-US'), text = `${number} ${count === 1 ? 'job' : 'jobs'} running`
    // The label names the Agent, so it does not read as SSIS executions; the words already say "SQL Server Agent".
    // A still glyph: replication and change data capture agents run as jobs that never end, and a spinner would never stop.
    chips.push({ id: 'jobs', tone: 'running', label: `${number} Agent ${count === 1 ? 'job' : 'jobs'} running`, value: number, words: `SQL Server Agent: ${text}`, title: `SQL Server Agent: ${text}.`, icon: 'agent-job' })
  }
  if (groups && groups.length > 0) {
    const worst = Math.max(0, Math.min(2, Math.min(...groups.map(group => group.health))))
    const affected = groups.filter(group => Math.max(0, Math.min(2, group.health)) === worst)
    const subject = affected.length === 1 ? affected[0].name : `${affected.length} AGs`
    const label = `${subject} ${healthWords[worst]}`
    const lines = groups.slice(0, maxGroupLines).map(group => `${group.name}: ${healthWords[Math.max(0, Math.min(2, group.health))]}, ${roleWords[group.role] ?? roleWords[0]}`)
    if (groups.length > maxGroupLines) lines.push(`and ${groups.length - maxGroupLines} more`)
    chips.push({ id: 'availability', tone: healthTones[worst], label, words: `Availability groups: ${label}`, title: ['Availability groups', ...lines].join('\n'), icon: worst === 2 ? 'pass' : undefined })
  }
  return chips
}

/**
 * `explorer.agentService`'s sample: Agent XPs (`value_in_use`, 0 or 1), the service's state as sys.dm_server_services reports
 * it (1 stopped, 2 start pending, 3 stop pending, 4 running, 5 continue pending, 6 pause pending, 7 paused) and its startup
 * type (2 automatic, 3 manual, 4 disabled). A value the login may not read is undefined: unknown, never guessed.
 */
/** `clustered`: SERVERPROPERTY('IsClustered'), a failover cluster instance, whose service verbs grey up front (AG-10). */
export interface AgentServiceState { readonly xps?: number; readonly state?: number; readonly startup?: number; readonly clustered?: boolean }
/** The Agent service states with a chip of their own; Running (4) has none. */
const agentStates: Readonly<Record<number, { label: string; words: string; tone: StatusTone; title: string }>> = {
  1: { label: 'STOPPED', words: 'Stopped', tone: 'warning', title: 'SQL Server Agent is stopped: jobs, alerts and schedules do not run.' },
  2: { label: 'STARTING', words: 'Starting', tone: 'running', title: 'SQL Server Agent is starting.' },
  3: { label: 'STOPPING', words: 'Stopping', tone: 'running', title: 'SQL Server Agent is stopping.' },
  5: { label: 'RESUMING', words: 'Resuming', tone: 'running', title: 'SQL Server Agent is resuming.' },
  6: { label: 'PAUSING', words: 'Pausing', tone: 'running', title: 'SQL Server Agent is pausing.' },
  7: { label: 'PAUSED', words: 'Paused', tone: 'warning', title: 'SQL Server Agent is paused.' }
}
/** The SQL Server Agent node's sublabel while Agent XPs is 0. */
export const agentXpsSublabel = 'Agent XPs disabled'
/**
 * The SQL Server Agent node's chips and sublabel: its service state when it is not running (unknown shows none), the jobs
 * running (as the server's chip counts them), and "Agent XPs disabled" while that option is 0.
 */
export function agentChips(service: AgentServiceState | undefined, runningJobs: number | null | undefined): { readonly chips: StatusChip[]; readonly sublabel?: string } {
  const chips: StatusChip[] = []
  const state = service?.state === undefined ? undefined : agentStates[service.state]
  if (state) chips.push({ id: 'service', tone: state.tone, label: state.label, words: state.words, title: state.title })
  if (runningJobs !== null && runningJobs !== undefined && runningJobs > 0) {
    const count = Math.trunc(runningJobs), number = count.toLocaleString('en-US'), text = `${number} ${count === 1 ? 'job' : 'jobs'} running`
    chips.push({ id: 'jobs', tone: 'running', label: text, value: number, words: text, title: `SQL Server Agent: ${text}.`, icon: 'agent-job' })
  }
  return service?.xps === 0 ? { chips, sublabel: agentXpsSublabel } : { chips }
}

/** A job row of `agent.jobs.list` as a chip reads it: its cells' texts (Job Activity Monitor's columns, src/shared/live/catalog.ts). */
export interface AgentJobStatusRow { readonly enabled: string | null; readonly status: string | null; readonly step: string | null; readonly lastOutcome: string | null }
/** The job states with a chip, by `sp_help_job`'s execution status label (src/shared/agent/catalog.ts executionStatuses); Idle and
 *  a multi-server job's untracked state have none. Running statuses carry the step, as the mock's "Running · step 2/4". */
const agentJobStates: Readonly<Record<string, { label: string; words: string; tone: StatusTone; running: boolean }>> = {
  'Executing': { label: 'Running', words: 'Running', tone: 'running', running: true },
  'Waiting for worker thread': { label: 'Running', words: 'Running, waiting for a worker thread', tone: 'running', running: true },
  'Performing completion actions': { label: 'Running', words: 'Running, performing completion actions', tone: 'running', running: true },
  'Between retries': { label: 'Between retries', words: 'Between retries', tone: 'warning', running: false },
  'Suspended': { label: 'Suspended', words: 'Suspended', tone: 'warning', running: false }
}
/** Job Activity Monitor's Step cell ("Step 2 of 4 · Rebuild", AgentJobsReader): the step, the step count when known, and its name. */
const stepPattern = /^Step (\d+)(?: of (\d+))?(?: · ([\s\S]*))?$/
/**
 * A job row's live chips (AG-12), from Job Activity Monitor's own `agent.jobs` read: Running with its step ("Running · step 2/4"),
 * Between retries or Suspended while that is its execution status, else Failed when its last run failed; and whether it is
 * enabled (undefined when the cell is not one the read writes). What Agent is doing now is not current while Agent cannot run
 * jobs (`live` false: stopped, Agent XPs off, or neither readable), so only the last outcome, which msdb keeps, shows then.
 */
export function agentJobChips(row: AgentJobStatusRow, live: boolean): { readonly chips: StatusChip[]; readonly enabled?: boolean } {
  const chips: StatusChip[] = []
  const state = live && row.status !== null && Object.hasOwn(agentJobStates, row.status) ? agentJobStates[row.status] : undefined
  if (state) {
    const step = state.running && row.step ? stepPattern.exec(row.step) : null
    const label = step ? `${state.label} · step ${step[1]}${step[2] ? '/' + step[2] : ''}` : state.label
    const words = step ? `${state.words}, step ${step[1]}${step[2] ? ' of ' + step[2] : ''}` : state.words
    const title = `${row.status}${step ? `: step ${step[1]}${step[2] ? ' of ' + step[2] : ''}${step[3] ? ` (${step[3]})` : ''}` : ''}.`
    // A still glyph, as the server's running-jobs chip: a job that never ends (a replication agent) would spin for ever.
    chips.push({ id: 'state', tone: state.tone, label, words, title, ...state.running ? { icon: 'agent-job' as const } : {} })
  } else if (row.lastOutcome === 'Failed') chips.push({ id: 'state', tone: 'critical', label: 'Failed', words: 'Last run failed', title: 'The job\'s last run failed.' })
  const enabled = row.enabled === 'Yes' ? true : row.enabled === 'No' ? false : undefined
  return enabled === undefined ? { chips } : { chips, enabled }
}

/** Every chip a database or server can show, for docs/object-explorer.md. */
export const statusChipDocs: readonly { readonly kind: 'server' | 'database' | 'agent' | 'agentJob'; readonly chip: string; readonly tone: string; readonly when: string }[] = [
  ...Object.entries(states).filter(([state]) => state !== '10').map(([state, value]) => ({ kind: 'database' as const, chip: value.label + (value.tone === 'running' && state !== '7' ? ' n %' : ''), tone: value.tone, when: `state ${state}${state === '6' ? ' or 10' : ''}: ${value.title}` })),
  { kind: 'database', chip: 'READ-ONLY / STANDBY', tone: 'warning', when: 'is_read_only, or is_in_standby (a log-shipping standby)' },
  { kind: 'database', chip: 'SINGLE USER / RESTRICTED USER', tone: 'warning', when: 'user_access 1 or 2' },
  { kind: 'server', chip: 'n Agent jobs running', tone: 'running', when: 'SQL Server Agent jobs of its current session that started and have not stopped (none while none runs)' },
  { kind: 'server', chip: '<group> healthy / partially healthy / not healthy', tone: 'success, warning, critical', when: 'the least healthy availability group (several: "n AGs …"); its tooltip names each group with its health and this replica\'s role' },
  ...Object.entries(agentStates).map(([state, value]) => ({ kind: 'agent' as const, chip: value.label, tone: value.tone, when: `the Agent service's state ${state}: ${value.title}` })),
  { kind: 'agent', chip: 'n jobs running', tone: 'running', when: 'as the server\'s chip; the node\'s sublabel says "Agent XPs disabled" while that option is 0, and an unknown service state shows no chip' },
  { kind: 'agentJob', chip: 'Running · step n/m', tone: 'running', when: 'the job is executing, waiting for a worker thread or performing completion actions (Job Activity Monitor\'s agent.jobs read, while its Jobs folder is open); the step count where msdb gives it' },
  { kind: 'agentJob', chip: 'Between retries / Suspended', tone: 'warning', when: 'that is the job\'s execution status' },
  { kind: 'agentJob', chip: 'Failed', tone: 'critical', when: 'the job is not running and its last run failed. While SQL Server Agent cannot run jobs (stopped, Agent XPs off, or neither readable) only this chip shows. A job the read finds disabled, or enabled, is dimmed with the disabled badge, or not, unless the row was listed after that read (a Disable or Enable lists it again at once), until the next read' }
]

/** A job row's status as its live read shows it (AG-12): disabled when the read found it disabled, not when it found it
 *  enabled, unless the row was listed after that read (a Disable or Enable lists it again at once); otherwise the listing's.
 *  The row and its menu (Enable Job or Disable Job) both follow it. */
export function liveJobStatus(listed: NodeStatus | undefined, listedAt: number | undefined, live: { readonly enabled?: boolean; readonly enabledAt?: number } | undefined): NodeStatus | undefined {
  if (live?.enabled === undefined || (live.enabledAt !== undefined && listedAt !== undefined && live.enabledAt <= listedAt)) return listed
  return live.enabled ? (listed === 'disabled' ? undefined : listed) : 'disabled'
}
