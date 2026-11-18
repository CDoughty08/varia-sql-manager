// SQL Server Agent: msdb's code tables with SSMS's names, the platform gates, the decoding of msdb's integer dates, times
// and durations, the limits, and the msdb and master procedures the backend may call (docs/agent-plan.md › Catalogue). It
// is the only declaration of Agent semantics: docs/sql-server-agent.md's reference part is generated from it, and the
// backend embeds agentCatalogJson() as Agent/agent-catalog.json (a vitest file snapshot keeps that copy in sync), so C#
// holds no Agent procedure list or bound of its own. Nothing here is registered yet: methods, context keys, commands,
// menus, Explorer kinds and actions come in later lanes (AG-0b onwards). Erasable TypeScript (no enums), so Node's type
// stripping can load it too.

export interface CodeLabel {
  readonly code: number
  readonly label: string
}
export type AgentTone = 'error' | 'accent' | 'warning' | 'muted' | 'success'
export interface ToneCodeLabel extends CodeLabel {
  readonly tone?: AgentTone
}

/** `sysjobhistory.run_status` (and `sp_help_jobhistory`'s): a step's or a job's outcome. */
export const runStatuses: readonly ToneCodeLabel[] = [
  { code: 0, label: 'Failed', tone: 'error' },
  { code: 1, label: 'Succeeded', tone: 'success' },
  { code: 2, label: 'Retry', tone: 'warning' },
  { code: 3, label: 'Canceled', tone: 'muted' },
  { code: 4, label: 'In Progress', tone: 'accent' }
]

/** `sp_help_job`'s `last_run_outcome`: 5 when the job has never run (or its outcome was purged). */
export const lastRunOutcomes: readonly ToneCodeLabel[] = [
  { code: 0, label: 'Failed', tone: 'error' },
  { code: 1, label: 'Succeeded', tone: 'success' },
  { code: 3, label: 'Canceled', tone: 'muted' },
  { code: 5, label: 'Unknown' }
]

/** `sp_help_job`'s `current_execution_status`, with Job Activity Monitor's Status names. 6 (obsolete) is never returned. */
export const executionStatuses: readonly ToneCodeLabel[] = [
  { code: 1, label: 'Executing', tone: 'accent' },
  { code: 2, label: 'Waiting for worker thread', tone: 'accent' },
  { code: 3, label: 'Between retries', tone: 'warning' },
  { code: 4, label: 'Idle' },
  { code: 5, label: 'Suspended', tone: 'warning' },
  { code: 7, label: 'Performing completion actions', tone: 'accent' }
]
/** The execution statuses Job Activity Monitor counts as running (its Running tile and chip). */
export const runningExecutionStatuses = [1, 2, 3, 7] as const

export interface Subsystem {
  /** `syssubsystems.subsystem`, as msdb spells it (and `sp_add_jobstep @subsystem` takes it). */
  readonly id: string
  /** SSMS's Type name in the step editor. */
  readonly label: string
}
/** Step types in SSMS's order. Which ones a server offers is read from `syssubsystems`, never assumed per platform; the
 *  platform gates below only hide ones a platform cannot run. */
export const subsystems: readonly Subsystem[] = [
  { id: 'TSQL', label: 'Transact-SQL script (T-SQL)' },
  { id: 'CmdExec', label: 'Operating system (CmdExec)' },
  { id: 'PowerShell', label: 'PowerShell' },
  { id: 'SSIS', label: 'SQL Server Integration Services Package' },
  { id: 'ANALYSISCOMMAND', label: 'SQL Server Analysis Services Command' },
  { id: 'ANALYSISQUERY', label: 'SQL Server Analysis Services Query' },
  { id: 'Distribution', label: 'Replication Distributor' },
  { id: 'Merge', label: 'Replication Merge' },
  { id: 'QueueReader', label: 'Replication Queue Reader' },
  { id: 'Snapshot', label: 'Replication Snapshot' },
  { id: 'LogReader', label: 'Replication Transaction-Log Reader' }
]
export type SubsystemId = typeof subsystems[number]['id']

/** `sysjobsteps.on_success_action` and `on_fail_action`; 4 goes to `on_success_step_id` / `on_fail_step_id`. */
export const stepActions: readonly CodeLabel[] = [
  { code: 1, label: 'Quit the job reporting success' },
  { code: 2, label: 'Quit the job reporting failure' },
  { code: 3, label: 'Go to the next step' },
  { code: 4, label: 'Go to step' }
]

/** `sysjobsteps.flags` bits Varia models, as SSMS scripts them: Log to table alone is 8, with Append 16 (never 24). Every
 *  other bit (such as 32 and 64) is carried through a save unchanged. */
export const stepFlags = {
  appendOutputFile: 2,
  includeStepOutputInHistory: 4,
  logToTable: 8,
  logToTableAppend: 16
} as const
/** The bits `stepFlags` owns; a save keeps `flags & ~stepFlagMask` as read. */
export const stepFlagMask = 2 | 4 | 8 | 16

/** `sysschedules.freq_type`, with SSMS's Schedule type names. */
export const frequencyTypes: readonly CodeLabel[] = [
  { code: 1, label: 'One time' },
  { code: 4, label: 'Daily' },
  { code: 8, label: 'Weekly' },
  { code: 16, label: 'Monthly' },
  { code: 32, label: 'Monthly, relative' },
  { code: 64, label: 'Start automatically when SQL Server Agent starts' },
  { code: 128, label: 'Start whenever the CPUs become idle' }
]
/** `sysschedules.freq_subday_type`. */
export const subdayTypes: readonly CodeLabel[] = [
  { code: 1, label: 'At the specified time' },
  { code: 2, label: 'Seconds' },
  { code: 4, label: 'Minutes' },
  { code: 8, label: 'Hours' }
]
/** `sysschedules.freq_relative_interval` (monthly relative schedules). */
export const relativeIntervals: readonly CodeLabel[] = [
  { code: 1, label: 'First' },
  { code: 2, label: 'Second' },
  { code: 4, label: 'Third' },
  { code: 8, label: 'Fourth' },
  { code: 16, label: 'Last' }
]
/** `freq_interval` of a weekly schedule: a bit per day, Sunday first. */
export const weekDays: readonly CodeLabel[] = [
  { code: 1, label: 'Sunday' },
  { code: 2, label: 'Monday' },
  { code: 4, label: 'Tuesday' },
  { code: 8, label: 'Wednesday' },
  { code: 16, label: 'Thursday' },
  { code: 32, label: 'Friday' },
  { code: 64, label: 'Saturday' }
]
/** `freq_interval` of a monthly relative schedule. */
export const relativeDays: readonly CodeLabel[] = [
  { code: 1, label: 'Sunday' },
  { code: 2, label: 'Monday' },
  { code: 3, label: 'Tuesday' },
  { code: 4, label: 'Wednesday' },
  { code: 5, label: 'Thursday' },
  { code: 6, label: 'Friday' },
  { code: 7, label: 'Saturday' },
  { code: 8, label: 'Day' },
  { code: 9, label: 'Weekday' },
  { code: 10, label: 'Weekend day' }
]

/** `sysjobs.notify_level_*` and `delete_level`, with SSMS's When names. */
export const notifyLevels: readonly CodeLabel[] = [
  { code: 0, label: 'Never' },
  { code: 1, label: 'When the job succeeds' },
  { code: 2, label: 'When the job fails' },
  { code: 3, label: 'When the job completes' }
]
/** `sp_help_alert`'s `type`. */
export const alertTypes: readonly CodeLabel[] = [
  { code: 1, label: 'SQL Server event alert' },
  { code: 2, label: 'SQL Server performance condition alert' },
  { code: 3, label: 'WMI event alert' }
]
/** `sysnotifications.notification_method` bits. */
export const notificationMethods: readonly CodeLabel[] = [
  { code: 1, label: 'E-mail' },
  { code: 2, label: 'Pager' },
  { code: 4, label: 'Net send' }
]

/** The Agent roles in msdb, lowest first (each is a member of the one before). */
export const agentRoles = ['SQLAgentUserRole', 'SQLAgentReaderRole', 'SQLAgentOperatorRole'] as const

// --- Servers and platform gates -------------------------------------------------------------------------------------

/** Where the Agent node shows, by `SERVERPROPERTY('EngineEdition')`: Standard, Enterprise (and Developer), Personal and
 *  Managed Instance. Express (4) has no Agent service, and the cloud editions have no Agent at all. */
export const agentEngineEditions = [1, 2, 3, 8] as const
export type AgentPlatform = 'windows' | 'linux' | 'managedInstance'
export const agentPlatforms = ['windows', 'linux', 'managedInstance'] as const satisfies readonly AgentPlatform[]

export const agentFeatures = [
  'alerts',
  'proxies',
  'eventAlerts',
  'performanceAlerts',
  'wmiAlerts',
  'cpuIdleSchedules',
  'emailNotifications',
  'pagerNotifications',
  'netSendNotifications',
  'eventLogNotifications',
  'errorLogs',
  'errorLogArchives',
  'agentPropertiesWrite',
  'windowsCredentials',
  'serviceControl',
  'multiServerTargets'
] as const
export type AgentFeature = typeof agentFeatures[number]

export interface AgentGate {
  readonly title: string
  /** The platforms that offer it. */
  readonly platforms: readonly AgentPlatform[]
  readonly note?: string
}
/** One row per feature the platforms differ on (docs/agent-plan.md › Servers and platform gates): the tree, documents and
 *  menus read these, and nothing hard-codes a platform. AG-1 verifies them, Linux against the CI container and Managed
 *  Instance from Microsoft's documentation. */
export const agentPlatformGates: { readonly [F in AgentFeature]: AgentGate } = {
  alerts: { title: 'Alerts folder, the job Alerts section, New › Alert and operators\' alert notifications', platforms: ['windows'] },
  proxies: { title: 'Proxies folder', platforms: ['windows', 'linux'], note: 'Linux lists the subsystems `syssubsystems` has.' },
  eventAlerts: { title: 'SQL Server event alerts', platforms: ['windows'] },
  performanceAlerts: { title: 'Performance condition alerts', platforms: ['windows'] },
  wmiAlerts: { title: 'WMI event alerts', platforms: ['windows'] },
  cpuIdleSchedules: { title: 'Start whenever the CPUs become idle schedules', platforms: ['windows', 'linux'] },
  emailNotifications: { title: 'E-mail notifications', platforms: ['windows', 'linux', 'managedInstance'], note: 'Managed Instance sends only through the Database Mail profile `AzureManagedInstance_dbmail_profile`.' },
  pagerNotifications: { title: 'Pager notifications', platforms: ['windows', 'linux'] },
  netSendNotifications: { title: 'Net send notifications', platforms: ['windows'] },
  eventLogNotifications: { title: 'Write to the Windows Application event log', platforms: ['windows'] },
  errorLogs: { title: 'Agent error logs', platforms: ['windows', 'linux', 'managedInstance'], note: 'Managed Instance reads them through `sp_readmierrorlog`; the others through `xp_readerrorlog`.' },
  errorLogArchives: { title: 'Agent error log archives (`xp_enumerrorlogs`)', platforms: ['windows', 'linux'], note: 'Managed Instance shows Current only until a Managed Instance check shows archives list there.' },
  agentPropertiesWrite: { title: 'Changing SQL Server Agent Properties', platforms: ['windows', 'linux'] },
  windowsCredentials: { title: 'Credentials with a Windows identity', platforms: ['windows', 'linux'] },
  serviceControl: { title: 'Start, Stop and Restart of the Agent service', platforms: ['windows'], note: 'Not on a failover cluster instance (`SERVERPROPERTY(\'IsClustered\') = 1`), where the cluster owns the service.' },
  multiServerTargets: { title: 'Multi-server (MSX/TSX) targets', platforms: [], note: 'Later on every platform; the Targets section shows the local server only.' }
}

/** Step types a platform can run at all; a server offers the ones of these its `syssubsystems` lists. */
export const platformSubsystems: { readonly [P in AgentPlatform]: readonly SubsystemId[] } = {
  windows: subsystems.map(subsystem => subsystem.id),
  linux: ['TSQL', 'Distribution', 'Snapshot', 'LogReader'],
  managedInstance: ['TSQL', 'SSIS', 'Distribution', 'Snapshot', 'LogReader']
}

/** Whether a platform offers a feature. */
export const agentGateOpen = (feature: AgentFeature, platform: AgentPlatform): boolean => agentPlatformGates[feature].platforms.includes(platform)
/** The platform of a server, from its engine edition and whether it runs on Linux; null where Agent is not served. */
export function agentPlatform(engineEdition: number, linux: boolean): AgentPlatform | null {
  if (!(agentEngineEditions as readonly number[]).includes(engineEdition)) return null
  if (engineEdition === 8) return 'managedInstance'
  return linux ? 'linux' : 'windows'
}

// --- Dates, times and durations -------------------------------------------------------------------------------------

/** A server-local date and time as msdb stores them (no time zone). */
export interface AgentDateTime {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

/** `run_date`, `next_run_date`, `active_start_date` (yyyymmdd) as year, month and day; null for 0 (never) or a value that is
 *  not a calendar date. */
export function decodeAgentDate(value: number | null | undefined): { year: number, month: number, day: number } | null {
  if (value == null || !Number.isInteger(value) || value <= 0 || value > 99_991_231) return null
  const year = Math.floor(value / 10_000), month = Math.floor(value / 100) % 100, day = value % 100
  if (year < 1900 || month < 1 || month > 12 || day < 1) return null
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day <= days ? { year, month, day } : null
}

/** `run_time`, `next_run_time`, `active_start_time` (hhmmss) as seconds since midnight; null when it is not a time of day. */
export function decodeAgentTime(value: number | null | undefined): number | null {
  if (value == null || !Number.isInteger(value) || value < 0 || value > 235_959) return null
  const hour = Math.floor(value / 10_000), minute = Math.floor(value / 100) % 100, second = value % 100
  return minute < 60 && second < 60 ? hour * 3600 + minute * 60 + second : null
}

/** `run_duration` (hhmmss, with hours past 99 as more leading digits) as seconds; null when it is not a duration. */
export function decodeAgentDuration(value: number | null | undefined): number | null {
  if (value == null || !Number.isInteger(value) || value < 0) return null
  const hours = Math.floor(value / 10_000), minute = Math.floor(value / 100) % 100, second = value % 100
  return minute < 60 && second < 60 ? hours * 3600 + minute * 60 + second : null
}

/** A date and a time column together (a job's last or next run, a history row's start); null when either is not set. A
 *  time with no date is meaningless, so 0 / 0 (never) is null. */
export function decodeAgentDateTime(date: number | null | undefined, time: number | null | undefined): AgentDateTime | null {
  const day = decodeAgentDate(date), seconds = decodeAgentTime(time)
  if (!day || seconds == null) return null
  return { ...day, hour: Math.floor(seconds / 3600), minute: Math.floor(seconds / 60) % 60, second: seconds % 60 }
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0')
/** SSMS's duration text, HH:MM:SS, with as many hour digits as needed ("123:04:05"). */
export function formatAgentDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}`
}
/** An ISO-style local text, "yyyy-mm-dd hh:mm:ss", for sorting and copying; the UI formats it for the locale. */
export function formatAgentDateTime(value: AgentDateTime): string {
  return `${pad(value.year, 4)}-${pad(value.month)}-${pad(value.day)} ${pad(value.hour)}:${pad(value.minute)}:${pad(value.second)}`
}

// --- Limits ---------------------------------------------------------------------------------------------------------

/** Every Agent bound in one place; zod, C# and the docs read these (zod and C# mirrors come with the methods that use them). */
export const agentLimits = {
  /** Jobs one listing (tree folder, Job Activity Monitor) holds; more set `truncated`. */
  listRows: 5_000,
  /** History rows one history read holds, newest first; more set `truncated`. */
  historyRows: 10_000,
  /** Jobs one history filter or one Delete History names (each a call in one transaction, so a save stays under 255 calls). */
  historyJobs: 64,
  /** Error log rows one read holds, newest first; the rest are cancelled and a notice says so. */
  logRows: 10_000,
  /** Characters of a history or error log search text. */
  searchChars: 200,
  /** Characters of a history message shown in a grid cell; the details pane reads the whole message. */
  gridMessageChars: 512,
  /** Characters `sp_help_jobhistory` returns of a message to logins that read history through it. */
  roleMessageChars: 1_024,
  /** Characters `sysjobhistory.message` holds. */
  messageChars: 4_000,
  /** UTF-16 code units in an Agent object's name (sysname). */
  nameChars: 128,
  /** Steps one job save may hold. */
  stepsPerJob: 50,
  /** Schedules one job save may hold. */
  schedulesPerJob: 16,
  /** Jobs one standalone schedule save may attach or detach. */
  scheduleJobChanges: 64,
  /** Jobs one Start, Stop, Enable or Disable from Job Activity Monitor may name (one request per job). */
  startJobs: 100,
  /** Jobs the status bar watches with live progress; more join one summary item. */
  watchedJobs: 3,
  /** One `xp_servicecontrol` Start or Stop, as its command timeout, in ms. */
  serviceStatementMs: 30_000,
  /** How long a Start or Stop waits for the service to reach its state, in ms. */
  serviceWaitMs: 60_000,
  /** One `xp_servicecontrol N'QueryState'` read, in ms. */
  serviceReadMs: 10_000,
  /** How long the live checks wait for Agent to come up after the server does, in ms. */
  agentUpWaitMs: 120_000
} as const
export type AgentLimit = keyof typeof agentLimits

/** THROW states carry a save's call index, 1 to 255, so a save's calls stay below this, guards included. */
export const agentCallIndexLimit = 255
/** The most calls one job save can make at its caps: per step a temporary rename and a final update (or an add and an
 *  update), per schedule an attach or detach plus an add, and the job's own calls and guards. */
export const agentJobSaveCalls = agentLimits.stepsPerJob * 2 + agentLimits.schedulesPerJob * 2 + 8

// --- Procedures -----------------------------------------------------------------------------------------------------

export interface ReadArgument {
  /** The procedure's parameter, passed by name. */
  readonly name: string
  /** Constants the argument may take instead of a parameter (as SQL text); none means parameters only. */
  readonly constants?: readonly string[]
}
export interface ReadProcedure {
  readonly name: string
  readonly arguments: readonly ReadArgument[]
  /** Which logins may run it, for the docs; the server's own refusal is still a value. */
  readonly who: string
}

/** The msdb procedures an Agent read may `EXEC` (`AgentSql.LintRead`): exactly `EXEC msdb.dbo.<name> @arg = @param, …;`
 *  with named arguments, each a parameter or one of its listed constants. */
export const readProcedures: readonly ReadProcedure[] = [
  { name: 'sp_help_job', arguments: [{ name: '@job_id' }, { name: '@job_aspect', constants: ["N'JOB'"] }], who: 'Every Agent role (its own jobs for SQLAgentUserRole)' },
  { name: 'sp_help_jobhistory', arguments: [{ name: '@job_id' }, { name: '@step_id' }, { name: '@run_status' }, { name: '@start_run_date' }, { name: '@end_run_date' }, { name: '@mode', constants: ["N'FULL'"] }], who: 'Every Agent role' },
  { name: 'sp_help_jobactivity', arguments: [{ name: '@job_id' }, { name: '@session_id' }], who: 'Every Agent role' },
  { name: 'sp_help_jobstep', arguments: [{ name: '@job_id' }, { name: '@step_id' }], who: 'Every Agent role' },
  { name: 'sp_help_jobschedule', arguments: [{ name: '@job_id' }, { name: '@schedule_id' }, { name: '@include_description', constants: ['1'] }], who: 'Every Agent role' },
  { name: 'sp_help_schedule', arguments: [{ name: '@schedule_id' }, { name: '@include_description', constants: ['1'] }], who: 'Every Agent role' },
  { name: 'sp_help_category', arguments: [{ name: '@class', constants: ["N'JOB'", "N'ALERT'", "N'OPERATOR'"] }], who: 'Every Agent role' },
  { name: 'sp_help_operator', arguments: [{ name: '@operator_id' }], who: 'Every Agent role (msdb grants SQLAgentUserRole EXECUTE)' },
  { name: 'sp_help_alert', arguments: [{ name: '@alert_id' }], who: 'SQLAgentOperatorRole and sysadmin' },
  { name: 'sp_help_notification', arguments: [{ name: '@object_type', constants: ["N'ALERTS'", "N'OPERATORS'"] }, { name: '@name' }, { name: '@enum_type', constants: ["N'ACTUAL'", "N'ALL'"] }, { name: '@notification_method', constants: ['7'] }], who: 'SQLAgentOperatorRole and sysadmin' },
  { name: 'sp_help_proxy', arguments: [{ name: '@proxy_id' }, { name: '@subsystem_name' }], who: 'Every Agent role (proxies granted to it below sysadmin)' },
  { name: 'sp_enum_login_for_proxy', arguments: [{ name: '@proxy_id' }], who: 'SQLAgentOperatorRole and sysadmin' },
  { name: 'sp_help_jobs_in_schedule', arguments: [{ name: '@schedule_id' }], who: 'Every Agent role (its own jobs for SQLAgentUserRole)' },
  { name: 'sp_enum_sqlagent_subsystems', arguments: [], who: 'Every Agent role' },
  { name: 'sp_get_sqlagent_properties', arguments: [], who: 'Every Agent role (AG-0: SQLAgentUserRole gets values); fails with 15281 while Agent XPs is off' }
]

export interface MasterReadShape {
  readonly name: string
  /** The exact statement; `@p` stands for any parameter. */
  readonly shape: string
  readonly who: string
}
/** The master procedures an Agent read may call, each in exactly this positional shape: log type 2 is the Agent log, `NULL`
 *  leaves the time bounds open, and `N'desc'` reads newest first so a cap keeps the newest rows. */
export const masterReadShapes: readonly MasterReadShape[] = [
  { name: 'xp_enumerrorlogs', shape: 'EXEC master.dbo.xp_enumerrorlogs 2;', who: 'sysadmin' },
  { name: 'xp_readerrorlog', shape: "EXEC master.dbo.xp_readerrorlog @p, 2, @p, @p, NULL, NULL, N'desc';", who: 'sysadmin' },
  { name: 'sp_readmierrorlog', shape: 'EXEC master.dbo.sp_readmierrorlog @p, 2, @p, @p;', who: 'Managed Instance; sysadmin' },
  { name: 'xp_servicecontrol', shape: "EXEC @rc = master.dbo.xp_servicecontrol N'QueryState', N'SQLServerAgent';", who: 'sysadmin' }
]

export type AgentLane = 'AG-2' | 'AG-5b' | 'AG-6a' | 'AG-6b' | 'AG-6c' | 'AG-7' | 'AG-8a' | 'AG-8b'
export interface WriteProcedure {
  readonly name: string
  readonly lane: AgentLane
  /** `master` for the service control call; msdb otherwise. */
  readonly database: 'msdb' | 'master'
}
/** Every procedure `AgentSql.LintExecutable` (AG-2) will admit, with the lane that brings its template. */
export const writeProcedures: readonly WriteProcedure[] = [
  { name: 'sp_start_job', lane: 'AG-2', database: 'msdb' },
  { name: 'sp_stop_job', lane: 'AG-2', database: 'msdb' },
  { name: 'sp_update_job', lane: 'AG-2', database: 'msdb' },
  { name: 'sp_delete_job', lane: 'AG-2', database: 'msdb' },
  { name: 'xp_servicecontrol', lane: 'AG-2', database: 'master' },
  { name: 'sp_purge_jobhistory', lane: 'AG-6a', database: 'msdb' },
  { name: 'sp_add_job', lane: 'AG-6a', database: 'msdb' },
  { name: 'sp_add_jobserver', lane: 'AG-6a', database: 'msdb' },
  { name: 'sp_update_alert', lane: 'AG-6a', database: 'msdb' },
  { name: 'sp_add_jobstep', lane: 'AG-6b', database: 'msdb' },
  { name: 'sp_update_jobstep', lane: 'AG-6b', database: 'msdb' },
  { name: 'sp_delete_jobstep', lane: 'AG-6b', database: 'msdb' },
  { name: 'sp_add_jobschedule', lane: 'AG-6c', database: 'msdb' },
  { name: 'sp_attach_schedule', lane: 'AG-6c', database: 'msdb' },
  { name: 'sp_detach_schedule', lane: 'AG-6c', database: 'msdb' },
  { name: 'sp_add_schedule', lane: 'AG-6c', database: 'msdb' },
  { name: 'sp_update_schedule', lane: 'AG-6c', database: 'msdb' },
  { name: 'sp_delete_schedule', lane: 'AG-6c', database: 'msdb' },
  { name: 'sp_add_operator', lane: 'AG-7', database: 'msdb' },
  { name: 'sp_update_operator', lane: 'AG-7', database: 'msdb' },
  { name: 'sp_delete_operator', lane: 'AG-7', database: 'msdb' },
  { name: 'sp_add_alert', lane: 'AG-7', database: 'msdb' },
  { name: 'sp_delete_alert', lane: 'AG-7', database: 'msdb' },
  { name: 'sp_add_notification', lane: 'AG-7', database: 'msdb' },
  { name: 'sp_update_notification', lane: 'AG-7', database: 'msdb' },
  { name: 'sp_delete_notification', lane: 'AG-7', database: 'msdb' },
  { name: 'sp_set_sqlagent_properties', lane: 'AG-8a', database: 'msdb' },
  { name: 'sp_add_proxy', lane: 'AG-8b', database: 'msdb' },
  { name: 'sp_update_proxy', lane: 'AG-8b', database: 'msdb' },
  { name: 'sp_delete_proxy', lane: 'AG-8b', database: 'msdb' },
  { name: 'sp_grant_proxy_to_subsystem', lane: 'AG-8b', database: 'msdb' },
  { name: 'sp_revoke_proxy_from_subsystem', lane: 'AG-8b', database: 'msdb' },
  { name: 'sp_grant_login_to_proxy', lane: 'AG-8b', database: 'msdb' },
  { name: 'sp_revoke_login_from_proxy', lane: 'AG-8b', database: 'msdb' },
  { name: 'sp_cycle_agent_errorlog', lane: 'AG-5b', database: 'msdb' }
]

/** msdb's error numbers as AG-0 found them on SQL Server 2025, for the action mapping (AG-2). 22022 is not mapped by
 *  number: every Agent refusal of a start or stop raises it, so the action re-reads the state instead. */
export const agentErrorNumbers: readonly { readonly number: number, readonly code: string, readonly meaning: string }[] = [
  { number: 14261, code: 'NAME_IN_USE', meaning: 'The name is already in use (a job, or a step within its job).' },
  { number: 14262, code: 'NOT_FOUND', meaning: 'An id or name does not exist (a job, or a step\'s database).' },
  { number: 14234, code: 'SQL_ERROR', meaning: 'An argument is not valid (such as an owner login that does not exist).' },
  { number: 14266, code: 'SQL_ERROR', meaning: 'An argument is not one of its valid values (such as a schedule\'s frequency type).' },
  { number: 14372, code: 'IN_USE', meaning: 'A schedule is still used by a job.' },
  { number: 15281, code: 'AGENT_STOPPED', meaning: 'Agent XPs is off (SQL Server Agent is stopped or disabled).' },
  { number: 22022, code: 'JOB_STATE', meaning: 'SQL Server Agent refused a start or stop; decided by a re-read, never by number.' },
  { number: 22003, code: 'SQL_ERROR', meaning: 'Every `xp_servicecontrol` failure; the Windows code is in its text ("returned error 5" is access denied).' }
]

// --- Catalogue JSON -------------------------------------------------------------------------------------------------

export const agentCatalogVersion = 1

// Compact sorted-key JSON, as in explorerCatalogJson(), so each entry diffs as one line.
const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sortKeys(item)]))
  : value
const line = (value: unknown) => JSON.stringify(sortKeys(value))
const block = (items: readonly unknown[]) => '[\n' + items.map(item => '    ' + line(item)).join(',\n') + '\n  ]'

/** The catalogue as the backend embeds it, keys sorted, so C# holds no Agent procedure list or bound of its own. */
export function agentCatalogJson(): string {
  return [
    '{',
    `  "engineEditions": ${line(agentEngineEditions)},`,
    `  "executionStatuses": ${block(executionStatuses)},`,
    `  "gates": ${block(agentFeatures.map(feature => ({ feature, platforms: agentPlatformGates[feature].platforms })))},`,
    `  "lastRunOutcomes": ${block(lastRunOutcomes)},`,
    `  "limits": ${line(agentLimits)},`,
    `  "masterReadShapes": ${block(masterReadShapes.map(({ name, shape }) => ({ name, shape })))},`,
    `  "platformSubsystems": ${line(platformSubsystems)},`,
    `  "readProcedures": ${block(readProcedures.map(({ name, arguments: args }) => ({ name, arguments: args })))},`,
    `  "runStatuses": ${block(runStatuses)},`,
    `  "subsystems": ${block(subsystems)},`,
    `  "version": ${agentCatalogVersion},`,
    `  "writeProcedures": ${block(writeProcedures)}`,
    '}',
    ''
  ].join('\n')
}
