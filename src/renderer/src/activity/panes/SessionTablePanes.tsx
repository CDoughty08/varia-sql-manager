// Blocking and Active Expensive Queries (docs/activity-monitor.md, Panes): the sessions probe's other two tables, each in
// a live grid (LiveGridPane, no React per row) with the pane's own states and a status line. They read the same sample as
// Sessions, so showing them runs no extra SQL. Blocking's order is its chains (each waiter under its blocker), so its
// header does not sort.
import { activityLimits, tableSpecs, type ActivityTable } from '../../../../shared/activity/catalog'
import type { TruncationReason } from '../../../../shared/contracts'
import type { LiveTone } from '../../../../shared/live/catalog'
import { useWorkbench } from '../../core/WorkbenchContext'
import { LiveGridPane } from '../../live/LiveGridPane'
import type { LiveHandle, LiveSnapshot } from '../../live/LiveService'
import { formatCount, plural } from '../../results/status'
import type { MonitorState } from '../ActivityMonitorService'
import PaneState, { paneProblem, paneWaiting, paneWaitingText, type PaneProblem, type PaneWaiting } from './PaneState'

const probe = 'activity.sessions'
/** The tables' places in the sessions probe's sample, in the catalogue's order. */
const sessionTables = ['sessions', 'blocking', 'activeQueries'] as const satisfies readonly ActivityTable[]
type SessionTable = (typeof sessionTables)[number]
export const sessionTableIndex = (table: SessionTable): number => sessionTables.indexOf(table)

// The backend tones a chain's lead blocker `blocking` and every session under it `blocked`, and a running request
// `blocked` or `rollback` (ActivitySessionRows); `departed` is a selected row kept one revision after it left.
const blockingTones: Partial<Record<LiveTone, string>> = { error: 'blocked', warning: 'lead blocker', muted: 'left the chain' }
const activeTones: Partial<Record<LiveTone, string>> = { error: 'blocked', running: 'rolling back', muted: 'no longer listed' }
export const blockingToneLabel = (tone: LiveTone): string | undefined => blockingTones[tone]
export const activeToneLabel = (tone: LiveTone): string | undefined => activeTones[tone]

/**
 * What a pane's table holds, for its status line and empty note. `live`: the last sample is current (the view runs and the
 * probe is fresh), so an empty table may say "right now"; otherwise it only speaks for the last sample.
 */
export interface TableFacts {
  readonly rows: number | undefined
  readonly truncated?: TruncationReason
  readonly live: boolean
  readonly waiting: PaneWaiting
  readonly refused: boolean
}
const cutForMemory = 'cut to stay inside the memory budget'

/** Blocking's status line: the sessions in chains, that there is none, or why there is nothing to count. */
export function blockingStatus({ rows, truncated, live, waiting, refused }: TableFacts): string {
  if (rows === undefined) return refused ? 'Blocking chains cannot be read on this server.' : paneWaitingText[waiting]
  if (rows === 0) return live ? 'No blocking: no session waits on another.' : 'No blocking in the last sample.'
  const parts = [`${formatCount(rows)} ${plural(rows, 'session')} in blocking chains`]
  if (truncated) parts.push(truncated === 'rowLimit' ? `cut at ${formatCount(tableSpecs.blocking.rowCap)} sessions or ${formatCount(activityLimits.blockingDepth)} levels deep` : cutForMemory)
  return parts.join(' · ')
}

/** Active Expensive Queries' status line: the requests running, that only the costliest are kept, or that none run. */
export function activeStatus({ rows, truncated, live, waiting, refused }: TableFacts): string {
  if (rows === undefined) return refused ? 'Running requests cannot be read on this server.' : paneWaitingText[waiting]
  if (rows === 0) return live ? 'No requests running.' : 'No requests running in the last sample.'
  const parts = [`${formatCount(rows)} running ${plural(rows, 'request')}`]
  if (truncated) parts.push(truncated === 'rowLimit' ? `the ${formatCount(tableSpecs.activeQueries.rowCap)} using the most CPU` : cutForMemory)
  return parts.join(' · ')
}

const panes = {
  blocking: { label: 'Blocking', toneLabel: blockingToneLabel, status: blockingStatus, empty: 'No blocking right now. Sessions that wait on another appear here as chains, lead blockers first.' },
  activeQueries: { label: 'Active Expensive Queries', toneLabel: activeToneLabel, status: activeStatus, empty: 'No requests are running right now.' }
} as const

/** The empty note goes over the grid only while the table is current and empty: never under a failure or a pause. */
export function emptyNote(table: 'blocking' | 'activeQueries', facts: TableFacts, problem: PaneProblem | undefined): string | undefined {
  return facts.rows === 0 && facts.live && !problem ? panes[table].empty : undefined
}

/** One of the sessions probe's tables other than Sessions' own. */
export default function SessionTablePane({ table, state, handle, snapshot }: {
  readonly table: 'blocking' | 'activeQueries'
  readonly state: MonitorState
  readonly handle: LiveHandle
  readonly snapshot: LiveSnapshot
}) {
  const { activity } = useWorkbench()
  const pane = panes[table], index = sessionTableIndex(table)
  const current = handle.table(probe, index)
  const problem = paneProblem(snapshot.probes[probe], index)
  const facts: TableFacts = {
    rows: current?.descriptor.rowsAvailable, truncated: current?.descriptor.truncated, waiting: paneWaiting(snapshot, probe), refused: problem?.kind === 'refused',
    live: snapshot.status === 'live' && snapshot.probes[probe]?.state === 'fresh'
  }
  return <div className="activity-pane-content" data-activity-grid={table}>
    <PaneState problem={problem} hasRows={!!current} waiting={facts.waiting} empty={emptyNote(table, facts, problem)}>
      <LiveGridPane live={handle} probe={probe} table={index} label={pane.label} toneLabel={pane.toneLabel} state={activity.gridState(state.id, table)} sortable={table !== 'blocking'} />
    </PaneState>
    <p className="activity-pane-status">{pane.status(facts)}</p>
  </div>
}
