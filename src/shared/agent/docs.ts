// Renders the generated part of docs/sql-server-agent.md from the catalogue: everything after `generatedMarker`.
// tests/agent-catalog.test.ts keeps the file in sync and leaves the hand-written part above the marker as it is.
import {
  agentCallIndexLimit, agentEngineEditions, agentErrorNumbers, agentFeatures, agentJobSaveCalls, agentLimits, agentPlatformGates, agentPlatforms, alertTypes, executionStatuses, frequencyTypes,
  lastRunOutcomes, masterReadShapes, notificationMethods, notifyLevels, platformSubsystems, readProcedures, relativeDays, relativeIntervals, runStatuses, stepActions, stepFlags, subdayTypes,
  subsystems, weekDays, writeProcedures, type AgentLimit, type AgentPlatform, type CodeLabel, type ToneCodeLabel
} from './catalog.ts'

export const generatedMarker = '<!-- Generated below from src/shared/agent/catalog.ts. Regenerate with: npx vitest run tests/agent-catalog.test.ts -u -->'

const cell = (value: string) => value.replaceAll('|', '\\|')
const row = (cells: readonly string[]) => '| ' + cells.map(cell).join(' | ') + ' |'
const table = (header: readonly string[], rows: readonly (readonly string[])[]) => [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n')
const code = (value: string | number) => '`' + value + '`'
const codes = (rows: readonly CodeLabel[]) => table(['Code', 'Meaning'], rows.map(item => [code(item.code), item.label]))
const toned = (rows: readonly ToneCodeLabel[]) => table(['Code', 'Meaning', 'Tone'], rows.map(item => [code(item.code), item.label, item.tone ?? '']))
const number = (value: number) => value.toLocaleString('en-US')
const platformNames: { readonly [P in AgentPlatform]: string } = { windows: 'Windows', linux: 'Linux', managedInstance: 'Managed Instance' }
const editionNames: Readonly<Record<number, string>> = { 1: 'Personal', 2: 'Standard', 3: 'Enterprise and Developer', 8: 'Managed Instance' }

const limitNotes: { readonly [L in AgentLimit]: string } = {
  listRows: 'Jobs one listing holds; more set `truncated`',
  historyRows: 'History rows one history read holds, newest first; more set `truncated`',
  historyJobs: 'Jobs one history filter or one Delete History names',
  logRows: 'Error log rows one read holds, newest first (oldest first on Managed Instance, whose `sp_readmierrorlog` takes no sort argument); the rest are cancelled and a notice says so',
  searchChars: 'Characters of a history or error log search text',
  gridMessageChars: 'Characters of a history message in a grid cell (the details pane reads all of it)',
  messageChars: 'Characters `sysjobhistory.message` holds',
  nameChars: 'UTF-16 code units in an Agent object\'s name (sysname)',
  stepsPerJob: 'Steps one job save may hold',
  schedulesPerJob: 'Schedules one job save may hold',
  jobAlerts: "Alerts one job save may detach (the job document's Alerts section)",
  descriptionChars: "Characters of a job's description (`sysjobs.description`)",
  ownerLogins: "Logins the job document's owner picker lists (sysadmin; the owner can still be typed)",
  scheduleJobChanges: 'Jobs one schedule save may attach or detach',
  lastRunRows: "History rows Job Activity Monitor's last run reads, newest first, before it cancels the rest",
  startJobs: 'Jobs one Start, Stop, Enable or Disable from Job Activity Monitor may name',
  watchedJobs: 'Jobs the status bar follows with live progress',
  serviceStatementMs: 'One service Start or Stop statement, in ms',
  serviceWaitMs: 'How long a Start or Stop waits for the service\'s new state, in ms',
  serviceReadMs: 'One service state read, in ms',
  servicePollMs: "How often a Start or Stop's wait polls the service's state, in ms",
  agentUpWaitMs: 'How long the live checks wait for Agent after the server is up, in ms',
  profileMs: 'The budget of `agent.profile` once it has its Object Explorer slot, in ms (a TIMEOUT value past it, unless msdb already refused the login: then the profile with no role)',
  historyMaxRows: 'The largest Maximum job history log size SQL Server Agent Properties sends, in rows (rows per job are 1 to it)',
  retentionDays: 'The days of history "What this keeps" measures each job\'s rate over',
  retentionJobs: 'Jobs "What this keeps" lists, those with the most rows first; more set `truncated`',
  historyAgeDays: 'Whole days of age the purge\'s row estimate counts separately (older rows count together)',
  purgeCount: 'The most days, weeks or months "Delete old history now" goes back (999 months stays inside `datetime`)',
  notificationChanges: 'Notification changes one alert or operator save makes (each one msdb call)',
  newOperators: 'Operators an alert save creates in place (the inline New operator)',
  alertMessageChars: 'Characters of an alert\'s additional notification message',
  alertKeywordChars: 'Characters of an alert\'s "Message contains" text',
  conditionChars: 'Characters of a performance condition (object|counter|instance|comparator|value)',
  addressChars: 'Characters of an operator\'s e-mail, pager and net send addresses',
  alertDelaySeconds: 'The most seconds an alert waits between responses',
  counterRows: 'Performance counters the alert document\'s pickers list',
  counterInstances: 'Instances one counter\'s current values list',
  recommendedAlerts: 'Alerts one Add recommended alerts creates',
  alertRows: 'Alerts the Operators and notifications grid reads',
  operatorRows: 'Operators one listing reads'
}

/** The generated reference: code tables, gates, procedures and limits. */
export function renderAgentDocs(): string {
  const procedures = readProcedures.map(procedure => [code('msdb.dbo.' + procedure.name), procedure.arguments.length
    ? procedure.arguments.map(argument => argument.constants ? `${code(argument.name)} (${argument.constants.map(code).join(', ')})` : code(argument.name)).join(', ') : 'none', procedure.who])
  return [
    generatedMarker,
    '',
    '## Reference',
    '',
    '### Servers',
    '',
    `The Agent node shows on engine editions ${agentEngineEditions.map(edition => `${edition} (${editionNames[edition]})`).join(', ')}. Express and the cloud editions have no Agent.`,
    '',
    '### Platform gates',
    '',
    table(['Feature', ...agentPlatforms.map(platform => platformNames[platform]), 'Note'], agentFeatures.map(feature => {
      const gate = agentPlatformGates[feature]
      return [gate.title, ...agentPlatforms.map(platform => gate.platforms.includes(platform) ? 'Yes' : 'No'), gate.note ?? '']
    })),
    '',
    'Step types each platform can run; a server offers those its `syssubsystems` lists:',
    '',
    table(['Type', 'msdb name', ...agentPlatforms.map(platform => platformNames[platform])], subsystems.map(subsystem =>
      [subsystem.label, code(subsystem.id), ...agentPlatforms.map(platform => platformSubsystems[platform].includes(subsystem.id) ? 'Yes' : 'No')])),
    '',
    '### Codes',
    '',
    'Job and step outcomes (`run_status`):',
    '',
    toned(runStatuses),
    '',
    'Last run outcome (`sp_help_job`):',
    '',
    toned(lastRunOutcomes),
    '',
    'Execution status (`current_execution_status`):',
    '',
    toned(executionStatuses),
    '',
    'Step actions on success and on failure:',
    '',
    codes(stepActions),
    '',
    'Step flags Varia sets (others are kept as read):',
    '',
    table(['Bit', 'Meaning'], Object.entries(stepFlags).map(([name, bit]) => [code(bit), ({ appendOutputFile: 'Append output to the output file', includeStepOutputInHistory: 'Include step output in history', logToTable: 'Log to table', logToTableAppend: 'Log to table, appending to the existing entry' } as Record<string, string>)[name]!])),
    '',
    'Schedule types (`freq_type`):',
    '',
    codes(frequencyTypes),
    '',
    'Daily frequency units (`freq_subday_type`):',
    '',
    codes(subdayTypes),
    '',
    'Weekly days (`freq_interval` bits):',
    '',
    codes(weekDays),
    '',
    'Monthly relative weeks (`freq_relative_interval`) and days (`freq_interval`):',
    '',
    codes(relativeIntervals),
    '',
    codes(relativeDays),
    '',
    'Notification levels (`notify_level_*`, `delete_level`):',
    '',
    codes(notifyLevels),
    '',
    'Alert types and notification methods:',
    '',
    codes(alertTypes),
    '',
    codes(notificationMethods),
    '',
    'Dates, times and durations are SQL Server\'s local time, as msdb stores them: a date is `yyyymmdd` (0 is never), a time',
    '`hhmmss`, and a duration `hhmmss` with hours past 99 as more leading digits (`1234505` is 123:45:05).',
    '',
    '### Procedures',
    '',
    'Reads may `EXEC` only these msdb procedures, as `EXEC msdb.dbo.<name> @argument = @parameter, …;` with named arguments,',
    'each a parameter or one of the constants listed (`AgentSql.LintRead`):',
    '',
    table(['Procedure', 'Arguments', 'Who can run it'], procedures),
    '',
    'And these master procedures, each in exactly this shape (`@p` is a parameter):',
    '',
    table(['Procedure', 'Statement', 'Who can run it'], masterReadShapes.map(shape => [code(shape.name), code(shape.shape), shape.who])),
    '',
    'Writes (from AG-2) call only these, each followed by a return-code check:',
    '',
    table(['Procedure', 'Arguments', 'Lane'], writeProcedures.map(procedure => [code(procedure.database + '.dbo.' + procedure.name), procedure.arguments?.map(code).join(', ') ?? 'later lanes', procedure.lane])),
    '',
    'msdb error numbers the actions map (AG-2 onward; reads map 15281 to `AGENT_DISABLED` instead):',
    '',
    table(['Number', 'Code', 'Meaning'], agentErrorNumbers.map(error => [code(error.number), code(error.code), error.meaning])),
    '',
    '### Limits',
    '',
    table(['Limit', 'Value', 'Meaning'], (Object.keys(agentLimits) as AgentLimit[]).map(limit => [code(limit), number(agentLimits[limit]), limitNotes[limit]])),
    '',
    `A job save makes at most ${agentJobSaveCalls} calls at these caps, below the ${agentCallIndexLimit} a THROW state can number.`,
    ''
  ].join('\n')
}
