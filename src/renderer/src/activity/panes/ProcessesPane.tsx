// The Sessions pane (docs/activity-monitor.md, Sessions; SSMS's Processes): one row per session from the sessions probe,
// in the results grid (LiveGridPane mounts ResultGrid's shell: no React per row), with its header's sort buttons and funnels
// (ColumnFilterPopover over the sessions facets) and Query Output's menu. Its toolbar and the funnels set the monitor's sessions filter (view chip, Show chips, filter box, column value filters), which
// ActivityMonitorService sends as the source's args; the backend filters (and sorts) the sample in memory.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { activityLimits, sessionToggles, tableSpecs, viewChipNotes, viewChipTitles, viewChips } from '../../../../shared/activity/catalog'
import type { ActivityColumnFilter } from '../../../../shared/activity/schema'
import type { LiveTone } from '../../../../shared/live/catalog'
import { useWorkbench } from '../../core/WorkbenchContext'
import Icon from '../../Icon'
import { Chip, ChipGroup } from '../../kit/Chip'
import { LiveGridPane, type LiveFilters } from '../../live/LiveGridPane'
import type { LiveHandle, LiveSnapshot } from '../../live/LiveService'
import { formatCount, plural } from '../../results/status'
import type { MonitorFacts, MonitorState, ProcessesFilter } from '../ActivityMonitorService'
import PaneState, { paneProblem, paneWaiting, paneWaitingText, type PaneWaiting } from './PaneState'

const probe = 'activity.sessions'
const sessions = tableSpecs.sessions
/** What a screen reader hears for a toned row: Sessions' tones (blocked, blocking, rollback, departed, system) as words. */
const toneWords: Partial<Record<LiveTone, string>> = { error: 'blocked', warning: 'blocking others', running: 'rolling back', muted: 'system or ended session' }
export const processesToneLabel = (tone: LiveTone): string | undefined => toneWords[tone]
export const columnCaption = (column: string): string => sessions.columns.find(item => item.id === column)?.caption ?? column
/** How many filters are on besides the Show chips (the view chip, the filter box, each column's funnel): what Clear filters clears. */
export const activeFilters = (filter: ProcessesFilter): number => (filter.view === 'all' ? 0 : 1) + (filter.text.trim() ? 1 : 0) + filter.columnFilters.length

/** The status line's words: rows shown, and why the list may be short. */
export function processesStatus(rows: number | undefined, truncated: boolean, filter: ProcessesFilter, waiting: PaneWaiting = 'loading'): string {
  if (rows === undefined) return paneWaitingText[waiting]
  const hidden = [!filter.showSystem && 'system sessions', !filter.showVaria && 'Varia\'s own'].filter(Boolean).join(' and ')
  const parts = [`${formatCount(rows)} ${plural(rows, 'session')}`]
  if (activeFilters(filter) > 0) parts.push(`${activeFilters(filter)} ${plural(activeFilters(filter), 'filter')} on`)
  if (hidden) parts.push(`${hidden} hidden`)
  if (truncated) parts.push(`at most ${formatCount(sessions.rowCap)} kept; idle sessions were dropped first`)
  return parts.join(' · ')
}

export default function ProcessesPane({ state, handle, snapshot, facts, labelledBy }: {
  readonly state: MonitorState
  readonly handle: LiveHandle
  readonly snapshot: LiveSnapshot
  readonly facts: MonitorFacts
  readonly labelledBy: string
}) {
  const { activity } = useWorkbench()
  const filter = state.processes
  const table = handle.table(probe, 0)
  const problem = paneProblem(snapshot.probes[probe], 0)
  const waiting = paneWaiting(snapshot, probe)
  // A draft in the filter box counts for Clear filters, so its click is not lost to the blur that commits the draft.
  const [drafting, setDrafting] = useState(false)
  // Find in Results (Ctrl+F) in the grid moves to the filter box: a live view has no Find of its own.
  const tools = useRef<HTMLDivElement>(null)
  const find = () => { const box = tools.current?.querySelector<HTMLInputElement>('input[type="search"]'); box?.focus(); box?.select() }
  const set = (change: Partial<ProcessesFilter>) => activity.setProcessesFilter(state.id, change)
  // The header's funnels: one per facet column, each a value filter the backend applies (ActivityFilter.cs).
  const filters: LiveFilters = {
    columns: sessions.facetColumns ?? [],
    filters: filter.columnFilters,
    facet: column => facts.facets.sessions?.[column],
    apply: (column, next) => {
      const others = filter.columnFilters.filter(item => item.column !== column)
      set({ columnFilters: next ? [...others, { column, ...next } satisfies ActivityColumnFilter] : others })
    },
    clear: () => set({ columnFilters: [] }),
    maxValues: activityLimits.columnFilterValues
  }
  return <div className="activity-pane-content" data-activity-grid="processes">
    <div ref={tools} className="activity-pane-tools one-row" role="toolbar" aria-label="Sessions filters">
      <ChipGroup label="View" dense scroll>
        {viewChips.map(view => <Chip key={view} label={viewChipTitles[view]} title={viewChipNotes[view]} pressed={filter.view === view} onToggle={() => set({ view: filter.view === view ? 'all' : view })} />)}
      </ChipGroup>
      <span className="activity-tools-separator" aria-hidden="true" />
      <ChipGroup label="Show" dense>
        <Chip label={sessionToggles.showSystem.label} title={sessionToggles.showSystem.note} pressed={filter.showSystem} onToggle={() => set({ showSystem: !filter.showSystem })} />
        <Chip label={sessionToggles.showVaria.label} title={sessionToggles.showVaria.note} pressed={filter.showVaria} onToggle={() => set({ showVaria: !filter.showVaria })} />
      </ChipGroup>
      <FilterBox id={state.id} value={filter.text} onCommit={text => set({ text })} onDraft={setDrafting} />
      <button type="button" className="activity-tool icon-only" disabled={activeFilters(filter) === 0 && !drafting} onClick={() => activity.clearProcessesFilter(state.id)}
        aria-label="Clear filters" title="Clear filters: the view, the filter box and the column filters">
        <Icon name="clear-all" />
      </button>
    </div>
    <PaneState problem={problem} hasRows={!!table} waiting={waiting}>
      <LiveGridPane live={handle} probe={probe} table={0} label="Sessions" toneLabel={processesToneLabel} state={activity.gridState(state.id, 'processes')} filters={filters} onFind={find} />
    </PaneState>
    {/* Not a live region: the count changes with every sample on a busy server, and re-announcing it would be noise. */}
    <p className="activity-pane-status" aria-labelledby={labelledBy}>{processesStatus(table?.descriptor.rowsAvailable, !!table?.descriptor.truncated, filter, waiting)}</p>
  </div>
}

/** The filter box: sent when typing pauses, on Enter, or when it loses focus; Escape puts back what was sent. */
function FilterBox({ id, value, onCommit, onDraft }: { readonly id: string; readonly value: string; readonly onCommit: (text: string) => void; readonly onDraft: (drafting: boolean) => void }) {
  const [draft, setDraft] = useState(value)
  const commit = useRef(onCommit)
  commit.current = onCommit
  useEffect(() => setDraft(value), [value])
  useEffect(() => onDraft(draft !== value), [draft, value, onDraft])
  // Typing settles before a filter goes out, so each keystroke is not a live.update of its own.
  useEffect(() => {
    if (draft === value) return
    const timer = window.setTimeout(() => commit.current(draft), 300)
    return () => window.clearTimeout(timer)
  }, [draft, value])
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); onCommit(draft) }
    else if (event.key === 'Escape' && draft !== value) { event.preventDefault(); event.stopPropagation(); setDraft(value) }
  }
  const inputId = `activity-${id}-processes-filter`
  return <span className="activity-filter-box">
    <Icon name="search" />
    <label htmlFor={inputId} className="visually-hidden">Filter sessions</label>
    <input id={inputId} type="search" spellCheck={false} placeholder="Filter sessions" value={draft} maxLength={activityLimits.filterText}
      title={`Matches ${(sessions.textColumns ?? []).map(columnCaption).join(', ')}`} onChange={event => setDraft(event.target.value)} onKeyDown={keyDown}
      onBlur={() => { if (draft !== value) onCommit(draft) }} />
  </span>
}
