// The query window's status bar (SSMS's): the run's state on the left; server (version), login (SPID), database,
// execution time and rows on the right. In the window's status bar (the default) only the connection's facts show: how the
// run went, its time and rows are the results head's run summary. Pure, so every state and setting is tested without React.
import type { SettingsValues } from '../../../shared/settings/catalog'
import type { RunStatus } from './ResultsService'
import { endedStatus, formatCount, formatElapsed, plural, statusLeads } from './status'

export interface QueryStatusConnection { readonly server: string; readonly displayName?: string; readonly serverVersion?: string; readonly productVersion?: string; readonly lost?: true }
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
  return connection.lost ? name + ' (connection lost)' : version ? `${name} (${version})` : name
}
export const sessionText = (session: QueryStatusInput['session']): string => session ? `${session.login ?? ''} (${session.spid})`.trim() : ''

const failed: ReadonlySet<RunStatus> = new Set(['failed', 'cancelled', 'timedOut', 'lost'])
/** The results head's icons (runSummary), so an outcome looks the same on both. */
const icons: Readonly<Record<Exclude<RunStatus, 'running' | 'closed' | 'lost'>, QueryStatusIcon>> = {
  completed: 'pass', completedWithErrors: 'warning', failed: 'error', cancelled: 'debug-stop', timedOut: 'watch'
}

export function queryStatusModel(input: QueryStatusInput): QueryStatusModel {
  const { connection, run, settings } = input
  const live = connection && !connection.lost ? connection : undefined
  const bar = input.variant !== 'segment'
  // A closed run keeps the sentence of how it ended; one the backend lost reads as failed.
  const ended = bar && run && !input.running ? endedStatus(run.status, run.closedFrom ?? run.summary?.status) : undefined
  let tone: QueryStatusTone, icon: QueryStatusIcon, text: string
  if (input.running && bar) { tone = 'executing'; icon = 'loading'; text = statusLeads.running }
  else if (connection?.lost) { tone = 'error'; icon = 'debug-disconnect'; text = 'Connection lost.' }
  else if (ended && ended !== 'running') { tone = failed.has(ended) ? 'error' : 'ready'; icon = ended === 'lost' ? 'error' : icons[ended]; text = ended === 'lost' ? statusLeads.failed : statusLeads[ended] }
  else if (live) { tone = 'ready'; icon = 'plug'; text = 'Connected.' }
  else { tone = 'disconnected'; icon = 'debug-disconnect'; text = 'Disconnected.' }

  const segments: QueryStatusSegment[] = []
  const server = connection ? serverText(connection) : '', login = live ? sessionText(input.session) : ''
  if (connection && settings['textEditor.statusBar.showServer']) segments.push({ key: 'server', label: 'Server', text: server })
  if (login && settings['textEditor.statusBar.showLogin']) segments.push({ key: 'login', label: 'Login', text: login })
  if (connection && settings['textEditor.statusBar.showDatabase']) segments.push({ key: 'database', label: 'Database', text: input.database })
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
  return { tone, icon, text, segments, place: [server || 'Disconnected', login, input.database].filter(Boolean).join(' | ') }
}
