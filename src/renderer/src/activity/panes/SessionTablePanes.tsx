// Blocking and Active Expensive Queries (docs/activity-monitor.md, Panes): the sessions probe's other two tables, each in
// a live grid (LiveGridPane, no React per row) with the pane's own states and a status line. They read the same sample as
// Processes, so showing them runs no extra SQL.
import { tableSpecs, type ActivityTable } from '../../../../shared/activity/catalog'
import type { LiveTone } from '../../../../shared/live/catalog'
import { useWorkbench } from '../../core/WorkbenchContext'
import { LiveGridPane } from '../../live/LiveGridPane'
import type { LiveHandle, LiveSnapshot } from '../../live/LiveService'
import { formatCount, plural } from '../../results/status'
import type { MonitorState } from '../ActivityMonitorService'
import PaneState, { paneProblem, paneWaiting, paneWaitingText, type PaneWaiting } from './PaneState'

const probe = 'activity.sessions'
/** The tables' places in the sessions probe's sample, in the catalogue's order. */
const sessionTables = ['sessions', 'blocking', 'activeQueries'] as const satisfies readonly ActivityTable[]
type SessionTable = (typeof sessionTables)[number]
export const sessionTableIndex = (table: SessionTable): number => sessionTables.indexOf(table)

const blockingTones: Partial<Record<LiveTone, string>> = { error: 'blocked', warning: 'lead blocker', muted: 'no longer blocked' }
const activeTones: Partial<Record<LiveTone, string>> = { error: 'blocked', running: 'rolling back', muted: 'finished' }
export const blockingToneLabel = (tone: LiveTone): string | undefined => blockingTones[tone]
export const activeToneLabel = (tone: LiveTone): string | undefined => activeTones[tone]

/** Blocking's status line: the sessions in chains, or that there is none. */
export function blockingStatus(rows: number | undefined, truncated: boolean, waiting: PaneWaiting = 'loading'): string {
  if (rows === undefined) return paneWaitingText[waiting]
  if (rows === 0) return 'No blocking: no session waits on another.'
  const parts = [`${formatCount(rows)} ${plural(rows, 'session')} in blocking chains`]
  if (truncated) parts.push(`at most ${formatCount(tableSpecs.blocking.rowCap)} kept`)
  return parts.join(' · ')
}

/** Active Expensive Queries' status line: the requests running, and that only the costliest are kept. */
export function activeStatus(rows: number | undefined, truncated: boolean, waiting: PaneWaiting = 'loading'): string {
  if (rows === undefined) return paneWaitingText[waiting]
  if (rows === 0) return 'No requests running.'
  const parts = [`${formatCount(rows)} running ${plural(rows, 'request')}`]
  if (truncated) parts.push(`the ${formatCount(tableSpecs.activeQueries.rowCap)} using the most CPU`)
  return parts.join(' · ')
}

const panes = {
  blocking: { label: 'Blocking', toneLabel: blockingToneLabel, status: blockingStatus, empty: 'No blocking right now. Sessions that wait on another appear here as chains, lead blockers first.' },
  activeQueries: { label: 'Active Expensive Queries', toneLabel: activeToneLabel, status: activeStatus, empty: 'No requests are running right now.' }
} as const

/** One of the sessions probe's tables other than Processes' own. */
export default function SessionTablePane({ table, state, handle, snapshot, labelledBy }: {
  readonly table: 'blocking' | 'activeQueries'
  readonly state: MonitorState
  readonly handle: LiveHandle
  readonly snapshot: LiveSnapshot
  readonly labelledBy: string
}) {
  const { activity } = useWorkbench()
  const pane = panes[table], index = sessionTableIndex(table)
  const current = handle.table(probe, index)
  const waiting = paneWaiting(snapshot, probe)
  const rows = current?.descriptor.rowsAvailable
  return <div className="activity-pane-content" data-activity-grid={table}>
    <PaneState problem={paneProblem(snapshot.probes[probe], index)} hasRows={!!current} waiting={waiting} empty={rows === 0 ? pane.empty : undefined}>
      <LiveGridPane live={handle} probe={probe} table={index} label={pane.label} toneLabel={pane.toneLabel} state={activity.gridState(state.id, table)} />
    </PaneState>
    <p className="activity-pane-status" aria-labelledby={labelledBy}>{pane.status(rows, !!current?.descriptor.truncated, waiting)}</p>
  </div>
}
