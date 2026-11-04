// Object Explorer's status chips (docs/object-explorer.md, Live status and Login status): what the `explorer` live source's
// probes (src/shared/live/catalog.ts) report, turned into the chips a node shows, and a login's static chip from its listing.
// Only a probe's own rows or the listing's own columns make a chip; nothing here guesses. Erasable TypeScript (no enums), so Node's type stripping can load it as well.
import type { IconId } from '../icons.ts'
import type { StatusTone } from '../theme/tones.ts'

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

/** Every chip a database or server can show, for docs/object-explorer.md. */
export const statusChipDocs: readonly { readonly kind: 'server' | 'database'; readonly chip: string; readonly tone: string; readonly when: string }[] = [
  ...Object.entries(states).filter(([state]) => state !== '10').map(([state, value]) => ({ kind: 'database' as const, chip: value.label + (value.tone === 'running' && state !== '7' ? ' n %' : ''), tone: value.tone, when: `state ${state}${state === '6' ? ' or 10' : ''}: ${value.title}` })),
  { kind: 'database', chip: 'READ-ONLY / STANDBY', tone: 'warning', when: 'is_read_only, or is_in_standby (a log-shipping standby)' },
  { kind: 'database', chip: 'SINGLE USER / RESTRICTED USER', tone: 'warning', when: 'user_access 1 or 2' },
  { kind: 'server', chip: 'n Agent jobs running', tone: 'running', when: 'SQL Server Agent jobs of its current session that started and have not stopped (none while none runs)' },
  { kind: 'server', chip: '<group> healthy / partially healthy / not healthy', tone: 'success, warning, critical', when: 'the least healthy availability group (several: "n AGs …"); its tooltip names each group with its health and this replica\'s role' }
]
