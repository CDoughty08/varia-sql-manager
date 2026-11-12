// The Activity Monitor's session actions (docs/activity-monitor.md, Session actions): what Details and Kill Process need
// from a row of Sessions, Blocking or Active Expensive Queries, whether Kill may be offered, and how each answer reads.
// Pure functions: ActivityMonitorService runs the requests, and the flyout and the confirm draw these.
import { activityLimits, detailsSections, killOutcomes, liveColumnId, tableSpecs, variaSessionKinds, type DetailsSection, type DetailsText, type KillOutcome } from '../../../shared/activity/catalog'
import { loginTimePattern, type ActivityDetailsResult, type ActivityKillResult, type ActivitySessionDetails, type ActivityText } from '../../../shared/activity/schema'
import { formatCount, plural } from '../results/status'

/** The panes whose rows are sessions. */
export const sessionTables = ['sessions', 'blocking', 'activeQueries'] as const
export type SessionTable = (typeof sessionTables)[number]

/** A session as its row named it: the id and login time identify it (SQL Server reuses ids); the rest is what the Kill
 *  confirm names. */
export interface SessionRef {
  readonly sessionId: number
  /** sys.dm_exec_sessions' login_time as the schema takes it: `2026-10-22T06:50:12.347`. */
  readonly loginTime: string
  /** The row's Host PID, which Kill checks; null when the session has none. */
  readonly hostProcessId: number | null
  readonly login?: string
  readonly hostName?: string
  readonly openTransactions?: number
  /** Varia's label when the session is this window's own (a query tab or a pool). */
  readonly varia?: string
}

const rowColumns = ['sessionId', 'loginTime', 'hostProcessId', 'login', 'hostName', 'openTransactions', 'varia'] as const
type RowColumn = (typeof rowColumns)[number]
/** The row cells a table has of those a session action reads, as the live layer's column ids. */
export function sessionColumns(table: SessionTable): string[] {
  return rowColumns.filter(id => tableSpecs[table].columns.some(column => column.id === id)).map(id => liveColumnId(table, id))
}

const integer = (text: string | null | undefined): number | undefined => {
  if (text == null || !/^-?\d+$/.test(text.trim())) return undefined
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : undefined
}
/** A datetime cell's stored text (`2026-10-22 06:50:12.347`) as the schema's login time, or undefined. */
export function loginTimeOf(text: string | null | undefined): string | undefined {
  const value = text?.trim().replace(' ', 'T')
  return value && value.length <= 40 && loginTimePattern.test(value) ? value : undefined
}

/** A row's cells (by live column id, from LiveGrid.activeRow) as the session it names; undefined when it names none that
 *  Details or Kill can identify (no id, or no login time: a session missing from the sample's Sessions rows). */
export function sessionFromRow(table: SessionTable, cells: Readonly<Record<string, string | null>> | undefined): SessionRef | undefined {
  if (!cells) return undefined
  const cell = (id: RowColumn) => cells[liveColumnId(table, id)]
  const sessionId = integer(cell('sessionId')), loginTime = loginTimeOf(cell('loginTime'))
  if (sessionId === undefined || sessionId < 1 || sessionId > activityLimits.sessionId || !loginTime) return undefined
  const text = (id: RowColumn) => { const value = cell(id); return value ? value : undefined }
  const hostProcessId = integer(cell('hostProcessId')), openTransactions = integer(cell('openTransactions'))
  return {
    sessionId, loginTime, hostProcessId: hostProcessId !== undefined && hostProcessId >= -2_147_483_648 && hostProcessId <= 2_147_483_647 ? hostProcessId : null,
    ...text('login') ? { login: text('login') } : {}, ...text('hostName') ? { hostName: text('hostName') } : {},
    ...openTransactions !== undefined ? { openTransactions } : {}, ...text('varia') ? { varia: text('varia') } : {}
  }
}
export const sameSession = (a: Pick<SessionRef, 'sessionId' | 'loginTime'> | undefined, b: Pick<SessionRef, 'sessionId' | 'loginTime'> | undefined): boolean =>
  !!a && !!b && a.sessionId === b.sessionId && a.loginTime === b.loginTime

const poolLabels: ReadonlySet<string> = new Set(variaSessionKinds.filter(kind => kind.kind === 'pool').map(kind => kind.label))
/** One of this window's own pools (Object Explorer, Scripting, the monitor's own…): Kill never offers to end it. */
export const isVariaPool = (session: Pick<SessionRef, 'varia'> | undefined): boolean => !!session?.varia && poolLabels.has(session.varia)

/** Whether Kill Process may be offered for a session, and why not: the monitor's `canKill` status (0 when the login lacks
 *  ALTER ANY CONNECTION; unknown until the first sample says), and never for Varia's own pools. */
export function killOffer(session: SessionRef | undefined, canKill: number | string | undefined): { readonly allowed: boolean; readonly reason?: string } {
  if (!session) return { allowed: false, reason: 'Select a session first.' }
  if (isVariaPool(session)) return { allowed: false, reason: `Session ${session.sessionId} is Varia's own (${session.varia}); Kill Process never ends it.` }
  if (canKill === 0 || canKill === '0') return { allowed: false, reason: 'Kill Process needs ALTER ANY CONNECTION (sysadmin or processadmin), which this login lacks.' }
  return { allowed: true }
}

/** The confirm's words: who the session is, and what ending it does. */
export function killQuestion(session: SessionRef): { readonly title: string; readonly facts: readonly (readonly [string, string])[]; readonly warning: string } {
  const open = session.openTransactions
  const facts: [string, string][] = [['Login', session.login ?? 'Unknown'], ['Host', session.hostName ?? 'None'], ['Open transactions', open === undefined ? 'Unknown' : formatCount(open)]]
  if (session.varia) facts.push(['Varia', session.varia])
  const warning = open && open > 0
    ? `Its ${open === 1 ? 'open transaction rolls' : `${formatCount(open)} open transactions roll`} back, which can take as long as the work it undoes; the session holds its locks until the rollback ends.`
    : 'Any open transaction rolls back, which can take as long as the work it undoes. The client sees its connection closed.'
  return { title: `Kill session ${session.sessionId}?`, facts, warning }
}

export type ReportTone = 'success' | 'info' | 'warning' | 'error'
/** What Kill Process answered, as the monitor reports it. */
export interface KillReport { readonly tone: ReportTone; readonly title: string; readonly detail: string }
const outcomeTitles: Readonly<Record<KillOutcome, (id: number) => string>> = {
  killed: id => `Session ${id} was killed.`,
  ended: id => `Session ${id} had already ended.`,
  changed: id => `Session ${id} is now another session.`,
  own: id => `Session ${id} is the session Kill runs on.`,
  system: id => `Session ${id} is a system session.`,
  varia: id => `Session ${id} is Varia's own.`,
  denied: id => `Session ${id} was not killed: permission denied.`,
  failed: id => `Session ${id} could not be killed.`
}
const outcomeTones: Readonly<Record<KillOutcome, ReportTone>> = { killed: 'success', ended: 'info', changed: 'warning', own: 'warning', system: 'warning', varia: 'warning', denied: 'error', failed: 'error' }
/** One session's outcome in words: the catalogue's meaning, with the rollback named when it held open transactions. */
export function killReport(session: SessionRef, result: Pick<ActivityKillResult, 'results' | 'error'> | undefined, failure?: string): KillReport {
  const id = session.sessionId
  const outcome = result?.results.find(item => item.sessionId === id)
  if (!outcome) {
    const why = failure ?? result?.error?.message ?? 'The backend did not try it.'
    return { tone: 'error', title: `Session ${id} was not killed.`, detail: `${why} Nothing was killed.` }
  }
  let detail: string = killOutcomes[outcome.outcome]
  if (outcome.outcome === 'killed' && session.openTransactions && session.openTransactions > 0)
    detail = `SQL Server accepted KILL. Its ${plural(session.openTransactions, 'open transaction')} ${session.openTransactions === 1 ? 'rolls' : 'roll'} back, which can take as long as the work it undoes; Sessions shows the progress as "rolling back n %".`
  if (outcome.outcome === 'failed' && outcome.message) detail = `${outcome.message} ${detail}`
  return { tone: outcomeTones[outcome.outcome], title: outcomeTitles[outcome.outcome](id), detail }
}

// --- Details ----------------------------------------------------------------------------------------------------------

export const sectionTitle = (section: DetailsSection): string => detailsSections.find(item => item.id === section)?.title ?? section
type Field = readonly [label: string, value: (session: ActivitySessionDetails) => string | number | boolean | undefined]
const ms = (value: number | undefined) => value === undefined ? undefined : `${formatCount(value)} ms`
const kb = (value: number | undefined) => value === undefined ? undefined : `${formatCount(value)} KB`
/** Identity and Now's fields, in order; a field the session lacks is left out. */
export const sessionFields: readonly Field[] = [
  ['Session ID', s => s.sessionId], ['Login', s => s.login], ['Original login', s => s.originalLogin !== s.login ? s.originalLogin : undefined],
  ['Login time', s => s.loginTime.replace('T', ' ')], ['Host', s => s.hostName], ['Host PID', s => s.hostProcessId], ['Application', s => s.application],
  ['Interface', s => s.interface], ['Net address', s => s.netAddress], ['Transport', s => s.transport], ['Encrypted', s => s.encrypted === undefined ? undefined : s.encrypted ? 'Yes' : 'No'],
  ['Auth scheme', s => s.authScheme], ['User session', s => s.isUserProcess ? 'Yes' : 'No (system)'], ['Database', s => s.database], ['Isolation level', s => s.isolationLevel],
  ['Status', s => s.status], ['Command', s => s.command], ['Requests', s => s.requestCount], ['Wait type', s => s.waitType], ['Wait time', s => ms(s.waitTimeMs)],
  ['Wait resource', s => s.waitResource], ['Blocked by', s => s.blockedBy], ['Elapsed', s => ms(s.elapsedMs)], ['CPU', s => ms(s.cpuMs)],
  ['Logical reads', s => formatCount(s.logicalReads)], ['Reads', s => formatCount(s.reads)], ['Writes', s => formatCount(s.writes)],
  ['% complete', s => s.percentComplete === undefined ? undefined : `${s.percentComplete.toFixed(1)} %`], ['DOP', s => s.dop], ['Granted memory', s => kb(s.grantedMemoryKb)],
  ['Memory', s => kb(s.memoryKb)], ['Open transactions', s => s.openTransactions], ['Last request start', s => s.lastRequestStart?.replace('T', ' ')],
  ['Last request end', s => s.lastRequestEnd?.replace('T', ' ')]
]
export function sessionRows(session: ActivitySessionDetails): (readonly [string, string])[] {
  return sessionFields.flatMap(([label, value]) => { const shown = value(session); return shown === undefined || shown === '' ? [] : [[label, String(shown)] as const] })
}

/** A text section's note: how much of it the flyout shows. */
export function textNote(text: ActivityText): string | undefined {
  return text.truncated ? `First ${formatCount(text.text.length)} of ${formatCount(text.chars)} characters.` : undefined
}
export const detailsTextOf = (result: ActivityDetailsResult, section: DetailsText): ActivityText | undefined =>
  section === 'inputBuffer' ? result.inputBuffer?.text : result[section]

/** What a Details answer means for the flyout as a whole: the session, or why there is none. */
export function detailsState(result: ActivityDetailsResult): { readonly kind: 'present' | 'departed' | 'error'; readonly message?: string } {
  if (result.state === 'present' && result.session) return { kind: 'present' }
  if (result.state === 'ended') return { kind: 'departed', message: `Session ${result.sessionId} has ended (or this login can no longer see it). Its details are gone.` }
  if (result.state === 'changed') return { kind: 'departed', message: `Session ${result.sessionId} ended, and its id now belongs to another session. Nothing of the new session was read.` }
  return { kind: 'error', message: result.error?.message ?? 'The session could not be read.' }
}

/** Copy's text: every section the flyout shows, as plain text (headings, "Label: value" lines, texts whole as read). */
export function detailsText(result: ActivityDetailsResult): string {
  const lines: string[] = []
  const heading = (title: string) => { if (lines.length) lines.push(''); lines.push(title, '-'.repeat(title.length)) }
  if (result.session) {
    heading(sectionTitle('session'))
    for (const [label, value] of sessionRows(result.session)) lines.push(`${label}: ${value}`)
  }
  for (const section of ['statement', 'batch', 'inputBuffer'] as const) {
    const text = detailsTextOf(result, section)
    if (!text) continue
    heading(sectionTitle(section))
    if (section === 'inputBuffer' && result.inputBuffer?.eventType) lines.push(`Event: ${result.inputBuffer.eventType}${result.inputBuffer.parameters ? ` (${result.inputBuffer.parameters} parameters)` : ''}`)
    lines.push(text.text)
    const note = textNote(text)
    if (note) lines.push(`(${note})`)
  }
  if (result.waits?.length) {
    heading(sectionTitle('waits'))
    for (const wait of result.waits) lines.push(`${wait.waitType}\t${wait.waitingTasks} tasks\t${wait.waitTimeMs} ms\tmax ${wait.maxWaitTimeMs} ms\tsignal ${wait.signalWaitTimeMs} ms`)
  }
  if (result.transactions?.length) {
    heading(sectionTitle('transactions'))
    for (const tran of result.transactions) lines.push([tran.transactionId, tran.name ?? '', tran.type, tran.state, tran.database ?? '', tran.beginTime ?? '', tran.logBytesUsed === undefined ? '' : `${tran.logBytesUsed} log bytes`].join('\t'))
  }
  if (result.tempdb) {
    heading(sectionTitle('tempdb'))
    lines.push(`User objects: ${result.tempdb.userObjectsKb} KB`, `Internal objects: ${result.tempdb.internalObjectsKb} KB`)
  }
  if (result.locks?.length) {
    heading(sectionTitle('locks'))
    for (const lock of result.locks) lines.push([lock.resourceType, lock.database ?? '', lock.mode, lock.status, lock.count].join('\t'))
  }
  return lines.join('\n')
}
