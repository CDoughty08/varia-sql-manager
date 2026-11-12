// Recent Expensive Queries (docs/activity-monitor.md, Panes): the query statistics probe's one table in a live grid
// (LiveGridPane, no React per row), with rank chips, the pane's own states and a status line. The probe reads the plan
// cache only while this pane shows (ActivityMonitorService pauses it otherwise), at its own interval. A rank chip is the
// table's sort key, sent as the probe's sort, which the header shows too: the backend re-sorts the last sample in memory at
// once (no SQL) and sorts every later one the same way.
import { rankChips, tableSpecs, type RankChip } from '../../../../shared/activity/catalog'
import type { LiveSort } from '../../../../shared/live/schema'
import { useWorkbench } from '../../core/WorkbenchContext'
import { Chip, ChipGroup } from '../../kit/Chip'
import { LiveGridPane } from '../../live/LiveGridPane'
import type { LiveHandle, LiveSnapshot } from '../../live/LiveService'
import { formatCount } from '../../results/status'
import type { MonitorState } from '../ActivityMonitorService'
import PaneState, { paneProblem, paneWaiting, paneWaitingText, type PaneProblem } from './PaneState'
import type { TableFacts } from './SessionTablePanes'

const probe = 'activity.queries'
const table = 0
const spec = tableSpecs.recentQueries
const ranks = Object.keys(rankChips) as RankChip[]
const caption = (column: string): string => spec.columns.find(item => item.id === column)?.caption ?? column

/** The chip a sort sets: the table's sole key, descending, on a chip's column. No key is the catalogue's default sort. */
export function pressedRank(sort: readonly LiveSort[] | undefined): RankChip | undefined {
  const own = (sort ?? []).filter(key => key.table === undefined || key.table === table)
  const keys = own.length > 0 ? own : spec.defaultSort
  if (keys.length !== 1 || !keys[0]!.descending) return undefined
  return ranks.find(rank => rankChips[rank].column === keys[0]!.column)
}
/** The probe's sort for a chip: its column, most first, as this table's only key. */
export const rankSort = (rank: RankChip): LiveSort[] => [{ column: rankChips[rank].column, descending: true, table }]

/** The status line: the query groups listed, that only the costliest are kept, or why there is nothing to count. */
export function recentQueriesStatus({ rows, truncated, live, waiting, refused }: TableFacts): string {
  if (rows === undefined) return refused ? 'Query statistics cannot be read on this server.' : paneWaitingText[waiting]
  if (rows === 0) return live ? 'No statement finished since the previous sample.' : 'No statements in the last sample.'
  const parts = [`${formatCount(rows)} ${rows === 1 ? 'query' : 'queries'} by query hash`]
  if (truncated) parts.push(truncated === 'rowLimit' ? `the ${formatCount(spec.rowCap)} that used the most CPU` : 'cut to stay inside the memory budget')
  return parts.join(' · ')
}

/** The empty note goes over the grid only while the table is current and empty: never under a failure or a pause. */
export function recentQueriesEmpty(facts: TableFacts, problem: PaneProblem | undefined): string | undefined {
  return facts.rows === 0 && facts.live && !problem ? 'No statement finished since the previous sample. Statements appear here as they complete, most expensive first.' : undefined
}

export default function RecentQueriesPane({ state, handle, snapshot }: {
  readonly state: MonitorState
  readonly handle: LiveHandle
  readonly snapshot: LiveSnapshot
}) {
  const { activity } = useWorkbench()
  // The sort lives in the probe's settings (the header's buttons set it too); a chip click draws its press at once.
  const pressed = pressedRank(handle.probeOptions(probe)?.sort)
  const current = handle.table(probe, table)
  const problem = paneProblem(snapshot.probes[probe], table)
  const facts: TableFacts = {
    rows: current?.descriptor.rowsAvailable, truncated: current?.descriptor.truncated, waiting: paneWaiting(snapshot, probe), refused: problem?.kind === 'refused',
    live: snapshot.status === 'live' && snapshot.probes[probe]?.state === 'fresh'
  }
  const rank = (chip: RankChip) => {
    if (pressed === chip) return
    handle.setProbe(probe, { sort: rankSort(chip) })
  }
  return <div className="activity-pane-content" data-activity-grid="recentQueries">
    <div className="activity-pane-tools one-row" role="toolbar" aria-label="Recent Expensive Queries ranking">
      <ChipGroup label="Rank by" dense scroll>
        {ranks.map(chip => <Chip key={chip} label={rankChips[chip].title} title={`Rank by ${caption(rankChips[chip].column)}, highest first`} pressed={pressed === chip} onToggle={() => rank(chip)} />)}
      </ChipGroup>
    </div>
    <PaneState problem={problem} hasRows={!!current} waiting={facts.waiting} empty={recentQueriesEmpty(facts, problem)}>
      <LiveGridPane live={handle} probe={probe} table={table} label="Recent Expensive Queries" state={activity.gridState(state.id, 'recentQueries')} />
    </PaneState>
    <p className="activity-pane-status">{recentQueriesStatus(facts)}</p>
  </div>
}
