// The query window's status bar (SSMS's): the run's state on the left; server (version), login (SPID), database,
// execution time and rows on the right. In the window's status bar (the default) only the connection's facts show: how the
// run went, its time and rows are the results head's run summary. Pure, so every state and setting is tested without React.
import type { MultiQueryTargetPhase, QueryMultiStatus } from '../../../shared/contracts'
import { multiQueryTargetStatuses } from '../../../shared/contracts'
import type { ProviderId } from '../../../shared/providers'
import type { SettingsValues } from '../../../shared/settings/catalog'
import type { RunStatus } from './ResultsService'
import { endedStatus, formatCount, formatElapsed, plural, statusLeads } from './status'

/** `providerId` 'bigquery': the server is the project, the login the Google account the connection verified, and the
 *  database the default dataset. */
export interface QueryStatusConnection { readonly server: string; readonly displayName?: string; readonly serverVersion?: string; readonly productVersion?: string; readonly lost?: true; readonly disconnected?: boolean; readonly providerId?: string; readonly login?: string }
export interface MultiQueryStatusTarget {
  readonly provider: ProviderId
  readonly connected: boolean
  readonly enabled: boolean
  readonly environment?: string
  readonly label?: string
  readonly phase?: MultiQueryTargetPhase
}
/** The parts of a tab's results the bar reads. */
export interface QueryStatusRun {
  readonly status: RunStatus; readonly startedAt: number; readonly rowsRead: number; readonly summary?: { readonly status: Exclude<RunStatus, 'running' | 'lost' | 'closed'>; readonly elapsedMs: number }
  /** When a run without a summary ended, and how a run whose results were closed had ended (ResultsService). */
  readonly endedAt?: number; readonly closedFrom?: Exclude<RunStatus, 'running' | 'closed'>
}
export interface QueryStatusInput {
  readonly connection?: QueryStatusConnection
  readonly database: string
  /** SSMS's `login (SPID)`: the session the query's last execution ran in, while it is still the query's. */
  readonly session?: { readonly login?: string; readonly spid: number }
  readonly run?: QueryStatusRun
  readonly running: boolean
  /** Multi-server or cross-engine mode and target states; when set, formats multi-target summary and outcomes. */
  readonly multiMode?: 'same' | 'cross'
  readonly multiTargets?: readonly MultiQueryStatusTarget[]
  readonly multiStatus?: QueryMultiStatus
  /** 'bar' (the default): SSMS's query window status bar, with the run's state, time and rows. 'segment': the window's status
   *  bar, which shows the connection's facts only, since the results head says how the run went (one run status). */
  readonly variant?: 'bar' | 'segment'
  readonly now: number
  readonly settings: Pick<SettingsValues, 'textEditor.statusBar.executionTime' | 'textEditor.statusBar.showServer' | 'textEditor.statusBar.showLogin' | 'textEditor.statusBar.showDatabase' | 'textEditor.statusBar.showRowCount'>
  /** How End shows a time of day; the app's locale by default. */
  readonly formatTime?: (time: number) => string
}
/** Which colours the bar takes. */
export type QueryStatusTone = 'ready' | 'disconnected' | 'executing' | 'error'
export type QueryStatusIcon = 'plug' | 'debug-disconnect' | 'loading' | 'pass' | 'warning' | 'error' | 'debug-stop' | 'watch'
export interface QueryStatusSegment { readonly key: 'server' | 'login' | 'database' | 'time' | 'rows'; readonly label: string; readonly text: string }
export interface QueryStatusModel {
  readonly tone: QueryStatusTone
  readonly icon: QueryStatusIcon
  readonly text: string
  /** In SSMS's order; switched off ones are left out. */
  readonly segments: readonly QueryStatusSegment[]
  /** The whole `server | login (SPID) | database`, for the tooltip of a bar too narrow to show it. */
  readonly place: string
}

/** "16.0" from "16.0.4135.4" or "16.00.4135": the major and minor version SSMS shows after the server's name. */
export function versionLabel(connection: Pick<QueryStatusConnection, 'productVersion' | 'serverVersion'>): string {
  for (const version of [connection.productVersion, connection.serverVersion]) {
    const match = version ? /^(\d+)\.(\d+)/.exec(version) : null
    if (match) return `${Number(match[1])}.${Number(match[2])}`
  }
  return ''
}
/** The server's name with its version, "sql01 (16.0)"; a lost connection says so instead. */
export function serverText(connection: QueryStatusConnection): string {
  const name = connection.displayName || connection.server, version = versionLabel(connection)
  return connection.disconnected ? name + ' Disconnected' : connection.lost ? name + ' (connection lost)' : version ? `${name} (${version})` : name
}
export const sessionText = (session: QueryStatusInput['session']): string => session ? `${session.login ?? ''} (${session.spid})`.trim() : ''

const failed: ReadonlySet<RunStatus> = new Set(['failed', 'cancelled', 'timedOut', 'lost'])
/** The results head's icons (runSummary), so an outcome looks the same on both. */
const icons: Readonly<Record<Exclude<RunStatus, 'running' | 'closed' | 'lost'>, QueryStatusIcon>> = {
  completed: 'pass', completedWithErrors: 'warning', failed: 'error', cancelled: 'debug-stop', timedOut: 'watch', detached: 'watch', superseded: 'debug-stop'
}
const terminalMultiPhases: ReadonlySet<string> = new Set<string>(multiQueryTargetStatuses)
const isProdEnvironment = (environment: string | undefined): boolean => {
  const normalized = environment?.trim().toLowerCase()
  return normalized === 'production' || normalized === 'prod'
}

export interface MultiTargetStatusSummary {
  readonly label: string
  readonly prodCount: number
  readonly connectedCount: number
  readonly enabledCount: number
  readonly ready: boolean
}

/** Formats multi-server and cross-engine target summaries (e.g. "3 SQL Servers (1 PROD) · Ready", "2 of 3 connected", "1 SQL Server + 1 BigQuery · Read-only"). */
export function multiTargetSummaryText(mode: 'same' | 'cross', targets: readonly MultiQueryStatusTarget[]): MultiTargetStatusSummary {
  const enabled = targets.filter(target => target.enabled)
  const enabledCount = enabled.length
  const connectedCount = enabled.filter(target => target.connected).length
  const prodCount = enabled.filter(target => isProdEnvironment(target.environment)).length
  const prodTag = prodCount > 0 ? ` (${prodCount} PROD)` : ''
  if (mode === 'cross') {
    const sqlCount = enabled.filter(target => target.provider === 'sqlserver').length
    const bqCount = enabled.filter(target => target.provider === 'bigquery').length
    const sqlLive = enabled.some(target => target.provider === 'sqlserver' && target.connected)
    const bqLive = enabled.some(target => target.provider === 'bigquery' && target.connected)
    const ready = sqlLive && bqLive
    const base = `${sqlCount} ${sqlCount === 1 ? 'SQL Server' : 'SQL Servers'} + ${bqCount} BigQuery${prodTag}`
    const state = enabledCount === 0
      ? 'No targets selected'
      : connectedCount === enabledCount && ready
        ? `${base} · Read-only`
        : connectedCount === 0
          ? `${base} · Disconnected`
          : `${base} · ${connectedCount} of ${enabledCount} connected`
    return { label: state, prodCount, connectedCount, enabledCount, ready }
  }
  const provider: ProviderId = enabled[0]?.provider ?? targets[0]?.provider ?? 'sqlserver'
  const noun = provider === 'bigquery'
    ? (enabledCount === 1 ? 'BigQuery project' : 'BigQuery projects')
    : (enabledCount === 1 ? 'SQL Server' : 'SQL Servers')
  const ready = connectedCount > 0
  const label = enabledCount === 0
    ? 'No targets selected'
    : connectedCount === enabledCount
      ? `${enabledCount} ${noun}${prodTag} · Ready`
      : connectedCount === 0
        ? `${enabledCount} ${noun}${prodTag} · Disconnected`
        : `${enabledCount} ${noun}${prodTag} · ${connectedCount} of ${enabledCount} connected`
  return { label, prodCount, connectedCount, enabledCount, ready }
}

const multiOutcomeDisplay: Readonly<Record<QueryMultiStatus, { readonly tone: QueryStatusTone; readonly icon: QueryStatusIcon; readonly text: string }>> = {
  completed: { tone: 'ready', icon: 'pass', text: 'Query executed successfully.' },
  completedWithErrors: { tone: 'ready', icon: 'warning', text: 'Query completed with errors.' },
  partialFailure: { tone: 'error', icon: 'warning', text: 'Query completed with partial failures.' },
  rolledBack: { tone: 'error', icon: 'warning', text: 'Transaction rolled back across all servers.' },
  commitInDoubt: { tone: 'error', icon: 'error', text: 'Commit outcome in doubt.' },
  failed: { tone: 'error', icon: 'error', text: statusLeads.failed },
  cancelled: { tone: 'error', icon: 'debug-stop', text: statusLeads.cancelled },
  timedOut: { tone: 'error', icon: 'watch', text: statusLeads.timedOut }
}

export function queryStatusModel(input: QueryStatusInput): QueryStatusModel {
  const { connection, run, settings } = input
  const bar = input.variant !== 'segment'
  if (input.multiMode) {
    const targets = input.multiTargets ?? []
    const multi = multiTargetSummaryText(input.multiMode, targets)
    const enabled = targets.filter(target => target.enabled)
    const ended = bar && run && !input.running ? endedStatus(run.status, run.closedFrom ?? run.summary?.status) : undefined
    let tone: QueryStatusTone, icon: QueryStatusIcon, text: string
    if (input.running && bar) {
      tone = 'executing'
      icon = 'loading'
      const withPhases = enabled.filter(target => target.phase !== undefined)
      const done = withPhases.filter(target => terminalMultiPhases.has(target.phase!)).length
      text = withPhases.length ? `Executing on ${withPhases.length} ${plural(withPhases.length, 'target')} (${done}/${withPhases.length} settled)…` : statusLeads.running
    } else if (bar && input.multiStatus && !input.running) {
      const outcome = multiOutcomeDisplay[input.multiStatus]
      tone = outcome.tone
      icon = outcome.icon
      text = outcome.text
    } else if (ended && ended !== 'running') {
      tone = failed.has(ended) ? 'error' : 'ready'
      icon = ended === 'lost' ? 'error' : icons[ended]
      text = ended === 'lost' ? statusLeads.failed : statusLeads[ended]
    } else if (multi.ready) {
      tone = 'ready'
      icon = 'plug'
      text = multi.label
    } else {
      tone = 'disconnected'
      icon = 'debug-disconnect'
      text = multi.label
    }
    const segments: QueryStatusSegment[] = []
    if (settings['textEditor.statusBar.showServer']) segments.push({ key: 'server', label: 'Targets', text: multi.label })
    const timed = bar && (!!run || multi.ready), mode = settings['textEditor.statusBar.executionTime']
    if (timed && mode !== 'none') {
      const elapsed = !run ? 0 : input.running ? input.now - run.startedAt : run.summary?.elapsedMs ?? Math.max(0, (run.endedAt ?? input.now) - run.startedAt)
      if (mode === 'end' && run && !input.running) segments.push({ key: 'time', label: 'End time', text: (input.formatTime ?? (time => new Date(time).toLocaleTimeString()))(run.startedAt + elapsed) })
      else segments.push({ key: 'time', label: 'Elapsed time', text: formatElapsed(elapsed) })
    }
    if (timed && settings['textEditor.statusBar.showRowCount']) {
      const rows = run?.rowsRead ?? 0
      segments.push({ key: 'rows', label: 'Rows', text: `${formatCount(rows)} ${plural(rows, 'row')}` })
    }
    const names = enabled.map(target => target.label).filter(Boolean).join(', ')
    return { tone, icon, text, segments, place: names ? `${multi.label} (${names})` : multi.label }
  }
  const live = connection && !connection.lost && !connection.disconnected ? connection : undefined
  // A closed run keeps the sentence of how it ended; one the backend lost reads as failed.
  const ended = bar && run && !input.running ? endedStatus(run.status, run.closedFrom ?? run.summary?.status) : undefined
  let tone: QueryStatusTone, icon: QueryStatusIcon, text: string
  if (input.running && bar) { tone = 'executing'; icon = 'loading'; text = statusLeads.running }
  else if (connection?.lost) { tone = 'error'; icon = 'debug-disconnect'; text = 'Connection lost.' }
  else if (ended && ended !== 'running') { tone = failed.has(ended) ? 'error' : 'ready'; icon = ended === 'lost' ? 'error' : icons[ended]; text = ended === 'lost' ? statusLeads.failed : statusLeads[ended] }
  else if (live) { tone = 'ready'; icon = 'plug'; text = 'Connected.' }
  else { tone = 'disconnected'; icon = 'debug-disconnect'; text = 'Disconnected.' }

  const segments: QueryStatusSegment[] = []
  // BigQuery has no SPID: its login segment is the account, and its database the default dataset.
  const bigQuery = connection?.providerId === 'bigquery'
  const server = connection ? serverText(connection) : '', login = !live ? '' : bigQuery ? live.login ?? '' : sessionText(input.session)
  const database = bigQuery && !input.database ? 'No default dataset' : input.database
  if (connection && settings['textEditor.statusBar.showServer']) segments.push({ key: 'server', label: bigQuery ? 'Project' : 'Server', text: server })
  if (login && settings['textEditor.statusBar.showLogin']) segments.push({ key: 'login', label: bigQuery ? 'Account' : 'Login', text: login })
  if (connection && settings['textEditor.statusBar.showDatabase']) segments.push({ key: 'database', label: bigQuery ? 'Dataset' : 'Database', text: database })
  // Before a first run, as in SSMS, a connected query shows 00:00:00 and 0 rows.
  const timed = bar && (!!run || !!live), mode = settings['textEditor.statusBar.executionTime']
  if (timed && mode !== 'none') {
    const elapsed = !run ? 0 : input.running ? input.now - run.startedAt : run.summary?.elapsedMs ?? Math.max(0, (run.endedAt ?? input.now) - run.startedAt)
    // End is the time of day the last run ended; a run still going shows how long it has taken.
    if (mode === 'end' && run && !input.running) segments.push({ key: 'time', label: 'End time', text: (input.formatTime ?? (time => new Date(time).toLocaleTimeString()))(run.startedAt + elapsed) })
    else segments.push({ key: 'time', label: 'Elapsed time', text: formatElapsed(elapsed) })
  }
  if (timed && settings['textEditor.statusBar.showRowCount']) {
    const rows = run?.rowsRead ?? 0
    segments.push({ key: 'rows', label: 'Rows', text: `${formatCount(rows)} ${plural(rows, 'row')}` })
  }
  return { tone, icon, text, segments, place: [server || 'Disconnected', login, database].filter(Boolean).join(' | ') }
}
