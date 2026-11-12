// Resource Waits and Data File I/O (docs/activity-monitor.md, Panes): the resources probe's three tables, each in a live
// grid (LiveGridPane, no React per row) with the pane's own states, a toolbar and a status line. Both panes read the same
// sample, so showing both runs the probe's SQL once. Resource Waits shows its categories or its types (both come in every
// sample, so the choice sends nothing); Hide benign waits and Data File I/O's view chip and latency thresholds are the
// backend's filter (live.update args).
import { fileViewNotes, fileViews, fileViewTitles, probeSpecs, tableSpecs, waitToggles, type ActivityTable, type FileView } from '../../../../shared/activity/catalog'
import { liveProbes, type LiveTone } from '../../../../shared/live/catalog'
import { useState } from 'react'
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
const nextSample = 'from the next sample'

/** What a resources pane knows beyond a table's facts. `rated` is false on a sample without rates (the first after a start,
 *  resume, restart or cleared statistics: the backend then has no interval, so no rate, latency or tone); `pending` is true
 *  while the rows shown predate the filter just chosen, which the backend applies from its next sample. */
export interface ResourceFacts extends TableFacts {
  readonly rated?: boolean
  readonly pending?: boolean
}

/** Resource Waits' status line: the categories or types shown, what is hidden, and why the list may be short. */
export function waitsStatus(filter: WaitsFilter, { rows, truncated, live, waiting, refused, rated = true, pending = false }: ResourceFacts): string {
  if (rows === undefined) return refused ? 'Wait statistics cannot be read on this server.' : paneWaitingText[waiting]
  const benign = pending ? [`benign waits ${filter.hideBenign ? 'hidden' : 'shown'} ${nextSample}`] : filter.hideBenign ? ['benign waits hidden'] : []
  if (rows === 0) return pending ? [live ? 'No waits in the interval' : 'No waits in the last sample', ...benign].join(' · ') : live ? 'No waits in the interval.' : 'No waits in the last sample.'
  const parts = [`${formatCount(rows)} ${nounPlural(rows, waitNouns[filter.table])}`, ...benign]
  if (!rated) parts.push(`rates ${nextSample}`)
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
export function filesStatus(filter: FilesFilter, { rows, truncated, live, waiting, refused, rated = true, pending = false }: ResourceFacts): string {
  if (rows === undefined) return refused ? 'File I/O statistics cannot be read on this server.' : paneWaitingText[waiting]
  const thresholds = `warning at ${formatCount(filter.warningMs)} ms, error at ${formatCount(errorLatencyMs(filter))} ms`
  const counted = (count: number) => `${formatCount(count)} ${plural(count, 'file')}`
  const view = filter.view === 'all' ? [] : [`${fileViewTitles[filter.view]} only`]
  // Rows from before a new view or threshold are not what the view's words would say, so the line then only counts them.
  if (pending) return [rows === 0 ? 'No files' : counted(rows), ...view, `${thresholds} ${nextSample}`].join(' · ')
  const empty = live ? emptyFiles[filter.view].live : emptyFiles[filter.view].last
  if (!rated) return [rows !== 0 ? counted(rows) : filter.view === 'overThreshold' ? 'No latencies yet' : empty, ...view, thresholds, `latencies and tones ${nextSample}`].join(' · ')
  if (rows === 0) return [empty, thresholds].join(' · ')
  const parts = [counted(rows), ...view, thresholds]
  // The backend keeps the first files by database and file id (ActivitySql's TOP ... ORDER BY), not the busiest.
  if (truncated) parts.push(truncated === 'rowLimit' ? `the first ${formatCount(tableSpecs.files.rowCap)} by database and file id` : cutForMemory)
  return parts.join(' · ')
}

/** The empty note over a grid goes only while the table is current and empty: never under a failure or a pause. */
export function resourceEmptyNote(pane: WaitsFilter['table'] | 'fileIo', facts: ResourceFacts, problem: PaneProblem | undefined, view: FileView = 'all'): string | undefined {
  if (facts.rows !== 0 || !facts.live || problem || facts.pending) return undefined
  if (pane !== 'fileIo') return `No wait time in the interval. ${pane === 'waitCategories' ? 'Wait categories' : 'Wait types'} appear here as tasks wait on resources.`
  if (view !== 'overThreshold') return emptyFiles[view].live + '.'
  return facts.rated === false ? 'Latencies arrive with the next sample: files over the warning threshold appear then.' : 'No file reached the latency warning threshold in the interval.'
}

/** True while the rows shown predate the filter `key` names: from the render the key changes until the table's result does
 *  (the backend applies live.update args from its next sample, which brings a new result). React's state-from-render pattern. */
export function usePendingFilter(key: string, resultId: number | undefined): boolean {
  const [seen, setSeen] = useState<{ readonly key: string; readonly resultId: number | undefined }>({ key, resultId: undefined })
  if (seen.key !== key) {
    setSeen({ key, resultId })
    return resultId !== undefined
  }
  return resultId !== undefined && seen.resultId === resultId
}

// wait.signal has a value on every sample with rates and none on one without (ActivityResourceRows); the files' rates start
// from the same baseline, so it says for both tables whether the sample shown has an interval.
const signalSeries = (liveProbes[probe].series ?? []).findIndex(series => series.id === 'wait.signal')
/** Whether the latest resources sample had rates: its wait.signal value is missing (NaN in the ring) on one without. */
export function sampleRated(handle: Pick<LiveHandle, 'ring'>): boolean {
  const ring = handle.ring(probe)
  return !ring || ring.length === 0 || !Number.isNaN(ring.value(ring.length - 1, signalSeries))
}
// Both wait tables come in every sample, so Resource Waits keys its pending note on one of them whichever it shows.
function useTable(handle: LiveHandle, snapshot: LiveSnapshot, table: ResourceTable, filterKey: string, sampleTable: ResourceTable = table): { facts: ResourceFacts; problem: PaneProblem | undefined; hasRows: boolean } {
  const index = resourceTableIndex(table)
  const current = handle.table(probe, index)
  const problem = paneProblem(snapshot.probes[probe], index)
  const pending = usePendingFilter(filterKey, handle.table(probe, resourceTableIndex(sampleTable))?.descriptor.resultId)
  return {
    problem, hasRows: !!current,
    facts: {
      rows: current?.descriptor.rowsAvailable, truncated: current?.descriptor.truncated, waiting: paneWaiting(snapshot, probe), refused: problem?.kind === 'refused',
      live: snapshot.status === 'live' && snapshot.probes[probe]?.state === 'fresh', rated: sampleRated(handle), pending
    }
  }
}

export function WaitsPane({ state, handle, snapshot }: { readonly state: MonitorState; readonly handle: LiveHandle; readonly snapshot: LiveSnapshot }) {
  const { activity } = useWorkbench()
  const filter = state.waits
  const { facts, problem, hasRows } = useTable(handle, snapshot, filter.table, String(filter.hideBenign), 'waitCategories')
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
    <PaneState problem={problem} hasRows={hasRows} waiting={facts.waiting} empty={resourceEmptyNote(filter.table, facts, problem)}>
      <LiveGridPane key={filter.table} live={handle} probe={probe} table={resourceTableIndex(filter.table)} label={filter.table === 'waitCategories' ? 'Wait categories' : 'Wait types'}
        state={activity.gridState(state.id, filter.table)} />
    </PaneState>
    <p className="activity-pane-status">{waitsStatus(filter, facts)}</p>
  </div>
}

export function FileIoPane({ state, handle, snapshot }: { readonly state: MonitorState; readonly handle: LiveHandle; readonly snapshot: LiveSnapshot }) {
  const { activity } = useWorkbench()
  const filter = state.files
  const { facts, problem, hasRows } = useTable(handle, snapshot, 'files', `${filter.view}|${filter.warningMs}|${filter.errorMs}`)
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
