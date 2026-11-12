// Resource Waits and Data File I/O (docs/activity-monitor.md, Panes): the resources probe's three tables, each in a live
// grid (LiveGridPane, no React per row) with the pane's own states, a toolbar and a status line. Both panes read the same
// sample, so showing both runs the probe's SQL once. Resource Waits shows its categories or its types (both come in every
// sample, so the choice sends nothing); Hide benign waits and Data File I/O's view chip and latency thresholds are the
// backend's filter (live.update args).
import { fileViewNotes, fileViews, fileViewTitles, probeSpecs, tableSpecs, waitToggles, type ActivityTable, type FileView } from '../../../../shared/activity/catalog'
import type { LiveTone } from '../../../../shared/live/catalog'
import { useWorkbench } from '../../core/WorkbenchContext'
import { Chip, ChipGroup } from '../../kit/Chip'
import { LiveGridPane } from '../../live/LiveGridPane'
import type { LiveHandle, LiveSnapshot } from '../../live/LiveService'
import { formatCount, plural } from '../../results/status'
import type { FilesFilter, MonitorState, WaitsFilter } from '../ActivityMonitorService'
import PaneState, { paneProblem, paneWaiting, paneWaitingText, type PaneProblem } from './PaneState'
import type { TableFacts } from './SessionTablePanes'

const probe = 'activity.resources'
type ResourceTable = Extract<ActivityTable, 'waitCategories' | 'waitTypes' | 'files'>
/** A table's place in the resources probe's sample, in the catalogue's order. */
export const resourceTableIndex = (table: ResourceTable): number => (probeSpecs[probe].tables as readonly ActivityTable[]).indexOf(table)

// The backend tones a file whose read or write latency in the interval reached a threshold (ActivityResourceRows).
const fileTones: Partial<Record<LiveTone, string>> = { warning: 'latency over the warning threshold', error: 'latency over the error threshold' }
export const fileToneLabel = (tone: LiveTone): string | undefined => fileTones[tone]
const cutForMemory = 'cut to stay inside the memory budget'
const waitNouns = { waitCategories: 'wait category', waitTypes: 'wait type' } as const
const nounPlural = (count: number, noun: string) => count === 1 ? noun : noun.endsWith('y') ? noun.slice(0, -1) + 'ies' : noun + 's'

/** Resource Waits' status line: the categories or types shown, what is hidden, and why the list may be short. */
export function waitsStatus(filter: WaitsFilter, { rows, truncated, live, waiting, refused }: TableFacts): string {
  if (rows === undefined) return refused ? 'Wait statistics cannot be read on this server.' : paneWaitingText[waiting]
  if (rows === 0) return live ? 'No waits in the interval.' : 'No waits in the last sample.'
  const parts = [`${formatCount(rows)} ${nounPlural(rows, waitNouns[filter.table])}`]
  if (filter.hideBenign) parts.push('benign waits hidden')
  if (truncated) parts.push(truncated === 'rowLimit' ? `the ${formatCount(tableSpecs[filter.table].rowCap)} with the most wait time` : cutForMemory)
  return parts.join(' · ')
}

/** The latency an error tone starts at: an error threshold below the warning one acts as the warning one. */
export const errorLatencyMs = (filter: Pick<FilesFilter, 'warningMs' | 'errorMs'>): number => Math.max(filter.warningMs, filter.errorMs)

const emptyFiles: Readonly<Record<FileView, { readonly live: string; readonly last: string }>> = {
  all: { live: 'No database files', last: 'No database files in the last sample' },
  rows: { live: 'No data files', last: 'No data files in the last sample' },
  log: { live: 'No log files', last: 'No log files in the last sample' },
  overThreshold: { live: 'No file over the latency threshold', last: 'No file over the latency threshold in the last sample' }
}
/** Data File I/O's status line: the files shown, its view, the thresholds that tone them, and why the list may be short. */
export function filesStatus(filter: FilesFilter, { rows, truncated, live, waiting, refused }: TableFacts): string {
  if (rows === undefined) return refused ? 'File I/O statistics cannot be read on this server.' : paneWaitingText[waiting]
  const thresholds = `warning at ${formatCount(filter.warningMs)} ms, error at ${formatCount(errorLatencyMs(filter))} ms`
  if (rows === 0) return [live ? emptyFiles[filter.view].live : emptyFiles[filter.view].last, thresholds].join(' · ')
  const parts = [`${formatCount(rows)} ${plural(rows, 'file')}`]
  if (filter.view !== 'all') parts.push(`${fileViewTitles[filter.view]} only`)
  parts.push(thresholds)
  if (truncated) parts.push(truncated === 'rowLimit' ? `at most ${formatCount(tableSpecs.files.rowCap)} kept, the busiest first` : cutForMemory)
  return parts.join(' · ')
}

/** The empty note over a grid goes only while the table is current and empty: never under a failure or a pause. */
export function resourceEmptyNote(pane: 'waits' | 'fileIo', facts: TableFacts, problem: PaneProblem | undefined, view: FileView = 'all'): string | undefined {
  if (facts.rows !== 0 || !facts.live || problem) return undefined
  if (pane === 'waits') return 'No wait time in the interval. Wait categories appear here as tasks wait on resources.'
  return view === 'overThreshold' ? 'No file reached the latency warning threshold in the interval.' : emptyFiles[view].live + '.'
}

function useTable(handle: LiveHandle, snapshot: LiveSnapshot, table: ResourceTable): { facts: TableFacts; problem: PaneProblem | undefined; hasRows: boolean } {
  const index = resourceTableIndex(table)
  const current = handle.table(probe, index)
  const problem = paneProblem(snapshot.probes[probe], index)
  return {
    problem, hasRows: !!current,
    facts: {
      rows: current?.descriptor.rowsAvailable, truncated: current?.descriptor.truncated, waiting: paneWaiting(snapshot, probe), refused: problem?.kind === 'refused',
      live: snapshot.status === 'live' && snapshot.probes[probe]?.state === 'fresh'
    }
  }
}

export function WaitsPane({ state, handle, snapshot }: { readonly state: MonitorState; readonly handle: LiveHandle; readonly snapshot: LiveSnapshot }) {
  const { activity } = useWorkbench()
  const filter = state.waits
  const { facts, problem, hasRows } = useTable(handle, snapshot, filter.table)
  const set = (change: Partial<WaitsFilter>) => activity.setWaitsFilter(state.id, change)
  return <div className="activity-pane-content" data-activity-grid="waits">
    <div className="activity-pane-tools one-row" role="toolbar" aria-label="Resource Waits filters">
      <ChipGroup label="Group" dense>
        <Chip label="By category" title="One row per wait category" pressed={filter.table === 'waitCategories'} onToggle={() => set({ table: 'waitCategories' })} />
        <Chip label="By type" title="One row per wait type" pressed={filter.table === 'waitTypes'} onToggle={() => set({ table: 'waitTypes' })} />
      </ChipGroup>
      <span className="activity-tools-separator" aria-hidden="true" />
      <Chip label={waitToggles.hideBenign.title} title="Leave out waits for work (benign wait types and the Idle category)" pressed={filter.hideBenign} onToggle={() => set({ hideBenign: !filter.hideBenign })} />
    </div>
    <PaneState problem={problem} hasRows={hasRows} waiting={facts.waiting} empty={resourceEmptyNote('waits', facts, problem)}>
      <LiveGridPane key={filter.table} live={handle} probe={probe} table={resourceTableIndex(filter.table)} label={filter.table === 'waitCategories' ? 'Wait categories' : 'Wait types'}
        state={activity.gridState(state.id, filter.table)} />
    </PaneState>
    <p className="activity-pane-status">{waitsStatus(filter, facts)}</p>
  </div>
}

export function FileIoPane({ state, handle, snapshot }: { readonly state: MonitorState; readonly handle: LiveHandle; readonly snapshot: LiveSnapshot }) {
  const { activity } = useWorkbench()
  const filter = state.files
  const { facts, problem, hasRows } = useTable(handle, snapshot, 'files')
  return <div className="activity-pane-content" data-activity-grid="fileIo">
    <div className="activity-pane-tools one-row" role="toolbar" aria-label="Data File I/O filters">
      <ChipGroup label="View" dense scroll>
        {fileViews.map(view => <Chip key={view} label={fileViewTitles[view]} title={fileViewNotes[view]} pressed={filter.view === view}
          onToggle={() => activity.setFilesFilter(state.id, { view: filter.view === view ? 'all' : view })} />)}
      </ChipGroup>
    </div>
    <PaneState problem={problem} hasRows={hasRows} waiting={facts.waiting} empty={resourceEmptyNote('fileIo', facts, problem, filter.view)}>
      <LiveGridPane live={handle} probe={probe} table={resourceTableIndex('files')} label="Data File I/O" toneLabel={fileToneLabel} state={activity.gridState(state.id, 'fileIo')} />
    </PaneState>
    <p className="activity-pane-status">{filesStatus(filter, facts)}</p>
  </div>
}
